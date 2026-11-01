/**
 * POST /shipment-status — checks carrier tracking for everything in the mail, for
 * the Shipments panel at the top of the ledger's Reports tab. Nothing is stored:
 * the app keeps the last result and asks again when it's over 4 hours old.
 *
 *   Outgoing: website orders and Log-a-deal labels (TCG Tracking envelopes, USPS packages via Shippo)
 *   Incoming: ledger buys marked "awaiting delivery" with a tracking number (carrier guessed from the number)
 *
 * Returns { rows, checked_at }. Shipments drop off once they're 45 days old (outgoing)
 * or marked received in the ledger (incoming).
 *
 * Auth: a signed-in partner.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Status = 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'problem' | 'unknown';
type Place = { city: string | null; state: string | null } | null;
type Shipment = { key: string; direction: 'out' | 'in'; label: string; tracking: string; carrier: string; tcg_order?: string; started_at: string; from: Place; to: Place };
type Check = { status: Status; detail: string | null; location: string | null; eta: string | null; last_event_at: string | null; from?: Place; to?: Place };
const spot = (a: { city?: string | null; state?: string | null } | null | undefined): Place =>
  a && (a.city || a.state) ? { city: a.city ?? null, state: a.state ?? null } : null;

const DAY = 86400e3;

/** Which carrier a bare tracking number belongs to. */
function carrierOf(tn: string): 'usps' | 'ups' | 'fedex' {
  const t = tn.replace(/\s+/g, '');
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return 'ups';
  if (/^\d{12}$|^\d{15}$|^\d{20}$/.test(t) && !/^9[1-5]/.test(t)) return 'fedex';
  return 'usps';
}

function trackUrl(carrier: string, tn: string): string | null {
  if (carrier === 'usps') return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tn)}`;
  if (carrier === 'ups') return `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`;
  if (carrier === 'fedex') return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}`;
  return null;
}

const place = (city?: string | null, state?: string | null) => [city, state].filter(Boolean).join(', ') || null;

function fromText(text: string, hasEvents: boolean): Status {
  if (/delivered/i.test(text) && !/not delivered|undeliverable/i.test(text)) return 'delivered';
  if (/out for delivery/i.test(text)) return 'out_for_delivery';
  if (/return|exception|fail|undeliverable|alert|refused|damaged|lost/i.test(text)) return 'problem';
  return hasEvents ? 'in_transit' : 'pre_transit';
}

async function shippo(carrier: string, tn: string): Promise<Check> {
  const key = Deno.env.get('SHIPPO_API_KEY');
  if (!key) throw new Error('Shippo isn’t connected');
  const r = await fetch(`https://api.goshippo.com/tracks/${carrier}/${encodeURIComponent(tn)}`, { headers: { Authorization: `ShippoToken ${key}` } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shippo tracking ${r.status}`);
  const t = b.tracking_status ?? {};
  const detail: string | null = t.status_details || null;
  const map: Record<string, Status> = { PRE_TRANSIT: 'pre_transit', TRANSIT: 'in_transit', DELIVERED: 'delivered', RETURNED: 'problem', FAILURE: 'problem', UNKNOWN: 'unknown' };
  let status = map[t.status as string] ?? 'unknown';
  if (status === 'in_transit' && /out for delivery/i.test(`${detail ?? ''} ${t.substatus?.code ?? ''}`)) status = 'out_for_delivery';
  return {
    status, detail, location: place(t.location?.city, t.location?.state), eta: b.eta ?? null, last_event_at: t.status_date ?? null,
    from: spot(b.address_from), to: spot(b.address_to),
  };
}

async function tcg(order: string): Promise<Check> {
  const key = Deno.env.get('TCGTRACKING_API_KEY'), shipper = Deno.env.get('TCGTRACKING_SHIPPER_NUMBER');
  if (!key || !shipper) throw new Error('TCG Tracking isn’t connected');
  const r = await fetch(`https://tcgtracking.com/api/v1/orders/track?order_number=${encodeURIComponent(order)}`, { headers: { 'X-Shipper-Number': shipper, 'X-API-Key': key } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`TCG Tracking ${r.status}`);
  const events = ((b.events ?? b.tracking?.events ?? []) as any[])
    .map((e) => ({ at: String(e.scan_datetime ?? e.date ?? e.timestamp ?? ''), text: String(e.description ?? ''), where: place(e.facility_city, e.facility_state) }))
    .sort((a, b2) => b2.at.localeCompare(a.at));
  const top = events[0];
  const raw = String(b.status ?? b.tracking?.status ?? '');
  const at = top?.at ? new Date(top.at) : null;
  return {
    status: fromText(`${raw} ${top?.text ?? ''}`, events.length > 0),
    detail: top?.text || raw || null,
    location: top?.where ?? null,
    eta: null,
    last_event_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
  };
}

async function shipments(): Promise<Shipment[]> {
  const since = new Date(Date.now() - 45 * DAY).toISOString();
  const [orders, labels, buys, settings, sells] = await Promise.all([
    db.from('shop_orders').select('id, order_number, method, tracking_number, buyer_name, items, ship_to, created_at, status')
      .not('tracking_number', 'is', null).neq('status', 'cancelled').gt('created_at', since),
    db.from('shipping_labels').select('id, ref, method, tracking_number, ship_to, description, created_at')
      .not('tracking_number', 'is', null).gt('created_at', since),
    db.from('entries').select('id, description, tracking, occurred_on, created_at')
      .eq('awaiting_delivery', true).is('deleted_at', null).not('tracking', 'is', null),
    db.from('shop_settings').select('from_city, from_state').eq('id', 1).maybeSingle(),
    // Sells with a tracking number typed in: labels made outside the app.
    db.from('entries').select('id, description, tracking, created_at, customer_id, customers(name, address)')
      .eq('kind', 'sell').is('deleted_at', null).not('tracking', 'is', null).gt('created_at', since),
  ]);
  if (sells.error) console.error('sells', sells.error.message);
  const home = spot({ city: settings.data?.from_city, state: settings.data?.from_state });
  const out: Shipment[] = [];
  for (const o of orders.data ?? []) {
    const first = (o.items as { title: string }[])[0]?.title ?? 'Website order';
    const n = (o.items as unknown[]).length;
    out.push({
      key: `order:${o.id}`, direction: 'out', tracking: o.tracking_number, started_at: o.created_at,
      label: `${o.buyer_name ?? 'Website order'} · ${first}${n > 1 ? ` +${n - 1}` : ''}`,
      carrier: o.method === 'envelope' ? 'tcg' : 'usps', tcg_order: o.method === 'envelope' ? o.order_number : undefined,
      from: home, to: spot(o.ship_to as Place),
    });
  }
  for (const l of labels.data ?? []) {
    out.push({
      key: `label:${l.id}`, direction: 'out', tracking: l.tracking_number, started_at: l.created_at,
      label: [(l.ship_to as { name?: string } | null)?.name, l.description].filter(Boolean).join(' · ') || `Label ${l.ref}`,
      carrier: l.method === 'envelope' ? 'tcg' : 'usps', tcg_order: l.method === 'envelope' ? l.ref : undefined,
      from: home, to: spot(l.ship_to as Place),
    });
  }
  for (const e of buys.data ?? []) {
    const tn = String(e.tracking).replace(/\s+/g, '');
    if (tn.length < 8) continue;
    out.push({ key: `entry:${e.id}`, direction: 'in', tracking: tn, started_at: e.created_at, label: e.description, carrier: carrierOf(tn), from: null, to: home });
  }
  for (const e of sells.data ?? []) {
    const tn = String(e.tracking).replace(/\s+/g, '');
    if (tn.length < 8) continue;
    const c = (Array.isArray(e.customers) ? e.customers[0] : e.customers) as { name?: string; address?: Place } | null;
    out.push({
      key: `sell:${e.id}`, direction: 'out', tracking: tn, started_at: e.created_at,
      label: [c?.name, e.description].filter(Boolean).join(' · '), carrier: carrierOf(tn), from: home, to: spot(c?.address),
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user?.email) return json({ error: 'Sign in first' }, 401);
  const { data: me } = await db.from('partners').select('id').ilike('email', user.email).maybeSingle();
  if (!me) return json({ error: 'Not a partner' }, 403);

  const list = await shipments();
  const now = new Date().toISOString();
  const rows = await Promise.all(list.map(async (s) => {
    const base = { key: s.key, direction: s.direction, label: s.label.slice(0, 200), carrier: s.carrier, tracking: s.tracking, url: s.carrier === 'tcg' ? null : trackUrl(s.carrier, s.tracking), started_at: s.started_at, checked_at: now }
    try {
      const c = s.carrier === 'tcg' ? await tcg(s.tcg_order!) : await shippo(s.carrier, s.tracking)
      // Our own records know the ends best; the carrier fills in what we don't have.
      return { ...base, ...c, from: s.from ?? c.from ?? null, to: s.to ?? c.to ?? null, error: null }
    } catch (err) {
      return { ...base, status: 'unknown' as Status, detail: null, location: null, eta: null, last_event_at: null, from: s.from, to: s.to, error: err instanceof Error ? err.message : String(err) }
    }
  }));
  rows.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return json({ rows, checked_at: now }, 200);
});

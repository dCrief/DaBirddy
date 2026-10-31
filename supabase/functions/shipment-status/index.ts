/**
 * POST /shipment-status — checks carrier tracking for everything in the mail and
 * saves it to shipment_status (which the ledger's Reports tab reads).
 *
 *   Outgoing: website orders and Log-a-deal labels (TCG Tracking envelopes, USPS packages via Shippo)
 *   Incoming: ledger buys marked "awaiting delivery" with a tracking number (carrier guessed from the number)
 *
 * Body: { refresh: 'all' } (the Refresh button) or { refresh: 'due' } (the 4-hourly
 * schedule: only what hasn't been checked in the last ~3.5 hours). Delivered
 * shipments aren't checked again. Returns { rows }.
 *
 * Auth: a signed-in partner, or the schedule's x-cron-key (checked against the
 * vault by shipment_cron_ok). Deploy with --no-verify-jwt.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Status = 'pre_transit' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'problem' | 'unknown';
type Shipment = { key: string; direction: 'out' | 'in'; label: string; tracking: string; carrier: string; tcg_order?: string; started_at: string };
type Check = { status: Status; detail: string | null; location: string | null; eta: string | null; last_event_at: string | null };

const DAY = 86400e3;

/** Which carrier a bare tracking number belongs to. */
function carrierOf(tn: string): 'usps' | 'ups' | 'fedex' {
  const t = tn.replace(/\s+/g, '');
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return 'ups';
  if (/^\d{12}$|^\d{15}$|^\d{20}$/.test(t) && !/^9[1-5]/.test(t)) return 'fedex';
  return 'usps';
}

export function trackUrl(carrier: string, tn: string): string | null {
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
  if (/pre.?transit|label|created|awaiting|shipping info|not yet/i.test(text)) return hasEvents ? 'in_transit' : 'pre_transit';
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
  return { status, detail, location: place(t.location?.city, t.location?.state), eta: b.eta ?? null, last_event_at: t.status_date ?? null };
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
  return {
    status: fromText(`${raw} ${top?.text ?? ''}`, events.length > 0),
    detail: top?.text || raw || null,
    location: top?.where ?? null,
    eta: null,
    last_event_at: top?.at ? new Date(top.at).toISOString() : null,
  };
}

async function shipments(): Promise<Shipment[]> {
  const since = new Date(Date.now() - 45 * DAY).toISOString();
  const [orders, labels, buys] = await Promise.all([
    db.from('shop_orders').select('id, order_number, method, tracking_number, buyer_name, items, created_at, status')
      .not('tracking_number', 'is', null).neq('status', 'cancelled').gt('created_at', since),
    db.from('shipping_labels').select('id, ref, method, tracking_number, ship_to, description, created_at')
      .not('tracking_number', 'is', null).gt('created_at', since),
    db.from('entries').select('id, description, tracking, occurred_on, created_at')
      .eq('awaiting_delivery', true).is('deleted_at', null).not('tracking', 'is', null),
  ]);
  const out: Shipment[] = [];
  for (const o of orders.data ?? []) {
    const first = (o.items as { title: string }[])[0]?.title ?? 'Website order';
    const n = (o.items as unknown[]).length;
    out.push({
      key: `order:${o.id}`, direction: 'out', tracking: o.tracking_number, started_at: o.created_at,
      label: `${o.buyer_name ?? 'Website order'} · ${first}${n > 1 ? ` +${n - 1}` : ''}`,
      carrier: o.method === 'envelope' ? 'tcg' : 'usps', tcg_order: o.method === 'envelope' ? o.order_number : undefined,
    });
  }
  for (const l of labels.data ?? []) {
    out.push({
      key: `label:${l.id}`, direction: 'out', tracking: l.tracking_number, started_at: l.created_at,
      label: [(l.ship_to as { name?: string } | null)?.name, l.description].filter(Boolean).join(' · ') || `Label ${l.ref}`,
      carrier: l.method === 'envelope' ? 'tcg' : 'usps', tcg_order: l.method === 'envelope' ? l.ref : undefined,
    });
  }
  for (const e of buys.data ?? []) {
    const tn = String(e.tracking).replace(/\s+/g, '');
    if (tn.length < 8) continue;
    out.push({ key: `entry:${e.id}`, direction: 'in', tracking: tn, started_at: e.created_at, label: e.description, carrier: carrierOf(tn) });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const cronKey = req.headers.get('x-cron-key');
  if (cronKey) {
    const { data: ok } = await db.rpc('shipment_cron_ok', { p_key: cronKey });
    if (ok !== true) return json({ error: 'Unauthorized' }, 401);
  } else {
    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user?.email) return json({ error: 'Sign in first' }, 401);
    const { data: me } = await db.from('partners').select('id').ilike('email', user.email).maybeSingle();
    if (!me) return json({ error: 'Not a partner' }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const all = body.refresh === 'all';
  const list = await shipments();
  const { data: prev } = await db.from('shipment_status').select('key, status, tracking, checked_at, delivered_at');
  const before = new Map((prev ?? []).map((p) => [p.key, p]));
  const now = new Date().toISOString();

  const rows = await Promise.all(list.map(async (s) => {
    const p = before.get(s.key);
    const same = p?.tracking === s.tracking;
    const fresh = same && p?.checked_at && Date.now() - new Date(p.checked_at).getTime() < 3.5 * 3600e3;
    if (same && (p?.status === 'delivered' || (!all && fresh))) return null; // nothing to do
    try {
      const c = s.carrier === 'tcg' ? await tcg(s.tcg_order!) : await shippo(s.carrier, s.tracking);
      return {
        key: s.key, direction: s.direction, label: s.label.slice(0, 200), carrier: s.carrier, tracking: s.tracking,
        url: s.carrier === 'tcg' ? null : trackUrl(s.carrier, s.tracking), ...c,
        error: null, checked_at: now, started_at: s.started_at,
        delivered_at: c.status === 'delivered' ? (c.last_event_at ?? now) : null,
      };
    } catch (err) {
      return {
        key: s.key, direction: s.direction, label: s.label.slice(0, 200), carrier: s.carrier, tracking: s.tracking,
        url: s.carrier === 'tcg' ? null : trackUrl(s.carrier, s.tracking), status: (same && p?.status) || 'unknown',
        error: err instanceof Error ? err.message : String(err), checked_at: now, started_at: s.started_at,
      };
    }
  }));
  const changed = rows.filter((r): r is NonNullable<typeof r> => !!r);
  if (changed.length) {
    const { error } = await db.from('shipment_status').upsert(changed, { onConflict: 'key' });
    if (error) return json({ error: error.message }, 500);
  }
  // Shipments that left the list (cancelled, received, too old) drop off.
  const keys = new Set(list.map((s) => s.key));
  const gone = [...before.keys()].filter((k) => !keys.has(k));
  if (gone.length) await db.from('shipment_status').delete().in('key', gone);
  await db.from('shipment_status_runs').upsert({ id: 1, ran_at: now, manual: all });

  const { data: out } = await db.from('shipment_status').select('*').order('started_at', { ascending: false });
  return json({ rows: out ?? [], checked: changed.length, ran_at: now });
});

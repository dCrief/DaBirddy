/**
 * Card orders: shipping rule, labels and logging the sale in the partner ledger.
 *
 * Env vars (set as Supabase secrets):
 *   TCGTRACKING_API_KEY, TCGTRACKING_SHIPPER_NUMBER — envelope labels (tcgtracking.com)
 *   SHIPPO_API_KEY                                   — package labels (goshippo.com)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY          — provided automatically
 *
 * The return address, default package and shipping prices live in the
 * shop_settings table (edited in the ledger's Shop tab).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

export const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

export type Settings = {
  payout_partner_id: string | null;
  from_name: string | null;
  from_street1: string | null;
  from_street2: string | null;
  from_city: string | null;
  from_state: string | null;
  from_zip: string | null;
  from_phone: string | null;
  from_email: string | null;
  package_length_in: number;
  package_width_in: number;
  package_height_in: number;
  package_weight_oz: number;
  envelope_cents: number;
  package_cents: number;
  envelope_under_cents: number;
};

export type OrderItem = {
  listing_id: string;
  title: string;
  set: string | null;
  number: string | null;
  category: string;
  price_cents: number;
  qty: number;
  photo: string | null; // private entry-photos name, for the ledger entry
};

export type ShipTo = {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

export type Order = {
  id: string;
  order_number: string;
  status: string;
  items: OrderItem[];
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number | null;
  method: 'envelope' | 'package';
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  ship_to: ShipTo | null;
  tracking_number: string | null;
  label_path: string | null;
  label_url: string | null;
  label_error: string | null;
  stripe_fee_cents: number | null;
  ledger_entry_id: string | null;
};

export async function loadSettings(): Promise<Settings> {
  const { data, error } = await db.from('shop_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as Settings;
}

/** Cards under the cutoff ship in a tracked envelope; anything else, or anything sealed, in a package. */
export function shippingFor(items: Pick<OrderItem, 'price_cents' | 'qty' | 'category'>[], s: Settings) {
  const subtotal = items.reduce((n, it) => n + it.price_cents * it.qty, 0);
  const bulky = items.some((it) => it.category === 'sealed');
  const method: 'envelope' | 'package' = !bulky && subtotal < s.envelope_under_cents ? 'envelope' : 'package';
  return { method, cents: method === 'envelope' ? s.envelope_cents : s.package_cents, subtotal };
}

export const usd = (cents: number) => (cents / 100).toFixed(2);

// ---------------------------------------------------------------- labels --

type LabelResult = {
  tracking_number: string;
  label_path?: string;
  label_url?: string;
  label_cost_cents?: number;
  carrier: string;
};

/** Envelope label from TCG Tracking. Re-sending the same order number returns the existing label. */
async function tcgTrackingLabel(o: Order): Promise<LabelResult> {
  const key = Deno.env.get('TCGTRACKING_API_KEY');
  const shipper = Deno.env.get('TCGTRACKING_SHIPPER_NUMBER');
  if (!key || !shipper) throw new Error('TCG Tracking isn’t connected yet (add TCGTRACKING_API_KEY and TCGTRACKING_SHIPPER_NUMBER)');
  const t = o.ship_to!;
  const headers = { 'Content-Type': 'application/json', 'X-Shipper-Number': shipper, 'X-API-Key': key };
  const res = await fetch('https://tcgtracking.com/api/v1/orders/', { // trailing slash: the bare path redirects and drops the POST
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_order_id: o.order_number,
      customer_name: t.name || o.buyer_name,
      address_line1: t.line1,
      address_line2: t.line2 || undefined,
      customer_city: t.city,
      customer_state: t.state,
      zipcode: t.postal_code,
      customer_country: t.country === 'CA' ? 'CA' : 'US',
      envelope_size: 'L64', // 6x4 sticker for the Rollo
      items: o.items.map((it) => ({ name: it.title.slice(0, 80), quantity: it.qty, price: it.price_cents / 100 })),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !(res.status === 500 && body.order_id)) {
    throw new Error(`TCG Tracking: ${body.message ?? res.status}`);
  }
  let pdf: string | undefined = body.pdf_base64;
  if (!pdf && body.order_id) {
    // Duplicate (a retry) or the PDF step failed: fetch the PDF separately.
    const r = await fetch(`https://tcgtracking.com/api/v1/orders/${body.order_id}/pdf?size=L64`, { headers });
    const b = await r.json().catch(() => ({}));
    pdf = b.pdf_base64;
  }
  if (!body.tracking_number) throw new Error('TCG Tracking didn’t return a tracking number');
  let label_path: string | undefined;
  if (pdf) {
    label_path = `${o.order_number}.pdf`;
    const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
    const { error } = await db.storage.from('shop-labels').upload(label_path, bytes, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error(`Saving the label: ${error.message}`);
  }
  return { tracking_number: body.tracking_number, label_path, carrier: 'TCG Tracking' };
}

/** Package label from Shippo: cheapest USPS Ground Advantage, falling back to the cheapest USPS rate. */
async function shippoLabel(o: Order, s: Settings): Promise<LabelResult> {
  const key = Deno.env.get('SHIPPO_API_KEY');
  if (!key) throw new Error('Shippo isn’t connected yet (add SHIPPO_API_KEY)');
  if (!s.from_street1 || !s.from_city || !s.from_state || !s.from_zip) {
    throw new Error('Add your return address in the ledger (Shop → Shipping settings)');
  }
  const t = o.ship_to!;
  const call = async (path: string, payload: unknown) => {
    const r = await fetch(`https://api.goshippo.com${path}`, {
      method: 'POST',
      headers: { Authorization: `ShippoToken ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Shippo: ${b.detail ?? JSON.stringify(b).slice(0, 200)}`);
    return b;
  };
  const shipment = await call('/shipments/', {
    async: false,
    address_from: {
      name: s.from_name ?? 'DaBirddy',
      street1: s.from_street1,
      street2: s.from_street2 ?? '',
      city: s.from_city,
      state: s.from_state,
      zip: s.from_zip,
      country: 'US',
      phone: s.from_phone ?? '',
      email: s.from_email ?? '',
    },
    address_to: {
      name: t.name || o.buyer_name,
      street1: t.line1,
      street2: t.line2 ?? '',
      city: t.city,
      state: t.state,
      zip: t.postal_code,
      country: t.country,
      phone: o.buyer_phone ?? '',
      email: o.buyer_email ?? '',
    },
    parcels: [{
      length: String(s.package_length_in),
      width: String(s.package_width_in),
      height: String(s.package_height_in),
      distance_unit: 'in',
      weight: String(s.package_weight_oz),
      mass_unit: 'oz',
    }],
    metadata: o.order_number,
  });
  const rates: any[] = (shipment.rates ?? []).filter((r: any) => /usps/i.test(r.provider));
  if (!rates.length) throw new Error('Shippo returned no USPS rates for this address');
  const byPrice = (a: any, b: any) => Number(a.amount) - Number(b.amount);
  const ground = rates.filter((r) => /ground_advantage/i.test(r.servicelevel?.token ?? '')).sort(byPrice);
  const rate = (ground[0] ?? rates.sort(byPrice)[0]);
  const tx = await call('/transactions/', { rate: rate.object_id, label_file_type: 'PDF_4x6', async: false, metadata: o.order_number });
  if (tx.status !== 'SUCCESS') {
    throw new Error(`Shippo: ${(tx.messages ?? []).map((m: any) => m.text).join('; ') || tx.status}`);
  }
  return {
    tracking_number: tx.tracking_number,
    label_url: tx.label_url,
    label_cost_cents: Math.round(Number(rate.amount) * 100),
    carrier: 'USPS',
  };
}

/**
 * Make the label for an order (if it hasn't got one) and save the result or
 * the error on the order. Never throws: a failed label is retried from the ledger.
 */
export async function makeLabel(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db.from('shop_orders').select('*').eq('id', orderId).single();
  if (error) return { ok: false, error: error.message };
  const o = data as Order;
  if (o.tracking_number) return { ok: true };
  if (!o.ship_to) return { ok: false, error: 'No shipping address on this order' };
  try {
    const s = await loadSettings();
    const label = o.method === 'envelope' ? await tcgTrackingLabel(o) : await shippoLabel(o, s);
    await db.from('shop_orders').update({
      tracking_number: label.tracking_number,
      label_path: label.label_path ?? null,
      label_url: label.label_url ?? null,
      label_cost_cents: label.label_cost_cents ?? null,
      label_error: null,
      print_requested_at: new Date().toISOString(), // the Rollo listener prints it
    }).eq('id', o.id);
    if (label.label_cost_cents && s.payout_partner_id) await logPostage(o, label.label_cost_cents, s.payout_partner_id);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('label', o.order_number, msg);
    await db.from('shop_orders').update({ label_error: msg }).eq('id', o.id);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------- ledger --

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

function describe(o: Order) {
  const names = o.items.map((it) => (it.qty > 1 ? `${it.qty}× ${it.title}` : it.title)).join(', ');
  const text = `Website ${o.order_number}: ${names}`;
  return text.length > 200 ? text.slice(0, 197) + '…' : text;
}

/** Log the sale in the partner ledger, credited to the payout partner, split 50/50. Once per order. */
export async function logSale(orderId: string): Promise<void> {
  const { data } = await db.from('shop_orders').select('*').eq('id', orderId).single();
  const o = data as Order | null;
  if (!o || o.ledger_entry_id || o.total_cents == null) return;
  const s = await loadSettings();
  if (!s.payout_partner_id) return;
  const fee = o.stripe_fee_cents ?? 0;
  const net = (o.total_cents - fee) / 100;
  const id = crypto.randomUUID();
  const { error } = await db.from('entries').insert({
    id,
    occurred_on: today(),
    kind: 'sell',
    partner_id: s.payout_partner_id,
    amount: net,
    owner_id: null,
    fee: fee / 100,
    platform: 'DaBirddy.com',
    description: describe(o),
    note: `Order ${o.order_number} · cards $${usd(o.subtotal_cents)} + shipping $${usd(o.shipping_cents)}${fee ? ` · Stripe fee $${usd(fee)}` : ''}`,
    source: 'import',
    photos: o.items.map((it) => it.photo).filter(Boolean),
    payments: [{ method: 'payout', amount: net }],
    created_by: s.payout_partner_id,
  });
  if (error) {
    console.error('ledger entry', o.order_number, error.message);
    return;
  }
  await db.from('shop_orders').update({ ledger_entry_id: id }).eq('id', o.id);
}

async function logPostage(o: Order, cents: number, partnerId: string) {
  const { error } = await db.from('entries').insert({
    occurred_on: today(),
    kind: 'expense',
    partner_id: partnerId,
    amount: -cents / 100,
    owner_id: null,
    platform: 'Shippo',
    description: `Postage for website ${o.order_number}`,
    source: 'import',
    payments: [{ method: 'card', amount: cents / 100 }],
    created_by: partnerId,
  });
  if (error) console.error('postage entry', o.order_number, error.message);
}

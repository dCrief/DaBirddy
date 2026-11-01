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
  envelope_cost_cents: number; // what an envelope label costs us (TCG doesn't return a price)
  package_cents: number;
  envelope_under_cents: number;
  envelope_max_cards: number; // more cards than this ship in a package
  auto_print: boolean; // send new labels straight to David's Rollo
  offers_enabled: boolean;
  offer_min_percent: number;
  parcel_template_id: string | null; // Shippo parcel template for packages (null = the "4 oz Ground" one)
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
  owner_id?: string | null; // whose item (null = shared 50/50)
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

/** Envelope for a few cards under the cutoff; a package for more cards, a bigger total, or anything sealed. */
export function shippingFor(items: Pick<OrderItem, 'price_cents' | 'qty' | 'category'>[], s: Pick<Settings, 'envelope_cents' | 'package_cents' | 'envelope_under_cents' | 'envelope_max_cards'>) {
  const subtotal = items.reduce((n, it) => n + it.price_cents * it.qty, 0);
  const cards = items.reduce((n, it) => n + it.qty, 0);
  const bulky = items.some((it) => it.category === 'sealed') || cards > (s.envelope_max_cards ?? 5);
  const method: 'envelope' | 'package' = !bulky && subtotal < s.envelope_under_cents ? 'envelope' : 'package';
  return { method, cents: method === 'envelope' ? s.envelope_cents : s.package_cents, subtotal };
}

export const usd = (cents: number) => (cents / 100).toFixed(2);

// ---------------------------------------------------------------- labels --

export type LabelResult = {
  tracking_number: string;
  label_path?: string;
  label_url?: string;
  label_cost_cents?: number;
  carrier: string;
};

/** Envelope label from TCG Tracking. Re-sending the same order number returns the existing label. */
export async function tcgTrackingLabel(o: Order): Promise<LabelResult> {
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

export type ParcelTemplate = { id: string; name: string; length: string; width: string; height: string; distance_unit: string; weight: string; weight_unit: string };

/** The parcel templates saved in the Shippo account (Settings → Parcel Templates). */
export async function parcelTemplates(): Promise<ParcelTemplate[]> {
  const key = Deno.env.get('SHIPPO_API_KEY');
  if (!key) return [];
  const r = await fetch('https://api.goshippo.com/user-parcel-templates/', { headers: { Authorization: `ShippoToken ${key}` } });
  if (!r.ok) throw new Error(`Shippo templates: ${r.status}`);
  const b = await r.json();
  return ((b.results ?? []) as any[]).map((t) => ({
    id: t.object_id, name: t.name ?? 'Template', length: String(t.length), width: String(t.width), height: String(t.height),
    distance_unit: t.distance_unit ?? 'in', weight: String(t.weight ?? ''), weight_unit: t.weight_unit ?? 'oz',
  }));
}

/** The default template: the one chosen in settings, else the one named like "4 oz Ground". */
export function defaultTemplate(templates: ParcelTemplate[], s: Pick<Settings, 'parcel_template_id'>): ParcelTemplate | null {
  if (s.parcel_template_id === 'custom') return null; // "Custom size" in settings
  return templates.find((t) => t.id === s.parcel_template_id)
    ?? templates.find((t) => /\b4\s*oz\b.*ground/i.test(t.name))
    ?? null;
}

/** The parcel to ship: a template (by id, or the default) or the package size in settings. */
async function parcelFor(s: Settings, templateId?: string | null) {
  const templates = await parcelTemplates().catch(() => []);
  const t = (templateId && templates.find((x) => x.id === templateId)) || defaultTemplate(templates, s);
  if (t) {
    // A template saved without a weight takes the weight from settings.
    const weight = t.weight && t.weight !== 'null' ? { weight: t.weight, mass_unit: t.weight_unit } : { weight: String(s.package_weight_oz), mass_unit: 'oz' };
    return { length: t.length, width: t.width, height: t.height, distance_unit: t.distance_unit, ...weight };
  }
  return {
    length: String(s.package_length_in), width: String(s.package_width_in), height: String(s.package_height_in),
    distance_unit: 'in', weight: String(s.package_weight_oz), mass_unit: 'oz',
  };
}

/** Package label from Shippo: cheapest USPS Ground Advantage, falling back to the cheapest USPS rate. */
export async function shippoLabel(o: Order, s: Settings, templateId?: string | null): Promise<LabelResult> {
  const key = Deno.env.get('SHIPPO_API_KEY');
  if (!key) throw new Error('Shippo isn’t connected yet (add SHIPPO_API_KEY)');
  if (!s.from_street1 || !s.from_city || !s.from_state || !s.from_zip) {
    throw new Error('Add your return address in the ledger (Settings → Shop & shipping)');
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
    parcels: [await parcelFor(s, templateId)],
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

/** USPS's take on an address, via Shippo: whether it exists, and its standard form. */
export type Verified = { valid: boolean; address: ShipTo; messages: string[] };

export async function verifyAddress(t: ShipTo): Promise<Verified> {
  const key = Deno.env.get('SHIPPO_API_KEY');
  if (!key) throw new Error('Address checking needs Shippo (add SHIPPO_API_KEY)');
  const r = await fetch('https://api.goshippo.com/addresses/', {
    method: 'POST',
    headers: { Authorization: `ShippoToken ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: t.name, street1: t.line1, street2: t.line2 ?? '', city: t.city, state: t.state,
      zip: t.postal_code, country: t.country || 'US', validate: true,
    }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Address check failed: ${b.detail ?? r.status}`);
  const v = b.validation_results ?? {};
  return {
    valid: v.is_valid === true,
    address: {
      name: t.name,
      line1: b.street1 || t.line1,
      line2: b.street2 || null,
      city: b.city || t.city,
      state: b.state || t.state,
      postal_code: b.zip || t.postal_code,
      country: b.country || t.country || 'US',
    },
    messages: ((v.messages ?? []) as { text?: string }[]).map((m) => m.text ?? '').filter(Boolean),
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
    // Standardize the address the USPS way first; flag it if USPS can't find it.
    const check = await verifyAddress(o.ship_to).catch(() => null);
    if (check) {
      if (check.valid) o.ship_to = check.address;
      await db.from('shop_orders').update({
        ship_to: o.ship_to,
        address_warning: check.valid ? null : `USPS couldn’t confirm this address${check.messages[0] ? `: ${check.messages[0]}` : ''}. Check it with the buyer.`,
      }).eq('id', o.id);
    }
    const label = o.method === 'envelope' ? await tcgTrackingLabel(o) : await shippoLabel(o, s);
    const cost = label.label_cost_cents ?? (o.method === 'envelope' ? s.envelope_cost_cents : null);
    await db.from('shop_orders').update({
      tracking_number: label.tracking_number,
      label_path: label.label_path ?? null,
      label_url: label.label_url ?? null,
      label_cost_cents: cost,
      label_error: null,
      // The Rollo listener prints it now, or when someone taps Print in the ledger.
      ...(s.auto_print ? { print_requested_at: new Date().toISOString() } : {}),
    }).eq('id', o.id);
    // Postage is the payout partner's (David's) cost, like the sale is his.
    if (cost && s.payout_partner_id) await logPostage(o, cost, s.payout_partner_id, label.carrier);
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

/**
 * Log the sale in the partner ledger, credited to the payout partner (whose
 * Stripe pays out). Each item's owner decides the split: shared items 50/50,
 * a partner's own items all theirs. An order mixing owners becomes one entry
 * per owner, with shipping and the Stripe fee shared out by item value. Once per order.
 */
type SalePart = { key: string; items: OrderItem[]; part: number; total: number; fee: number };

/** Splits a website order into one ledger line per card owner (shared cards together), pro-rating total and Stripe fee. */
function splitSale(o: Order, fee: number): SalePart[] {
  const groups = new Map<string, OrderItem[]>();
  for (const it of o.items) {
    const k = it.owner_id ?? 'shared';
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const keys = [...groups.keys()];
  const sub = o.subtotal_cents || 1;
  let leftTotal = o.total_cents!, leftFee = fee;
  return keys.map((key, i) => {
    const items = groups.get(key)!;
    const part = items.reduce((n, it) => n + it.price_cents * it.qty, 0);
    const last = i === keys.length - 1;
    const total = last ? leftTotal : Math.round((o.total_cents! * part) / sub);
    const f = last ? leftFee : Math.round((fee * part) / sub);
    leftTotal -= total;
    leftFee -= f;
    return { key, items, part, total, fee: f };
  });
}

const saleNote = (o: Order, p: SalePart, parts: number, fee: number) =>
  `Order ${o.order_number} · cards $${usd(p.part)}${parts > 1 ? ` (part of $${usd(o.subtotal_cents)})` : ''} + shipping${fee ? ` · Stripe fee $${usd(p.fee)}` : ''}`;

/**
 * Logs a website sale for the payout partner (David, whose Stripe account is paid). Amounts are net of
 * the Stripe fee, so the fee comes off David's cash and off each owner's share of the sale.
 */
export async function logSale(orderId: string): Promise<void> {
  const { data } = await db.from('shop_orders').select('*').eq('id', orderId).single();
  const o = data as Order | null;
  if (!o || o.ledger_entry_id || o.total_cents == null) return;
  const s = await loadSettings();
  if (!s.payout_partner_id) return;
  const fee = o.stripe_fee_cents ?? 0;
  const parts = splitSale(o, fee);
  let firstId: string | null = null;
  for (const p of parts) {
    const net = (p.total - p.fee) / 100;
    const id = crypto.randomUUID();
    const names = p.items.map((it) => (it.qty > 1 ? `${it.qty}× ${it.title}` : it.title)).join(', ');
    const desc = `Website ${o.order_number}: ${names}`;
    const { error } = await db.from('entries').insert({
      id,
      occurred_on: today(),
      kind: 'sell',
      partner_id: s.payout_partner_id,
      amount: net,
      owner_id: p.key === 'shared' ? null : p.key,
      fee: p.fee / 100,
      platform: 'DaBirddy.com',
      description: desc.length > 200 ? desc.slice(0, 197) + '…' : desc,
      note: saleNote(o, p, parts.length, fee),
      source: 'import',
      photos: p.items.map((it) => it.photo).filter(Boolean),
      payments: [{ method: 'payout', amount: net }],
      created_by: s.payout_partner_id,
    });
    if (error) {
      console.error('ledger entry', o.order_number, error.message);
      return;
    }
    firstId ??= id;
  }
  await db.from('shop_orders').update({ ledger_entry_id: firstId }).eq('id', o.id);
}

/**
 * Stripe often hasn't settled the fee when the payment webhook runs, so a sale can be logged with no fee.
 * Once the order has its fee, this takes it off the sale's ledger lines. Lines someone edited by hand are left alone.
 */
export async function syncSaleFee(orderId: string): Promise<boolean> {
  const { data } = await db.from('shop_orders').select('*').eq('id', orderId).single();
  const o = data as Order | null;
  if (!o || !o.ledger_entry_id || o.total_cents == null || o.stripe_fee_cents == null) return false;
  const { data: rows } = await db.from('entries').select('id, owner_id, amount, fee')
    .eq('kind', 'sell').is('deleted_at', null).like('note', `Order ${o.order_number} ·%`);
  if (!rows?.length) return false;
  const logged = rows.reduce((n, r) => n + Math.round(Number(r.fee) * 100), 0);
  if (logged === o.stripe_fee_cents) return false;
  const before = splitSale(o, logged), after = splitSale(o, o.stripe_fee_cents);
  if (before.length !== rows.length) return false;
  let changed = false;
  for (const [i, p] of after.entries()) {
    const owner = p.key === 'shared' ? null : p.key;
    const row = rows.find((r) => r.owner_id === owner);
    if (!row || Math.round(Number(row.amount) * 100) !== before[i].total - before[i].fee) continue;
    const net = (p.total - p.fee) / 100;
    const { error } = await db.from('entries').update({
      amount: net,
      fee: p.fee / 100,
      payments: [{ method: 'payout', amount: net }],
      note: saleNote(o, p, after.length, o.stripe_fee_cents),
    }).eq('id', row.id);
    if (error) console.error('fee sync', o.order_number, error.message);
    else changed = true;
  }
  if (changed) console.log(`fee sync ${o.order_number}: Stripe fee $${usd(o.stripe_fee_cents)}`);
  return changed;
}

/** Whose postage it is: the owner when every card in the order is one partner's (they get the buyer's shipping too), else shared. */
function postageOwner(o: Order): string | null {
  const owners = new Set(o.items.map((it) => it.owner_id ?? null));
  return owners.size === 1 ? [...owners][0] : null;
}

async function logPostage(o: Order, cents: number, partnerId: string, carrier: string) {
  const { error } = await db.from('entries').insert({
    occurred_on: today(),
    kind: 'expense',
    partner_id: partnerId,
    amount: -cents / 100,
    owner_id: postageOwner(o), // the cards' owner when they're all one partner's; otherwise shared (50/50)
    platform: o.method === 'envelope' ? 'TCG Tracking' : 'Shippo',
    description: `Postage for website ${o.order_number}`,
    note: `${o.method === 'envelope' ? 'Tracked envelope' : `${carrier} package`} · tracking on the order`,
    source: 'import',
    payments: [{ method: 'card', amount: cents / 100 }],
    created_by: partnerId,
  });
  if (error) console.error('postage entry', o.order_number, error.message);
}

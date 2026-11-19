/**
 * POST /deal-label — a shipping label for a deal logged in the ledger
 * (Whatnot, eBay, in person...), made with the shop's TCG Tracking (envelope)
 * or Shippo (package) account. David's accounts pay the label cost
 * (the payout partner); it is charged to the cards' owners, split by sale price.
 *
 * Body: { method: 'envelope'|'package', ship_to: { name, line1, line2?, city, state, postal_code },
 *         description?, value_cents?, partner_id, owner_id?, force?, entry_id? }
 *   or { action: 'verify', ship_to } -> { valid, address, messages }: the USPS-standard address.
 *   or { action: 'templates' } -> { templates, default_id }: the Shippo parcel templates for packages.
 * template_id (packages) picks one of those; otherwise the default.
 * Buying re-checks the address and ships to the standard form; an address USPS
 * can't find is refused (needs_confirm) unless force is true.
 * entry_id is the ledger entry (the sale) the label belongs to; the ledger shows the
 * label on that entry. Every label PDF is kept in the shop-labels bucket (Shippo's
 * own links expire), so it can be opened from the entry for good.
 * Partners only (signed-in ledger user).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { db, defaultTemplate, loadSettings, parcelTemplates, shippoLabel, splitPostage, tcgTrackingLabel, verifyAddress, type Order } from '../_shared/cards.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Copy a label PDF from the carrier's link into the shop-labels bucket; its path, or null. */
async function keepPdf(url: string, path: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const { error } = await db.storage.from('shop-labels').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (error) throw error;
    return path;
  } catch (err) {
    // label-archive retries it later.
    console.error('keep label pdf', path, err);
    return null;
  }
}

/**
 * Whose cards the label ships, with what each sold for. An eBay order that mixes owners is logged as one
 * sale line per owner, so every line of that order counts. Otherwise it's the owner picked on the deal.
 */
async function saleOwners(entryId: string | null, fallback: string | null): Promise<{ owner: string | null; value: number }[]> {
  if (entryId) {
    const { data: e } = await db.from('entries').select('description').eq('id', entryId).maybeSingle();
    const ebay = e?.description?.match(/^eBay (\S+):/);
    if (ebay) {
      const { data: lines } = await db.from('entries').select('owner_id, amount, fee')
        .eq('kind', 'sell').is('deleted_at', null).like('description', `eBay ${ebay[1]}:%`);
      if (lines?.length) return lines.map((l) => ({ owner: l.owner_id, value: Math.round((Number(l.amount) + Number(l.fee ?? 0)) * 100) }));
    }
  }
  return [{ owner: fallback, value: 0 }];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Who's asking: a signed-in partner.
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user?.email) return json({ error: 'Sign in first' }, 401);
  const { data: me } = await db.from('partners').select('id').ilike('email', user.email).maybeSingle();
  if (!me) return json({ error: 'Not a partner' }, 403);

  const b = await req.json().catch(() => ({}));
  const method = b.method === 'package' ? 'package' : b.method === 'envelope' ? 'envelope' : null;
  const t = b.ship_to ?? {};
  const ship_to = {
    name: str(t.name),
    line1: str(t.line1),
    line2: str(t.line2) || null,
    city: str(t.city),
    state: str(t.state, 2).toUpperCase(),
    postal_code: str(t.postal_code, 10),
    country: 'US',
  };
  if (b.action === 'templates') {
    try {
      const [templates, s] = await Promise.all([parcelTemplates(), loadSettings()]);
      return json({ templates, default_id: defaultTemplate(templates, s)?.id ?? null });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }
  if (b.action === 'verify') {
    if (!ship_to.line1 || !ship_to.city || !ship_to.state || !ship_to.postal_code) return json({ error: 'Fill in the street, city, state and ZIP' }, 400);
    try {
      return json(await verifyAddress(ship_to));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  const { data: partners } = await db.from('partners').select('id');
  const ids = new Set((partners ?? []).map((p) => p.id));
  if (!method) return json({ error: 'Pick envelope or package' }, 400);
  if (!ship_to.name || !ship_to.line1 || !ship_to.city) return json({ error: 'Fill in the name, street and city' }, 400);
  if (!/^[A-Z]{2}$/.test(ship_to.state)) return json({ error: 'State must be 2 letters, like MD' }, 400);
  if (!/^\d{5}(-\d{4})?$/.test(ship_to.postal_code)) return json({ error: 'ZIP must be 5 digits' }, 400);
  if (!ids.has(b.partner_id)) return json({ error: 'Pick whose deal this is' }, 400);
  const owner_id = ids.has(b.owner_id) ? b.owner_id : null;
  const description = str(b.description, 120) || null;
  const value_cents = Number.isInteger(b.value_cents) && b.value_cents > 0 ? Math.min(b.value_cents, 9_999_999) : null;
  const entry_id = typeof b.entry_id === 'string' && UUID.test(b.entry_id) ? b.entry_id : null;

  // Ship to the USPS-standard form of the address; stop if USPS can't find it.
  try {
    const check = await verifyAddress(ship_to);
    if (check.valid) Object.assign(ship_to, check.address);
    else if (b.force !== true) {
      return json({ error: `USPS couldn’t confirm this address${check.messages[0] ? `: ${check.messages[0]}` : ''}`, needs_confirm: true, messages: check.messages }, 422);
    }
  } catch (err) {
    if (b.force !== true) return json({ error: err instanceof Error ? err.message : String(err), needs_confirm: true }, 422);
  }

  const { data: row, error: ie } = await db.from('shipping_labels')
    .insert({ method, ship_to, description, value_cents, partner_id: b.partner_id, owner_id, entry_id, created_by: me.id })
    .select('id, ref').single();
  if (ie) return json({ error: ie.message }, 500);

  try {
    const s = await loadSettings();
    const order = {
      id: row.id,
      order_number: row.ref,
      status: 'paid',
      items: [{ listing_id: '', title: description ?? 'Trading cards', set: null, number: null, category: 'single', price_cents: value_cents ?? 100, qty: 1, photo: null }],
      subtotal_cents: value_cents ?? 100,
      shipping_cents: 0,
      total_cents: value_cents,
      method,
      buyer_name: ship_to.name,
      buyer_email: null,
      buyer_phone: null,
      ship_to,
      tracking_number: null,
      label_path: null,
      label_url: null,
      label_error: null,
      stripe_fee_cents: null,
      ledger_entry_id: null,
    } satisfies Order;
    const label = method === 'envelope' ? await tcgTrackingLabel(order) : await shippoLabel(order, s, typeof b.template_id === 'string' ? b.template_id : null);
    const cost = label.label_cost_cents ?? (method === 'envelope' ? s.envelope_cost_cents : 0);

    // David's accounts pay for the label; the cost goes to the cards' owners, split by sale price.
    let expense_entry_id: string | null = null;
    if (cost) {
      const parts = splitPostage(cost, await saleOwners(entry_id, owner_id));
      const base = `Label ${row.ref} · ${method === 'envelope' ? 'tracked envelope' : 'USPS package'} · tracking ${label.tracking_number}`;
      const total = parts.reduce((n, p) => n + p.value, 0);
      for (const p of parts) {
        const { data: e, error: ee } = await db.from('entries').insert({
          occurred_on: today(),
          kind: 'expense',
          partner_id: s.payout_partner_id ?? b.partner_id,
          owner_id: p.owner, // null = shared (50/50)
          amount: -p.cents / 100,
          platform: method === 'envelope' ? 'TCG Tracking' : 'Shippo',
          description: `Postage${description ? `: ${description}` : ''} (${ship_to.name})`.slice(0, 200),
          note: parts.length > 1
            ? `${base} · $${(cost / 100).toFixed(2)} label split by sale price: this part $${(p.cents / 100).toFixed(2)} for $${(p.value / 100).toFixed(2)} of $${(total / 100).toFixed(2)}`
            : base,
          source: 'import',
          payments: [{ method: 'card', amount: p.cents / 100 }],
          created_by: me.id,
        }).select('id').single();
        if (ee) console.error('postage entry', row.ref, ee.message);
        expense_entry_id ??= e?.id ?? null;
      }
    }

    // Keep our own copy of the PDF: Shippo's link stops working after a while.
    const label_path = label.label_path ?? (label.label_url ? await keepPdf(label.label_url, `${row.ref}.pdf`) : null);

    await db.from('shipping_labels').update({
      tracking_number: label.tracking_number,
      label_path,
      label_url: label.label_url ?? null,
      cost_cents: cost,
      expense_entry_id,
      ...(s.auto_print ? { print_requested_at: new Date().toISOString() } : {}),
    }).eq('id', row.id);

    let pdf = label.label_url ?? null;
    if (label_path) {
      const { data: signed } = await db.storage.from('shop-labels').createSignedUrl(label_path, 3600);
      pdf = signed?.signedUrl ?? pdf;
    }
    return json({ ok: true, id: row.id, ref: row.ref, tracking_number: label.tracking_number, cost_cents: cost, pdf, logged: !!expense_entry_id, ship_to });
  } catch (err) {
    // Nothing was bought: drop the row so it doesn't linger.
    await db.from('shipping_labels').delete().eq('id', row.id);
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

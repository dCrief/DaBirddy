/**
 * The print queue for the label printer listener on David's PC.
 *
 *   GET  /label-printer          -> { jobs: [{ id, order, requested_at, url }] }
 *   POST /label-printer { id, requested_at, error? }  -> marks the job printed (or failed)
 *
 * Auth: the SHA-256 of X-Printer-Token must be in private.printer_tokens. Deploy with
 * --no-verify-jwt (the listener has no Supabase login).
 */

import { db } from '../_shared/cards.ts';
import { portrait } from '../_shared/portrait.ts';
import { packingSlip, type SlipOrder } from '../_shared/slip.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function authorized(req: Request) {
  const token = req.headers.get('X-Printer-Token') ?? '';
  if (token.length < 32) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { data } = await db.rpc('printer_token_ok', { p_hash: hash });
  return data === true;
}

// Envelope labels (TCG Tracking) are saved 6x4 landscape; turn them 4x6 portrait once,
// before the first print, so the Rollo prints them like any other 4x6 label.
async function makePortrait(path: string) {
  try {
    const { data } = await db.storage.from('shop-labels').download(path);
    if (!data) return;
    const turned = await portrait(new Uint8Array(await data.arrayBuffer()));
    if (!turned) return;
    const { error } = await db.storage.from('shop-labels').upload(path, turned, { contentType: 'application/pdf', upsert: true });
    if (error) console.error('portrait upload', path, error.message);
    else console.log('turned portrait', path);
  } catch (err) {
    console.error('makePortrait', path, err);
  }
}

async function slipFor(o: SlipOrder): Promise<string | null> {
  try {
    const path = `slips/${o.order_number}.pdf`;
    const { error } = await db.storage.from('shop-labels').upload(path, await packingSlip(o), { contentType: 'application/pdf', upsert: true });
    if (error) throw error;
    const { data } = await db.storage.from('shop-labels').createSignedUrl(path, 600);
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error('packing slip', o.order_number, err);
    return null;
  }
}

type DealLabel = {
  id: string; ref: string; print_requested_at: string; printed_at: string | null; label_path: string | null; label_url: string | null;
  entry_id: string | null; description: string | null; value_cents: number | null; ship_to: { name?: string | null } | null; created_at: string;
};

const cents = (v: unknown) => Math.round(Number((v as { value?: string } | null)?.value ?? 0) * 100);

/**
 * Labels made from Log a deal get a packing slip too. When the sale is an eBay order, the slip
 * shows the eBay order's items and totals (the SKU is our stock number); otherwise it lists the
 * label's description with no prices.
 */
async function dealSlips(labels: DealLabel[]) {
  const entryIds = labels.map((l) => l.entry_id).filter(Boolean) as string[];
  const ebay = new Map<string, Record<string, unknown>>();
  if (entryIds.length) {
    const { data, error } = await db.from('ebay_orders')
      .select('order_id, ordered_at, buyer, total_cents, items_cents, shipping_cents, items, ship_to, ledger_entry_id')
      .in('ledger_entry_id', entryIds);
    if (error) console.error('ebay orders for slips', error.message);
    for (const o of data ?? []) ebay.set(o.ledger_entry_id, o);
  }
  return labels.map((l) => {
    const e = l.entry_id ? ebay.get(l.entry_id) : undefined;
    let slip: SlipOrder;
    if (e) {
      const items = ((e.items as Record<string, unknown>[]) ?? []).map((it) => {
        const qty = Number(it.quantity ?? 1) || 1;
        return {
          title: String(it.title ?? 'Item').replace(/\s+Pokemon Card$/i, ''),
          set: null, number: null,
          price_cents: Math.round(cents(it.lineItemCost) / qty),
          qty,
          inventory_no: typeof it.sku === 'string' && it.sku ? it.sku : null,
        };
      });
      slip = {
        order_number: String(e.order_id), source: 'eBay order', created_at: String(e.ordered_at ?? l.created_at), items,
        subtotal_cents: Number(e.items_cents ?? 0), shipping_cents: Number(e.shipping_cents ?? 0),
        total_cents: Number(e.items_cents ?? 0) + Number(e.shipping_cents ?? 0), coupon_code: null,
        buyer_name: (e.buyer as string) ?? null, ship_to: (e.ship_to as { name?: string }) ?? l.ship_to,
      };
    } else {
      slip = {
        order_number: l.ref, created_at: l.created_at, hide_prices: true,
        items: [{ title: l.description || 'Your order', set: null, number: null, price_cents: 0, qty: 1 }],
        subtotal_cents: 0, shipping_cents: 0, total_cents: null, coupon_code: null, buyer_name: null, ship_to: l.ship_to,
      };
    }
    return { ...l, name: l.ref, slip: slip as SlipOrder | null };
  });
}

Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: 'Unauthorized' }, 401);

  if (req.method === 'GET') {
    // Website orders and labels made from Log a deal share one queue.
    const since = new Date(Date.now() - 3 * 86400e3).toISOString();
    const [orders, labels] = await Promise.all([
      db.from('shop_orders')
        .select('id, order_number, print_requested_at, printed_at, label_path, label_url, created_at, items, subtotal_cents, shipping_cents, total_cents, coupon_code, buyer_name, ship_to, combine_shipping, combine_with, whatnot_username')
        // Combined-shipping orders have no label of their own; only their packing slip prints.
        .not('print_requested_at', 'is', null).or('tracking_number.not.is.null,combine_shipping.eq.true')
        .neq('status', 'cancelled').gt('print_requested_at', since).limit(20),
      db.from('shipping_labels')
        .select('id, ref, print_requested_at, printed_at, label_path, label_url, entry_id, description, value_cents, ship_to, created_at')
        .not('print_requested_at', 'is', null).not('tracking_number', 'is', null)
        .gt('print_requested_at', since).limit(20),
    ]);
    if (orders.error) return json({ error: orders.error.message }, 500);
    if (labels.error) return json({ error: labels.error.message }, 500);
    const rows = [
      ...(orders.data ?? []).map((o) => ({ ...o, name: o.order_number, slip: o as SlipOrder | null, slipOnly: !!o.combine_shipping && !o.label_path && !o.label_url })),
      ...(await dealSlips(labels.data ?? [])),
    ].sort((a, b) => a.print_requested_at.localeCompare(b.print_requested_at));
    // Stock numbers for the packing slips.
    const ids = rows.flatMap((r) => (r.slip?.items ?? []).map((it) => it.listing_id)).filter(Boolean) as string[];
    const stock = new Map<string, string>();
    if (ids.length) {
      const { data } = await db.from('shop_listings').select('id, inventory_no').in('id', ids);
      for (const l of data ?? []) if (l.inventory_no) stock.set(l.id, l.inventory_no);
    }
    for (const r of rows) {
      if (r.slip) r.slip = { ...r.slip, items: r.slip.items.map((it) => ({ ...it, inventory_no: it.inventory_no ?? (it.listing_id ? stock.get(it.listing_id) ?? null : null) })) };
    }
    const jobs = [];
    for (const o of rows) {
      if (o.printed_at && o.printed_at >= o.print_requested_at) continue;
      let url = o.label_url as string | null;
      if (!url && o.label_path) {
        await makePortrait(o.label_path);
        const { data: s } = await db.storage.from('shop-labels').createSignedUrl(o.label_path, 600);
        url = s?.signedUrl ?? null;
      }
      if (url) jobs.push({ id: o.id, order: o.name, requested_at: o.print_requested_at, url });
      // A packing slip right after the label, every time it prints.
      if ((url || ('slipOnly' in o && o.slipOnly)) && o.slip) {
        const slipUrl = await slipFor(o.slip);
        if (slipUrl) jobs.push({ id: o.id, order: `${o.name}-slip`, requested_at: o.print_requested_at, url: slipUrl });
      }
    }
    return json({ jobs });
  }

  if (req.method === 'POST') {
    const { id, requested_at, error } = await req.json().catch(() => ({}));
    if (typeof id !== 'string' || typeof requested_at !== 'string') return json({ error: 'id and requested_at required' }, 400);
    // Mark printed as of the request we printed, so a reprint asked for meanwhile still prints.
    const patch = error ? { print_error: String(error).slice(0, 300) } : { printed_at: requested_at, print_error: null };
    for (const table of ['shop_orders', 'shipping_labels']) {
      const { error: e } = await db.from(table).update(patch).eq('id', id);
      if (e) return json({ error: e.message }, 500);
    }
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
});

/**
 * /whatnot — takes a shop card off dabirddy.com (and so off eBay) when it sells on Whatnot.
 *
 * Shop cards are listed on David's Whatnot shop as Buy It Now products whose external_id is the
 * shop inventory # (S0060, D0005, ...). Every 5 minutes pg_cron posts { action: 'tick' } here. The
 * tick reads new Whatnot orders (Seller API, newest first, back to the last check), looks at each
 * order's items, and for every item that is one of our cards (product_external_id = inventory #, or
 * product_id = shop_listings.whatnot_product_id) takes the quantity off the listing with
 * whatnot_take_stock. At 0 the listing turns sold, which hides it on the site and, through the
 * existing eBay triggers, ends its eBay listing. Each order is looked at once (whatnot_orders).
 * The partners get a push ("Sold on Whatnot"), or a warning when the card had already sold
 * somewhere else, so the Whatnot order can be cancelled.
 *
 * Nothing is written to the ledger: Whatnot payouts are logged by hand per stream.
 *
 * Callers:
 *   x-hub-token (vault shop_sync_token): { action: 'tick' } | { action: 'status' }
 *
 * Secret: WHATNOT_TOKEN, a Whatnot personal access token (wn_pat_tk_...) with read:orders, made at
 * whatnot.com/dashboard/developer?tab=tokens. Deploy with --no-verify-jwt.
 */

import { db } from '../_shared/cards.ts';
import { money, notifyLedger } from '../_shared/push.ts';

const API = 'https://api.whatnot.com/seller-api/rest/v2';
const TOKEN = Deno.env.get('WHATNOT_TOKEN') ?? '';
const BUDGET_MS = 110_000; // stay well inside the function time limit
const SKIP_STATUS = new Set(['failed', 'cancelled', 'canceled', 'refunded']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (m?: { amount?: string } | null) => (m?.amount ? Math.round(Number(m.amount) * 100) : 0);

type Order = {
  id: string;
  status: string;
  transaction_type: string | null;
  buyer?: { username?: string } | null;
  amounts?: { total?: { amount: string } } | null;
  created_at: string;
};
type Item = {
  id: string;
  product_id: string | null;
  product_external_id: string | null;
  quantity: number;
  unit_price?: { amount: string } | null;
  purchased_item?: { title?: string } | null;
};

class WhatnotError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The API allows 2 requests a second.
let lastCall = 0;
async function wn(path: string): Promise<any> {
  const wait = lastCall + 550 - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; ; attempt++) {
    lastCall = Date.now();
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' } });
    if (r.status === 429 && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new WhatnotError(r.status, `Whatnot ${r.status} ${path}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}

async function items(orderId: string): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const r = await wn(`/orders/${orderId}/items?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...((r?.data ?? []) as Item[]));
    cursor = r?.next_cursor ?? null;
  } while (cursor);
  return out;
}

/** Look at one order once. Returns true when it had one of our cards. */
async function takeOrder(o: Order): Promise<boolean> {
  const list = await items(o.id);
  // Claim the order first so two runs can't both take it.
  const { error: ce } = await db.from('whatnot_orders').insert({
    order_id: o.id,
    ordered_at: o.created_at,
    status: o.status,
    transaction_type: o.transaction_type,
    total_cents: cents(o.amounts?.total),
  });
  if (ce) {
    if (/duplicate/i.test(ce.message)) return false;
    throw new Error(`save order ${o.id}: ${ce.message}`);
  }
  type Taken = { title: string; before: number; after: number; qty: number; price: number; inv: string | null };
  const taken: Taken[] = [];
  const ids: string[] = [];
  for (const it of list) {
    const ext = it.product_external_id?.trim().toUpperCase() || null;
    if (!ext && !it.product_id) continue;
    const { data, error } = await db.rpc('whatnot_take_stock', {
      p_external: ext,
      p_product: it.product_id,
      p_qty: Math.max(1, it.quantity || 1),
    });
    if (error) throw new Error(`take stock ${o.id}: ${error.message}`);
    const row = (data ?? [])[0];
    if (!row) continue;
    ids.push(row.id);
    taken.push({ title: row.title, before: row.quantity_before, after: row.quantity, qty: it.quantity || 1, price: cents(it.unit_price), inv: row.inventory_no });
  }

  if (!taken.length) return false;
  await db.from('whatnot_orders').update({ matched: true, buyer: o.buyer?.username ?? null, items: list, listing_ids: ids }).eq('order_id', o.id);

  const clash = taken.filter((t) => t.before < t.qty);
  const names = taken.map((t) => `${t.qty > 1 ? `${t.qty}× ` : ''}${t.title}${t.inv ? ` (${t.inv})` : ''}`).join(', ');
  const total = taken.reduce((n, t) => n + t.price * t.qty, 0);
  await notifyLedger('orders', clash.length
    ? {
      title: 'Whatnot sale: card already sold',
      body: `${clash.map((t) => t.title).join(', ')} sold on Whatnot but was already gone from the shop. Cancel the Whatnot order if you can't fill it.`,
      tag: `whatnot-${o.id}`,
    }
    : { title: 'Sold on Whatnot', body: `${names} · ${money(total)}. Taken off the site and eBay.`, tag: `whatnot-${o.id}` });
  return true;
}

async function tick() {
  const started = Date.now();
  const startedIso = new Date().toISOString();
  const { data: state } = await db.from('whatnot_sync').select('*').eq('id', 1).single();
  // Overlap the last check by an hour; orders already seen are skipped.
  const since = state?.orders_checked_at
    ? Date.parse(state.orders_checked_at) - 3600_000
    : Date.now() - 2 * 86400_000;

  let seenAll = true, looked = 0, matched = 0;
  try {
    let cursor: string | null = null;
    outer: do {
      const r = await wn(`/orders?limit=50&reverse=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const orders = (r?.data ?? []) as Order[];
      if (!orders.length) break;
      const { data: done } = await db.from('whatnot_orders').select('order_id').in('order_id', orders.map((o) => o.id));
      const known = new Set((done ?? []).map((d) => d.order_id));
      for (const o of orders) {
        if (Date.parse(o.created_at) < since) break outer;
        if (known.has(o.id) || SKIP_STATUS.has(o.status) || o.transaction_type === 'giveaway') continue;
        if (Date.now() - started > BUDGET_MS) {
          seenAll = false; // a busy stream: pick the rest up next tick
          break outer;
        }
        if (await takeOrder(o)) matched++;
        looked++;
      }
      cursor = r?.next_cursor ?? null;
    } while (cursor);
  } catch (err) {
    const msg = (err as Error).message;
    console.error('whatnot tick', msg);
    const firstFail = !state?.last_error;
    await db.from('whatnot_sync').update({ last_run_at: startedIso, last_error: msg.slice(0, 500) }).eq('id', 1);
    // Tell the partners once when the token stops working (expired or revoked).
    if (firstFail && err instanceof WhatnotError && (err.status === 401 || err.status === 403)) {
      await notifyLedger('orders', {
        title: 'Whatnot sync stopped',
        body: 'The Whatnot API token was refused, so Whatnot sales are not coming off the site and eBay. Make a new token and update the WHATNOT_TOKEN secret.',
        tag: 'whatnot-token',
      });
    }
    return { ok: false, error: msg, looked, matched };
  }
  await db.from('whatnot_sync').update({
    last_run_at: startedIso,
    last_error: null,
    ...(seenAll ? { orders_checked_at: startedIso } : {}),
  }).eq('id', 1);
  return { ok: true, looked, matched, caught_up: seenAll };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const hub = req.headers.get('x-hub-token');
  if (!hub) return json({ error: 'Forbidden' }, 403);
  const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: hub });
  if (ok !== true) return json({ error: 'Forbidden' }, 403);
  const b = await req.json().catch(() => ({}));
  if (!TOKEN) return json({ skipped: 'WHATNOT_TOKEN not set' });
  if (b.action === 'tick') return json(await tick());
  if (b.action === 'status') {
    const { data } = await db.from('whatnot_sync').select('*').eq('id', 1).single();
    return json(data);
  }
  return json({ error: 'Unknown action' }, 400);
});

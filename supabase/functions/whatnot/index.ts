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
 * The other way: each listing has a "List on Whatnot" switch (shop_listings.whatnot). When it's
 * on and the card is live, the card is a Buy It Now product on Whatnot at the shop quantity and the
 * shop price + 5% rounded up (the product is created the first time, after checking Whatnot for one
 * with the same external_id). Otherwise its Whatnot stock is 0, and switching it off also takes it
 * off the Whatnot shop. Any change to the switch, quantity, status or price marks the listing
 * whatnot_dirty and a trigger posts { action: 'push', id }; the tick pushes anything still dirty.
 * The tick also links listings to products already on Whatnot (external_id = inventory #) and turns
 * their switch on.
 *
 * Callers:
 *   x-hub-token (vault shop_sync_token): { action: 'tick' | 'status' } | { action: 'push', id }
 *
 * Secret: WHATNOT_TOKEN, a Whatnot personal access token (wn_pat_tk_...) with read:orders,
 * read:inventory and write:inventory, made at whatnot.com/dashboard/developer?tab=tokens.
 * Deploy with --no-verify-jwt.
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
async function wn(path: string, body?: unknown, method?: string): Promise<any> {
  const wait = lastCall + 550 - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 0; ; attempt++) {
    lastCall = Date.now();
    const r = await fetch(API + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

// ---- Shop → Whatnot stock ----

// What a new Whatnot product looks like (same as the first bulk listing run).
const CATEGORY_POKEMON = '2';
const PROFILE_CARDS = '1302457'; // "Cards" shipping profile, 0.4 oz
const CONDITION_ATTR = '84';
const CONDITION: Record<string, { label: string; note: string }> = {
  nm: { label: 'Near Mint', note: 'Clean card with little to no wear.' },
  ex: { label: 'Light Played', note: 'Light edge or corner wear and minor surface scuffs. No major flaws.' },
  vg: { label: 'Moderately Played', note: 'Noticeable edge and corner wear, scuffs or light creasing.' },
  poor: { label: 'Heavily Played', note: 'Heavy wear, creases or other major flaws.' },
};
const PHOTO_BASE = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/shop-photos/`;

/** Whatnot price: shop price + 5%, rounded up to the next whole dollar. */
const whatnotPrice = (price: number) => Math.ceil(Math.round(Number(price) * 105) / 100);

type Listing = {
  id: string;
  title: string;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  category: string;
  price: number;
  quantity: number;
  photos: string[] | null;
  status: string;
  inventory_no: string | null;
  ebay_condition: string | null;
  whatnot: boolean;
  whatnot_product_id: string | null;
  whatnot_variant_id: string | null;
  whatnot_price: number | null;
  whatnot_synced_qty: number | null;
  updated_at: string;
};
const LISTING_COLS = 'id, title, set_name, card_number, variant, category, price, quantity, photos, status, inventory_no, ebay_condition, whatnot, whatnot_product_id, whatnot_variant_id, whatnot_price, whatnot_synced_qty, updated_at';

const externalId = (l: Listing) => (l.inventory_no || l.id.slice(0, 8)).toUpperCase();

function productBody(l: Listing) {
  const num = l.card_number ? (/^[0-9]/.test(l.card_number) ? `#${l.card_number}` : l.card_number) : null;
  const full = [l.title, num, l.set_name, l.variant, 'Pokemon Card'].filter(Boolean).join(' ');
  const title = full.length <= 80 ? full : [l.title, num, l.set_name, l.variant].filter(Boolean).join(' ').slice(0, 80);
  const cond = CONDITION[l.ebay_condition ?? 'nm'] ?? CONDITION.nm;
  const description = [
    `Card: ${l.title}`,
    l.set_name && `Set: ${l.set_name}`,
    l.card_number && `Number: ${l.card_number}`,
    l.variant && `Printing: ${l.variant}`,
    `Condition: ${cond.label}. ${cond.note}`,
    'The photos are of the exact card you will receive.',
    'Shipped in a sleeve inside a semi-rigid card holder or toploader. Ships within 2 business days.',
    `Stock # ${externalId(l)}`,
  ].filter(Boolean).join('\n');
  const media = (l.photos ?? []).filter((p) => /\.jpe?g$/i.test(p) && !/_(m|p|t)\.jpg$/i.test(p)).slice(0, 10)
    .map((p) => ({ url: PHOTO_BASE + p, alt: l.title }));
  return {
    title,
    category: { id: CATEGORY_POKEMON },
    description,
    external_id: externalId(l),
    attributes: [{ id: CONDITION_ATTR, value: cond.label }],
    dimension_profile: { id: PROFILE_CARDS },
    media,
  };
}

/** An existing Whatnot product with this external_id (so a card is never listed twice). */
async function findProduct(ext: string): Promise<string | null> {
  let cursor: string | null = null, pages = 0;
  do {
    const r = await wn(`/products?limit=50&reverse=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const hit = ((r?.data ?? []) as { id: string; external_id: string | null }[]).find((p) => p.external_id?.trim().toUpperCase() === ext);
    if (hit) return hit.id;
    cursor = r?.next_cursor ?? null;
  } while (cursor && ++pages < 20);
  return null;
}

const firstVariant = async (pid: string): Promise<string | null> => (await wn(`/products/${pid}/variants?limit=5`))?.data?.[0]?.id ?? null;

/**
 * Make Whatnot match one listing. With the Whatnot switch on and the card live, it is on Whatnot as
 * Buy It Now at the shop quantity and shop price + 5% (the product is created the first time).
 * Otherwise its Whatnot stock is 0 and, if the switch is off, it's taken off the Whatnot shop.
 */
async function push(id: string): Promise<{ ok: boolean; qty?: number; created?: boolean; error?: string; skipped?: string }> {
  const { data } = await db.from('shop_listings').select(LISTING_COLS).eq('id', id).maybeSingle();
  const l = data as Listing | null;
  if (!l) return { ok: true, skipped: 'gone' };
  const want = l.whatnot && l.status === 'live' ? Math.max(0, l.quantity) : 0;
  const done = (fields: Record<string, unknown>) =>
    db.from('shop_listings').update({ whatnot_dirty: false, whatnot_error: null, ...fields }).eq('id', id).eq('updated_at', l.updated_at);
  try {
    let pid = l.whatnot_product_id, vid = l.whatnot_variant_id, created = false;
    if (!vid) {
      if (!want) {
        await done({});
        return { ok: true, skipped: 'not on Whatnot' };
      }
      if (l.category !== 'single') throw new Error('Only single cards can go on Whatnot for now');
      pid = await findProduct(externalId(l));
      if (!pid) {
        const body = productBody(l);
        if (!body.media.length) throw new Error('Add a photo first');
        pid = String((await wn('/products', body))?.id ?? '');
        if (!pid) throw new Error('Whatnot did not return a product id');
        created = true;
      }
      vid = await firstVariant(pid);
      if (!vid) throw new Error('Whatnot product has no variant');
      // Save the link right away so a retry never makes a second product.
      const { data: u } = await db.from('shop_listings').update({ whatnot_product_id: pid, whatnot_variant_id: vid }).eq('id', id).select('updated_at').single();
      if (u?.updated_at) l.updated_at = u.updated_at;
    }
    const fields: Record<string, unknown> = {};
    if (want) {
      const price = whatnotPrice(l.price);
      if (created || Number(l.whatnot_price) !== price) {
        const r = await wn(`/products/${pid}/variants`, { variants: [{ id: vid, price: { amount: String(price), currency: 'USD' } }] }, 'PATCH');
        if (r?.errors?.length) throw new Error(`Whatnot price: ${r.errors.map((e: { message?: string; code?: string }) => e.message ?? e.code).join(', ')}`);
        fields.whatnot_price = price;
      }
    }
    const r = await wn('/inventory/set', {
      items: [{ variant_id: vid, quantity: want, idempotency_key: `${id}-${want}-${Date.parse(l.updated_at)}` }],
    });
    const res = r?.results?.[0];
    if (res && res.status !== 'applied') throw new Error(`Whatnot said ${res.status}${res.warnings?.length ? ` (${res.warnings.join(', ')})` : ''}`);
    fields.whatnot_synced_qty = res?.new_quantity ?? want;
    // Publish as Buy It Now when it's new or coming back; take it off the Whatnot shop when switched off.
    if (want && (created || !l.whatnot_synced_qty)) {
      await wn(`/merchandising/products/${pid}`, { transaction_type: 'buy_it_now', reserve_for_live: false });
    } else if (!l.whatnot && l.whatnot_synced_qty) {
      await wn(`/merchandising/products/${pid}`, { reserve_for_live: true });
    }
    // Only clear the flag if nothing changed while we were at it.
    await done(fields);
    return { ok: true, qty: want, created };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    await db.from('shop_listings').update({ whatnot_error: msg }).eq('id', id).eq('updated_at', l.updated_at);
    return { ok: false, error: msg };
  }
}

async function pushDirty(started: number) {
  const { data } = await db.from('shop_listings').select('id').eq('whatnot_dirty', true).order('updated_at').limit(40);
  let pushed = 0, failed = 0;
  for (const r of data ?? []) {
    if (Date.now() - started > BUDGET_MS) break;
    const res = await push(r.id);
    if (res.ok) pushed++;
    else failed++;
  }
  return { pushed, failed };
}

/**
 * Link shop listings to their Whatnot product + variant by inventory # (external_id): live ones, and
 * ones that changed in the last 3 days (a card that sold on the site just after it was put on
 * Whatnot still gets linked, and so taken off Whatnot).
 */
async function link(started: number) {
  const recent = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data: open } = await db.from('shop_listings').select('id, inventory_no')
    .is('whatnot_variant_id', null).not('inventory_no', 'is', null).eq('category', 'single')
    .or(`status.eq.live,updated_at.gte.${recent}`);
  if (!open?.length) return 0;
  const want = new Map(open.map((l) => [String(l.inventory_no).toUpperCase(), l.id as string]));
  const found = new Map<string, string>(); // listing id -> product id
  let cursor: string | null = null, pages = 0;
  do {
    const r = await wn(`/products?limit=50&reverse=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const p of (r?.data ?? []) as { id: string; external_id: string | null }[]) {
      const lid = p.external_id ? want.get(p.external_id.trim().toUpperCase()) : undefined;
      if (lid && !found.has(lid)) found.set(lid, p.id);
    }
    cursor = r?.next_cursor ?? null;
  } while (cursor && ++pages < 20 && found.size < want.size && Date.now() - started < BUDGET_MS);
  let linked = 0;
  for (const [lid, pid] of found) {
    if (Date.now() - started > BUDGET_MS) break;
    const v = await wn(`/products/${pid}/variants?limit=5`);
    const vid = v?.data?.[0]?.id;
    if (!vid) continue;
    // A card already on Whatnot has the switch on. Linking marks it dirty (trigger) without a ping;
    // pushDirty then makes Whatnot match the shop.
    const { error } = await db.from('shop_listings').update({ whatnot: true, whatnot_product_id: pid, whatnot_variant_id: vid }).eq('id', lid);
    if (error) console.error('whatnot link', lid, error.message);
    else linked++;
  }
  return linked;
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
  let stock: Record<string, unknown> = {};
  try {
    const linked = await link(started);
    stock = { linked, ...(await pushDirty(started)) };
  } catch (err) {
    console.error('whatnot stock', (err as Error).message);
    stock = { stock_error: (err as Error).message.slice(0, 300) };
  }
  return { ok: true, looked, matched, caught_up: seenAll, ...stock };
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
  if (b.action === 'push' && typeof b.id === 'string') return json(await push(b.id));
  if (b.action === 'status') {
    const { data } = await db.from('whatnot_sync').select('*').eq('id', 1).single();
    return json(data);
  }
  return json({ error: 'Unknown action' }, 400);
});

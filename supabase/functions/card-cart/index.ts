/**
 * POST /card-cart { cart_id, items: [{ id, qty, offer? }], coupon?, order_id? }
 * Keeps an anonymous copy of a website cart (listing ids and quantities only) so the
 * partners can see what's in people's carts in the ledger. The cart id is a random
 * id the browser makes; nothing here identifies the shopper. Deploy with --no-verify-jwt.
 */

import { corsHeaders, json } from '../_shared/shop.ts';
import { db } from '../_shared/cards.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.cart_id !== 'string' || !UUID.test(b.cart_id) || !Array.isArray(b.items) || b.items.length > 30) {
    return json(req, { error: 'Bad cart' }, 400);
  }
  const items = (b.items as { id?: unknown; qty?: unknown; offer?: unknown }[])
    .filter((it) => typeof it.id === 'string' && UUID.test(it.id) && Number.isInteger(it.qty) && (it.qty as number) > 0 && (it.qty as number) <= 20)
    .map((it) => ({ id: it.id as string, qty: it.qty as number, ...(it.offer ? { offer: true } : {}) }));
  const coupon = typeof b.coupon === 'string' && /^[A-Z0-9-]{2,30}$/i.test(b.coupon) ? b.coupon.toUpperCase() : null;
  const order = typeof b.order_id === 'string' && UUID.test(b.order_id) ? b.order_id : undefined;

  const { error } = await db.from('shop_carts').upsert({
    id: b.cart_id,
    items,
    item_count: items.reduce((n, it) => n + it.qty, 0),
    coupon,
    ...(order ? { order_id: order } : {}),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) {
    console.error('cart', error.message);
    return json(req, { error: 'Not saved' }, 500);
  }
  return json(req, { ok: true });
});

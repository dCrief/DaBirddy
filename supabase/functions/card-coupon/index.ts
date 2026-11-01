/**
 * GET /card-coupon?code=GINGER -> { code, percent, maxOff, amountOff, minSubtotal } (money in cents)
 * for the cart to show the discount before checkout. card-checkout re-checks and applies it.
 * Coupons with a use limit say so once they're used up. Anonymous; deploy with --no-verify-jwt.
 */

import { corsHeaders, json } from '../_shared/shop.ts';
import { db } from '../_shared/cards.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);
  const code = (new URL(req.url).searchParams.get('code') ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,30}$/.test(code)) return json(req, { error: 'That coupon code isn’t valid.' }, 404);
  const { data: c } = await db.from('shop_coupons')
    .select('code, percent_off, max_off_cents, amount_off_cents, min_subtotal_cents, max_uses, active').eq('code', code).maybeSingle();
  if (!c || !c.active) return json(req, { error: 'That coupon code isn’t valid.' }, 404);
  if (c.max_uses) {
    const { data: used } = await db.rpc('shop_coupon_uses', { p_code: c.code });
    if ((used ?? 0) >= c.max_uses) return json(req, { error: 'That coupon has been used up.' }, 410);
  }
  return json(req, {
    code: c.code,
    percent: c.percent_off,
    maxOff: c.max_off_cents,
    amountOff: c.amount_off_cents,
    minSubtotal: c.min_subtotal_cents,
  }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /shop-checkout — turns a cart into a Stripe Checkout session.
 * Body: { items: [{ variantId: number, quantity: number }] }
 * Prices are always re-read from Printful; the browser only sends ids and quantities.
 * Deploy with --no-verify-jwt.
 *
 * Env vars:
 *   STRIPE_SECRET_KEY            — sk_test_... while testing, sk_live_... when open
 *   SHOP_BASE_URL                — default "https://dabirddy.com/shop"
 *   SHOP_SHIPPING_CENTS          — flat shipping per order, default 599
 *   SHOP_FREE_SHIPPING_OVER_CENTS — optional; subtotal at which shipping is free
 *   SHOP_SHIP_COUNTRIES          — comma-separated ISO codes, default "US"
 */

import Stripe from 'npm:stripe@17';
import { corsHeaders, json, loadCatalog, type ShopVariant } from '../_shared/shop.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  httpClient: Stripe.createFetchHttpClient(),
});

const MAX_LINES = 20;
const MAX_QTY = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  let items: Array<{ variantId: number; quantity: number }>;
  try {
    ({ items } = await req.json());
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_LINES) throw 0;
    for (const it of items) {
      if (!Number.isInteger(it.variantId) || !Number.isInteger(it.quantity) ||
          it.quantity < 1 || it.quantity > MAX_QTY) throw 0;
    }
  } catch {
    return json(req, { error: 'Invalid cart' }, 400);
  }

  try {
    const catalog = await loadCatalog();
    const variants = new Map<number, { product: string; v: ShopVariant }>();
    for (const p of catalog) for (const v of p.variants) variants.set(v.id, { product: p.name, v });

    const missing = items.filter((it) => !variants.has(it.variantId));
    if (missing.length) {
      return json(req, { error: 'Some items are no longer available. Please refresh the shop.' }, 409);
    }

    const lineItems = items.map(({ variantId, quantity }) => {
      const { v } = variants.get(variantId)!;
      return {
        quantity,
        price_data: {
          currency: v.currency,
          unit_amount: v.price,
          product_data: { name: v.name, ...(v.image ? { images: [v.image] } : {}) },
        },
      };
    });

    const subtotal = items.reduce((sum, it) => sum + variants.get(it.variantId)!.v.price * it.quantity, 0);
    const freeOver = Number(Deno.env.get('SHOP_FREE_SHIPPING_OVER_CENTS') ?? 0);
    const shipping = freeOver && subtotal >= freeOver ? 0 : Number(Deno.env.get('SHOP_SHIPPING_CENTS') ?? 599);
    const base = Deno.env.get('SHOP_BASE_URL') ?? 'https://dabirddy.com/shop';
    const countries = (Deno.env.get('SHOP_SHIP_COUNTRIES') ?? 'US').split(',').map((c) => c.trim());

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: countries as any },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: shipping === 0 ? 'Free shipping' : 'Standard shipping',
          fixed_amount: { amount: shipping, currency: variants.get(items[0].variantId)!.v.currency },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 5 },
            maximum: { unit: 'business_day', value: 12 },
          },
        },
      }],
      // Compact cart ("variantId:qty,...") so the webhook can build the Printful order.
      metadata: { cart: items.map((it) => `${it.variantId}:${it.quantity}`).join(',') },
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/`,
    });

    return json(req, { url: session.url });
  } catch (err) {
    console.error(err);
    return json(req, { error: 'Could not start checkout. Please try again.' }, 502);
  }
});

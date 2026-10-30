/**
 * POST /card-checkout — turns a cart of cards into a Stripe Checkout session.
 * Body: { items: [{ id: <listing uuid>, qty: number }], release?: <previous order id> }
 *    or { offer: <offer token>, release? }: pay an accepted or countered offer (one card at the offer price).
 *
 * `release` cancels the buyer's own earlier checkout (they backed out of
 * Stripe and came back): its Stripe page is expired and its holds dropped, so
 * it can't block them or be paid later.
 *
 * Prices, stock and shipping always come from the database; the browser only
 * sends ids and quantities. The cards are held for 35 minutes while the buyer
 * pays (Stripe's page expires after 31), so nobody else can buy them meanwhile.
 * Deploy with --no-verify-jwt.
 *
 * Env: STRIPE_SECRET_KEY, SHOP_CARDS_URL (default https://dabirddy.com/cards)
 */

import Stripe from 'npm:stripe@17';
import { corsHeaders, json } from '../_shared/shop.ts';
import { db, loadSettings, shippingFor, type OrderItem } from '../_shared/cards.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { httpClient: Stripe.createFetchHttpClient() });
const MAX_LINES = 30;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  let cart: { id: string; qty: number }[];
  let release: unknown;
  let offer: { id: string; token: string; listing_id: string; pay: number } | null = null;
  try {
    const body = await req.json();
    release = body.release;
    if (typeof body.offer === 'string') {
      if (!/^[0-9a-f]{64}$/.test(body.offer)) throw 0;
      const { data: o } = await db.from('shop_offers')
        .select('id, listing_id, status, amount_cents, counter_cents, expires_at').eq('token', body.offer).maybeSingle();
      if (!o) throw 0;
      if (o.status === 'paid') return json(req, { error: 'This offer is already paid.' }, 409);
      if (!(o.status === 'accepted' || o.status === 'countered') || !o.expires_at || new Date(o.expires_at) < new Date()) {
        return json(req, { error: 'This offer can’t be paid any more. Make a new offer or buy it at the listed price.' }, 409);
      }
      offer = { id: o.id, token: body.offer, listing_id: o.listing_id, pay: o.status === 'countered' ? o.counter_cents! : o.amount_cents };
      cart = [{ id: o.listing_id, qty: 1 }];
    } else {
      cart = body.items;
    }
    if (!Array.isArray(cart) || !cart.length || cart.length > MAX_LINES) throw 0;
    for (const it of cart) {
      if (typeof it.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(it.id) || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > 20) throw 0;
    }
    if (new Set(cart.map((c) => c.id)).size !== cart.length) throw 0;
  } catch {
    return json(req, { error: 'Invalid cart' }, 400);
  }

  try {
    if (typeof release === 'string' && /^[0-9a-f-]{36}$/i.test(release)) await releaseOrder(release);

    const { data: running } = await db.from('shows').select('id').is('ended_at', null).limit(1);
    if (running?.length) {
      return json(req, { error: 'We’re at a card show right now, so online checkout is paused. Please try again after the show.' }, 409);
    }

    const { data: listings, error } = await db
      .from('shop_listings')
      .select('id, title, set_name, card_number, category, price, photos, status')
      .in('id', cart.map((c) => c.id));
    if (error) throw error;
    const byId = new Map((listings ?? []).map((l) => [l.id, l]));
    const gone = cart.filter((c) => byId.get(c.id)?.status !== 'live').map((c) => c.id);
    if (gone.length) return json(req, { error: 'Some cards in your cart just sold. They’ve been removed.', unavailable: gone }, 409);

    const items: OrderItem[] = cart.map((c) => {
      const l = byId.get(c.id)!;
      return {
        listing_id: l.id,
        title: l.title,
        set: l.set_name,
        number: l.card_number,
        category: l.category,
        price_cents: offer ? offer.pay : Math.round(Number(l.price) * 100),
        qty: c.qty,
        photo: (l.photos as string[])[0] ?? null,
      };
    });
    const settings = await loadSettings();
    const ship = shippingFor(items, settings);

    const { data: order, error: oe } = await db
      .from('shop_orders')
      .insert({ items, subtotal_cents: ship.subtotal, shipping_cents: ship.cents, method: ship.method })
      .select('id, order_number')
      .single();
    if (oe) throw oe;

    const { error: re } = await db.rpc('shop_reserve', { p_order: order.id, p_minutes: 35 });
    if (re) {
      await db.from('shop_orders').update({ status: 'cancelled' }).eq('id', order.id);
      const m = /unavailable:([0-9a-f-]{36})/i.exec(re.message);
      if (m) return json(req, { error: 'One of these cards is in someone else’s checkout or just sold. It’s been removed from your cart.', unavailable: [m[1]] }, 409);
      throw re;
    }

    const base = (Deno.env.get('SHOP_CARDS_URL') ?? 'https://dabirddy.com/cards').replace(/\/$/, '');
    const photoUrl = (name: string | null) =>
      name ? db.storage.from('shop-photos').getPublicUrl(name.replace(/\.jpg$/, '_m.jpg')).data.publicUrl : undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: items.map((it) => ({
        quantity: it.qty,
        price_data: {
          currency: 'usd',
          unit_amount: it.price_cents,
          product_data: {
            name: it.title,
            ...([it.set, it.number ? `#${it.number}` : null].some(Boolean)
              ? { description: [it.set, it.number ? `#${it.number}` : null].filter(Boolean).join(' · ') }
              : {}),
            ...(photoUrl(it.photo) ? { images: [photoUrl(it.photo)!] } : {}),
          },
        },
      })),
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: ship.method === 'envelope' ? 'Tracked envelope' : 'Tracked package (USPS Ground Advantage)',
          fixed_amount: { amount: ship.cents, currency: 'usd' },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: ship.method === 'envelope' ? 3 : 2 },
            maximum: { unit: 'business_day', value: ship.method === 'envelope' ? 7 : 6 },
          },
        },
      }],
      payment_intent_data: { description: `DaBirddy cards order ${order.order_number}` },
      metadata: { kind: 'cards', order_id: order.id, order_number: order.order_number, ...(offer ? { offer_id: offer.id } : {}) },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: offer ? `${base}/offer.html?o=${offer.token}` : `${base}/?cart=1`,
    });

    await db.from('shop_orders').update({ stripe_session_id: session.id }).eq('id', order.id);
    return json(req, { url: session.url, order: order.id });
  } catch (err) {
    console.error(err);
    return json(req, { error: 'Could not start checkout. Please try again.' }, 502);
  }
});

/** Cancel a still-pending checkout: expire its Stripe page and drop its holds. */
async function releaseOrder(id: string) {
  const { data: o } = await db.from('shop_orders').select('id, status, stripe_session_id').eq('id', id).maybeSingle();
  if (!o || o.status !== 'pending') return;
  if (o.stripe_session_id) {
    try {
      await stripe.checkout.sessions.expire(o.stripe_session_id);
    } catch {
      // Already expired or completed. If it was paid, the webhook marks the order paid; leave it alone.
      const s = await stripe.checkout.sessions.retrieve(o.stripe_session_id).catch(() => null);
      if (s?.payment_status === 'paid') return;
    }
  }
  await db.from('shop_holds').delete().eq('order_id', id);
  await db.from('shop_orders').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending');
}

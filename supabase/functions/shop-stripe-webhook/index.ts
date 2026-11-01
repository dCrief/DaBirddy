/**
 * POST /shop-stripe-webhook — Stripe calls this after a successful checkout.
 * Creates the matching Printful order so it gets printed and shipped.
 * Deploy with --no-verify-jwt (Stripe can't send a Supabase JWT; we verify Stripe's signature instead).
 *
 * Env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe webhook endpoint
 *   PRINTFUL_AUTO_CONFIRM  — "true" sends orders straight to production (Printful charges
 *                            your card on file). Anything else leaves them as drafts to
 *                            review and confirm in the Printful dashboard.
 */

import Stripe from 'npm:stripe@17';
import { printful } from '../_shared/shop.ts';
import { db, logSale, makeLabel, syncSaleFee } from '../_shared/cards.ts';
import { money, notifyLedger } from '../_shared/push.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      req.headers.get('Stripe-Signature') ?? '',
      Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error('Bad signature', err);
    return new Response('Bad signature', { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') return new Response('Ignored', { status: 200 });

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== 'paid') return new Response('Not paid', { status: 200 });

  if (session.metadata?.kind === 'cards') return cardsPaid(session);

  // Printful external_id is limited to 32 chars, so key the order on the PaymentIntent id.
  const externalId = String(session.payment_intent ?? session.id).slice(0, 32);

  try {
    // Stripe retries webhooks; skip if this order was already sent to Printful.
    const existing = await printful(`/orders/@${externalId}`).catch(() => null);
    if (existing) return new Response('Already created', { status: 200 });

    const ship = (session as any).collected_information?.shipping_details ?? (session as any).shipping_details;
    const addr = ship?.address;
    if (!addr) throw new Error(`No shipping address on session ${session.id}`);

    const items = (session.metadata?.cart ?? '').split(',').filter(Boolean).map((pair) => {
      const [id, qty] = pair.split(':').map(Number);
      return { sync_variant_id: id, quantity: qty };
    });
    if (!items.length) throw new Error(`Empty cart metadata on session ${session.id}`);

    const confirm = Deno.env.get('PRINTFUL_AUTO_CONFIRM') === 'true';
    const order = await printful(`/orders?confirm=${confirm}`, {
      method: 'POST',
      body: JSON.stringify({
        external_id: externalId,
        shipping: 'STANDARD',
        recipient: {
          name: ship.name,
          address1: addr.line1,
          address2: addr.line2 ?? undefined,
          city: addr.city,
          state_code: addr.state ?? undefined,
          country_code: addr.country,
          zip: addr.postal_code,
          email: session.customer_details?.email ?? undefined,
          phone: session.customer_details?.phone ?? undefined,
        },
        items,
        retail_costs: {
          currency: (session.currency ?? 'usd').toUpperCase(),
          shipping: ((session.shipping_cost?.amount_total ?? 0) / 100).toFixed(2),
        },
      }),
    });

    console.log(`Printful order ${order.id} (${order.status}) created for ${externalId}`);
    return new Response('OK', { status: 200 });
  } catch (err) {
    // Non-2xx makes Stripe retry for up to 3 days.
    console.error(err);
    return new Response('Printful order failed', { status: 500 });
  }
});

/**
 * A cards order was paid: take the cards out of stock, save the buyer and
 * address, log the sale in the ledger, and buy the shipping label.
 * Safe to run twice. A failed label doesn't fail the webhook; the ledger
 * shows the error with a Retry button.
 */
async function cardsPaid(session: Stripe.Checkout.Session): Promise<Response> {
  const orderId = session.metadata?.order_id;
  if (!orderId) return new Response('No order id', { status: 200 });
  try {
    const { data: order } = await db.from('shop_orders').select('id, status').eq('id', orderId).maybeSingle();
    if (!order) throw new Error(`Order ${orderId} not found`);
    const firstTime = order.status === 'pending' || order.status === 'cancelled'; // Stripe retries: notify once
    // Paid just as the buyer's earlier checkout was being cancelled: honour the payment.
    if (order.status === 'cancelled') await db.from('shop_orders').update({ status: 'pending' }).eq('id', orderId);

    const { error: ce } = await db.rpc('shop_complete', { p_order: orderId });
    if (ce) throw ce;

    const ship = (session as any).collected_information?.shipping_details ?? (session as any).shipping_details;
    const a = ship?.address;
    const fee = session.payment_intent ? await stripeFee(String(session.payment_intent)) : null;
    await db.from('shop_orders').update({
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent ? String(session.payment_intent) : null,
      total_cents: session.amount_total,
      buyer_name: ship?.name ?? session.customer_details?.name ?? null,
      buyer_email: session.customer_details?.email ?? null,
      buyer_phone: session.customer_details?.phone ?? null,
      ship_to: a ? {
        name: ship.name,
        line1: a.line1,
        line2: a.line2 ?? null,
        city: a.city,
        state: a.state,
        postal_code: a.postal_code,
        country: a.country,
      } : null,
      ...(fee != null ? { stripe_fee_cents: fee } : {}),
    }).eq('id', orderId);

    const offerIds = (session.metadata?.offer_ids ?? session.metadata?.offer_id ?? '').split(',').filter(Boolean);
    if (offerIds.length) {
      await db.from('shop_offers').update({ status: 'paid', order_id: orderId }).in('id', offerIds);
    }
    if (session.metadata?.coupon) await closeUsedUpCoupon(session.metadata.coupon, orderId);
    await closeSoldOutCheckouts(orderId);
    await logSale(orderId);
    await syncSaleFee(orderId); // a Stripe retry may bring the fee the first run didn't have
    await makeLabel(orderId);
    if (firstTime) await notifyOrder(orderId);
    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('cards order', orderId, err);
    return new Response('Card order failed', { status: 500 });
  }
}

/** "New order" on the partners' phones. */
/**
 * The Stripe fee for a payment. Stripe often attaches the balance transaction a moment after
 * checkout completes, so try a few times; shop-fee-sync fills in any that are still missing.
 */
async function stripeFee(paymentIntent: string): Promise<number | null> {
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge.balance_transaction'] }).catch(() => null);
    const bt = (pi?.latest_charge as any)?.balance_transaction;
    if (bt && typeof bt === 'object') return bt.fee;
  }
  return null;
}

async function notifyOrder(orderId: string) {
  const { data: o } = await db.from('shop_orders')
    .select('order_number, items, total_cents, subtotal_cents, shipping_cents, method, buyer_name, label_error, tracking_number, stock_problem')
    .eq('id', orderId).maybeSingle();
  if (!o) return;
  const items = (o.items as { title: string; qty: number }[]).map((it) => (it.qty > 1 ? `${it.qty}× ${it.title}` : it.title)).join(', ');
  const label = o.tracking_number ? 'Label ready' : o.label_error ? 'Label needs attention' : 'Making the label';
  await notifyLedger('orders', {
    title: `${o.stock_problem ? '⚠️ ' : ''}New order: ${money(o.total_cents ?? o.subtotal_cents + o.shipping_cents)}`,
    body: `${o.buyer_name ?? 'Someone'} bought ${items}. ${o.method === 'envelope' ? 'Envelope' : 'Package'} · ${label}.${o.stock_problem ? ` ${o.stock_problem}` : ''}`,
    tag: `order-${o.order_number}`,
  });
}

/**
 * Limited coupons are claimed when checkout starts, so other checkouts holding a live claim
 * are legitimate and left alone. When this payment uses the code up, close any other checkout
 * with that code that has no live claim (started before claims existed, or whose claim lapsed):
 * expire its Stripe page (so it can't be paid) and let its cards go.
 */
async function closeUsedUpCoupon(code: string, paidOrderId: string) {
  try {
    const { data: c } = await db.from('shop_coupons').select('max_uses').eq('code', code).maybeSingle();
    if (!c?.max_uses) return;
    const { data: used } = await db.rpc('shop_coupon_uses', { p_code: code });
    if ((used ?? 0) < c.max_uses) return;
    const { data: open } = await db.from('shop_orders').select('id, stripe_session_id')
      .eq('coupon_code', code).eq('status', 'pending').neq('id', paidOrderId)
      .or(`coupon_claimed_until.is.null,coupon_claimed_until.lt.${new Date().toISOString()}`);
    for (const o of open ?? []) {
      if (o.stripe_session_id) {
        try {
          await stripe.checkout.sessions.expire(o.stripe_session_id);
        } catch {
          // Already expired, or paid this very moment (its own webhook will handle it).
          const s = await stripe.checkout.sessions.retrieve(o.stripe_session_id).catch(() => null);
          if (s?.payment_status === 'paid') continue;
        }
      }
      await db.from('shop_holds').delete().eq('order_id', o.id);
      await db.from('shop_orders').update({ status: 'cancelled' }).eq('id', o.id).eq('status', 'pending');
    }
    console.log(`coupon ${code} used up: closed ${open?.length ?? 0} other checkouts`);
  } catch (err) {
    console.error('closeUsedUpCoupon', code, err);
  }
}

/**
 * Cards aren't held at checkout, so others may be paying for a card this order just bought.
 * Close their checkouts (expire the Stripe page) for any card that's now sold out.
 */
async function closeSoldOutCheckouts(paidOrderId: string) {
  try {
    const { data: paid } = await db.from('shop_orders').select('items').eq('id', paidOrderId).maybeSingle();
    const ids = ((paid?.items ?? []) as { listing_id: string }[]).map((it) => it.listing_id);
    if (!ids.length) return;
    const { data: gone } = await db.from('shop_listings').select('id').in('id', ids).lte('quantity', 0);
    const soldOut = new Set((gone ?? []).map((l) => l.id));
    if (!soldOut.size) return;
    const { data: open } = await db.from('shop_orders').select('id, items, stripe_session_id').eq('status', 'pending').neq('id', paidOrderId);
    let closed = 0;
    for (const o of open ?? []) {
      if (!((o.items ?? []) as { listing_id: string }[]).some((it) => soldOut.has(it.listing_id))) continue;
      if (o.stripe_session_id) {
        try {
          await stripe.checkout.sessions.expire(o.stripe_session_id);
        } catch {
          const s = await stripe.checkout.sessions.retrieve(o.stripe_session_id).catch(() => null);
          if (s?.payment_status === 'paid') continue;
        }
      }
      await db.from('shop_orders').update({ status: 'cancelled' }).eq('id', o.id).eq('status', 'pending');
      closed++;
    }
    if (closed) console.log(`closed ${closed} checkouts with cards that just sold`);
  } catch (err) {
    console.error('closeSoldOutCheckouts', err);
  }
}

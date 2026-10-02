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

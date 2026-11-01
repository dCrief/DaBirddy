/**
 * POST /shop-fee-sync — run every 10 minutes by pg_cron (job shop-fee-sync).
 * Fills in the Stripe fee on recent paid website orders that don't have one yet (Stripe often
 * settles it after the payment webhook ran), then takes the fee off the sale's ledger lines.
 * Needs header x-hub-token matching vault secret shop_sync_token (checked by shop_sync_token_ok; the cron job sends it).
 * Deploy with --no-verify-jwt.
 */

import Stripe from 'npm:stripe@17';
import { db, syncSaleFee } from '../_shared/cards.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { httpClient: Stripe.createFetchHttpClient() });

Deno.serve(async (req) => {
  const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: req.headers.get('x-hub-token') ?? '' });
  if (ok !== true) return new Response('Forbidden', { status: 403 });

  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: orders, error } = await db.from('shop_orders')
    .select('id, order_number, stripe_payment_intent, stripe_fee_cents')
    .in('status', ['paid', 'shipped']).gte('paid_at', since).order('paid_at', { ascending: false }).limit(50);
  if (error) return new Response(error.message, { status: 500 });

  let filled = 0, synced = 0;
  for (const o of orders ?? []) {
    if (o.stripe_fee_cents == null && o.stripe_payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(o.stripe_payment_intent, { expand: ['latest_charge.balance_transaction'] }).catch(() => null);
      const bt = (pi?.latest_charge as any)?.balance_transaction;
      if (bt && typeof bt === 'object') {
        await db.from('shop_orders').update({ stripe_fee_cents: bt.fee }).eq('id', o.id);
        filled++;
      }
    }
    if (await syncSaleFee(o.id)) synced++;
  }
  if (filled || synced) console.log(`fee sync: ${filled} fees filled, ${synced} sales corrected`);
  return new Response(JSON.stringify({ checked: orders?.length ?? 0, filled, synced }), { headers: { 'Content-Type': 'application/json' } });
});

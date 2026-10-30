/**
 * GET /card-order?session_id=cs_... — what the buyer sees on the order
 * confirmation page: items, totals, shipping method and tracking.
 * The Stripe session id is unguessable, so it works as the buyer's key.
 * Never returns the address or anything about other orders.
 * Deploy with --no-verify-jwt.
 */

import { corsHeaders, json } from '../_shared/shop.ts';
import { db } from '../_shared/cards.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);
  const id = new URL(req.url).searchParams.get('session_id') ?? '';
  if (!/^cs_[A-Za-z0-9_]{10,}$/.test(id)) return json(req, { error: 'Not found' }, 404);

  const { data: o } = await db
    .from('shop_orders')
    .select('order_number, status, method, items, subtotal_cents, shipping_cents, total_cents, tracking_number, label_url, shipped_at')
    .eq('stripe_session_id', id)
    .maybeSingle();
  if (!o) return json(req, { error: 'Not found' }, 404);

  // Envelope tracking lives with TCG Tracking; ask it for the latest scan.
  let progress: { status: string; events: { date: string; description: string }[] } | null = null;
  const key = Deno.env.get('TCGTRACKING_API_KEY'), shipper = Deno.env.get('TCGTRACKING_SHIPPER_NUMBER');
  if (o.method === 'envelope' && o.tracking_number && o.shipped_at && key && shipper) {
    try {
      const r = await fetch(`https://tcgtracking.com/api/v1/orders/track?order_number=${encodeURIComponent(o.order_number)}`, {
        headers: { 'X-Shipper-Number': shipper, 'X-API-Key': key },
      });
      const b = await r.json();
      if (r.ok) {
        progress = {
          status: String(b.status ?? b.tracking?.status ?? ''),
          events: ((b.events ?? b.tracking?.events ?? []) as any[]).slice(0, 8).map((e) => ({
            date: String(e.date ?? e.timestamp ?? e.event_date ?? ''),
            description: String(e.description ?? e.event ?? e.status ?? ''),
          })),
        };
      }
    } catch {
      // Tracking is a nice-to-have on this page.
    }
  }

  return json(req, {
    order: o.order_number,
    status: o.status === 'pending' ? 'processing' : o.status,
    method: o.method,
    items: (o.items as any[]).map((it) => ({ title: it.title, set: it.set, number: it.number, qty: it.qty, price: it.price_cents })),
    subtotal: o.subtotal_cents,
    shipping: o.shipping_cents,
    total: o.total_cents,
    tracking: o.tracking_number,
    trackUrl: o.method === 'package' && o.tracking_number
      ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(o.tracking_number)}`
      : null,
    shipped: !!o.shipped_at,
    progress,
  }, 200, { 'Cache-Control': 'no-store' });
});

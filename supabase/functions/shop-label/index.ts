/**
 * POST /shop-label { order_id } — retry the shipping label for a paid order.
 * Partners only: called from the ledger with the signed-in partner's token.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { makeLabel } from '../_shared/cards.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Partners only (row level security on partners decides).
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: partners } = await asUser.from('partners').select('id').limit(1);
  if (!partners?.length) return json({ error: 'Not a partner' }, 403);

  const { order_id } = await req.json().catch(() => ({}));
  if (typeof order_id !== 'string') return json({ error: 'order_id required' }, 400);
  const { data: order } = await asUser.from('shop_orders').select('status').eq('id', order_id).maybeSingle();
  if (!order) return json({ error: 'Order not found' }, 404);
  if (order.status !== 'paid') return json({ error: 'Only paid, unshipped orders get labels' }, 409);

  const r = await makeLabel(order_id);
  return json(r, r.ok ? 200 : 502);
});

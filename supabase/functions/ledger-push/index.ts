/**
 * The ledger app's side of phone notifications. Partners only.
 *   GET                -> { publicKey }  the VAPID public key to subscribe with
 *   POST { type: 'test' } -> sends a test notification to the caller's devices
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { db } from '../_shared/cards.ts';
import { notifyLedger } from '../_shared/push.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user?.email) return json({ error: 'Sign in first' }, 401);
  const { data: me } = await db.from('partners').select('id, name').ilike('email', user.email).maybeSingle();
  if (!me) return json({ error: 'Not a partner' }, 403);

  if (req.method === 'GET') {
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
    if (!publicKey) return json({ error: 'Notifications aren’t set up on the server' }, 503);
    return json({ publicKey });
  }
  const b = await req.json().catch(() => ({}));
  if (b.type === 'test') {
    const sent = await notifyLedger('test', { title: 'Notifications are on', body: `Hi ${me.name}, new website orders and offers will show up like this.`, tag: 'test' }, me.id);
    return json({ sent });
  }
  return json({ error: 'Unknown request' }, 400);
});

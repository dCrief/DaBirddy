/**
 * POST /label-archive — keeps every shipping label PDF for good.
 *
 * Shippo package labels come back as a link that expires (about a year). This copies
 * any label that has only that link (shipping_labels from Log a deal, and shop_orders)
 * into the shop-labels bucket and saves label_path, which never expires. deal-label
 * already does this when it buys a label; this run catches anything it missed and
 * did the one-time backfill. pg_cron calls it hourly.
 *
 * Needs header x-hub-token matching vault secret shop_sync_token. Deploy with
 * verify_jwt off (the cron job has no Supabase login).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

async function keep(table: 'shipping_labels' | 'shop_orders', name: 'ref' | 'order_number') {
  const { data, error } = await db.from(table).select(`id, ${name}, label_url`)
    .not('label_url', 'is', null).is('label_path', null).limit(25);
  if (error) throw error;
  let saved = 0;
  const failed: string[] = [];
  for (const row of (data ?? []) as Record<string, string>[]) {
    const path = `${row[name]}.pdf`;
    try {
      const r = await fetch(row.label_url);
      if (!r.ok) throw new Error(`download ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const up = await db.storage.from('shop-labels').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
      if (up.error) throw up.error;
      const { error: ue } = await db.from(table).update({ label_path: path }).eq('id', row.id);
      if (ue) throw ue;
      saved++;
    } catch (err) {
      console.error('label-archive', table, path, err);
      failed.push(row[name]);
    }
  }
  return { saved, failed };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: req.headers.get('x-hub-token') ?? '' });
  if (ok !== true) return new Response('Forbidden', { status: 403 });
  try {
    const [labels, orders] = await Promise.all([keep('shipping_labels', 'ref'), keep('shop_orders', 'order_number')]);
    return Response.json({ ok: true, labels, orders });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});

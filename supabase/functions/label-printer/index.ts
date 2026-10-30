/**
 * The print queue for the label printer listener on David's PC.
 *
 *   GET  /label-printer          -> { jobs: [{ id, order, requested_at, url }] }
 *   POST /label-printer { id, requested_at, error? }  -> marks the job printed (or failed)
 *
 * Auth: the SHA-256 of X-Printer-Token must be in private.printer_tokens. Deploy with
 * --no-verify-jwt (the listener has no Supabase login).
 */

import { db } from '../_shared/cards.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function authorized(req: Request) {
  const token = req.headers.get('X-Printer-Token') ?? '';
  if (token.length < 32) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const { data } = await db.rpc('printer_token_ok', { p_hash: hash });
  return data === true;
}

Deno.serve(async (req) => {
  if (!(await authorized(req))) return json({ error: 'Unauthorized' }, 401);

  if (req.method === 'GET') {
    const { data, error } = await db
      .from('shop_orders')
      .select('id, order_number, print_requested_at, printed_at, label_path, label_url')
      .not('print_requested_at', 'is', null)
      .not('tracking_number', 'is', null)
      .neq('status', 'cancelled')
      .gt('print_requested_at', new Date(Date.now() - 3 * 86400e3).toISOString())
      .order('print_requested_at', { ascending: true })
      .limit(20);
    if (error) return json({ error: error.message }, 500);
    const jobs = [];
    for (const o of data ?? []) {
      if (o.printed_at && o.printed_at >= o.print_requested_at) continue;
      let url = o.label_url as string | null;
      if (!url && o.label_path) {
        const { data: s } = await db.storage.from('shop-labels').createSignedUrl(o.label_path, 600);
        url = s?.signedUrl ?? null;
      }
      if (url) jobs.push({ id: o.id, order: o.order_number, requested_at: o.print_requested_at, url });
    }
    return json({ jobs });
  }

  if (req.method === 'POST') {
    const { id, requested_at, error } = await req.json().catch(() => ({}));
    if (typeof id !== 'string' || typeof requested_at !== 'string') return json({ error: 'id and requested_at required' }, 400);
    // Mark printed as of the request we printed, so a reprint asked for meanwhile still prints.
    const { error: e } = await db.from('shop_orders')
      .update(error ? { print_error: String(error).slice(0, 300) } : { printed_at: requested_at, print_error: null })
      .eq('id', id);
    if (e) return json({ error: e.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
});

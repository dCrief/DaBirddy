/**
 * POST /postage-preview — a sample envelope sticker with EasyPost postage, made with EASYPOST_TEST_KEY
 * (free test postage, not valid for mailing). Used to line up where the postage sits on TCG Tracking's
 * label before envelope postage is turned on, and to show David a sample.
 *
 * Body (all optional): { crop?: Box, spot?: Box, oz?: number, fresh?: boolean }
 *   crop/spot override POSTAGE_CROP/POSTAGE_SPOT (fractions of the page from the bottom-left).
 *   fresh buys a new test label instead of reusing the last one.
 * Returns signed links to the sample sticker, the raw EasyPost test label and the TCG label used.
 *
 * Needs header x-hub-token matching vault secret shop_sync_token. Deploy with verify_jwt off.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { buyLetterPostage, stampLabel, type Box } from '../_shared/postage.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const loadSettings = async () => (await db.from('shop_settings').select('*').eq('id', 1).single()).data;

const box = (v: any): Box | undefined =>
  v && ['x', 'y', 'w', 'h'].every((k) => typeof v[k] === 'number' && v[k] >= 0 && v[k] <= 1) ? { x: v.x, y: v.y, w: v.w, h: v.h } : undefined;

async function link(path: string) {
  const { data } = await db.storage.from('shop-labels').createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: req.headers.get('x-hub-token') ?? '' });
  if (ok !== true) return new Response('Forbidden', { status: 403 });
  const b = await req.json().catch(() => ({}));
  try {
    // The newest envelope label we have, and where it went.
    const { data: rows, error } = await db.from('shipping_labels').select('ref, label_path, ship_to')
      .eq('method', 'envelope').not('label_path', 'is', null).order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const row = rows?.[0];
    if (!row) throw new Error('No envelope label to use as the sample');
    const { data: file } = await db.storage.from('shop-labels').download(row.label_path);
    if (!file) throw new Error(`Couldn’t read ${row.label_path}`);
    const label = new Uint8Array(await file.arrayBuffer());

    // Test postage, reused between previews unless fresh.
    let postage: Uint8Array | null = null;
    if (!b.fresh) {
      const { data } = await db.storage.from('shop-labels').download('previews/easypost-test.pdf');
      if (data) postage = new Uint8Array(await data.arrayBuffer());
    }
    let cost_cents: number | null = null;
    if (!postage) {
      const s = await loadSettings();
      const t = row.ship_to;
      const p = await buyLetterPostage({
        test: true,
        reference: `PREVIEW-${Date.now()}`,
        oz: typeof b.oz === 'number' ? b.oz : 1,
        nonmachinable: s.envelope_nonmachinable,
        to: { name: t.name, street1: t.line1, street2: t.line2, city: t.city, state: t.state, zip: t.postal_code },
        from: { name: s.from_name ?? 'DaBirddy', street1: s.from_street1!, street2: s.from_street2, city: s.from_city!, state: s.from_state!, zip: s.from_zip!, phone: s.from_phone },
      });
      postage = p.pdf;
      cost_cents = p.cost_cents;
      await db.storage.from('shop-labels').upload('previews/easypost-test.pdf', postage, { contentType: 'application/pdf', upsert: true });
    }

    const sample = await stampLabel(label, postage, box(b.crop), box(b.spot));
    await db.storage.from('shop-labels').upload('previews/postage-preview.pdf', sample, { contentType: 'application/pdf', upsert: true });
    return Response.json({
      ok: true,
      from_label: row.ref,
      cost_cents,
      sample: await link('previews/postage-preview.pdf'),
      easypost: await link('previews/easypost-test.pdf'),
      tcg: await link(row.label_path),
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});

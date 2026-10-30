/**
 * GET /shop-products — public catalog for dabirddy.com/shop and /cards.
 *
 *   products: Printful merch (cached 5 min)
 *   cards:    live listings from the partner ledger's shop_listings table
 *             (cached 20 s so a card sold at a show or on Whatnot disappears fast)
 *   cardsPaused: true while a card show is running in the ledger; cards is then empty
 *
 * Deploy with --no-verify-jwt (the shop pages are anonymous). Reads listings
 * with the service role, which edge functions get automatically; only the
 * fields below ever leave this function (never cost or who listed it).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json, loadCatalog, type ShopProduct } from '../_shared/shop.ts';

const MERCH_CACHE_MS = 5 * 60 * 1000;
const CARDS_CACHE_MS = 20 * 1000;

type ShopCard = {
  id: string;
  title: string;
  set: string | null;
  number: string | null;
  category: string;
  price: number;        // cents
  quantity: number;
  description: string | null;
  photos: { grid: string; full: string }[];
  listedAt: string | null;
};

let merch: { at: number; products: ShopProduct[] } | null = null;
let cards: { at: number; cards: ShopCard[]; paused: boolean } | null = null;

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

async function loadCards(): Promise<{ cards: ShopCard[]; paused: boolean }> {
  const { data: running, error: se } = await db.from('shows').select('id').is('ended_at', null).limit(1);
  if (se) throw se;
  if (running?.length) return { cards: [], paused: true };

  const { data, error } = await db
    .from('shop_listings')
    .select('id, title, set_name, card_number, category, price, quantity, description, photos, published_at')
    .eq('status', 'live')
    .gt('quantity', 0)
    .order('published_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  const url = (name: string) => db.storage.from('shop-photos').getPublicUrl(name).data.publicUrl;
  return {
    paused: false,
    cards: (data ?? []).map((l) => ({
      id: l.id,
      title: l.title,
      set: l.set_name,
      number: l.card_number,
      category: l.category,
      price: Math.round(Number(l.price) * 100),
      quantity: l.quantity,
      description: l.description,
      photos: (l.photos as string[]).map((p) => ({ grid: url(p.replace(/\.jpg$/, '_m.jpg')), full: url(p) })),
      listedAt: l.published_at,
    })),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);

  // Merch and cards load independently: one failing doesn't hide the other.
  const [m, c] = await Promise.allSettled([
    !merch || Date.now() - merch.at > MERCH_CACHE_MS
      ? loadCatalog().then((products) => (merch = { at: Date.now(), products }))
      : Promise.resolve(merch),
    !cards || Date.now() - cards.at > CARDS_CACHE_MS
      ? loadCards().then((r) => (cards = { at: Date.now(), ...r }))
      : Promise.resolve(cards),
  ]);
  if (m.status === 'rejected') console.error('merch', m.reason);
  if (c.status === 'rejected') console.error('cards', c.reason);
  if (m.status === 'rejected' && c.status === 'rejected') {
    return json(req, { error: 'Could not load products' }, 502);
  }

  return json(
    req,
    {
      products: m.status === 'fulfilled' ? m.value.products : merch?.products ?? [],
      cards: c.status === 'fulfilled' ? c.value.cards : cards?.cards ?? [],
      cardsPaused: c.status === 'fulfilled' ? c.value.paused : cards?.paused ?? false,
      merchError: m.status === 'rejected',
      cardsError: c.status === 'rejected',
    },
    200,
    { 'Cache-Control': 'public, max-age=15' },
  );
});

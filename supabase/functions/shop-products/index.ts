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

import { corsHeaders, json, loadCatalog, type ShopProduct } from '../_shared/shop.ts';
import { db, loadSettings } from '../_shared/cards.ts';

const MERCH_CACHE_MS = 5 * 60 * 1000;
const CARDS_CACHE_MS = 10 * 1000;

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
type Shipping = { envelope: number; package: number; envelopeUnder: number; offers: boolean; offerMinPercent: number; maxCards: number };
let cards: { at: number; cards: ShopCard[]; paused: boolean; shipping: Shipping | null } | null = null;

async function loadCards(): Promise<{ cards: ShopCard[]; paused: boolean; shipping: Shipping | null }> {
  const s = await loadSettings().catch(() => null);
  const shipping = s ? { envelope: s.envelope_cents, package: s.package_cents, envelopeUnder: s.envelope_under_cents, offers: s.offers_enabled, offerMinPercent: s.offer_min_percent, maxCards: s.envelope_max_cards } : null;
  const { data: running, error: se } = await db.from('shows').select('id').is('ended_at', null).limit(1);
  if (se) throw se;
  if (running?.length) return { cards: [], paused: true, shipping };

  const { data, error } = await db
    .from('shop_listings')
    .select('id, title, set_name, card_number, category, price, quantity, description, photos, published_at')
    .eq('status', 'live')
    .gt('quantity', 0)
    .order('published_at', { ascending: false })
    .limit(1000);
  if (error) throw error;

  // Cards in someone's checkout right now aren't available to anyone else.
  const ids = (data ?? []).map((l) => l.id);
  const held = new Map<string, number>();
  if (ids.length) {
    const { data: holds, error: he } = await db
      .from('shop_holds')
      .select('listing_id, qty')
      .in('listing_id', ids)
      .gt('expires_at', new Date().toISOString());
    if (he) throw he;
    for (const h of holds ?? []) held.set(h.listing_id, (held.get(h.listing_id) ?? 0) + h.qty);
  }

  const url = (name: string) => db.storage.from('shop-photos').getPublicUrl(name).data.publicUrl;
  return {
    paused: false,
    shipping,
    cards: (data ?? []).filter((l) => l.quantity - (held.get(l.id) ?? 0) > 0).map((l) => ({
      id: l.id,
      title: l.title,
      set: l.set_name,
      number: l.card_number,
      category: l.category,
      price: Math.round(Number(l.price) * 100),
      quantity: l.quantity - (held.get(l.id) ?? 0),
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
      shipping: c.status === 'fulfilled' ? c.value.shipping : cards?.shipping ?? null,
      merchError: m.status === 'rejected',
      cardsError: c.status === 'rejected',
    },
    200,
    { 'Cache-Control': 'public, max-age=15' },
  );
});

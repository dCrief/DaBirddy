/**
 * Offers on cards (dabirddy.com/cards). Anonymous; deploy with --no-verify-jwt.
 *
 *   POST { listing_id, amount_cents, name, email, phone?, note? }  -> { token }
 *   GET  ?o=<token>  -> the offer's status for the buyer's offer page
 *
 * The token is unguessable and is the buyer's only key to their offer. Partners
 * answer offers in the ledger; an accepted or countered offer is paid through
 * card-checkout ({ offer: token }) within 48 hours.
 */

import { corsHeaders, json } from '../_shared/shop.ts';
import { db, loadSettings } from '../_shared/cards.ts';
import { money, notifyLedger } from '../_shared/push.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });

  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('o') ?? '';
    if (!/^[0-9a-f]{64}$/.test(token)) return json(req, { error: 'Not found' }, 404);
    const { data: o } = await db.from('shop_offers')
      .select('status, amount_cents, counter_cents, expires_at, created_at, listing_id, buyer_name')
      .eq('token', token).maybeSingle();
    if (!o) return json(req, { error: 'Not found' }, 404);
    const { data: l } = await db.from('shop_listings')
      .select('id, title, set_name, card_number, variant, price, photos, status, quantity').eq('id', o.listing_id).maybeSingle();
    const expired = !!o.expires_at && new Date(o.expires_at) < new Date();
    const available = l?.status === 'live' && l.quantity > 0;
    const photo = (l?.photos as string[] | undefined)?.[0];
    return json(req, {
      status: (o.status === 'accepted' || o.status === 'countered') && expired ? 'expired' : o.status,
      offer: o.amount_cents,
      counter: o.counter_cents,
      pay: o.status === 'countered' ? o.counter_cents : o.status === 'accepted' ? o.amount_cents : null,
      expires_at: o.expires_at,
      name: o.buyer_name,
      card: l ? {
        id: l.id,
        title: l.title,
        set: l.set_name,
        number: l.card_number,
        variant: l.variant,
        price: Math.round(Number(l.price) * 100),
        photo: photo ? db.storage.from('shop-photos').getPublicUrl(photo.replace(/\.jpg$/, '_m.jpg')).data.publicUrl : null,
        available,
      } : null,
    }, 200, { 'Cache-Control': 'no-store' });
  }

  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);
  const b = await req.json().catch(() => ({}));
  const name = str(b.name, 80), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 30) || null, note = str(b.note, 500) || null;
  const amount = Number(b.amount_cents);
  if (typeof b.listing_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.listing_id)) return json(req, { error: 'Pick a card' }, 400);
  if (!Number.isInteger(amount) || amount < 100) return json(req, { error: 'Enter your offer in dollars' }, 400);
  if (!name) return json(req, { error: 'Add your name' }, 400);
  if (!EMAIL.test(email)) return json(req, { error: 'Add an email we can reply to' }, 400);

  const s = await loadSettings();
  if (!s.offers_enabled) return json(req, { error: 'We’re not taking offers right now.' }, 409);
  const { data: show } = await db.from('shows').select('id').is('ended_at', null).limit(1);
  if (show?.length) return json(req, { error: 'We’re at a card show right now. Try again after the show.' }, 409);

  const { data: l } = await db.from('shop_listings').select('id, title, price, status, quantity').eq('id', b.listing_id).maybeSingle();
  if (!l || l.status !== 'live' || l.quantity < 1) return json(req, { error: 'This card just sold.' }, 409);
  const price = Math.round(Number(l.price) * 100);
  if (amount >= price) return json(req, { error: 'That’s the full price, so just add it to your cart.' }, 400);
  // Cards under $20 need offers of at least 80%; pricier cards use the ledger setting.
  const min = Math.ceil((price * (price < 2000 ? Math.max(80, s.offer_min_percent) : s.offer_min_percent)) / 100);
  if (amount < min) return json(req, { error: `Offers on this card start at $${(min / 100).toFixed(2)}.` }, 400);

  // Keep it to one open offer per buyer per card, and a few open offers per buyer.
  const { data: open } = await db.from('shop_offers').select('id, listing_id').eq('buyer_email', email).eq('status', 'pending');
  if ((open ?? []).some((x) => x.listing_id === l.id)) return json(req, { error: 'You already have an offer waiting on this card. We’ll reply soon.' }, 409);
  if ((open ?? []).length >= 5) return json(req, { error: 'You have a few offers waiting already. We’ll reply to those first.' }, 429);

  const { data: row, error } = await db.from('shop_offers')
    .insert({ listing_id: l.id, amount_cents: amount, buyer_name: name, buyer_email: email, buyer_phone: phone, note })
    .select('token').single();
  if (error) return json(req, { error: 'Couldn’t send your offer. Please try again.' }, 500);
  await notifyLedger('offers', {
    title: `Offer: ${money(amount)} for ${l.title}`,
    body: `${name} offered ${money(amount)} (listed ${money(price)}, ${Math.round((amount / price) * 100)}%).${note ? ` “${note.slice(0, 80)}”` : ''}`,
    tag: `offer-${row.token.slice(0, 12)}`,
  });
  return json(req, { token: row.token });
});

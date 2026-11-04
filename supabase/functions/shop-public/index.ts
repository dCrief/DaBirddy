/**
 * The public bits of dabirddy.com/cards that aren't checkout. Deploy with --no-verify-jwt.
 *
 * GET  ?reviews                 published reviews, average rating and count
 * GET  ?cart=<cart id>          what's in a cart (for the cart-reminder email's link)
 * GET  ?review=<order id>&t=<review token>   the order a review link is for (+ its review)
 * POST { action: 'review', o, t, rating, body, name }   leave or edit that order's review
 * POST { action: 'subscribe', email, vid?, source? }    join the email list (welcome email once)
 * POST { action: 'alert', email, term, vid? }           "notify me" when matching cards list
 * POST { action: 'wishlist', vid, ids }                 the browser's saved cards (whole set)
 * POST { action: 'event', vid, type, path, listing_id?, ref?, utm_source?, utm_medium?, utm_campaign? }
 * POST { action: 'unsubscribe', u }                     an email's unsubscribe/stop-alert token
 *
 * Only paid, shipped orders can be reviewed, and only with the token from that order's
 * review email, so every review is from a real customer. The browser id (vid) is the
 * random cart id the site already keeps; it identifies nobody on its own.
 */

import { corsHeaders, json } from '../_shared/shop.ts';
import { db } from '../_shared/cards.ts';
import * as mail from '../_shared/mail.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const TOKEN = /^[0-9a-f]{16,64}$/i;
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|embedly|monitor|curl|wget|python|go-http/i;
const EVENTS = new Set(['view', 'card', 'add', 'checkout', 'signup', 'wishlist', 'alert']);

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const clean = (v: unknown, max: number) => {
  const s = str(v, max);
  return s ? s.replace(/[\u0000-\u001f\u007f]/g, ' ') : null;
};

function device(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** Order for a review link, if the link is genuine and the order was paid and shipped. */
async function reviewOrder(o: unknown, t: unknown) {
  if (typeof o !== 'string' || !UUID.test(o) || typeof t !== 'string' || !TOKEN.test(t)) return null;
  const { data } = await db.from('shop_orders').select('id, order_number, buyer_name, items, status, paid_at, review_token').eq('id', o).maybeSingle();
  if (!data || data.review_token !== t || !data.paid_at || data.status !== 'shipped') return null;
  return data;
}

async function reviews(req: Request) {
  const { data, error } = await db.from('shop_reviews').select('id, rating, body, display_name, created_at, order_id').eq('hidden', false).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  const ids = (data ?? []).map((r) => r.order_id);
  const { data: orders } = ids.length ? await db.from('shop_orders').select('id, items').in('id', ids) : { data: [] };
  const list = (data ?? []).map((r) => ({
    rating: r.rating,
    body: r.body,
    name: r.display_name,
    at: r.created_at,
    cards: ((orders ?? []).find((o) => o.id === r.order_id)?.items as { title: string }[] | undefined ?? []).slice(0, 4).map((it) => it.title),
  }));
  const count = list.length;
  const average = count ? Math.round((list.reduce((n, r) => n + r.rating, 0) / count) * 10) / 10 : null;
  return json(req, { reviews: list, count, average }, 200, { 'Cache-Control': 'public, max-age=60' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  try {
    if (req.method === 'GET') {
      const q = new URL(req.url).searchParams;
      if (q.has('reviews')) return await reviews(req);
      if (q.has('cart')) {
        // A cart-reminder link: the cards still in that cart (ids and quantities only).
        const id = q.get('cart') ?? '';
        if (!UUID.test(id)) return json(req, { error: 'Not found' }, 404);
        const { data: c } = await db.from('shop_carts').select('items, order_id, updated_at').eq('id', id).maybeSingle();
        if (!c) return json(req, { error: 'Not found' }, 404);
        if (c.order_id) {
          // Already bought? Then there's nothing to bring back.
          const since = new Date(new Date(c.updated_at).getTime() - 10 * 60e3).toISOString();
          const { data: paid } = await db.from('shop_orders').select('id').eq('id', c.order_id).not('paid_at', 'is', null).gte('created_at', since).maybeSingle();
          if (paid) return json(req, { items: [] }, 200, { 'Cache-Control': 'no-store' });
        }
        const items = (c.items as { id: string; qty: number; offer?: boolean }[]).filter((it) => !it.offer).map((it) => ({ id: it.id, qty: it.qty }));
        return json(req, { items }, 200, { 'Cache-Control': 'no-store' });
      }
      if (q.has('review')) {
        const o = await reviewOrder(q.get('review'), q.get('t'));
        if (!o) return json(req, { error: 'This review link isn’t valid, or the order hasn’t shipped yet.' }, 404);
        const { data: r } = await db.from('shop_reviews').select('rating, body, display_name').eq('order_id', o.id).maybeSingle();
        const first = (o.buyer_name ?? '').trim().split(/\s+/);
        return json(req, {
          order: o.order_number,
          cards: (o.items as { title: string; qty: number }[]).map((it) => it.title),
          name: first[0] ? `${first[0]}${first.length > 1 && first.at(-1) ? ` ${first.at(-1)![0]}.` : ''}` : '',
          review: r ? { rating: r.rating, body: r.body, name: r.display_name } : null,
        }, 200, { 'Cache-Control': 'no-store' });
      }
      return json(req, { error: 'Not found' }, 404);
    }
    if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

    const b = await req.json().catch(() => null);
    if (!b || typeof b !== 'object') return json(req, { error: 'Bad request' }, 400);
    const vid = typeof b.vid === 'string' && UUID.test(b.vid) ? b.vid : null;

    switch (b.action) {
      case 'review': {
        const o = await reviewOrder(b.o, b.t);
        if (!o) return json(req, { error: 'This review link isn’t valid, or the order hasn’t shipped yet.' }, 403);
        const rating = Number(b.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(req, { error: 'Pick 1 to 5 stars.' }, 400);
        const name = clean(b.name, 40);
        if (!name) return json(req, { error: 'Add the name to show with your review.' }, 400);
        const body = typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n').trim().slice(0, 1500) : '';
        const { error } = await db.from('shop_reviews').upsert({ order_id: o.id, rating, body, display_name: name }, { onConflict: 'order_id' });
        if (error) throw error;
        return json(req, { ok: true });
      }

      case 'subscribe': {
        if (b.website) return json(req, { ok: true }); // honeypot
        const email = str(b.email, 254)?.toLowerCase();
        if (!email || !EMAIL.test(email)) return json(req, { error: 'That email doesn’t look right.' }, 400);
        const source = clean(b.source, 30) ?? 'site';
        const { data: had } = await db.from('shop_subscribers').select('id, unsubscribed_at').eq('email', email).maybeSingle();
        const { data: sub, error } = await db.from('shop_subscribers')
          .upsert({ email, source: had ? undefined : source, unsubscribed_at: null, ...(vid ? { vid } : {}) }, { onConflict: 'email' })
          .select('token').single();
        if (error) throw error;
        if (vid) await db.from('shop_events').insert({ vid, type: 'signup', path: '/cards/', device: device(req.headers.get('user-agent') ?? '') });
        // The welcome email goes once per address, ever, so this can't be used to spam someone.
        const { data: first } = await db.from('shop_email_log').upsert({ kind: 'welcome', key: 'welcome', email }, { onConflict: 'kind,key,email', ignoreDuplicates: true }).select('kind');
        if (first?.length) await mail.welcome(email, sub.token).catch((e) => console.error('welcome', e));
        return json(req, { ok: true, already: !!had && !had.unsubscribed_at });
      }

      case 'alert': {
        if (b.website) return json(req, { ok: true });
        const email = str(b.email, 254)?.toLowerCase();
        if (!email || !EMAIL.test(email)) return json(req, { error: 'That email doesn’t look right.' }, 400);
        const term = clean(b.term, 60)?.replace(/\s+/g, ' ');
        if (!term || term.length < 2) return json(req, { error: 'What should we watch for?' }, 400);
        const { count } = await db.from('shop_alerts').select('id', { count: 'exact', head: true }).eq('email', email).eq('active', true);
        if ((count ?? 0) >= 25) return json(req, { error: 'That email already has 25 alerts. Stop one from an alert email first.' }, 400);
        const { data: a, error } = await db.from('shop_alerts').upsert({ email, term, active: true }, { onConflict: 'email,term' }).select('token, term').single();
        if (error) throw error;
        if (vid) await db.from('shop_events').insert({ vid, type: 'alert', path: '/cards/', device: device(req.headers.get('user-agent') ?? '') });
        const { data: first } = await db.from('shop_email_log').upsert({ kind: 'welcome', key: `alert:${term.toLowerCase()}`, email }, { onConflict: 'kind,key,email', ignoreDuplicates: true }).select('kind');
        if (first?.length) await mail.alertConfirm(email, a.token, a.term).catch((e) => console.error('alert confirm', e));
        return json(req, { ok: true });
      }

      case 'wishlist': {
        if (!vid || !Array.isArray(b.ids) || b.ids.length > 200) return json(req, { error: 'Bad wishlist' }, 400);
        const ids = [...new Set((b.ids as unknown[]).filter((x): x is string => typeof x === 'string' && UUID.test(x)))];
        const { data: real } = ids.length ? await db.from('shop_listings').select('id').in('id', ids) : { data: [] };
        const keep = (real ?? []).map((r) => r.id);
        const { data: now } = await db.from('shop_wishlist').select('listing_id').eq('vid', vid);
        const have = new Set((now ?? []).map((r) => r.listing_id));
        const gone = [...have].filter((id) => !keep.includes(id));
        const added = keep.filter((id) => !have.has(id));
        if (gone.length) await db.from('shop_wishlist').delete().eq('vid', vid).in('listing_id', gone);
        if (added.length) {
          await db.from('shop_wishlist').insert(added.map((listing_id) => ({ vid, listing_id })));
          await db.from('shop_events').insert(added.map((listing_id) => ({ vid, type: 'wishlist', listing_id, path: '/cards/', device: device(req.headers.get('user-agent') ?? '') })));
        }
        return json(req, { ok: true });
      }

      case 'event': {
        const ua = req.headers.get('user-agent') ?? '';
        if (!vid || !EVENTS.has(b.type) || BOT.test(ua) || !ua) return json(req, { ok: true });
        let ref: string | null = null;
        try {
          const host = b.ref ? new URL(String(b.ref)).hostname.replace(/^www\./, '') : '';
          ref = host && !/(^|\.)dabirddy\.com$/.test(host) ? host.slice(0, 100) : null;
        } catch { /* not a URL */ }
        const listing = typeof b.listing_id === 'string' && UUID.test(b.listing_id) ? b.listing_id : null;
        const { error } = await db.from('shop_events').insert({
          vid,
          type: b.type,
          path: clean(b.path, 200),
          listing_id: listing,
          ref,
          utm_source: clean(b.utm_source, 60)?.toLowerCase() ?? null,
          utm_medium: clean(b.utm_medium, 60)?.toLowerCase() ?? null,
          utm_campaign: clean(b.utm_campaign, 60) ?? null,
          device: device(ua),
        });
        // A listing id for a card that's since been deleted fails the foreign key; drop it quietly.
        if (error && listing) await db.from('shop_events').insert({ vid, type: b.type, path: clean(b.path, 200), ref, device: device(ua) });
        return json(req, { ok: true });
      }

      case 'unsubscribe': {
        const u = typeof b.u === 'string' && TOKEN.test(b.u) ? b.u : null;
        if (!u) return json(req, { error: 'This link isn’t valid.' }, 400);
        const { data: sub } = await db.from('shop_subscribers').update({ unsubscribed_at: new Date().toISOString() }).eq('token', u).select('email').maybeSingle();
        if (sub) {
          await db.from('shop_alerts').update({ active: false }).eq('email', sub.email);
          return json(req, { ok: true, kind: 'list' });
        }
        const { data: a } = await db.from('shop_alerts').update({ active: false }).eq('token', u).select('term').maybeSingle();
        if (a) return json(req, { ok: true, kind: 'alert', term: a.term });
        return json(req, { error: 'This link isn’t valid.' }, 404);
      }
    }
    return json(req, { error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('shop-public', e);
    return json(req, { error: 'Something went wrong. Please try again.' }, 500);
  }
});

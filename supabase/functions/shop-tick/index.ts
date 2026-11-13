/**
 * POST /shop-tick — runs every 5 minutes from pg_cron (job "shop-tick"), sending the shop's
 * follow-up emails. Needs header x-hub-token matching vault secret shop_sync_token.
 *
 *   1. "Your order shipped" — orders marked shipped in the last 3 days that haven't had it.
 *   2. Review request — 7 days after shipping (up to 30 days), once per order.
 *   3. Abandoned cart — a subscriber's cart (cart id = their browser id) left 2–48 hours
 *      with cards still for sale and nothing bought since. Once per cart change, and at
 *      most once every 3 days per email.
 *   4. "Notify me" alerts — new cards matching a saved alert (words, plus optional kind of
 *      listing and top price after any sale), each card once per email.
 *   5. Wishlist sale — once per sale per subscriber, when their saved cards are in it.
 *   6. Late-shipping reminder to the partners (not customers) — paid orders not marked
 *      shipped 48 hours after payment, once per order per partner.
 *
 * Every send is claimed first (a shop_email_log row or an order timestamp), so a slow or
 * overlapping run never emails anyone twice. Deploy with --no-verify-jwt.
 */

import { db } from '../_shared/cards.ts';
import { activeSale, onSale, salePrice } from '../_shared/sale.ts';
import * as mail from '../_shared/mail.ts';

const MAX_SENDS = 40; // per run; Resend allows 2/second, and the free plan 100/day
const HOUR = 3600e3;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const pause = () => new Promise((r) => setTimeout(r, 600));

let sends = 0;
async function sendOne(fn: () => Promise<boolean>): Promise<boolean> {
  if (sends >= MAX_SENDS) return false;
  sends++;
  const ok = await fn().catch((e) => (console.error('send', e), false));
  await pause();
  return ok;
}

/** Claim (kind, key, email) in the log. False if it was already sent. */
async function claim(kind: string, key: string, email: string): Promise<boolean> {
  const { data, error } = await db.from('shop_email_log').upsert({ kind, key, email }, { onConflict: 'kind,key,email', ignoreDuplicates: true }).select('kind');
  if (error) {
    console.error('claim', kind, error.message);
    return false;
  }
  return (data ?? []).length > 0;
}
const unclaim = (kind: string, key: string, email: string) => db.from('shop_email_log').delete().match({ kind, key, email });

const photoUrl = (name: string | null | undefined) =>
  name ? db.storage.from('shop-photos').getPublicUrl(name.replace(/\.jpg$/, '_m.jpg')).data.publicUrl : null;

type Listing = { id: string; title: string; set_name: string | null; card_number: string | null; variant: string | null; category: string; price: number; quantity: number; photos: string[] | null; published_at: string | null };
const LISTING_COLS = 'id, title, set_name, card_number, variant, category, price, quantity, photos, published_at';

function toMailCard(l: Listing, sale: Awaited<ReturnType<typeof activeSale>>): mail.MailCard {
  const list = Math.round(Number(l.price) * 100);
  const price = salePrice(sale, l.id, list);
  return {
    id: l.id,
    title: l.variant ? `${l.title} (${l.variant})` : l.title,
    set: l.set_name,
    number: l.card_number,
    price,
    list: price < list ? list : null,
    photo: photoUrl(l.photos?.[0]),
  };
}

const ORDER_COLS = 'id, order_number, buyer_name, buyer_email, method, tracking_number, stripe_session_id, review_token, items';

async function shippedEmails() {
  const { data } = await db.from('shop_orders').select(ORDER_COLS)
    .eq('status', 'shipped').is('shipped_email_at', null).not('buyer_email', 'is', null).gte('shipped_at', ago(72 * HOUR)).limit(20);
  for (const o of data ?? []) {
    // Claim the order first; give it back if Resend refuses so the next run retries.
    const { data: got } = await db.from('shop_orders').update({ shipped_email_at: new Date().toISOString() }).eq('id', o.id).is('shipped_email_at', null).select('id');
    if (!got?.length) continue;
    if (!(await sendOne(() => mail.shipped(o as any)))) await db.from('shop_orders').update({ shipped_email_at: null }).eq('id', o.id);
  }
}

async function reviewRequests() {
  const { data } = await db.from('shop_orders').select(ORDER_COLS)
    .eq('status', 'shipped').is('review_requested_at', null).not('buyer_email', 'is', null).not('paid_at', 'is', null)
    .lte('shipped_at', ago(7 * 24 * HOUR)).gte('shipped_at', ago(30 * 24 * HOUR)).limit(20);
  for (const o of data ?? []) {
    const { count } = await db.from('shop_reviews').select('id', { count: 'exact', head: true }).eq('order_id', o.id);
    const { data: got } = await db.from('shop_orders').update({ review_requested_at: new Date().toISOString() }).eq('id', o.id).is('review_requested_at', null).select('id');
    if (!got?.length || count) continue; // already reviewed: just mark it
    if (!(await sendOne(() => mail.reviewRequest(o as any)))) await db.from('shop_orders').update({ review_requested_at: null }).eq('id', o.id);
  }
}

async function abandonedCarts(sale: Awaited<ReturnType<typeof activeSale>>) {
  const { data: carts } = await db.from('shop_carts').select('id, items, order_id, updated_at')
    .gt('item_count', 0).lte('updated_at', ago(2 * HOUR)).gte('updated_at', ago(48 * HOUR)).limit(200);
  if (!carts?.length) return;
  const { data: subs } = await db.from('shop_subscribers').select('email, token, vid').in('vid', carts.map((c) => c.id)).is('unsubscribed_at', null);
  for (const sub of subs ?? []) {
    const cart = carts.find((c) => c.id === sub.vid)!;
    const since = new Date(new Date(cart.updated_at).getTime() - 10 * 60e3).toISOString();
    // Bought these (or anything) since the cart last changed? Then it isn't abandoned.
    if (cart.order_id) {
      const { data: o } = await db.from('shop_orders').select('id').eq('id', cart.order_id).not('paid_at', 'is', null).gte('created_at', since).maybeSingle();
      if (o) continue;
    }
    const { count: bought } = await db.from('shop_orders').select('id', { count: 'exact', head: true }).ilike('buyer_email', sub.email.replace(/[\\%_]/g, '\\$&')).not('paid_at', 'is', null).gte('paid_at', since);
    if (bought) continue;
    const { count: recent } = await db.from('shop_email_log').select('key', { count: 'exact', head: true }).eq('kind', 'cart').eq('email', sub.email).gte('sent_at', ago(72 * HOUR));
    if (recent) continue;

    const ids = (cart.items as { id: string }[]).map((it) => it.id);
    const { data: ls } = await db.from('shop_listings').select(LISTING_COLS).in('id', ids).eq('status', 'live').gt('quantity', 0);
    if (!ls?.length) continue;
    const key = `${cart.id}@${cart.updated_at}`;
    if (!(await claim('cart', key, sub.email))) continue;
    const cards = ids.map((id) => ls.find((l) => l.id === id)).filter(Boolean).map((l) => toMailCard(l as Listing, sale));
    if (!(await sendOne(() => mail.cartReminder(sub.email, sub.token, cart.id, cards)))) await unclaim('cart', key, sub.email);
  }
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

async function alerts(sale: Awaited<ReturnType<typeof activeSale>>) {
  const { data: fresh } = await db.from('shop_listings').select(LISTING_COLS).eq('status', 'live').gt('quantity', 0).gte('published_at', ago(24 * HOUR)).limit(500);
  if (!fresh?.length) return;
  const { data: list } = await db.from('shop_alerts').select('email, term, token, category, max_price, created_at').eq('active', true).limit(2000);
  for (const a of list ?? []) {
    const want = words(a.term);
    if (!want.length) continue;
    const matches = (fresh as Listing[]).filter((l) => {
      if (!l.published_at || new Date(l.published_at) < new Date(a.created_at)) return false;
      if (a.category && l.category !== a.category) return false;
      if (a.max_price != null && salePrice(sale, l.id, Math.round(Number(l.price) * 100)) > Math.round(Number(a.max_price) * 100)) return false;
      const hay = new Set(words([l.title, l.variant, l.set_name, l.card_number].filter(Boolean).join(' ')));
      return want.every((w) => hay.has(w));
    });
    const cards: Listing[] = [];
    for (const l of matches) if (await claim('alert', l.id, a.email)) cards.push(l);
    if (!cards.length) continue;
    if (!(await sendOne(() => mail.alert(a.email, a.token, a, cards.slice(0, 12).map((l) => toMailCard(l, sale)))))) {
      for (const l of cards) await unclaim('alert', l.id, a.email);
    }
  }
}

async function wishlistSale(sale: Awaited<ReturnType<typeof activeSale>>) {
  if (!sale || new Date(sale.ends_at).getTime() - Date.now() < 30 * 60e3) return;
  const { data: wish } = await db.from('shop_wishlist').select('vid, listing_id').limit(10000);
  if (!wish?.length) return;
  const vids = new Set(wish.map((w) => w.vid));
  const { data: all } = await db.from('shop_subscribers').select('email, token, vid').is('unsubscribed_at', null).not('vid', 'is', null).limit(5000);
  const subs = (all ?? []).filter((s) => vids.has(s.vid));
  if (!subs.length) return;
  const { data: ls } = await db.from('shop_listings').select(LISTING_COLS).in('id', [...new Set(wish.map((w) => w.listing_id))]).eq('status', 'live').gt('quantity', 0);
  for (const sub of subs) {
    const mine = (ls as Listing[] ?? []).filter((l) => onSale(sale, l.id) && wish.some((w) => w.vid === sub.vid && w.listing_id === l.id));
    if (!mine.length) continue;
    if (!(await claim('sale', sale.id, sub.email))) continue;
    if (!(await sendOne(() => mail.wishlistSale(sub.email, sub.token, sale, mine.slice(0, 12).map((l) => toMailCard(l, sale)))))) await unclaim('sale', sale.id, sub.email);
  }
}

// Late-shipping nudge for David and Arjun: paid website orders still not marked shipped
// 48 hours after payment. One email per partner, listing the late orders plus any close
// behind (36h+). Each order is nudged once per partner (claimed in shop_email_log as "ship-late").
const LEDGER_APP = 'https://partner-ledger-rosy.vercel.app';
type LateOrder = { id: string; order_number: string; buyer_name: string | null; paid_at: string; method: string; items: { title: string; qty: number }[] | null };

function lateMail(to: { name: string; email: string }, orders: LateOrder[]) {
  const n = orders.length;
  const waited = (o: LateOrder) => {
    const h = Math.floor((Date.now() - new Date(o.paid_at).getTime()) / HOUR);
    return h < 72 ? `${h} hours` : `${Math.floor(h / 24)} days`;
  };
  const what = (o: LateOrder) => (o.items ?? []).map((it) => (it.qty > 1 ? `${it.qty} × ${it.title}` : it.title)).join(', ');
  const rows = orders.map((o) =>
    `<tr><td style="padding:8px 10px 8px 0;border-bottom:1px solid #eee;vertical-align:top"><b>${mail.esc(o.order_number)}</b><br><span style="color:#666;font-size:13px">${mail.esc(o.buyer_name ?? 'Buyer')} · ${o.method === 'envelope' ? 'Envelope' : 'Package'}</span></td>` +
    `<td style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top;color:#333">${mail.esc(what(o))}</td>` +
    `<td style="padding:8px 0 8px 10px;border-bottom:1px solid #eee;vertical-align:top;text-align:right;white-space:nowrap;color:#b91c1c">${waited(o)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:14px;padding:28px 24px">
<div style="font-size:24px;font-weight:800">DaBirddy</div>
<h1 style="font-size:20px;margin:18px 0 8px">${n === 1 ? 'An order hasn’t shipped yet' : `${n} orders haven’t shipped yet`}</h1>
<p style="margin:0 0 10px;color:#333;line-height:1.5">Hi ${mail.esc(to.name)}, ${n === 1 ? 'this website order is' : 'these website orders are'} still waiting in To ship.</p>
<table style="width:100%;border-collapse:collapse;margin-top:12px">${rows}</table>
<p style="margin:22px 0 0"><a href="${LEDGER_APP}" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Open To ship</a></p>
<p style="margin:18px 0 0;color:#666;font-size:13px;line-height:1.5">Already sent it? Tap Shipped on the order in the Shop tab so the buyer gets their tracking email. This reminder goes to David and Arjun only.</p>
</div></div></body></html>`;
  const text = `Hi ${to.name}, ${n === 1 ? 'this order is' : 'these orders are'} still waiting to be marked shipped:\n` +
    orders.map((o) => `- ${o.order_number} · ${o.buyer_name ?? 'Buyer'} · ${what(o)} · waiting ${waited(o)}`).join('\n') +
    `\n\nOpen To ship: ${LEDGER_APP}\nAlready sent it? Tap Shipped so the buyer gets their tracking email.`;
  return mail.send(to.email, n === 1 ? `Reminder: order ${orders[0].order_number} still needs to ship` : `Reminder: ${n} orders still need to ship`, html, text);
}

async function shipReminders() {
  const { data: late } = await db.from('shop_orders').select('id, order_number, buyer_name, paid_at, method, items')
    .eq('status', 'paid').not('paid_at', 'is', null).lte('paid_at', ago(36 * HOUR)).order('paid_at').limit(50);
  if (!late?.length) return;
  const { data: partners } = await db.from('partners').select('name, email').not('email', 'is', null);
  for (const p of partners ?? []) {
    if (!p.email?.includes('@')) continue;
    // Only when an order has crossed 48 hours; orders close behind (36h+) ride along in the
    // same email so a batch of orders paid close together doesn't mean a run of emails.
    const { data: done } = await db.from('shop_email_log').select('key').eq('kind', 'ship-late').eq('email', p.email).in('key', late.map((o) => o.id));
    const seen = new Set((done ?? []).map((d) => d.key));
    if (!(late as LateOrder[]).some((o) => !seen.has(o.id) && Date.now() - new Date(o.paid_at).getTime() >= 48 * HOUR)) continue;
    const mine: LateOrder[] = [];
    for (const o of late as LateOrder[]) if (await claim('ship-late', o.id, p.email)) mine.push(o);
    if (!mine.length) continue;
    if (!(await sendOne(() => lateMail(p, mine)))) for (const o of mine) await unclaim('ship-late', o.id, p.email);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: req.headers.get('x-hub-token') ?? '' });
  if (ok !== true) return new Response('Forbidden', { status: 403 });
  if (!Deno.env.get('RESEND_API_KEY')) return Response.json({ ok: false, error: 'RESEND_API_KEY not set' });

  sends = 0;
  const sale = await activeSale(0).catch(() => null);
  const steps: [string, () => Promise<void>][] = [
    ['ship-late', shipReminders],
    ['shipped', shippedEmails],
    ['reviews', reviewRequests],
    ['carts', () => abandonedCarts(sale)],
    ['alerts', () => alerts(sale)],
    ['wishlist', () => wishlistSale(sale)],
  ];
  const errors: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      console.error(name, e);
      errors.push(name);
    }
  }
  return Response.json({ ok: !errors.length, sent: sends, errors });
});

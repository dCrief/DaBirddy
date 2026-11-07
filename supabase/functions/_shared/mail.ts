import { db } from './cards.ts';

/**
 * Follow-up and marketing emails for dabirddy.com/cards, sent through Resend
 * (RESEND_API_KEY; optional SHOP_EMAIL_FROM). The order thank-you lives in email.ts.
 *
 *   shipped        — order is on its way, with tracking
 *   reviewRequest  — a week after shipping: leave a verified review
 *   cartReminder   — cards still in a cart the shopper left (subscribers only)
 *   alert          — new cards matching a "notify me" alert (Pokémon + optional kind and top price)
 *   manageAlerts   — a link to cards/alerts.html, where a shopper edits all their alerts
 *   wishlistSale   — wishlist cards in a flash sale (subscribers only)
 *   welcome / alertConfirm — right after signing up
 *
 * Marketing emails carry an unsubscribe link (unsubscribe.html?u=<token>).
 */

export const SITE = 'https://dabirddy.com/cards';
const FROM = () => Deno.env.get('SHOP_EMAIL_FROM') ?? 'DaBirddy <orders@dabirddy.com>';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const usd = (c: number) => '$' + (c / 100).toFixed(2);

let replyTo: string | null | undefined;
async function reply(): Promise<string | null> {
  if (replyTo === undefined) {
    const { data } = await db.from('shop_settings').select('from_email').eq('id', 1).maybeSingle();
    replyTo = data?.from_email ?? null;
  }
  return replyTo ?? null;
}

/** Send one email. Returns true when Resend accepted it. */
export async function send(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], ...((await reply()) ? { reply_to: await reply() } : {}), subject, html, text }),
  });
  if (!r.ok) {
    console.error('email', subject, r.status, await r.text().catch(() => ''));
    return false;
  }
  return true;
}

const button = (href: string, label: string) =>
  `<p style="margin:22px 0 0"><a href="${esc(href)}" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(label)}</a></p>`;

/** The shared look: white card on grey, DaBirddy header, optional unsubscribe line. */
function page(title: string, body: string, unsubscribe?: { href: string; label: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:14px;padding:28px 24px">
<div style="font-size:24px;font-weight:800">DaBirddy</div>
<h1 style="font-size:20px;margin:18px 0 8px">${esc(title)}</h1>
${body}
</div>
<p style="text-align:center;color:#888;font-size:12px;margin-top:14px;line-height:1.6"><a href="${SITE}" style="color:#888">dabirddy.com/cards</a> · <a href="${SITE}/policies.html" style="color:#888">Shipping &amp; returns</a>${unsubscribe ? `<br><a href="${esc(unsubscribe.href)}" style="color:#888">${esc(unsubscribe.label)}</a>` : ''}</p>
</div></body></html>`;
}

const para = (s: string) => `<p style="margin:0 0 10px;color:#333;line-height:1.5">${s}</p>`;

export type MailCard = { id: string; title: string; set: string | null; number: string | null; price: number; list?: number | null; photo: string | null };

function cardRows(cards: MailCard[]) {
  return `<table style="width:100%;border-collapse:collapse;margin-top:12px">${cards.map((c) => {
    const meta = [c.set, c.number ? `#${c.number}` : null].filter(Boolean).join(' · ');
    return `<tr><td style="padding:8px 10px 8px 0;border-bottom:1px solid #eee;width:56px">${c.photo ? `<a href="${SITE}/#${c.id}"><img src="${esc(c.photo)}" width="52" style="border-radius:6px;display:block" alt=""></a>` : ''}</td>` +
      `<td style="padding:8px 0;border-bottom:1px solid #eee"><a href="${SITE}/#${c.id}" style="color:#111;text-decoration:none"><b>${esc(c.title)}</b></a>${meta ? `<br><span style="color:#666;font-size:13px">${esc(meta)}</span>` : ''}</td>` +
      `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap"><b>${usd(c.price)}</b>${c.list && c.list > c.price ? `<br><s style="color:#999;font-size:12px">${usd(c.list)}</s>` : ''}</td></tr>`;
  }).join('')}</table>`;
}
const cardText = (cards: MailCard[]) => cards.map((c) => `- ${c.title} ${usd(c.price)}  ${SITE}/#${c.id}`).join('\n');

type OrderForMail = {
  id: string; order_number: string; buyer_name: string | null; buyer_email: string; method: string;
  tracking_number: string | null; stripe_session_id: string | null; review_token: string | null;
  items: { title: string; qty: number }[];
};
const firstName = (n: string | null) => (n ?? '').trim().split(/\s+/)[0] || 'there';
const orderLink = (o: OrderForMail) => (o.stripe_session_id ? `${SITE}/order.html?session_id=${o.stripe_session_id}` : `${SITE}/order.html?o=${o.order_number}`); // order.html asks for the email when there's no session id
const itemsText = (o: OrderForMail) => o.items.map((it) => (it.qty > 1 ? `${it.qty} × ${it.title}` : it.title)).join(', ');

export async function shipped(o: OrderForMail) {
  const usps = o.tracking_number && /^\d{20,22}$/.test(o.tracking_number) ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${o.tracking_number}` : null;
  const html = page(`Your order is on its way, ${firstName(o.buyer_name)}!`,
    para(`We just shipped order <b>${esc(o.order_number)}</b>: ${esc(itemsText(o))}.`) +
    para(o.method === 'envelope' ? 'It’s coming in a protected, tracked envelope. Most arrive in 3–7 business days.' : 'It’s coming by USPS Ground Advantage. Most arrive in 2–6 business days.') +
    (o.tracking_number ? para(`Tracking: ${usps ? `<a href="${usps}" style="color:#e11d48">${esc(o.tracking_number)}</a>` : esc(o.tracking_number)}`) : '') +
    button(orderLink(o), 'Track your order') +
    `<p style="margin:22px 0 0;color:#666;font-size:13px;line-height:1.5">Something not right? Reply to this email. Cards can be returned within 14 days of delivery (sealed product is final sale).</p>`);
  const text = `We just shipped order ${o.order_number}: ${itemsText(o)}.\n${o.tracking_number ? `Tracking: ${o.tracking_number}\n` : ''}Track your order: ${orderLink(o)}\n\nSomething not right? Reply to this email. Cards can be returned within 14 days of delivery (sealed product is final sale).`;
  return send(o.buyer_email, `Your DaBirddy order ${o.order_number} has shipped`, html, text);
}

export async function reviewRequest(o: OrderForMail) {
  const link = `${SITE}/reviews.html?o=${o.id}&t=${o.review_token}`;
  const html = page(`How did we do, ${firstName(o.buyer_name)}?`,
    para(`Your order <b>${esc(o.order_number)}</b> (${esc(itemsText(o))}) should have arrived by now. We’d love to hear what you think.`) +
    para('A quick star rating and a sentence or two helps other collectors trust a small shop like ours. Only real customers can leave reviews.') +
    button(link, 'Leave a review') +
    `<p style="margin:22px 0 0;color:#666;font-size:13px;line-height:1.5">Haven’t received it, or something’s wrong? Just reply and we’ll make it right.</p>`);
  const text = `Your order ${o.order_number} should have arrived by now. We'd love a quick review: ${link}\n\nHaven't received it, or something's wrong? Just reply and we'll make it right.`;
  return send(o.buyer_email, 'How did we do? Leave a quick review', html, text);
}

export async function cartReminder(email: string, token: string, cartId: string, cards: MailCard[]) {
  const link = `${SITE}/?restore=${cartId}`;
  const unsub = `${SITE}/unsubscribe.html?u=${token}`;
  const html = page('You left something in your cart',
    para(cards.length === 1 ? 'This card is still waiting for you. Cards here are one of a kind, so once it sells it’s gone.' : 'These cards are still waiting for you. Cards here are one of a kind, so once they sell they’re gone.') +
    cardRows(cards) + button(link, 'Finish checking out'),
    { href: unsub, label: 'Unsubscribe from DaBirddy emails' });
  const text = `Still thinking it over? These cards are still in your cart:\n${cardText(cards)}\n\nFinish checking out: ${link}\n\nUnsubscribe: ${unsub}`;
  return send(email, cards.length === 1 ? `Still want ${cards[0].title}?` : 'Your cards are still in your cart', html, text);
}

/** One saved alert: what to watch for, and optional filters. */
export type AlertFor = { term: string; category?: string | null; max_price?: number | string | null };
const KIND: Record<string, string> = { single: 'singles', graded: 'graded cards', sealed: 'sealed product', bundle: 'bundles and lots' };
/** "Charizard (graded cards, up to $150)" */
export function alertLabel(a: AlertFor) {
  const top = a.max_price == null ? null : Number(a.max_price);
  const bits = [a.category ? KIND[a.category] : null, top != null ? `up to $${top % 1 ? top.toFixed(2) : top}` : null].filter(Boolean);
  return bits.length ? `${a.term} (${bits.join(', ')})` : a.term;
}
const manageLink = (token: string) => `${SITE}/alerts.html?u=${token}`;
const manageLine = (token: string) =>
  `<p style="margin:18px 0 0;color:#666;font-size:13px;line-height:1.5">Want other Pokémon, only graded cards, or a top price? <a href="${esc(manageLink(token))}" style="color:#e11d48">Manage your alerts</a>.</p>`;

export async function alert(email: string, token: string, a: AlertFor, cards: MailCard[]) {
  const stop = `${SITE}/unsubscribe.html?u=${token}`;
  const term = a.term;
  const html = page(`New ${term} cards just listed`,
    para(`You asked us to tell you when <b>${esc(alertLabel(a))}</b> comes in. ${cards.length === 1 ? 'This one' : 'These'} just went up:`) +
    cardRows(cards) + button(SITE, 'See them on the site') + manageLine(token),
    { href: stop, label: `Stop ${term} alerts` });
  const text = `New ${term} cards just listed:\n${cardText(cards)}\n\nManage your alerts: ${manageLink(token)}\nStop these alerts: ${stop}`;
  return send(email, `New ${term} ${cards.length === 1 ? 'card' : 'cards'} at DaBirddy`, html, text);
}

export async function manageAlerts(email: string, token: string) {
  const link = manageLink(token);
  const html = page('Manage your card alerts',
    para('Here’s your link to see every Pokémon you’re watching for on dabirddy.com/cards. Add new ones, change the kind of cards or the top price, or stop any of them.') +
    button(link, 'Manage my alerts') +
    `<p style="margin:22px 0 0;color:#666;font-size:13px;line-height:1.5">Didn’t ask for this? You can ignore it. Nothing changes unless you use the link.</p>`);
  return send(email, 'Your DaBirddy card alerts', html, `Manage your card alerts: ${link}\n\nDidn't ask for this? You can ignore it.`);
}

export async function wishlistSale(email: string, token: string, sale: { name: string; percent: number; ends_at: string }, cards: MailCard[]) {
  const unsub = `${SITE}/unsubscribe.html?u=${token}`;
  const ends = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(sale.ends_at));
  const html = page(`Cards on your wishlist are ${sale.percent}% off`,
    para(`Our ${esc(sale.name)} is on until <b>${esc(ends)}</b>, and ${cards.length === 1 ? 'a card' : 'cards'} you saved ${cards.length === 1 ? 'is' : 'are'} included:`) +
    cardRows(cards) + button(SITE, 'Shop the sale'),
    { href: unsub, label: 'Unsubscribe from DaBirddy emails' });
  const text = `Our ${sale.name} is on until ${ends}. Cards on your wishlist are ${sale.percent}% off:\n${cardText(cards)}\n\nUnsubscribe: ${unsub}`;
  return send(email, `${sale.percent}% off cards on your wishlist`, html, text);
}

export async function welcome(email: string, token: string) {
  const unsub = `${SITE}/unsubscribe.html?u=${token}`;
  const html = page('You’re on the list!',
    para('Thanks for signing up. We’ll email you about new card drops, flash sales and coupon codes. No spam, and you can unsubscribe any time.') +
    para('Tip: tap the ♡ on any card to save it to your wishlist. If a saved card goes on sale, we’ll let you know.') +
    button(SITE, 'Browse the cards'),
    { href: unsub, label: 'Unsubscribe' });
  return send(email, 'You’re on the DaBirddy list', html, `Thanks for signing up! We'll email you about new drops, flash sales and coupon codes.\n\nBrowse: ${SITE}\nUnsubscribe: ${unsub}`);
}

export async function alertConfirm(email: string, token: string, a: AlertFor) {
  const stop = `${SITE}/unsubscribe.html?u=${token}`;
  const html = page(`We’ll watch for ${a.term}`,
    para(`When new <b>${esc(alertLabel(a))}</b> cards are listed on dabirddy.com/cards, we’ll email you right away.`) +
    button(manageLink(token), 'Manage my alerts') +
    `<p style="margin:18px 0 0;color:#666;font-size:13px;line-height:1.5">Use that link any time to add more Pokémon, change the kind of cards or top price, or stop an alert.</p>`,
    { href: stop, label: `Stop ${a.term} alerts` });
  return send(email, `Alert set: ${a.term} cards`, html, `When new ${alertLabel(a)} cards are listed, we'll email you.\n\nManage your alerts: ${manageLink(token)}\nStop these alerts: ${stop}`);
}

import { db } from './cards.ts';

/**
 * "Thanks for your order" email for dabirddy.com/cards orders, sent through Resend.
 * Needs the RESEND_API_KEY secret (and dabirddy.com verified in Resend); without it this
 * does nothing. Optional: SHOP_EMAIL_FROM (default "DaBirddy <orders@dabirddy.com>").
 * Replies go to the shop's return email (ledger → Shop settings).
 */

const THANKS = [
  'Thanks for your support! Every order helps keep the binders full.',
  'Thank you for shopping small. It means a lot to us.',
  'Thanks for the support! We hope this one finds a great spot in your collection.',
  'You just made our day. Thanks for buying from DaBirddy!',
  'Thanks a ton! May your next pack be full of hits.',
  'We appreciate you! Thanks for supporting a small card shop.',
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const usd = (c: number) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);

type Item = { title: string; set: string | null; number: string | null; price_cents: number; qty: number; list_cents?: number };

function trackingUrl(n: string) {
  return /^\d{20,22}$/.test(n) ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` : null;
}

export async function sendThanks(orderId: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  try {
    const { data: o } = await db.from('shop_orders')
      .select('order_number, items, subtotal_cents, shipping_cents, total_cents, coupon_code, method, buyer_name, buyer_email, ship_to, tracking_number')
      .eq('id', orderId).maybeSingle();
    if (!o?.buyer_email) return false;
    const { data: s } = await db.from('shop_settings').select('from_email').eq('id', 1).maybeSingle();

    const first = (o.buyer_name ?? '').trim().split(/\s+/)[0] || 'there';
    let h = 0;
    for (const c of o.order_number) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const note = THANKS[h % THANKS.length];
    const items = o.items as Item[];
    const total = o.total_cents ?? o.subtotal_cents + o.shipping_cents;
    const coupon = o.subtotal_cents + o.shipping_cents - total;
    const t = o.ship_to as { name: string; line1: string; line2: string | null; city: string; state: string; postal_code: string } | null;
    const track = o.tracking_number ? trackingUrl(o.tracking_number) : null;

    const rows = items.map((it) => {
      const meta = [it.set, it.number ? `#${it.number}` : null].filter(Boolean).join(' · ');
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee"><b>${it.qty > 1 ? `${it.qty} × ` : ''}${esc(it.title)}</b>${meta ? `<br><span style="color:#666;font-size:13px">${esc(meta)}</span>` : ''}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${usd(it.price_cents * it.qty)}${it.list_cents ? `<br><s style="color:#999;font-size:12px">${usd(it.list_cents * it.qty)}</s>` : ''}</td></tr>`;
    }).join('');
    const line = (label: string, value: string, bold = false) =>
      `<tr><td style="padding:3px 0;${bold ? 'font-weight:700;font-size:16px' : 'color:#444'}">${label}</td><td style="padding:3px 0;text-align:right;${bold ? 'font-weight:700;font-size:16px' : 'color:#444'}">${value}</td></tr>`;

    const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:14px;padding:28px 24px">
<div style="font-size:24px;font-weight:800">DaBirddy</div>
<h1 style="font-size:20px;margin:18px 0 6px">Thank you, ${esc(first)}!</h1>
<p style="margin:0 0 6px;color:#333;line-height:1.5">We got your order <b>${esc(o.order_number)}</b> and we’re getting it ready to ship. ${esc(note)}</p>
<table style="width:100%;border-collapse:collapse;margin-top:18px">${rows}</table>
<table style="width:100%;border-collapse:collapse;margin-top:10px">
${line('Cards', usd(o.subtotal_cents))}
${coupon > 0 ? line(`Coupon${o.coupon_code ? ` ${esc(o.coupon_code)}` : ''}`, usd(-coupon)) : ''}
${line(o.method === 'envelope' ? 'Shipping (tracked envelope)' : 'Shipping (tracked package)', o.shipping_cents ? usd(o.shipping_cents) : 'Free')}
${line('Total paid', usd(total), true)}
</table>
${t ? `<p style="margin:18px 0 0;color:#444;line-height:1.5"><b>Shipping to</b><br>${esc(t.name)}<br>${esc(t.line1)}${t.line2 ? `<br>${esc(t.line2)}` : ''}<br>${esc(t.city)}, ${esc(t.state)} ${esc(t.postal_code)}</p>` : ''}
${o.tracking_number ? `<p style="margin:14px 0 0;color:#444">Tracking: ${track ? `<a href="${track}" style="color:#e11d48">${esc(o.tracking_number)}</a>` : esc(o.tracking_number)}</p>` : ''}
<p style="margin:22px 0 0;color:#444;line-height:1.5">Questions? Just reply to this email.<br>Thanks again for supporting DaBirddy!</p>
</div>
<p style="text-align:center;color:#888;font-size:12px;margin-top:14px"><a href="https://dabirddy.com/cards" style="color:#888">dabirddy.com/cards</a></p>
</div></body></html>`;

    const text = [
      `Thank you, ${first}!`,
      '',
      `We got your order ${o.order_number} and we're getting it ready to ship. ${note}`,
      '',
      ...items.map((it) => `${it.qty > 1 ? `${it.qty} x ` : ''}${it.title}  ${usd(it.price_cents * it.qty)}`),
      '',
      `Cards ${usd(o.subtotal_cents)}`,
      ...(coupon > 0 ? [`Coupon ${usd(-coupon)}`] : []),
      `Shipping ${o.shipping_cents ? usd(o.shipping_cents) : 'Free'}`,
      `Total paid ${usd(total)}`,
      ...(o.tracking_number ? ['', `Tracking: ${o.tracking_number}`] : []),
      '',
      'Questions? Just reply to this email. Thanks again for supporting DaBirddy!',
    ].join('\n');

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('SHOP_EMAIL_FROM') ?? 'DaBirddy <orders@dabirddy.com>',
        to: [o.buyer_email],
        ...(s?.from_email ? { reply_to: s.from_email } : {}),
        subject: `Thanks for your order! (${o.order_number})`,
        html,
        text,
      }),
    });
    if (!r.ok) {
      console.error('thank-you email', o.order_number, r.status, await r.text().catch(() => ''));
      return false;
    }
    console.log('thank-you email sent', o.order_number);
    return true;
  } catch (err) {
    console.error('thank-you email', orderId, err);
    return false;
  }
}

import { PDFDocument, PDFFont, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';

/** A 4x6 packing slip for a website order: what they bought, what they paid, and a thank-you. */

export type SlipOrder = {
  order_number: string;
  created_at: string;
  items: { title: string; set: string | null; number: string | null; price_cents: number; qty: number; listing_id?: string; inventory_no?: string | null }[];
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number | null;
  coupon_code: string | null;
  buyer_name: string | null;
  ship_to: { name?: string | null } | null;
};

const THANKS = [
  'Thanks for your support! Every order helps keep the binders full.',
  'Thank you for shopping small. It means a lot to us.',
  'Thanks for the support! Hope this one finds a great spot in your collection.',
  'You just made our day. Thanks for buying from DaBirddy!',
  'Thanks a ton! May your next pack be full of hits.',
  'We appreciate you! Thanks for supporting a small card shop.',
  'Thank you! Enjoy the new addition to your collection.',
  'Thanks for your order! Your support keeps the shop running.',
  'Huge thanks from DaBirddy. Happy collecting!',
  'Thanks for supporting the hobby and our little shop!',
  'Thank you! We hope it was worth the wait at the mailbox.',
  'Thanks for buying from us. Catch you at the next show!',
];

const W = 288, H = 432, M = 18;
// Thermal printers dither grey into faint dots, so everything prints solid black.
const ink = rgb(0, 0, 0), grey = ink;
const usd = (c: number) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);

/** Helvetica only covers Windows-1252; swap anything else for a close character. */
function clean(font: PDFFont, s: string) {
  return [...s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return '?';
      }
    })
    .join('');
}

function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The message is picked from the order number, so a reprint says the same thing. */
export function thanksFor(orderNumber: string) {
  let h = 0;
  for (const c of orderNumber) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return THANKS[h % THANKS.length];
}

export async function packingSlip(o: SlipOrder): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Packing slip ${o.order_number}`);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ital = await doc.embedFont(StandardFonts.HelveticaOblique);

  let page = doc.addPage([W, H]);
  let y = H - M;
  const text = (s: string, x: number, size: number, font = reg, color = ink) => page.drawText(clean(font, s), { x, y, size, font, color });
  const right = (s: string, size: number, font = reg, color = ink) => {
    const t = clean(font, s);
    page.drawText(t, { x: W - M - font.widthOfTextAtSize(t, size), y, size, font, color });
  };
  const rule = (gap = 8) => {
    y -= gap;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: grey });
    y -= gap;
  };
  const room = (need: number) => {
    if (y - need > M + 70) return;
    page = doc.addPage([W, H]);
    y = H - M - 12;
    text(`Order ${o.order_number} (continued)`, M, 9, bold, grey);
    y -= 18;
  };

  // Header
  y -= 18;
  text('DaBirddy', M, 22, bold);
  right('Packing slip', 10, bold, grey);
  y -= 13;
  text('dabirddy.com/cards', M, 10, reg, grey);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(o.created_at));
  right(date, 10, reg, grey);
  rule();
  y -= 4;
  text('Order', M, 9, reg, grey);
  right('Ship to', 9, reg, grey);
  y -= 12;
  text(o.order_number, M, 11, bold);
  right(o.ship_to?.name || o.buyer_name || '', 11, bold);
  rule(10);

  // Items
  const priceW = 70;
  const count = o.items.reduce((n, it) => n + it.qty, 0);
  text(`${count} item${count === 1 ? '' : 's'}`, M, 9, reg, grey);
  right('Price', 9, reg, grey);
  y -= 14;
  for (const it of o.items) {
    const title = wrap(bold, 10, clean(bold, it.title), W - 2 * M - priceW);
    const meta = [it.set, it.number ? `#${it.number}` : null].filter(Boolean).join(' · ');
    room(title.length * 12 + (meta || it.inventory_no ? 12 : 0) + 8);
    title.forEach((line, i) => {
      text(line, M, 10, bold);
      if (i === 0) right(it.qty > 1 ? `${it.qty} x ${usd(it.price_cents)}` : usd(it.price_cents), 10, reg);
      y -= 12;
    });
    // Stock # first, in bold, so the right card is easy to pull.
    if (meta || it.inventory_no) {
      let x = M;
      if (it.inventory_no) {
        const stock = clean(bold, `Stock ${it.inventory_no}`);
        text(stock, x, 9, bold);
        x += bold.widthOfTextAtSize(stock, 9) + (meta ? 6 : 0);
      }
      if (meta) {
        let m = clean(reg, meta);
        while (m.length > 4 && reg.widthOfTextAtSize(m, 9) > W - M - x) m = m.slice(0, -2) + '…';
        text(m.replace(/……$/, '…'), x, 9, reg, grey);
      }
      y -= 12;
    }
    y -= 5;
  }

  // Totals
  room(80);
  rule(2);
  const discount = o.total_cents != null ? o.subtotal_cents + o.shipping_cents - o.total_cents : 0;
  const row = (label: string, value: string, strong = false) => {
    y -= 13;
    text(label, M + 60, strong ? 11 : 9, strong ? bold : reg);
    right(value, strong ? 11 : 9, strong ? bold : reg);
  };
  row('Cards', usd(o.subtotal_cents));
  if (discount > 0) row(`Coupon${o.coupon_code ? ` ${o.coupon_code}` : ''}`, usd(-discount));
  row('Shipping', o.shipping_cents ? usd(o.shipping_cents) : 'Free');
  y -= 3;
  row('Total paid', usd(o.total_cents ?? o.subtotal_cents + o.shipping_cents), true);

  // Thank-you note at the bottom of the last page
  const note = wrap(ital, 11, thanksFor(o.order_number), W - 2 * M - 16);
  const boxH = note.length * 14 + 30;
  page.drawRectangle({ x: M, y: M, width: W - 2 * M, height: boxH, borderColor: ink, borderWidth: 0.8 });
  y = M + boxH - 20;
  for (const line of note) {
    page.drawText(line, { x: (W - ital.widthOfTextAtSize(line, 11)) / 2, y, size: 11, font: ital, color: ink });
    y -= 14;
  }
  const sig = '- DaBirddy';
  page.drawText(sig, { x: (W - bold.widthOfTextAtSize(sig, 10)) / 2, y: M + 8, size: 10, font: bold, color: ink });

  return await doc.save();
}

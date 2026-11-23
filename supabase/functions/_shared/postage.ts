/**
 * USPS letter postage for envelope labels, bought from EasyPost and printed on the TCG Tracking sticker.
 *
 * TCG Tracking makes the tracked label (address + its Intelligent Mail barcode) but sells no postage
 * through its API. EasyPost sells First-Class letter postage on a 6x4 label. We keep TCG Tracking's
 * label (so its scan history keeps working) and draw the postage block from EasyPost's label in the
 * stamp corner, so one sticker carries both.
 *
 * Env: EASYPOST_API_KEY (live). EASYPOST_TEST_KEY makes free sample labels for previews.
 */

import { PDFDocument, rgb } from 'npm:pdf-lib@1.17.1';

/** A box as fractions of the page, measured from the bottom-left corner (PDF style). */
export type Box = { x: number; y: number; w: number; h: number };

/** Where the postage sits on EasyPost's 6x4 letter label. Tuned from a sample label. */
export const POSTAGE_CROP: Box = { x: 0.6, y: 0.6, w: 0.4, h: 0.4 };
/** Where it goes on TCG Tracking's 6x4 (L64) label: the top-right stamp corner. */
export const POSTAGE_SPOT: Box = { x: 0.66, y: 0.6, w: 0.32, h: 0.38 };

/** The letter we mail: a card in a semi-rigid holder in an envelope. EasyPost needs dimensions. */
const LETTER = { length: 6.5, width: 3.625, height: 0.25 };

export type Postage = { cost_cents: number; tracking: string | null; shipment_id: string; pdf: Uint8Array };

type Addr = { name: string; street1: string; street2?: string | null; city: string; state: string; zip: string; phone?: string | null };

async function ep(key: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`https://api.easypost.com/v2${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Basic ${btoa(`${key}:`)}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`EasyPost: ${b.error?.message ?? r.status}`);
  return b;
}

/**
 * Buys First-Class letter postage for `oz` ounces from `from` to `to`. `test` uses the test key
 * (free, not real postage). Returns the 6x4 PDF and what it cost.
 */
export async function buyLetterPostage(opts: { to: Addr; from: Addr; oz: number; reference: string; nonmachinable?: boolean; test?: boolean }): Promise<Postage> {
  const key = Deno.env.get(opts.test ? 'EASYPOST_TEST_KEY' : 'EASYPOST_API_KEY');
  if (!key) throw new Error(`EasyPost isn’t connected yet (add ${opts.test ? 'EASYPOST_TEST_KEY' : 'EASYPOST_API_KEY'})`);
  const addr = (a: Addr) => ({ name: a.name, street1: a.street1, street2: a.street2 || undefined, city: a.city, state: a.state, zip: a.zip, country: 'US', phone: a.phone || undefined });
  const shipment = await ep(key, '/shipments', {
    method: 'POST',
    body: {
      shipment: {
        reference: opts.reference,
        to_address: addr(opts.to),
        from_address: addr(opts.from),
        parcel: { predefined_package: 'Letter', weight: opts.oz, ...LETTER },
        options: { label_format: 'PDF', label_size: '6x4', machinable: !opts.nonmachinable },
      },
    },
  });
  const rates: any[] = (shipment.rates ?? []).filter((r: any) => /usps/i.test(r.carrier) && r.service === 'First');
  if (!rates.length) {
    const why = (shipment.messages ?? []).map((m: any) => m.message).filter(Boolean).join('; ');
    throw new Error(`EasyPost had no First-Class letter rate${why ? `: ${why}` : ''}`);
  }
  const rate = rates.sort((a, b) => Number(a.rate) - Number(b.rate))[0];
  const bought = await ep(key, `/shipments/${shipment.id}/buy`, { method: 'POST', body: { rate: { id: rate.id } } });
  let url: string | undefined = bought.postage_label?.label_pdf_url;
  if (!url) {
    const pdf = await ep(key, `/shipments/${shipment.id}/label?file_format=PDF`);
    url = pdf.postage_label?.label_pdf_url ?? pdf.postage_label?.label_url;
  }
  if (!url) throw new Error('EasyPost didn’t return a postage PDF');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Downloading the postage: ${r.status}`);
  return {
    cost_cents: Math.round(Number(bought.selected_rate?.rate ?? rate.rate) * 100),
    tracking: bought.tracking_code ?? null,
    shipment_id: shipment.id,
    pdf: new Uint8Array(await r.arrayBuffer()),
  };
}

/** Draws the postage block (crop of EasyPost's label) onto the first page of TCG Tracking's label. */
export async function stampLabel(label: Uint8Array, postage: Uint8Array, crop: Box = POSTAGE_CROP, spot: Box = POSTAGE_SPOT): Promise<Uint8Array> {
  const out = await PDFDocument.load(label);
  const src = (await PDFDocument.load(postage)).getPage(0);
  const { width: sw, height: sh } = src.getSize();
  const block = await out.embedPage(src, {
    left: crop.x * sw, bottom: crop.y * sh, right: (crop.x + crop.w) * sw, top: (crop.y + crop.h) * sh,
  });
  const page = out.getPage(0);
  const { width: pw, height: ph } = page.getSize();
  const box = { x: spot.x * pw, y: spot.y * ph, w: spot.w * pw, h: spot.h * ph };
  // Keep the block's shape: fit it inside the spot, top-right aligned.
  const scale = Math.min(box.w / block.width, box.h / block.height);
  const w = block.width * scale, h = block.height * scale;
  const x = box.x + box.w - w, y = box.y + box.h - h;
  page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1) });
  page.drawPage(block, { x, y, width: w, height: h });
  return await out.save();
}

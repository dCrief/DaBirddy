import { PDFDocument, degrees } from 'npm:pdf-lib@1.17.1';

/**
 * TCG Tracking's L64 envelope label is a 6x4 landscape page. The Rollo feeds 4x6
 * portrait (like Whatnot's labels), and rotating at print time shifted it along the
 * label, so landscape pages are turned into 4x6 portrait before printing.
 * Returns null when there's nothing to change (already portrait, or unreadable).
 */
export async function portrait(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const src = await PDFDocument.load(bytes);
    const pages = src.getPages();
    if (!pages.some((p) => p.getWidth() > p.getHeight())) return null;
    const out = await PDFDocument.create();
    for (const [i, p] of pages.entries()) {
      const { width, height } = p.getSize();
      if (width <= height) {
        const [copy] = await out.copyPages(src, [i]);
        out.addPage(copy);
        continue;
      }
      const page = out.addPage([height, width]);
      page.drawPage(await out.embedPage(p), { x: height, y: 0, rotate: degrees(90) });
    }
    return await out.save();
  } catch (err) {
    console.error('portrait label', err);
    return null;
  }
}

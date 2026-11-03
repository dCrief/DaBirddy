import { db } from './cards.ts';

/**
 * Flash sale for dabirddy.com/cards: a percent off the whole site or chosen cards until a set
 * time. The ledger saves it as config/flash-sale.json in the shop-photos bucket (partners can
 * write there); null or an ended sale means no sale.
 */
export type Sale = {
  id: string;
  name: string;
  percent: number;
  all: boolean;
  listing_ids: string[];
  starts_at: string;
  ends_at: string;
  ended_at?: string | null;
};

let cache: { at: number; sale: Sale | null } | null = null;

function live(s: Sale | null): Sale | null {
  if (!s) return null;
  const now = Date.now();
  if (s.ended_at || !(s.percent >= 1 && s.percent <= 90)) return null;
  if (new Date(s.starts_at).getTime() > now || new Date(s.ends_at).getTime() <= now) return null;
  return s;
}

/** The sale running right now, if any (re-read at most every few seconds). */
export async function activeSale(maxAgeMs = 5000): Promise<Sale | null> {
  if (!cache || Date.now() - cache.at > maxAgeMs) {
    let sale: Sale | null = null;
    try {
      const { data } = await db.storage.from('shop-photos').download('config/flash-sale.json');
      if (data) sale = JSON.parse(await data.text());
    } catch {
      sale = null;
    }
    cache = { at: Date.now(), sale };
  }
  return live(cache.sale);
}

export const onSale = (s: Sale | null, listingId: string) => !!s && (s.all || s.listing_ids.includes(listingId));

/** The price in cents after the sale (whole cents, never below 1¢). */
export function salePrice(s: Sale | null, listingId: string, cents: number): number {
  if (!onSale(s, listingId)) return cents;
  return Math.max(1, Math.round((cents * (100 - s!.percent)) / 100));
}

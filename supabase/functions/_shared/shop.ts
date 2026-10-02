/**
 * Shared helpers for the DaBirddy merch shop functions.
 *
 * Env vars (set via `supabase secrets set`):
 *   PRINTFUL_API_TOKEN   — private token from developers.printful.com/tokens
 *   PRINTFUL_STORE_ID    — only needed if the token is account-level (multiple stores)
 *   SHOP_ALLOWED_ORIGINS — comma-separated, default "https://dabirddy.com,https://www.dabirddy.com"
 */

const PRINTFUL_API = 'https://api.printful.com';

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('SHOP_ALLOWED_ORIGINS') ??
    'https://dabirddy.com,https://www.dabirddy.com')
    .split(',').map((s) => s.trim());
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', ...extra },
  });
}

export async function printful(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${Deno.env.get('PRINTFUL_API_TOKEN')}`,
    'Content-Type': 'application/json',
  };
  const storeId = Deno.env.get('PRINTFUL_STORE_ID');
  if (storeId) headers['X-PF-Store-Id'] = storeId;

  const res = await fetch(PRINTFUL_API + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Printful ${res.status} on ${path}: ${body?.error?.message ?? body?.result ?? 'unknown error'}`);
  }
  return body.result;
}

export type ShopVariant = {
  id: number;          // Printful sync_variant id
  name: string;
  size: string | null;
  color: string | null;
  price: number;       // retail price in cents
  currency: string;
  image: string | null;
};

export type ShopProduct = {
  id: number;          // Printful sync_product id
  name: string;
  thumbnail: string | null;
  variants: ShopVariant[];
};

/** Loads every non-ignored product in the Printful store with its sellable variants. */
export async function loadCatalog(): Promise<ShopProduct[]> {
  const summaries: Array<{ id: number; is_ignored?: boolean }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await printful(`/store/products?limit=100&offset=${offset}`);
    summaries.push(...page);
    if (page.length < 100) break;
  }

  const details = await Promise.all(
    summaries.filter((p) => !p.is_ignored).map((p) => printful(`/store/products/${p.id}`)),
  );

  return details.map(({ sync_product, sync_variants }) => ({
    id: sync_product.id,
    name: sync_product.name,
    thumbnail: sync_product.thumbnail_url ?? null,
    variants: (sync_variants as any[])
      .filter((v) => !v.is_ignored && v.synced !== false &&
        (v.availability_status ?? 'active') === 'active' && v.retail_price)
      .map((v) => {
        const preview = (v.files ?? []).find((f: any) => f.type === 'preview');
        // Fallback parsing for names like "DaBirddy Tee - Black / M"
        const parts = String(v.name).split(' / ');
        return {
          id: v.id,
          name: v.name,
          size: v.size ?? (parts.length > 1 ? parts[parts.length - 1] : null),
          color: v.color ?? (parts.length > 1 ? parts[parts.length - 2].split(' - ').pop() : null),
          price: Math.round(parseFloat(v.retail_price) * 100),
          currency: (v.currency ?? 'USD').toLowerCase(),
          image: preview?.preview_url ?? v.product?.image ?? null,
        };
      }),
  })).filter((p) => p.variants.length > 0);
}

/**
 * GET /shop-products — public product catalog for dabirddy.com/shop.
 * Reads products from Printful and returns only what the storefront needs.
 * Deploy with --no-verify-jwt (the shop page is anonymous).
 */

import { corsHeaders, json, loadCatalog, type ShopProduct } from '../_shared/shop.ts';

const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; products: ShopProduct[] } | null = null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405);

  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), products: await loadCatalog() };
    }
    return json(req, { products: cache.products }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (err) {
    console.error(err);
    return json(req, { error: 'Could not load products' }, 502);
  }
});

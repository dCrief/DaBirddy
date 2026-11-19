/**
 * /ebay — lists shop cards on David's eBay account and keeps both sides in step.
 *
 * A listing with `ebay` on (Partner Ledger listing editor) is listed on eBay through the Inventory API
 * under its SKU (the inventory #, else the first 8 characters of the listing id). Any change that
 * matters to eBay marks the listing ebay_dirty and a database trigger posts { action: 'sync', id }
 * here; selling out, taking it off the site or turning eBay off ends the eBay listing. Every 5
 * minutes pg_cron posts { action: 'tick' }: dirty listings are retried and new eBay orders are pulled
 * in, taking the cards off the shop and logging the sale in the ledger for the payout partner.
 * The tick also pulls open Best Offers into shop_offers (source 'ebay') and buyer messages into
 * ebay_messages; answering either in the ledger fires a database trigger that posts
 * { action: 'offer_respond' | 'message_reply', id } here to send it to eBay (Trading API).
 *
 * Callers:
 *   x-hub-token (vault shop_sync_token): { action: 'sync' | 'offer_respond' | 'message_reply', id } | { action: 'tick' }
 *   Signed-in partner (ledger):          { action: 'status' | 'connect' | 'settings' | 'list_all' | 'sync' | 'disconnect', ... }
 *   eBay, GET ?code=&state=              OAuth consent came back (the RuName's "auth accepted" URL)
 *   eBay, GET ?challenge_code=           marketplace account deletion endpoint check
 *   eBay, POST (no auth)                 marketplace account deletion notice
 *
 * Secrets: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME, EBAY_VERIFICATION_TOKEN (32-80 chars,
 * also typed into eBay's deletion notification settings), optional EBAY_ENV=sandbox.
 * Deploy with --no-verify-jwt (eBay calls it without a Supabase token).
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { XMLParser } from 'npm:fast-xml-parser@4.5.0';
import { db, loadSettings } from '../_shared/cards.ts';
import { money, notifyLedger } from '../_shared/push.ts';

const SANDBOX = Deno.env.get('EBAY_ENV') === 'sandbox';
const API = SANDBOX ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const AUTH = SANDBOX ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
const ITEM_URL = SANDBOX ? 'https://sandbox.ebay.com/itm/' : 'https://www.ebay.com/itm/';
const CLIENT_ID = Deno.env.get('EBAY_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('EBAY_CLIENT_SECRET') ?? '';
const RUNAME = Deno.env.get('EBAY_RUNAME') ?? '';
const VERIFY_TOKEN = Deno.env.get('EBAY_VERIFICATION_TOKEN') ?? '';
const ENDPOINT = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ebay`;
const LEDGER_URL = 'https://partner-ledger-rosy.vercel.app';
const PHOTO_BASE = `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/shop-photos/`;
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');
const MARKETPLACE = 'EBAY_US';
const CATEGORY_SINGLES = '183454'; // Collectible Card Games > CCG Individual Cards
// Ungraded card condition (condition descriptor 40001). CCG singles (183454) take the "played" ids;
// 400011-400013 are only valid in the sports/non-sport card categories.
const CONDITION: Record<string, { id: string; label: string }> = {
  nm: { id: '400010', label: 'Near Mint or Better' },
  ex: { id: '400015', label: 'Lightly Played (Excellent)' },
  vg: { id: '400016', label: 'Moderately Played (Very Good)' },
  poor: { id: '400017', label: 'Heavily Played (Poor)' },
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const configured = () => !!(CLIENT_ID && CLIENT_SECRET && RUNAME);

type Account = {
  ebay_user: string | null;
  refresh_token: string | null;
  refresh_expires_at: string | null;
  access_token: string | null;
  access_expires_at: string | null;
  oauth_state: string | null;
  envelope_policy_id: string | null;
  package_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  location_key: string | null;
  markup_percent: number;
  list_by_default: boolean;
  default_condition: string;
  orders_checked_at: string | null;
  messages_checked_at: string | null;
  connected_at: string | null;
};

type Listing = {
  id: string;
  title: string;
  set_name: string | null;
  card_number: string | null;
  variant: string | null;
  category: string;
  shipping: string | null;
  price: number;
  quantity: number;
  description: string | null;
  photos: string[] | null;
  status: string;
  inventory_no: string | null;
  owner_id: string | null;
  ebay: boolean;
  ebay_condition: string | null;
  ebay_sku: string | null;
  ebay_offer_id: string | null;
  ebay_listing_id: string | null;
  ebay_state: string | null;
};

async function account(): Promise<Account> {
  const { data, error } = await db.from('ebay_account').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as Account;
}
const saveAccount = (fields: Partial<Account>) => db.from('ebay_account').update(fields).eq('id', 1);

// ---- OAuth ----

async function tokenCall(params: Record<string, string>) {
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`eBay sign-in failed: ${body.error_description ?? body.error ?? r.status}`);
  return body as { access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number };
}

const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();

async function accessToken(a?: Account): Promise<string> {
  a ??= await account();
  if (!a.refresh_token) throw new Error('eBay isn’t connected');
  if (a.access_token && a.access_expires_at && Date.parse(a.access_expires_at) > Date.now() + 120_000) return a.access_token;
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: a.refresh_token, scope: SCOPES });
  await saveAccount({ access_token: t.access_token, access_expires_at: later(t.expires_in) });
  a.access_token = t.access_token;
  return t.access_token;
}

/** Call the eBay REST API. Returns the parsed body (null for 204); throws with eBay's message. */
async function ebay(method: string, path: string, body?: unknown, ok: number[] = []): Promise<any> {
  const token = await accessToken();
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok && !ok.includes(r.status)) {
    const errs = (parsed?.errors ?? []) as { errorId?: number; message?: string; longMessage?: string }[];
    const msg = errs.map((e) => e.longMessage || e.message).filter(Boolean).join(' ') || `${r.status}`;
    const err = new Error(`eBay: ${msg}`) as Error & { status: number; ids: number[] };
    err.status = r.status;
    err.ids = errs.map((e) => e.errorId ?? 0);
    throw err;
  }
  return parsed;
}

// ---- Account setup: business policies and the ship-from location ----

type Policy = { id: string; name: string };

async function policies(): Promise<{ shipping: Policy[]; payment: Policy[]; returns: Policy[] }> {
  const get = async (kind: string, key: string, idKey: string) => {
    const r = await ebay('GET', `/sell/account/v1/${kind}?marketplace_id=${MARKETPLACE}`);
    return ((r?.[key] ?? []) as Record<string, string>[]).map((p) => ({ id: p[idKey], name: p.name }));
  };
  try {
    const [shipping, payment, returns] = await Promise.all([
      get('fulfillment_policy', 'fulfillmentPolicies', 'fulfillmentPolicyId'),
      get('payment_policy', 'paymentPolicies', 'paymentPolicyId'),
      get('return_policy', 'returnPolicies', 'returnPolicyId'),
    ]);
    return { shipping, payment, returns };
  } catch (err) {
    // Not opted in to business policies yet: opt in (eBay can take a little while to switch it on).
    if ((err as { ids?: number[] }).ids?.includes(20403)) {
      await ebay('POST', '/sell/account/v1/program/opt_in', { programType: 'SELLING_POLICY_MANAGEMENT' }, [409]).catch(() => null);
      return { shipping: [], payment: [], returns: [] };
    }
    throw err;
  }
}

/** Pick policies that aren't chosen yet: the only one, or one named like envelope / package. */
async function fillPolicies(a: Account) {
  const p = await policies();
  const named = (re: RegExp) => p.shipping.find((x) => re.test(x.name))?.id;
  const fields: Partial<Account> = {};
  if (!a.envelope_policy_id && p.shipping.length) fields.envelope_policy_id = named(/envelope|letter|card/i) ?? p.shipping[0].id;
  if (!a.package_policy_id && p.shipping.length) fields.package_policy_id = named(/package|box|ground|priority/i) ?? fields.envelope_policy_id ?? a.envelope_policy_id ?? p.shipping[0].id;
  if (!a.payment_policy_id && p.payment.length) fields.payment_policy_id = p.payment[0].id;
  if (!a.return_policy_id && p.returns.length) fields.return_policy_id = p.returns[0].id;
  if (Object.keys(fields).length) await saveAccount(fields);
  return p;
}

/** The ship-from location eBay needs on every offer, from the shop's return address. */
async function ensureLocation(a: Account): Promise<string> {
  if (a.location_key) return a.location_key;
  const s = await loadSettings();
  if (!s.from_zip || !s.from_city || !s.from_state) throw new Error('Add the return address in Shop settings first (eBay needs a ship-from city, state and ZIP)');
  const key = 'dabirddy';
  await ebay('POST', `/sell/inventory/v1/location/${key}`, {
    location: { address: { city: s.from_city, stateOrProvince: s.from_state, postalCode: s.from_zip, country: 'US' } },
    locationTypes: ['WAREHOUSE'],
    name: 'DaBirddy',
    merchantLocationStatus: 'ENABLED',
  }, [409]);
  await saveAccount({ location_key: key });
  a.location_key = key;
  return key;
}

// ---- Listing a card ----

const skuFor = (l: Listing) => l.ebay_sku ?? (l.inventory_no || l.id.slice(0, 8)).toUpperCase();

function ebayTitle(l: Listing): string {
  const num = l.card_number ? (/^[0-9]/.test(l.card_number) ? `#${l.card_number}` : l.card_number) : null;
  const full = [l.title, num, l.set_name, l.variant, 'Pokemon Card'].filter(Boolean).join(' ');
  if (full.length <= 80) return full;
  const short = [l.title, num, l.set_name, l.variant].filter(Boolean).join(' ');
  return short.length <= 80 ? short : short.slice(0, 80);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function ebayDescription(l: Listing): string {
  const rows = [['Card', l.title], ['Set', l.set_name], ['Number', l.card_number], ['Printing', l.variant], ['Condition', CONDITION[l.ebay_condition ?? '']?.label]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<li><b>${k}:</b> ${esc(v!)}</li>`)
    .join('');
  const extra = l.description ? `<p>${esc(l.description).replace(/\n/g, '<br>')}</p>` : '';
  return `<h2>${esc(l.title)}</h2><ul>${rows}</ul>${extra}<p>Photos are of the actual card you will receive.</p>`;
}

/** Envelope or package: the listing's own choice, else the shop's rule for a single item. */
async function shipsIn(l: Listing): Promise<'envelope' | 'package'> {
  if (l.shipping === 'envelope' || l.shipping === 'package') return l.shipping;
  if (l.category === 'sealed') return 'package';
  const s = await loadSettings();
  return Math.round(l.price * 100) < s.envelope_under_cents ? 'envelope' : 'package';
}

/** Why this listing can't go on eBay yet, or null. */
function blocker(l: Listing, a: Account): string | null {
  if (l.category !== 'single') return 'Only single (ungraded) cards can go on eBay for now';
  if (!l.ebay_condition || !CONDITION[l.ebay_condition]) return 'Pick the card’s condition for eBay';
  if (!photosOf(l).length) return 'Add a photo';
  if (!a.envelope_policy_id || !a.package_policy_id || !a.payment_policy_id || !a.return_policy_id) return 'Pick the eBay shipping, payment and return policies in Shop settings';
  return null;
}

const photosOf = (l: Listing) => (l.photos ?? []).filter((p) => /\.jpe?g$/i.test(p) && !/_(m|p|t)\.jpg$/i.test(p)).slice(0, 24).map((p) => PHOTO_BASE + p);
// The DaBirddy banner (logo, site, socials) goes last on every eBay listing. It's served from
// dabirddy.com; bump the ?v= when the image changes so eBay fetches the new one.
const EBAY_BANNER = 'https://dabirddy.com/ebay-banner.jpg?v=1';
const ebayImages = (l: Listing) => [...photosOf(l).slice(0, 23), EBAY_BANNER];

type Offer = { offerId: string; status: string; listing?: { listingId?: string } };

async function findOffer(sku: string): Promise<Offer | null> {
  const r = await ebay('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE}`, undefined, [404]);
  return (r?.offers ?? [])[0] ?? null;
}

async function endOffer(offerId: string) {
  // Already ended or never published: nothing to do.
  await ebay('POST', `/sell/inventory/v1/offer/${offerId}/withdraw`, {}, [400, 404, 409]);
}

/** Bring one listing's eBay side in line with the shop. Never throws: errors are saved on the listing. */
async function syncListing(id: string, a?: Account): Promise<{ ok: boolean; state: string | null; error?: string }> {
  const { data } = await db.from('shop_listings').select('*').eq('id', id).maybeSingle();
  const l = data as Listing | null;
  if (!l) return { ok: false, state: null, error: 'No such listing' };
  // Claim this round of changes; a change made while we work sets the flag again.
  await db.from('shop_listings').update({ ebay_dirty: false }).eq('id', id);
  try {
    a ??= await account();
    if (!a.refresh_token) throw new Error('eBay isn’t connected yet (Shop settings → eBay)');
    const sku = skuFor(l);
    const wanted = l.ebay && l.status === 'live' && l.quantity > 0;

    if (!wanted) {
      const offerId = l.ebay_offer_id ?? (l.ebay_sku ? (await findOffer(sku))?.offerId : null);
      if (offerId && l.ebay_state === 'listed') await endOffer(offerId);
      await db.from('shop_listings').update({
        ebay_state: offerId ? 'ended' : null, ebay_error: null, ebay_synced_at: new Date().toISOString(), ebay_offer_id: offerId ?? null,
      }).eq('id', id);
      return { ok: true, state: offerId ? 'ended' : null };
    }

    const why = blocker(l, a);
    if (why) throw new Error(why);
    const location = await ensureLocation(a);
    const cond = CONDITION[l.ebay_condition!];

    const aspects: Record<string, string[]> = {
      Game: ['Pokémon TCG'],
      'Card Name': [l.title.slice(0, 65)],
      Graded: ['No'],
      Language: [/japanese/i.test(`${l.set_name} ${l.variant} ${l.title}`) ? 'Japanese' : 'English'],
      Manufacturer: ['The Pokémon Company'],
    };
    if (l.set_name) aspects.Set = [l.set_name.slice(0, 65)];
    if (l.card_number) aspects['Card Number'] = [l.card_number.slice(0, 65)];

    await ebay('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      availability: { shipToLocationAvailability: { quantity: l.quantity } },
      condition: 'USED_VERY_GOOD', // eBay's code for "Ungraded" in trading card categories
      conditionDescriptors: [{ name: '40001', values: [cond.id] }],
      product: { title: ebayTitle(l), description: ebayDescription(l), aspects, imageUrls: ebayImages(l) },
    });

    const price = Math.round(l.price * (100 + Number(a.markup_percent || 0))) / 100;
    const offer = {
      sku,
      marketplaceId: MARKETPLACE,
      format: 'FIXED_PRICE',
      availableQuantity: l.quantity,
      categoryId: CATEGORY_SINGLES,
      listingDescription: ebayDescription(l),
      listingDuration: 'GTC',
      merchantLocationKey: location,
      pricingSummary: { price: { value: price.toFixed(2), currency: 'USD' } },
      listingPolicies: {
        fulfillmentPolicyId: (await shipsIn(l)) === 'envelope' ? a.envelope_policy_id : a.package_policy_id,
        paymentPolicyId: a.payment_policy_id,
        returnPolicyId: a.return_policy_id,
        bestOfferTerms: await bestOfferTerms(price),
      },
    };

    // The saved offer (null if it was deleted on eBay), else one already made for this SKU.
    let found: Offer | null = l.ebay_offer_id ? await ebay('GET', `/sell/inventory/v1/offer/${l.ebay_offer_id}`, undefined, [404]) : null;
    if (!found?.offerId) found = await findOffer(sku);
    if (found) {
      // On a published offer this also updates the live eBay listing.
      await ebay('PUT', `/sell/inventory/v1/offer/${found.offerId}`, offer);
    } else {
      try {
        found = { offerId: (await ebay('POST', '/sell/inventory/v1/offer', offer)).offerId, status: 'UNPUBLISHED' };
      } catch (err) {
        // Made by another run a moment ago.
        found = await findOffer(sku);
        if (!found) throw err;
      }
    }
    const offerId = found!.offerId;
    await db.from('shop_listings').update({ ebay_sku: sku, ebay_offer_id: offerId }).eq('id', id);

    // New, or ended earlier (withdrawn): put it up. An ended one comes back as a new eBay listing.
    let listingId = found!.listing?.listingId ?? l.ebay_listing_id;
    if (found!.status !== 'PUBLISHED') listingId = (await ebay('POST', `/sell/inventory/v1/offer/${offerId}/publish`, {}))?.listingId ?? listingId;
    await db.from('shop_listings').update({
      ebay_listing_id: listingId, ebay_state: 'listed', ebay_error: null, ebay_synced_at: new Date().toISOString(),
    }).eq('id', id);
    return { ok: true, state: 'listed' };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error('ebay sync', id, msg);
    // Not connected yet, or eBay was down: leave it dirty for the next tick. Anything eBay
    // refused (or a missing condition/photo) waits for the listing to be edited.
    const status = (err as { status?: number }).status;
    const retry = status == null ? !/condition|single|photo/i.test(msg) : status >= 500 || status === 429;
    await db.from('shop_listings').update({ ebay_state: 'error', ebay_error: msg, ebay_dirty: retry }).eq('id', id);
    return { ok: false, state: 'error', error: msg };
  }
}

// ---- eBay orders → shop and ledger ----

type EbayOrder = {
  orderId: string;
  creationDate: string;
  buyer?: { username?: string };
  cancelStatus?: { cancelState?: string };
  pricingSummary?: { total?: { value: string } };
  totalMarketplaceFee?: { value: string };
  lineItems: { sku?: string; title: string; quantity: number; lineItemCost?: { value: string } }[];
};

const cents = (v?: { value: string }) => (v ? Math.round(Number(v.value) * 100) : 0);

async function pullOrders(a: Account) {
  const since = new Date(Math.min(Date.now() - 3600_000, a.orders_checked_at ? Date.parse(a.orders_checked_at) - 3600_000 : Date.now() - 2 * 86400_000));
  const started = new Date().toISOString();
  const r = await ebay('GET', `/sell/fulfillment/v1/order?limit=100&filter=${encodeURIComponent(`creationdate:[${since.toISOString()}..]`)}`);
  const orders = (r?.orders ?? []) as EbayOrder[];
  if (orders.length) {
    const { data: seen } = await db.from('ebay_orders').select('order_id').in('order_id', orders.map((o) => o.orderId));
    const done = new Set((seen ?? []).map((s) => s.order_id));
    for (const o of orders) if (!done.has(o.orderId) && o.cancelStatus?.cancelState !== 'CANCELED') await takeOrder(o);
  }
  await saveAccount({ orders_checked_at: started });
}

async function takeOrder(o: EbayOrder) {
  // Claim the order first so two runs can't both take it.
  const total = cents(o.pricingSummary?.total), fee = cents(o.totalMarketplaceFee);
  const { error: ce } = await db.from('ebay_orders').insert({
    order_id: o.orderId, ordered_at: o.creationDate, buyer: o.buyer?.username ?? null, total_cents: total, fee_cents: fee, items: o.lineItems,
  });
  if (ce) return; // already taken

  type Taken = { id: string; title: string; owner_id: string | null; photo: string | null; quantity: number; line: number; qty: number };
  const taken: Taken[] = [];
  for (const li of o.lineItems) {
    if (!li.sku) continue;
    const { data } = await db.rpc('ebay_take_stock', { p_sku: li.sku, p_qty: li.quantity });
    const row = (data ?? [])[0];
    if (row) taken.push({ ...row, line: cents(li.lineItemCost), qty: li.quantity });
  }
  if (!taken.length) return; // not one of ours (listed on eBay by hand)

  const names = taken.map((t) => (t.qty > 1 ? `${t.qty}× ${t.title}` : t.title)).join(', ');
  notifyLedger('orders', { title: 'Sold on eBay', body: `${names} · ${money(total)}`, tag: `ebay-${o.orderId}` });

  // Ledger: one sale line per owner, net of eBay's fee, for the payout partner (whose eBay account is paid).
  const s = await loadSettings().catch(() => null);
  if (!s?.payout_partner_id || !total) return;
  const groups = new Map<string, Taken[]>();
  for (const t of taken) groups.set(t.owner_id ?? 'shared', [...(groups.get(t.owner_id ?? 'shared') ?? []), t]);
  const sub = taken.reduce((n, t) => n + t.line, 0) || 1;
  let leftTotal = total, leftFee = fee, firstId: string | null = null;
  const keys = [...groups.keys()];
  for (const [i, key] of keys.entries()) {
    const items = groups.get(key)!;
    const part = items.reduce((n, t) => n + t.line, 0);
    const last = i === keys.length - 1;
    const t = last ? leftTotal : Math.round((total * part) / sub);
    const f = last ? leftFee : Math.round((fee * part) / sub);
    leftTotal -= t;
    leftFee -= f;
    const net = (t - f) / 100;
    if (!net) continue;
    const id = crypto.randomUUID();
    const desc = `eBay ${o.orderId}: ${items.map((x) => (x.qty > 1 ? `${x.qty}× ${x.title}` : x.title)).join(', ')}`;
    const { error } = await db.from('entries').insert({
      id,
      occurred_on: today(),
      kind: 'sell',
      partner_id: s.payout_partner_id,
      amount: net,
      owner_id: key === 'shared' ? null : key,
      fee: f / 100,
      platform: 'eBay',
      description: desc.length > 200 ? desc.slice(0, 197) + '…' : desc,
      note: `eBay order ${o.orderId}${o.buyer?.username ? ` · ${o.buyer.username}` : ''} · $${(t / 100).toFixed(2)} incl. shipping · eBay fee $${(f / 100).toFixed(2)}`,
      source: 'import',
      photos: items.map((x) => x.photo).filter(Boolean),
      payments: [{ method: 'payout', amount: net }],
      created_by: s.payout_partner_id,
    });
    if (error) console.error('ebay ledger entry', o.orderId, error.message);
    else firstId ??= id;
  }
  if (firstId) await db.from('ebay_orders').update({ ledger_entry_id: firstId }).eq('order_id', o.orderId);
}

// ---- Best Offers and buyer messages (eBay's Trading API, which takes the same OAuth token) ----

/** Best Offer follows the site's offer settings: on or off, and offers under the minimum are declined by eBay. */
async function bestOfferTerms(price: number) {
  const s = (await loadSettings().catch(() => null)) as { offers_enabled?: boolean; offer_min_percent?: number } | null;
  if (!s?.offers_enabled) return { bestOfferEnabled: false };
  const floor = Math.floor(price * (s.offer_min_percent ?? 50)) / 100;
  return floor > 0 && floor < price
    ? { bestOfferEnabled: true, autoDeclinePrice: { value: floor.toFixed(2), currency: 'USD' } }
    : { bestOfferEnabled: true };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // ids are longer than a JS number
  isArray: (name) => ['ItemBestOffers', 'BestOffer', 'MemberMessageExchange', 'Errors'].includes(name),
});
const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v));

/** One Trading API call. Returns the parsed <CallResponse>; throws with eBay's message when it fails. */
async function trading(call: string, inner: string): Promise<any> {
  const r = await fetch(`${API}/ws/api.dll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': call,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1271',
      'X-EBAY-API-IAF-TOKEN': await accessToken(),
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${call}Request>`,
  });
  const out = xml.parse(await r.text())?.[`${call}Response`];
  if (!out) throw Object.assign(new Error(`eBay: ${call} failed (${r.status})`), { status: r.status });
  if (out.Ack === 'Failure' || out.Ack === 'PartialFailure') {
    const errs = (out.Errors ?? []) as { LongMessage?: string; ShortMessage?: string; SeverityCode?: string }[];
    const msg = errs.filter((e) => e.SeverityCode !== 'Warning').map((e) => e.LongMessage || e.ShortMessage).join(' ');
    throw Object.assign(new Error(`eBay: ${msg || call + ' failed'}`), { status: 400 });
  }
  return out;
}

/** Shop listing (and its eBay price) by eBay item number. */
async function listingsByItem(itemIds: string[]) {
  const m = new Map<string, { id: string; title: string; price: number }>();
  if (!itemIds.length) return m;
  const { data } = await db.from('shop_listings').select('id, title, price, ebay_listing_id').in('ebay_listing_id', itemIds);
  for (const l of data ?? []) m.set(l.ebay_listing_id, l);
  return m;
}

/** Open Best Offers into shop_offers (source 'ebay'), and close the ones eBay no longer has open. */
async function pullOffers(a: Account) {
  const r = await trading('GetBestOffers', '<BestOfferStatus>Active</BestOfferStatus><DetailLevel>ReturnAll</DetailLevel>');
  const items = (r.ItemBestOffersArray?.ItemBestOffers ?? []) as any[];
  const byItem = await listingsByItem(items.map((i) => text(i.Item?.ItemID)).filter(Boolean));
  const markup = 1 + Number(a.markup_percent || 0) / 100;
  const active: string[] = [];
  let added = 0;
  for (const it of items) {
    const itemId = text(it.Item?.ItemID);
    const l = byItem.get(itemId);
    for (const o of (it.BestOfferArray?.BestOffer ?? []) as any[]) {
      const offerId = text(o.BestOfferID);
      if (!offerId) continue;
      active.push(offerId);
      if (!l) continue; // listed on eBay by hand, not from the shop
      const amount = Math.round(Number(text(o.Price)) * 100);
      const { data: row, error } = await db.from('shop_offers').insert({
        source: 'ebay',
        ebay_offer_id: offerId,
        ebay_item_id: itemId,
        listing_id: l.id,
        amount_cents: amount,
        list_cents: Math.round(l.price * markup * 100),
        buyer_name: text(o.Buyer?.UserID) || 'eBay buyer',
        note: text(o.BuyerMessage) || null,
        created_at: o.CreatedTime ? text(o.CreatedTime) : undefined,
      }).select('id').maybeSingle();
      if (error || !row) continue; // already have it
      added++;
      notifyLedger('ebay', {
        title: text(o.BestOfferCodeType) === 'BuyerCounterOffer' ? 'eBay counter offer' : 'New eBay offer',
        body: `${money(amount)} on ${l.title} from ${text(o.Buyer?.UserID) || 'a buyer'}`,
        tag: `ebay-offer-${offerId}`,
      });
    }
  }
  // Still "new" here but gone from eBay: the buyer withdrew it, it expired, or it was answered on eBay.
  let q = db.from('shop_offers').update({ status: 'withdrawn' }).eq('source', 'ebay').eq('status', 'pending');
  if (active.length) q = q.not('ebay_offer_id', 'in', `(${active.join(',')})`);
  await q;
  return added;
}

/** Answer an eBay offer the way it was answered in the ledger. On failure it goes back to new, with the reason. */
async function respondOffer(id: string) {
  const { data: o } = await db.from('shop_offers').select('*').eq('id', id).maybeSingle();
  if (!o || o.source !== 'ebay' || !['accepted', 'countered', 'declined'].includes(o.status)) return { ok: false, error: 'Nothing to send' };
  const action = o.status === 'accepted' ? 'Accept' : o.status === 'declined' ? 'Decline' : 'Counter';
  const counter = action === 'Counter'
    ? `<CounterOfferPrice currencyID="USD">${(o.counter_cents / 100).toFixed(2)}</CounterOfferPrice><CounterOfferQuantity>1</CounterOfferQuantity>`
    : '';
  try {
    await trading('RespondToBestOffer', `<ItemID>${esc(o.ebay_item_id)}</ItemID><BestOfferID>${esc(o.ebay_offer_id)}</BestOfferID><Action>${action}</Action>${counter}`);
    await db.from('shop_offers').update({ ebay_error: null }).eq('id', id);
    return { ok: true };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error('ebay offer', id, msg);
    await db.from('shop_offers').update({ status: 'pending', counter_cents: null, responded_at: null, expires_at: null, ebay_error: msg }).eq('id', id);
    return { ok: false, error: msg };
  }
}

/** Buyer messages (questions about items, and messages after a sale) into ebay_messages. */
async function pullMessages(a: Account) {
  const end = new Date();
  const start = new Date(Math.min(end.getTime() - 3600_000, a.messages_checked_at ? Date.parse(a.messages_checked_at) - 3600_000 : end.getTime() - 7 * 86400_000));
  const r = await trading(
    'GetMemberMessages',
    `<MailMessageType>All</MailMessageType><StartCreationTime>${start.toISOString()}</StartCreationTime><EndCreationTime>${end.toISOString()}</EndCreationTime><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>`,
  );
  const ex = (r.MemberMessage?.MemberMessageExchange ?? []) as any[];
  const byItem = await listingsByItem(ex.map((e) => text(e.Item?.ItemID)).filter(Boolean));
  let added = 0;
  for (const e of ex) {
    const q = e.Question ?? {};
    const id = text(q.MessageID);
    const sender = text(q.SenderID);
    if (!id || !sender || sender === a.ebay_user) continue;
    const itemId = text(e.Item?.ItemID) || null;
    const l = itemId ? byItem.get(itemId) : undefined;
    const { data: row, error } = await db.from('ebay_messages').insert({
      id,
      item_id: itemId,
      listing_id: l?.id ?? null,
      item_title: l?.title ?? (text(e.Item?.Title) || null),
      sender,
      subject: text(q.Subject) || null,
      body: text(q.Body),
      received_at: text(e.CreationDate) || new Date().toISOString(),
      replied_at: text(e.MessageStatus) === 'Answered' ? new Date().toISOString() : null,
    }).select('id').maybeSingle();
    if (error || !row || text(e.MessageStatus) === 'Answered') continue;
    added++;
    const body = text(q.Body);
    notifyLedger('ebay', {
      title: `eBay message from ${sender}`,
      body: (l ? `${l.title}: ` : '') + (body.length > 140 ? body.slice(0, 137) + '…' : body),
      tag: `ebay-msg-${id}`,
    });
  }
  await saveAccount({ messages_checked_at: end.toISOString() });
  return added;
}

/** Send the reply written in the ledger. On failure the reply is cleared and the reason kept. */
async function replyMessage(id: string) {
  const { data: m } = await db.from('ebay_messages').select('*').eq('id', id).maybeSingle();
  if (!m?.reply || m.replied_at) return { ok: false, error: 'Nothing to send' };
  try {
    await trading(
      'AddMemberMessageRTQ',
      (m.item_id ? `<ItemID>${esc(m.item_id)}</ItemID>` : '') +
        `<MemberMessage><Body>${esc(m.reply.slice(0, 2000))}</Body><DisplayToPublic>false</DisplayToPublic><EmailCopyToSender>true</EmailCopyToSender>` +
        `<ParentMessageID>${esc(m.id)}</ParentMessageID><RecipientID>${esc(m.sender)}</RecipientID></MemberMessage>`,
    );
    await db.from('ebay_messages').update({ replied_at: new Date().toISOString(), reply_error: null }).eq('id', id);
    return { ok: true };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error('ebay reply', id, msg);
    await db.from('ebay_messages').update({ reply: null, reply_error: msg }).eq('id', id);
    return { ok: false, error: msg };
  }
}

async function tick() {
  if (!configured()) return { skipped: 'not configured' };
  const a = await account();
  if (!a.refresh_token) return { skipped: 'not connected' };
  const out: Record<string, unknown> = {};
  try {
    await pullOrders(a);
  } catch (err) {
    console.error('ebay orders', err);
    out.orders_error = String(err);
  }
  try {
    out.offers = await pullOffers(a);
  } catch (err) {
    console.error('ebay offers', err);
    out.offers_error = String(err);
  }
  try {
    out.messages = await pullMessages(a);
  } catch (err) {
    console.error('ebay messages', err);
    out.messages_error = String(err);
  }
  const { data: dirty } = await db.from('shop_listings').select('id').eq('ebay_dirty', true).order('updated_at').limit(40);
  let synced = 0;
  for (const d of dirty ?? []) if ((await syncListing(d.id, a)).ok) synced++;
  return { ...out, dirty: dirty?.length ?? 0, synced };
}

// ---- Ledger (signed-in partner) ----

async function status() {
  if (!configured()) return { configured: false, connected: false };
  const a = await account();
  const base = {
    configured: true,
    sandbox: SANDBOX,
    connected: !!a.refresh_token,
    ebay_user: a.ebay_user,
    connected_at: a.connected_at,
    envelope_policy_id: a.envelope_policy_id,
    package_policy_id: a.package_policy_id,
    payment_policy_id: a.payment_policy_id,
    return_policy_id: a.return_policy_id,
    markup_percent: Number(a.markup_percent),
    list_by_default: a.list_by_default,
    default_condition: a.default_condition,
    orders_checked_at: a.orders_checked_at,
    item_url: ITEM_URL,
  };
  if (!a.refresh_token) return base;
  try {
    return { ...base, policies: await fillPolicies(a) };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function partnerAction(req: Request, b: Record<string, unknown>) {
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user?.email) return json({ error: 'Sign in first' }, 401);
  const { data: me } = await db.from('partners').select('id').ilike('email', user.email).maybeSingle();
  if (!me) return json({ error: 'Not a partner' }, 403);

  if (b.action === 'status') return json(await status());
  if (!configured()) return json({ error: 'eBay keys aren’t set up yet' }, 400);

  if (b.action === 'connect') {
    const state = crypto.randomUUID();
    await saveAccount({ oauth_state: state });
    const url = `${AUTH}/oauth2/authorize?` + new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: RUNAME, response_type: 'code', scope: SCOPES, state, prompt: 'login' });
    return json({ url });
  }

  if (b.action === 'disconnect') {
    await saveAccount({ refresh_token: null, refresh_expires_at: null, access_token: null, access_expires_at: null, ebay_user: null, connected_at: null });
    return json({ ok: true });
  }

  if (b.action === 'settings') {
    const fields: Partial<Account> = {};
    for (const k of ['envelope_policy_id', 'package_policy_id', 'payment_policy_id', 'return_policy_id'] as const) {
      if (typeof b[k] === 'string' && b[k]) fields[k] = (b[k] as string).slice(0, 40);
    }
    if (b.markup_percent != null) {
      const m = Number(b.markup_percent);
      if (!(m >= 0 && m <= 100)) return json({ error: 'Markup must be 0 to 100%' }, 400);
      fields.markup_percent = Math.round(m * 100) / 100;
    }
    if (typeof b.list_by_default === 'boolean') fields.list_by_default = b.list_by_default;
    if (typeof b.default_condition === 'string' && CONDITION[b.default_condition]) fields.default_condition = b.default_condition;
    const { error } = await saveAccount(fields);
    if (error) return json({ error: error.message }, 500);
    // Price or policy changes reach every eBay listing.
    if (fields.markup_percent != null || fields.envelope_policy_id || fields.package_policy_id || fields.payment_policy_id || fields.return_policy_id) {
      await db.from('shop_listings').update({ ebay_dirty: true }).eq('ebay', true).eq('status', 'live');
    }
    return json({ ok: true });
  }

  if (b.action === 'list_all') {
    // Every live single on the site that isn't on eBay yet; the trigger sends each one up.
    const a = await account();
    const { data: rows } = await db.from('shop_listings').select('id, ebay_condition')
      .eq('status', 'live').eq('category', 'single').gt('quantity', 0).eq('ebay', false);
    for (const r of rows ?? []) {
      await db.from('shop_listings').update({ ebay: true, ebay_condition: r.ebay_condition ?? a.default_condition }).eq('id', r.id);
    }
    return json({ ok: true, count: rows?.length ?? 0 });
  }

  if (b.action === 'sync' && typeof b.id === 'string') return json(await syncListing(b.id));
  return json({ error: 'Unknown action' }, 400);
}

// ---- eBay callbacks ----

async function oauthCallback(url: URL) {
  const back = (q: string) => Response.redirect(`${LEDGER_URL}/?tab=shop&ebay=${q}`, 302);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  const a = await account();
  if (!code || !state || state !== a.oauth_state) return back('failed');
  try {
    const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: RUNAME });
    await saveAccount({
      oauth_state: null,
      access_token: t.access_token,
      access_expires_at: later(t.expires_in),
      refresh_token: t.refresh_token ?? null,
      refresh_expires_at: t.refresh_token_expires_in ? later(t.refresh_token_expires_in) : null,
      connected_at: new Date().toISOString(),
    });
    const fresh = await account();
    const who = await fetch(`${SANDBOX ? 'https://apiz.sandbox.ebay.com' : 'https://apiz.ebay.com'}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (who?.username) await saveAccount({ ebay_user: who.username });
    await fillPolicies(fresh).catch((err) => console.error('ebay policies', err));
    await ensureLocation(fresh).catch((err) => console.error('ebay location', err));
    // Anything turned on before eBay was connected goes up on the next tick.
    return back('connected');
  } catch (err) {
    console.error('ebay oauth', err);
    return back('failed');
  }
}

async function deletionChallenge(code: string) {
  const bytes = new TextEncoder().encode(code + VERIFY_TOKEN + ENDPOINT);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
  return json({ challengeResponse: hash });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const challenge = url.searchParams.get('challenge_code');
    if (challenge) return deletionChallenge(challenge);
    if (url.searchParams.has('code') || url.searchParams.has('error')) return oauthCallback(url);
    // Declined on eBay's consent page.
    if (url.searchParams.has('state')) return Response.redirect(`${LEDGER_URL}/?tab=shop&ebay=declined`, 302);
    return json({ error: 'Not found' }, 404);
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const b = await req.json().catch(() => ({}));

  // Database trigger and cron.
  const hub = req.headers.get('x-hub-token');
  if (hub) {
    const { data: ok } = await db.rpc('shop_sync_token_ok', { p_token: hub });
    if (ok !== true) return json({ error: 'Forbidden' }, 403);
    if (!configured()) return json({ skipped: 'not configured' });
    if (b.action === 'sync' && typeof b.id === 'string') return json(await syncListing(b.id));
    if (b.action === 'tick') return json(await tick());
    if (b.action === 'offer_respond' && typeof b.id === 'string') return json(await respondOffer(b.id));
    if (b.action === 'message_reply' && typeof b.id === 'string') return json(await replyMessage(b.id));
    return json({ error: 'Unknown action' }, 400);
  }

  // eBay marketplace account deletion: we keep only buyer usernames on eBay orders.
  if (b?.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
    const username = b?.notification?.data?.username;
    if (username) {
      await db.from('ebay_orders').update({ buyer: null }).eq('buyer', username);
      await db.from('shop_offers').update({ buyer_name: 'eBay buyer', note: null }).eq('source', 'ebay').eq('buyer_name', username);
      await db.from('ebay_messages').delete().eq('sender', username);
    }
    return new Response(null, { status: 204 });
  }

  if (req.headers.get('Authorization')) return partnerAction(req, b);
  return json({ error: 'Forbidden' }, 403);
});

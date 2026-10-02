# DaBirddy Merch Shop — Setup

`dabirddy.com/shop` is a custom storefront. Printful makes and ships the products, Stripe takes the payment, and three Supabase edge functions connect them:

| Function | What it does |
|---|---|
| `shop-products` | Reads your Printful store's products and shows them on `/shop` (cached 5 min) |
| `shop-checkout` | Re-checks prices with Printful, then opens a Stripe Checkout page |
| `shop-stripe-webhook` | After payment, creates the Printful order using the customer's shipping address |

Until step 5 is done, `/shop` shows a "Shop Opening Soon" page, so it's safe to push this before everything is set up.

## 1. Printful
1. Sign up at printful.com and add a billing card (Printful charges you its base cost + shipping for each order).
2. **Stores → Add store → "Manual order platform / API"**. Name it "DaBirddy".
3. Design your apparel and add it to that store. Set a **retail price** on each variant; that's the price customers pay.
4. Go to **developers.printful.com → Your tokens → Create token**. Pick the DaBirddy store and turn on at least the *orders* and *sync products* scopes. Copy the token.

## 2. Stripe
1. Sign up at stripe.com. Stay in **Test mode** for now.
2. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_...`).

## 3. Deploy the functions
From this repo folder (run `supabase init` first if the CLI asks for it):

```bash
supabase functions deploy shop-products shop-checkout shop-stripe-webhook --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF PRINTFUL_API_TOKEN=... STRIPE_SECRET_KEY=sk_test_... SHOP_SHIPPING_CENTS=599
```

Optional secrets:
- `SHOP_FREE_SHIPPING_OVER_CENTS=7500`: free shipping on orders of $75 or more
- `SHOP_SHIP_COUNTRIES=US,CA`: where you ship (default is US only)
- `PRINTFUL_STORE_ID`: only needed if your token covers more than one store
- `PRINTFUL_AUTO_CONFIRM=true`: see step 7

## 4. Stripe webhook
1. Go to **Stripe → Developers → Webhooks → Add endpoint**.
2. URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/shop-stripe-webhook`
3. Event: `checkout.session.completed`
4. Copy the signing secret, then run:

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF STRIPE_WEBHOOK_SECRET=whsec_...
```

## 5. Point the page at your functions
In `shop/index.html`, change this line:
```js
var SHOP_API = 'https://YOUR_PROJECT_REF.supabase.co/functions/v1';
```

## 6. Test an order
1. Go to `/shop`, add an item, and check out with card `4242 4242 4242 4242`, any future date and any CVC.
2. You should land on the "Order Placed" page, and a **draft** order should appear in Printful → Orders.
3. If no order appears, look at the `shop-stripe-webhook` logs in the Supabase dashboard. Stripe retries failed webhooks automatically for 3 days.

## 7. Go live
1. Swap in your live Stripe secret key (`sk_live_...`) and make a live webhook endpoint (repeat step 4 in Live mode).
2. Orders arrive in Printful as **drafts**. Confirm each one in Printful to start production. When you trust the flow, set `PRINTFUL_AUTO_CONFIRM=true` and orders will go to production automatically.

## Notes
- **Shipping** is a flat rate you choose; Printful bills you the actual shipping cost. Set the rate a bit above Printful's typical rate for your products.
- **Sales tax** is not collected right now. If you need to collect it, turn on Stripe Tax and add `automatic_tax: { enabled: true }` in `shop-checkout`.
- **Adding or changing products** happens in Printful only. The shop updates within about 5 minutes.

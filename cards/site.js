// Shared by every dabirddy.com/cards page: the footer (links, email signup, trust line),
// the browser id, and anonymous page analytics. Pages put <footer id="siteFooter"></footer>
// where the footer goes and load this file with <script src="site.js" defer>.
(function () {
  var API = 'https://fbxrizapfpjyvhxwyweb.supabase.co/functions/v1/shop-public';
  var WHATNOT_SALES = '3,800+';

  // The random id the site already keeps for the cart doubles as the browser id.
  function vid() {
    try {
      var id = localStorage.getItem('dabirddy_cart_id');
      if (!id && window.crypto && crypto.randomUUID) { id = crypto.randomUUID(); localStorage.setItem('dabirddy_cart_id', id); }
      return id;
    } catch (e) { return null; }
  }

  // Anonymous stats: page views, card views, adds, checkouts. Nothing that identifies anyone,
  // and nothing at all when the browser asks not to be tracked.
  var quiet = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  var utm = (function () {
    var p = new URLSearchParams(location.search), u = {};
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
      var v = p.get(k);
      try { if (v) sessionStorage.setItem(k, v); else v = sessionStorage.getItem(k); } catch (e) {}
      if (v) u[k] = v;
    });
    return u;
  })();
  var ref = (function () {
    var r = document.referrer;
    try { if (r) sessionStorage.setItem('dabirddy_ref', r); else r = sessionStorage.getItem('dabirddy_ref') || ''; } catch (e) {}
    return r;
  })();
  function track(type, listingId) {
    if (quiet) return;
    var id = vid(); if (!id) return;
    var body = { action: 'event', vid: id, type: type, path: location.pathname.slice(0, 200), ref: ref || undefined, listing_id: listingId || undefined };
    for (var k in utm) body[k] = utm[k];
    var data = JSON.stringify(body);
    try { if (navigator.sendBeacon && navigator.sendBeacon(API, data)) return; } catch (e) {}
    fetch(API, { method: 'POST', body: data, keepalive: true }).catch(function () {});
  }

  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }, function () { return { ok: false, d: {} }; }); });
  }
  function subscribe(email, source) {
    return post({ action: 'subscribe', email: email, vid: vid() || undefined, source: source || 'footer' });
  }

  var reviewsP = null;
  function reviews() {
    if (!reviewsP) reviewsP = fetch(API + '?reviews').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return reviewsP;
  }
  function stars(n) {
    var s = '';
    for (var i = 1; i <= 5; i++) s += i <= Math.floor(n + 0.25) ? '★' : '☆';
    return s;
  }

  var css =
    '.site-foot{max-width:1180px;margin:56px auto 0;padding:28px 16px calc(28px + env(safe-area-inset-bottom));border-top:1px solid rgba(255,255,255,0.07);color:#8d8b93;font-size:.88rem;line-height:1.6}' +
    '.site-foot .cols{display:grid;grid-template-columns:1.3fr 1fr;gap:28px}' +
    '@media(max-width:720px){.site-foot .cols{grid-template-columns:1fr}}' +
    '.site-foot h3{font-family:"Bebas Neue",sans-serif;letter-spacing:1.5px;font-size:1.35rem;color:#f0ede8;font-weight:400;margin-bottom:6px}' +
    '.site-foot form{display:flex;gap:8px;margin-top:10px}' +
    '.site-foot input{flex:1;min-width:0;font:inherit;font-size:16px;color:#f0ede8;background:#17171c;border:1px solid rgba(255,255,255,0.14);border-radius:12px;padding:0 14px;min-height:46px}' +
    '.site-foot button{font:inherit;font-weight:700;font-size:.9rem;color:#fff;background:linear-gradient(135deg,#ff4d6d,#e0284b);border:0;border-radius:12px;padding:0 18px;min-height:46px;cursor:pointer;white-space:nowrap}' +
    '.site-foot button:disabled{opacity:.6;cursor:default}' +
    '.site-foot .msg{font-size:.82rem;margin-top:8px;min-height:1.2em}' +
    '.site-foot .msg.ok{color:#4ade80}.site-foot .msg.bad{color:#ff8fa3}' +
    '.site-foot nav{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px}' +
    '.site-foot nav a{color:#cfccd4;text-decoration:none}.site-foot nav a:hover{color:#fff;text-decoration:underline}' +
    '.site-foot .trust{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:22px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.07);font-size:.8rem}' +
    '.site-foot .trust span{display:inline-flex;align-items:center;gap:6px}' +
    '.site-foot .trust a{color:#ffd166;text-decoration:none}' +
    '.site-foot .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}';

  function footer() {
    var el = document.getElementById('siteFooter');
    if (!el) return;
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    el.className = 'site-foot';
    el.innerHTML =
      '<div class="cols">' +
        '<div><h3>New drops &amp; flash sales</h3>' +
          '<div>Get an email when fresh cards go up, plus coupon codes and sale alerts. No spam; unsubscribe any time.</div>' +
          '<form id="footSignup" novalidate><input type="email" id="footEmail" placeholder="you@email.com" autocomplete="email" aria-label="Email address" required>' +
          '<input class="hp" name="website" id="footHp" tabindex="-1" autocomplete="off" aria-hidden="true">' +
          '<button type="submit" id="footBtn">Sign up</button></form>' +
          '<div class="msg" id="footMsg" role="status"></div></div>' +
        '<nav aria-label="Shop info">' +
          '<a href="./">Shop all cards</a><a href="reviews.html">Customer reviews</a>' +
          '<a href="order.html">Track your order</a><a href="policies.html#shipping">Shipping</a>' +
          '<a href="policies.html#returns">Returns &amp; refunds</a><a href="policies.html#privacy">Privacy</a>' +
          '<a href="policies.html#contact">Contact us</a><a href="../">About DaBirddy</a>' +
        '</nav>' +
      '</div>' +
      '<div class="trust">' +
        '<span>🔒 Secure checkout by Stripe · Apple Pay · Google Pay</span>' +
        '<span>📦 Every order ships with tracking</span>' +
        '<span>↩︎ 14-day returns</span>' +
        '<span>⭐ ' + WHATNOT_SALES + ' sales on <a href="https://www.whatnot.com/user/dabirddy" target="_blank" rel="noopener">Whatnot</a></span>' +
        '<span id="footReviews"></span>' +
      '</div>' +
      '<div style="margin-top:12px;font-size:.78rem">© ' + new Date().getFullYear() + ' DaBirddy · <a href="mailto:dabirddy@gmail.com" style="color:inherit">dabirddy@gmail.com</a></div>';

    reviews().then(function (r) {
      if (r && r.count) document.getElementById('footReviews').innerHTML = '<a href="reviews.html">' + stars(r.average) + ' ' + r.average.toFixed(1) + ' from ' + r.count + ' verified buyer' + (r.count === 1 ? '' : 's') + '</a>';
    });

    document.getElementById('footSignup').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('footEmail').value.trim(), msg = document.getElementById('footMsg'), btn = document.getElementById('footBtn');
      msg.className = 'msg';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { msg.className = 'msg bad'; msg.textContent = 'Enter your email address.'; return; }
      if (document.getElementById('footHp').value) return;
      btn.disabled = true; msg.textContent = 'Signing you up…';
      subscribe(email, 'footer').then(function (x) {
        btn.disabled = false;
        if (!x.ok) { msg.className = 'msg bad'; msg.textContent = x.d.error || 'Couldn’t sign you up. Please try again.'; return; }
        document.getElementById('footEmail').value = '';
        msg.className = 'msg ok';
        msg.textContent = x.d.already ? 'You’re already on the list. Thanks!' : 'You’re in! Check your inbox for a welcome email.';
      }, function () { btn.disabled = false; msg.className = 'msg bad'; msg.textContent = 'Couldn’t sign you up. Check your connection and try again.'; });
    });
  }

  window.DaBirddy = { api: API, vid: vid, track: track, post: post, subscribe: subscribe, reviews: reviews, stars: stars };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', footer); else footer();
})();

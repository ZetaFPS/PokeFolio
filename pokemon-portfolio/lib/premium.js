'use strict';
// PokéFolio Premium: unlimited cards (free accounts hold up to FREE_CARD_LIMIT).
//
// Payments go through Stripe Checkout, which shows Apple Pay on iPhone / Safari (and Google Pay,
// cards, Link elsewhere) — no card details ever touch this server. Configure on the host:
//   STRIPE_SECRET_KEY      sk_live_… (or sk_test_… while testing)
//   STRIPE_PRICE_ID        price_… — the Premium price made in the Stripe dashboard. A recurring
//                          price makes Premium a subscription; a one-time price makes it lifetime.
//   STRIPE_WEBHOOK_SECRET  whsec_… — from the webhook endpoint pointed at /api/premium/webhook
// Without the first two, everything else works and the upgrade button says Premium isn't on sale yet.

const crypto = require('crypto');
const { FREE_CARD_LIMIT, isPremium, premiumSource } = require('./auth');

const API = 'https://api.stripe.com/v1';
const LIFETIME = 253402300799000; // a one-time purchase: premium until the year 9999
const GRACE_MS = 3 * 864e5; // a renewal's payment can land a little after the period ends
const ACTIVE = new Set(['active', 'trialing', 'past_due']);

// Cards in a portfolio, counted the way the app's "Cards" figure counts them (quantities included).
const cardCount = (items) => (Array.isArray(items) ? items : []).reduce((n, it) => n + Math.max(1, Math.min(999, Math.floor(+it?.qty) || 1)), 0);

// Flatten { a: { b: [x] } } into Stripe's form encoding: a[b][0]=x
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

function createPremium({ store, httpError, send, readBody, requireUser, optionalUser, isHttps, live }) {
  const key = () => process.env.STRIPE_SECRET_KEY || '';
  const priceId = () => process.env.STRIPE_PRICE_ID || '';
  const enabled = () => !!(key() && priceId());

  async function stripe(method, path, params) {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
      body: params ? form(params).toString() : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`stripe ${method} ${path}: ${j.error?.message || r.status}`);
      throw httpError(502, 'The payment service didn’t answer — try again in a moment.');
    }
    return j;
  }

  // The Premium price (amount, currency, monthly/yearly or one-time), cached for 10 minutes.
  let priceCache = null;
  async function price() {
    if (!enabled()) return null;
    if (priceCache && priceCache.id === priceId() && Date.now() - priceCache.at < 10 * 60e3) return priceCache.value;
    try {
      const p = await stripe('GET', `/prices/${encodeURIComponent(priceId())}`);
      const value = { amount: p.unit_amount != null ? p.unit_amount / 100 : null, currency: (p.currency || 'usd').toUpperCase(), interval: p.recurring?.interval || null, intervalCount: p.recurring?.interval_count || 1 };
      priceCache = { id: priceId(), at: Date.now(), value };
      return value;
    } catch { return priceCache?.value || null; }
  }

  async function grant(userId, fields) {
    const u = await store.getUser(userId);
    if (!u) return null;
    const updated = await store.updateUser(userId, fields);
    live?.send(userId, 'account', {}); // the app refreshes the account (and lifts the limit) at once
    return updated;
  }

  const periodEnd = (sub) => (sub.current_period_end || sub.items?.data?.[0]?.current_period_end || 0) * 1000;
  async function applySubscription(sub, userId = null) {
    const uid = userId || sub.metadata?.userId;
    if (!uid) return;
    const until = ACTIVE.has(sub.status) ? periodEnd(sub) + GRACE_MS : Date.now();
    await grant(uid, { premiumUntil: until, stripeSub: sub.id, stripeCustomer: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null });
  }
  // A finished Checkout: a one-time payment (lifetime) or the first payment of a subscription.
  async function applySession(s) {
    const uid = s.client_reference_id;
    if (!uid || s.status !== 'complete') return false;
    const customer = typeof s.customer === 'string' ? s.customer : s.customer?.id || null;
    if (s.mode === 'payment') {
      if (s.payment_status !== 'paid') return false;
      await grant(uid, { premiumUntil: LIFETIME, ...(customer ? { stripeCustomer: customer } : {}) });
      return true;
    }
    if (s.mode === 'subscription' && s.subscription) {
      const sub = typeof s.subscription === 'string' ? await stripe('GET', `/subscriptions/${encodeURIComponent(s.subscription)}`) : s.subscription;
      await applySubscription(sub, uid);
      return true;
    }
    return false;
  }

  // Stripe signs each webhook: "t=…,v1=…" = HMAC-SHA256(secret, `${t}.${body}`).
  function verified(raw, header) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret || !header) return false;
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
    const t = +parts.t;
    if (!t || Math.abs(Date.now() / 1000 - t) > 600) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const sigs = String(header).split(',').filter((x) => x.trim().startsWith('v1=')).map((x) => x.trim().slice(3));
    return sigs.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  }
  function readRaw(req, max = 1e6) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > max) { reject(httpError(413, 'Too large.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const status = (u) => ({
    limit: FREE_CARD_LIMIT, premium: isPremium(u), source: premiumSource(u), until: u?.premiumUntil || null, canManage: !!u?.stripeCustomer,
  });

  return async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // GET /api/premium — the plan, its price, and this account's status
    if (pathname === '/api/premium' && method === 'GET') {
      const u = await optionalUser(req);
      send(res, 200, { enabled: enabled(), price: await price(), ...status(u) });
      return true;
    }

    // POST /api/premium/webhook — Stripe tells us about payments and subscription changes
    if (pathname === '/api/premium/webhook' && method === 'POST') {
      const raw = await readRaw(req);
      if (!verified(raw, req.headers['stripe-signature'])) throw httpError(400, 'Bad signature.');
      const event = JSON.parse(raw);
      const obj = event.data?.object || {};
      try {
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await applySession(obj);
        else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) await applySubscription(obj);
        else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
          const subId = obj.subscription || obj.parent?.subscription_details?.subscription;
          if (subId) await applySubscription(await stripe('GET', `/subscriptions/${encodeURIComponent(subId)}`));
        }
      } catch (e) {
        console.error('premium webhook:', e.message);
        throw httpError(500, 'Webhook failed.'); // Stripe retries
      }
      send(res, 200, { received: true });
      return true;
    }

    if (!pathname.startsWith('/api/premium/')) return false;
    const user = await requireUser(req);

    // POST /api/premium/checkout → { url } of Stripe's payment page (Apple Pay, cards…)
    if (pathname === '/api/premium/checkout' && method === 'POST') {
      if (!enabled()) throw httpError(503, 'Premium isn’t on sale yet — check back soon.');
      if (isPremium(user)) throw httpError(400, 'You already have Premium.');
      const p = await price();
      const subscription = !!p?.interval;
      const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
      const session = await stripe('POST', '/checkout/sessions', {
        mode: subscription ? 'subscription' : 'payment',
        line_items: [{ price: priceId(), quantity: 1 }],
        client_reference_id: user.id,
        ...(user.stripeCustomer ? { customer: user.stripeCustomer } : { customer_email: user.email }),
        ...(subscription ? { subscription_data: { metadata: { userId: user.id } } } : { customer_creation: 'always', payment_intent_data: { metadata: { userId: user.id } } }),
        metadata: { userId: user.id },
        allow_promotion_codes: 'true',
        success_url: `${origin}/?premium=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?premium=cancel`,
      });
      send(res, 200, { url: session.url });
      return true;
    }

    // POST /api/premium/confirm { sessionId } — back from Checkout: check the payment straight away
    // (the webhook does the same, but this doesn't make the buyer wait for it).
    if (pathname === '/api/premium/confirm' && method === 'POST') {
      const { sessionId } = await readBody(req);
      if (!enabled() || typeof sessionId !== 'string' || !/^cs_[\w]+$/.test(sessionId)) throw httpError(400, 'Unknown checkout.');
      const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      if (s.client_reference_id !== user.id) throw httpError(403, 'That checkout belongs to another account.');
      await applySession(s);
      send(res, 200, status(await store.getUser(user.id)));
      return true;
    }

    // POST /api/premium/portal → { url } to manage or cancel the subscription on Stripe
    if (pathname === '/api/premium/portal' && method === 'POST') {
      if (!enabled() || !user.stripeCustomer) throw httpError(400, 'There’s no subscription to manage on this account.');
      const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
      const s = await stripe('POST', '/billing_portal/sessions', { customer: user.stripeCustomer, return_url: `${origin}/` });
      send(res, 200, { url: s.url });
      return true;
    }
    throw httpError(404, 'Not found.');
  };
}

module.exports = { createPremium, cardCount, FREE_CARD_LIMIT };

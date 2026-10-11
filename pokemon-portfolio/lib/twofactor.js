'use strict';
// Two-factor sign-in by text message.
//
// - Signing up asks for a phone number; the account is only created once the code texted to it
//   is entered.
// - Signing in on a device that hasn't been verified before (no trusted-device cookie for this
//   account) needs a code texted to the account's phone, after the password.
// - Accounts made before this get a prompt to add and verify a phone number.
//
// Codes are sent and checked by Twilio Verify (it makes the codes, expires them and limits
// guessing). Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID on the host.
// Without them two-factor is off and accounts work as before. SMS_PROVIDER=console (testing only)
// prints codes in the server log instead of texting them.

const crypto = require('crypto');

const PENDING_TTL = 15 * 60e3; // a code step must be finished within 15 minutes
const MAX_TRIES = 5; // wrong codes before the step has to be started again
const RESEND_GAP = 30e3;
const SENDS_PER_HOUR = 5; // per phone number
const MAX_DEVICES = 20;
const DEVICE_COOKIE = 'pf_device';
const DEVICE_DAYS = 365;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// "+1 (512) 555-0134", "512-555-0134", "+44 7700 900123" → E.164 ("+15125550134"), or null.
// Numbers without a country code are taken as US/Canada (+1).
function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.length === 10) digits = `1${digits}`;
  else if (!(digits.length === 11 && digits.startsWith('1'))) return null;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}
const maskPhone = (p) => (p ? `•••• ${String(p).slice(-4)}` : null);

function createSms() {
  const sid = () => process.env.TWILIO_ACCOUNT_SID || '';
  const token = () => process.env.TWILIO_AUTH_TOKEN || '';
  const service = () => process.env.TWILIO_VERIFY_SERVICE_SID || '';
  const provider = () => (sid() && token() && service() ? 'twilio' : process.env.SMS_PROVIDER === 'console' ? 'console' : 'off');

  async function twilio(path, params) {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service())}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid()}:${token()}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  const consoleCodes = new Map(); // phone -> { hash, exp } (SMS_PROVIDER=console only)
  return {
    provider,
    enabled: () => provider() !== 'off',
    async send(phone) {
      if (provider() === 'console') {
        const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
        consoleCodes.set(phone, { hash: sha256(code), exp: Date.now() + 10 * 60e3 });
        console.log(`[sms:console] code for ${phone}: ${code}`);
        return;
      }
      const r = await twilio('Verifications', { To: phone, Channel: 'sms' });
      if (!r.ok) {
        console.error(`twilio send ${r.status}: ${r.j.message || ''}`);
        const e = new Error(r.status === 429 || r.j.code === 60203 ? 'Too many codes sent to that number — wait a few minutes and try again.'
          : r.j.code === 60200 || r.j.code === 21211 || r.j.code === 21614 ? 'That doesn’t look like a mobile number that can get texts.'
            : 'Couldn’t send the text — try again in a moment.');
        e.status = r.status === 429 ? 429 : 400;
        throw e;
      }
    },
    async check(phone, code) {
      if (provider() === 'console') {
        const c = consoleCodes.get(phone);
        if (!c || c.exp < Date.now() || c.hash !== sha256(code)) return false;
        consoleCodes.delete(phone);
        return true;
      }
      const r = await twilio('VerificationCheck', { To: phone, Code: code });
      return r.ok && r.j.status === 'approved';
    },
  };
}

function createTwoFactor({ store, auth, httpError, sms = createSms() }) {
  // A code step in progress: token -> { kind: 'signup'|'login'|'phone', phone, user?, userId?, exp, tries, sentAt }
  const pending = new Map();
  const sendLog = new Map(); // phone -> [send times]
  setInterval(() => {
    const now = Date.now();
    for (const [k, p] of pending) if (p.exp < now) pending.delete(k);
    for (const [k, t] of sendLog) if (!t.some((x) => now - x < 3600e3)) sendLog.delete(k);
  }, 60e3).unref();

  async function sendCode(phone) {
    const now = Date.now();
    const recent = (sendLog.get(phone) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= SENDS_PER_HOUR) throw httpError(429, 'Too many codes sent to that number — wait a while and try again.');
    try { await sms.send(phone); } catch (e) { throw httpError(e.status || 400, e.message); }
    sendLog.set(phone, [...recent, now]);
  }
  async function start(step) {
    await sendCode(step.phone);
    const token = crypto.randomBytes(24).toString('base64url');
    pending.set(token, { ...step, exp: Date.now() + PENDING_TTL, tries: 0, sentAt: Date.now() });
    return { verify: token, phone: maskPhone(step.phone) };
  }
  function stepFor(token, kind = null) {
    const p = typeof token === 'string' ? pending.get(token) : null;
    if (!p || p.exp < Date.now() || (kind && p.kind !== kind)) throw httpError(410, 'That code has expired — start again to get a new one.');
    return p;
  }
  // Check a code; a correct one ends the step and returns it.
  async function finish(token, code, kind = null) {
    const p = stepFor(token, kind);
    const c = String(code ?? '').replace(/\D/g, '');
    if (c.length < 4 || c.length > 10) throw httpError(400, 'Enter the code from the text message.');
    p.tries++;
    if (!(await sms.check(p.phone, c))) {
      if (p.tries >= MAX_TRIES) { pending.delete(token); throw httpError(410, 'Too many wrong codes — start again to get a new one.'); }
      throw httpError(400, 'That code isn’t right — check the text and try again.');
    }
    pending.delete(token);
    return p;
  }
  async function resend(token) {
    const p = stepFor(token);
    if (Date.now() - p.sentAt < RESEND_GAP) throw httpError(429, 'Wait a few seconds before asking for another code.');
    await sendCode(p.phone);
    p.sentAt = Date.now();
    p.exp = Date.now() + PENDING_TTL;
    return { phone: maskPhone(p.phone) };
  }

  async function phoneFree(phone, userId = null) {
    const other = await store.getUserByPhone(phone);
    if (other && other.id !== userId) throw httpError(409, 'That phone number is already on another PokéFolio account.');
  }
  const checkPhone = (raw) => {
    const phone = normalizePhone(raw);
    if (!phone) throw httpError(400, 'Enter a mobile number, e.g. (512) 555-0134 — or +44 7700 900123 outside the US.');
    return phone;
  };

  // Trusted devices: a random id in a long-lived cookie; the account keeps its hash.
  const newDevice = () => crypto.randomBytes(32).toString('base64url');
  const trusted = (user, deviceId) => !!deviceId && (user.trustedDevices || []).some((d) => d.h === sha256(deviceId));
  async function trust(userId, deviceId) {
    const u = await store.getUser(userId);
    const h = sha256(deviceId);
    const list = (u.trustedDevices || []).filter((d) => d.h !== h);
    list.push({ h, at: Date.now() });
    await store.updateUser(userId, { trustedDevices: list.slice(-MAX_DEVICES) });
  }

  return {
    enabled: sms.enabled,
    provider: sms.provider,
    DEVICE_COOKIE, DEVICE_DAYS, maskPhone, normalizePhone,
    newDevice, trusted, trust,

    // Sign-up step 1: everything is checked now; the account is made after the code.
    async startSignup(body) {
      const user = await auth.prepareSignup(body);
      const phone = checkPhone(body.phone);
      await phoneFree(phone);
      return start({ kind: 'signup', phone, user });
    },
    // Sign-in on an unverified device: the password was right; now the code.
    startLogin(user) {
      return start({ kind: 'login', phone: user.phone, userId: user.id });
    },
    // Adding (or changing) the phone number on a signed-in account.
    async startPhone(user, raw) {
      const phone = checkPhone(raw);
      await phoneFree(phone, user.id);
      return start({ kind: 'phone', phone, userId: user.id });
    },
    finish, resend,
    // After a correct code: the account (new or existing) it's for.
    async complete(step) {
      if (step.kind === 'signup') {
        await phoneFree(step.phone);
        return auth.createPrepared({ ...step.user, phone: step.phone, phoneVerifiedAt: Date.now() });
      }
      if (step.kind === 'phone') {
        await phoneFree(step.phone, step.userId);
        await store.updateUser(step.userId, { phone: step.phone, phoneVerifiedAt: Date.now() });
      }
      return store.getUser(step.userId);
    },
  };
}

module.exports = { createTwoFactor, createSms, normalizePhone, maskPhone };

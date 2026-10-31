/* Studypath web push (Phase 4, 2026-10-27).
 *
 * Keys are never in code: the public key is in js/site-config.js as
 * vapidPublicKey (public by design), the private key is in Convex env
 * as VAPID_PRIVATE_KEY (set in the Convex dashboard, never in chat
 * or in a file). If the private key is missing, sendTestPush reports
 * vapid_not_configured instead of attempting a send.
 *
 * Sender design, deliberately payload-less: a daily reminder does not
 * need a dynamic message, it only needs to wake the installed app.
 * The action POSTs an empty body with a VAPID Authorization header;
 * the service worker in sw.js already shows its default reminder
 * ("Studypath reminder" / "Time for your study session.") when a
 * push arrives with no data, and opens the dashboard on tap.
 * Skipping the payload avoids aes128gcm encryption entirely, which
 * is the part of Web Push most likely to fail silently.
 *
 * VAPID JWT: ES256 over P-256, signed with WebCrypto. The public
 * point is derived from the private scalar with plain BigInt
 * P-256 arithmetic below (no external dependency, no Buffer, so it
 * runs in Convex's action runtime). The derived public key is sent
 * as the VAPID `k` parameter, so it always matches the signing key.
 */
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

async function requireSessionUserId(ctx: any, sessionToken: string): Promise<any> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .unique();
  if (!session || session.expiresAt < Date.now()) return null;
  return session.userId;
}

export const saveSubscription = mutation({
  args: {
    sessionToken: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    reminderTime: v.optional(v.string()),
    remindersOn: v.optional(v.boolean()),
  },
  handler: async (ctx, { sessionToken, endpoint, p256dh, auth, reminderTime, remindersOn }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { userId, p256dh, auth, reminderTime, remindersOn });
    } else {
      await ctx.db.insert("pushSubscriptions", { userId, endpoint, p256dh, auth, createdAt: Date.now(), reminderTime, remindersOn });
    }
    return { ok: true };
  },
});

export const mySubscription = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .collect();
    if (!rows.length) return { ok: true, data: { hasSubscription: false, reminderTime: null, remindersOn: null } };
    return { ok: true, data: { hasSubscription: true, reminderTime: rows[0].reminderTime || "19:00", remindersOn: rows[0].remindersOn !== false } };
  },
});

export const removeSubscription = mutation({
  args: { sessionToken: v.string(), endpoint: v.string() },
  handler: async (ctx, { sessionToken, endpoint }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", endpoint))
      .unique();
    if (existing && existing.userId === userId) await ctx.db.delete(existing._id);
    return { ok: true };
  },
});

export const updateReminder = mutation({
  args: { sessionToken: v.string(), reminderTime: v.string(), remindersOn: v.boolean() },
  handler: async (ctx, { sessionToken, reminderTime, remindersOn }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .collect();
    for (const r of rows) await ctx.db.patch(r._id, { reminderTime, remindersOn });
    return { ok: true, updated: rows.length };
  },
});

/* ---------------- Sender internals (not callable from the frontend) ---------------- */

export const subscriptionsForSession = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return null;
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .collect();
    return rows.map((r: any) => ({ endpoint: r.endpoint }));
  },
});

export const deleteByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { ok: true };
  },
});

export const listAllSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pushSubscriptions").collect();
    return rows.map((r: any) => ({
      endpoint: r.endpoint,
      reminderTime: r.reminderTime || "19:00",
      remindersOn: r.remindersOn !== false,
      lastReminderDate: r.lastReminderDate || null,
      lastReminderSentAt: r.lastReminderSentAt || null,
      lastGeneralSentAt: r.lastGeneralSentAt || null,
    }));
  },
});

export const markReminderSent = internalMutation({
  args: { endpoint: v.string(), date: v.string(), sentAt: v.optional(v.number()) },
  handler: async (ctx, { endpoint, date, sentAt }) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastReminderDate: date, lastReminderSentAt: sentAt ?? Date.now() });
    return { ok: true };
  },
});

export const markGeneralSent = internalMutation({
  args: { endpoint: v.string(), sentAt: v.number() },
  handler: async (ctx, { endpoint, sentAt }) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q: any) => q.eq("endpoint", endpoint))
      .unique();
    if (existing) await ctx.db.patch(existing._id, { lastGeneralSentAt: sentAt });
    return { ok: true };
  },
});

// --- base64url, without Buffer/btoa (Convex action runtime safe) ---
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64_ALPHABET[b2 & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(s: string): Uint8Array {
  const clean = s.replace(/-/g, "+").replace(/_/g, "/");
  const rev = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i++) rev.set(B64_ALPHABET[i], i);
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const val = rev.get(ch);
    if (val === undefined) continue;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
function bigIntToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// --- P-256 point arithmetic (BigInt) ---
const P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_A = P256_P - 3n;
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const P256_GX = BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296");
const P256_GY = BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5");
type Point = [bigint, bigint] | null;
function modP(a: bigint): bigint {
  const r = a % P256_P;
  return r < 0n ? r + P256_P : r;
}
function modInv(a: bigint): bigint {
  // Extended Euclidean algorithm; P256_P is prime and a != 0 here.
  let [oldR, r] = [modP(a), P256_P];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return modP(oldS);
}
function pointAdd(p: Point, q: Point): Point {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p;
  const [x2, y2] = q;
  let lambda: bigint;
  if (x1 === x2) {
    if (modP(y1 + y2) === 0n) return null;
    lambda = modP((3n * x1 * x1 + P256_A) * modInv(2n * y1));
  } else {
    lambda = modP((y2 - y1) * modInv(x2 - x1));
  }
  const x3 = modP(lambda * lambda - x1 - x2);
  const y3 = modP(lambda * (x1 - x3) - y1);
  return [x3, y3];
}
function scalarMul(k: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    n >>= 1n;
  }
  return result;
}

async function vapidAuthorization(endpoint: string, privateKeyB64url: string): Promise<string> {
  const privateBytes = base64urlDecode(privateKeyB64url);
  if (privateBytes.length !== 32) throw new Error("VAPID private key must decode to 32 bytes");
  const pub = scalarMul(bytesToBigInt(privateBytes), [P256_GX, P256_GY]);
  if (!pub) throw new Error("Could not derive VAPID public key");
  const x = base64urlEncode(bigIntToBytes32(pub[0]));
  const y = base64urlEncode(bigIntToBytes32(pub[1]));
  const d = base64urlEncode(privateBytes);
  const publicKey = base64urlEncode(
    new Uint8Array([4, ...bigIntToBytes32(pub[0]), ...bigIntToBytes32(pub[1])]),
  );
  const header = base64urlEncode(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(
    textBytes(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: now + 12 * 60 * 60,
        sub: "mailto:obakpoloreghosa56@gmail.com",
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d, ext: true } as any,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textBytes(signingInput),
  );
  const jwt = `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${publicKey}`;
}

async function sendOnePush(endpoint: string, privateKey: string): Promise<"sent" | "gone" | string> {
  try {
    const auth = await vapidAuthorization(endpoint, privateKey);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: auth, TTL: "86400" },
    });
    if (resp.status === 404 || resp.status === 410) return "gone";
    if (resp.status >= 200 && resp.status < 300) return "sent";
    return `${resp.status}`;
  } catch (e: any) {
    return e?.message || "fetch failed";
  }
}

/* ---------------- Public test action ---------------- */

export const sendTestPush = action({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!privateKey) {
      return { ok: false, error: { code: "vapid_not_configured", message: "VAPID private key is not set in Convex env yet." } };
    }
    const subs = await ctx.runQuery(internal.push.subscriptionsForSession, { sessionToken });
    if (!subs) {
      return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    }
    if (subs.length === 0) {
      return { ok: false, error: { code: "no_subscription", message: "Enable push first, then send a test push." } };
    }
    let sent = 0;
    let failed = 0;
    let pruned = 0;
    const errors: string[] = [];
    for (const sub of subs) {
      const result = await sendOnePush(sub.endpoint, privateKey);
      if (result === "gone") {
        await ctx.runMutation(internal.push.deleteByEndpoint, { endpoint: sub.endpoint });
        pruned++;
      } else if (result === "sent") {
        sent++;
      } else {
        failed++;
        errors.push(result);
      }
    }
    return { ok: sent > 0, sent, failed, pruned, total: subs.length, errors: errors.slice(0, 3) };
  },
});

/* ---------------- Automated daily reminders ----------------
 * Convex cron (convex/crons.ts) runs sendDailyReminders every 5 minutes.
 * Lagos is UTC+1 all year (no daylight saving), so Lagos wall time is
 * UTC time + 1 hour. A subscription is due when its reminder time is
 * within the last 10 minutes and it has not already been sent today
 * (lastReminderDate guard, so a second tick in the window cannot
 * double-send). Users who never set a time default to 19:00, and
 * remindersOn defaults to true for older rows. No button press needed.
 */
export const sendDailyReminders = internalAction({
  args: {},
  handler: async (ctx) => {
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!privateKey) return { ok: false, error: "vapid_not_configured" };
    const subs = await ctx.runQuery(internal.push.listAllSubscriptions, {});
    const lagos = new Date(Date.now() + 60 * 60 * 1000);
    const today = `${lagos.getUTCFullYear()}-${String(lagos.getUTCMonth() + 1).padStart(2, "0")}-${String(lagos.getUTCDate()).padStart(2, "0")}`;
    const minutesNow = lagos.getUTCHours() * 60 + lagos.getUTCMinutes();
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    for (const sub of subs) {
      if (!sub.remindersOn) continue;
      if (sub.lastReminderDate === today) continue;
      const parts = String(sub.reminderTime || "19:00").split(":");
      const dueMin = Number(parts[0]) * 60 + Number(parts[1] || 0);
      if (Number.isNaN(dueMin)) continue;
      if (dueMin > minutesNow || minutesNow - dueMin > 10) continue;
      const result = await sendOnePush(sub.endpoint, privateKey);
      if (result === "gone") {
        await ctx.runMutation(internal.push.deleteByEndpoint, { endpoint: sub.endpoint });
        pruned++;
      } else if (result === "sent") {
        await ctx.runMutation(internal.push.markReminderSent, { endpoint: sub.endpoint, date: today, sentAt: Date.now() });
        sent++;
      } else {
        failed++;
      }
    }
    return { ok: true, sent, pruned, failed, checked: subs.length, today };
  },
});

/* ---------------- General study reminders (final notification system) ----
 * No user setting: every 4 hours, every push subscriber gets a general
 * "time to study" nudge, whether or not they set a session reminder time.
 * The only way out is the browser/OS notification block, or unsubscribing
 * via the Settings turn-on/off control when it is shown (denied case) -
 * by design there is no Settings toggle for general reminders once
 * notifications are allowed, because notifications are a default part
 * of the app. Skips a subscriber if a session reminder went out in the
 * last 2 hours, so the two types never arrive back to back. The message
 * itself is chosen on the device by sw.js (payload-less push), rotating
 * by time of day, so the server only has to wake the app.
 */
export const sendGeneralReminders = internalAction({
  args: {},
  handler: async (ctx) => {
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!privateKey) return { ok: false, error: "vapid_not_configured" };
    const subs = await ctx.runQuery(internal.push.listAllSubscriptions, {});
    const now = Date.now();
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    let skipped = 0;
    for (const sub of subs) {
      if (sub.lastReminderSentAt && now - sub.lastReminderSentAt < 2 * 60 * 60 * 1000) { skipped++; continue; }
      const result = await sendOnePush(sub.endpoint, privateKey);
      if (result === "gone") {
        await ctx.runMutation(internal.push.deleteByEndpoint, { endpoint: sub.endpoint });
        pruned++;
      } else if (result === "sent") {
        await ctx.runMutation(internal.push.markGeneralSent, { endpoint: sub.endpoint, sentAt: now });
        sent++;
      } else {
        failed++;
      }
    }
    return { ok: true, sent, pruned, failed, skipped, checked: subs.length };
  },
});

/* Studypath email verification (Phase 1, 2026-10-27).
 *
 * Follows the existing passwordResets pattern exactly: a 6 digit code,
 * only its SHA-256 hash stored, one active code per user, short expiry,
 * limited wrong attempts, limited resends. The raw code exists only in
 * the email.
 *
 * Sending uses Brevo (BREVO_API_KEY, BREVO_FROM_EMAIL) via
 * convex/lib/email.ts, isolated in sendVerificationEmail so the code
 * lifecycle is untouched. Sender note: Brevo single-sender verification
 * is used for now (Eghosa's Gmail, no Studypath domain yet), so codes
 * can reach any recipient; a verified Studypath domain sender can
 * replace BREVO_FROM_EMAIL later with no code change. The Google
 * sign in path needs no Studypath email at all.
 *
 * Gating: verificationStatus is the source of truth for the frontend
 * banner. Gemini and Material Library gating live in
 * convex/lib/eligibility.ts (requireEmailVerified) and its call sites,
 * not here, so the code flow and the gate cannot drift apart.
 */
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendStudypathEmail } from "./lib/email";

const CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const RESEND_LIMIT = 5; // 5 codes per user per hour

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  return String(100000 + (n % 900000));
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function requireSessionUserId(ctx: any, sessionToken: string): Promise<any> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .unique();
  if (!session || session.expiresAt < Date.now()) return null;
  return session.userId;
}

/* ---------------- Internal helpers ---------------- */

export const createCode = internalMutation({
  args: { userId: v.id("users"), codeHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { userId, codeHash, expiresAt }) => {
    const prev = await ctx.db
      .query("emailVerifications")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(10);
    for (const p of prev) {
      if (!p.usedAt) await ctx.db.patch(p._id, { usedAt: Date.now() });
    }
    await ctx.db.insert("emailVerifications", {
      userId,
      codeHash,
      attempts: 0,
      expiresAt,
      createdAt: Date.now(),
    });
  },
});

export const checkResendRateLimit = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const bucket = await ctx.db
      .query("rateLimitBuckets")
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();
    if (!bucket) {
      await ctx.db.insert("rateLimitBuckets", { key, count: 1, createdAt: now });
      return true;
    }
    if (bucket.createdAt < now - RESEND_WINDOW_MS) {
      await ctx.db.patch(bucket._id, { count: 1, createdAt: now });
      return true;
    }
    if (bucket.count >= RESEND_LIMIT) return false;
    await ctx.db.patch(bucket._id, { count: bucket.count + 1 });
    return true;
  },
});

export const getUserForVerification = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user || !user.email) return null;
    return { _id: user._id, email: user.email, emailVerifiedAt: user.emailVerifiedAt || null };
  },
});

/* ---------------- Public actions / mutations ---------------- */

// One function owns sending, via the shared Brevo transport.
async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  const html = `
<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2b28">
<h2 style="margin:0 0 12px">Verify your Studypath email</h2>
<p>Your verification code for ${escapeHtml(email)} is:</p>
<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:12px 0">${escapeHtml(code)}</p>
<p style="color:#5b564a;font-size:13px">This code expires in 15 minutes. If you didn't create a Studypath account, you can safely ignore this email.</p>
</body></html>`;
  return sendStudypathEmail(email, "Your Studypath verification code", html);
}

export const requestVerificationCode = action({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const user: any = await ctx.runQuery(internal.emailVerification.getUserForVerification, { sessionToken });
    if (!user) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    const allowed = await ctx.runMutation(internal.emailVerification.checkResendRateLimit, {
      key: `verify:${user._id}`,
    });
    if (!allowed) {
      return { ok: false, error: { code: "rate_limited", message: "Too many codes requested recently. Please try again later." } };
    }
    const code = randomCode();
    const codeHash = await sha256Hex(code);
    await ctx.runMutation(internal.emailVerification.createCode, {
      userId: user._id,
      codeHash,
      expiresAt: Date.now() + CODE_EXPIRY_MS,
    });
    await sendVerificationEmail(user.email, code);
    // Deliberately always ok here: whether the email actually left is a
    // provider concern, and the code lifecycle above is what the client
    // needs. Failures are in the Convex dashboard logs.
    return { ok: true };
  },
});

export const verifyCode = mutation({
  args: { sessionToken: v.string(), code: v.string() },
  handler: async (ctx, { sessionToken, code }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const user = await ctx.db.get(userId);
    if (!user) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };
    const row = await ctx.db
      .query("emailVerifications")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .order("desc")
      .first();
    if (!row || row.usedAt || row.expiresAt < Date.now()) {
      return { ok: false, error: { code: "invalid_code", message: "That code is invalid or has expired. Request a new one." } };
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(row._id, { usedAt: Date.now() });
      return { ok: false, error: { code: "invalid_code", message: "Too many wrong attempts. Request a new code." } };
    }
    const submitted = String(code || "").trim();
    if (!/^\d{6}$/.test(submitted)) {
      return { ok: false, error: { code: "invalid_code", message: "Enter the 6 digit code from your email." } };
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(submitted));
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hash !== row.codeHash) {
      await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
      return { ok: false, error: { code: "invalid_code", message: "That code is incorrect. Please try again." } };
    }
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    await ctx.db.patch(userId, { emailVerifiedAt: Date.now() });
    return { ok: true };
  },
});

export const verificationStatus = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await requireSessionUserId(ctx, sessionToken);
    if (!userId) return { verified: false };
    const user = await ctx.db.get(userId);
    return { verified: !!(user && user.emailVerifiedAt) };
  },
});

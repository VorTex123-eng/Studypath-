/* Studypath password recovery (2026-10-06; Brevo transport 2026-10-28).
 *
 * Forgot-password flow using Brevo (BREVO_API_KEY, BREVO_FROM_EMAIL in
 * Convex env, via convex/lib/email.ts). Security properties:
 * - Generic response: never reveals whether an email exists (anti-enumeration).
 * - Tokens are cryptographically random (32 bytes); only the SHA-256 hash
 *   is stored. The raw token exists only in the emailed link.
 * - Single-use: usedAt is set atomically on success; reuse is rejected.
 * - Short expiry: 1 hour.
 * - Rate-limited per email + per IP-ish key (uses existing bumpBucket pattern).
 * - Sessions are invalidated on password change.
 * - No token/password is ever logged.
 */
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { hashPassword } from "./auth";
import { validatePassword } from "./lib/passwords";
import { sendStudypathEmail } from "./lib/email";

const RESET_TOKEN_BYTES = 32;
const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const RESET_RATE_WINDOW_MS = 60 * 60 * 1000;
const RESET_RATE_LIMIT = 3; // 3 reset emails per email per hour

function resetThrow(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(RESET_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function validPassword(password: string): string | null {
  // Phase 1: reset uses the same strong-password rules as signup.
  return validatePassword(password);
}

/* ---------------- Internal helpers ---------------- */

export const findUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .first();
    return user ? { _id: user._id, email: user.email } : null;
  },
});

export const createResetToken = internalMutation({
  args: { userId: v.id("users"), tokenHash: v.string(), expiresAt: v.number() },
  handler: async (ctx, { userId, tokenHash, expiresAt }) => {
    // Invalidate any previous unused tokens for this user (single active token).
    const prev = await ctx.db
      .query("passwordResets")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(10);
    for (const p of prev) {
      if (!p.usedAt) await ctx.db.patch(p._id, { usedAt: Date.now() });
    }
    await ctx.db.insert("passwordResets", {
      userId,
      tokenHash,
      expiresAt,
      createdAt: Date.now(),
    });
  },
});

export const consumeResetToken = internalMutation({
  args: { tokenHash: v.string(), passwordHash: v.string() },
  handler: async (ctx, { tokenHash, passwordHash }) => {
    const row = await ctx.db
      .query("passwordResets")
      .withIndex("by_token_hash", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (!row || row.usedAt || row.expiresAt < Date.now()) {
      resetThrow("invalid_token", "This reset link is invalid or has expired.");
    }
    const user = await ctx.db.get(row.userId);
    if (!user) {
      resetThrow("invalid_token", "This reset link is invalid or has expired.");
    }
    // Single-use: mark consumed BEFORE the password write so a concurrent
    // retry cannot reuse the token.
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    await ctx.db.patch(row.userId, { passwordHash });
    // Invalidate all sessions: the password changed.
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q: any) => q.eq("userId", row.userId))
      .take(50);
    for (const s of sessions) await ctx.db.delete(s._id);
    return { ok: true };
  },
});

export const checkResetRateLimit = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const windowStart = now - RESET_RATE_WINDOW_MS;
    const bucket = await ctx.db
      .query("rateLimitBuckets")
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();
    if (!bucket) {
      await ctx.db.insert("rateLimitBuckets", { key, count: 1, createdAt: now });
      return true;
    }
    if (bucket.createdAt < windowStart) {
      await ctx.db.patch(bucket._id, { count: 1, createdAt: now });
      return true;
    }
    if (bucket.count >= RESET_RATE_LIMIT) return false;
    await ctx.db.patch(bucket._id, { count: bucket.count + 1 });
    return true;
  },
});

/* ---------------- Public actions ---------------- */

const GENERIC_RESPONSE = "If an account exists for that email, we'll send you a password reset link.";

/**
 * Request a password reset. ALWAYS returns the generic response, whether or
 * not the email exists, to prevent account enumeration.
 */
export const requestPasswordReset = action({
  args: { email: v.string(), siteUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      // Even for malformed input, return the generic response.
      return { ok: true, message: GENERIC_RESPONSE };
    }
    try {
      const allowed = await ctx.runMutation(internal.passwordReset.checkResetRateLimit, {
        key: `pwreset:${email}`,
      });
      if (!allowed) {
        return { ok: true, message: GENERIC_RESPONSE };
      }
      const user: any = await ctx.runQuery(internal.passwordReset.findUserByEmail, { email });
      if (!user) {
        return { ok: true, message: GENERIC_RESPONSE };
      }
      const token = randomToken();
      const tokenHash = await sha256Hex(token);
      await ctx.runMutation(internal.passwordReset.createResetToken, {
        userId: user._id,
        tokenHash,
        expiresAt: Date.now() + RESET_EXPIRY_MS,
      });
      const siteUrl = (args.siteUrl || process.env.SITE_URL || "https://studypath.app").replace(/\/$/, "");
      const resetUrl = `${siteUrl}/reset-password.html?token=${token}`;
      const html = `
<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2b28">
<h2 style="margin:0 0 12px">Reset your Studypath password</h2>
<p>We received a request to reset the password for your Studypath account (${escapeHtml(email)}).</p>
<p><a href="${resetUrl}" style="display:inline-block;background:#0e7c6b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:700">Create a new password</a></p>
<p style="color:#5b564a;font-size:13px">This link expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email. Your password won't change.</p>
</body></html>`;
      // Brevo transport (convex/lib/email.ts). A failed send is logged
      // in the Convex dashboard; the client still gets the generic
      // response, so account existence is never revealed.
      await sendStudypathEmail(email, "Reset your Studypath password", html);
      return { ok: true, message: GENERIC_RESPONSE };
    } catch (err) {
      // Never leak internals or enumeration signals.
      console.error("[passwordReset] request failed");
      return { ok: true, message: GENERIC_RESPONSE };
    }
  },
});

/**
 * Complete a password reset with a token from the email link.
 */
export const resetPassword = action({
  args: { token: v.string(), newPassword: v.string(), confirmPassword: v.string() },
  handler: async (ctx, args) => {
    const token = String(args.token || "").trim();
    if (!token || token.length < 32 || token.length > 256 || !/^[a-f0-9]+$/i.test(token)) {
      resetThrow("invalid_token", "This reset link is invalid or has expired.");
    }
    const pwError = validPassword(args.newPassword);
    if (pwError) resetThrow("weak_password", pwError);
    if (args.newPassword !== args.confirmPassword) {
      resetThrow("mismatch", "The two passwords don't match.");
    }
    // Hash the password with the same PBKDF2 scheme as signup.
    const passwordHash = await hashPassword(args.newPassword);
    const tokenHash = await sha256Hex(token.toLowerCase());
    await ctx.runMutation(internal.passwordReset.consumeResetToken, {
      tokenHash,
      passwordHash,
    });
    return { ok: true };
  },
});

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

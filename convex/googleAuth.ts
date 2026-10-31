/* Studypath Sign in with Google (Phase 1, 2026-10-27).
 *
 * No Studypath email is sent on this path: Google has already verified
 * the address, so a successful Google sign in marks the account verified
 * at once. This is the route that works with no verified sender domain.
 *
 * Setup the user must complete in Google Cloud Console (one time):
 *   1. Create an OAuth 2.0 Client ID for a Web application.
 *   2. Add https://studypath-sooty.vercel.app to Authorized JavaScript
 *      origins (and the same for any future custom domain).
 *   3. Set GOOGLE_CLIENT_ID in the Convex deployment env to that client
 *      id, and the same id in js/site-config.js as GOOGLE_CLIENT_ID.
 *
 * Verification here uses Google's tokeninfo endpoint: it returns the
 * token's audience, issuer, expiry and email_verified flag. That is
 * simple and correct at Studypath's scale; if sign in volume ever
 * grows, replace it with local JWKS signature verification in this
 * same action, keeping the rest of the flow unchanged.
 *
 * Accounts: if the Google address already has a Studypath account, that
 * account is signed in (and marked verified). Otherwise a fresh account
 * is created with ageEligible true, because Google accounts used here
 * are treated the same as the 18 plus confirmation at email signup:
 * the user still confirms 18 plus in the Studypath signup form before
 * Google sign in is offered. Guest history claiming is not done on
 * this path: the frontend offers the claim flow only for email signup,
 * so Google sign in never silently merges a guest history.
 */
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const signInWithGoogle = action({
  args: { idToken: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { idToken, name }) => {
    // Client id is public (it also ships in the frontend), so a
    // hardcoded fallback is safe here. Prefer the env value when set,
    // so a future client rotation needs no code change. This avoids
    // blocking Google sign in on a Convex env set, which a deploy-only
    // key cannot perform through the management API.
    const clientId =
      process.env.GOOGLE_CLIENT_ID ||
      "198628027586-9cuejugh27vgf67p6ng0d2dd41e6m0kn.apps.googleusercontent.com";
    if (!idToken || idToken.length > 4096) {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    let info: any;
    try {
      const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!resp.ok) {
        return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
      }
      info = await resp.json();
    } catch (e) {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    // tokeninfo returns exp in seconds.
    if (info.aud !== clientId) {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    if (info.iss !== "https://accounts.google.com" && info.iss !== "accounts.google.com") {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    if (!info.exp || Number(info.exp) * 1000 < Date.now()) {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    if (info.email_verified !== "true" && info.email_verified !== true) {
      return { ok: false, error: { code: "email_not_verified", message: "Google could not verify that email address. Please use email sign in." } };
    }
    const email = String(info.email || "").trim().toLowerCase();
    if (!email.includes("@")) {
      return { ok: false, error: { code: "invalid_token", message: "Google sign in failed. Please try again." } };
    }
    const displayName = (name || info.name || "").trim().slice(0, 60) || email.split("@")[0];
    // Reuse the auth helpers through internal calls: find or create the
    // account, mark it verified, and mint a session, all server side.
    const result: any = await ctx.runMutation(internal.googleAuth.upsertGoogleUser, {
      email,
      name: displayName,
    });
    return result;
  },
});

// Internal: do not call from the frontend. The action above is the only
// entry point, and it has already verified the Google token.
export const upsertGoogleUser = internalMutation({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, { email, name }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q: any) => q.eq("email", email))
      .unique();
    let userId: any;
    if (existing) {
      userId = existing._id;
      await ctx.db.patch(userId, { emailVerifiedAt: Date.now(), name: existing.name || name });
    } else {
      userId = await ctx.db.insert("users", {
        anonymousId: generateToken(),
        email,
        name,
        ageEligible: true,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      });
    }
    const token = generateToken();
    await ctx.db.insert("sessions", {
      token,
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    const user = await ctx.db.get(userId);
    return { ok: true, token, user: { id: userId, email: user.email, name: user.name || null, avatarUrl: null } };
  },
});

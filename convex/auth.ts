import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { validatePassword } from "./lib/passwords";

/**
 * M11G - authentication.
 *
 * Deliberately plain mutations/queries, not Convex actions with a
 * "use node" Node runtime, and deliberately zero npm dependencies for
 * password hashing (an earlier version used bcryptjs - Convex's bundler
 * couldn't resolve it, since it isn't part of the default isolate and a
 * plain `npm install` locally doesn't change what the deploy step
 * bundles). Password hashing here uses only the Web Crypto API
 * (`crypto.subtle`, `crypto.getRandomValues`), which Convex's default
 * runtime supports natively with no install step at all: PBKDF2-SHA256
 * with a random salt per password, which is exactly what a
 * dependency like bcrypt would be doing under the hood anyway.
 *
 * Sessions are plain bearer tokens (a row in `sessions`, sent back by the
 * client on every call that needs identity) rather than cookies - this
 * frontend talks to Convex via raw fetch from static HTML pages on a
 * different origin (Netlify -> *.convex.cloud), so a self-managed token
 * is simpler and more reliable here than fighting cross-site cookies.
 *
 * The `users` table's anonymousId column is never made optional or torn
 * out - see schema.ts. Existing anonymous data (js/anon-id.js,
 * convex/attempts.ts) keeps working exactly as before for anyone who
 * never signs up.
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERATIONS = 100000;

// M11H — rate limiting for signup/signin. Same fixed-window bucket
// pattern as convex/quiz.ts, duplicated locally rather than shared -
// matches this file's existing style of small local helpers (see
// requireSession below vs. attempts.ts's own version) rather than a
// cross-file utils module. Real accounts exist now, so this endpoint is
// a real credential-stuffing / mass-signup target, not just a cost
// concern like the Gemini call.
async function bumpBucket(ctx: any, key: string, limit: number): Promise<boolean> {
  const existing = await ctx.db
    .query("rateLimitBuckets")
    .withIndex("by_key", (q: any) => q.eq("key", key))
    .unique();
  if (!existing) {
    await ctx.db.insert("rateLimitBuckets", { key, count: 1, createdAt: Date.now() });
    return true;
  }
  if (existing.count >= limit) return false;
  await ctx.db.patch(existing._id, { count: existing.count + 1 });
  return true;
}

// Sign-in is keyed by the *attempted* email, not the caller's identity -
// the point is protecting one account from being brute-forced, not
// giving each caller their own quota to spend guessing many accounts.
// Deliberately generous (10/10min) since a real person mistyping their
// own password a few times is the common case this must not punish.
const SIGNIN_WINDOW_MS = 10 * 60 * 1000;
const SIGNIN_LIMIT = 10;

// Sign-up is keyed by the calling device's anonymousId (no email exists
// yet to key it by) - catches a script mass-creating accounts from one
// browser/device. Tighter, since a real person only signs up once.
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_LIMIT = 5;

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf as ArrayBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// Stored as "pbkdf2$<iterations>$<saltHex>$<hashHex>" so the iteration
// count and algorithm are self-describing - if PBKDF2_ITERATIONS ever
// changes, existing hashes still verify correctly against whatever
// count they were actually created with.
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufToHex(salt)}$${bufToHex(derived)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = hexToBytes(parts[2]);
  const expectedHex = parts[3];
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, keyMaterial, 256);
  const actualHex = bufToHex(derived);
  if (actualHex.length !== expectedHex.length) return false;
  // Constant-time-ish comparison - avoids a naive === short-circuiting
  // on the first differing character, which is the whole point of
  // hashing passwords in the first place.
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}


function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findUserByEmail(ctx: any, email: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_email", (q: any) => q.eq("email", email))
    .unique();
}

async function findAnonUser(ctx: any, anonymousId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_anonymous_id", (q: any) => q.eq("anonymousId", anonymousId))
    .unique();
}

async function createSession(ctx: any, userId: any) {
  const token = generateToken();
  await ctx.db.insert("sessions", {
    token,
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export const signUp = mutation({
  args: {
    email: v.string(),
    password: v.string(),
    name: v.string(),
    anonymousId: v.string(),
    claimAnonymous: v.boolean(),
    // Age eligibility (2026-10-06): Gemini's terms require 18+. The
    // frontend must collect an explicit confirmation; the server rejects
    // signup without it (client checkbox alone is not the authority).
    ageConfirmed: v.boolean(),
  },
  handler: async (ctx, { email, password, name, anonymousId, claimAnonymous, ageConfirmed }) => {
    if (!ageConfirmed) {
      return { ok: false, error: { code: "age_required", message: "Please confirm you are 18 or older to create an account." } };
    }
    const signupBucketOk = await bumpBucket(ctx, `signup:${anonymousId}:${Math.floor(Date.now() / SIGNUP_WINDOW_MS)}`, SIGNUP_LIMIT);
    if (!signupBucketOk) {
      return { ok: false, error: { code: "rate_limited", message: "Too many accounts created from this device recently. Please try again later." } };
    }
    const normalizedEmail = normalizeEmail(email);
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, error: { code: "name_required", message: "Enter your name." } };
    }
    if (trimmedName.length > 60) {
      return { ok: false, error: { code: "name_too_long", message: "Name must be 60 characters or fewer." } };
    }
    if (!normalizedEmail.includes("@") || normalizedEmail.length < 5) {
      return { ok: false, error: { code: "invalid_email", message: "Enter a valid email address." } };
    }
    // Phase 1 (2026-10-27): strong passwords, server side. The form
    // meter is guidance only; this check is the authority.
    const passwordError = validatePassword(password, normalizedEmail, trimmedName);
    if (passwordError) {
      return { ok: false, error: { code: "weak_password", message: passwordError } };
    }
    if (await findUserByEmail(ctx, normalizedEmail)) {
      return { ok: false, error: { code: "email_taken", message: "An account with that email already exists." } };
    }

    const passwordHash = await hashPassword(password);
    let userId: any = null;

    if (claimAnonymous) {
      const anonUser = await findAnonUser(ctx, anonymousId);
      // Only a pure guest row can be claimed. If this anonymousId already
      // belongs to a signed-up account, claiming it would overwrite that
      // account's email and password - i.e. take it over - so skip the
      // claim and fall through to creating a fresh account instead.
      if (anonUser && !anonUser.email && !anonUser.passwordHash) {
        // Upgrade the existing anonymous row in place - same _id, so
        // every attempt already saved under this userId stays correctly
        // linked with zero migration. This is the whole reason claiming
        // is cheap: nothing about `attempts` has to change.
        await ctx.db.patch(anonUser._id, { email: normalizedEmail, passwordHash, name: trimmedName, ageEligible: true });
        userId = anonUser._id;
        // The claimed history now belongs to a signed-up account, so build
        // its per-question results (idempotent, batched, runs in the background).
        await ctx.scheduler.runAfter(0, internal.questionResults.backfillForUser, { userId: anonUser._id });
      }
    }

    if (!userId) {
      // Declined the claim, or there was nothing to claim - a fresh
      // account, unrelated to whatever this browser's anonymousId was
      // doing before. It still needs *some* anonymousId to satisfy the
      // schema/index, so it gets its own synthetic one rather than
      // reusing the browser's (which would silently merge history the
      // user just said not to merge).
      userId = await ctx.db.insert("users", {
        anonymousId: generateToken(),
        email: normalizedEmail,
        passwordHash,
        name: trimmedName,
        ageEligible: true,
        createdAt: Date.now(),
      });
    }

    const token = await createSession(ctx, userId);
    const user = await ctx.db.get(userId);
    // Phase 1: a new email account starts unverified. The frontend
    // requests a code right after signup and shows the code step.
    return { ok: true, token, needsVerification: true, user: { id: userId, email: user.email, name: user.name || null, avatarUrl: null, emailVerified: false } };
  },
});

export const signIn = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    const normalizedEmail = normalizeEmail(email);
    const signinBucketOk = await bumpBucket(ctx, `login:${normalizedEmail}:${Math.floor(Date.now() / SIGNIN_WINDOW_MS)}`, SIGNIN_LIMIT);
    if (!signinBucketOk) {
      return { ok: false, error: { code: "rate_limited", message: "Too many sign-in attempts for this account. Please wait a few minutes and try again." } };
    }
    const user = await findUserByEmail(ctx, normalizedEmail);
    if (!user || !user.passwordHash) {
      // Same generic error whether the email doesn't exist or the
      // password is wrong - don't tell a caller which part failed.
      return { ok: false, error: { code: "invalid_credentials", message: "Incorrect email or password." } };
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return { ok: false, error: { code: "invalid_credentials", message: "Incorrect email or password." } };
    }
    const token = await createSession(ctx, user._id);
    const avatarUrl = user.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null;
    return { ok: true, token, user: { id: user._id, email: user.email, name: user.name || null, avatarUrl, emailVerified: !!user.emailVerifiedAt } };
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q: any) => q.eq("token", token))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return { ok: true };
  },
});

// Age eligibility (2026-10-06). Accounts created before the requirement
// have ageEligible unset ("unknown"). The account holder sets it once via
// this mutation; it is never asked again. Setting false blocks that
// account's Gemini features. Identified by session token, never by a
// client-supplied user id.
export const setAgeEligibility = mutation({
  args: { sessionToken: v.string(), eligible: v.boolean() },
  handler: async (ctx, { sessionToken, eligible }) => {
    const userId = await requireSession(ctx, sessionToken);
    if (!userId) {
      return { ok: false, error: { code: "not_authenticated", message: "Please sign in." } };
    }
    const user = await ctx.db.get(userId);
    if (!user || user.email == null) {
      return { ok: false, error: { code: "not_authenticated", message: "Please sign in." } };
    }
    if (typeof user.ageEligible === "boolean") {
      return { ok: true, ageEligible: user.ageEligible };
    }
    await ctx.db.patch(userId, { ageEligible: eligible });
    return { ok: true, ageEligible: eligible };
  },
});

// Shared by every profile-editing mutation below: resolves a session
// token to a userId, or null if it's missing/invalid/expired. Kept
// separate from getCurrentUser's query-only version in attempts.ts style
// since mutations and queries can't share a function that only one of
// them is allowed to write from - here neither writes, so it's simpler,
// but the naming still matches that convention for anyone reading both.
async function requireSession(ctx: any, sessionToken: string | null | undefined) {
  if (!sessionToken) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .unique();
  if (!session || session.expiresAt < Date.now()) return null;
  return session.userId;
}

export const updateName = mutation({
  args: { sessionToken: v.string(), name: v.string() },
  handler: async (ctx, { sessionToken, name }) => {
    const userId = await requireSession(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: { code: "name_required", message: "Enter your name." } };
    if (trimmed.length > 60) return { ok: false, error: { code: "name_too_long", message: "Name must be 60 characters or fewer." } };
    await ctx.db.patch(userId, { name: trimmed });
    return { ok: true, name: trimmed };
  },
});

// Step 1 of the avatar upload: mint a one-time upload URL. Requires a
// valid session - minting these is otherwise a free, unauthenticated way
// to write arbitrary blobs into this project's storage, which is exactly
// the kind of "expensive public resource" M11H is about to lock down
// properly everywhere else too. This one door doesn't get left open in
// the meantime.
export const generateAvatarUploadUrl = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await requireSession(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    // M11H - even a valid, logged-in session could otherwise mint
    // unlimited storage-upload URLs; generous ceiling for a real person
    // trying a few photos, tight enough to stop a scripted loop.
    const uploadBucketOk = await bumpBucket(ctx, `avatar:${userId}:${Math.floor(Date.now() / SIGNUP_WINDOW_MS)}`, 10);
    if (!uploadBucketOk) {
      return { ok: false, error: { code: "rate_limited", message: "Too many photo uploads recently. Please try again later." } };
    }
    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { ok: true, uploadUrl };
  },
});

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Step 2: after the client has POSTed the file bytes to the URL from
// generateAvatarUploadUrl and gotten a storageId back, this attaches it
// to the account - but only after checking the file Convex actually
// received against real limits. The client already checks size/type
// before uploading, but that's just fast feedback, not enforcement - a
// request can always skip the frontend, so the check that matters is
// this one, server-side, against what's actually sitting in storage.
export const setAvatar = mutation({
  args: { sessionToken: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { sessionToken, storageId }) => {
    const userId = await requireSession(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };

    const metadata = await ctx.db.system.get(storageId);
    if (!metadata || metadata.size > MAX_AVATAR_BYTES || !ALLOWED_AVATAR_TYPES.includes(metadata.contentType || "")) {
      await ctx.storage.delete(storageId); // don't leave a rejected upload orphaned in storage
      return { ok: false, error: { code: "invalid_image", message: "Please upload a JPEG, PNG, WebP, or GIF under 5MB." } };
    }

    const user = await ctx.db.get(userId);
    if (user && user.avatarStorageId) {
      await ctx.storage.delete(user.avatarStorageId); // replacing a photo shouldn't accumulate orphaned blobs
    }
    await ctx.db.patch(userId, { avatarStorageId: storageId });
    const avatarUrl = await ctx.storage.getUrl(storageId);
    return { ok: true, avatarUrl };
  },
});

export const getCurrentUser = query({
  args: { token: v.union(v.string(), v.null()) },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q: any) => q.eq("token", token))
      .unique();
    if (!session || session.expiresAt < Date.now()) return null;
    const user = await ctx.db.get(session.userId);
    if (!user) return null;
    const avatarUrl = user.avatarStorageId ? await ctx.storage.getUrl(user.avatarStorageId) : null;
    return { id: user._id, email: user.email || null, name: user.name || null, avatarUrl, emailVerified: !!user.emailVerifiedAt };
  },
});

// Lets the sign-up screen decide whether the "claim your existing
// history" prompt is even worth showing - only worth asking if this
// browser's anonymousId actually has attempts tied to it.
export const checkAnonymousHistory = query({
  args: { anonymousId: v.string() },
  handler: async (ctx, { anonymousId }) => {
    const user = await findAnonUser(ctx, anonymousId);
    if (!user || user.email || user.passwordHash) return { count: 0 };
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_user", (q: any) => q.eq("userId", user._id))
      .collect();
    return { count: attempts.length };
  },
});

/* ------------------------------------------------------------------
 * Account deletion (required by Google Play and the App Store for any
 * app that lets people create an account).
 *
 * Two entry points, one shared purge:
 *  - deleteAccount: in-app, needs the live session token AND, for
 *    accounts that have a password, the password again (a stolen or
 *    left-open session alone must not be enough to erase a password
 *    account's history). Passwordless Google-only accounts have no
 *    password to re-enter, so the live Google-verified session alone
 *    is the proof for them.
 *  - deleteAccountByCredentials: the public web page
 *    (delete-account.html) - for someone who no longer has the app
 *    installed. Email + password, and it shares the sign-in rate limit
 *    bucket so it cannot be used to brute-force a password any faster
 *    than signing in could.
 *
 * The account row, sessions and avatar go immediately. Quiz attempts
 * are removed in small batches by a scheduled internal mutation, so a
 * very large history can never blow a single mutation's read/write
 * limits.
 * ------------------------------------------------------------------ */
async function purgeUser(ctx: any, userId: any) {
  const user = await ctx.db.get(userId);
  if (!user) return;
  if (user.avatarStorageId) {
    try { await ctx.storage.delete(user.avatarStorageId); } catch (e) { /* already gone - fine */ }
  }
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .collect();
  for (const s of sessions) await ctx.db.delete(s._id);
  // Stabilization (L1): reports were capped at 500 rows — drain in
  // batches so a prolific reporter leaves no orphans.
  let reportsRemaining = true;
  while (reportsRemaining) {
    const batch = await ctx.db
      .query("reports")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(500);
    for (const r of batch) await ctx.db.delete(r._id);
    reportsRemaining = batch.length === 500;
  }
  // Stabilization (L2): drop this account's rate-limit buckets too
  // (gen:burst/gen:daily/delete/save keys embed the userId).
  const uid = String(userId);
  const buckets = await ctx.db.query("rateLimitBuckets").collect();
  for (const b of buckets) {
    if (typeof b.key === "string" && b.key.indexOf(uid) !== -1) await ctx.db.delete(b._id);
  }
  await ctx.db.delete(userId);
  await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserAttempts, { userId });
  await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserQuestionResults, { userId });
  // Phase C: saved study materials go last - attempts/questionResults are
  // already queued for removal, and deleting a material unlinks (rather
  // than deletes) any attempt that still points at it.
  await ctx.scheduler.runAfter(0, internal.materials.purgeUserMaterials, { userId });
  // B1: tutor conversations and messages go too.
  await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserTutorData, { userId });
}

const DELETE_WINDOW_MS = 10 * 60 * 1000;
const DELETE_LIMIT = 5;

export const deleteAccount = mutation({
  args: { sessionToken: v.string(), password: v.string() },
  handler: async (ctx, { sessionToken, password }) => {
    const userId = await requireSession(ctx, sessionToken);
    if (!userId) return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    const bucketOk = await bumpBucket(ctx, `delete:${userId}:${Math.floor(Date.now() / DELETE_WINDOW_MS)}`, DELETE_LIMIT);
    if (!bucketOk) {
      return { ok: false, error: { code: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." } };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { ok: false, error: { code: "not_authenticated", message: "Please sign in again." } };
    }
    if (user.passwordHash) {
      // Email/password account: password re-entry is the second proof.
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return { ok: false, error: { code: "invalid_credentials", message: "Incorrect password." } };
    }
    // Passwordless account (Google-only sign-in, no passwordHash set):
    // the live session itself is the proof of ownership, because it was
    // minted only after Google verified the account. Requiring a
    // password here made deletion impossible for these accounts.
    await purgeUser(ctx, userId);
    return { ok: true };
  },
});

export const deleteAccountByCredentials = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    const normalizedEmail = normalizeEmail(email);
    const bucketOk = await bumpBucket(ctx, `login:${normalizedEmail}:${Math.floor(Date.now() / SIGNIN_WINDOW_MS)}`, SIGNIN_LIMIT);
    if (!bucketOk) {
      return { ok: false, error: { code: "rate_limited", message: "Too many attempts for this account. Please wait a few minutes and try again." } };
    }
    const user = await findUserByEmail(ctx, normalizedEmail);
    // Same generic error whether the email is unknown or the password
    // is wrong - never reveal which accounts exist.
    if (!user || !user.passwordHash) {
      return { ok: false, error: { code: "invalid_credentials", message: "Incorrect email or password." } };
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return { ok: false, error: { code: "invalid_credentials", message: "Incorrect email or password." } };
    await purgeUser(ctx, user._id);
    return { ok: true };
  },
});

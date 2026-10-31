/* ============================================================
   Phase C: saved study materials ("My Materials").

   A private, per-account library of study texts the user chose to keep
   for quiz reuse. Guests never get rows here: every function resolves the
   owner from the session token server-side (via the findValidSessionUserId
   helper shared with convex/attempts.ts) - there is no client-supplied
   userId and no anonymousId path, so there is no way to read or write
   another account's material. Missing, expired, and foreign ids all throw
   the same material_not_found error so one cannot be told apart from
   the other.

   The full extracted text lives only in the materials table; attempts
   carry just an optional materialId pointer (see convex/schema.ts), so
   deleting a material only unlinks attempts instead of deleting quiz
   history. List views return summaries without the text blob - the full
   text travels only through getMaterial (owner-only) and
   resolveMaterialForGeneration (internal, server-side, used by quiz
   generation).

   Validation contract (enforced here, not just client-side):
   - text: 120-50,000 chars after normalization
   - 20 materials max per account (library_full)
   - titles unique per account, max 80 chars (duplicate_title)
   ============================================================ */

import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { findValidSessionUserId } from "./attempts";
import { emailNotVerifiedError } from "./lib/eligibility";
import type { Id } from "./_generated/dataModel";

const MIN_CHARS = 120;
const MAX_CHARS = 50000;
const MAX_MATERIALS_PER_USER = 20;
const MAX_TITLE_LENGTH = 80;
const LIST_PAGE_SIZE = 25; // above the per-user cap, so one page always holds the whole library

// Save-material rate limit: fixed-window buckets, same pattern as the
// signup/signin buckets in convex/auth.ts and the generation buckets in
// convex/quiz.ts. Keyed by account (not device) - guests cannot save at
// all, so there is nothing anonymous to key by.
const SAVE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SAVE_LIMIT_PER_WINDOW = 30;

// Missing, expired, and foreign ids all throw the same error so one cannot
// be told apart from the other. Thrown (not returned) so the HTTP layer
// surfaces it as {ok:false} - the same convention convex/attempts.ts and
// convex/quiz.ts use, which is what the frontend's `if (!res.ok)` checks
// expect.
function throwNotFound(): never {
  throw new ConvexError({ code: "material_not_found", message: "That saved material is no longer available." });
}

function throwError(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

type MaterialsCtx = { db: any };

// Local copy of the rate-limit bucket helper (convex/auth.ts keeps its own
// private copy too - this file's style is small local helpers, not a
// shared utils module).
async function bumpBucket(ctx: MaterialsCtx, key: string, limit: number): Promise<boolean> {
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

// Resolve the calling account from the session token. Guests (no token,
// expired token, unknown token) get null - and every caller below treats
// null as "nothing of yours here", returning material_not_found.
async function sessionUserId(ctx: MaterialsCtx, sessionToken?: string | null) {
  return findValidSessionUserId(ctx, sessionToken);
}

// A material row plus its owner, for the ownership-checked paths.
async function ownedMaterial(ctx: MaterialsCtx, userId: Id<"users">, materialId: Id<"materials">) {
  const material = await ctx.db.get(materialId);
  if (!material || material.userId !== userId) return null;
  return material;
}

function toSummary(material: any) {
  return {
    id: material._id,
    title: material.title,
    subject: material.subject || "",
    kind: material.kind,
    charCount: material.charCount,
    updatedAt: material.updatedAt,
    createdAt: material.createdAt,
  };
}

function validateSaveInput(title: unknown, extractedText: unknown) {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) {
    return { ok: false as const, error: { code: "title_required", message: "Give your material a title first." } };
  }
  if (t.length > MAX_TITLE_LENGTH) {
    return { ok: false as const, error: { code: "title_too_long", message: "Keep the title under 80 characters." } };
  }
  const text = typeof extractedText === "string" ? extractedText : "";
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) {
    return {
      ok: false as const,
      error: {
        code: "text_invalid",
        message: `Material text must be between ${MIN_CHARS.toLocaleString()} and ${MAX_CHARS.toLocaleString()} characters.`,
      },
    };
  }
  return { ok: true as const, title: t, text };
}

/* ---------------- Queries ---------------- */

export const listMaterials = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const userId = await sessionUserId(ctx, sessionToken);
    if (!userId) throwNotFound();
    const rows = await ctx.db
      .query("materials")
      .withIndex("by_user_and_updated", (q: any) => q.eq("userId", userId))
      .order("desc")
      .take(LIST_PAGE_SIZE);
    return { materials: rows.map(toSummary), total: rows.length };
  },
});

export const getMaterial = query({
  args: { sessionToken: v.optional(v.string()), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await sessionUserId(ctx, sessionToken);
    if (!userId) throwNotFound();
    const material = await ownedMaterial(ctx, userId, materialId);
    if (!material) throwNotFound();
    return { material: { ...toSummary(material), extractedText: material.extractedText } };
  },
});

// Server-side resolution used by quiz generation (convex/quiz.ts): the AI
// action receives only a materialId from the client and loads the text
// itself, so the client can never inject foreign or forged text into a
// generation. Internal only - not callable from the browser.
export const resolveMaterialForGeneration = internalMutation({
  args: { sessionToken: v.optional(v.string()), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await sessionUserId(ctx, sessionToken);
    if (!userId) throwNotFound();
    const material = await ownedMaterial(ctx, userId, materialId);
    if (!material) throwNotFound();
    return { text: material.extractedText, label: material.title };
  },
});

/* ---------------- Mutations ---------------- */

export const saveMaterial = mutation({
  args: {
    sessionToken: v.optional(v.string()),
    title: v.string(),
    subject: v.optional(v.string()),
    kind: v.union(v.literal("pdf"), v.literal("docx"), v.literal("txt"), v.literal("paste")),
    extractedText: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await sessionUserId(ctx, args.sessionToken);
    if (!userId) throwNotFound();
    // Phase 1: mutations read the database directly (no runQuery here),
    // so check verification inline instead of via the action gate.
    const owner = await ctx.db.get(userId);
    if (!owner || !owner.emailVerifiedAt) emailNotVerifiedError();

    const allowed = await bumpBucket(
      ctx,
      `material:save:${String(userId)}:${Math.floor(Date.now() / SAVE_WINDOW_MS)}`,
      SAVE_LIMIT_PER_WINDOW
    );
    if (!allowed) {
      throwError("rate_limited", "You're saving materials faster than we allow right now. Please wait a bit and try again.");
    }

    const valid = validateSaveInput(args.title, args.extractedText);
    if (!valid.ok) throwError(valid.error.code, valid.error.message);

    const count = (
      await ctx.db
        .query("materials")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .take(MAX_MATERIALS_PER_USER + 1)
    ).length;
    if (count >= MAX_MATERIALS_PER_USER) {
      throwError(
        "library_full",
        `Your library holds up to ${MAX_MATERIALS_PER_USER} materials. Delete one you no longer need to save a new one.`
      );
    }

    const duplicate = await ctx.db
      .query("materials")
      .withIndex("by_user_and_title", (q: any) => q.eq("userId", userId).eq("title", valid.title))
      .unique();
    if (duplicate) {
      throwError("duplicate_title", "You already have a saved material with that title. Pick a different one.");
    }

    const now = Date.now();
    const subject = (args.subject || "").trim().slice(0, 120);
    const id = await ctx.db.insert("materials", {
      userId,
      title: valid.title,
      subject,
      kind: args.kind,
      extractedText: valid.text,
      charCount: valid.text.length,
      createdAt: now,
      updatedAt: now,
    });
    // Build the summary from the values just written (avoids a re-read).
    return {
      material: {
        id,
        title: valid.title,
        subject,
        kind: args.kind,
        charCount: valid.text.length,
        updatedAt: now,
        createdAt: now,
      },
    };
  },
});

export const renameMaterial = mutation({
  args: {
    sessionToken: v.optional(v.string()),
    materialId: v.id("materials"),
    title: v.string(),
  },
  handler: async (ctx, { sessionToken, materialId, title }) => {
    const userId = await sessionUserId(ctx, sessionToken);
    if (!userId) throwNotFound();
    const material = await ownedMaterial(ctx, userId, materialId);
    if (!material) throwNotFound();

    const t = typeof title === "string" ? title.trim() : "";
    if (!t) {
      throwError("title_required", "Give your material a title first.");
    }
    if (t.length > MAX_TITLE_LENGTH) {
      throwError("title_too_long", "Keep the title under 80 characters.");
    }
    const duplicate = await ctx.db
      .query("materials")
      .withIndex("by_user_and_title", (q: any) => q.eq("userId", userId).eq("title", t))
      .unique();
    if (duplicate && duplicate._id !== materialId) {
      throwError("duplicate_title", "You already have a saved material with that title. Pick a different one.");
    }
    await ctx.db.patch(materialId, { title: t, updatedAt: Date.now() });
    return { material: toSummary({ ...material, title: t }) };
  },
});

export const deleteMaterial = mutation({
  args: { sessionToken: v.optional(v.string()), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await sessionUserId(ctx, sessionToken);
    if (!userId) throwNotFound();
    const material = await ownedMaterial(ctx, userId, materialId);
    if (!material) throwNotFound();

    // Unlink, never cascade-delete: attempts keep their questions, answers
    // and scores - they just lose the pointer to the removed material.
    const linked = await ctx.db
      .query("attempts")
      .withIndex("by_material", (q: any) => q.eq("materialId", materialId))
      .collect();
    for (const attempt of linked) {
      if (attempt.userId !== userId) continue; // defense in depth - should be impossible by construction
      await ctx.db.patch(attempt._id, { materialId: undefined });
    }

    await ctx.db.delete(materialId);
    return { deleted: true };
  },
});

// Account-deletion chain: removes all of a user's materials in 200-row
// batches, self-rescheduling like the sibling purges in
// convex/accountCleanup.ts. Runs after questionResults per the existing
// cleanup order (wired in convex/auth.ts purgeUser).
export const purgeUserMaterials = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const batch = await ctx.db
      .query("materials")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(200);
    for (const row of batch) {
      await ctx.db.delete(row._id);
    }
    if (batch.length === 200) {
      await ctx.scheduler.runAfter(0, internal.materials.purgeUserMaterials, { userId });
    }
    return { deleted: batch.length, rescheduled: batch.length === 200 };
  },
});

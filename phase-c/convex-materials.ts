/**
 * STUDYPATH PHASE C — CONVEX WIRING (integration-time file, NOT live).
 *
 * DO NOT copy this into convex/ yet. At integration time this file
 * becomes convex/materials.ts (plural — convex/material.ts already
 * exists and is the validation module; the names must not collide).
 *
 * Design notes, all audited from existing code:
 *  - Identity: findValidSessionUserId + isAccountRow from
 *    convex/attempts.ts, exactly like convex/lib/ownRows.ts does.
 *    No anonymousId parameter on any function — guests cannot reach
 *    these endpoints' writes, and reads return not_authenticated.
 *  - Envelopes: { ok, error: { code, message } }, matching auth.ts.
 *  - Validation/limits: delegated to the shared core
 *    (../phase-c/material-validation.js, material-ownership.js,
 *    material-service.js, material-cleanup.js). The Convex layer only
 *    adapts ctx (db/session) to the core's injected collaborators, so
 *    there is exactly one implementation of every rule — the same one
 *    the node:test suite exercises.
 *  - Bounded reads: listMaterials pages through by_user_and_updated
 *    (never .collect()); deleteMaterial clears attempt references via
 *    the proposed by_material index in bounded batches.
 *  - Rate limiting: reuse the existing fixed-window bucket pattern
 *    (convex/auth.ts bumpBucket). Material writes are cheap but not
 *    free — cap saves per account per hour.
 *
 * The code below is written against the PROPOSED schema
 * (phase-c/schema-proposal.ts). It will not typecheck until the
 * materials table and attempts.materialId exist.
 */

import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { findValidSessionUserId, isAccountRow } from "./attempts";
// Core is plain JS so it can be unit-tested without Convex; the
// deployment bundles it like any other local module.
import { validateMaterialInput, validateRename } from "../phase-c/material-validation";
import { LIMITS, ERROR_CODES } from "../phase-c/material-types";

// -- identity -------------------------------------------------------
async function requireAccount(ctx: any, sessionToken: string | undefined) {
  const userId = await findValidSessionUserId(ctx, sessionToken);
  const user = userId ? await ctx.db.get(userId) : null;
  if (!userId || !isAccountRow(user)) return null;
  return userId;
}

function notAuthed() {
  return { ok: false, error: { code: "not_authenticated", message: "Please sign in to use your material library." } };
}

// -- writes ---------------------------------------------------------
export const saveMaterial = mutation({
  args: {
    sessionToken: v.string(),
    title: v.string(),
    subject: v.optional(v.string()),
    kind: v.union(v.literal("pdf"), v.literal("docx"), v.literal("txt"), v.literal("paste")),
    extractedText: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAccount(ctx, args.sessionToken);
    if (!userId) return notAuthed();

    const valid = validateMaterialInput({
      title: args.title,
      subject: args.subject,
      kind: args.kind,
      extractedText: args.extractedText,
    });
    if (!valid.ok) return valid;

    // Server-side per-user cap (§12) — counted, not trusted.
    const existing = await ctx.db
      .query("materials")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(LIMITS.MAX_MATERIALS_PER_USER + 1);
    if (existing.length >= LIMITS.MAX_MATERIALS_PER_USER) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.MATERIAL_LIMIT_REACHED,
          message: `You can save up to ${LIMITS.MAX_MATERIALS_PER_USER} materials. Delete one to save another.`,
        },
      };
    }

    const now = Date.now();
    const id = await ctx.db.insert("materials", {
      userId,
      title: valid.data.title,
      subject: valid.data.subject ?? undefined,
      kind: valid.data.kind,
      extractedText: valid.data.extractedText,
      charCount: valid.data.charCount,
      createdAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(id);
    const { extractedText: _omit, ...summary } = row as any;
    return { ok: true, material: summary };
  },
});

export const renameMaterial = mutation({
  args: { sessionToken: v.string(), materialId: v.id("materials"), title: v.string() },
  handler: async (ctx, { sessionToken, materialId, title }) => {
    const userId = await requireAccount(ctx, sessionToken);
    if (!userId) return notAuthed();
    const titleRes = validateRename(title);
    if (!titleRes.ok) return titleRes;
    const row = await ctx.db.get(materialId);
    // Same id for "missing" and "someone else's": never leak existence.
    if (!row || row.userId !== userId) {
      return { ok: false, error: { code: "material_not_found", message: "Material not found." } };
    }
    await ctx.db.patch(materialId, { title: titleRes.data, updatedAt: Date.now() });
    return { ok: true };
  },
});

export const deleteMaterial = mutation({
  args: { sessionToken: v.string(), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await requireAccount(ctx, sessionToken);
    if (!userId) return notAuthed();
    const row = await ctx.db.get(materialId);
    if (!row || row.userId !== userId) {
      return { ok: false, error: { code: "material_not_found", message: "Material not found." } };
    }
    // Unlink, don't destroy: attempts keep every field; only the
    // reference is removed (see schema-proposal.ts). Bounded via the
    // proposed by_material index.
    for (;;) {
      const refs = await ctx.db
        .query("attempts")
        .withIndex("by_material", (q: any) => q.eq("materialId", materialId))
        .take(200);
      if (refs.length === 0) break;
      for (const a of refs) await ctx.db.patch(a._id, { materialId: undefined });
      if (refs.length < 200) break;
    }
    await ctx.db.delete(materialId);
    return { ok: true };
  },
});

// -- reads ----------------------------------------------------------
export const listMaterials = query({
  args: { sessionToken: v.string(), limit: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, { sessionToken, limit, cursor }) => {
    const userId = await requireAccount(ctx, sessionToken);
    if (!userId) return notAuthed();
    const pageSize = Math.max(1, Math.min(50, limit || 50));
    let q = ctx.db
      .query("materials")
      .withIndex("by_user_and_updated", (qq: any) => qq.eq("userId", userId))
      .order("desc");
    // Cursor is the last-seen row id (opaque to the client).
    const all = await q.take(pageSize + 1 + (cursor ? 50 : 0));
    let items = all;
    if (cursor) {
      const idx = all.findIndex((r: any) => r._id === cursor);
      items = idx === -1 ? [] : all.slice(idx + 1);
    }
    const page = items.slice(0, pageSize);
    const nextCursor = items.length > pageSize ? String(page[page.length - 1]._id) : null;
    return {
      ok: true,
      materials: page.map((r: any) => {
        const { extractedText: _omit, ...summary } = r;
        return summary;
      }),
      nextCursor,
    };
  },
});

export const getMaterial = query({
  args: { sessionToken: v.string(), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await requireAccount(ctx, sessionToken);
    if (!userId) return notAuthed();
    const row = await ctx.db.get(materialId);
    if (!row || row.userId !== userId) {
      return { ok: false, error: { code: "material_not_found", message: "Material not found." } };
    }
    return { ok: true, material: row };
  },
});

// -- AI choke point (§19) -------------------------------------------
// Internal: only called server-side (e.g. from quiz.ts generateQuiz).
// Resolves the material TEXT from the session owner's own row — the
// model input can never be another user's text because the lookup key
// is (session -> userId) + materialId, never a client-supplied userId.
export const resolveMaterialForGeneration = internalMutation({
  args: { sessionToken: v.string(), materialId: v.id("materials") },
  handler: async (ctx, { sessionToken, materialId }) => {
    const userId = await requireAccount(ctx, sessionToken);
    if (!userId) return notAuthed();
    const row = await ctx.db.get(materialId);
    if (!row || row.userId !== userId) {
      return { ok: false, error: { code: "material_not_found", message: "Material not found." } };
    }
    return {
      ok: true,
      material: { id: row._id, title: row.title, label: row.title, text: row.extractedText, charCount: row.charCount },
    };
  },
});

// -- account cleanup extension --------------------------------------
// Scheduled from purgeUser (see integration-plan.md). Batched +
// self-rescheduling, same pattern as purgeUserAttempts.
export const purgeUserMaterials = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<null> => {
    const batch = await ctx.db
      .query("materials")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(200);
    for (const m of batch) await ctx.db.delete(m._id);
    if (batch.length === 200) {
      await ctx.scheduler.runAfter(0, internal.materials.purgeUserMaterials, { userId });
    }
    return null;
  },
});

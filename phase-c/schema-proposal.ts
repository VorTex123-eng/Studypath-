/**
 * STUDYPATH PHASE C — SCHEMA PROPOSAL (not applied).
 *
 * This file is a PROPOSAL ONLY. It is not imported anywhere, it is not
 * part of the Convex deployment, and convex/schema.ts is untouched.
 * At integration time, the `materials` table below is merged into
 * convex/schema.ts and the `attempts` table gains the optional
 * `materialId` field described at the bottom.
 *
 * Conventions followed (audited from the existing schema):
 *  - Date.now() ms numbers for createdAt/updatedAt (not ISO strings).
 *  - userId: v.id("users"), ownership always the session-resolved account.
 *  - Dedicated by_user indexes; no uniqueness constraints (Convex
 *    indexes don't enforce them — same note as by_email).
 *  - Bounded reads via indexes (no unbounded .collect() on user data).
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Phase C: persistent study materials. Signed-in accounts only.
 * Guest material stays exactly where it is today: sessionStorage via
 * js/material.js, never in this table.
 */
export const materials = defineTable({
  /** Owning account. Resolved server-side from the session token; the
   *  client never supplies this. Never an anonymousId-derived user. */
  userId: v.id("users"),

  /** User-facing title, trimmed, 1..120 chars (validated server-side). */
  title: v.string(),

  /** Optional subject label, trimmed, <=120 chars. */
  subject: v.optional(v.string()),

  /** Where the text came from. The original binary is never stored. */
  kind: v.union(
    v.literal("pdf"),
    v.literal("docx"),
    v.literal("txt"),
    v.literal("paste")
  ),

  /**
   * Normalized extracted text, 120..50,000 chars (UTF-16 units, same as
   * the existing convex/material.ts gate). Stored verbatim after
   * normalization so generation, future study guides (D) and the tutor
   * (B) all read the same canonical text.
   */
  extractedText: v.string(),

  /**
   * extractedText.length, denormalized. List views ("My Materials")
   * need per-row sizes without pulling 50k-char blobs; storing the
   * count keeps those reads to the indexed row only.
   */
  charCount: v.number(),

  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_user_and_updated", ["userId", "updatedAt"]);

/**
 * PROPOSED MIGRATION to the existing `attempts` table (convex/schema.ts):
 *
 *   attempts: defineTable({
 *     ...existing fields...,
 *     // NEW (optional — every existing row simply has it absent):
 *     materialId: v.optional(v.id("materials")),
 *   })
 *   .index("by_user", ["userId"])
 *   .index("by_user_and_completed", ["userId", "completedAt"])
 *   // NEW index so material delete can find referencing attempts
 *   // without scanning the user's whole history:
 *   .index("by_material", ["materialId"])
 *
 * Semantics:
 *  - saveAttempt gains an optional materialId arg. When the quiz was
 *    generated from a saved material, the client sends the materialId;
 *    the server verifies ownership (same session check as everything
 *    else) before storing it. The full material text is NOT copied into
 *    the attempt — the id is the link.
 *  - Deleting a material does NOT delete attempts. The delete flow
 *    clears the reference (patch the attempt, removing the materialId
 *    field) via the by_material index, then deletes the material row.
 *    Historical results, per-question rows and weak-area signals stay
 *    fully intact — they never needed the material text, only the quiz
 *    content they already embed.
 *  - No backfill is required: absent materialId means "pre-Phase-C or
 *    unsaved session material", which is already the only thing the
 *    field's absence can mean.
 */
export {};

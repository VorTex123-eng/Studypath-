import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { deriveQuestionResults } from "./lib/results";

/**
 * F1 backfill: builds `questionResults` for attempts that were saved before
 * the table existed (and for a guest's history once they sign up and claim it).
 *
 * INTERNAL ONLY - none of this is callable from a browser. Run it from the
 * Convex dashboard or CLI:  npx convex run questionResults:backfillAll
 *
 * Safe to run any number of times:
 *  - Idempotent: an attempt that already has rows is skipped (checked by the
 *    by_attempt index), so a second run inserts nothing.
 *  - Batched: a few attempts per transaction, then the function schedules
 *    itself for the next page, so no single transaction gets large.
 *  - Resumable: progress is just the pagination cursor; if it is interrupted,
 *    run it again.
 *  - Authenticated ownership only: rows are created only for attempts whose
 *    owner is a signed-up account. Guest attempts are skipped, never written.
 */
const ATTEMPTS_PER_BATCH = 5;

async function backfillPage(ctx: any, page: any[]) {
  const owners = new Map<string, any>();
  let processed = 0, inserted = 0, skippedGuest = 0, alreadyDone = 0;
  for (const attempt of page) {
    processed++;
    const key = String(attempt.userId);
    if (!owners.has(key)) owners.set(key, await ctx.db.get(attempt.userId));
    const owner = owners.get(key);
    if (!owner || !(owner.email || owner.passwordHash)) { skippedGuest++; continue; }
    const existing = await ctx.db
      .query("questionResults")
      .withIndex("by_attempt", (q: any) => q.eq("attemptId", attempt._id))
      .first();
    if (existing) { alreadyDone++; continue; }
    for (const row of deriveQuestionResults(attempt)) {
      await ctx.db.insert("questionResults", { userId: attempt.userId, attemptId: attempt._id, ...row });
      inserted++;
    }
  }
  return { processed, inserted, skippedGuest, alreadyDone };
}

export const backfillAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("attempts").paginate({ numItems: ATTEMPTS_PER_BATCH, cursor: cursor ?? null });
    const stats = await backfillPage(ctx, page.page);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.questionResults.backfillAll, { cursor: page.continueCursor });
    }
    return { ...stats, done: page.isDone };
  },
});

// One user's history - used right after a guest claims their history by
// signing up. Stops immediately if the account no longer exists (deleted
// mid-run), so it can never write rows for a deleted user.
export const backfillForUser = internalMutation({
  args: { userId: v.id("users"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { userId, cursor }) => {
    const owner = await ctx.db.get(userId);
    if (!owner || !(owner.email || owner.passwordHash)) return { processed: 0, inserted: 0, skippedGuest: 0, alreadyDone: 0, done: true };
    const page = await ctx.db
      .query("attempts")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .paginate({ numItems: ATTEMPTS_PER_BATCH, cursor: cursor ?? null });
    const stats = await backfillPage(ctx, page.page);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.questionResults.backfillForUser, { userId, cursor: page.continueCursor });
    }
    return { ...stats, done: page.isDone };
  },
});

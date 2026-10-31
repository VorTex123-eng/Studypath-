import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Background half of account deletion (see convex/auth.ts:purgeUser).
 * Deletes a removed user's quiz attempts in batches and reschedules
 * itself until none are left, so one very large history can never hit a
 * single mutation's document limits. Internal: not callable from the
 * browser.
 */
const BATCH = 200;

export const purgeUserAttempts = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<null> => {
    const batch = await ctx.db
      .query("attempts")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(BATCH);
    for (const a of batch) await ctx.db.delete(a._id);
    if (batch.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserAttempts, { userId });
    }
    return null;
  },
});

/**
 * Same batched approach for a deleted account's per-question results (F1).
 * Reschedules itself until none are left.
 */
export const purgeUserQuestionResults = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<null> => {
    const batch = await ctx.db
      .query("questionResults")
      .withIndex("by_user_and_time", (q: any) => q.eq("userId", userId))
      .take(BATCH);
    for (const r of batch) await ctx.db.delete(r._id);
    if (batch.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserQuestionResults, { userId });
    }
    return null;
  },
});

/**
 * B1: purge a deleted account's tutor conversations and messages.
 * Same batched, self-rescheduling approach. Messages carry the denormalized
 * userId so both tables purge without a join.
 */
export const purgeUserTutorData = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<null> => {
    const convos = await ctx.db
      .query("tutorConversations")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(BATCH);
    for (const c of convos) await ctx.db.delete(c._id);
    const msgs = await ctx.db
      .query("tutorMessages")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(BATCH);
    for (const m of msgs) await ctx.db.delete(m._id);
    if (convos.length === BATCH || msgs.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.accountCleanup.purgeUserTutorData, { userId });
    }
    return null;
  },
});

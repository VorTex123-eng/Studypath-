import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * "Report a problem" on a quiz question. Public but tightly bounded:
 * fixed reason list, capped text lengths, and a per-reporter hourly
 * limit so it cannot be used to flood the table.
 */
const REASONS = ["incorrect", "offensive", "off_topic", "other"];
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 10;

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

export const submitReport = mutation({
  args: {
    sessionToken: v.optional(v.string()),
    anonymousId: v.string(),
    quizId: v.string(),
    questionId: v.string(),
    questionText: v.string(),
    topic: v.string(),
    reason: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!REASONS.includes(args.reason)) {
      return { ok: false, error: { code: "invalid_request", message: "Please choose a reason." } };
    }
    // Signed-in reporters are linked to their account (so deleting the
    // account removes the report); guests are not linked to anything.
    let userId: any = undefined;
    if (args.sessionToken) {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_token", (q: any) => q.eq("token", args.sessionToken))
        .unique();
      if (session && session.expiresAt > Date.now()) userId = session.userId;
    }
    const who = userId ? String(userId) : "anon:" + args.anonymousId;
    const ok = await bumpBucket(ctx, `report:${who}:${Math.floor(Date.now() / WINDOW_MS)}`, LIMIT);
    if (!ok) {
      return { ok: false, error: { code: "rate_limited", message: "You've sent a lot of reports recently. Please try again later." } };
    }
    await ctx.db.insert("reports", {
      ...(userId ? { userId } : {}),
      quizId: args.quizId.slice(0, 100),
      questionId: args.questionId.slice(0, 100),
      questionText: args.questionText.slice(0, 1000),
      topic: args.topic.slice(0, 200),
      reason: args.reason,
      note: (args.note || "").trim().slice(0, 500),
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

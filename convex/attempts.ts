import { mutation, query } from "./_generated/server";
import { deriveQuestionResults } from "./lib/results";
import { v, ConvexError } from "convex/values";

/**
 * M11F — persistence read/write. M11G added real accounts on top: both
 * functions now accept an optional `sessionToken` and prefer it over the
 * self-reported `anonymousId` whenever it points at a valid, unexpired
 * session. `anonymousId` remains required and is still exactly what runs
 * for a signed-out browser - that path is unchanged from M11F.
 *
 * `saveAttempt` is a `mutation` (not an action) - it only reads/writes the
 * Convex database, no external calls, which is exactly what mutations are
 * for and queries/actions are deliberately not allowed to do reliably.
 *
 * `finalize()` in js/app.js calls saveAttempt as a best-effort background
 * sync right after its localStorage write - see js/app.js for why that's
 * fire-and-forget with `keepalive: true` rather than awaited.
 */

// A users row that has an email or password hash is a real, signed-up
// account. Those are reachable ONLY through a valid session token. The
// anonymousId of an upgraded account is a device identifier that can
// appear in requests and in old data, so it must never be enough on its
// own to read or write that account's history.
export function isAccountRow(user: any): boolean {
  return !!(user && (user.email || user.passwordHash));
}

// Finds the users row for a given anonymous client ID, creating one if
// this is the first time we've seen it. Only usable from a mutation
// (it writes), which is why saveAttempt's resolver is separate from
// listAttempts' read-only one below.
// Returns the guest user's id, creating a guest row if none exists yet.
// Returns null when this anonymousId belongs to a real account (see above).
async function getOrCreateUser(ctx: any, anonymousId: string) {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_anonymous_id", (q: any) => q.eq("anonymousId", anonymousId))
    .unique();
  if (existing) return isAccountRow(existing) ? null : existing._id;
  return await ctx.db.insert("users", { anonymousId, createdAt: Date.now() });
}

export async function findValidSessionUserId(ctx: any, sessionToken: string | null | undefined) {
  if (!sessionToken) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .unique();
  if (!session || session.expiresAt < Date.now()) return null;
  return session.userId;
}

// Write-capable resolver for saveAttempt (a mutation, so getOrCreateUser's
// insert is allowed). A stale/invalid token doesn't fail the save - it
// just falls through to the anonymous path, same as having no token at
// all, so a dropped or expired session never costs someone a quiz result.
// `authenticated` is true ONLY when a live session vouched for a real
// account: that is the sole condition under which per-question learning
// data is recorded (guests never get it, and it is never keyed by anonymousId).
async function resolveUserIdForWrite(ctx: any, sessionToken: string | null | undefined, anonymousId: string) {
  const sessionUserId = await findValidSessionUserId(ctx, sessionToken);
  if (sessionUserId) {
    const owner = await ctx.db.get(sessionUserId);
    return { userId: sessionUserId, authenticated: isAccountRow(owner) };
  }
  return { userId: await getOrCreateUser(ctx, anonymousId), authenticated: false };
}

// Read-only resolver for listAttempts (a query - cannot insert). No
// history yet for a brand-new anonymousId just means "no user row
// exists", which already means "no attempts" - no need to create one
// just to answer a read.
async function resolveUserIdForRead(ctx: any, sessionToken: string | null | undefined, anonymousId: string) {
  const sessionUserId = await findValidSessionUserId(ctx, sessionToken);
  if (sessionUserId) return sessionUserId;
  const anonUser = await ctx.db
    .query("users")
    .withIndex("by_anonymous_id", (q: any) => q.eq("anonymousId", anonymousId))
    .unique();
  if (!anonUser || isAccountRow(anonUser)) return null;
  return anonUser._id;
}

// M11H — request validation independent of the frontend. This call was
// always reachable directly against the Convex deployment, bypassing
// whatever the quiz engine itself would ever actually produce - so a
// crafted request with a huge `questions`/`answers` payload or absurd
// text fields could otherwise bloat storage indefinitely for free.
// Generous ceilings (matching MAX_QUESTION_COUNT in convex/quiz.ts, plus
// slack for a full mixed-type quiz with explanations) - meant to catch
// abuse, not constrain any real quiz this app can actually generate.
const MAX_TEXT_FIELD_CHARS = 300;
const MAX_PAYLOAD_BYTES = 300000; // ~300KB for questions+answers+topicPerformance combined

function validateAttemptPayload(attempt: {
  title: string;
  subject: string;
  sourceMaterial: string;
  questions: any;
  answers: any;
  topicPerformance: any;
}): string | null {
  if (attempt.title.length > MAX_TEXT_FIELD_CHARS) return "Title is too long.";
  if (attempt.subject.length > MAX_TEXT_FIELD_CHARS) return "Subject is too long.";
  if (attempt.sourceMaterial.length > MAX_TEXT_FIELD_CHARS) return "Source material label is too long.";
  let payloadSize = 0;
  try {
    payloadSize = JSON.stringify(attempt.questions).length + JSON.stringify(attempt.answers).length + JSON.stringify(attempt.topicPerformance).length;
  } catch {
    return "Attempt data could not be read.";
  }
  if (payloadSize > MAX_PAYLOAD_BYTES) return "Attempt data is too large.";
  return null;
}

export const saveAttempt = mutation({
  args: {
    anonymousId: v.string(),
    sessionToken: v.optional(v.string()),
    quizId: v.string(),
    title: v.string(),
    subject: v.string(),
    difficulty: v.string(),
    mode: v.string(),
    timeLimitMinutes: v.union(v.number(), v.null()),
    questionCount: v.number(),
    sourceMaterial: v.string(),
    retryOf: v.union(v.string(), v.null()),
    questions: v.any(),
    answers: v.any(),
    correctCount: v.number(),
    incorrectCount: v.number(),
    skippedCount: v.number(),
    score: v.number(),
    completionTimeSeconds: v.number(),
    topicPerformance: v.any(),
    // Phase C: optional link to a saved study material. Stored only when
    // the caller is signed in AND the material row belongs to that same
    // account - a foreign or missing id is silently dropped (the attempt
    // still saves; it just isn't linked).
    materialId: v.optional(v.id("materials")),
    // A2: how this quiz came to be ("normal" | "focused_history" |
    // "targeted_ai"). The schema union rejects anything else; an absent
    // value stays absent (older rows and normal quizzes).
    practiceSource: v.optional(v.union(v.literal("normal"), v.literal("focused_history"), v.literal("targeted_ai"))),
  },
  handler: async (ctx, args) => {
    const { anonymousId, sessionToken, materialId, practiceSource, ...attempt } = args;
    const payloadError = validateAttemptPayload(attempt);
    if (payloadError) {
      throw new ConvexError({ code: "invalid_request", message: payloadError });
    }
    const { userId, authenticated } = await resolveUserIdForWrite(ctx, sessionToken, anonymousId);
    if (!userId) {
      // This device id belongs to a signed-up account and no valid
      // session was presented (e.g. it expired). Refuse rather than
      // quietly writing into someone's account; the client keeps its
      // local copy and syncs again after signing in.
      throw new ConvexError({ code: "not_authenticated", message: "Please sign in again." });
    }
    // Phase C: verify ownership before linking. Only a live session's
    // account can link, and only to its own material rows.
    let verifiedMaterialId: typeof materialId | undefined = undefined;
    if (materialId && authenticated) {
      const material = await ctx.db.get(materialId);
      if (material && material.userId === userId) verifiedMaterialId = materialId;
    }
    const completedAt = Date.now();
    const attemptId = await ctx.db.insert("attempts", {
      userId,
      ...attempt,
      materialId: verifiedMaterialId,
      practiceSource: practiceSource ?? undefined,
      completedAt,
    });
    // F1: record lean per-question results, but only for a signed-in account.
    // deriveQuestionResults never throws (unreadable questions are skipped),
    // so the attempt above is always saved even if the results cannot be.
    if (authenticated) {
      for (const row of deriveQuestionResults({ ...attempt, completedAt })) {
        await ctx.db.insert("questionResults", { userId, attemptId, ...row });
      }
    }
    return { attemptId };
  },
});

export const listAttempts = query({
  args: { anonymousId: v.string(), sessionToken: v.optional(v.string()) },
  handler: async (ctx, { anonymousId, sessionToken }) => {
    const userId = await resolveUserIdForRead(ctx, sessionToken, anonymousId);
    if (!userId) return [];
    // Stabilization (M3): bounded — the full history (including question
    // blobs) used to ship on every dashboard/history/progress load with no
    // limit. 500 newest is generous for sync; older records remain in the
    // client's local store from earlier syncs.
    return await ctx.db
      .query("attempts")
      .withIndex("by_user_and_completed", (q) => q.eq("userId", userId))
      .order("desc")
      .take(500);
  },
});

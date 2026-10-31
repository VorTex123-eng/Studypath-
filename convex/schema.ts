import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * M11F — persistence schema.
 *
 * Deliberately two tables, not eight, despite the master plan listing
 * users/quizzes/questions/attempts/answers/results/progress/study-activity
 * as things needing a schema. See the M11F design note in the phase
 * report: quizzes/questions/answers/results collapse into one `attempts`
 * record (matching the already-proven denormalized shape from
 * localStorage['sessions']), and progress/study-activity are computed
 * queries over `attempts`, not stored entities.
 *
 * `questions` and `answers` inside `attempts` use v.any() rather than a
 * strict union schema. This is deliberate, not sloppy: every attempt
 * saved here has already passed through real structural validation
 * earlier in the pipeline (QuizValidate.validateQuiz client-side for
 * mock-generated quizzes, or convex/quiz.ts's validateQuiz for real
 * Gemini output) before it ever reaches this point. Re-encoding that
 * same mcq/true_false/short_answer union as a Convex validator here
 * would duplicate a check that already happened, not add real safety.
 */
export default defineSchema({
  users: defineTable({
    // A random ID generated client-side and stored in localStorage - NOT
    // a real authenticated identity. Every user row still has one (see
    // M11G note below on why), but it's no longer the only way to
    // identify a user once email/passwordHash are set.
    anonymousId: v.string(),
    createdAt: v.number(),

    // M11G - real accounts. Both optional because a purely-anonymous
    // guest row (never signed up) still exists with neither set - that
    // path is untouched, not torn out, per the original M11G plan.
    // On signup, either an existing anonymous row is upgraded in place
    // (user chose to claim their history - same _id, so every attempt
    // already linked via userId needs no migration at all), or a fresh
    // row is created with a synthetic anonymousId (declined/nothing to
    // claim) - see convex/auth.ts:signUp for the exact branching.
    email: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    // Phase 1 (2026-10-27): null/undefined = unverified. Set by
    // emailVerification:verifyCode, or at once by Google sign in
    // (googleAuth.ts), which Google has already verified. Existing
    // accounts predate this field and are treated as unverified until
    // they verify, with a prompt rather than a lockout.
    emailVerifiedAt: v.optional(v.number()),

    // Profile - collected at signup (name is required there), editable
    // later from Settings. avatarStorageId points into Convex's file
    // storage (the _storage system table), not a base64 blob in this
    // row - keeps document size sane and lets us reuse Convex's own
    // signed-URL serving instead of piping image bytes through queries.
    name: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    // Gemini age eligibility (2026-10-06): undefined = unknown (existing
    // users), true = confirmed 18+, false = confirmed under 18. Server-side
    // Gemini paths require true. See convex/lib/eligibility.ts.
    ageEligible: v.optional(v.boolean()),
  })
    .index("by_anonymous_id", ["anonymousId"])
    // Not a uniqueness *constraint* - Convex indexes don't enforce
    // that - so signUp still has to check for a collision itself
    // before inserting. This index just makes that check (and sign-in
    // lookups) fast instead of a full table scan.
    .index("by_email", ["email"]),

  // M11G - bearer session tokens. A signed-in browser holds one of these
  // tokens (in localStorage, same pattern as the anonymous ID) and sends
  // it alongside/instead of anonymousId; convex/attempts.ts prefers a
  // valid session's userId over the self-reported anonymousId whenever
  // one is present; getAnonId()/anonymousId remains the fallback for
  // guests. No separate "by_user" index yet - nothing needs "all of this
  // user's sessions" today (e.g. a future "sign out everywhere") - add
  // one then, don't speculate now.
  sessions: defineTable({
    token: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    // Added for account deletion: purgeUser removes every session a
    // deleted account still holds, not just the one that asked.
    .index("by_user", ["userId"]),

  // M11H - fixed-window rate limiting. `key` encodes everything that
  // scopes a bucket - e.g. "gen:burst:<userId>:<windowIndex>" - so one
  // generic table serves every scope/window combination convex/quiz.ts
  // needs, rather than a table per limit. Buckets for expired windows
  // are simply never read again (a new windowIndex means a new key) -
  // they just sit there unread. Fine at this app's scale; a scheduled
  // sweep to delete old ones would be the fix if that ever changes, not
  // needed today.
  rateLimitBuckets: defineTable({
    key: v.string(),
    count: v.number(),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  // In-app "Report a problem" on a question (Google Play's policy for apps
  // with AI-generated content expects a way to flag bad output). Read these
  // in the Convex dashboard. `userId` is set only for signed-in reporters so
  // account deletion can remove them; guests are stored without any link to
  // an identity.
  reports: defineTable({
    userId: v.optional(v.id("users")),
    quizId: v.string(),
    questionId: v.string(),
    questionText: v.string(),
    topic: v.string(),
    reason: v.string(),
    note: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  // F1: one lean row per graded question of an attempt saved by a SIGNED-IN
  // account. Derived from `attempts` (which stays the source of truth) so
  // per-topic queries never have to read 300KB attempt blobs. Never written
  // for guests, and ownership is always the session-resolved account - never
  // an anonymousId. `topic` is the human-readable name as generated;
  // `topicKey` is its canonical grouping key (see convex/lib/topics.ts);
  // `questionKey` recognises the same question across quizzes.
  questionResults: defineTable({
    userId: v.id("users"),
    attemptId: v.id("attempts"),
    quizId: v.string(),
    questionKey: v.string(),
    topic: v.string(),
    topicKey: v.string(),
    subject: v.string(),
    type: v.string(),
    difficulty: v.string(),
    mode: v.string(),
    retryOf: v.union(v.string(), v.null()),
    outcome: v.union(v.literal("correct"), v.literal("incorrect"), v.literal("skipped")),
    answeredAt: v.number(), // the attempt's completion time (no per-question timestamps exist)
  })
    .index("by_attempt", ["attemptId"])
    .index("by_user_and_time", ["userId", "answeredAt"])
    .index("by_user_and_topic", ["userId", "topicKey", "answeredAt"]),

  attempts: defineTable({
    userId: v.id("users"),

    // Quiz metadata - mirrors the session/result shape already used
    // throughout the existing frontend (js/app.js buildResultRecord).
    quizId: v.string(),
    title: v.string(),
    subject: v.string(),
    difficulty: v.string(),
    mode: v.string(),
    timeLimitMinutes: v.union(v.number(), v.null()),
    questionCount: v.number(),
    sourceMaterial: v.string(),
    retryOf: v.union(v.string(), v.null()),
    materialId: v.optional(v.id("materials")),
    // Phase C: optional link to the user's saved study material. Set only
    // when the quiz was generated from a library row the account owns;
    // deleting the material unlinks this (set back to undefined) rather
    // than deleting the attempt.
    practiceSource: v.optional(
      v.union(v.literal("normal"), v.literal("focused_history"), v.literal("targeted_ai"))
    ),
    // A2: how this quiz came to be. "normal" = regular Create Quiz flow,
    // "focused_history" = A1 past-questions practice, "targeted_ai" = A2
    // AI-generated targeted practice. Absent on older rows (treated as
    // normal). Lets future Progress/Analytics see whether targeted
    // practice moved the needle.

    // Full question set + the user's answers - see file-level note above
    // on why these are v.any() rather than a strict union schema.
    questions: v.any(),
    answers: v.any(),

    // Computed results (mirrors buildResultRecord's output exactly).
    correctCount: v.number(),
    incorrectCount: v.number(),
    skippedCount: v.number(),
    score: v.number(),
    completionTimeSeconds: v.number(),
    topicPerformance: v.any(),

    completedAt: v.number(), // Date.now() at save time, not an ISO string - easier to range-query later.
  })
    .index("by_user", ["userId"])
    .index("by_user_and_completed", ["userId", "completedAt"])
    .index("by_material", ["materialId"]),

  // ---------------------------------------------------------------------------
  // Phase C: saved study materials ("My Materials").
  //
  // A private, per-account library of study texts the user chose to keep for
  // reuse. Guests never get rows here: every write and read resolves the
  // owner from the session token server-side; there is no client-supplied
  // userId and no anonymousId path. The full extracted text lives only in
  // this table (never duplicated onto attempts) - attempts carry just an
  // optional materialId pointer, so deleting a material only unlinks
  // attempts instead of deleting quiz history.
  // ---------------------------------------------------------------------------
  materials: defineTable({
    userId: v.id("users"),
    title: v.string(), // user-provided, unique per account (enforced in convex/materials.ts)
    subject: v.optional(v.string()), // free-form label, e.g. "Biology"
    kind: v.union(
      v.literal("pdf"),
      v.literal("docx"),
      v.literal("txt"),
      v.literal("paste")
    ),
    extractedText: v.string(), // normalized text, 120-50,000 chars (server-validated on insert)
    charCount: v.number(), // denormalized length for list views (the list never returns extractedText)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_updated", ["userId", "updatedAt"])
    .index("by_user_and_title", ["userId", "title"]),

  // ---------------------------------------------------------------------------
  // Phase B1: AI Tutor conversations.
  //
  // Server-side persistence for material-grounded tutor chats. Every message
  // round-trips through the server, which owns the history — the client never
  // supplies context. userId is always the session-resolved account (tutor is
  // signed-in-only; materials are signed-in-only), never a client-provided id.
  // Bounded: 20 conversations per user (oldest pruned), 50 messages per
  // conversation (oldest pruned). Purged on account deletion (see
  // convex/accountCleanup.ts:purgeUserTutorData).
  // ---------------------------------------------------------------------------
  tutorConversations: defineTable({
    userId: v.id("users"),
    materialId: v.id("materials"),
    title: v.string(), // e.g. "Mitosis — Biology 101 Notes", derived from first question
    createdAt: v.number(),
    updatedAt: v.number(),
    // B1D: denormalized count for the history list (optional: older rows predate it).
    messageCount: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_updated", ["userId", "updatedAt"]),

  tutorMessages: defineTable({
    conversationId: v.id("tutorConversations"),
    userId: v.id("users"), // denormalized: ownership checks + deletion purge without a join
    role: v.union(v.literal("user"), v.literal("tutor")),
    text: v.string(),
    grounded: v.optional(v.boolean()), // tutor messages: was the answer grounded in the material?
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_user", ["userId"]),

  // Password recovery: single-use reset tokens. Only the SHA-256 hash of
  // the token is stored — the raw token exists only in the email link.
  passwordResets: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user", ["userId"]),

  // Phase 1: email verification codes. Only the SHA-256 hash of the
  // 6 digit code is stored; the raw code exists only in the email.
  // Phase 4: web push subscriptions, one row per device. endpoint and
  // keys come from the browser Push API; the user can delete their
  // account and these rows go with it via the account purge (add a
  // purge step there before production push use).
  pushSubscriptions: defineTable({
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    createdAt: v.number(),
    // Daily automation (2026-10-27): the reminder time the user set in
    // Settings, synced from the browser. Optional so older rows still work.
    reminderTime: v.optional(v.string()),
    remindersOn: v.optional(v.boolean()),
    lastReminderDate: v.optional(v.string()),
    lastReminderSentAt: v.optional(v.number()),
    lastGeneralSentAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  emailVerifications: defineTable({
    userId: v.id("users"),
    codeHash: v.string(),
    attempts: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});

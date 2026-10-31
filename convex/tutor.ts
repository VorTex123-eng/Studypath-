/**
 * B1 AI Tutor — server-side actions.
 *
 * Saved material → grounded tutor conversation. Reuses the shared AI layer:
 * - transport/retry/fallback: callGeminiJson + runWithFallback (convex/ai/model.ts)
 * - retrieval: extractPassages + buildTargetedContext (convex/lib/targetedRetrieval.ts,
 *   NOT modified — A2 stays frozen)
 * - rate limiting: fixed-window buckets (same pattern as convex/quiz.ts)
 * - errors: tutorErrorFor (mirrors A2's targetedErrorFor)
 * - ownership: session-resolved userId; material rows re-verified (mirrors
 *   convex/materials.ts:ownedMaterial)
 *
 * Auth model: tutor is signed-in-only (materials are signed-in-only). Every
 * entry resolves the user from the session token server-side; there is no
 * client-supplied userId and no anonymousId path. A foreign or missing
 * conversation/material returns the same not_found/material_unavailable as
 * a genuinely missing one — existence is never leaked across users.
 */

import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { findValidSessionUserId } from "./attempts";
import { requireGeminiEligibility, requireEmailVerified } from "./lib/eligibility";
import { callGeminiJson, getGeminiConfig, runWithFallback } from "./ai/model";
import {
  retrieveWithFollowupFallback,
  insufficientContextReply,
  buildTutorPrompt,
  TUTOR_RESPONSE_SCHEMA,
  validateTutorResponse,
  tutorErrorFor,
  TUTOR_MIN_EVIDENCE,
  TUTOR_MAX_MESSAGE_CHARS,
  TUTOR_MAX_MESSAGES_PER_CONVERSATION,
  TUTOR_MAX_CONVERSATIONS_PER_USER,
  TUTOR_HISTORY_WINDOW,
} from "./lib/tutorRetrieval";
import type { TutorHistoryMessage } from "./lib/tutorRetrieval";

// Tutor quota: separate keys from quiz generation so a generation block
// never silences the tutor and vice versa. Consumed once per sendMessage,
// before any model call. No refund on provider failure (documented in the
// B1 design note): 50/day is generous, and the retry loop is bounded.
const TUTOR_BURST_WINDOW_MS = 10 * 60 * 1000;
const TUTOR_BURST_LIMIT = 10;
const TUTOR_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TUTOR_DAILY_LIMIT = 50;

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

function tutorThrow(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/* ---------------- Internal helpers (never callable from the browser) ---------------- */

export const getTutorUser = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    const userId = await findValidSessionUserId(ctx, sessionToken);
    if (!userId) tutorThrow("not_authenticated", "Please sign in again to use the tutor.");
    return userId;
  },
});

export const getOwnedMaterial = internalQuery({
  args: { userId: v.id("users"), materialId: v.id("materials") },
  handler: async (ctx, { userId, materialId }) => {
    const material = await ctx.db.get(materialId);
    if (!material || String(material.userId) !== String(userId)) {
      tutorThrow("material_unavailable", "That saved material is no longer available.");
    }
    return { title: material.title as string, extractedText: material.extractedText as string };
  },
});

export const checkTutorRateLimit = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    const idKey = String(userId);
    const burstOk = await bumpBucket(
      ctx,
      `tutor:burst:${idKey}:${Math.floor(now / TUTOR_BURST_WINDOW_MS)}`,
      TUTOR_BURST_LIMIT
    );
    if (!burstOk) {
      tutorThrow("rate_limited", "You're sending tutor messages faster than we allow right now. Please wait a few minutes and try again.");
    }
    const dailyOk = await bumpBucket(
      ctx,
      `tutor:daily:${idKey}:${Math.floor(now / TUTOR_DAILY_WINDOW_MS)}`,
      TUTOR_DAILY_LIMIT
    );
    if (!dailyOk) {
      tutorThrow("rate_limited", "You've sent a lot of tutor messages today. Please try again tomorrow.");
    }
    return { ok: true as const };
  },
});

export const createConversation = internalMutation({
  args: { userId: v.id("users"), materialId: v.id("materials"), title: v.string() },
  handler: async (ctx, { userId, materialId, title }) => {
    // Cap conversations per user; prune the oldest so the table stays bounded.
    const existing = await ctx.db
      .query("tutorConversations")
      .withIndex("by_user_and_updated", (q: any) => q.eq("userId", userId))
      .order("asc")
      .take(TUTOR_MAX_CONVERSATIONS_PER_USER);
    if (existing.length >= TUTOR_MAX_CONVERSATIONS_PER_USER) {
      await ctx.db.delete(existing[0]._id);
      const oldMsgs = await ctx.db
        .query("tutorMessages")
        .withIndex("by_conversation", (q: any) => q.eq("conversationId", existing[0]._id))
        .take(TUTOR_MAX_MESSAGES_PER_CONVERSATION);
      for (const m of oldMsgs) await ctx.db.delete(m._id);
    }
    const now = Date.now();
    return await ctx.db.insert("tutorConversations", {
      userId,
      materialId,
      title: title.slice(0, 80),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const loadConversation = internalQuery({
  args: { userId: v.id("users"), conversationId: v.id("tutorConversations") },
  handler: async (ctx, { userId, conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    // Same error for missing and foreign: never leak another user's data.
    if (!conversation || String(conversation.userId) !== String(userId)) {
      tutorThrow("not_found", "That conversation wasn't found.");
    }
    const messages = await ctx.db
      .query("tutorMessages")
      .withIndex("by_conversation", (q: any) => q.eq("conversationId", conversationId))
      .order("asc")
      .take(TUTOR_MAX_MESSAGES_PER_CONVERSATION);
    messages.sort((a: any, b: any) => a.createdAt - b.createdAt);
    return {
      conversation: {
        id: conversation._id,
        materialId: conversation.materialId,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
      },
      messages: messages.map((m: any) => ({
        id: m._id,
        role: m.role,
        text: m.text,
        grounded: m.grounded ?? null,
        createdAt: m.createdAt,
      })),
    };
  },
});

export const saveMessages = internalMutation({
  args: {
    userId: v.id("users"),
    conversationId: v.id("tutorConversations"),
    userText: v.string(),
    tutorText: v.string(),
    grounded: v.boolean(),
  },
  handler: async (ctx, { userId, conversationId, userText, tutorText, grounded }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || String(conversation.userId) !== String(userId)) {
      tutorThrow("not_found", "That conversation wasn't found.");
    }
    const now = Date.now();
    await ctx.db.insert("tutorMessages", {
      conversationId, userId, role: "user", text: userText, createdAt: now,
    });
    const tutorMsgId = await ctx.db.insert("tutorMessages", {
      conversationId, userId, role: "tutor", text: tutorText, grounded, createdAt: now + 1,
    });
    // Keep the conversation bounded: prune oldest beyond the cap.
    const msgs = await ctx.db
      .query("tutorMessages")
      .withIndex("by_conversation", (q: any) => q.eq("conversationId", conversationId))
      .order("asc")
      .take(TUTOR_MAX_MESSAGES_PER_CONVERSATION + 2);
    const excess = msgs.length - TUTOR_MAX_MESSAGES_PER_CONVERSATION;
    for (let i = 0; i < excess; i++) await ctx.db.delete(msgs[i]._id);
    await ctx.db.patch(conversationId, {
      updatedAt: now,
      messageCount: (conversation.messageCount || 0) + 2,
    });
    return { tutorMessageId: tutorMsgId };
  },
});

/**
 * B1D: delete one conversation and all its messages. Ownership is verified
 * server-side; a foreign conversationId looks exactly like a missing one.
 */
export const deleteConversationRow = internalMutation({
  args: { userId: v.id("users"), conversationId: v.id("tutorConversations") },
  handler: async (ctx, { userId, conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation || String(conversation.userId) !== String(userId)) {
      tutorThrow("not_found", "That conversation wasn't found.");
    }
    const msgs = await ctx.db
      .query("tutorMessages")
      .withIndex("by_conversation", (q: any) => q.eq("conversationId", conversationId))
      .take(TUTOR_MAX_MESSAGES_PER_CONVERSATION + 2);
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(conversationId);
    return { ok: true };
  },
});

/** Public action: delete one of the caller's tutor conversations. */
export const deleteConversation = action({
  args: { sessionToken: v.string(), conversationId: v.id("tutorConversations") },
  handler: async (ctx, args) => {
    try {
      const userId: any = await ctx.runQuery(internal.tutor.getTutorUser, {
        sessionToken: args.sessionToken,
      });
      await ctx.runMutation(internal.tutor.deleteConversationRow, {
        userId,
        conversationId: args.conversationId,
      });
      return { ok: true };
    } catch (err) {
      throw new ConvexError(tutorErrorFor(err));
    }
  },
});

export const listUserConversations = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("tutorConversations")
      .withIndex("by_user_and_updated", (q: any) => q.eq("userId", userId))
      .order("desc")
      .take(TUTOR_MAX_CONVERSATIONS_PER_USER);
    return rows.map((c: any) => ({
      id: c._id,
      materialId: c.materialId,
      title: c.title,
      updatedAt: c.updatedAt,
      messageCount: c.messageCount || 0,
    }));
  },
});

/* ---------------- Public actions ---------------- */

/**
 * Open a tutor conversation on one of the caller's saved materials.
 * The material is re-verified ownership-side; a foreign materialId looks
 * exactly like a missing one.
 */
export const startConversation = action({
  args: {
    sessionToken: v.string(),
    materialId: v.id("materials"),
    // B1D: optional first question (quiz "Ask Tutor why", weak-area "explain").
    // Answered through the normal grounded pipeline in this same action.
    initialMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const userId: any = await ctx.runQuery(internal.tutor.getTutorUser, {
        sessionToken: args.sessionToken,
      });
      const material = await ctx.runQuery(internal.tutor.getOwnedMaterial, {
        userId,
        materialId: args.materialId,
      });
      const conversationId = await ctx.runMutation(internal.tutor.createConversation, {
        userId,
        materialId: args.materialId,
        title: material.title,
      });
      const initial = String(args.initialMessage || "").trim();
      if (initial) {
        if (initial.length > TUTOR_MAX_MESSAGE_CHARS) {
          tutorThrow("bad_request", "That message wasn't valid. Please try again.");
        }
        // Rate limit before any AI spend, same as sendMessage.
        await ctx.runMutation(internal.tutor.checkTutorRateLimit, { userId });
        const first = await answerTutorQuestion(ctx, {
          userId,
          conversationId,
          material,
          history: [],
          text: initial,
        });
        return { conversationId, materialTitle: material.title, firstAnswer: first.answer, firstGrounded: first.groundedInMaterial };
      }
      return { conversationId, materialTitle: material.title };
    } catch (err) {
      throw new ConvexError(tutorErrorFor(err));
    }
  },
});

/**
 * Send one tutor message. Full pipeline: auth → ownership → validate →
 * rate limit → bounded retrieval → (insufficient → honest fixed reply) →
 * prompt + history → model w/ validation → persist both messages.
 */
export const sendMessage = action({
  args: {
    sessionToken: v.string(),
    conversationId: v.id("tutorConversations"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      return await sendMessageInner(ctx, args);
    } catch (err) {
      // Never leak raw provider text: every failure maps to a fixed,
      // user-safe message. Codes + details stay in server logs.
      throw new ConvexError(tutorErrorFor(err));
    }
  },
});

/**
 * B1D: core answer pipeline shared by sendMessage and startConversation's
 * optional initialMessage. The caller must already have: authenticated the
 * user, ownership-verified the material, validated text, and passed the rate
 * limit. Runs: bounded retrieval -> (insufficient -> honest fixed reply) ->
 * prompt + history -> model w/ validation -> persist both messages.
 */
async function answerTutorQuestion(
  ctx: any,
  args: {
    userId: any;
    conversationId: any;
    material: any;
    history: TutorHistoryMessage[];
    text: string;
  }
) {
  const { userId, conversationId, material, history, text } = args;
  // Age eligibility (2026-10-06): central gate for every Tutor answer,
  // covering sendMessage and startConversation-with-initialMessage.
  await requireGeminiEligibility(ctx, userId);
  await requireEmailVerified(ctx, userId);
  const prevUser = [...history].reverse().find((m) => m.role === "user");
  const { evidence, contextText } = retrieveWithFollowupFallback(
    text,
    prevUser ? prevUser.text : null,
    material.extractedText
  );

  let answer: string;
  let grounded: boolean;
  if (evidence < TUTOR_MIN_EVIDENCE || !contextText) {
    // Honest path: the material has nothing usable. Deterministic, no
    // model call — saves quota and cannot hallucinate.
    answer = insufficientContextReply(material.title);
    grounded = false;
  } else {
    const { apiKey, model, fallbackModel } = getGeminiConfig();
    if (!apiKey) {
      tutorThrow(
        "not_configured",
        "The tutor isn't available right now. Please try again later."
      );
    }
    const prompt = buildTutorPrompt({
      materialTitle: material.title,
      contextText,
      history,
      question: text,
    });
    const output = await runWithFallback({
      logTag: "tutor.sendMessage",
      model,
      fallbackModel,
      attempt: async (modelName: string, retryNote: string) => {
        const finalPrompt = retryNote
          ? `${prompt}\n\nCorrection needed before you reply: ${retryNote}`
          : prompt;
        const res = await callGeminiJson({
          apiKey: apiKey as string,
          model: modelName,
          prompt: finalPrompt,
          responseSchema: TUTOR_RESPONSE_SCHEMA,
          logTag: "tutor.sendMessage",
        });
        if (!res.ok) return res;
        const valid = validateTutorResponse(res.parsed);
        if (!valid) {
          return {
            ok: false as const,
            code: "validation_failed",
            message: "Tutor response failed validation.",
          };
        }
        return { ok: true as const, value: valid };
      },
      validationRetryNote: (msg: string) =>
        `Your previous reply was not valid (${msg}). Reply with ONLY the JSON object {"answer": string, "groundedInMaterial": boolean}.`,
    });
    answer = output.answer;
    grounded = output.groundedInMaterial;
  }

  await ctx.runMutation(internal.tutor.saveMessages, {
    userId,
    conversationId,
    userText: text,
    tutorText: answer,
    grounded,
  });
  return { answer, groundedInMaterial: grounded };
}

async function sendMessageInner(
  ctx: any,
  args: { sessionToken: string; conversationId: any; message: string }
) {
  const userId: any = await ctx.runQuery(internal.tutor.getTutorUser, {
    sessionToken: args.sessionToken,
  });

  const text = String(args.message || "").trim();
  if (!text || text.length > TUTOR_MAX_MESSAGE_CHARS) {
    tutorThrow("bad_request", "That message wasn't valid. Please try again.");
  }

  const loaded: any = await ctx.runQuery(internal.tutor.loadConversation, {
    userId,
    conversationId: args.conversationId,
  });

  // Rate limit before any AI spend.
  await ctx.runMutation(internal.tutor.checkTutorRateLimit, { userId });

  const material = await ctx.runQuery(internal.tutor.getOwnedMaterial, {
    userId,
    materialId: loaded.conversation.materialId,
  });

  // Bounded retrieval: current question, with one follow-up fallback pass
  // (previous user message's terms) for pronoun/ellipsis follow-ups.
  const history: TutorHistoryMessage[] = loaded.messages
    .slice(-TUTOR_HISTORY_WINDOW)
    .map((m: any) => ({ role: m.role as "user" | "tutor", text: m.text }));
  return answerTutorQuestion(ctx, {
    userId,
    conversationId: args.conversationId,
    material,
    history,
    text,
  });
}

/** Load one conversation (ownership-checked). Used to resume after refresh. */
export const getConversation = action({
  args: { sessionToken: v.string(), conversationId: v.id("tutorConversations") },
  handler: async (ctx, args) => {
    try {
      const userId: any = await ctx.runQuery(internal.tutor.getTutorUser, {
        sessionToken: args.sessionToken,
      });
      const loaded: any = await ctx.runQuery(internal.tutor.loadConversation, {
        userId,
        conversationId: args.conversationId,
      });
      const material = await ctx.runQuery(internal.tutor.getOwnedMaterial, {
        userId,
        materialId: loaded.conversation.materialId,
      });
      return { ...loaded, materialTitle: material.title };
    } catch (err) {
      throw new ConvexError(tutorErrorFor(err));
    }
  },
});

/** The caller's conversations, newest first. Surfaced by the B1D
 *  "Recent conversations" list on tutor.html. Returns { conversations: [...] }
 *  (stable object shape — the frontend reads res.data.conversations). */
export const listConversations = action({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    try {
      const userId: any = await ctx.runQuery(internal.tutor.getTutorUser, {
        sessionToken: args.sessionToken,
      });
      // Stable object shape: the frontend reads res.data.conversations.
      // Returning the bare array here once broke Recent conversations
      // silently (res.data.conversations was undefined). Do not regress.
      return {
        conversations: await ctx.runQuery(internal.tutor.listUserConversations, { userId }),
      };
    } catch (err) {
      throw new ConvexError(tutorErrorFor(err));
    }
  },
});

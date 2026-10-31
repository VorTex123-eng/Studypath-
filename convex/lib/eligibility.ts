/* Gemini age eligibility enforcement (2026-10-06).
 *
 * Google's Gemini API Additional Terms (effective 2026-03-23, verified on
 * https://ai.google.dev/gemini-api/terms) state:
 *
 *   "You must be 18 years of age or older to use the APIs. You also will
 *    not use the Services as part of a website, application, or other
 *    service (collectively, "API Clients") that is directed towards or is
 *    likely to be accessed by individuals under the age of 18."
 *
 * Studypath's target audience is Nigerian/African students (UTME/PUTME),
 * where under-18 users are foreseeable. To comply, every server-side path
 * that invokes Gemini must verify the caller's age eligibility.
 *
 * Eligibility model (users.ageEligible):
 *   undefined/false => unknown or ineligible => Gemini calls blocked
 *   true            => confirmed 18+ => Gemini calls allowed
 *
 * This module centralizes the check so future Gemini features cannot
 * accidentally bypass it. Frontend prompts are UX only; enforcement here
 * is the authority.
 */
import { ConvexError } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

export const ELIGIBILITY_ERROR_CODE = "age_not_eligible";

export function eligibilityError(): never {
  throw new ConvexError({
    code: ELIGIBILITY_ERROR_CODE,
    message:
      "AI features require confirming you are 18 or older. Please complete the age check to continue.",
  });
}

/**
 * Database read for the eligibility gate. Runs as an internal query so
 * the check uses ctx.runQuery — the same surface every other database
 * access in the tutor/quiz actions already uses — rather than depending
 * on the action context's own db client.
 */
export const checkAgeEligibility = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return user?.ageEligible === true;
  },
});

/**
 * Server-side gate. Call with the authenticated userId (from the session,
 * never from client input) before any Gemini invocation.
 */
export async function requireGeminiEligibility(ctx: any, userId: any): Promise<void> {
  if (!userId) eligibilityError();
  const eligible = await ctx.runQuery(internal.lib.eligibility.checkAgeEligibility, { userId });
  if (!eligible) eligibilityError();
}

/* Phase 1 (2026-10-27): email verification gate for Gemini and for
 * saving materials. Guests have no userId and are already blocked by
 * the age gate; signed-in accounts with no emailVerifiedAt are blocked
 * here with a distinct code so the frontend can show the verify banner
 * instead of the age prompt. Google accounts are verified at sign in.
 * Existing accounts are prompted, not locked out of browsing, history
 * or settings: only the gated paths below call this. */
export const EMAIL_NOT_VERIFIED_CODE = "email_not_verified";

export function emailNotVerifiedError(): never {
  throw new ConvexError({
    code: EMAIL_NOT_VERIFIED_CODE,
    message: "Please verify your email address to use AI features and save materials.",
  });
}

export const checkEmailVerified = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return !!(user && user.emailVerifiedAt);
  },
});

export async function requireEmailVerified(ctx: any, userId: any): Promise<void> {
  if (!userId) emailNotVerifiedError();
  const verified = await ctx.runQuery(internal.lib.eligibility.checkEmailVerified, { userId });
  if (!verified) emailNotVerifiedError();
}

/**
 * Non-throwing check for UI state (e.g. "should we show the age prompt?").
 */
export async function isGeminiEligible(ctx: any, userId: any): Promise<boolean> {
  if (!userId) return false;
  const user = await ctx.db.get(userId);
  return !!user && user.ageEligible === true;
}

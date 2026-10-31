import { query } from "./_generated/server";
import { v } from "convex/values";
import { computeQuestionsToRevisit } from "./lib/revisit";
import { loadOwnResultRows } from "./lib/ownRows";

/**
 * Questions to revisit: individual questions the signed-in student missed
 * and has not answered correctly since (see ./lib/revisit). Returns only
 * identifiers and counts - the question text itself stays in the student's
 * own attempts, and the browser resolves it from history it already holds.
 *
 * Same security shape as getWeakAreas: the user comes from the session token
 * only, there are no userId/anonymousId arguments, guests get
 * `not_authenticated`, and the read is bounded.
 */
export const getQuestionsToRevisit = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const own = await loadOwnResultRows(ctx, sessionToken);
    if (!own.ok) {
      return { ok: false as const, error: { code: "not_authenticated", message: "Please sign in to see this." } };
    }
    return { ok: true as const, ...computeQuestionsToRevisit(own.rows as any), truncated: own.truncated };
  },
});

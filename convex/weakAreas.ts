import { query } from "./_generated/server";
import { v } from "convex/values";
import { computeWeakAreas } from "./lib/weakness";
import { loadOwnResultRows } from "./lib/ownRows";

/**
 * A1: the one authoritative weak-area calculation.
 *
 * Signed-in accounts only. The user is ALWAYS derived from the session
 * token on the server - there is no userId or anonymousId argument, so there
 * is nothing a client could pass to look at someone else's data, and a guest
 * (no session) simply gets `not_authenticated`.
 *
 * Reads only the caller's own questionResults, newest first, capped (see
 * ./lib/ownRows) so the query stays bounded however long the history grows.
 * If a history is longer than the cap, only the most recent answers are
 * scored and `truncated` says so. The scoring itself lives in ./lib/weakness
 * (pure, documented, unit-tested).
 */
export const getWeakAreas = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, { sessionToken }) => {
    const own = await loadOwnResultRows(ctx, sessionToken);
    if (!own.ok) {
      return { ok: false as const, error: { code: "not_authenticated", message: "Please sign in to see your weak areas." } };
    }
    const report = computeWeakAreas(own.rows as any);
    return { ok: true as const, ...report, evaluatedAnswers: own.rows.length, truncated: own.truncated };
  },
});

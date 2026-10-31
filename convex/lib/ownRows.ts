import { findValidSessionUserId, isAccountRow } from "../attempts";

/**
 * Shared, bounded read of the CALLER's own questionResults (A1 + patch).
 *
 * The user is always derived from the session token on the server; there is
 * no way to name another user. Guests (no session) and expired/invalid
 * sessions get `not_authenticated`. Reads at most `max` newest rows via the
 * by_user_and_time index, returned oldest first (ties in creation order).
 */
export const MAX_RESULT_ROWS = 3000;

export async function loadOwnResultRows(ctx: any, sessionToken: string | undefined | null, max: number = MAX_RESULT_ROWS) {
  const userId = await findValidSessionUserId(ctx, sessionToken);
  const user = userId ? await ctx.db.get(userId) : null;
  if (!userId || !isAccountRow(user)) {
    return { ok: false as const, error: { code: "not_authenticated", message: "Please sign in to see this." } };
  }
  const newestFirst = await ctx.db
    .query("questionResults")
    .withIndex("by_user_and_time", (q: any) => q.eq("userId", userId))
    .order("desc")
    .take(max + 1);
  return {
    ok: true as const,
    rows: newestFirst.slice(0, max).reverse() as any[],
    truncated: newestFirst.length > max,
    userId,
  };
}

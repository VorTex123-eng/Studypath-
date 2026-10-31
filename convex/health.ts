import { query } from "./_generated/server";

/**
 * M11B connectivity check only.
 *
 * A harmless, read-only query: no arguments in, no side effects, no data
 * access. Its only job is to prove that Frontend -> Convex -> response ->
 * Frontend actually works before anything real (material processing,
 * Gemini calls, persistence) is built on top of it.
 *
 * This is a `query` (not a mutation or action) deliberately - it reads
 * nothing and writes nothing, so it belongs in the most restrictive
 * Convex function type available.
 */
export const ping = query({
  args: {},
  handler: async () => {
    return {
      status: "ok",
      service: "studypath-convex",
      time: Date.now(),
    };
  },
});

import { cleanTopicLabel, topicKeyFor } from "./topics";

/**
 * Topic names a learner already has (A1 patch). Fed to quiz generation so new
 * questions reuse established names instead of inventing variants.
 *
 * Pure and deterministic. Rows are the learner's own questionResults (the
 * caller guarantees ownership). Rules:
 *  - Group by the canonical topic key (counter artefacts stripped), so
 *    "State Capitals 1/1" and "state capitals" are one topic.
 *  - The display name is the most frequent cleaned spelling (ties: shorter,
 *    then alphabetical) - readable, never an artefact variant.
 *  - Only topics seen on at least 2 questions qualify, plus single-question
 *    topics from the SAME source label (same material): this stops one-off,
 *    over-specific names from being promoted to "known".
 *  - Order: topics from the same source first, then by how many questions
 *    they cover, then by key. Capped, so the prompt stays small.
 */
export const MAX_KNOWN_TOPICS = 25;
const MAX_NAME_CHARS = 60;

export function sanitizeTopicName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f"`\\]/g, " ") // control chars and quote-like characters can't break out of the prompt list
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
}

export function collectKnownTopics(
  rows: { topic: string; subject: string }[],
  subject: string,
  cap: number = MAX_KNOWN_TOPICS
): string[] {
  const groups = new Map<string, { labels: Map<string, number>; count: number; sameSubject: number }>();
  for (const r of rows) {
    const label = cleanTopicLabel(r.topic);
    if (!label) continue;
    const key = topicKeyFor(label);
    if (key === "general") continue;
    const g = groups.get(key) || { labels: new Map<string, number>(), count: 0, sameSubject: 0 };
    g.labels.set(label, (g.labels.get(label) || 0) + 1);
    g.count++;
    if (r.subject === subject) g.sameSubject++;
    groups.set(key, g);
  }
  const eligible = [...groups.entries()]
    .filter(([, g]) => g.count >= 2 || g.sameSubject >= 1)
    .map(([key, g]) => {
      const best = [...g.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))[0][0];
      return { key, name: sanitizeTopicName(best), count: g.count, same: g.sameSubject > 0 };
    })
    .filter((t) => t.name.length > 0);
  eligible.sort((a, b) => Number(b.same) - Number(a.same) || b.count - a.count || (a.key < b.key ? -1 : 1));
  return eligible.slice(0, cap).map((t) => t.name);
}

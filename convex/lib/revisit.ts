import { cleanTopicLabel } from "./topics";

/**
 * "Questions to revisit" (A1 patch). Pure and deterministic.
 *
 * A different signal from weak areas. Weak areas are recurring evidence
 * at TOPIC level and need a sample; this is about INDIVIDUAL QUESTIONS the
 * student previously got wrong, and needs no sample at all - one miss is
 * enough - so it does not depend on how a topic happens to be named.
 *
 * A question is identified by its questionKey (type + normalised text), so
 * the same question is recognised across quizzes, retries and practice sets
 * whatever topic label each quiz gave it.
 *
 * Rules, per question, over every time it was answered (oldest first):
 *  - If the MOST RECENT answer was correct, it is dropped: the student has
 *    since shown they can answer it.
 *  - Otherwise it qualifies. Its priority is the weight of the misses since
 *    the last correct answer (wrong = 1, skipped = 0.5), so a question missed
 *    several times outranks one missed once, and wrong outranks skipped.
 *  - Ties: the more recently missed first, then questionKey (determinism).
 * Duplicates cannot occur: one entry per questionKey.
 */
export type RevisitRow = {
  questionKey: string;
  subject: string;
  topic: string;
  type: string;
  outcome: "correct" | "incorrect" | "skipped";
  answeredAt: number;
};

export type RevisitItem = {
  questionKey: string;
  subject: string; // subject of the most recent answer (context only - grouping is per-question)
  topic: string;
  type: string;
  misses: number; // misses since the last correct answer
  lastOutcome: "incorrect" | "skipped";
  lastAnsweredAt: number;
  priority: number;
};

export const MAX_REVISIT = 15; // one practice set

export function computeQuestionsToRevisit(rowsInput: RevisitRow[], limit: number = MAX_REVISIT): { total: number; repeated: number; items: RevisitItem[] } {
  const rows = rowsInput.map((r, i) => ({ r, i })).sort((a, b) => a.r.answeredAt - b.r.answeredAt || a.i - b.i).map((x) => x.r);
  const byQuestion = new Map<string, RevisitRow[]>();
  for (const r of rows) {
    const list = byQuestion.get(r.questionKey);
    if (list) list.push(r); else byQuestion.set(r.questionKey, [r]);
  }
  const eligible: RevisitItem[] = [];
  for (const [questionKey, history] of byQuestion) {
    const last = history[history.length - 1];
    if (last.outcome === "correct") continue;
    let lastCorrect = -1;
    for (let i = history.length - 1; i >= 0; i--) if (history[i].outcome === "correct") { lastCorrect = i; break; }
    const tail = history.slice(lastCorrect + 1);
    eligible.push({
      questionKey,
      subject: typeof last.subject === "string" ? last.subject : "",
      topic: cleanTopicLabel(last.topic) || last.topic,
      type: last.type,
      misses: tail.length,
      lastOutcome: last.outcome as "incorrect" | "skipped",
      lastAnsweredAt: last.answeredAt,
      priority: tail.reduce((sum, r) => sum + (r.outcome === "skipped" ? 0.5 : 1), 0),
    });
  }
  eligible.sort((a, b) => b.priority - a.priority || b.lastAnsweredAt - a.lastAnsweredAt || (a.questionKey < b.questionKey ? -1 : 1));
  return {
    total: eligible.length,
    repeated: eligible.filter((e) => e.misses >= 2).length,
    items: eligible.slice(0, limit),
  };
}

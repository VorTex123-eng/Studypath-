import { topicKeyFor, cleanTopicLabel } from "./topics";

/**
 * Weak-area scoring (A1). Pure and deterministic: rows in, report out. No
 * database access, no clock, no randomness - the same rows always give the
 * same report, so every rule below is unit-testable.
 *
 * INPUT  questionResults rows (one per graded question, F1), oldest first.
 * OUTPUT one entry per subject+topic bucket (subjectKey + topicKey), with a
 * status:
 *
 *   insufficient  not enough independent evidence to say anything
 *   emerging      an early sign of a weak spot; more data would confirm it
 *   established   persistent weakness, backed by enough evidence
 *   improving     was weak, has recovered over recent quizzes
 *   solid         performing fine (never shown as a weakness)
 *
 * WEAK-AREA IDENTITY = SUBJECT + TOPIC. Rows are grouped by
 * subjectKeyFor(row.subject) + "|" + topicKeyFor(row.topic), so
 * "Mathematics + Waves" and "Physics + Waves" are independent buckets even
 * though the topic name is identical. Subject is the application-owned quiz
 * context (never derived from topic); topic is the AI/question-level
 * concept. A wrong merge here would silently mix two subjects' learning
 * data, so the subject key is deliberately light (see subjectKeyFor) -
 * a missed merge only splits one subject's data, never contaminates.
 *
 * HOW A TOPIC IS SCORED
 *
 * 1. Independent evidence vs repeats. A row is a REPEAT exposure when the
 *    quiz was a retry (retryOf set) or a practice set, or when the same
 *    question (questionKey) was already answered in an earlier quiz. Repeats
 *    are not independent evidence - the student has seen the question - so
 *    they count with weight 0.35 in the mastery estimate and are never counted
 *    toward the amount of evidence (N). They DO feed the repeated-miss and
 *    "improved after review" signals. First exposures weigh 1.
 *
 * 2. Recency. Each row is weighted 0.5^(age / 21 days), floored at 0.2, where
 *    age is measured from the topic's most recent row (not from today). That
 *    makes recent work count several times more than old work, while old
 *    evidence is never discarded (the floor), and a topic you simply have not
 *    touched lately keeps the picture it had (staleness is a different
 *    question, left to spaced review).
 *
 * 3. Difficulty (context, mild). A miss on an easy quiz is stronger evidence
 *    of weakness than a miss on a hard one, and a hit on a hard quiz is
 *    stronger evidence of mastery. Miss weight: easy 1.25, medium 1, hard 0.8,
 *    expert 0.65. Hit weight: easy 0.8, medium 1, hard 1.2, expert 1.4. Any
 *    other value ("mixed") is 1. The multipliers are deliberately small so a
 *    little data cannot swing the result.
 *
 * 4. Skips. A skipped question counts as half a miss (it may be a timeout or
 *    a guess not made) and is reported separately as a skip rate.
 *
 * 5. Sample-size protection (shrinkage). Mastery is the mean of a Beta
 *    posterior that starts from a neutral prior of 70% worth 4 questions
 *    (alpha 2.8, beta 1.2) and adds the weighted hits and misses. Little data
 *    stays near the prior; a lot of data dominates it. `upper` is a one-sided
 *    ~90% bound (mean + 1.28 sd) - "even being generous, mastery is below X".
 *
 * 6. Status rules, in this order:
 *      N < 4                                        -> insufficient
 *      improving (see 7)                            -> improving
 *      N >= 8, >= 2 quizzes, upper < 0.70, mean < 0.60 -> established
 *      N >= 4 AND >= 2 missed/skipped answers AND
 *        (mean < 0.65, or 2+ unresolved repeated misses with mean < 0.72)
 *                                                   -> emerging ("Early sign")
 *      otherwise                                    -> solid
 *    A single mistake can never produce an Early sign - it takes at least
 *    four independent answers of which at least two were missed or skipped
 *    (patch: 1 miss in 3 used to tip over 65% on an easy quiz because of the
 *    difficulty weighting). One bad quiz can also never make a topic
 *    "established": that needs at least 8 independent questions spread over
 *    at least 2 quizzes.
 *
 * 7. Improvement. With at least 3 quizzes of independent evidence, compare
 *    the older half of the quizzes with the newer half (each needing at least
 *    4 questions): improving = older accuracy < 65%, newer accuracy >= 70%,
 *    and a rise of at least 20 points. Whole quizzes are compared, so one
 *    lucky quiz cannot flip it.
 *
 * 8. Priority score (0-100, used only to rank): 100 x (1 - mean), plus up to
 *    10 for unresolved repeated misses (4 each) and up to 6 for a run of
 *    recent misses (2 per miss beyond the first). "Repeated miss" = the same
 *    question answered wrongly or skipped at least twice with no correct
 *    answer since.
 *
 * 9. Question type. If a topic has two or more types with at least 4 first
 *    exposures each, and the weakest type's mastery is below 55% and at least
 *    25 points below the strongest, the weakness is reported as type-specific
 *    ("mainly short answer") instead of being spread over the whole topic.
 *
 * Canonical topics: rows are grouped by topicKeyFor(row.topic), recomputed at
 * read time from the stored display name with the CURRENT key rule. Stored
 * topicKey values are never rewritten, so history written under the older
 * rule (e.g. "State Capitals 1/1") joins its cleaner siblings automatically,
 * with no migration. No semantic merging here. Since the subject/topic
 * contamination fix, the grouping key is subjectKeyFor(row.subject) + "|" +
 * topicKeyFor(row.topic) - see above.
 */

export type Outcome = "correct" | "incorrect" | "skipped";

export type ResultRow = {
  subject: string;
  topicKey: string;
  topic: string;
  questionKey: string;
  quizId: string;
  retryOf: string | null;
  type: string;
  difficulty: string;
  outcome: Outcome;
  answeredAt: number;
};

export type WeakStatus = "insufficient" | "emerging" | "established" | "improving" | "solid";

export type WeakArea = {
  topicKey: string;
  subjectKey: string; // canonical subject identity of this bucket
  subject: string; // display form (cleaned); "" when the rows carry none
  topic: string;
  topicVariants: string[];
  status: WeakStatus;
  score: number;
  mastery: number; // percent, shrunk estimate
  questions: number; // independent (first-exposure) answers
  quizzes: number;
  correct: number;
  accuracy: number; // percent of first-exposure answers correct
  skipped: number;
  skipRate: number; // percent
  highSkipRate: boolean;
  repeatedMisses: number;
  recovered: number;
  recentMissStreak: number;
  recentAccuracy: number | null; // percent, only when improvement could be assessed
  priorAccuracy: number | null;
  weakestType: { type: string; mastery: number; questions: number } | null;
  typeSpecific: boolean;
  reason: string;
  lastPracticedAt: number;
};

export type WeakReport = {
  areas: WeakArea[]; // established, then emerging, then improving; capped
  summary: { tracked: number; insufficient: number; solid: number; emerging: number; established: number; improving: number };
};

// ---- tunables (documented above) ----
export const PRIOR_ALPHA = 2.8;
export const PRIOR_BETA = 1.2;
export const HALF_LIFE_DAYS = 21;
export const RECENCY_FLOOR = 0.2;
export const REPEAT_WEIGHT = 0.35;
export const SKIP_MISS_FACTOR = 0.5;
export const MIN_EVIDENCE = 4; // fewer independent answers than this is never enough
export const EMERGING_MIN_MISSES = 2; // missed or skipped, independent answers only
export const ESTABLISHED_MIN_QUESTIONS = 8;
export const ESTABLISHED_MIN_QUIZZES = 2;
export const UPPER_Z = 1.28;
export const MAX_AREAS = 12;
export const MAX_VARIANTS = 12;

const DAY_MS = 86400000;
const MISS_DIFFICULTY: Record<string, number> = { easy: 1.25, medium: 1, hard: 0.8, expert: 0.65 };
const HIT_DIFFICULTY: Record<string, number> = { easy: 0.8, medium: 1, hard: 1.2, expert: 1.4 };
const TYPE_LABELS: Record<string, string> = { mcq: "multiple choice", true_false: "true/false", short_answer: "short answer" };

/**
 * Canonical subject key (subject/topic contamination fix).
 *
 * Deliberately LIGHT: lowercase, trim, strip accents and punctuation. It
 * does NOT do the topic key's stopword/singularise/word-sorting
 * normalization. Rationale: subjects are application-owned labels set once
 * per quiz ("Mathematics"), not free model text, so spelling variants are
 * rare; and a wrong merge here would silently mix two subjects' learning
 * data - exactly the bug this prevents. A missed merge ("Maths" vs
 * "Mathematics") only splits one subject's data across two buckets:
 * annoying, never contaminating. Unknown/empty subjects key as "".
 */
export function subjectKeyFor(subject: unknown): string {
  let s = typeof subject === "string" ? subject : "";
  s = s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 80);
}

/** Display form of a subject: whitespace-collapsed, otherwise untouched. */
export function cleanSubjectLabel(subject: unknown): string {
  const s = typeof subject === "string" ? subject : "";
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

// Retry sets and practice sets are built from questions already seen, so
// everything in them is a repeat exposure by construction.
function isRepeatQuiz(row: ResultRow): boolean {
  return row.retryOf !== null || row.quizId.startsWith("practice_") || row.quizId.startsWith("retry_");
}

function pct(x: number): number {
  return Math.round(x * 100);
}

function posterior(alpha: number, beta: number) {
  const n = alpha + beta;
  const mean = alpha / n;
  const sd = Math.sqrt((mean * (1 - mean)) / (n + 1));
  return { mean, upper: mean + UPPER_Z * sd };
}

type Exposure = { row: ResultRow; repeat: boolean; weight: number; hit: number; miss: number };

export function computeWeakAreas(rowsInput: ResultRow[]): WeakReport {
  // Stable chronological order (ties keep the caller's creation order).
  const rows = rowsInput.map((r, i) => ({ r, i })).sort((a, b) => a.r.answeredAt - b.r.answeredAt || a.i - b.i).map((x) => x.r);

  // Weak-area identity = subject + topic. Two subjects sharing a topic name
  // ("Mathematics + Waves" vs "Physics + Waves") form independent buckets.
  const byBucket = new Map<string, { subjectKey: string; topicKey: string; rows: ResultRow[] }>();
  for (const r of rows) {
    const sKey = subjectKeyFor(r.subject);
    const tKey = topicKeyFor(r.topic);
    const key = sKey + "|" + tKey;
    const bucket = byBucket.get(key);
    if (bucket) bucket.rows.push(r);
    else byBucket.set(key, { subjectKey: sKey, topicKey: tKey, rows: [r] });
  }

  const summary = { tracked: 0, insufficient: 0, solid: 0, emerging: 0, established: 0, improving: 0 };
  const all: WeakArea[] = [];

  for (const { subjectKey, topicKey, rows: bucketRows } of byBucket.values()) {
    const area = scoreTopic(topicKey, bucketRows, subjectKey);
    summary.tracked++;
    summary[area.status]++;
    all.push(area);
  }

  const rank: Record<string, number> = { established: 0, emerging: 1, improving: 2 };
  const areas = all
    .filter((a) => a.status === "established" || a.status === "emerging" || a.status === "improving")
    .sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score || b.lastPracticedAt - a.lastPracticedAt || (a.subjectKey + "|" + a.topicKey < b.subjectKey + "|" + b.topicKey ? -1 : 1))
    .slice(0, MAX_AREAS);

  return { areas, summary };
}

export function scoreTopic(topicKey: string, topicRows: ResultRow[], subjectKey: string = ""): WeakArea {
  const latest = topicRows[topicRows.length - 1].answeredAt;
  const firstQuizOfQuestion = new Map<string, string>();

  // 1) classify exposures and weight them
  const exposures: Exposure[] = topicRows.map((row) => {
    const seenIn = firstQuizOfQuestion.get(row.questionKey);
    const repeat = isRepeatQuiz(row) || (seenIn !== undefined && seenIn !== row.quizId);
    if (seenIn === undefined && !isRepeatQuiz(row)) firstQuizOfQuestion.set(row.questionKey, row.quizId);
    const ageDays = (latest - row.answeredAt) / DAY_MS;
    const recency = Math.max(RECENCY_FLOOR, Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
    const weight = recency * (repeat ? REPEAT_WEIGHT : 1);
    const hit = row.outcome === "correct" ? weight * (HIT_DIFFICULTY[row.difficulty] ?? 1) : 0;
    const miss = row.outcome === "correct" ? 0 : weight * (MISS_DIFFICULTY[row.difficulty] ?? 1) * (row.outcome === "skipped" ? SKIP_MISS_FACTOR : 1);
    return { row, repeat, weight, hit, miss };
  });

  const firsts = exposures.filter((e) => !e.repeat);
  const N = firsts.length;
  const quizOrder: string[] = [];
  for (const e of firsts) if (quizOrder.indexOf(e.row.quizId) === -1) quizOrder.push(e.row.quizId);
  const Nq = quizOrder.length;
  const correct = firsts.filter((e) => e.row.outcome === "correct").length;
  const skipped = firsts.filter((e) => e.row.outcome === "skipped").length;
  const firstMisses = firsts.length - correct; // incorrect + skipped
  const accuracy = N ? correct / N : 0;
  const skipRate = N ? skipped / N : 0;

  // 2) shrunk mastery
  let alpha = PRIOR_ALPHA, beta = PRIOR_BETA;
  for (const e of exposures) { alpha += e.hit; beta += e.miss; }
  const { mean, upper } = posterior(alpha, beta);

  // 3) per-question history: repeated misses, recoveries
  const perQuestion = new Map<string, Outcome[]>();
  for (const e of exposures) {
    const list = perQuestion.get(e.row.questionKey);
    if (list) list.push(e.row.outcome); else perQuestion.set(e.row.questionKey, [e.row.outcome]);
  }
  let repeatedMisses = 0, recovered = 0;
  for (const outcomes of perQuestion.values()) {
    const lastCorrect = outcomes.lastIndexOf("correct");
    const missesAfter = outcomes.slice(lastCorrect + 1).filter((o) => o !== "correct").length;
    if (missesAfter >= 2) repeatedMisses++;
    const firstMiss = outcomes.findIndex((o) => o !== "correct");
    if (firstMiss !== -1 && outcomes.slice(firstMiss + 1).indexOf("correct") !== -1) recovered++;
  }
  let streak = 0;
  for (let i = firsts.length - 1; i >= 0 && firsts[i].row.outcome !== "correct"; i--) streak++;

  // 4) improvement across whole quizzes
  let recentAccuracy: number | null = null, priorAccuracy: number | null = null, improving = false;
  if (Nq >= 3) {
    const recentQuizzes = new Set(quizOrder.slice(quizOrder.length - Math.ceil(Nq / 2)));
    const recentRows = firsts.filter((e) => recentQuizzes.has(e.row.quizId));
    const priorRows = firsts.filter((e) => !recentQuizzes.has(e.row.quizId));
    if (recentRows.length >= 4 && priorRows.length >= 4) {
      const acc = (list: Exposure[]) => list.filter((e) => e.row.outcome === "correct").length / list.length;
      recentAccuracy = acc(recentRows);
      priorAccuracy = acc(priorRows);
      improving = priorAccuracy < 0.65 && recentAccuracy >= 0.7 && recentAccuracy - priorAccuracy >= 0.2;
    }
  }

  // 5) question type
  const typeStats = new Map<string, { alpha: number; beta: number; n: number }>();
  for (const e of exposures) {
    const t = typeStats.get(e.row.type) || { alpha: PRIOR_ALPHA, beta: PRIOR_BETA, n: 0 };
    t.alpha += e.hit; t.beta += e.miss;
    if (!e.repeat) t.n++;
    typeStats.set(e.row.type, t);
  }
  const typed = [...typeStats.entries()]
    .filter(([, t]) => t.n >= 4)
    .map(([type, t]) => ({ type, mastery: posterior(t.alpha, t.beta).mean, n: t.n }))
    .sort((a, b) => a.mastery - b.mastery || (a.type < b.type ? -1 : 1));
  let weakestType: WeakArea["weakestType"] = null, typeSpecific = false;
  if (typed.length >= 2) {
    const weakest = typed[0], strongest = typed[typed.length - 1];
    weakestType = { type: weakest.type, mastery: pct(weakest.mastery), questions: weakest.n };
    typeSpecific = weakest.mastery < 0.55 && strongest.mastery - weakest.mastery >= 0.25;
  }

  // 6) status
  let status: WeakStatus;
  if (N < MIN_EVIDENCE) status = "insufficient";
  else if (improving) status = "improving";
  else if (N >= ESTABLISHED_MIN_QUESTIONS && Nq >= ESTABLISHED_MIN_QUIZZES && upper < 0.7 && mean < 0.6) status = "established";
  else if (firstMisses >= EMERGING_MIN_MISSES && (mean < 0.65 || (repeatedMisses >= 2 && mean < 0.72))) status = "emerging";
  else status = "solid";

  // 7) priority score
  const bonus = Math.min(0.1, 0.04 * repeatedMisses) + Math.min(0.06, 0.02 * Math.max(0, streak - 1));
  const score = Math.round(100 * Math.min(1, Math.max(0, 1 - mean + bonus)));

  // 8) reason (plain, deterministic)
  const typeLabel = weakestType ? TYPE_LABELS[weakestType.type] || weakestType.type : "";
  let reason = "";
  if (status === "established") {
    reason = `${correct} of ${N} right across ${Nq} quiz${Nq === 1 ? "" : "zes"}`
      + (repeatedMisses ? `; ${repeatedMisses} question${repeatedMisses === 1 ? "" : "s"} missed more than once` : "")
      + (typeSpecific ? `; mainly ${typeLabel} questions` : "") + ".";
  } else if (status === "emerging") {
    reason = `Early sign: ${correct} of ${N} right so far. A little more practice will show if it is real.`
      + (typeSpecific ? ` Mostly ${typeLabel} questions.` : "");
  } else if (status === "improving") {
    reason = `Up from ${pct(priorAccuracy as number)}% to ${pct(recentAccuracy as number)}% over your recent quizzes.`;
  } else if (status === "insufficient") {
    reason = "Not enough data yet.";
  }

  // Raw names as stored (the browser matches local questions on these and on
  // the key); the display name is the newest one with counter artefacts removed.
  const variants: string[] = [];
  for (let i = topicRows.length - 1; i >= 0 && variants.length < MAX_VARIANTS; i--) {
    if (variants.indexOf(topicRows[i].topic) === -1) variants.push(topicRows[i].topic);
  }
  const rawLatest = topicRows[topicRows.length - 1].topic;
  const display = cleanTopicLabel(rawLatest) || rawLatest;
  // The bucket's subject display: the newest row's subject, cleaned. Like
  // the topic display, it is presentational only - identity is the key.
  const subjectDisplay = cleanSubjectLabel(topicRows[topicRows.length - 1].subject);

  return {
    topicKey,
    subjectKey,
    subject: subjectDisplay,
    topic: display,
    topicVariants: variants,
    status,
    score,
    mastery: pct(mean),
    questions: N,
    quizzes: Nq,
    correct,
    accuracy: pct(accuracy),
    skipped,
    skipRate: pct(skipRate),
    highSkipRate: skipped >= 3 && skipRate >= 0.3,
    repeatedMisses,
    recovered,
    recentMissStreak: streak,
    recentAccuracy: recentAccuracy === null ? null : pct(recentAccuracy),
    priorAccuracy: priorAccuracy === null ? null : pct(priorAccuracy),
    weakestType,
    typeSpecific,
    reason,
    lastPracticedAt: latest,
  };
}

import { topicKeyFor } from "./topics";

/**
 * Pure helpers that turn a saved quiz attempt into lean per-question result
 * rows (F1). No database access here - callers own reads/writes - so this
 * is easy to test and can never partially fail a save: `deriveQuestionResults`
 * never throws, it just skips anything it cannot make sense of.
 */

export type Outcome = "correct" | "incorrect" | "skipped";

// Hard ceiling on rows derived from ONE attempt. A real quiz is at most
// MAX_QUESTION_COUNT (100) questions; the cap only exists so a crafted
// attempt with thousands of tiny questions cannot turn one saveAttempt call
// into thousands of writes.
export const MAX_RESULTS_PER_ATTEMPT = 200;

const MAX_TOPIC_CHARS = 120;

// Mirrors isSkipped() in js/app.js exactly, so server and client agree.
export function isSkippedAnswer(answer: unknown): boolean {
  return answer === undefined || answer === null || String(answer).trim() === "";
}

// Mirrors isCorrect() in js/app.js exactly (mcq by option id, true/false by
// string compare, short answer by normalised match against the accepted
// answers). Kept identical on purpose: the client already graded the attempt
// this way and the server-derived rows must never disagree with the score
// the user saw.
export function gradeAnswer(q: any, answer: unknown): Outcome {
  if (isSkippedAnswer(answer)) return "skipped";
  let correct = false;
  if (q.type === "mcq") {
    correct = answer === q.correctOptionId;
  } else if (q.type === "true_false") {
    correct = String(answer) === String(q.correctAnswer);
  } else if (q.type === "short_answer") {
    const norm = (s: unknown) => String(s).trim().toLowerCase().replace(/[^\w\s]/g, "");
    correct = (Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : []).some(
      (a: unknown) => norm(a) === norm(answer)
    );
  }
  return correct ? "correct" : "incorrect";
}

// cyrb53: small, fast, deterministic, well-distributed 53-bit string hash.
// Not for security - it only needs to give the same question text the same
// key every time so repeated misses of one question can be recognised.
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * Stable identity for a question ACROSS quizzes. Question ids ("q_1"...) only
 * mean something inside one quiz, but retry and practice sets re-serve the
 * same question text - hashing type + normalised text lets the same question
 * be recognised wherever it reappears.
 */
export function questionKeyFor(q: any): string {
  const text = typeof q?.text === "string" ? q.text : "";
  const normalised = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return "qk_" + cyrb53(`${typeof q?.type === "string" ? q.type : ""}|${normalised}`);
}

export type DerivedResult = {
  quizId: string;
  questionKey: string;
  topic: string;
  topicKey: string;
  subject: string;
  type: string;
  difficulty: string;
  mode: string;
  retryOf: string | null;
  outcome: Outcome;
  answeredAt: number;
};

export function deriveQuestionResults(attempt: {
  quizId: string;
  subject: string;
  difficulty: string;
  mode: string;
  retryOf: string | null;
  questions: unknown;
  answers: unknown;
  completedAt: number;
}): DerivedResult[] {
  try {
    if (!Array.isArray(attempt.questions)) return [];
    const answers: Record<string, unknown> =
      attempt.answers && typeof attempt.answers === "object" && !Array.isArray(attempt.answers)
        ? (attempt.answers as Record<string, unknown>)
        : {};
    const rows: DerivedResult[] = [];
    for (const q of attempt.questions) {
      if (rows.length >= MAX_RESULTS_PER_ATTEMPT) break;
      if (!q || typeof q !== "object" || typeof (q as any).id !== "string") continue;
      const question: any = q;
      // Flashcards and anything else without a gradable type never produce rows.
      if (question.type !== "mcq" && question.type !== "true_false" && question.type !== "short_answer") continue;
      // Same fallback the client uses (q.topic || 'General').
      const topic = (typeof question.topic === "string" && question.topic.trim() ? question.topic.trim() : "General").slice(0, MAX_TOPIC_CHARS);
      rows.push({
        quizId: attempt.quizId,
        questionKey: questionKeyFor(question),
        topic,
        topicKey: topicKeyFor(topic),
        subject: attempt.subject,
        type: question.type,
        difficulty: attempt.difficulty,
        mode: attempt.mode,
        retryOf: attempt.retryOf,
        outcome: gradeAnswer(question, answers[question.id]),
        answeredAt: attempt.completedAt,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

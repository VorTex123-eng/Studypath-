/**
 * Canonical topic keys (F1, refined in the A1 patch).
 *
 * Question topics are free text written by the model, so the same idea shows
 * up as "Waves", "wave" and "Waves." across quizzes. `topicKeyFor` maps
 * those to ONE stable key so per-topic performance can be grouped. The
 * human-readable topic name is always stored alongside the key and is what
 * users see; the key is internal and never shown.
 *
 * Deliberately simple and explainable - lowercase, strip accents and
 * punctuation, drop filler words, singularise, sort the words - not
 * semantic matching. It merges spelling/plural/word-order variants
 * ("Waves" = "wave", "Work and Energy" = "energy, work") and, since v2,
 * counter artefacts the model appends ("State Capitals 1/1", "Genetics (2)",
 * "Problem #3"). Genuinely different names for the same concept ("Wave
 * motion" vs "Waves") stay separate on purpose: a wrong merge silently
 * corrupts someone's weak-area data, a missed merge only splits it. Plain
 * trailing numbers ("World War 2", "Windows 10") are NOT stripped here -
 * they can be part of the real name - see consolidateTopics for the
 * quiz-level, evidence-based handling of those.
 *
 * The rule is versioned. Stored keys are never rewritten: readers that need
 * the current rule recompute it from the stored display name.
 */
export const TOPIC_KEY_VERSION = 2;

// Counter artefacts models append to a topic label. Only forms that are
// never part of a real name: a score-like fraction, a bracketed number, a
// "#n" / "No. n" marker - and only at the END of the label.
const TRAILING_ARTEFACTS: RegExp[] = [
  /\s*[(\[]?\s*\d+\s*\/\s*\d+\s*[)\]]?\s*$/, // "1/1", "(2/3)"
  /\s*[(\[]\s*\d{1,3}\s*[)\]]\s*$/,           // "(2)", "[3]"
  /\s*(?:#|no\.?\s*)\d{1,3}\s*$/i,               // "#2", "No. 3"
];

/**
 * Readable label with counter artefacts and wrapping quotes removed. Casing
 * and wording are preserved. Returns "" when nothing meaningful is left
 * (e.g. the label was just "1/1").
 */
export function cleanTopicLabel(topic: unknown): string {
  let s = typeof topic === "string" ? topic : "";
  s = s.replace(/\s+/g, " ").trim().replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, "").trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const re of TRAILING_ARTEFACTS) {
      const t = s.replace(re, "").trim();
      if (t !== s) { s = t; changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "in", "on", "to", "for", "with", "by", "at", "from", "as", "is", "are",
]);

const MAX_KEY_CHARS = 80;

/** Singularise one word (shared with A2 retrieval for variant-tolerant
 *  matching; exported additively — no behavior change to topic keys). */
export function singularise(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function topicKeyFor(topic: unknown): string {
  const raw = cleanTopicLabel(topic);
  const cleaned = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  const chosen = (meaningful.length ? meaningful : words).map(singularise);
  if (!chosen.length) return "general";
  return chosen.sort().join("-").slice(0, MAX_KEY_CHARS);
}

/**
 * Quiz-level topic consolidation (A1 patch). Given the topic labels of ONE
 * generated quiz (and, optionally, topic names already known for this
 * learner), returns the labels to store: same length, same order.
 *
 *  1. Counter artefacts are removed ("State Capitals 1/1" -> "State Capitals").
 *  2. Labels with the same canonical key collapse to one spelling - a known
 *     topic's spelling wins, otherwise the first one in the quiz.
 *  3. A label ending in a small plain number ("Genetics 2") is folded into
 *     its base ("Genetics") ONLY when that base already exists as a topic in
 *     this quiz or in the known list. Without such evidence the number is
 *     kept, because it may be part of the real name ("World War 2").
 *
 * Nothing else is merged: "Cell Division" and "Cell Structure" stay
 * separate, and so do "Waves" and "Wave motion". Deterministic and cheap -
 * no model calls. Labels that clean to nothing come back as "".
 */
export function consolidateTopics(labels: string[], known: string[] = []): string[] {
  const knownByKey = new Map<string, string>();
  for (const k of known) {
    const c = cleanTopicLabel(k);
    if (!c) continue;
    const key = topicKeyFor(c);
    if (!knownByKey.has(key)) knownByKey.set(key, c);
  }
  const cleaned = labels.map((l) => cleanTopicLabel(l));
  const keyOf = cleaned.map((c) => (c ? topicKeyFor(c) : ""));
  const displayByKey = new Map<string, string>();
  cleaned.forEach((c, i) => {
    if (c && !displayByKey.has(keyOf[i])) displayByKey.set(keyOf[i], knownByKey.get(keyOf[i]) ?? c);
  });
  return cleaned.map((c, i) => {
    if (!c) return "";
    const m = c.match(/^(.*\S)\s+(\d{1,2})$/);
    if (m) {
      const baseKey = topicKeyFor(m[1]);
      if (baseKey !== keyOf[i]) {
        const base = displayByKey.get(baseKey) ?? knownByKey.get(baseKey);
        if (base) return base;
      }
    }
    return displayByKey.get(keyOf[i]) as string;
  });
}

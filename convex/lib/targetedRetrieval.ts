/**
 * A2 targeted practice — bounded material relevance retrieval.
 *
 * Pure and deterministic: weak-area + material metadata in, ranked
 * materials and extracted passages out. No database access, no clock,
 * no network, so every rule below is unit-testable.
 *
 * STRATEGY (deliberately conservative — wrong material context is worse
 * than no targeted material):
 *
 *  1. Rank the user's materials by SUBJECT match first. The weak area's
 *     subjectKey must agree with the material's subject (exact subjectKey
 *     match, or strong title-word overlap). A material whose STORED subject
 *     is known and different is HARD-EXCLUDED: no topic evidence can ever
 *     select it (subject/topic contamination protection). A material with
 *     NO stored subject is "unknown", not wrong: it may still be fetched
 *     when the title carries a subject or topic signal, and the passage
 *     evidence bar decides.
 *  2. For the top-ranked candidates only, scan the extracted text for the
 *     weak topic. Matching is variant-tolerant but NOT semantic: words
 *     match up to singular/plural variation ("equation" = "equations"),
 *     in order, as a contiguous phrase or as individual keywords, with a
 *     bonus for headings (including standalone single-line headings).
 *  3. Extract the best passages with a little surrounding context and cap
 *     the total context sent to Gemini.
 *
 * LIMITATIONS (documented honestly):
 *  - This is keyword matching, not semantic understanding. A passage can
 *    mention the topic words without teaching the concept, and a passage
 *    that teaches the concept with different wording ("Mitosis and
 *    Meiosis" for the topic "Cell Division") will be missed.
 *  - Subject matching is only as good as the stored subject metadata.
 *    Materials saved without a subject fall back to title signals, which
 *    are weaker; a small documented alias map covers unambiguous
 *    abbreviations ("Maths" = "Mathematics") for RETRIEVAL ONLY — the
 *    A1 learning identity (subject+topic buckets) is never merged.
 *  - Only the single best material is used, so cross-material topics are
 *    not covered in one practice set.
 */

import { cleanTopicLabel, singularise, topicKeyFor } from "./topics";
import { subjectKeyFor } from "./weakness";

// Small local stopword set mirroring convex/lib/topics.ts (kept local so
// this module stays dependency-light and the list is visible next to its
// one use).
const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "in", "on", "to", "for", "with",
  "by", "at", "from", "as", "is", "are",
]);

/** Hard cap on the characters of material context sent to Gemini. */
export const TARGETED_MAX_CONTEXT_CHARS = 8000;
/** Minimum material score (subject + title signals) to even fetch its text. */
export const TARGETED_MIN_MATERIAL_SCORE = 60;
/** How many top-ranked materials get their full text fetched (bounded). */
export const TARGETED_MAX_MATERIALS_FETCHED = 3;
/** Minimum passage-level topic evidence for a material to be usable. */
export const TARGETED_MIN_PASSAGE_SCORE = 12;
/** Max passages kept from the winning material. */
export const TARGETED_MAX_PASSAGES = 6;
/** Surrounding blocks included with each hit block for context. */
const PASSAGE_CONTEXT_BLOCKS = 1;

export type MaterialMeta = {
  id: string;
  title: string;
  subject: string;
};

export type WeakAreaRef = {
  subject: string;
  subjectKey: string;
  topic: string;
  topicKey: string;
};

export type RankedMaterial = {
  id: string;
  score: number;
  subjectScore: number;
  /** Topic-word bonus from the title (ranking only, capped at 15). */
  titleTopic: number;
  /** True when the stored subject is known and disagrees: never fetched. */
  excluded: boolean;
  /** True when the material has no stored subject (unknown, not wrong). */
  subjectUnknown: boolean;
  /** True when the title names the topic phrase (variant-tolerant). */
  titleHasTopicPhrase: boolean;
  reasons: string[];
};

export type Passage = {
  text: string;
  heading: string | null;
  score: number;
};

export type TopicTerms = {
  /** Canonical phrase, e.g. "quadratic equations". May be "". */
  phrase: string;
  /** Individual keywords, lowercased, stopwords removed. */
  keywords: string[];
};

/**
 * Search terms for a weak-area topic: the canonical phrase plus
 * individual keywords. Pure function of the weak area's topic label.
 */
export function topicSearchTerms(weak: WeakAreaRef): TopicTerms {
  const phrase = cleanTopicLabel(weak.topic);
  const keyWords = topicKeyFor(weak.topic).split("-").filter((w) => w.length > 2);
  const labelWords = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const keywords: string[] = [];
  for (const w of [...keyWords, ...labelWords]) {
    if (!keywords.includes(w)) keywords.push(w);
  }
  return { phrase, keywords };
}

function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/* ============================================================
   Subject identity for RETRIEVAL only.
   The A1 learning identity stays conservative ("Maths" and
   "Mathematics" are separate weak-area buckets — a missed merge is
   safer than a false merge there). For retrieval candidacy only, a
   tiny documented alias map covers unambiguous abbreviations so a
   material stored as "Maths" can still ground a "Mathematics" weak
   area. This never merges learning data and never lets a genuinely
   different subject through.
   ============================================================ */

/** Unambiguous subject abbreviations, applied to retrieval matching only. */
const SUBJECT_ALIASES: Record<string, string> = {
  maths: "mathematics",
  math: "mathematics",
};

/** Canonical subject key for retrieval: subjectKeyFor + alias folding. */
export function canonicalSubjectKey(subject: unknown): string {
  const k = subjectKeyFor(subject);
  return SUBJECT_ALIASES[k] ?? k;
}

const aliasWord = (w: string): string => SUBJECT_ALIASES[w] ?? w;

/**
 * Subject agreement between a weak area and one material, 0-100.
 * 100 = canonical subject-key match on stored subject metadata
 *       (alias-aware: "Maths" = "Mathematics").
 * 60  = strong title-word overlap with the weak subject (>= half the
 *       subject's significant words appear in the title, alias-aware).
 * 30  = weak title-word overlap (at least one word).
 * 0   = no signal.
 *
 * A non-empty stored subject that canonically disagrees scores 0 here
 * AND is hard-excluded by isSubjectExcluded below: topic evidence can
 * never rescue it.
 */
export function subjectMatchScore(weakSubjectKey: string, meta: MaterialMeta): number {
  const weakKey = canonicalSubjectKey(weakSubjectKey);
  const metaKey = canonicalSubjectKey(meta.subject);
  if (weakKey && metaKey && weakKey === metaKey) return 100;
  const weakWords = wordsOf(weakKey).filter((w) => !STOPWORDS.has(w));
  if (!weakWords.length) return 0;
  const titleWords = new Set(wordsOf(meta.title).map(aliasWord));
  const matched = weakWords.filter((w) => titleWords.has(w)).length;
  if (matched / weakWords.length >= 0.5) return 60;
  if (matched > 0) return 30;
  return 0;
}

/**
 * Hard subject exclusion (contamination protection). True when the
 * material has a KNOWN stored subject that canonically disagrees with
 * the weak area's subject. Such materials are never fetched and never
 * selected, no matter how strong the topic-word evidence is.
 * Materials with no stored subject are "unknown", never excluded.
 */
export function isSubjectExcluded(weakSubjectKey: string, meta: MaterialMeta): boolean {
  const weakKey = canonicalSubjectKey(weakSubjectKey);
  const metaKey = canonicalSubjectKey(meta.subject);
  return !!weakKey && !!metaKey && weakKey !== metaKey;
}

/** True when the material carries no usable stored subject. */
export function isSubjectUnknown(meta: MaterialMeta): boolean {
  return canonicalSubjectKey(meta.subject) === "";
}

/**
 * Rank materials for a weak area using metadata only (no text fetched).
 * Sorted best-first. `reasons` explains each score for transparency and
 * tests. Nothing here reads material text.
 *
 * Callers must apply isFetchCandidate: materials below
 * TARGETED_MIN_MATERIAL_SCORE are still returned here so tests and
 * diagnostics can see the full picture.
 */
export function rankMaterials(weak: WeakAreaRef, metas: MaterialMeta[]): RankedMaterial[] {
  const terms = topicSearchTerms(weak);
  const ranked = metas.map((m) => {
    const subjectScore = subjectMatchScore(weak.subjectKey, m);
    const excluded = isSubjectExcluded(weak.subjectKey, m);
    const subjectUnknown = !excluded && isSubjectUnknown(m);
    // Title topic overlap is a secondary signal for ranking; the real
    // topic evidence is measured on the text later. The phrase check is
    // variant-tolerant (singular/plural); keywords stay substring-based
    // here because this is ranking, not evidence.
    const titleLower = ` ${m.title.toLowerCase()} `;
    const titleHasTopicPhrase =
      !!terms.phrase && phraseMatchesText(terms.phrase, m.title);
    let titleTopic = 0;
    if (titleHasTopicPhrase) titleTopic += 10;
    for (const kw of terms.keywords) {
      if (titleLower.includes(kw)) titleTopic += 2;
    }
    titleTopic = Math.min(titleTopic, 15);
    const score = excluded ? 0 : subjectScore + titleTopic;
    const reasons: string[] = [];
    if (excluded) reasons.push("stored subject disagrees — excluded");
    else if (subjectScore >= 100) reasons.push("subject metadata matches");
    else if (subjectScore >= 60) reasons.push("title matches weak-area subject");
    else if (subjectScore > 0) reasons.push("weak title/subject overlap");
    if (titleTopic > 0) reasons.push("topic words in title");
    if (subjectUnknown && titleHasTopicPhrase)
      reasons.push("subject unknown but title names the topic — text will decide");
    if (!reasons.length) reasons.push("no subject or topic signal");
    return {
      id: m.id,
      score,
      subjectScore,
      titleTopic,
      excluded,
      subjectUnknown,
      titleHasTopicPhrase,
      reasons,
    };
  });
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return ranked;
}

/**
 * Fetch candidacy: the single gate the action (and diagnostics) apply
 * before reading any material text. A material is fetched when it is
 * not hard-excluded AND either it clears the metadata score floor, or
 * its subject is unknown but its title names the topic phrase — in
 * which case the passage evidence bar (not the title) decides.
 */
export function isFetchCandidate(r: RankedMaterial): boolean {
  if (r.excluded) return false;
  if (r.score >= TARGETED_MIN_MATERIAL_SCORE) return true;
  return r.subjectUnknown && r.titleHasTopicPhrase;
}

/* ============================================================
   Variant-tolerant text matching.
   Words match up to singular/plural variation via the SAME
   singularise() the topic keys use ("equation" = "equations"), so
   matching stays consistent with A1's topic identity. This is
   deliberately NOT semantic: word order is preserved, every phrase
   word must match contiguously, and unrelated vocabulary never
   matches. "Cell Division" still does not match "Mitosis and
   Meiosis" — that would require real semantic understanding.
   ============================================================ */

/** Lowercase alphanumeric tokens; single letters (e.g. "'s" fragments) dropped. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/**
 * Count non-overlapping occurrences of a phrase in text, where each
 * phrase word must match a text word with singularise() equality, in
 * order, contiguously. "quadratic equations" matches "Quadratic
 * equation", never "equation ... quadratic" out of order.
 */
export function phraseMatchesText(phrase: string, text: string): boolean {
  return countPhraseOccurrences(tokenize(phrase), tokenize(text)) > 0;
}

function countPhraseOccurrences(phraseTokens: string[], textTokens: string[]): number {
  if (!phraseTokens.length || textTokens.length < phraseTokens.length) return 0;
  const pSing = phraseTokens.map(singularise);
  const tSing = textTokens.map(singularise);
  let count = 0;
  let i = 0;
  while (i <= tSing.length - pSing.length) {
    let ok = true;
    for (let j = 0; j < pSing.length; j++) {
      if (tSing[i + j] !== pSing[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      count++;
      i += pSing.length;
    } else {
      i++;
    }
  }
  return count;
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 120) return false;
  if (/^#{1,4}\s/.test(t)) return true;
  if (/:$/.test(t)) return true;
  // ALL-CAPS short line (allow digits/punctuation).
  const letters = t.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
  // Title-Case short line without terminal punctuation, e.g.
  // "Quadratic Equations". Conservative: every word must start
  // uppercase, so ordinary sentences ("To solve these, first ...")
  // never qualify. The heading bonus still requires a phrase or
  // keyword match inside the line itself, so a misclassified line
  // can only boost text that is already about the topic.
  if (!/[.!?]$/.test(t) && t.length <= 80) {
    const words = t.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
    if (words.length >= 1 && words.length <= 8 && words.every((w) => /^[A-Z]/.test(w)))
      return true;
  }
  return false;
}

/**
 * Score text blocks against the topic terms and return the best
 * passages with surrounding context. Blocks are paragraphs (blank-line
 * separated); each hit block pulls in up to PASSAGE_CONTEXT_BLOCKS
 * neighbors so the model sees setup, not just the matched sentence.
 *
 * Scoring (per block):
 *  - variant-tolerant phrase occurrence × 10 — the block is actually
 *    about the topic, not just sharing vocabulary;
 *  - variant-tolerant keyword occurrence × 2;
 *  - heading phrase match + 8, heading keyword match + 4. Headings are
 *    detected on the block's first line for multi-line blocks AND on
 *    standalone single-line blocks (the common "HEADING\\n\\nparagraph"
 *    layout). The hit block's neighbor expansion then pulls the headed
 *    paragraphs into the passage automatically.
 */
export function extractPassages(terms: TopicTerms, text: string): Passage[] {
  const rawBlocks = String(text || "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!rawBlocks.length) return [];

  const phraseTokens = tokenize(terms.phrase);
  // Dedupe AFTER singularising: topicSearchTerms can yield both
  // "equation" (from the key) and "equations" (from the label), which
  // would otherwise double-count the same occurrences.
  const keywordSingulars = [...new Set(terms.keywords.map(singularise))];

  const scored = rawBlocks.map((block) => {
    const tokens = tokenize(block);
    const freq = new Map<string, number>();
    for (const t of tokens) {
      const s = singularise(t);
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }
    let score = 0;
    score += countPhraseOccurrences(phraseTokens, tokens) * 10;
    for (const k of keywordSingulars) {
      score += (freq.get(k) ?? 0) * 2;
    }
    const firstLine = block.split("\n")[0].trim();
    const heading = firstLine && isHeading(firstLine) ? firstLine : null;
    if (heading) {
      const hTokens = tokenize(heading);
      if (countPhraseOccurrences(phraseTokens, hTokens) > 0) score += 8;
      else if (keywordSingulars.some((k) => hTokens.some((t) => singularise(t) === k)))
        score += 4;
    }
    return { block, heading, score };
  });

  const hits = scored
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, TARGETED_MAX_PASSAGES);

  // Expand each hit with neighbors, then dedupe overlapping windows.
  const taken = new Set<number>();
  const passages: Passage[] = [];
  for (const hit of hits) {
    const from = Math.max(0, hit.index - PASSAGE_CONTEXT_BLOCKS);
    const to = Math.min(rawBlocks.length - 1, hit.index + PASSAGE_CONTEXT_BLOCKS);
    let idx = from;
    while (idx <= to && taken.has(idx)) idx++;
    if (idx > to) continue; // fully covered by an earlier, better passage
    const parts: string[] = [];
    for (let i = from; i <= to; i++) {
      if (!taken.has(i)) {
        taken.add(i);
        parts.push(rawBlocks[i]);
      }
    }
    if (parts.length) passages.push({ text: parts.join("\n\n"), heading: hit.heading, score: hit.score });
  }
  passages.sort((a, b) => b.score - a.score);
  return passages;
}

/**
 * Join passages into the final bounded context string. Passages are
 * ordered best-first and the total is hard-capped at
 * TARGETED_MAX_CONTEXT_CHARS so Gemini never receives an unbounded
 * dump. Returns "" when there is nothing to send.
 */
export function buildTargetedContext(passages: Passage[], maxChars: number = TARGETED_MAX_CONTEXT_CHARS): string {
  const ordered = [...passages].sort((a, b) => b.score - a.score);
  const parts: string[] = [];
  let used = 0;
  for (const p of ordered) {
    const chunk = (p.heading ? `${p.heading}\n` : "") + p.text;
    if (used + chunk.length > maxChars) {
      const room = maxChars - used;
      if (room > 200) parts.push(chunk.slice(0, room).trimEnd() + "…");
      break;
    }
    parts.push(chunk);
    used += chunk.length + 2;
  }
  return parts.join("\n\n---\n\n").trim();
}

/* ============================================================
   Retrieval diagnostics (TESTS ONLY — never called by the action,
   never sent to the client, no material text leaves this module).
   Mirrors the action's decision stage-by-stage so a false
   "no_material" can be traced to the exact failing stage instead of
   guessed at: subject score -> title score -> fetch decision ->
   passage evidence -> final decision.
   ============================================================ */

export interface TargetedDiagnosisStage {
  id: string;
  title: string;
  subjectScore: number;
  subjectDecision: "match" | "unknown" | "excluded";
  titleTopicScore: number;
  rankScore: number;
  fetchCandidate: boolean;
  fetchReason: string;
  passageScores: number[];
  evidence: number;
  decision: "selected" | "rejected";
  decisionReason: string;
}

export interface TargetedDiagnosis {
  stages: TargetedDiagnosisStage[];
  /** The material the action would select, or null (-> no_material). */
  selectedId: string | null;
}

export function diagnoseTargetedRetrieval(
  weak: WeakAreaRef,
  metas: MaterialMeta[],
  textsById: Record<string, string>
): TargetedDiagnosis {
  const terms = topicSearchTerms(weak);
  const ranked = rankMaterials(weak, metas);
  const stages: TargetedDiagnosisStage[] = ranked.map((r) => {
    const meta = metas.find((m) => m.id === r.id);
    const fetchCandidate = isFetchCandidate(r);
    const fetchReason = r.excluded
      ? "excluded: stored subject disagrees with the weak-area subject"
      : fetchCandidate
        ? r.score >= TARGETED_MIN_MATERIAL_SCORE
          ? `metadata score ${r.score} >= ${TARGETED_MIN_MATERIAL_SCORE}`
          : "subject unknown but title names the topic — text evidence decides"
        : `metadata score ${r.score} < ${TARGETED_MIN_MATERIAL_SCORE}, no title topic signal`;
    let passageScores: number[] = [];
    let evidence = 0;
    if (fetchCandidate) {
      const passages = extractPassages(terms, textsById[r.id] || "");
      passageScores = passages.map((p) => p.score);
      evidence = passageScores.reduce((s, x) => s + x, 0);
    }
    const ok = fetchCandidate && evidence >= TARGETED_MIN_PASSAGE_SCORE;
    return {
      id: r.id,
      title: meta ? meta.title : "",
      subjectScore: r.subjectScore,
      subjectDecision: r.excluded ? "excluded" : r.subjectUnknown ? "unknown" : "match",
      titleTopicScore: r.titleTopic,
      rankScore: r.score,
      fetchCandidate,
      fetchReason,
      passageScores,
      evidence,
      decision: ok ? "selected" : "rejected",
      decisionReason: !fetchCandidate
        ? "not fetched: " + fetchReason
        : ok
          ? `evidence ${evidence} >= ${TARGETED_MIN_PASSAGE_SCORE}`
          : `evidence ${evidence} < ${TARGETED_MIN_PASSAGE_SCORE}`,
    };
  });
  // Best-wins, exactly like the action: highest evidence among selected.
  let selectedId: string | null = null;
  let bestScore = -1;
  for (const s of stages) {
    if (s.decision === "selected" && s.evidence > bestScore) {
      bestScore = s.evidence;
      selectedId = s.id;
    }
  }
  return { stages, selectedId };
}

/**
 * Weak-area eligibility for targeted practice. Mirrors exactly the areas
 * the Focused Practice UI surfaces (established, emerging, improving) —
 * A2 consumes A1's output and never redefines "weak". The "general"
 * bucket is too broad to target meaningfully.
 */
export function isEligibleWeakArea(area: { status: string; topicKey: string } | null | undefined): boolean {
  if (!area) return false;
  if (area.topicKey === "general") return false;
  return area.status === "established" || area.status === "emerging" || area.status === "improving";
}

/**
 * Find the weak-area bucket matching a subject+topic identity in a
 * computed weak-area report. Returns null when absent.
 */
export function findWeakAreaBucket(
  areas: Array<{ subjectKey: string; topicKey: string }> | null | undefined,
  subjectKey: string,
  topicKey: string
): number {
  if (!areas) return -1;
  return areas.findIndex((a) => a.subjectKey === subjectKey && a.topicKey === topicKey);
}

/* ============================================================
   Ownership predicate (A2 security, pure / testable).
   The action loads material rows by index and re-verifies each one;
   this is the exact predicate the internal query applies, shared so
   the rule is tested against the real code, not a copy.
   ============================================================ */

export function filterOwnedRows<T extends { userId: unknown }>(rows: T[], userId: unknown): T[] {
  return (rows || []).filter((r) => !!r && String(r.userId) === String(userId));
}

/* ============================================================
   Novelty backstop predicate (A2, pure / testable).
   True when at least one generated question collides with a question
   the student has already seen on this subject+topic (same keyFn the
   quiz engine uses). The action regenerates once with stronger
   novelty wording when this fires.
   ============================================================ */

export function hasNoveltyCollision<T>(
  questions: T[],
  historical: Set<string>,
  keyFn: (q: T) => string
): boolean {
  for (const q of questions || []) {
    try {
      if (historical.has(keyFn(q))) return true;
    } catch {
      /* an unreadable question can't collide; skip it */
    }
  }
  return false;
}

/* ============================================================
   Safe error mapping (A2, pure / testable).
   Every failure the targeted flow can produce maps to a fixed,
   user-safe message. Raw provider text, stack traces, and internal
   details NEVER reach the client through this path.
   ============================================================ */

export interface TargetedSafeError {
  code: string;
  message: string;
}

const TARGETED_SAFE_ERRORS: Record<string, string> = {
  no_material:
    "No saved material found for this weak area yet. Add the notes or textbook section you studied and try again.",
  no_weak_area:
    "This topic doesn't look like a weak area right now. The past-questions practice is still available.",
  not_authenticated: "Please sign in again to use targeted practice.",
  rate_limited: "You've used today's practice generations. Please try again tomorrow.",
  invalid_response: "The generation didn't come back in a usable form. Please try again.",
  generation_failed: "Couldn't generate targeted practice right now. Please try again.",
  bad_request: "That request wasn't valid. Please try again.",
  not_configured: "AI generation isn't available right now. Please try again later.",
  // Age gate (2026-10-06): must pass through unmapped so the frontend's
  // withAgeEligibility sees the code and shows the one-time prompt.
  age_not_eligible: "AI features need 18+ confirmation. Please complete the age check to continue.",
  provider_error:
    "The AI service is overloaded right now. Please try again in a little while.",
  timeout: "The AI service took too long to respond. Please try again.",
};

export function targetedErrorFor(err: unknown): TargetedSafeError {
  const anyErr = err as any;
  const code =
    (anyErr && (anyErr.code || (anyErr.data && anyErr.data.code))) || "generation_failed";
  if (Object.prototype.hasOwnProperty.call(TARGETED_SAFE_ERRORS, code)) {
    return { code, message: TARGETED_SAFE_ERRORS[code] };
  }
  // Unknown codes (raw provider failures, timeouts, network errors):
  // never forward err.message — it may contain internal details.
  return { code: "generation_failed", message: TARGETED_SAFE_ERRORS.generation_failed };
}

/**
 * Provider-side failure codes where no usable generation happened: the
 * provider never delivered output, so the attempt must not consume the
 * learner's generation quota (see refundGenerationQuota in convex/quiz.ts).
 * Deliberately excludes validation_failed / malformed_json (the provider
 * did work — its output was unusable) and not_configured (a persistent
 * deployment state, where a refund would remove all backpressure).
 */
export const REFUNDABLE_PROVIDER_CODES = new Set([
  "network_error",
  "timeout",
  "provider_error",
  "bad_response",
  "empty_response",
]);

/* ============================================================
   Calculation-material heuristic + targeted prompt.
   Moved here from convex/quiz.ts so the A2 prompt is unit-
   testable; quiz.ts imports both back (no behavior change).
   ============================================================ */

// followed correctly, that framing just isn't what calculation-based
// material needs. This heuristic decides when to swap in the
// alternative framing. Deliberately conservative: a false negative just
// keeps today's already-correct behavior for that material; a false
// positive could ask a non-calculation subject to "invent a new
// problem" it has no sensible way to do, which is the worse failure
// mode - so both a keyword AND a symbol-density signal are required
// together, not either alone.
const CALCULATION_KEYWORDS = [
  "solve", "equation", "simplify", "factor", "factorise", "factorize",
  "calculate", "compute", "evaluate", "differentiate", "integrate",
  "derivative", "integral", "quadratic", "simultaneous", "probability",
  "permutation", "combination", "logarithm", "trigonometric", "sine",
  "cosine", "tangent", "matrix", "matrices", "fraction", "percentage",
  "expand", "substitute", "coefficient", "exponent", "square root", "surd",
];

export function detectsCalculationMaterial(text: string): boolean {
  const lower = text.toLowerCase();
  let keywordHits = 0;
  for (const kw of CALCULATION_KEYWORDS) {
    if (lower.includes(kw)) keywordHits++;
    if (keywordHits >= 2) break;
  }
  if (keywordHits < 2) return false;
  const symbolMatches = text.match(/[=^√±%]|\d+\s*[+\-*/]\s*\d+/g) || [];
  const symbolDensity = symbolMatches.length / Math.max(1, text.length / 500);
  return symbolDensity >= 1;
}

/**
 * Prompt for targeted practice generation. Pure (exported for tests).
 * The passages are the ONLY source context. Questions must be NEW
 * (never copies of material exercises or previously seen questions)
 * and every question is filed under the weak topic's canonical name so
 * A1 keeps tracking improvement in the same subject+topic bucket.
 */
export function buildTargetedPrompt(args: {
  subject: string;
  topic: string;
  contextText: string;
  materialTitle: string;
  questionCount: number;
  difficulty: string;
  allowedTypes: string[];
}): string {
  const { subject, topic, contextText, materialTitle, questionCount, difficulty, allowedTypes } = args;
  const isCalculation = detectsCalculationMaterial(contextText);
  return [
    `You are generating a focused practice quiz for a learner who keeps making mistakes in this area. Your job is to test whether they can apply the concept in NEW situations.`,
    ``,
    `Subject: ${subject}`,
    `Weak topic: ${topic}`,
    ``,
    `The study material below (from the learner's own saved notes, "${materialTitle}") is the ONLY source of facts, formulas, and definitions you may use. Do not use outside knowledge for content - every question must be answerable from this material.`,
    `"""`,
    contextText,
    `"""`,
    ``,
    `Generate exactly ${questionCount} question(s) at "${difficulty}" difficulty.`,
    `Allowed question types: ${allowedTypes.join(", ")}. Mix them if more than one is allowed; otherwise use only the listed type.`,
    `Set "topic" to exactly "${topic}" for every question.`,
    `Put the question wording in "text" (never a field named "question").`,
    `Every question must test the weak topic ("${topic}") from a NEW angle:`,
    `- These must be NEW questions. Do NOT copy exercises, examples, or questions from the material above.`,
    `- Do NOT reuse the learner's previous questions - invent different numbers, scenarios, or angles that test the same underlying concept.`,
    `- Do not reveal or reference any previous quiz; just ask each new question directly.`,
    isCalculation
      ? `This material teaches calculation-based mathematics. For each question: identify the mathematical concept and method the material teaches, then invent a NEW problem instance that applies that exact method, using different numbers or coefficients than any worked example shown above. Solve your new problem yourself and double-check your own arithmetic before writing the question.`
      : ``,
    `Every question object must include every one of these fields, with the field matching its own "type" always populated - never left empty or omitted:`,
    `- "options": for "mcq" questions, exactly 4 entries with short ids ("o0","o1","o2","o3"). For other types, an empty array.`,
    `- "correctOptionId": for "mcq" questions, REQUIRED and must exactly equal the "id" of the correct entry in "options". For other types, an empty string.`,
    `- "correctAnswer": for "true_false" questions, REQUIRED, must be the boolean true or false (never a string). For other types, false.`,
    `- "acceptableAnswers": for "short_answer" questions, REQUIRED, at least one short correct answer (accept minor phrasing variation). For other types, an empty array.`,
    `A "mcq" question with no correctOptionId, or a "true_false" question with no correctAnswer, is invalid output - do not produce one.`,
    `Every question needs a one-sentence "explanation" grounded in the material above.`,
    ``,
    `When a question, option, or explanation needs to show a mathematical expression, formula, or equation, format it using LaTeX: wrap inline expressions in single dollar signs (for example $x^2+3x$) and standalone or display expressions in double dollar signs (for example $$x^2-5x+6=0$$). Do not wrap ordinary prose in LaTeX. Never use a bare dollar sign for currency inside a question, spell amounts out in words instead (for example "12 dollars") to avoid ambiguity with math notation.`,
  ].filter(Boolean).join("\n");
}

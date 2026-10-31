import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * M11C — server-side material validation.
 *
 * The frontend (js/material.js) already validates uploaded material:
 * file type/size, extraction, normalization, and a gibberish heuristic
 * (`assessTextQuality`). That stays exactly as-is - extraction does not
 * move server-side (see M11C architecture note: moving PDF/DOCX parsing
 * here would mean uploading whole files for no benefit, since extracted
 * text is what actually needs to reach the backend).
 *
 * What client-side validation can NOT provide is a trust boundary -
 * anyone can call this Convex deployment directly, skipping the browser
 * entirely. Per the M11 plan (M11H): "the backend must validate
 * independently." This query is that independent gate. It intentionally
 * mirrors material.js's `assessTextQuality` logic (same thresholds, same
 * reasons) rather than trusting whatever quality flag the client sends -
 * a client could just claim "looksLikeRealText: true" and skip the
 * check entirely if the backend didn't recompute it itself.
 *
 * Not wired into the live Create Quiz flow yet - the mock provider
 * doesn't call Convex at all, so there is nothing for this to gate today.
 * This becomes a real internal step inside M11D's `generateQuiz` action,
 * run right before any material text is sent to Gemini.
 */

// Same floor as MIN_CONTENT_CHARS in material.js.
const MIN_MATERIAL_CHARS = 120;

// New here: material.js has no upper bound today because nothing
// downstream cost money. Once M11D exists, unbounded material length
// directly becomes unbounded Gemini cost per request - so the backend
// enforces a ceiling independently of whatever the client sends.
const MAX_MATERIAL_CHARS = 50000;

const COMMON_WORDS = new Set([
  "the", "and", "is", "of", "to", "in", "a", "that", "it", "for",
  "on", "with", "as", "was", "are", "this", "be", "by", "an", "or",
  "at", "from", "have", "has", "not", "but", "which", "their",
  "they", "you", "your", "we", "our", "can", "will", "if", "then",
  "these", "those", "into", "about", "also", "more", "such", "one",
  "two", "other", "its", "all", "when", "may", "each", "most",
]);

export type Quality = { score: number; looksLikeRealText: boolean; reasons: string[] };

function assessTextQuality(text: string): Quality {
  const words = String(text || "").match(/[A-Za-z']{1,30}/g) || [];
  const total = words.length;
  if (total < 10) {
    return { score: 0, looksLikeRealText: false, reasons: ["not enough recognizable words"] };
  }

  const lower = words.map((w) => w.toLowerCase());
  const commonRatio = lower.filter((w) => COMMON_WORDS.has(w)).length / total;

  const vowelRe = /[aeiou]/i;
  const noVowelRatio = words.filter((w) => w.length >= 4 && !vowelRe.test(w)).length / total;

  const clusterRe = /[^aeiou\s]{5,}/i;
  const clusterRatio = words.filter((w) => clusterRe.test(w)).length / total;

  const uniqueRatio = new Set(lower).size / total;

  const repeatedCharRe = /(.)\1{4,}/;
  const repeatedRatio = words.filter((w) => repeatedCharRe.test(w)).length / total;

  const avgLen = words.reduce((s, w) => s + w.length, 0) / total;

  let score = 100;
  const reasons: string[] = [];
  if (commonRatio < 0.02) { score -= 35; reasons.push("very few common words like \u201cthe,\u201d \u201cand,\u201d or \u201cis\u201d"); }
  if (noVowelRatio > 0.25) { score -= 25; reasons.push("many words with no vowels"); }
  if (clusterRatio > 0.15) { score -= 20; reasons.push("unusual consonant clusters"); }
  if (uniqueRatio < 0.25) { score -= 15; reasons.push("very repetitive wording"); }
  if (repeatedRatio > 0.05) { score -= 15; reasons.push("repeated-character spam"); }
  if (avgLen < 2.2 || avgLen > 11) { score -= 10; reasons.push("unusual average word length"); }

  score = Math.max(0, Math.min(100, score));
  return { score, looksLikeRealText: score >= 55, reasons };
}

export type MaterialCheck = {
  ok: boolean;
  characterCount: number;
  limits: { min: number; max: number };
  quality: Quality;
  reasons: string[];
};

// Plain function, not a Convex query - so quiz.ts's generateQuiz action
// can call the exact same check on material text right before spending
// Gemini quota on it, instead of maintaining a second, potentially-
// drifting copy of these thresholds. The validateMaterial query below
// (used by the Settings dev check) is now just a thin wrapper around it.
export function checkMaterialText(text: string): MaterialCheck {
  const characterCount = text.length;
  const reasons: string[] = [];

  const withinMin = characterCount >= MIN_MATERIAL_CHARS;
  if (!withinMin) reasons.push(`shorter than the ${MIN_MATERIAL_CHARS}-character minimum`);

  const withinMax = characterCount <= MAX_MATERIAL_CHARS;
  if (!withinMax) reasons.push(`longer than the ${MAX_MATERIAL_CHARS}-character maximum`);

  const quality = assessTextQuality(text);
  if (!quality.looksLikeRealText) reasons.push(...quality.reasons);

  return {
    ok: withinMin && withinMax && quality.looksLikeRealText,
    characterCount,
    limits: { min: MIN_MATERIAL_CHARS, max: MAX_MATERIAL_CHARS },
    quality,
    reasons,
  };
}

export const validateMaterial = query({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => checkMaterialText(text),
});

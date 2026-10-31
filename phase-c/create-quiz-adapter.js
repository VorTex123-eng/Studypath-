/* ============================================================
   Studypath Phase C — Create Quiz integration adapter (PROPOSAL).
   ISOLATED: not imported by any existing file. Defines the contract
   the existing Create Quiz flow (js/app.js) would use once the
   no-modification rule is lifted. See phase-c/integration-plan.md
   §"Create Quiz" for the exact call-site diffs.

   Two selection modes, matching Phase C §18:
     Option 1 — "Upload new material":
       browser extraction (existing Material.fromFile/fromPaste) ->
       normalized text -> save to library (materials:saveMaterial) ->
       materialId
     Option 2 — "Use saved material":
       user picks from My Materials list -> materialId only.
       The TEXT is resolved server-side via getMaterialForGeneration,
       never round-tripped through the client.

   The adapter's single output is a GenerationMaterialInput:
     { mode: 'inline', text, label }            // Option 1, unsaved session text (today's behavior)
     { mode: 'saved',  materialId, label }      // Option 2, text resolved server-side
     { mode: 'saved-new', materialId, label }   // Option 1 after saving to the library

   Server-side rule for generateQuiz (to be added in convex/quiz.ts):
     - if input.mode starts with 'saved': load text via
       getMaterialForGeneration(sessionToken, materialId). The client
       must NOT send text in this mode; if it does, it is ignored.
     - if input.mode === 'inline': today's behavior (text inline), unchanged.
   This keeps guests working exactly as today while giving signed-in
   users the reuse path, and it preserves the §19 guarantee: Gemini
   only ever receives the session owner's material.
   ============================================================ */
'use strict';

const MODES = Object.freeze({
  INLINE: 'inline', // session text, not saved (guest-compatible, today's flow)
  SAVED: 'saved', // existing library material, text resolved server-side
  SAVED_NEW: 'saved-new', // just uploaded AND saved to the library
});

/**
 * Build the generation input for Option 2 (use saved material).
 * Client-side: only the materialId and display label travel; the text
 * stays server-side until generateQuiz resolves it.
 */
function forSavedMaterial(materialId, label) {
  if (!materialId || typeof materialId !== 'string') {
    throw new Error('forSavedMaterial requires a materialId string.');
  }
  return { mode: MODES.SAVED, materialId, label: label || 'Saved material' };
}

/**
 * Build the generation input for Option 1 when the user also saves the
 * material to their library. `saved` is the MaterialSummary returned by
 * materials:saveMaterial.
 */
function forNewlySavedMaterial(saved) {
  if (!saved || !saved.id) throw new Error('forNewlySavedMaterial requires a saved material summary.');
  return { mode: MODES.SAVED_NEW, materialId: saved.id, label: saved.title };
}

/**
 * Build the generation input for unsaved session text (Option 1 without
 * saving, and the entire guest flow). Identical to today's shape:
 * js/app.js passes { text, label } straight into generateQuiz.
 */
function forInlineText(text, label) {
  return { mode: MODES.INLINE, text: String(text || ''), label: label || 'Pasted text' };
}

/**
 * Normalize a GenerationMaterialInput for the generateQuiz call.
 * Returns { materialId|null, text|null, label } — the server decides
 * which source of text to use (see module header).
 */
function toGenerationArgs(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.mode === MODES.SAVED || i.mode === MODES.SAVED_NEW) {
    return { materialId: i.materialId || null, text: null, label: i.label || 'Saved material' };
  }
  return { materialId: null, text: i.text || '', label: i.label || 'Pasted text' };
}

/**
 * Client-side guard: which modes are available to this caller.
 * Guests may only use INLINE (no library exists for them); signed-in
 * users get all three. The server re-checks independently.
 */
function availableModes(isSignedIn) {
  return isSignedIn ? [MODES.INLINE, MODES.SAVED, MODES.SAVED_NEW] : [MODES.INLINE];
}

module.exports = { MODES, forSavedMaterial, forNewlySavedMaterial, forInlineText, toGenerationArgs, availableModes };

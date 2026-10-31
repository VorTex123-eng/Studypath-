/* ============================================================
   Studypath Phase C — Material Library: shared types & constants.
   Plain JavaScript (CommonJS) so the core stays runnable and testable
   with zero dependencies. JSDoc typedefs carry the shape contracts.

   Naming note: the existing backend module is `convex/material.ts`
   (server-side material *validation*). The Phase C *library* wiring is
   deliberately named `materials` (plural) everywhere to avoid any
   collision at integration time.
   ============================================================ */
'use strict';

/**
 * @typedef {'pdf'|'docx'|'txt'|'paste'} MaterialKind
 * Source of the extracted text. 'paste' covers text pasted directly by
 * the user. The original binary file is NEVER stored (Phase C §11).
 */

/**
 * @typedef {Object} Material
 * @property {string} id        - repository-assigned id (opaque string)
 * @property {string} userId    - owning account's user id (session-resolved, never anonymousId)
 * @property {string} title     - user-facing title, trimmed, 1..120 chars
 * @property {string|null} subject - optional subject label, trimmed, <=120 chars
 * @property {MaterialKind} kind
 * @property {string} extractedText - normalized extracted text, 120..50000 chars
 * @property {number} charCount - extractedText.length, stored so list views never read the blob
 * @property {number} createdAt - Date.now() ms
 * @property {number} updatedAt - Date.now() ms, bumped on rename
 */

/**
 * @typedef {Object} MaterialSummary
 * List-view projection: everything EXCEPT extractedText, so rendering
 * "My Materials" never pulls 50k-char blobs per row.
 * @property {string} id
 * @property {string} title
 * @property {string|null} subject
 * @property {MaterialKind} kind
 * @property {number} charCount
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} ServiceError
 * @property {string} code    - machine-readable code (see ERROR_CODES)
 * @property {string} message - human-readable, safe to show in UI
 */

/**
 * @typedef {Object} ServiceResult
 * @property {boolean} ok
 * @property {*} [data]
 * @property {ServiceError} [error]
 * Mirrors the existing Convex envelope used across convex/auth.ts and
 * convex/attempts.ts: { ok: true, ... } | { ok: false, error: { code, message } }.
 */

// --- Limits ------------------------------------------------------
// These MUST stay in lockstep with the existing enforcement points:
//   MAX_MATERIAL_CHARS  === convex/material.ts MAX_MATERIAL_CHARS (server gate before Gemini)
//   MIN_CONTENT_CHARS   === js/material.js MIN_CONTENT_CHARS (quiz-ready floor)
// A material below the quiz-ready floor can never be used for
// generation, so Phase C refuses to store it rather than keep a dead
// asset. MAX_MATERIALS_PER_USER is new in Phase C (§12).
const LIMITS = Object.freeze({
  MAX_MATERIAL_CHARS: 50000,
  MIN_CONTENT_CHARS: 120,
  MAX_MATERIALS_PER_USER: 20,
  MAX_TITLE_CHARS: 120,
  MAX_SUBJECT_CHARS: 120,
});

const MATERIAL_KINDS = Object.freeze(['pdf', 'docx', 'txt', 'paste']);

// --- Error codes -------------------------------------------------
// 'material_not_found' is intentionally returned BOTH when the id does
// not exist AND when it belongs to another user: distinguishing the two
// would let a caller probe for other users' material ids.
const ERROR_CODES = Object.freeze({
  NOT_AUTHENTICATED: 'not_authenticated',
  MATERIAL_NOT_FOUND: 'material_not_found',
  INVALID_TITLE: 'invalid_title',
  INVALID_SUBJECT: 'invalid_subject',
  INVALID_KIND: 'invalid_kind',
  MATERIAL_TOO_SHORT: 'material_too_short',
  MATERIAL_TOO_LONG: 'material_too_long',
  MATERIAL_LIMIT_REACHED: 'material_limit_reached',
});

function serviceError(code, message) {
  return { ok: false, error: { code, message } };
}

function serviceOk(data) {
  return { ok: true, data };
}

module.exports = {
  LIMITS,
  MATERIAL_KINDS,
  ERROR_CODES,
  serviceError,
  serviceOk,
};

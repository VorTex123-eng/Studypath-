/* ============================================================
   Studypath Phase C — Material Library: validation.
   Zero-dependency, pure functions. Safe to run on client AND server.

   normalizeText() intentionally mirrors js/material.js's normalizeText
   step-for-step (same replacements, same order). It is duplicated here
   rather than imported because:
     1. js/material.js is a browser IIFE bound to `window` with
        extraction side effects - not importable server-side;
     2. the Phase C core must be runnable in tests without a DOM;
     3. a single canonical implementation will live here at integration
        time, with js/material.js delegating to it (see integration-plan.md).

   Character counting uses `text.length` (UTF-16 code units), NOT
   code-point counting. This is deliberate: the existing server gate
   (convex/material.ts checkMaterialText) enforces the 50,000 limit with
   text.length, and Phase C must enforce the SAME limit in the SAME units
   or the two gates would disagree about what fits. Unicode text is fully
   preserved by normalization; only the unit of the limit matches.
   ============================================================ */
'use strict';

const { LIMITS, MATERIAL_KINDS, ERROR_CODES, serviceError, serviceOk } = require('./material-types');

/**
 * Normalize raw extracted/pasted text into the canonical stored form.
 * Mirrors js/material.js normalizeText exactly:
 *  - CRLF/CR -> LF
 *  - strip control chars (except \n and \t)
 *  - join PDF-style hard wraps (lowercase letter + newline + lowercase letter)
 *  - collapse 3+ newlines to a paragraph break
 *  - collapse 2+ spaces/tabs to one space
 *  - trim trailing whitespace per line
 *  - trim overall
 * Unicode content (CJK, emoji, accented text, RTL) passes through untouched.
 */
function normalizeText(raw) {
  if (raw == null) return '';
  let text = String(raw);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = text.replace(/([a-z,;:])\n(?=[a-z])/g, '$1 ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
  return text.trim();
}

/**
 * Character count in the same units as the existing 50k enforcement.
 * See module header for why this is text.length and not code points.
 */
function countChars(text) {
  return String(text == null ? '' : text).length;
}

function validateKind(kind) {
  if (MATERIAL_KINDS.indexOf(kind) === -1) {
    return serviceError(
      ERROR_CODES.INVALID_KIND,
      'Material kind must be one of: ' + MATERIAL_KINDS.join(', ') + '.'
    );
  }
  return serviceOk(kind);
}

function validateTitle(title) {
  const trimmed = String(title == null ? '' : title).trim();
  if (!trimmed) {
    return serviceError(ERROR_CODES.INVALID_TITLE, 'Give this material a title.');
  }
  if (trimmed.length > LIMITS.MAX_TITLE_CHARS) {
    return serviceError(
      ERROR_CODES.INVALID_TITLE,
      'Title must be ' + LIMITS.MAX_TITLE_CHARS + ' characters or fewer.'
    );
  }
  return serviceOk(trimmed);
}

function validateSubject(subject) {
  if (subject == null || String(subject).trim() === '') return serviceOk(null);
  const trimmed = String(subject).trim();
  if (trimmed.length > LIMITS.MAX_SUBJECT_CHARS) {
    return serviceError(
      ERROR_CODES.INVALID_SUBJECT,
      'Subject must be ' + LIMITS.MAX_SUBJECT_CHARS + ' characters or fewer.'
    );
  }
  return serviceOk(trimmed);
}

/**
 * Validate extracted text AFTER normalization. Returns the normalized
 * text and its char count on success.
 */
function validateExtractedText(rawText) {
  const normalized = normalizeText(rawText);
  const chars = countChars(normalized);
  if (chars < LIMITS.MIN_CONTENT_CHARS) {
    return serviceError(
      ERROR_CODES.MATERIAL_TOO_SHORT,
      'This material has too little readable text to save (' +
        chars +
        ' characters; at least ' +
        LIMITS.MIN_CONTENT_CHARS +
        ' needed).'
    );
  }
  if (chars > LIMITS.MAX_MATERIAL_CHARS) {
    return serviceError(
      ERROR_CODES.MATERIAL_TOO_LONG,
      'This material is too long to save (' +
        chars.toLocaleString('en-US') +
        ' characters; maximum ' +
        LIMITS.MAX_MATERIAL_CHARS.toLocaleString('en-US') +
        ').'
    );
  }
  return serviceOk({ extractedText: normalized, charCount: chars });
}

/**
 * Full create-input validation. Pure: no I/O, no ownership checks.
 * Returns { ok: true, data: { title, subject, kind, extractedText, charCount } }
 * with every field in its canonical stored form.
 */
function validateMaterialInput(input) {
  const inObj = input && typeof input === 'object' ? input : {};
  const kindRes = validateKind(inObj.kind);
  if (!kindRes.ok) return kindRes;
  const titleRes = validateTitle(inObj.title);
  if (!titleRes.ok) return titleRes;
  const subjectRes = validateSubject(inObj.subject);
  if (!subjectRes.ok) return subjectRes;
  const textRes = validateExtractedText(inObj.extractedText);
  if (!textRes.ok) return textRes;
  return serviceOk({
    title: titleRes.data,
    subject: subjectRes.data,
    kind: kindRes.data,
    extractedText: textRes.data.extractedText,
    charCount: textRes.data.charCount,
  });
}

/** Rename validation: same title rules, nothing else may change. */
function validateRename(title) {
  return validateTitle(title);
}

module.exports = {
  normalizeText,
  countChars,
  validateKind,
  validateTitle,
  validateSubject,
  validateExtractedText,
  validateMaterialInput,
  validateRename,
};

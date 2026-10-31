/* Phase C — validation tests (section 30: MATERIAL CREATION, TEXT). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  countChars,
  validateTitle,
  validateSubject,
  validateKind,
  validateExtractedText,
  validateMaterialInput,
  validateRename,
} = require('../material-validation');
const { LIMITS } = require('../material-types');
const { textOfLength, validInput } = require('./helpers');

test('accepts valid input for every material kind', () => {
  for (const kind of ['pdf', 'docx', 'txt', 'paste']) {
    const r = validateMaterialInput(validInput({ kind }));
    assert.equal(r.ok, true, kind);
    assert.equal(r.data.kind, kind);
    assert.equal(r.data.charCount, r.data.extractedText.length);
  }
});

test('rejects empty text', () => {
  const r = validateMaterialInput(validInput({ extractedText: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'material_too_short');
});

test('rejects whitespace-only text', () => {
  const r = validateMaterialInput(validInput({ extractedText: '   \n\n\t  \n  ' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'material_too_short');
});

test('rejects text below the 120-char floor', () => {
  const r = validateMaterialInput(validInput({ extractedText: textOfLength(119) }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'material_too_short');
});

test('accepts exactly 120 characters', () => {
  const r = validateMaterialInput(validInput({ extractedText: textOfLength(120) }));
  assert.equal(r.ok, true);
  assert.equal(r.data.charCount, 120);
});

test('accepts exactly 50,000 characters', () => {
  const r = validateMaterialInput(validInput({ extractedText: textOfLength(50000) }));
  assert.equal(r.ok, true);
  assert.equal(r.data.charCount, 50000);
});

test('rejects 50,001 characters', () => {
  const r = validateMaterialInput(validInput({ extractedText: textOfLength(50001) }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'material_too_long');
});

test('rejects invalid material kind', () => {
  const r = validateMaterialInput(validInput({ kind: 'epub' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid_kind');
});

test('rejects missing title, accepts trimmed title', () => {
  assert.equal(validateTitle('').ok, false);
  assert.equal(validateTitle('   ').ok, false);
  assert.equal(validateTitle(null).error.code, 'invalid_title');
  const r = validateTitle('  Cell Division  ');
  assert.equal(r.ok, true);
  assert.equal(r.data, 'Cell Division');
});

test('rejects excessive title', () => {
  const r = validateTitle('x'.repeat(121));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid_title');
  assert.equal(validateTitle('x'.repeat(120)).ok, true);
});

test('subject is optional, trimmed, length-capped', () => {
  assert.equal(validateSubject(null).data, null);
  assert.equal(validateSubject('').data, null);
  assert.equal(validateSubject('  Physics ').data, 'Physics');
  assert.equal(validateSubject('x'.repeat(121)).ok, false);
});

test('normalization mirrors js/material.js behavior', () => {
  // CRLF -> LF, control chars stripped, hard wraps joined, blanks collapsed
  assert.equal(normalizeText('a\r\nb\x00c'), 'a bc');
  assert.equal(normalizeText('line one\n\n\n\nline two'), 'line one\n\nline two');
  assert.equal(normalizeText('too   many    spaces'), 'too many spaces');
  assert.equal(normalizeText('trailing   \nspace\t'), 'trailing\nspace');
  assert.equal(normalizeText(null), '');
});

test('normalization preserves unicode content', () => {
  const uni = '光合作用 は photosynthesis です 🌍 — naïve façade.\nSecond paragraph here.';
  assert.equal(normalizeText(uni), uni);
});

test('char count uses UTF-16 units like the existing 50k gate', () => {
  // 'é' is 1 unit, '🌍' is 2 units — text.length semantics
  assert.equal(countChars('héllo 🌍'), 8);
  assert.equal(countChars('日本語'), 3);
  assert.equal(LIMITS.MAX_MATERIAL_CHARS, 50000);
  assert.equal(LIMITS.MIN_CONTENT_CHARS, 120);
});

test('validateKind accepts only the four kinds', () => {
  for (const k of ['pdf', 'docx', 'txt', 'paste']) assert.equal(validateKind(k).ok, true);
  assert.equal(validateKind('PDF').ok, false);
  assert.equal(validateKind('').ok, false);
});

test('validateRename enforces title rules only', () => {
  assert.equal(validateRename('New Name').data, 'New Name');
  assert.equal(validateRename('').error.code, 'invalid_title');
  assert.equal(validateRename('x'.repeat(200)).error.code, 'invalid_title');
});

test('input missing entirely is invalid', () => {
  assert.equal(validateMaterialInput(null).ok, false);
  assert.equal(validateMaterialInput(undefined).ok, false);
  assert.equal(validateExtractedText(null).error.code, 'material_too_short');
});

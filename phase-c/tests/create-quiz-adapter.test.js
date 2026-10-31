/* Phase C — create-quiz adapter contract tests. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODES,
  forSavedMaterial,
  forNewlySavedMaterial,
  forInlineText,
  toGenerationArgs,
  availableModes,
} = require('../create-quiz-adapter');

test('saved-material mode carries id + label, never text', () => {
  const input = forSavedMaterial('mat_1', 'Biology Notes');
  assert.equal(input.mode, MODES.SAVED);
  assert.equal(input.materialId, 'mat_1');
  assert.equal(input.label, 'Biology Notes');
  assert.equal(input.text, undefined);

  const args = toGenerationArgs(input);
  assert.equal(args.materialId, 'mat_1');
  assert.equal(args.text, null); // server resolves text itself
  assert.equal(args.label, 'Biology Notes');
});

test('newly-saved mode comes from a saveMaterial summary', () => {
  const args = toGenerationArgs(forNewlySavedMaterial({ id: 'mat_9', title: 'Chem' }));
  assert.equal(args.mode, undefined); // toGenerationArgs strips mode by design
  assert.equal(args.materialId, 'mat_9');
  assert.equal(args.label, 'Chem');
});

test('inline mode preserves today\'s { text, label } shape', () => {
  const args = toGenerationArgs(forInlineText('some text here', 'notes.pdf'));
  assert.equal(args.materialId, null);
  assert.equal(args.text, 'some text here');
  assert.equal(args.label, 'notes.pdf');
});

test('forSavedMaterial requires a materialId string', () => {
  assert.throws(() => forSavedMaterial(null, 'x'), /materialId/);
  assert.throws(() => forSavedMaterial(123, 'x'), /materialId/);
});

test('guests only get inline mode; signed-in users get all three', () => {
  assert.deepEqual(availableModes(false), [MODES.INLINE]);
  assert.deepEqual(availableModes(true), [MODES.INLINE, MODES.SAVED, MODES.SAVED_NEW]);
});

test('malformed input degrades to inline, never to a forged saved reference', () => {
  const args = toGenerationArgs({ mode: 'whatever', materialId: 'mat_evil' });
  assert.equal(args.materialId, null);
  assert.equal(args.text, '');
});

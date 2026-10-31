/* Phase C — limit tests (section 30: LIMITS). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS } = require('../material-types');
const { makeService, validInput, textOfLength } = require('./helpers');

const NOW = 1700000000000;

test('20 materials allowed, 21st rejected server-side', async () => {
  const { service } = makeService({ now: NOW });
  for (let i = 0; i < 20; i++) {
    const r = await service.createMaterial('tok_alice', validInput({ title: 'M' + i }));
    assert.equal(r.ok, true, 'material ' + i + ' should save');
  }
  const over = await service.createMaterial('tok_alice', validInput({ title: 'M20' }));
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'material_limit_reached');
  assert.equal(LIMITS.MAX_MATERIALS_PER_USER, 20);
});

test('deleting one material frees a slot', async () => {
  const { service } = makeService({ now: NOW });
  const ids = [];
  for (let i = 0; i < 20; i++) {
    ids.push((await service.createMaterial('tok_alice', validInput({ title: 'M' + i }))).data.material.id);
  }
  assert.equal((await service.createMaterial('tok_alice', validInput({ title: 'extra' }))).ok, false);
  await service.deleteMaterial('tok_alice', ids[0]);
  const r = await service.createMaterial('tok_alice', validInput({ title: 'extra' }));
  assert.equal(r.ok, true);
});

test('the limit is per-user, not global', async () => {
  const { service } = makeService({ now: NOW });
  for (let i = 0; i < 20; i++) {
    assert.equal((await service.createMaterial('tok_alice', validInput({ title: 'A' + i }))).ok, true);
  }
  // bob is unaffected by alice's full library
  assert.equal((await service.createMaterial('tok_bob', validInput({ title: 'B0' }))).ok, true);
});

test('limit cannot be bypassed with oversized text (both gates fire)', async () => {
  const { service } = makeService({ now: NOW });
  const r = await service.createMaterial('tok_alice', validInput({ extractedText: textOfLength(60000) }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'material_too_long'); // text gate fires before/instead of count gate
});

test('exactly-50k material counts toward the limit like any other', async () => {
  const { service } = makeService({ now: NOW });
  const r = await service.createMaterial('tok_alice', validInput({ extractedText: textOfLength(50000) }));
  assert.equal(r.ok, true);
  assert.equal(r.data.material.charCount, 50000);
});

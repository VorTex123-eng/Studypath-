/* Phase C — service CRUD + generation choke point tests. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeService, makeAttemptLinkage, validInput, textOfLength } = require('./helpers');

const NOW = 1700000000000;

test('create stores canonical fields and returns a summary', async () => {
  const { service, repo } = makeService({ now: NOW });
  const r = await service.createMaterial('tok_alice', validInput({ title: '  Cell Notes ', kind: 'paste' }));
  assert.equal(r.ok, true);
  const summary = r.data.material;
  assert.equal(summary.title, 'Cell Notes'); // trimmed
  assert.equal(summary.kind, 'paste');
  assert.equal(summary.subject, 'Biology');
  assert.ok(summary.id);
  assert.equal(summary.extractedText, undefined); // summaries never carry the blob
  assert.equal(summary.createdAt, NOW);
  assert.equal(summary.updatedAt, NOW);

  const full = repo.getById(summary.id);
  assert.equal(full.userId, 'u_alice'); // ownership from session, not client
  assert.equal(full.charCount, full.extractedText.length);
});

test('client cannot choose the owner: userId in input is ignored', async () => {
  const { service, repo } = makeService({ now: NOW });
  const r = await service.createMaterial(
    'tok_alice',
    validInput({ userId: 'u_bob', owner: 'u_bob' }) // forged fields
  );
  assert.equal(r.ok, true);
  const full = repo.getById(r.data.material.id);
  assert.equal(full.userId, 'u_alice'); // session wins, always
  assert.equal(full.owner, undefined);
});

test('list returns newest-updated first, bounded, without text blobs', async () => {
  const { service } = makeService({ now: NOW });
  await service.createMaterial('tok_alice', validInput({ title: 'First' }));
  await service.createMaterial('tok_alice', validInput({ title: 'Second' }));
  await service.createMaterial('tok_bob', validInput({ title: 'Bob Material' }));

  const r = await service.listMaterials('tok_alice');
  assert.equal(r.ok, true);
  assert.equal(r.data.materials.length, 2); // bob's is invisible
  assert.equal(r.data.materials[0].title, 'Second');
  assert.equal(r.data.materials[1].title, 'First');
  for (const m of r.data.materials) assert.equal(m.extractedText, undefined);
});

test('list is bounded and paginates with cursor', async () => {
  const { service } = makeService({ now: NOW });
  for (let i = 0; i < 5; i++) await service.createMaterial('tok_alice', validInput({ title: 'M' + i }));
  const p1 = await service.listMaterials('tok_alice', { limit: 2 });
  assert.equal(p1.data.materials.length, 2);
  assert.ok(p1.data.nextCursor);
  const p2 = await service.listMaterials('tok_alice', { limit: 2, cursor: p1.data.nextCursor });
  assert.equal(p2.data.materials.length, 2);
  const p3 = await service.listMaterials('tok_alice', { limit: 2, cursor: p2.data.nextCursor });
  assert.equal(p3.data.materials.length, 1);
  assert.equal(p3.data.nextCursor, null);
});

test('get returns full text to the owner only', async () => {
  const { service } = makeService({ now: NOW });
  const text = textOfLength(5000);
  const id = (await service.createMaterial('tok_alice', validInput({ extractedText: text }))).data.material.id;
  const r = await service.getMaterial('tok_alice', id);
  assert.equal(r.ok, true);
  assert.equal(r.data.material.extractedText, r.data.material.extractedText.trim());
  assert.equal(r.data.material.charCount, 5000);
});

test('rename updates title and bumps updatedAt', async () => {
  const now2 = NOW + 60000;
  const { service } = makeService({ now: NOW });
  const id = (await service.createMaterial('tok_alice', validInput({ title: 'Old' }))).data.material.id;
  // rename with a later clock
  service.now = () => now2;
  const r = await service.renameMaterial('tok_alice', id, '  New Title ');
  assert.equal(r.ok, true);
  assert.equal(r.data.material.title, 'New Title');
  assert.equal(r.data.material.updatedAt, now2);
});

test('rename rejects bad titles and enforces ownership', async () => {
  const { service } = makeService({ now: NOW });
  const id = (await service.createMaterial('tok_alice', validInput())).data.material.id;
  assert.equal((await service.renameMaterial('tok_alice', id, '')).error.code, 'invalid_title');
  assert.equal((await service.renameMaterial('tok_alice', id, 'x'.repeat(121))).error.code, 'invalid_title');
  assert.equal((await service.renameMaterial('tok_bob', id, 'Hijack')).error.code, 'material_not_found');
  assert.equal((await service.renameMaterial('tok_alice', 'nope', 'X')).error.code, 'material_not_found');
});

test('getMaterialForGeneration is the AI choke point: owner text only', async () => {
  const { service } = makeService({ now: NOW });
  const id = (await service.createMaterial('tok_alice', validInput({ title: 'Secret Notes' }))).data.material.id;

  const r = await service.getMaterialForGeneration('tok_alice', id);
  assert.equal(r.ok, true);
  assert.equal(r.data.material.label, 'Secret Notes'); // label convention matches create-quiz
  assert.ok(r.data.material.text.length >= 120);

  // bob (or nobody) gets nothing — never another user's text
  assert.equal((await service.getMaterialForGeneration('tok_bob', id)).error.code, 'material_not_found');
  assert.equal((await service.getMaterialForGeneration(null, id)).error.code, 'not_authenticated');
});

test('delete removes the row and reports unlinked attempts', async () => {
  const linkage = makeAttemptLinkage();
  const { service, repo } = makeService({ now: NOW, attemptLinkage: linkage });
  const id = (await service.createMaterial('tok_alice', validInput())).data.material.id;
  linkage.addAttempt({ id: 'a1', userId: 'u_alice', materialId: id, score: 72 });
  linkage.addAttempt({ id: 'a2', userId: 'u_alice', materialId: id, score: 90 });
  linkage.addAttempt({ id: 'a3', userId: 'u_alice', materialId: null, score: 55 });

  const r = await service.deleteMaterial('tok_alice', id);
  assert.equal(r.ok, true);
  assert.equal(r.data.unlinkedAttempts, 2);
  assert.equal(repo.getById(id), null); // material gone

  // attempts SURVIVE with all their data; only the reference is cleared
  assert.equal(linkage.attempts.length, 3);
  assert.equal(linkage.attempts[0].materialId, null);
  assert.equal(linkage.attempts[0].score, 72);
  assert.equal(linkage.attempts[1].materialId, null);
  assert.equal(linkage.attempts[2].score, 55);
});

test('delete of missing/foreign id reports not_found, deletes nothing', async () => {
  const { service, repo } = makeService({ now: NOW });
  const id = (await service.createMaterial('tok_alice', validInput())).data.material.id;
  assert.equal((await service.deleteMaterial('tok_alice', 'mat_999')).error.code, 'material_not_found');
  assert.equal((await service.deleteMaterial('tok_bob', id)).error.code, 'material_not_found');
  assert.ok(repo.getById(id)); // still there
});

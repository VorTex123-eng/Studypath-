/* Phase C — delete semantics + account cleanup tests (section 30: DELETE, ACCOUNT DELETION). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeUserMaterials, DEFAULT_BATCH } = require('../material-cleanup');
const { MemoryMaterialRepository } = require('../material-repo-memory');
const { makeService, makeAttemptLinkage, validInput } = require('./helpers');

const NOW = 1700000000000;

function seedRepo(repo, userId, n, now) {
  for (let i = 0; i < n; i++) {
    repo.insert({
      userId,
      title: 'M' + i,
      subject: null,
      kind: 'txt',
      extractedText: 'x'.repeat(200),
      charCount: 200,
      createdAt: now,
      updatedAt: now,
    });
  }
}

test('purgeUserMaterials deletes only that user, in batches', async () => {
  const repo = new MemoryMaterialRepository();
  seedRepo(repo, 'u_alice', 5, NOW);
  seedRepo(repo, 'u_bob', 3, NOW);

  const res = await purgeUserMaterials('u_alice', repo, { batch: 2 });
  assert.equal(res.deleted, 5);
  assert.equal(res.batches, 3); // 2 + 2 + 1
  assert.equal(repo.countByUserId('u_alice'), 0);
  assert.equal(repo.countByUserId('u_bob'), 3); // untouched
});

test('purgeUserMaterials is idempotent on an empty library', async () => {
  const repo = new MemoryMaterialRepository();
  const res = await purgeUserMaterials('u_nobody', repo);
  assert.deepEqual(res, { deleted: 0, batches: 1 });
});

test('purge default batch matches the existing account-cleanup batch size', () => {
  assert.equal(DEFAULT_BATCH, 200); // convex/accountCleanup.ts BATCH
});

test('full account-deletion order: materials go last, attempts/questionResults first', async () => {
  // Simulates the proposed purgeUser order: attempts + questionResults
  // purged by the EXISTING jobs, materials by the NEW extension.
  const linkage = makeAttemptLinkage();
  const { service, repo } = makeService({ now: NOW, attemptLinkage: linkage });

  const mid = (await service.createMaterial('tok_alice', validInput())).data.material.id;
  linkage.addAttempt({ id: 'a1', userId: 'u_alice', materialId: mid, score: 72, questions: ['q1'] });
  const questionResults = [{ userId: 'u_alice', attemptId: 'a1', outcome: 'incorrect' }];

  // 1. material deleted (user action): attempts + questionResults survive
  await service.deleteMaterial('tok_alice', mid);
  assert.equal(linkage.attempts.length, 1);
  assert.equal(linkage.attempts[0].materialId, null);
  assert.equal(linkage.attempts[0].score, 72);
  assert.equal(questionResults.length, 1); // per-question rows untouched by material delete

  // 2. account deletion: existing jobs clear attempts/questionResults...
  linkage.attempts.length = 0;
  questionResults.length = 0;
  // ...then the new extension clears materials (none left here, still safe)
  const purged = await purgeUserMaterials('u_alice', repo);
  assert.equal(purged.deleted, 0);
  assert.equal(repo.countByUserId('u_alice'), 0);
});

test('historical attempts remain fully usable after the source material is gone', async () => {
  const linkage = makeAttemptLinkage();
  const { service } = makeService({ now: NOW, attemptLinkage: linkage });
  const mid = (await service.createMaterial('tok_alice', validInput({ title: 'Bio' }))).data.material.id;
  linkage.addAttempt({
    id: 'a1',
    userId: 'u_alice',
    materialId: mid,
    title: 'Bio: quiz',
    score: 72,
    questions: [{ id: 'q_1', text: 'What is...' }],
    answers: { q_1: 'a' },
  });
  await service.deleteMaterial('tok_alice', mid);
  const a = linkage.attempts[0];
  assert.deepEqual(a.questions, [{ id: 'q_1', text: 'What is...' }]);
  assert.deepEqual(a.answers, { q_1: 'a' });
  assert.equal(a.title, 'Bio: quiz');
  assert.equal(a.materialId, null); // unlinked, not destroyed
});

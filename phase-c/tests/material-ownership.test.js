/* Phase C — ownership tests (section 30: OWNERSHIP, SECURITY). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOwner, ownerCanAccess, requireOwnership, isAccountRow } = require('../material-ownership');
const { makeUsers, makeSessions, makeService, validInput } = require('./helpers');

const NOW = 1700000000000;

function deps() {
  const users = makeUsers();
  const store = makeSessions(users, NOW);
  return {
    findSession: (t) => store.findSession(t),
    getUser: (id) => users.get(id) || null,
    now: () => NOW,
  };
}

test('valid session resolves to the account userId', () => {
  const r = resolveOwner('tok_alice', deps());
  assert.equal(r.ok, true);
  assert.equal(r.data.userId, 'u_alice');
});

test('missing token is rejected', () => {
  assert.equal(resolveOwner(null, deps()).error.code, 'not_authenticated');
  assert.equal(resolveOwner(undefined, deps()).error.code, 'not_authenticated');
  assert.equal(resolveOwner('', deps()).error.code, 'not_authenticated');
});

test('unknown token is rejected', () => {
  assert.equal(resolveOwner('tok_nonexistent', deps()).error.code, 'not_authenticated');
});

test('expired session is rejected', () => {
  assert.equal(resolveOwner('tok_expired', deps()).error.code, 'not_authenticated');
});

test('session pointing at a pure guest row is rejected (no anonymousId ownership)', () => {
  // u_guest has no email/passwordHash: isAccountRow is false, so even a
  // "valid" session for it must not resolve to an owner.
  const r = resolveOwner('tok_guest', deps());
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_authenticated');
});

test('session pointing at a deleted user is rejected', () => {
  const d = deps();
  const users = makeUsers();
  users.delete('u_alice');
  const r = resolveOwner('tok_alice', {
    findSession: d.findSession,
    getUser: (id) => users.get(id) || null,
    now: d.now,
  });
  assert.equal(r.error.code, 'not_authenticated');
});

test('isAccountRow matches convex/attempts.ts rule', () => {
  assert.equal(isAccountRow({ email: 'a@b.c' }), true);
  assert.equal(isAccountRow({ passwordHash: 'x' }), true);
  assert.equal(isAccountRow({}), false);
  assert.equal(isAccountRow(null), false);
});

test('there is no anonymousId parameter to smuggle identity through', () => {
  // resolveOwner's signature is (sessionToken, deps). Any extra argument
  // is ignored by JS semantics — assert the function arity and that a
  // forged "anonymousId" cannot influence the result.
  assert.equal(resolveOwner.length, 2);
  const r = resolveOwner('tok_alice', deps(), { anonymousId: 'forged-id' });
  assert.equal(r.ok, true);
  assert.equal(r.data.userId, 'u_alice'); // still the session's user, not the forged id
});

test('ownerCanAccess requires strict equality', () => {
  const mat = { id: 'm1', userId: 'u_alice' };
  assert.equal(ownerCanAccess(mat, 'u_alice'), true);
  assert.equal(ownerCanAccess(mat, 'u_bob'), false);
  assert.equal(ownerCanAccess(mat, null), false);
  assert.equal(ownerCanAccess(null, 'u_alice'), false);
});

test('requireOwnership never leaks existence', () => {
  const missing = requireOwnership(null, 'u_alice');
  assert.equal(missing.error.code, 'material_not_found');
  const others = requireOwnership({ id: 'm1', userId: 'u_bob' }, 'u_alice');
  assert.equal(others.error.code, 'material_not_found'); // same code as missing
  assert.equal(requireOwnership({ id: 'm1', userId: 'u_alice' }, 'u_alice'), null);
});

test('cross-user isolation end to end: bob cannot touch alice material', async () => {
  const { service } = makeService({ now: NOW });
  const created = await service.createMaterial('tok_alice', validInput());
  assert.equal(created.ok, true);
  const id = created.data.material.id;

  assert.equal((await service.getMaterial('tok_bob', id)).error.code, 'material_not_found');
  assert.equal((await service.renameMaterial('tok_bob', id, 'Hijacked')).error.code, 'material_not_found');
  assert.equal((await service.deleteMaterial('tok_bob', id)).error.code, 'material_not_found');
  assert.equal((await service.getMaterialForGeneration('tok_bob', id)).error.code, 'material_not_found');

  // ...and alice's material is untouched.
  const stillThere = await service.getMaterial('tok_alice', id);
  assert.equal(stillThere.ok, true);
  assert.equal(stillThere.data.material.title, 'Biology Notes');
});

test('guests cannot create or list materials', async () => {
  const { service } = makeService({ now: NOW });
  // tok_guest resolves to a non-account row -> not_authenticated
  assert.equal((await service.createMaterial('tok_guest', validInput())).error.code, 'not_authenticated');
  assert.equal((await service.listMaterials('tok_guest')).error.code, 'not_authenticated');
  // no token at all
  assert.equal((await service.createMaterial(null, validInput())).error.code, 'not_authenticated');
});

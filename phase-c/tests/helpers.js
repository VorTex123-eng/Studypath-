/* Phase C tests — shared fixtures. */
'use strict';

const { MemoryMaterialRepository, makeSessionStore } = require('../material-repo-memory');
const { MaterialService } = require('../material-service');

/** Two signed-in account users + one guest row + one stranger. */
function makeUsers() {
  return new Map([
    ['u_alice', { _id: 'u_alice', email: 'alice@example.com', name: 'Alice' }],
    ['u_bob', { _id: 'u_bob', email: 'bob@example.com', name: 'Bob' }],
    // Pure guest row: no email/passwordHash — must NEVER own materials.
    ['u_guest', { _id: 'u_guest' }],
  ]);
}

/** Session store pre-loaded with tokens for alice, bob, guest + an expired one. */
function makeSessions(users, now) {
  const t = typeof now === 'number' ? now : Date.now();
  const store = makeSessionStore();
  store.add('tok_alice', 'u_alice', 30 * 24 * 3600 * 1000, t);
  store.add('tok_bob', 'u_bob', 30 * 24 * 3600 * 1000, t);
  store.add('tok_guest', 'u_guest', 30 * 24 * 3600 * 1000, t);
  store.add('tok_expired', 'u_alice', -1000, t); // already expired
  return store;
}

function makeService(opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : 1700000000000;
  const users = o.users || makeUsers();
  const store = o.store || makeSessions(users, now);
  const repo = o.repo || new MemoryMaterialRepository();
  const service = new MaterialService({
    repo,
    findSession: (tok) => store.findSession(tok),
    getUser: (id) => users.get(id) || null,
    attemptLinkage: o.attemptLinkage,
    now: () => now,
  });
  return { service, repo, store, users, now };
}

/** Fake attempt store: attempts survive material deletion; only materialId is cleared. */
function makeAttemptLinkage() {
  const attempts = [];
  return {
    attempts,
    addAttempt(a) {
      attempts.push(Object.assign({ materialId: null }, a));
    },
    async unlinkMaterial(materialId) {
      let n = 0;
      for (const a of attempts) {
        if (a.materialId === materialId) {
          a.materialId = null;
          n++;
        }
      }
      return n;
    },
  };
}

const LOREM =
  'Photosynthesis is the process by which green plants convert sunlight, water and carbon dioxide into glucose and oxygen. ' +
  'Chlorophyll absorbs light energy, which powers the splitting of water molecules and the fixation of carbon. ';

/** Exactly n chars that survive normalization unchanged (no leading/trailing
 *  whitespace, single spaces, no newlines) — so boundary tests test the
 *  boundary, not the normalizer. */
function textOfLength(n) {
  const unit = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
  let s = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  s = s.trim();
  while (s.length < n) s += 'x';
  return s.slice(0, n);
}

function validInput(overrides) {
  return Object.assign(
    {
      title: 'Biology Notes',
      subject: 'Biology',
      kind: 'pdf',
      extractedText: textOfLength(2000),
    },
    overrides || {}
  );
}

module.exports = { makeUsers, makeSessions, makeService, makeAttemptLinkage, textOfLength, validInput, LOREM };

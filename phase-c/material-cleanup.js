/* ============================================================
   Studypath Phase C — Material Library: account-cleanup extension.
   ISOLATED PROPOSAL. This file is NOT wired into the existing
   deletion flow (convex/auth.ts purgeUser / convex/accountCleanup.ts)
   because the no-modification rule forbids touching those files.

   What it does: the pure, testable half of material cleanup —
   deleting one user's materials in bounded batches. The Convex
   wiring (internal mutation + the extra scheduler call inside
   purgeUser) is specified in phase-c/integration-plan.md §"Account
   deletion" with exact diffs.

   Deletion order for a full account purge (matches existing
   purgeUser, materials slotted in):
     1. avatar blob, sessions, reports, user row   (existing, immediate)
     2. attempts          (existing, batched internal mutation)
     3. questionResults   (existing, batched internal mutation)
     4. materials         (NEW, batched — this module's purgeUserMaterials)
   Materials are deleted AFTER attempts on purpose: nothing in the
   attempts purge needs the material rows, and deleting materials last
   keeps the window where dangling references could be observed as
   small as possible. (With the proposed schema the attempts'
   materialId field is simply removed on material delete anyway —
   see material-service.deleteMaterial — so order is belt-and-braces.)
   ============================================================ */
'use strict';

const DEFAULT_BATCH = 200;

/**
 * Delete every material owned by userId in batches.
 *
 * @param {string} userId
 * @param {Object} repo - MaterialRepository (needs deleteAllByUserId)
 * @param {Object} [opts] - { batch } batch size, default 200 (matches
 *                          the existing BATCH in convex/accountCleanup.ts)
 * @returns {Promise<{ deleted: number, batches: number }>}
 *          Resolves when NO materials remain for the user. A production
 *          caller that cannot loop (Convex mutation limits) should call
 *          this once per scheduled run and reschedule while !done — the
 *          same self-rescheduling pattern purgeUserAttempts uses.
 */
async function purgeUserMaterials(userId, repo, opts) {
  const batch = Math.max(1, (opts && opts.batch) || DEFAULT_BATCH);
  let deleted = 0;
  let batches = 0;
  for (;;) {
    const res = repo.deleteAllByUserId(userId, { batch });
    deleted += res.deleted;
    batches += 1;
    if (res.done) break;
    // Safety valve: never loop forever on a misbehaving repo.
    if (batches > 100000) throw new Error('purgeUserMaterials: repo never reported done');
  }
  return { deleted, batches };
}

module.exports = { purgeUserMaterials, DEFAULT_BATCH };

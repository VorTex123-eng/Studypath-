/* ============================================================
   Studypath Phase C — Material Library: ownership.
   Zero-dependency, pure logic. The session store and user lookup are
   injected, so this is testable without Convex and portable into the
   real Convex wiring (see phase-c/convex/materials.ts).

   SECURITY MODEL (mirrors convex/attempts.ts + convex/lib/ownRows.ts):
   - Ownership comes ONLY from a valid, unexpired session token,
     resolved SERVER-SIDE to a userId.
   - There is deliberately NO anonymousId parameter anywhere in this
     module. Guests keep their existing session-only material behavior
     (js/material.js sessionStorage) and can never own server-backed
     materials. If a future caller tries to pass an anonymousId, there
     is no parameter to receive it.
   - The client NEVER supplies a userId. The service layer only ever
     sees the userId this module resolved from the session token.
   - Only real account rows (email or passwordHash set — the same
     `isAccountRow` rule as convex/attempts.ts) may own materials.
     A pure guest row can never be resolved to an owner, even if someone
     hand-crafts a session pointing at one.
   - Existence is never leaked: callers must return MATERIAL_NOT_FOUND
     both when the id is unknown and when it belongs to someone else
     (enforced in material-service.js via ownerCanAccess()).
   ============================================================ */
'use strict';

const { ERROR_CODES, serviceError, serviceOk } = require('./material-types');

/**
 * Same rule as convex/attempts.ts isAccountRow(). Duplicated here (not
 * imported) so the core has no dependency on existing backend files;
 * at integration time convex/materials.ts will import the real one.
 */
function isAccountRow(user) {
  return !!(user && (user.email || user.passwordHash));
}

/**
 * Resolve the owner for an operation from a session token.
 *
 * @param {string|null|undefined} sessionToken - bearer token from the caller
 * @param {Object} deps
 * @param {(token: string) => ({ userId: string, expiresAt: number } | null)} deps.findSession
 *        server-side session lookup (e.g. sessions.by_token + expiry check)
 * @param {(userId: string) => ({ email?: string, passwordHash?: string } | null)} deps.getUser
 *        server-side user row lookup
 * @param {() => number} [deps.now] - clock, injectable for tests
 * @returns {{ok:true, data:{userId:string}} | {ok:false, error}}
 */
function resolveOwner(sessionToken, deps) {
  const now = deps && typeof deps.now === 'function' ? deps.now() : Date.now();
  if (!sessionToken || typeof sessionToken !== 'string') {
    return serviceError(ERROR_CODES.NOT_AUTHENTICATED, 'Please sign in to use your material library.');
  }
  let session = null;
  try {
    session = deps.findSession(sessionToken);
  } catch (e) {
    session = null;
  }
  if (!session || !session.userId || typeof session.expiresAt !== 'number' || session.expiresAt < now) {
    return serviceError(ERROR_CODES.NOT_AUTHENTICATED, 'Please sign in to use your material library.');
  }
  let user = null;
  try {
    user = deps.getUser(session.userId);
  } catch (e) {
    user = null;
  }
  if (!isAccountRow(user)) {
    // Covers: user deleted, session pointing at a pure guest row, or any
    // other row that is not a real signed-up account.
    return serviceError(ERROR_CODES.NOT_AUTHENTICATED, 'Please sign in to use your material library.');
  }
  return serviceOk({ userId: session.userId });
}

/**
 * Ownership predicate used by every CRUD path. Strict equality on the
 * resolved userId; no coercion, no fallback.
 */
function ownerCanAccess(material, userId) {
  return !!material && !!userId && material.userId === userId;
}

/**
 * Guard helper: returns null when access is allowed, otherwise the
 * MATERIAL_NOT_FOUND service error (never NOT_AUTHENTICATED here, and
 * never a distinct "belongs to someone else" signal).
 */
function requireOwnership(material, userId) {
  if (!ownerCanAccess(material, userId)) {
    return serviceError(ERROR_CODES.MATERIAL_NOT_FOUND, 'Material not found.');
  }
  return null;
}

module.exports = {
  isAccountRow,
  resolveOwner,
  ownerCanAccess,
  requireOwnership,
};

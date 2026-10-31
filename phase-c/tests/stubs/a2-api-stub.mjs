/* Test stub for convex/_generated/api.
 * Internal function references are plain string ids; the fake ctx in the
 * harness switches on them. Zero dependencies. */
export const internal = {
  quiz: {
    resolveTargetedPracticeContext: 'internal.quiz.resolveTargetedPracticeContext',
    getTargetedMaterialTexts: 'internal.quiz.getTargetedMaterialTexts',
    resolveIdentityAndCheckRateLimit: 'internal.quiz.resolveIdentityAndCheckRateLimit',
    refundGenerationQuota: 'internal.quiz.refundGenerationQuota',
    // Session resolution for action handlers (2026-10-08): actions have no
    // ctx.db, so generateQuiz/generateTargetedPractice resolve the session
    // through this internal query via ctx.runQuery.
    resolveSessionUserId: 'internal.quiz.resolveSessionUserId',
  },
  // B1: tutor internal references (same string-id pattern).
  tutor: {
    getTutorUser: 'internal.tutor.getTutorUser',
    getOwnedMaterial: 'internal.tutor.getOwnedMaterial',
    checkTutorRateLimit: 'internal.tutor.checkTutorRateLimit',
    createConversation: 'internal.tutor.createConversation',
    loadConversation: 'internal.tutor.loadConversation',
    saveMessages: 'internal.tutor.saveMessages',
    listUserConversations: 'internal.tutor.listUserConversations',
    deleteConversationRow: 'internal.tutor.deleteConversationRow',
  },
  // Password recovery internal references (same string-id pattern).
  passwordReset: {
    findUserByEmail: 'internal.passwordReset.findUserByEmail',
    createResetToken: 'internal.passwordReset.createResetToken',
    consumeResetToken: 'internal.passwordReset.consumeResetToken',
    checkResetRateLimit: 'internal.passwordReset.checkResetRateLimit',
  },
  // Age eligibility gate: the check itself runs as an internal query so
  // actions reach it via ctx.runQuery (the proven surface).
  lib: {
    eligibility: {
      checkAgeEligibility: 'internal.lib.eligibility.checkAgeEligibility',
    },
  },
};
export const api = { quiz: {} };

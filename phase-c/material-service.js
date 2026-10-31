/* ============================================================
   Studypath Phase C — Material Library: service layer.
   The single place where material business rules live. Depends only on
   injected collaborators, so it is fully testable without Convex:

     new MaterialService({
       repo,            // MaterialRepository (see material-repo-memory.js)
       findSession,     // (token) -> { userId, expiresAt } | null
       getUser,         // (userId) -> user row | null
       attemptLinkage,  // optional: { unlinkMaterial(materialId) -> Promise<number> }
       now,             // optional clock () -> number
       generateId,      // optional id factory (repo assigns ids by default)
     })

   Every public method takes a sessionToken and NEVER a userId: the
   userId always comes from material-ownership.resolveOwner(). There is
   no code path by which a client-supplied userId can reach the repo.

   Attempt linkage: deleting a material must NOT delete history. The
   service delegates reference cleanup to an injected AttemptLinkage
   collaborator (production: a Convex internal mutation that clears the
   proposed attempts.materialId field; tests: a fake). Attempts and
   questionResults themselves are never touched by deleteMaterial.
   ============================================================ */
'use strict';

const { LIMITS, ERROR_CODES, serviceError, serviceOk } = require('./material-types');
const { validateMaterialInput, validateRename } = require('./material-validation');
const { resolveOwner, requireOwnership } = require('./material-ownership');
const { toSummary } = require('./material-repo-memory');

const LIST_PAGE_SIZE = 50;

class MaterialService {
  constructor(deps) {
    if (!deps || !deps.repo) throw new Error('MaterialService requires a repo.');
    if (typeof deps.findSession !== 'function') throw new Error('MaterialService requires findSession.');
    if (typeof deps.getUser !== 'function') throw new Error('MaterialService requires getUser.');
    this.repo = deps.repo;
    this.findSession = deps.findSession;
    this.getUser = deps.getUser;
    this.attemptLinkage = deps.attemptLinkage || null;
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  }

  _owner(sessionToken) {
    return resolveOwner(sessionToken, {
      findSession: this.findSession,
      getUser: this.getUser,
      now: this.now,
    });
  }

  /** Create a material from already-extracted, normalized text. */
  async createMaterial(sessionToken, input) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;

    const valid = validateMaterialInput(input || {});
    if (!valid.ok) return valid;

    // Server-side per-user cap (§12). Counted here, not trusted from the client.
    const count = this.repo.countByUserId(owner.data.userId);
    if (count >= LIMITS.MAX_MATERIALS_PER_USER) {
      return serviceError(
        ERROR_CODES.MATERIAL_LIMIT_REACHED,
        'You can save up to ' + LIMITS.MAX_MATERIALS_PER_USER + ' materials. Delete one to save another.'
      );
    }

    const t = this.now();
    const row = this.repo.insert({
      userId: owner.data.userId,
      title: valid.data.title,
      subject: valid.data.subject,
      kind: valid.data.kind,
      extractedText: valid.data.extractedText,
      charCount: valid.data.charCount,
      createdAt: t,
      updatedAt: t,
    });
    return serviceOk({ material: toSummary(row) });
  }

  /** Bounded list of the caller's own materials (summaries only). */
  async listMaterials(sessionToken, opts) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;
    const o = opts || {};
    const page = this.repo.listByUserId(owner.data.userId, {
      limit: Math.min(LIST_PAGE_SIZE, o.limit || LIST_PAGE_SIZE),
      cursor: o.cursor || null,
    });
    return serviceOk({ materials: page.items, nextCursor: page.nextCursor });
  }

  /** Full material including extractedText. Ownership-checked. */
  async getMaterial(sessionToken, materialId) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;
    const row = this.repo.getById(materialId);
    const denied = requireOwnership(row, owner.data.userId);
    if (denied) return denied;
    return serviceOk({ material: Object.assign({}, row) });
  }

  /** Rename. Only the title may change; updatedAt bumps. */
  async renameMaterial(sessionToken, materialId, title) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;
    const titleRes = validateRename(title);
    if (!titleRes.ok) return titleRes;
    const row = this.repo.getById(materialId);
    const denied = requireOwnership(row, owner.data.userId);
    if (denied) return denied;
    const updated = this.repo.updateTitle(materialId, { title: titleRes.data, updatedAt: this.now() });
    return serviceOk({ material: toSummary(updated) });
  }

  /**
   * Delete a material. Historical quiz attempts and questionResults are
   * NEVER deleted here; the attempt linkage collaborator clears the
   * materialId reference on attempts (unlink, not destroy) so results
   * stay readable after the source material is gone.
   */
  async deleteMaterial(sessionToken, materialId) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;
    const row = this.repo.getById(materialId);
    const denied = requireOwnership(row, owner.data.userId);
    if (denied) return denied;
    const deleted = this.repo.deleteById(materialId);
    let unlinkedAttempts = 0;
    if (this.attemptLinkage && typeof this.attemptLinkage.unlinkMaterial === 'function') {
      unlinkedAttempts = await this.attemptLinkage.unlinkMaterial(materialId);
    }
    return serviceOk({ deleted: toSummary(deleted), unlinkedAttempts });
  }

  /**
   * AI-pipeline choke point (§19). Returns the material TEXT for quiz
   * generation, but ONLY after resolving ownership from the session.
   * This is the function the generateQuiz integration must call: the
   * model can then only ever receive the authenticated caller's own
   * material, because the text is loaded server-side from the resolved
   * userId - a client-supplied userId or a forged materialId can never
   * reach another user's text.
   */
  async getMaterialForGeneration(sessionToken, materialId) {
    const owner = this._owner(sessionToken);
    if (!owner.ok) return owner;
    const row = this.repo.getById(materialId);
    const denied = requireOwnership(row, owner.data.userId);
    if (denied) return denied;
    return serviceOk({
      material: {
        id: row.id,
        title: row.title,
        // Label convention matches today's create-quiz flow
        // (js/app.js: label = fileName || 'Pasted text').
        label: row.title,
        text: row.extractedText,
        charCount: row.charCount,
      },
    });
  }
}

module.exports = { MaterialService, LIST_PAGE_SIZE };

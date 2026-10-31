/* ============================================================
   Studypath Phase C — Material Library: in-memory repository.
   Implements the MaterialRepository interface the service depends on,
   backed by plain Maps. Used by:
     - the node:test suite (fast, deterministic, no backend),
     - the standalone UI prototype (material-ui/) as its demo store.
   It is NOT production storage; the production implementation is the
   Convex wiring in phase-c/convex/materials.ts (backed by the proposed
   `materials` table in phase-c/schema-proposal.ts).

   MaterialRepository interface (what material-service.js needs):
     insert(material) -> material            // material WITHOUT id
     getById(id) -> material | null
     listByUserId(userId, { limit, cursor }) -> { items, nextCursor }
       items are MaterialSummary (no extractedText), newest-updated first
     countByUserId(userId) -> number
     updateTitle(id, { title, updatedAt }) -> material | null
     deleteById(id) -> material | null       // returns the deleted row
     deleteAllByUserId(userId, { batch }) -> { deleted, done }
       batched so account cleanup can never blow per-op limits
   ============================================================ */
'use strict';

function toSummary(m) {
  return {
    id: m.id,
    title: m.title,
    subject: m.subject,
    kind: m.kind,
    charCount: m.charCount,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

class MemoryMaterialRepository {
  constructor() {
    this.rows = new Map(); // id -> Material
    this.byUser = new Map(); // userId -> Set<id>
    this.nextId = 1;
  }

  _track(row) {
    if (!this.byUser.has(row.userId)) this.byUser.set(row.userId, new Set());
    this.byUser.get(row.userId).add(row.id);
  }

  _untrack(row) {
    const set = this.byUser.get(row.userId);
    if (set) {
      set.delete(row.id);
      if (set.size === 0) this.byUser.delete(row.userId);
    }
  }

  insert(material) {
    const row = Object.assign({}, material, { id: 'mat_' + this.nextId++ });
    this.rows.set(row.id, row);
    this._track(row);
    return Object.assign({}, row);
  }

  getById(id) {
    const row = this.rows.get(id);
    return row ? Object.assign({}, row) : null;
  }

  listByUserId(userId, opts) {
    const o = opts || {};
    const limit = Math.max(1, Math.min(100, o.limit || 50));
    const ids = this.byUser.get(userId);
    if (!ids) return { items: [], nextCursor: null };
    const sorted = Array.from(ids)
      .map((id) => this.rows.get(id))
      .filter(Boolean)
      // Newest-updated first; ties (same ms timestamp) break toward the
      // later-created row so repeated rapid saves still read newest-first.
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
    let start = 0;
    if (o.cursor) {
      const idx = sorted.findIndex((r) => r.id === o.cursor);
      start = idx === -1 ? 0 : idx + 1;
    }
    const page = sorted.slice(start, start + limit);
    const nextCursor = start + limit < sorted.length ? page[page.length - 1].id : null;
    return { items: page.map(toSummary), nextCursor };
  }

  countByUserId(userId) {
    const set = this.byUser.get(userId);
    return set ? set.size : 0;
  }

  updateTitle(id, patch) {
    const row = this.rows.get(id);
    if (!row) return null;
    row.title = patch.title;
    row.updatedAt = patch.updatedAt;
    return Object.assign({}, row);
  }

  deleteById(id) {
    const row = this.rows.get(id);
    if (!row) return null;
    this.rows.delete(id);
    this._untrack(row);
    return Object.assign({}, row);
  }

  deleteAllByUserId(userId, opts) {
    const batch = Math.max(1, (opts && opts.batch) || 200);
    const ids = this.byUser.get(userId);
    if (!ids || ids.size === 0) return { deleted: 0, done: true };
    let deleted = 0;
    for (const id of Array.from(ids)) {
      if (deleted >= batch) break;
      const row = this.rows.get(id);
      if (row) {
        this.rows.delete(id);
        this._untrack(row);
        deleted++;
      }
    }
    const remaining = this.byUser.get(userId);
    return { deleted, done: !remaining || remaining.size === 0 };
  }
}

/**
 * Fake session store for tests/prototype: token -> { userId, expiresAt }.
 * The prototype's demo data is CLEARLY labelled demo data in the UI.
 */
function makeSessionStore() {
  const sessions = new Map();
  return {
    sessions,
    add(token, userId, ttlMs, now) {
      const t = typeof now === 'number' ? now : Date.now();
      sessions.set(token, { userId, expiresAt: t + (ttlMs == null ? 30 * 24 * 3600 * 1000 : ttlMs) });
    },
    findSession(token) {
      return sessions.get(token) || null;
    },
  };
}

module.exports = { MemoryMaterialRepository, makeSessionStore, toSummary };

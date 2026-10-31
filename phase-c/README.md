# Studypath Phase C — Material Library (implementation)

> **Status: implementation complete, not integrated.** Everything in this
> directory is new code written for Phase C. Nothing under it is imported
> by the existing app; no existing file was modified. Integration happens
> later, following `integration-plan.md`.

## What Phase C builds

A persistent, per-account library of study materials. Signed-in users can
save the text extracted from their documents (PDF/DOCX/TXT) or pasted text,
then reuse it for quiz generation without re-uploading. Guests keep the
existing session-only behavior (`js/material.js` → sessionStorage) unchanged.

## Layout

| Path | What it is |
|---|---|
| `material-types.js` | Shared constants: limits, kinds, error codes, service envelope, JSDoc types. |
| `material-validation.js` | Text normalization (mirrors `js/material.js` step-for-step), char counting (UTF-16 units, like the existing 50k gate), title/subject/kind/text validation. |
| `material-ownership.js` | Session-token → userId resolution, `isAccountRow` mirror, no-existence-leak guards. No anonymousId parameter exists by design. |
| `material-repo-memory.js` | In-memory repository implementing the persistence contract + session store. Swap for Convex at integration. |
| `material-service.js` | `MaterialService`: create/list/get/rename/delete + `getMaterialForGeneration` (the AI choke point). All collaborators injected. |
| `material-cleanup.js` | `purgeUserMaterials(userId, repo, {batch})` — account-deletion extension, batch 200 like existing cleanup. |
| `create-quiz-adapter.js` | Create Quiz integration contract: `inline` / `saved` / `saved-new` modes; text resolved server-side, never from the client. |
| `schema-proposal.ts` | Proposed `materials` table + proposed `attempts.materialId` migration. **Not applied.** |
| `convex-materials.ts` | Proposed Convex wiring (becomes `convex/materials.ts` at integration). **Not live.** |
| `material-ui/` | Standalone UI prototype (`materials.html/css/js`). Demo data only, not routed. |
| `tests/` | `node:test` suite, zero dependencies. Run: `node --test tests/*.test.js` |
| `README.md` | This file. |
| `architecture.md` | Design decisions and module map. |
| `privacy-impact.md` | Privacy analysis of storing extracted text (does **not** claim `privacy.html` was updated). |
| `integration-plan.md` | Exact wiring diffs for the future integration PR. |

## Quick verification

```bash
cd ~/workspace/studypath/phase-c
node --test tests/*.test.js        # 55 tests, zero dependencies
```

Serve the prototype over HTTP (the bootstrap uses `fetch`, so `file://` won't work):

```bash
cd ~/workspace/studypath/phase-c/material-ui
python3 -m http.server 8080
# open http://localhost:8080/materials.html
```

## Key rules (non-negotiable, enforced by tests)

1. **Identity is session-derived.** No method accepts a client-supplied userId; there is no anonymousId path. Guests get `not_authenticated`.
2. **Existence is never leaked.** Missing and cross-user ids both return `material_not_found`.
3. **One validation implementation.** Limits (120–50,000 chars, 20/user, title ≤120) live in `material-validation.js`; the Convex wiring will call it, not re-implement it.
4. **Delete unlinks, never destroys history.** Attempts and questionResults survive material deletion; only `materialId` is cleared.
5. **AI input choke point.** `getMaterialForGeneration` resolves text from the session owner's row — generation can never receive another user's text.

## Constraints honored

- No existing file modified, overwritten, deleted, renamed, or refactored (verified against `~/workspace/studypath-baseline-checksums.txt`).
- New files only under `phase-c/` (plus `/tmp` scratch).
- No A2/B/D/E/F scope: no study guides, no tutor, no embeddings/vector DB, no new AI provider.

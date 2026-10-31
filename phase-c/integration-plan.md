# Phase C — Integration Plan

> How the Phase C implementation (this directory) gets wired into the live
> app. Nothing here has been applied yet; this is the future PR's checklist.
> All file/line references were audited 2026-10-01 against the live tree.

## 0. Preconditions

- [ ] Copy `phase-c/material-{types,validation,ownership,repo-memory,service,cleanup}.js`
      and `phase-c/create-quiz-adapter.js` into the deployment so
      `convex/materials.ts` can import them (same bundling as any local module).
- [ ] Apply `phase-c/schema-proposal.ts` to `convex/schema.ts`:
      add the `materials` table; add `materialId: v.optional(v.id("materials"))`
      to `attempts`; add the `by_material` index. No backfill needed —
      absent `materialId` already means "pre-Phase-C / unsaved material".

## 1. New Convex wiring

- [ ] Add `convex/materials.ts` from `phase-c/convex-materials.ts`
      (plural — `convex/material.ts` already exists as the validation module).
      Exposes: `saveMaterial`, `renameMaterial`, `deleteMaterial`,
      `listMaterials`, `getMaterial`, internal `resolveMaterialForGeneration`,
      internal `purgeUserMaterials`.
- [ ] `convex/auth.ts` → `purgeUser`: schedule `purgeUserMaterials` after the
      existing `purgeUserAttempts` + `purgeUserQuestionResults` scheduling.
      Order: avatar → sessions → reports → user row (existing) → attempts +
      questionResults (existing jobs) → materials (new, last).
- [ ] Rate limiting: reuse the existing fixed-window bucket pattern
      (`convex/auth.ts` `bumpBucket`) for `saveMaterial` (per account/hour).

## 2. Quiz generation (the AI choke point, §19)

`convex/quiz.ts` → `generateQuiz`:

- [ ] Accept optional `materialId` alongside the existing
      `material: { text, label }` arg.
- [ ] When `materialId` is present: call internal
      `resolveMaterialForGeneration({ sessionToken, materialId })`; use the
      returned `text`/`label` as the model input. Never trust client text
      when an id is given.
- [ ] `convex/attempts.ts` → `saveAttempt`: accept optional `materialId`;
      verify ownership (same session check) before storing it on the attempt.

## 3. Create Quiz UI

`js/app.js:646` (audited):

```js
material: draft.tab === 'sample' ? null : { text: mat.extractedText, label: mat.fileName || 'Pasted text' },
```

- [ ] Add a "From my library" source mode to the Create Quiz view, driven by
      `create-quiz-adapter.js` (`forSavedMaterial` / `forNewlySavedMaterial` /
      `forInlineText`, `availableModes(signedIn)`).
- [ ] Saved modes send `{ materialId, label }` (adapter output); the inline
      mode keeps sending `{ text, label }` exactly as today (guests: inline only).
- [ ] After quiz creation from a saved material, store `materialId` on the
      attempt via the extended `saveAttempt`.

## 4. Material library UI

- [ ] Port `phase-c/material-ui/` into the app's router as a real view
      ("My Materials"): replace the in-memory repo + demo seed with
      `convex-client.js` calls to `materials:listMaterials` etc., following
      the existing `{ok, data} / {ok, error}` envelope handling.
- [ ] Keep the design tokens (already copied from `css/styles.css`).
- [ ] Library entry point: nav item visible to signed-in users only.

## 5. Save flow (extraction → library)

- [ ] After `js/material.js` extraction succeeds, signed-in users get
      "Save to my library" (title prompt, defaulting to file name).
      Calls `materials:saveMaterial` with the normalized text.
- [ ] Client-side pre-validation via `material-validation.js`
      (already the same code the server runs); server re-validates.

## 6. Privacy & copy

- [ ] Update `privacy.html` per `privacy-impact.md` (the "we do not save the
      source text" statement must change for signed-in accounts).
- [ ] First-save notice: "Saved to your library — only you can see it,
      delete anytime."

## 7. Verification at integration

- [ ] `node --test phase-c/tests/*.test.js` green (55 tests).
- [ ] Convex typecheck + push to dev deployment; exercise save/list/rename/
      delete as two accounts; confirm cross-user `material_not_found`.
- [ ] Delete an account; confirm attempts, questionResults, and materials
      are all gone and in the right order.
- [ ] Confirm guest flow is byte-for-byte today's behavior (sessionStorage,
      no new network calls).

## Explicitly out of scope

Study guides (D), tutor (B), embeddings/vector DB, new AI providers,
material sharing, public libraries — none of these are in Phase C.

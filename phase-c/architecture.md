# Phase C — Architecture

## Problem

Today, study material lives and dies with the browser tab: extraction
happens client-side (`js/material.js`), the text sits in sessionStorage,
and quiz generation (`js/app.js:646` → `convex/quiz.ts generateQuiz`) takes
`{ text, label }` inline. Signed-in users re-upload the same document every
time. Phase C gives accounts a persistent library; guests keep the exact
current behavior.

## Module map

```
┌─────────────────────────────────────────────────────────────┐
│  material-types.js       constants: LIMITS, KINDS,            │
│                          ERROR_CODES, envelope helpers       │
└──────────────┬──────────────────────────────────────────────┘
               │ required by
┌──────────────▼──────────────────────────────────────────────┐
│  material-validation.js  normalizeText (mirrors              │
│  material-ownership.js   js/material.js), validate*,        │
│                          resolveOwner, isAccountRow,          │
│                          ownerCanAccess/requireOwnership     │
└──────────────┬──────────────────────────────────────────────┘
               │ used by
┌──────────────▼──────────────────────────────────────────────┐
│  material-service.js     MaterialService { repo, findSession,│
│                          getUser, attemptLinkage, now }       │
│   create · list · get · rename · delete ·                   │
│   getMaterialForGeneration (AI choke point)                 │
└──────┬──────────────────────────────┬───────────────────────┘
       │ persists via                 │ clears refs via
┌──────▼───────────────────┐   ┌──────▼───────────────────┐
│ material-repo-memory.js  │   │ attemptLinkage           │
│ MemoryMaterialRepository │   │ (injected; Convex impl  │
│ makeSessionStore         │   │ patches attempts via    │
│ toSummary                │   │ by_material at wiring)   │
└──────────────────────────┘   └──────────────────────────┘

  material-cleanup.js      purgeUserMaterials — account-deletion
                           extension, batch 200, materials last.

  create-quiz-adapter.js   inline / saved / saved-new modes;
                           toGenerationArgs() — the contract the
                           future Create Quiz view will speak.
```

## Why plain CommonJS, not TypeScript

The core is testable with `node:test` and zero dependencies — no build
step, no Convex runtime needed. The two `.ts` files (`schema-proposal.ts`,
`convex-materials.ts`) are integration-time artifacts only, written in the
existing `convex/*.ts` idiom so they drop in cleanly. There is exactly one
implementation of every rule; the Convex layer adapts `ctx` to the core's
injected collaborators rather than re-implementing anything.

## Identity & ownership

Mirrors `convex/attempts.ts` + `convex/lib/ownRows.ts` exactly:

- `findValidSessionUserId(ctx, sessionToken)` → userId, else null.
- `isAccountRow(user)` = `email || passwordHash`. Session tokens minted for
  pure guest rows resolve to `not_authenticated` — there is no anonymousId
  parameter anywhere in the ownership module, so no caller can smuggle one.
- Every CRUD path re-resolves ownership from the token. The client never
  supplies a userId; forged `userId` fields in input are ignored (tested).
- Missing vs. foreign ids are indistinguishable: `material_not_found` for both.

## Data model (proposed — see schema-proposal.ts)

`materials`: `userId`, `title` (1–120), `subject?` (≤120), `kind`
(pdf|docx|txt|paste), `extractedText` (120–50,000 chars), `charCount`
(denormalized for list views), `createdAt`, `updatedAt`.
Indexes: `by_user`, `by_user_and_updated` (bounded, newest-first reads).

`attempts.materialId` (optional): link, not a copy. Deleting a material
clears the reference via the `by_material` index in bounded batches;
attempts, answers, and per-question rows are never touched.

## Limits & why these numbers

| Limit | Value | Rationale |
|---|---|---|
| Text length | 120–50,000 chars | Same gate as existing `convex/material.ts` — quiz-ready floor, model-context ceiling. |
| Materials per user | 20 | Generous for a study library; bounds storage per account without a quota system. |
| Title / subject | ≤120 chars | UI-safe, matches existing label caps (`attempts` title ≤200). |
| Binary storage | never | Only normalized extracted text persists — same posture as today's pipeline. |

Char counting uses UTF-16 `text.length`, matching the existing server-side
50k enforcement exactly (a "50k code points" rule would diverge from it).

## Generation path (§19)

`getMaterialForGeneration(sessionToken, materialId)` is the single choke
point: it resolves `(session → userId) + materialId → text` server-side.
The future `generateQuiz` will accept `materialId` instead of raw text for
the saved-material modes; the model input can therefore never be another
user's text, and raw client text only flows in the legacy inline mode
(which keeps today's behavior for guests).

## Deletion & account cleanup

- **User deletes a material:** row deleted; `attemptLinkage.unlinkMaterial`
  clears `materialId` on referencing attempts (bounded). Scores, answers,
  question results, weak-area signals all survive — they embed the quiz
  content they need and never depended on the material text.
- **User deletes their account:** existing jobs purge attempts and
  questionResults first (unchanged), then the new `purgeUserMaterials`
  extension runs — batch 200, self-rescheduling, same pattern as
  `purgeUserAttempts` in `convex/accountCleanup.ts`.

## UI prototype

`material-ui/` is standalone: library grid, detail view with text preview,
create form with instant validation, rename/delete with confirmation, and
a "Use for quiz" panel showing the adapter output. It drives the real core
against an in-memory repo seeded with clearly-labeled demo data. It is not
routed from the app; wiring is specified in `integration-plan.md`.

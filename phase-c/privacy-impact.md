# Phase C — Privacy Impact Assessment

> **Scope note:** this is a new analysis document. `privacy.html` was
> **not** modified as part of Phase C; the "required changes" section below
> lists what must be updated there at integration time.

## What changes

Today, `privacy.html` states (audited 2026-10-01): **"We do not save the
source text itself in our database."** That statement is true today because
material text lives only in the tab's sessionStorage and is sent inline to
quiz generation.

Phase C deliberately changes this for **signed-in users only**: extracted,
normalized study text (120–50,000 chars) is persisted in the proposed
`materials` table, keyed to the account. Guest behavior is unchanged —
guest material still never leaves the browser tab.

## Data stored (new)

| Datum | Where | Notes |
|---|---|---|
| `extractedText` | `materials.extractedText` | Normalized text the user supplied (upload extraction or paste). Never the original binary. |
| `title`, `subject`, `kind` | `materials` | User-provided labels. |
| `charCount` | `materials` | Denormalized length for list views. |
| `attempts.materialId` | `attempts` | Optional link from a quiz attempt to its source material. |

No new third parties receive this data. The text flows to the existing AI
provider only at quiz-generation time — the same flow as today, except the
text is resolved server-side from the user's own row instead of arriving
inline from the client.

## Risk analysis

1. **Cross-account exposure.** Mitigated by construction: ownership is
   resolved server-side from the session token on every access; there is no
   client-supplied userId and no anonymousId path; missing and foreign ids
   return the same `material_not_found`. The AI choke point
   (`getMaterialForGeneration`) can only resolve the session owner's text.
   Covered by ownership tests (cross-user isolation, forged sessions,
   guest rejection).

2. **Data retention beyond intent.** Users may forget saved materials
   persist. Mitigations: per-material delete (immediate), account deletion
   purges all materials (new `purgeUserMaterials`, batched, runs after
   attempts/questionResults per the existing cleanup order), and a visible
   20-material cap keeps libraries bounded and reviewable.

3. **Copies of the text.** The full text is returned only by `getMaterial`
   (owner-only) and `resolveMaterialForGeneration` (internal, server-side).
   List views return summaries without the blob, so browsing the library
   never moves 50k-char texts around unnecessarily.

4. **The old privacy statement becomes false.** This is the one hard
   requirement: `privacy.html` must be updated at integration (see below).
   Shipping Phase C without that update would leave a false statement live.

## Required changes at integration time

- [ ] `privacy.html`: revise the "we do not save the source text" statement
      to describe saved materials for signed-in accounts (what is stored,
      why, how to delete, that guests are unaffected).
- [ ] Consider: an in-app notice on first material save ("Saved to your
      library — visible only to you, deletable anytime"), and a "storage"
      line in account settings showing material count.
- [ ] No changes needed to the existing data-deletion flow beyond wiring
      `purgeUserMaterials` into `purgeUser` (already specified in
      `integration-plan.md`).

## Out of scope (explicitly not introduced)

Embeddings or vector storage of material text, sharing materials between
users, public libraries, or any new AI provider — all deferred per the
Phase C brief (no A2/B/D/E/F).

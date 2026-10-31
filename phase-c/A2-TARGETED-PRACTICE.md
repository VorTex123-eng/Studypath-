# A2 — AI-Generated Targeted Practice (2026-10-02)

## What it is

One weak area (Subject + Topic, from A1) → the backend finds the learner's
own saved material about that topic → Gemini writes NEW questions grounded
in short passages from it → the quiz enters the normal engine untouched
(ready screen → Start → quiz → results → `saveAttempt` with
`practiceSource: "targeted_ai"`).

## Retrieval algorithm (keyword-based, not semantic)

Implemented in `convex/lib/targetedRetrieval.ts` (pure, unit-tested).
No embeddings, no vector DB, no new AI provider — a deliberate constraint.

1. **Weak-area lookup.** `findWeakAreaBucket` matches the requested
   `subjectKey + "|" + topicKey` against the live A1 report.
   `isEligibleWeakArea` accepts only the statuses Focused Practice surfaces
   (`established`, `emerging`, `improving`); the `general` bucket is excluded
   as too broad to target. A2 never redefines "weak".
2. **Material ranking (metadata only).** `rankMaterials` scores each of the
   user's materials without reading any text:
   - `subjectMatchScore`: 100 = canonical subject-key match on stored
     subject metadata; 60 = strong title-word overlap; 30 = weak overlap;
     0 = none. Canonicalisation is alias-aware for retrieval only
     (`Maths`/`Math` = `Mathematics`; see aliases below).
   - A material whose STORED subject is known and canonically disagrees
     is **hard-excluded** (`isSubjectExcluded`): never fetched, never
     selected, whatever the topic evidence. A material with NO stored
     subject is "unknown", not wrong.
   - Small title/topic-word bonus (max 15).
   - Fetch gate (`isFetchCandidate`, the single gate the action applies):
     not excluded AND (score ≥ 60, OR subject unknown with the topic
     phrase in the title — then the passage evidence bar decides).
3. **Passage extraction (top ≤3 materials only).** Full text is fetched for
   at most 3 candidates (`TARGETED_MAX_MATERIALS_FETCHED`), ownership
   re-verified per row. `extractPassages` splits text into paragraphs and
   scores each against the topic terms with **variant-tolerant matching**:
   words match up to singular/plural via the same `singularise()` the
   topic keys use ("equation" = "equations"); the phrase must still match
   in order and contiguously (no semantic matching — "Cell Division" does
   not match "Mitosis and Meiosis"). Phrase ×10 per hit, keywords ×2,
   heading phrase bonus +8 / keyword bonus +4. Headings are detected on
   the first line of multi-line blocks AND on standalone single-line
   blocks (ALL-CAPS, trailing colon, `#` markdown, or Title Case without
   terminal punctuation); the hit block's neighbor expansion pulls the
   headed paragraphs into the passage. Zero-score blocks are dropped.
   The best material needs total evidence ≥ 12
   (`TARGETED_MIN_PASSAGE_SCORE`, unchanged).
4. **Bounded context.** `buildTargetedContext` joins the best passages
   (best-first) and hard-caps the total at 8000 chars
   (`TARGETED_MAX_CONTEXT_CHARS`). Only this string reaches Gemini — never
   the whole library, never another user's text.
5. **Fail safe.** If no material is sufficiently relevant, the action throws
   `no_material` ("No saved material found for this weak area."). There is
   **no generic ungrounded fallback** — this is a deliberate product rule.

## Prompt

`buildTargetedPrompt` pins Subject, the weak topic, the passages as the ONLY
source, question count (3–20, default 8), difficulty (existing scale, default
`medium` — never auto-Expert), allowed types, and a novelty contract: NEW
questions, never copies of material exercises or previous questions, with
`topic` set to exactly the weak topic so A1 keeps tracking the same
subject+topic bucket. Calculation-heavy material gets the "invent a NEW
problem instance" framing (shared `detectsCalculationMaterial` heuristic).

## Reused infrastructure (nothing new)

- Same `./ai/model` transport (timeout / retry / model fallback), same
  `validateQuestion` server validation, same math verification and topic
  repair via the shared `attemptGeneration` path (`promptOverride`).
- Same server-side generation quota (5/10-min burst + 20/day), enforced
  **before** any Gemini spend via `resolveIdentityAndCheckRateLimit`.
- Novelty backstop: generated questions whose `questionKey` matches one the
  learner already saw on this subject+topic fail validation once, triggering
  a regeneration with stronger novelty wording.

## Limitations (known, accepted)

- **Keyword-based, not semantic.** Retrieval matches terms up to
  singular/plural variation — it cannot find a passage that teaches the
  concept with different vocabulary ("Mitosis and Meiosis" for the topic
  "Cell Division"), and paraphrased material can still be missed. This is
  conservative by design (precision over recall).
- **Subject matching is metadata-first.** Materials without a stored
  subject rely on title signals; a file whose title carries neither the
  subject nor the topic (e.g. "MTH101 Notes") is never fetched — the
  system will not guess what "MTH101" means.
- **Retrieval-only subject aliases** (documented, minimal): `maths` and
  `math` are treated as `mathematics` for material candidacy ONLY. The A1
  learning identity is untouched — "Maths" and "Mathematics" remain
  separate weak-area buckets (a missed merge is safer than a false merge
  there). No other subject merging is attempted.
- **Guests are rejected** (`not_authenticated`): targeted practice is
  grounded in saved materials, which are signed-in-only.
- **Diagnostics are test-only.** `diagnoseTargetedRetrieval` exposes the
  per-stage decision (subject/title/fetch/evidence) for tests; it is never
  called by the action and no material text is ever sent to the client
  through it.
- **No real-deployment testing** was possible in this environment (no
  network/toolchain): the action, rate limiter, and Gemini round-trip must
  be verified after `npx convex deploy` (see the A2 report's checklist).

## Generation-failure diagnosis (2026-10-02)

The retrieval fix was verified live, but generation still failed with the
generic "Couldn't generate targeted practice right now." Production
dashboard logs gave the ground truth:

```
[quiz.generateTargetedPractice] gemini-3.6-flash failed with provider_error,
  falling back to gemini-3.5-flash-lite.
[quiz.generateQuiz] Gemini HTTP 503: "This model is currently experiencing
  high demand."
```

GEMINI_API_KEY is set; Gemini returns HTTP 503 on BOTH the primary and
fallback models. The retry/fallback machinery works as designed (it fell
back, both failed, it failed safe) — normal quiz generation fails
identically right now. NOT an A2 code defect.

A mocked end-to-end harness (`phase-c/tests/targeted-generation.test.js`)
drives the REAL `generateTargetedPractice` handler with staged internal
queries and a stubbed Gemini transport and proves stages 4–14 are clean:
no code bug in the action, prompt builder, validation, topic repair,
novelty check, or response shape for any mocked provider behavior. (The
harness also caught a real `let`-in-try block-scoping bug in the first
version of the quota-refund wiring before it shipped.)

Two code changes resulted, both diagnosability/fairness — no retrieval,
validation, or engine changes:

1. **Honest error codes.** `targetedErrorFor` now maps `provider_error`
   and `timeout` instead of collapsing them into generic
   `generation_failed`, and the Focused Practice UI renders "The AI
   service is overloaded right now. Please try again in a little while."
   for them (plus the earlier `not_configured` branch). No provider
   internals leak.
2. **Quota refund on provider failure.** `bumpBucket` charged burst+daily
   quota on every attempt, including doomed ones — during an outage the
   user burns their 20/day allowance and stays locked out after recovery.
   New internal `refundGenerationQuota` mutation hands the unit back when
   the failure is provider-side (`network_error`, `timeout`,
   `provider_error`, `bad_response`, `empty_response`); validation and
   model-output failures keep the charge, and `not_configured` keeps
   backpressure. Best-effort, never masks the original error.

To confirm recovery: Convex dashboard → this deployment → Settings →
Environment Variables (key present), then retry once Gemini stops 503ing.
Each failed click during the outage no longer burns the daily allowance.

# Subject/Topic Contamination Fix (A1) — 2026-10-02

## Root cause

Weak areas were grouped by `topicKey` alone (`convex/lib/weakness.ts`), and there
was no application-owned subject anywhere in the quiz pipeline:
`convex/quiz.ts` set the generated quiz's `subject` to `material.label` (the
uploaded file name / material title), the Create Quiz flow had no subject
input, and that label flowed through `sess.subject` → `saveAttempt` →
`deriveQuestionResults` onto every questionResult row. Two subjects sharing a
topic name ("Waves" in Mathematics and Physics) merged into one bucket by
design, and the bucket wore the newest row's label — so a Mathematics quiz
could surface under a Biology weak area.

## The fix

**Subject = application-owned quiz context. Topic = AI/question-level
concept. Weak-area identity = Subject + Topic.**

- `convex/lib/weakness.ts`: rows group by
  `subjectKeyFor(subject) + "|" + topicKeyFor(topic)`. `subjectKeyFor` is
  deliberately light (lowercase/trim/strip accents) — a wrong merge would
  silently mix two subjects' data, so near-misses ("Maths" vs "Mathematics")
  stay separate on purpose. `WeakArea` now carries `subjectKey` and a cleaned
  `subject` display string.
- `convex/quiz.ts`: `generateQuiz` accepts optional `subject`, trims/caps it
  at 120 chars, and assigns it to the quiz; falls back to `material.label`
  only when empty (old behavior preserved). The AI response schema has no
  subject field — the model can never set or overwrite it. `attemptGeneration`
  receives it as a parameter. `getKnownTopicsForUser` is now called with the
  resolved subject (its same-subject boost finally compares real subjects).
- `js/app.js`: one optional "Subject" input on the Create Quiz config panel;
  prefilled from a library material's stored subject when the user hasn't
  typed one. Threaded through `onGenerateClick` → provider → action.
  `weakAreasHtml` shows "Topic · Subject" in the existing muted style —
  nothing else visual changed. `weakAreaPracticeQuestions` matches questions
  to areas by subject+topic (practice sessions keep legacy topic-only
  matching, since they mix subjects by construction).
- `js/generator.js`: backend provider forwards `subject`; mock provider uses
  `config.subject` with the label fallback, same as the server.
- `convex/lib/revisit.ts`: `subject` is carried through rows → items
  (context only; grouping was and remains per-questionKey, so no
  contamination was possible there).
- Save-to-library form gained an optional Subject field so stored materials
  can carry one for the prefill.

## Old data — intentionally NOT migrated

Existing questionResults rows keep whatever subject they were stamped with
(material labels like "Biology Notes.pdf"). Under the new identity they form
their own buckets; nothing merges across subjects going forward, and nothing
was guessed or rewritten. Repairing old rows deterministically is impossible
in the general case (the true subject is unrecoverable from a file name),
so they are left intact. Over time, new quizzes with real subjects build
clean buckets alongside them.

## What to verify on deploy

- `npx convex deploy` (or `convex dev`) then `tsc --noEmit` if available —
  the Convex functions changed (`quiz.ts`, `lib/weakness.ts`,
  `lib/revisit.ts`).
- Regression: `node --test phase-c/tests/*.test.js` (66 tests).
- Manual: create quizzes with an explicit subject, check weak areas show
  "Topic · Subject", and confirm same-named topics from two subjects stay
  separate.

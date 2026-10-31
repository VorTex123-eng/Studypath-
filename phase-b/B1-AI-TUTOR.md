# B1: AI Tutor — Design

**Date:** 2026-10-04. **Status:** design approved by brief; implementing.

## Goal

SAVED MATERIAL → TUTOR → QUESTION → RELEVANT RETRIEVAL → BOUNDED CONTEXT → GROUNDED RESPONSE → FOLLOW-UP. A study-material-grounded tutor, not a generic chatbot. A2 stays frozen and untouched.

## Architecture (reuses everything)

```
Studypath AI Layer
├── Quiz Generation (convex/quiz.ts — untouched)
├── Targeted Practice (A2 — frozen, untouched)
└── AI Tutor (NEW: convex/tutor.ts + convex/lib/tutorRetrieval.ts)
        ├── transport: callGeminiJson / runWithFallback (convex/ai/model.ts — reused)
        ├── retrieval: extractPassages + buildTargetedContext (convex/lib/targetedRetrieval.ts — reused, A2 file NOT modified)
        ├── rate limit: bumpBucket pattern on tutor:* keys (mirrors quiz.ts)
        ├── errors: tutorErrorFor (mirrors targetedErrorFor)
        └── ownership: ownedMaterial pattern (mirrors convex/materials.ts)
```

No new providers, no embeddings, no vector DB, no new frameworks.

## Retrieval (bounded, keyword-based — same philosophy as A2)

Tutor retrieval is simpler than A2's: the material is explicitly chosen (no
subject ranking needed), so the pipeline is:

1. `questionSearchTerms(question)` → `{ phrase: "", keywords: [...] }` — significant
   words (len > 2, stopwords removed), singularised at match time. Phrase is
   intentionally empty: tutor questions are natural language ("What is
   mitosis?"), so keyword evidence is the workhorse; phrase matching would
   demand the literal question wording appear in the text.
2. `extractPassages(terms, material.extractedText)` (A2's, reused) → scored passages.
3. Evidence gate: `TUTOR_MIN_EVIDENCE = 6`. Below it, ONE fallback pass with
   terms from current + previous user message (pronoun follow-ups like
   "Why is sunlight important?"). Still below → deterministic honest
   response, NO model call (saves quota, cannot hallucinate).
4. `buildTargetedContext(passages, TUTOR_MAX_CONTEXT_CHARS = 6000)` → bounded context.

## Conversation persistence (server-side, simplest reliable)

Two new tables (see schema below). Every message round-trips through the
server, which owns the history — no client-trusted context.

- `tutorConversations`: userId, materialId, title, createdAt, updatedAt.
  Max 20/user (oldest pruned). Indexed by_user, by_user_and_material.
- `tutorMessages`: conversationId, userId (denormalized for purge/isolation),
  role (user|tutor), text, grounded (tutor msgs), createdAt.
  Max 50/conversation (oldest 10 pruned). Indexed by_conversation, by_user.

Why server-side, not localStorage: multi-turn context must be server-owned
anyway (the model prompt is built server-side); refresh survival and the
"strict user ownership" requirement both fall out naturally. Guests have no
tutor (materials are signed-in-only; tutor requires a valid session).

## Actions (convex/tutor.ts)

- `startConversation({sessionToken, materialId})` → ownership-checked;
  creates conversation (pruning to 20 cap); returns `{conversationId, materialTitle}`.
- `sendMessage({sessionToken, conversationId, message})` → the full pipeline:
  auth → ownership → validate (≤2000 chars) → rate limit → retrieve →
  (insufficient → honest fixed reply, saved) → build prompt w/ last 10 msgs →
  runWithFallback(callGeminiJson + validateTutorResponse) → save both messages
  → return `{answer, groundedInMaterial}`.
- `getConversation({sessionToken, conversationId})` → ownership-checked;
  returns material title + up to 50 messages.
- `listConversations({sessionToken})` → newest-first, 20 cap. (Server-side
  ready for future UI; B1 UI always starts a fresh conversation per material.)

Cross-user access (foreign conversationId/materialId) returns the same
`not_found` as a missing row — existence is never leaked.

## Response contract

`{ answer: string (1..4000 chars), groundedInMaterial: boolean }` via
`responseMimeType: application/json` + schema. `validateTutorResponse`
rejects malformed output → `validation_failed` → one same-model retry with a
correction note → then `invalid_response` to the client. The prompt requires
the model to set `groundedInMaterial` honestly and to phrase accordingly
("Your material covers…" vs "Your material doesn't go into detail here…").

## Rate limiting

`tutor:burst:<userId>:<window>` 10/10min, `tutor:daily:<userId>:<day>` 50/day —
separate keys from generation quota (a quiz-gen block must not silence the
tutor and vice versa). Consumed once per sendMessage, before the model call.
No refund on provider failure (documented; 50/day is generous).

## Errors (tutorErrorFor — distinct codes, safe messages)

not_authenticated, bad_request, not_found (missing OR foreign — no leak),
material_unavailable, rate_limited, insufficient_context (fixed honest reply,
not an error to the user), not_configured, provider_error, timeout,
network_error, invalid_response, tutor_failed (generic fallback). Raw provider
text never reaches the client; codes + details go to server logs.

## Frontend (tutor.html + app.js, existing design system)

- Entry: material detail view gains "Ask Tutor" (primary flow per brief).
  No top-nav entry (keep B1 focused).
- `tutor.html?materialId=X` → startConversation → empty state.
  `?conversationId=Y` → getConversation → history (refresh survival).
  Guests → sign-in prompt (tutor is signed-in-only).
- Chat UI: material header ("Tutoring from: {title}"), message list,
  textarea + Send, typing indicator, error bubble with Retry, send locked
  while in-flight (`tutorUI.sending` — duplicate sends impossible),
  Enter-to-send, auto-scroll, escaped HTML + paragraph breaks (no markdown
  parser, no new deps). Mobile-first, existing tokens/classes only.

## Deletion

`purgeUserTutorData` internal batched mutation (mirrors purgeUserAttempts);
scheduled from `purgeUser` in convex/auth.ts. Stabilization rule upheld:
every user-data table is purged.

## Tunables (documented, not magic)

TUTOR_MAX_CONTEXT_CHARS=6000, TUTOR_MIN_EVIDENCE=6,
TUTOR_MAX_PASSAGES=4 (via extractPassages slice), history window=10 msgs,
message cap 2000 chars in / 4000 out, 50 msgs/conversation, 20 convos/user,
burst 10/10min, daily 50/day.

## B1D Completion (2026-10-05)

### Persistence (the refresh bug)
Root cause: the backend always persisted conversations, but the frontend never
wrote `?c=<id>` into the URL after `startConversation`. A refresh re-ran
`?materialId=` and opened a *new* conversation instead of resuming. Fix:
`window.history.replaceState` pins `?c=` after start (uses `window.history`
because the app's `function history()` page shadows the bare global).
Refresh/leave/return now resumes via the existing `tutor:getConversation`.

### Added
- Conversation history: `tutor.html` (no params) lists recent conversations
  (title, message count, relative time) with open/continue and delete.
  Backend: `tutorConversations.messageCount` (optional, denormalized, +2 per
  exchange), `deleteConversation` action + `deleteConversationRow` internal
  mutation (ownership-checked; messages purged with the conversation).
- Discoverability: "Tutor" in top nav + mobile bottom nav (matching SVG icon),
  "Ask the AI Tutor" in the dashboard Quick start panel, "Tutor" button on each
  materials-library row. No popups or onboarding.
- Quiz integration: review page shows "Ask Tutor why" on wrong answers for
  material-grounded quizzes only (`r.materialId`). Opens the tutor on that
  material with a bounded pre-filled question (question + your answer + correct
  answer, sliced to 500/300/300 chars) answered through the normal grounded
  pipeline via `startConversation(initialMessage)`.
- Weak-area integration: each weak area offers "Ask Tutor to explain", opening
  a material picker (user's materials, subject matches first) so grounding
  stays explicit. A2 untouched: no targeted generation, no scoring changes.
- Icons: 📖/💬 replaced with Font Awesome (`fa-book-open`, `fa-comments`).
- Copy: create-page free-plan notice shortened to two sentences; legal
  disclosure (sent to Google's AI; free-plan product improvement) kept.
  No em dashes in new/modified UI copy (audited).

### Not changed
Retrieval, grounding honesty, rate limits, auth, A1 scoring, A2 (still frozen),
Material Library ownership, quiz generation.

### Tests
`phase-c/tests/tutor-b1d.test.js`: 11 new tests (messageCount, delete +
ownership, history list, refresh URL pinning, integration links, icons, copy).
Full suite: 210/210 green.

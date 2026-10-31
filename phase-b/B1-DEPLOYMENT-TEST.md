# B1 AI Tutor — Real Deployment Test Script

For Eghosa, after extracting `studypath-functional.zip` and running `npx convex dev`.
Covers the brief's 11 real-world checks. Everything is manual UI except where noted.

## Setup

1. Deploy: extract the flat zip over your project folder, run `npx convex dev`, wait for sync.
2. Verify the new functions are live (Convex dashboard → Functions, or CLI):
   `tutor:startConversation`, `tutor:sendMessage`, `tutor:getConversation`, `tutor:listConversations`
3. Sign in on the deployed frontend. Open **My Materials** and confirm you have at least one
   saved material with real study text (upload/paste something with a few paragraphs if needed).

## The 11 checks

### 1–2. Open saved material → open Tutor
- Open a material → tap **Ask Tutor**.
- Expect: tutor page loads, header reads **"Tutoring from: <your material title>"**, empty state invites a question.

### 3–4. Grounded answer
- Ask a question whose answer is clearly in the material (e.g. material defines mitosis → "What is mitosis?").
- Expect: answer uses the material's facts/terms. Check the Convex logs for `tutor.sendMessage` (no error lines).

### 5–6. Follow-up keeps context
- Ask a follow-up that depends on the previous turn (e.g. "Why is it important?" or "Give me an example").
- Expect: the tutor answers in the same thread, referencing the earlier topic. Refresh the page
  (`tutor.html?c=<id>` should persist — copy the URL before refreshing): the history must still be there.

### 7–8. Honest "not in the material"
- Ask something the material clearly does NOT cover (e.g. "What is the capital of France?").
- Expect: a message like *"I couldn't find enough in "…" to answer that reliably…"* — it must NOT
  invent an answer and claim the material says so.

### 9. Provider failure
- Hard to force on demand. Two options:
  a. Temporarily set a wrong `GEMINI_API_KEY` in the Convex dashboard → ask a question → expect a clean
     "AI service" message (not a crash, not a raw stack trace). Then restore the key.
  b. If Gemini has an outage window, note the message shown.
- Expect: simple user-facing message; the Convex function log shows the real code (`provider_error`/`timeout`).

### 10–11. Mobile + desktop
- Mobile: chat is readable, input bar is reachable, Send is a comfortable tap target, Enter on a
  hardware keyboard sends. Double-tap Send fast → only ONE reply appears (duplicate guard).
- Desktop: same flow; Enter sends, Shift+Enter makes a newline.

## Failure diagnosis (if anything looks wrong)

- "Please sign in again" → session expired; sign in again.
- "That saved material is no longer available" → the material was deleted; pick another.
- "You've sent a lot of tutor messages today" → the 50/day tutor quota tripped (separate from quiz quota).
- Blank page / console errors → check the browser console and tell Muse the exact message.
- In the Convex dashboard logs, every tutor failure is logged with its real code
  (`not_authenticated`, `material_unavailable`, `rate_limited`, `provider_error`, `timeout`,
  `invalid_response`, …) — paste the code and I can trace it.

## Quick regression sweep (do NOT skip)

- Create a quiz from a saved material (normal flow) — must work exactly as before.
- Weak areas / Focused Practice (A1) — unchanged.
- Confirm there is still NO visible "targeted practice" entry (A2 stays frozen).
- Sign out → tutor page shows the sign-in prompt, not a chat.

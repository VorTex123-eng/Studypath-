# Studypath M0-M9 (+ functionality layer)

A responsive, multi-page Studypath implementation. The original M0-M9 visual
design is unchanged; this layer adds real study-material ingestion and a
genuinely functional quiz workflow. No backend, API key, or paid AI service
is required — question generation runs entirely client-side.

## Run

Open `index.html` in any modern browser, or serve the folder locally:

```powershell
python -m http.server 8080
```

Then visit `http://localhost:8080`. Every page also supports direct navigation.
`create.html` loads pdf.js and mammoth.js from a CDN for PDF/DOCX extraction —
an internet connection is needed for those two file types (TXT and pasted
text work fully offline).

## Pages

Landing, dashboard, quiz creator, quiz engine, results, review, history,
progress, and settings are separate HTML routes. Shared styles live in
`css/styles.css`. Application logic is split into:

- `js/material.js` — file validation, PDF/DOCX/TXT extraction, text
  normalization, and the material state machine.
- `js/generator.js` — the quiz-generation provider abstraction. The mock
  provider derives real questions (MCQ/True-False/Short-Answer) from the
  user's own material using sentence/keyword heuristics — no API key needed.
  Swapping in a real backend/LLM provider later is a one-line change.
- `js/validate.js` — validates a generated quiz before it enters the engine.
- `js/app.js` — routing, dashboard, the create-quiz flow, the quiz engine
  (timer, navigator, study/exam modes), results, review, retry-incorrect,
  history, and progress.

## Test flow

Create a quiz from a PDF/DOCX/TXT upload, pasted text, or a built-in sample
topic -> configure difficulty/count/type/time/mode -> Generate -> Start ->
answer questions -> Submit -> Results -> Review -> Retry Incorrect (only the
missed/skipped questions) -> History -> Progress. Sessions persist to
localStorage; the in-progress quiz persists to sessionStorage so a refresh
mid-quiz doesn't lose answers.

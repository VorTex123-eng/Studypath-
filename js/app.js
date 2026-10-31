/* Studypath: application logic. Visual system (css/styles.css) is
   unchanged/extended-only; this file implements the actual product
   behavior on top of it. */

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full/unavailable */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch (e) {} }
};

// Active (in-progress) quiz session lives in sessionStorage: it should
// survive a refresh mid-quiz, but not persist forever like real history.
const activeSession = {
  key: 'studypath:active',
  get: () => { try { return JSON.parse(sessionStorage.getItem(activeSession.key) || 'null'); } catch (e) { return null; } },
  set: (v) => { try { sessionStorage.setItem(activeSession.key, JSON.stringify(v)); } catch (e) {} },
  clear: () => { try { sessionStorage.removeItem(activeSession.key); } catch (e) {} }
};

// Stabilization (M5/M6): server-sync bookkeeping. When the background
// sync of a completed quiz fails (offline, expired session, oversized
// payload), the record id is parked here and retried on the next app
// start; history rows render "not synced yet" until the server confirms.
function getPendingSync() { return store.get('pendingSync', []); }
function setPendingSync(ids) { store.set('pendingSync', ids); }
function markPendingSync(id) {
  const pending = getPendingSync();
  if (pending.indexOf(id) === -1) { pending.push(id); setPendingSync(pending); }
}
function unmarkPendingSync(id) {
  setPendingSync(getPendingSync().filter(function (x) { return x !== id; }));
}
function retryPendingSyncs(syncFn) {
  const pending = getPendingSync();
  if (!pending.length || typeof syncFn !== 'function') return;
  const all = store.get('sessions', []);
  pending.slice().forEach(function (id) {
    const record = all.find(function (r) { return r && r.id === id; });
    if (!record) { unmarkPendingSync(id); return; } // gone locally; nothing to sync
    try { syncFn(record); } catch (e) { /* stays pending */ }
  });
}

// Best-effort background copy of a completed quiz to Convex. Pure global:
// takes the record, never touches quiz-page closure state, so the retry
// pass in init() can reuse it.
function syncAttemptToConvex(record) {
  try {
    Convex.mutation('attempts:saveAttempt', {
      anonymousId: getAnonId(),
      sessionToken: Auth.getToken(),
      quizId: record.id,
      title: record.title,
      subject: record.subject,
      difficulty: record.difficulty,
      mode: record.mode,
      timeLimitMinutes: record.timeLimitMinutes,
      questionCount: record.questionCount,
      sourceMaterial: record.sourceMaterial,
      retryOf: record.retryOf,
      // Phase C: dropped server-side unless the session's account owns it.
      materialId: record.materialId || undefined,
      // A2: union-validated server-side; absent stays absent.
      practiceSource: record.practiceSource || undefined,
      questions: record.questions,
      answers: record.answers,
      correctCount: record.correctCount,
      incorrectCount: record.incorrectCount,
      skippedCount: record.skippedCount,
      score: record.score,
      completionTimeSeconds: record.completionTimeSeconds,
      topicPerformance: record.topicPerformance
    }, { keepalive: true }).then(function (res) {
      // The server confirmed the write (or reported a real failure) —
      // either way the pending flag is resolved honestly.
      if (res && res.ok && res.data && res.data.ok) unmarkPendingSync(record.id);
      else markPendingSync(record.id);
    }).catch(function () { markPendingSync(record.id); });
  } catch (e) { markPendingSync(record.id); /* Convex/getAnonId unavailable */ }
}

// Stabilization freeze: AI targeted practice (A2) is not released yet.
// When false, its entry points are hidden but no code is deleted —
// flip back to true to re-enable. Covers the per-weak-area button on
// the progress page and the ready-screen regenerate path.
const TARGETED_PRACTICE_ENABLED = false;

const esc = (s) => (window.Material ? Material.escapeHtml(s) : String(s == null ? '' : s));

const NAV_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1V10"/></svg>',
  create: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>',
  progress: '<svg viewBox="0 0 24 24"><path d="M4 20V10M11 20V4M18 20v-7"/></svg>',
  // Phase C: saved study materials - a small stack of pages.
  materials: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9.5L19 7v13.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M15 3.5V7.5h4.5"/><path d="M8.5 12h7M8.5 15.5h7"/></svg>',
  // B1D: AI Tutor discoverability - chat bubble in the same stroke style.
  tutor: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-5 3.5v-3.5H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M8.5 10h7M8.5 13h4.5"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.5a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 3.5 12.4H3.4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.48 2.54l.06.06A1.7 1.7 0 0 0 9.4 2.94 1.7 1.7 0 0 0 10.45 1.4V1.3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.05 1.54 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.02a1.7 1.7 0 0 0 1.55 1.04h.09a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.55 1.05Z"/></svg>'
};

function init() {
  theme();
  applyReducedMotion();
  renderShell();
  // A missing backend URL can never fail silently in one flow again: if
  // js/convex-config.js didn't run with a URL on this page load (missing
  // from the deploy, stale placeholder, blocked script), every page says
  // so up front instead of letting e.g. Save to Library be the first to
  // break. All Convex features share the one client in js/convex-client.js,
  // so this banner means all of them are down, not just one.
  const page = document.body.dataset.page;
  if (!window.CONVEX_URL) {
    console.error('[Studypath] window.CONVEX_URL is not set — the deployed js/convex-config.js is missing or empty.');
    // Legal/landing pages don't need the backend; don't scare readers with
    // a backend warning on a page that never uses it.
    if (page !== 'legal' && page !== 'landing') {
      const shell = document.querySelector('#shell');
      if (shell) {
        const banner = document.createElement('div');
        banner.setAttribute('role', 'alert');
        banner.innerHTML = `<div class="status-msg error" style="margin:14px 0">Studypath isn&rsquo;t connected to its backend in this deployment (CONVEX_URL is missing). Please check that <b>js/convex-config.js</b> was deployed containing your Convex URL.</div>`;
        shell.prepend(banner);
      }
    }
  }
  ({ landing, dashboard, create, quiz, results, review, history, progress, materials, tutor, settings, signin, signup, 'reset-password': resetPasswordPage })[page] &&
    ({ landing, dashboard, create, quiz, results, review, history, progress, materials, tutor, settings, signin, signup, 'reset-password': resetPasswordPage })[page]();
  runIntroThenReveal();
  // Stabilization (M5): retry any quiz syncs that failed earlier (offline,
  // expired session). Runs on every page; no-ops when nothing is pending.
  retryPendingSyncs(typeof syncAttemptToConvex === 'function' ? syncAttemptToConvex : null);
}

// Video intro -> logo loading screen -> the actual page, in that order,
// once per browser session (sessionStorage, not localStorage - a closed
// tab/browser restarting the session shows it again; navigating between
// pages within one visit does not). The inline script next to
// #introOverlay in each HTML file already hides the overlay
// synchronously, before first paint, for a repeat visit this session -
// this function only needs to handle the first-time-this-session case:
// wait for the video, then hand off to the existing pageLoader sequence.
function runIntroThenReveal() {
  const overlay = document.querySelector('#introOverlay');
  const alreadySeen = overlay ? overlay.style.display === 'none' : true;
  if (!overlay || alreadySeen) { hidePageLoader(); return; }

  const video = document.querySelector('#introVideo');
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try { sessionStorage.setItem('studypath:introSeen', '1'); } catch (e) { /* storage unavailable - the video will just replay next load, not a functional break */ }
    overlay.classList.add('hide');
    setTimeout(() => { overlay.remove(); hidePageLoader(); }, 350);
  };
  if (!video) { finish(); return; }
  video.addEventListener('ended', finish, { once: true });
  video.addEventListener('error', finish, { once: true }); // e.g. the file failed to load - never let a broken intro block the app
  // Autoplay-with-sound is commonly blocked, but this is muted, so it
  // should generally play; this timeout is a safety net regardless, in
  // case a browser blocks it anyway or playback stalls.
  setTimeout(finish, 8000);
}

function hidePageLoader() {
  const loader = document.querySelector('#pageLoader');
  if (!loader) return;
  // A brief minimum-visible time keeps the brand moment legible even though
  // rendering itself is near-instant; it also naturally covers the split
  // second it takes external assets (fonts, CDN scripts on Create) to settle.
  setTimeout(() => loader.classList.add('hide'), 450);
}

function theme() { document.documentElement.dataset.theme = store.get('theme', 'light'); }
function applyReducedMotion() { document.documentElement.dataset.reducedMotion = store.get('reducedMotion', false) ? 'true' : 'false'; }

function renderShell() {
  let p = document.body.dataset.page;
  // Phase C: the saved-materials library is a signed-in feature, so the
  // Materials nav entry only renders for accounts. Guests never see it.
  const showMaterials = typeof Auth !== 'undefined' && Auth.isLoggedIn();

  if (p === 'landing') {
    // Public marketing page: brand + a single honest CTA. No app nav (nothing
    // to navigate to yet as a visitor), no fake profile control.
    document.querySelector('#shell').innerHTML = `<header class="topbar public"><a class="brand" href="index.html"><img src="assets/icon-mark.png" alt="" width="22" height="22">study<b>path</b></a><div class="nav-actions"><a class="btn ghost" href="signup.html">Sign up</a><a class="btn" href="create.html">Get started</a></div></header>`;
    return;
  }

  if (p === 'legal') {
    // Static public pages (privacy, terms, delete-account): same public
    // header as landing, reachable without JS-rendered content.
    document.querySelector('#shell').innerHTML = `<header class="topbar public"><a class="brand" href="index.html"><img src="assets/icon-mark.png" alt="" width="22" height="22">study<b>path</b></a><a class="btn ghost" href="index.html">Back to Studypath</a></header>`;
    fillContactEmail();
    return;
  }

  if (p === 'signin' || p === 'signup' || p === 'reset-password') {
    // Auth is an optional side path, not a gated entry point - the whole
    // quiz flow already works for guests. Same minimal public-style
    // header as landing, just swapping the CTA for the other auth page.
    document.querySelector('#shell').innerHTML = `<header class="topbar public"><a class="brand" href="index.html"><img src="assets/icon-mark.png" alt="" width="22" height="22">study<b>path</b></a><a class="btn ghost" href="${p === 'signin' ? 'signup.html' : 'signin.html'}">${p === 'signin' ? 'Create account' : 'Sign in'}</a></header>`;
    return;
  }

  document.querySelector('#shell').innerHTML = `<header class="topbar"><a class="brand" href="index.html"><img src="assets/icon-mark.png" alt="" width="22" height="22">study<b>path</b></a><nav class="nav"><a class="${p === 'dashboard' ? 'active' : ''}" href="dashboard.html">Dashboard</a><a class="${p === 'history' ? 'active' : ''}" href="history.html">History</a><a class="${p === 'progress' ? 'active' : ''}" href="progress.html">Progress</a><a class="${p === 'tutor' ? 'active' : ''}" href="tutor.html">Tutor</a>${showMaterials ? `<a class="${p === 'materials' ? 'active' : ''}" href="materials.html">Materials</a>` : ''}<a class="${p === 'settings' ? 'active' : ''}" href="settings.html">Settings</a></nav><div class="nav-actions"><a class="btn create-cta ${p === 'create' ? 'secondary' : ''}" href="create.html">+ Create quiz</a></div></header>` +
    (p === 'quiz' ? '' : `<nav class="bottom-nav" aria-label="Studypath">
      <a class="${p === 'dashboard' ? 'active' : ''}" href="dashboard.html" aria-current="${p === 'dashboard'}">${NAV_ICONS.dashboard}<span>Home</span></a>
      <a class="${p === 'history' ? 'active' : ''}" href="history.html" aria-current="${p === 'history'}">${NAV_ICONS.history}<span>History</span></a>
      <a class="${p === 'create' ? 'active' : ''}" href="create.html" aria-current="${p === 'create'}">${NAV_ICONS.create}<span>Create</span></a>
      ${showMaterials ? `<a class="${p === 'materials' ? 'active' : ''}" href="materials.html" aria-current="${p === 'materials'}">${NAV_ICONS.materials}<span>Materials</span></a>` : ''}
      <a class="${p === 'progress' ? 'active' : ''}" href="progress.html" aria-current="${p === 'progress'}">${NAV_ICONS.progress}<span>Progress</span></a>
      <a class="${p === 'tutor' ? 'active' : ''}" href="tutor.html" aria-current="${p === 'tutor'}">${NAV_ICONS.tutor}<span>Tutor</span></a>
      <a class="${p === 'settings' ? 'active' : ''}" href="settings.html" aria-current="${p === 'settings'}">${NAV_ICONS.settings}<span>Settings</span></a>
    </nav>`);
}

// Legal pages: fill every [data-contact-email] with the address from
// js/site-config.js (one place to change it for all three pages).
function fillContactEmail() {
  const email = (window.STUDYPATH_SITE && window.STUDYPATH_SITE.contactEmail) || '';
  const isSet = email && email.indexOf('REPLACE-WITH') === -1;
  document.querySelectorAll('[data-contact-email]').forEach(el => {
    if (isSet) { el.textContent = email; el.setAttribute('href', 'mailto:' + email); }
    else { el.textContent = '[contact email not set yet]'; el.removeAttribute('href'); }
  });
}

// Gemini API plan switch (js/site-config.js). Defaults to 'free' — the
// cautious direction: if the config is missing, the disclosures show.
function geminiPlan() {
  const p = window.STUDYPATH_SITE && window.STUDYPATH_SITE.geminiPlan;
  return p === 'paid' ? 'paid' : 'free';
}
function geminiFreePlan() { return geminiPlan() === 'free'; }

// One-line honesty notice for the Create page, shown under the material
// input on tabs whose text is actually sent to Gemini (upload, paste,
// saved library) — never on the Sample topic tab (browser-built) and
// never in Flashcards mode (browser-built). Hidden entirely on the paid
// plan. Plain muted paragraph: wraps, theme-aware, no popup.
function toast(m, duration) {
  let t = document.querySelector('.toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), duration || 2600);
}


/* Phase 2 (2026-10-27): installable app banner. Studypath already has
   a manifest, icons and a service worker; this is the prompt that was
   missing. The banner is dismissible for 30 days, and installing is
   always optional: the website stays full and always available. */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; showInstallBanner(); });
window.addEventListener('appinstalled', () => { const el = document.querySelector('#installBanner'); if (el) el.hidden = true; });
function isStandaloneApp() { try { return window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone; } catch (e) { return false; } }
function isIOSDevice() { return /iphone|ipad|ipod/i.test(navigator.userAgent || ''); }
function installDismissedRecently() { try { const v = localStorage.getItem('studypath:installDismissedAt'); return !!v && Date.now() - Number(v) < 30 * 24 * 3600 * 1000; } catch (e) { return false; } }
function hasCompletedQuiz() { try { return (store.get('sessions', []) || []).length > 0; } catch (e) { return false; } }
function showInstallBanner() {
  const el = document.querySelector('#installBanner'); if (!el || isStandaloneApp() || installDismissedRecently() || !hasCompletedQuiz()) return;
  el.hidden = false;
  const instr = document.querySelector('#installInstructions');
  if (instr) instr.textContent = isIOSDevice() ? 'On iPhone: tap Share, then Add to Home Screen.' : 'Tap Install below. If your browser does not offer it yet, use your browser menu, then Install app or Add to Home Screen.';
}
function wireInstallBanner() {
  const el = document.querySelector('#installBanner'); if (!el) return;
  const btn = document.querySelector('#installBtn'); const dismiss = document.querySelector('#installDismiss');
  if (dismiss) dismiss.onclick = () => { try { localStorage.setItem('studypath:installDismissedAt', String(Date.now())); } catch (e) {} el.hidden = true; };
  if (btn) btn.onclick = async () => {
    if (deferredInstallPrompt) { try { deferredInstallPrompt.prompt(); const choice = await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; if (choice && choice.outcome === 'accepted') el.hidden = true; } catch (e) {} return; }
    const instr = document.querySelector('#installInstructions');
    if (instr) instr.textContent = isIOSDevice() ? 'On iPhone: tap Share, then Add to Home Screen.' : 'In your browser menu, choose Install app or Add to Home Screen. The website works fully either way.';
  };
  showInstallBanner();
}

/* Phase 3 upgrade (2026-10-27): daily study reminder at a chosen time.
   Builds on the existing session reminder toggle. The time is stored
   locally (store key reminderTime, default 19:00). When the time is
   reached and the app is open, it shows a toast and, if the user
   granted notification permission, a browser notification. At most
   once per day, and never if reminders are off. */
function dailyReminderDue() {
  if (!store.get('sessionReminders', true)) return false;
  const time = store.get('reminderTime', '19:00') || '19:00';
  const parts = String(time).split(':'); const h = Number(parts[0]); const m = Number(parts[1] || 0);
  const now = new Date(); const due = new Date(now); due.setHours(h, m, 0, 0);
  if (now < due) return false;
  const today = now.toDateString();
  if (store.get('dailyReminderShownDate', null) === today) return false;
  return true;
}
function fireDailyReminder() {
  if (!dailyReminderDue()) return;
  store.set('dailyReminderShownDate', new Date().toDateString());
  toast('Time for your study session. Ready for a quick quiz?', 8000);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Studypath reminder', { body: 'Time for your study session. Ready for a quick quiz?', icon: 'assets/icon-192.png' });
    }
  } catch (e) {}
}
function startDailyReminderTimer() {
  fireDailyReminder();
  setInterval(fireDailyReminder, 60000);
}

/* ============================================================
   LANDING
   ============================================================ */
function landing() {
  const year = new Date().getFullYear();
  document.querySelector('main').innerHTML = `<section class="hero"><div><div class="eyebrow">Learning, with momentum</div><h1>Your study time deserves a <em>clearer path.</em></h1><p class="lead">Turn your own notes, PDFs, or Word docs into a focused quiz. See what you missed, and watch your progress build one session at a time.</p><div class="hero-cta"><a class="btn" href="create.html">Build a quiz <span>→</span></a><a class="btn ghost" href="signup.html">Sign up</a></div><p class="sub" style="margin-top:14px"><a href="dashboard.html" style="color:var(--muted);text-decoration:underline">Or explore the dashboard as a guest</a></p></div><div class="visual"><div class="visual-head"><b>Today's focus</b><span id="heroSlideLabel">1 / 3</span></div><div class="hero-slide visual-card active" data-slide="0"><div class="mini-label">BIOLOGY · CELLULAR SYSTEMS</div><div class="mini-q">What is the primary function of mitochondria?</div><div class="option">A &nbsp; Store genetic information</div><div class="option good">B &nbsp; Produce cellular energy <b style="float:right">✓</b></div><div class="option">C &nbsp; Break down proteins</div></div><div class="hero-slide" data-slide="1"><img src="assets/hero-slide-1.jpg" alt="Close-up of a person writing focused notes" loading="lazy" decoding="async"><div class="hero-slide-caption">Learn better, not just longer.</div></div><div class="hero-slide" data-slide="2"><img src="assets/hero-slide-2.jpg" alt="A person writing notes in a notebook" loading="lazy" decoding="async"><div class="hero-slide-caption">Turn notes into knowledge.</div></div><div class="hero-dots"><button class="hero-dot active" data-dot="0" aria-label="Show slide 1"></button><button class="hero-dot" data-dot="1" aria-label="Show slide 2"></button><button class="hero-dot" data-dot="2" aria-label="Show slide 3"></button></div></div></section><section class="panel" id="installBanner" hidden style="margin-top:18px"><h2>Get Studypath on your home screen</h2><p class="sub">Install it if you want. The website stays full and always available, nothing is app only.</p><p class="sub" id="installInstructions"></p><div class="inline-actions" style="margin-top:12px"><button id="installBtn" class="btn">Install Studypath</button><button id="installDismiss" class="btn ghost">Not now</button></div></section><section class="logos"><div class="logos-track"><span>PDF</span><span>DOCX</span><span>TXT</span><span>PASTED TEXT</span><span>PDF</span><span>DOCX</span><span>TXT</span><span>PASTED TEXT</span></div></section><section class="photo-band reveal"><img src="assets/photo-band.jpg" alt="A study desk with an open book, laptop, and handwritten notes" loading="lazy" decoding="async" width="1600" height="700"><div class="photo-band-overlay"><p>Real material. Real focus. Real progress.</p></div><span class="photo-credit">Photo: Yen Vu / Unsplash</span></section><section class="how-it-works" id="how-it-works"><div class="section-head"><div class="eyebrow">How it works</div><h2>From your material to real understanding.</h2></div><div class="steps-grid"><article class="step-card reveal" style="transition-delay:0ms"><span class="num">01</span><h3>Add your material</h3><p>Upload a PDF, DOCX, or TXT file, or paste text directly. Studypath reads the actual content.</p></article><article class="step-card reveal" style="transition-delay:80ms"><span class="num">02</span><h3>Get a real quiz</h3><p>Questions are generated from what you gave it, not a generic question bank.</p></article><article class="step-card reveal" style="transition-delay:160ms"><span class="num">03</span><h3>Practice with intent</h3><p>Choose Study mode for instant feedback, or Exam mode for a focused, timed run.</p></article><article class="step-card reveal" style="transition-delay:240ms"><span class="num">04</span><h3>Review, retry, track</h3><p>See exactly what you missed, retry just those questions, and watch progress build over time.</p></article></div></section><section class="final-cta reveal"><h2>Bring your own material. Get a quiz that's actually about it.</h2><p>No account needed to try it. Your first quiz is a click away.</p><a class="btn" href="create.html">Build your first quiz →</a></section><footer class="site-footer"><div class="footer-grid"><div><div class="footer-brand">study<b>path</b></div><p class="footer-desc">Turn your own study material into a focused quiz, understand your mistakes, and track your progress over time.</p></div><div class="footer-col"><h4>Product</h4><a href="create.html">Create Quiz</a><a href="dashboard.html">Dashboard</a><a href="history.html">History</a><a href="progress.html">Progress</a></div><div class="footer-col"><h4>Learn more</h4><a href="#how-it-works">How it works</a></div><div class="footer-col"><h4>Legal</h4><a href="privacy.html">Privacy Policy</a><a href="terms.html">Terms of Use</a><a href="delete-account.html">Delete account</a></div></div><div class="footer-bottom">© ${year} Studypath by Vortex. Built for focused learning.</div></footer>`;

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); } });
    }, { threshold: 0.15 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  } else {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
  }

  startHeroCarousel();
  wireInstallBanner();

  // Anyone clicking a "start as a guest" link from the landing page gets
  // a one-time heads-up on the next page (create.html) about what being
  // a guest means - see create()'s init for where this actually renders,
  // since a toast can't survive the page navigation that's about to
  // happen. Only from these specific landing links, not every future
  // visit to create.html, so it doesn't repeat itself for someone
  // already using the app.
  document.querySelectorAll('a[href="create.html"]').forEach(a => {
    a.addEventListener('click', () => {
      try { sessionStorage.setItem('studypath:showGuestNotice', '1'); } catch (e) {}
    });
  });
}

function startHeroCarousel() {
  const slides = document.querySelectorAll('.hero-slide');
  const dots = document.querySelectorAll('.hero-dot');
  const label = document.querySelector('#heroSlideLabel');
  if (!slides.length) return;
  const total = slides.length;
  let i = 0;
  let handle;

  function show(n) {
    i = n;
    slides.forEach((s, idx) => s.classList.toggle('active', idx === n));
    dots.forEach((d, idx) => d.classList.toggle('active', idx === n));
    if (label) label.textContent = (n + 1) + ' / ' + total;
  }
  function restart() {
    clearInterval(handle);
    handle = setInterval(() => show((i + 1) % total), 4000);
  }
  dots.forEach((d, idx) => d.onclick = () => { show(idx); restart(); });
  restart();
}

/* ============================================================
   AUTH (M11G) - reuses existing .panel/.field/.btn/.status-msg/
   .modal-overlay primitives only; no new CSS needed.
   ============================================================ */
function authFormMarkup(kind) {
  const isSignup = kind === 'signup';
  const nameField = isSignup ? `<label class="field">Your name<input type="text" id="authName" autocomplete="name" placeholder="e.g. Mike Johnson" maxlength="60"></label>` : '';
  const avatarField = isSignup ? `<div class="field" style="margin-top:14px"><span>Profile photo <span class="hint">(optional)</span></span><div style="display:flex;align-items:center;gap:14px;margin-top:6px"><div class="avatar-picker" id="authAvatarPreview">+</div><button type="button" id="authAvatarBtn" class="btn ghost">Choose photo</button><input type="file" id="authAvatarInput" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none"></div></div>` : '';
  const ageField = isSignup ? `<label class="check" style="margin-top:14px;display:flex;gap:10px;align-items:flex-start;font-size:14px"><input type="checkbox" id="authAgeConfirm" style="margin-top:3px">I confirm I am 18 or older. Required for AI features.</label>` : '';
  const forgotLink = !isSignup ? `<p class="sub" style="margin-top:10px;text-align:center"><a href="reset-password.html" style="color:var(--teal);font-weight:700">Forgot password?</a></p>` : '';
  return `<section class="page-title" style="justify-content:center;text-align:center"><div><div class="eyebrow">${isSignup ? 'Keep your progress' : 'Welcome back'}</div><h1>${isSignup ? 'Create your account' : 'Sign in'}</h1><p>${isSignup ? 'Optional. Studypath already works as a guest.' : 'Pick up your synced history where you left off.'}</p></div></section><article class="panel" style="max-width:420px;margin:0 auto">${nameField}<label class="field" style="margin-top:14px">Email<input type="email" id="authEmail" autocomplete="email" placeholder="you@example.com"></label><label class="field" style="margin-top:14px">Password<input type="password" id="authPassword" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="${isSignup ? 'At least 12 characters' : 'Your password'}">${isSignup ? '<p class="sub" id="authPasswordHint" style="margin-top:6px">Use at least 12 characters, with a capital letter, a lowercase letter, a number, and a special character.</p>' : ''}</label>${avatarField}${ageField}<div id="authStatus"></div>${isSignup || true ? '<div id="googleBtnWrap" style="margin-top:14px"></div>' : ''}<button id="authSubmit" class="btn" style="margin-top:16px;width:100%">${isSignup ? 'Create account' : 'Sign in'}</button>${forgotLink}${isSignup ? '<p class="sub" style="margin-top:12px;text-align:center;font-size:13px">By creating an account you agree to the <a href="terms.html" style="color:var(--teal);font-weight:700">Terms</a> and <a href="privacy.html" style="color:var(--teal);font-weight:700">Privacy Policy</a>.</p>' : ''}<p class="sub" style="margin-top:16px;text-align:center">${isSignup ? 'Already have an account? <a href="signin.html" style="color:var(--teal);font-weight:700">Sign in</a>' : 'New here? <a href="signup.html" style="color:var(--teal);font-weight:700">Create an account</a>'}</p></article>`;
}


/* Phase 1: email verification form. Shown after email signup, after a
   sign in with an unverified account, and from Settings. The code step
   is a full page render so it works from any of those entry points. */
function verifyFormMarkup(email) {
  return `<section class="page-title" style="justify-content:center;text-align:center"><div><div class="eyebrow">Verify your email</div><h1>Check your inbox</h1><p>We sent a 6 digit code to ${esc(email)}. Enter it below to unlock AI quizzes, Tutor and saved materials.</p></div></section><article class="panel" style="max-width:420px;margin:0 auto"><label class="field">Verification code<input type="text" id="verifyCodeInput" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="6"></label><div id="verifyStatus"></div><button id="verifySubmit" class="btn" style="margin-top:16px;width:100%">Verify email</button><button id="verifyResend" class="btn ghost" style="margin-top:10px;width:100%">Resend code</button><p class="sub" style="margin-top:12px;text-align:center">The code expires in 15 minutes.</p></article>`;
}
function showVerificationForm(email) {
  document.querySelector('main').innerHTML = verifyFormMarkup(email);
  const codeEl = document.querySelector('#verifyCodeInput');
  const statusEl = document.querySelector('#verifyStatus');
  const submitBtn = document.querySelector('#verifySubmit');
  const resendBtn = document.querySelector('#verifyResend');
  function setStatus(cls, text) { statusEl.innerHTML = text ? `<div class="status-msg ${cls}" style="margin-top:14px">${esc(text)}</div>` : ''; }
  let cooldown = 0; let timer = null;
  function startCooldown() {
    cooldown = 60; resendBtn.disabled = true; resendBtn.textContent = 'Resend code (60s)';
    timer = setInterval(() => { cooldown -= 1; if (cooldown <= 0) { clearInterval(timer); resendBtn.disabled = false; resendBtn.textContent = 'Resend code'; } else { resendBtn.textContent = 'Resend code (' + cooldown + 's)'; } }, 1000);
  }
  Auth.requestVerificationCode().then(res => { if (!res.ok && res.data && res.data.error) setStatus('error', res.data.error.message); else if (res.ok) startCooldown(); });
  submitBtn.onclick = () => {
    const code = codeEl.value.trim();
    if (!/^\d{6}$/.test(code)) { setStatus('error', 'Enter the 6 digit code from your email.'); return; }
    submitBtn.disabled = true; setStatus('info', 'Verifying\u2026');
    Auth.verifyCode(code).then(res => {
      submitBtn.disabled = false;
      if (res.ok) { toast('Email verified'); goToDashboardWithPrompt(); }
      else setStatus('error', (res.data && res.data.error && res.data.error.message) || (res.error && res.error.message) || 'Verification failed.');
    });
  };
  resendBtn.onclick = () => { setStatus('info', 'Sending a new code\u2026'); Auth.requestVerificationCode().then(res => { if (res.ok) { setStatus('info', 'A new code was sent.'); startCooldown(); } else setStatus('error', 'Could not send a new code. Please try again.'); }); };
  codeEl.focus();
}
// Phase 1: Have I Been Pwned breach check, hash prefix only. Network
// failure is not a block: the server common-password list still applies.
async function passwordBreached(password) {
  try {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const resp = await fetch('https://api.pwnedpasswords.com/range/' + hex.slice(0, 5));
    if (!resp.ok) return false;
    const text = await resp.text();
    const suffix = hex.slice(5);
    return text.split('\n').some(line => line.split(':')[0].trim() === suffix);
  } catch (e) { return false; }
}
function initGoogleButton(statusFn) {
  const wrap = document.querySelector('#googleBtnWrap');
  const clientId = (window.STUDYPATH_SITE && window.STUDYPATH_SITE.googleClientId) || '198628027586-9cuejugh27vgf67p6ng0d2dd41e6m0kn.apps.googleusercontent.com';
  if (!wrap || !clientId) return;
  wrap.innerHTML = '<div id="googleSignInBtn" style="display:flex;justify-content:center"></div><p class="sub" style="text-align:center;margin-top:8px">or continue with Google</p>';
  function loadGsi() {
    if (window.google && window.google.accounts) {
      window.google.accounts.id.initialize({ client_id: clientId, callback: (resp) => {
        Auth.signInWithGoogle(resp.credential, '').then(res => {
          if (res.ok) { toast('Signed in with Google'); goToDashboardWithPrompt(); }
          else statusFn('error', (res.error && res.error.message) || 'Google sign in failed.');
        });
      }});
      window.google.accounts.id.renderButton(document.querySelector('#googleSignInBtn'), { theme: 'outline', size: 'large', width: 320 });
    } else {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
      s.onload = loadGsi; document.head.appendChild(s);
    }
  }
  loadGsi();
}

function wireAuthSubmit(kind) {
  const nameEl = document.querySelector('#authName');
  const emailEl = document.querySelector('#authEmail');
  const passwordEl = document.querySelector('#authPassword');
  const statusEl = document.querySelector('#authStatus');
  const submitBtn = document.querySelector('#authSubmit');
  const avatarInput = document.querySelector('#authAvatarInput');
  const avatarBtn = document.querySelector('#authAvatarBtn');
  const avatarPreview = document.querySelector('#authAvatarPreview');
  let selectedAvatarFile = null;

  if (avatarBtn) {
    avatarBtn.onclick = () => avatarInput.click();
    avatarInput.onchange = () => {
      const file = avatarInput.files[0];
      if (!file) return;
      selectedAvatarFile = file;
      const reader = new FileReader();
      reader.onload = () => { avatarPreview.innerHTML = `<img src="${reader.result}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`; };
      reader.readAsDataURL(file);
    };
  }

  function setStatus(cls, text) {
    statusEl.innerHTML = text ? `<div class="status-msg ${cls}" style="margin-top:14px">${esc(text)}</div>` : '';
  }

  if (passwordEl) { passwordEl.addEventListener('input', () => { const hint = document.querySelector('#authPasswordHint'); if (!hint) return; const v = passwordEl.value; const missing = []; if (v.length < 12) missing.push('12+ characters'); if (!/[A-Z]/.test(v)) missing.push('a capital letter'); if (!/[a-z]/.test(v)) missing.push('a lowercase letter'); if (!/[0-9]/.test(v)) missing.push('a number'); if (!/[^A-Za-z0-9]/.test(v)) missing.push('a special character'); hint.textContent = v.length === 0 ? 'Use at least 12 characters, with a capital letter, a lowercase letter, a number, and a special character.' : missing.length ? 'Still needed: ' + missing.join(', ') + '.' : 'Strong password.'; }); }
  initGoogleButton(setStatus);

  function doSignIn() {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!email || !password) { setStatus('error', 'Enter your email and password.'); return; }
    submitBtn.disabled = true;
    setStatus('info', 'Signing in\u2026');
    Auth.signIn(email, password).then(res => {
      submitBtn.disabled = false;
      if (res.ok) { if (res.data && res.data.emailVerified === false) { showVerificationForm(email); return; } toast('Welcome back'); goToDashboardWithPrompt(); }
      else setStatus('error', res.error.message);
    });
  }

  function finishSignUp(claimAnonymous) {
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    const name = nameEl.value.trim();
    const ageConfirmed = !document.querySelector('#authAgeConfirm') || document.querySelector('#authAgeConfirm').checked;
    submitBtn.disabled = true;
    setStatus('info', 'Creating your account\u2026');
    Auth.signUp(email, password, claimAnonymous, name, ageConfirmed).then(res => {
      if (!res.ok) { submitBtn.disabled = false; setStatus('error', res.error.message); return; }
      const goNext = () => { if (res.needsVerification) { showVerificationForm(email); } else { toast('Account created'); goToDashboardWithPrompt(); } };
      if (!selectedAvatarFile) { goNext(); return; }
      setStatus('info', 'Uploading your photo\u2026');
      Auth.uploadAvatar(selectedAvatarFile).then(avatarRes => {
        // A failed photo upload shouldn't block getting into the app -
        // the account already exists; they can just add a photo later
        // from Settings.
        if (!avatarRes.ok) toast('Account created, but the photo upload failed. Add one later in Settings.');
        if (res.needsVerification) { showVerificationForm(email); } else { toast('Account created'); goToDashboardWithPrompt(); }
      });
    });
  }

  function claimModalMarkup(count) {
    return `<div class="modal-overlay" id="claimOverlay"><article class="panel modal-card"><h2>Keep your existing history?</h2><p class="sub">This device has ${count} quiz attempt${count === 1 ? '' : 's'} saved as a guest. Add ${count === 1 ? 'it' : 'them'} to your new account?</p><div class="inline-actions"><button class="btn" id="claimYes">Yes, add ${count === 1 ? 'it' : 'them'}</button><button class="btn ghost" id="claimNo">No, start fresh</button></div></article></div>`;
  }

  function doSignUp() {
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passwordEl.value;
    if (!name) { setStatus('error', 'Enter your name.'); return; }
    if (!email || !password) { setStatus('error', 'Enter an email and password.'); return; }
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) { const m = []; if (password.length < 12) m.push('at least 12 characters'); if (!/[A-Z]/.test(password)) m.push('a capital letter'); if (!/[a-z]/.test(password)) m.push('a lowercase letter'); if (!/[0-9]/.test(password)) m.push('a number'); if (!/[^A-Za-z0-9]/.test(password)) m.push('a special character'); setStatus('error', 'Password must contain ' + m.join(', ') + '.'); return; }
    const ageBox = document.querySelector('#authAgeConfirm');
    if (ageBox && !ageBox.checked) { setStatus('error', 'Please confirm you are 18 or older to create an account.'); return; }
    submitBtn.disabled = true;
    setStatus('info', 'Checking password safety\u2026');
    passwordBreached(password).then(breached => { if (breached) { submitBtn.disabled = false; setStatus('error', 'That password has appeared in known data breaches. Please choose a different one.'); return; } setStatus('info', 'Checking this device\u2026'); Auth.checkAnonymousHistory().then(res => {
      submitBtn.disabled = false;
      const count = (res.ok && res.data && res.data.count) || 0;
      if (count > 0) {
        setStatus('', '');
        document.body.insertAdjacentHTML('beforeend', claimModalMarkup(count));
        document.querySelector('#claimYes').onclick = () => { document.querySelector('#claimOverlay').remove(); finishSignUp(true); };
        document.querySelector('#claimNo').onclick = () => { document.querySelector('#claimOverlay').remove(); finishSignUp(false); };
      } else {
        finishSignUp(false);
      }
    }); });
  }

  submitBtn.onclick = kind === 'signup' ? doSignUp : doSignIn;
  passwordEl.onkeydown = (e) => { if (e.key === 'Enter') submitBtn.click(); };
}

function signin() {
  document.querySelector('main').innerHTML = authFormMarkup('signin');
  wireAuthSubmit('signin');
}

function signup() {
  document.querySelector('main').innerHTML = authFormMarkup('signup');
  wireAuthSubmit('signup');
}

/* ============================================================
   PASSWORD RECOVERY (2026-10-06) - reset-password.html hosts two
   states: the email request form, and the new-password form when
   ?token= is present. Reuses .panel/.field/.btn/.status-msg only.
   ============================================================ */
function resetPasswordPage() {
  const params = new URLSearchParams(location.search);
  const token = (params.get('token') || '').trim();
  const main = document.querySelector('main');

  function statusHtml(cls, text) {
    return text ? `<div class="status-msg ${cls}" style="margin-top:14px" role="status">${esc(text)}</div>` : '';
  }

  if (!token) {
    main.innerHTML = `<section class="page-title" style="justify-content:center;text-align:center"><div><div class="eyebrow">Account recovery</div><h1>Reset your password</h1><p>Enter the email you signed up with. If an account exists for it, we will send you a reset link.</p></div></section><article class="panel" style="max-width:420px;margin:0 auto"><label class="field">Email<input type="email" id="resetEmail" autocomplete="email" placeholder="you@example.com"></label><div id="resetStatus"></div><button id="resetRequest" class="btn" style="margin-top:16px;width:100%">Send reset link</button><p class="sub" style="margin-top:16px;text-align:center"><a href="signin.html" style="color:var(--teal);font-weight:700">Back to sign in</a></p></article>`;
    const emailEl = document.querySelector('#resetEmail');
    const statusEl = document.querySelector('#resetStatus');
    const btn = document.querySelector('#resetRequest');
    btn.onclick = () => {
      const email = emailEl.value.trim();
      if (!email) { statusEl.innerHTML = statusHtml('error', 'Enter your email address.'); return; }
      btn.disabled = true;
      statusEl.innerHTML = statusHtml('info', 'Sending\u2026');
      Auth.requestPasswordReset(email).then(res => {
        btn.disabled = false;
        const msg = (res.ok && res.data && res.data.message) || 'If an account exists for that email, we will send you a password reset link.';
        statusEl.innerHTML = statusHtml('info', msg);
      }).catch(() => {
        btn.disabled = false;
        statusEl.innerHTML = statusHtml('info', 'If an account exists for that email, we will send you a password reset link.');
      });
    };
    emailEl.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
    return;
  }

  main.innerHTML = `<section class="page-title" style="justify-content:center;text-align:center"><div><div class="eyebrow">Account recovery</div><h1>Choose a new password</h1><p>This link expires in 1 hour and can only be used once.</p></div></section><article class="panel" style="max-width:420px;margin:0 auto"><label class="field">New password<input type="password" id="resetPw1" autocomplete="new-password" placeholder="At least 8 characters"></label><label class="field" style="margin-top:14px">Confirm new password<input type="password" id="resetPw2" autocomplete="new-password" placeholder="Repeat the new password"></label><div id="resetStatus"></div><button id="resetConfirm" class="btn" style="margin-top:16px;width:100%">Set new password</button><p class="sub" style="margin-top:16px;text-align:center"><a href="signin.html" style="color:var(--teal);font-weight:700">Back to sign in</a></p></article>`;
  const pw1 = document.querySelector('#resetPw1');
  const pw2 = document.querySelector('#resetPw2');
  const statusEl = document.querySelector('#resetStatus');
  const btn = document.querySelector('#resetConfirm');
  btn.onclick = () => {
    const a = pw1.value, b = pw2.value;
    if (a.length < 8) { statusEl.innerHTML = statusHtml('error', 'Password must be at least 8 characters.'); return; }
    if (a !== b) { statusEl.innerHTML = statusHtml('error', "The two passwords don't match."); return; }
    btn.disabled = true;
    statusEl.innerHTML = statusHtml('info', 'Setting your new password\u2026');
    Auth.resetPassword(token, a, b).then(res => {
      if (res.ok && res.data && res.data.ok) {
        main.querySelector('article').innerHTML = `<h2>Password updated</h2><p class="sub">Your password has been changed. Sign in with your new password to continue.</p><div style="margin-top:16px"><a class="btn" href="signin.html" style="width:100%">Sign in</a></div>`;
        return;
      }
      btn.disabled = false;
      const msg = (res.ok && res.data && res.data.code === 'weak_password') ? 'Password must be at least 8 characters.'
        : (res.ok && res.data && res.data.code === 'mismatch') ? "The two passwords don't match."
        : 'This reset link is invalid or has expired. Request a new one and try again.';
      statusEl.innerHTML = statusHtml('error', msg);
    }).catch(() => {
      btn.disabled = false;
      statusEl.innerHTML = statusHtml('error', 'This reset link is invalid or has expired. Request a new one and try again.');
    });
  };
  pw2.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
}

/* ============================================================
   AGE ELIGIBILITY (2026-10-06) - one-time prompt for accounts
   created before the 18+ requirement. The server is the authority;
   this modal is UX only. Shown when a Gemini call fails with
   age_not_eligible, or proactively before AI features.
   ============================================================ */
function showAgeEligibilityModal(onDone) {
  if (document.querySelector('#ageOverlay')) { if (onDone) onDone(false); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'ageOverlay';
  overlay.innerHTML = `<article class="panel modal-card" role="dialog" aria-modal="true" aria-labelledby="ageTitle"><h2 id="ageTitle">One quick check</h2><p class="sub">Studypath's AI features (quiz generation and the Tutor) use Google's Gemini API, whose terms require users to be 18 or older. Please confirm to continue using AI features. You will only see this once.</p><div id="ageStatus"></div><div class="inline-actions"><button class="btn" id="ageYes">I am 18 or older</button><button class="btn ghost" id="ageNo">I am under 18</button></div></article>`;
  document.body.appendChild(overlay);
  const close = (result) => { overlay.remove(); if (onDone) onDone(result); };
  document.querySelector('#ageYes').onclick = () => {
    document.querySelector('#ageStatus').innerHTML = `<div class="status-msg info" style="margin-top:12px" role="status">Saving\u2026</div>`;
    Auth.setAgeEligibility(true).then(res => {
      if (res.ok && res.data && res.data.ok) { toast('Confirmed'); close(true); }
      else { document.querySelector('#ageStatus').innerHTML = `<div class="status-msg error" style="margin-top:12px" role="status">${esc((res.error && res.error.message) || 'Could not save. Try again.')}</div>`; }
    }).catch(() => {
      document.querySelector('#ageStatus').innerHTML = `<div class="status-msg error" style="margin-top:12px" role="status">Could not save. Try again.</div>`;
    });
  };
  document.querySelector('#ageNo').onclick = () => {
    Auth.setAgeEligibility(false).then(() => close(false)).catch(() => close(false));
  };
}

// Wraps a Gemini-backed promise: on age_not_eligible, shows the one-time
// prompt and retries once after confirmation. Handles both rejection
// style (err.code) and Convex.action resolution style ({ok:false}).
function withAgeEligibility(fn) {
  function isAgeBlocked(outcome, err) {
    if (outcome && outcome.ok === false && outcome.error && outcome.error.code === 'age_not_eligible') return true;
    const code = err && (err.code || (err.error && err.error.code));
    return code === 'age_not_eligible';
  }
  return fn().then(
    (outcome) => {
      if (!isAgeBlocked(outcome, null)) return outcome;
      return new Promise((resolve, reject) => {
        showAgeEligibilityModal((confirmed) => {
          if (!confirmed) { reject(new Error('AI features need 18+ confirmation. Your non-AI features keep working.')); return; }
          fn().then(resolve, reject);
        });
      });
    },
    (err) => {
      if (!isAgeBlocked(null, err)) throw err;
      return new Promise((resolve, reject) => {
        showAgeEligibilityModal((confirmed) => {
          if (!confirmed) { reject(new Error('AI features need 18+ confirmation. Your non-AI features keep working.')); return; }
          fn().then(resolve, reject);
        });
      });
    }
  );
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function dashboard() {
  if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
    // New-account handling for returning sessions too: silent subscribe
    // if the browser already allowed notifications, prompt once per
    // account if undecided. Runs after render so it never blocks the page.
    setTimeout(() => { ensureAccountNotifications(null); }, 800);
  }
  const sessions = store.get('sessions', []).filter(isValidRecord);
  const recent = sessions.slice(-4).reverse();
  const activeRaw = activeSession.get();
  const activeHasContent = activeRaw && ((Array.isArray(activeRaw.questions) && activeRaw.questions.length) || (Array.isArray(activeRaw.cards) && activeRaw.cards.length));
  const active = activeHasContent ? activeRaw : null;

  let continuePanel;
  if (active && active.status === 'in_progress') {
    const isFlashcards = active.mode === 'flashcards';
    const total = isFlashcards ? active.cards.length : active.questions.length;
    const answered = isFlashcards ? (active.index || 0) : Object.keys(active.answers || {}).length;
    const ringPct = total ? Math.round((answered / total) * 100) : 0;
    const progressText = isFlashcards ? `${total} cards \u00b7 card ${(active.index || 0) + 1} of ${total}` : `${total} questions \u00b7 ${Object.keys(active.answers || {}).length}/${total} answered`;
    continuePanel = `<article class="panel continue"><div class="ring" data-pct="${ringPct}" style="background:conic-gradient(var(--lime) 0 ${ringPct}%,#ffffff35 ${ringPct}%)" title="Progress through this quiz"></div><div class="eyebrow" style="color:var(--lime)">Continue learning</div><h2>${esc(active.title)}</h2><p class="sub">${progressText}</p><a href="quiz.html" class="btn">Resume session →</a></article>`;
  } else {
    // No quiz in progress - the ring instead reflects the user's own
    // overall average score (0 if they have no completed sessions yet),
    // not a fixed number that was previously the same for every user.
    const overallAvg = sessions.length ? Math.round(sessions.reduce((sum, s) => sum + s.score, 0) / sessions.length) : 0;
    continuePanel = `<article class="panel continue"><div class="ring" data-pct="${overallAvg}" style="background:conic-gradient(var(--lime) 0 ${overallAvg}%,#ffffff35 ${overallAvg}%)" title="Your average score"></div><div class="eyebrow" style="color:var(--lime)">Ready when you are</div><h2>No quiz in progress</h2><p class="sub">Add your study material and Studypath will build one.</p><a href="create.html" class="btn">Start a quiz →</a></article>`;
  }

  const weekScores = lastNDaysAverageScore(sessions, 7);

  document.querySelector('main').innerHTML = `<section class="page-title"><div style="display:flex;align-items:center;gap:14px"><div id="dashAvatarSlot"></div><div><div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1 id="dashGreeting">${sessions.length ? 'Good to see you.' : 'Welcome to Studypath.'}</h1><p id="dashSub">${sessions.length ? 'Small steps, strong recall. You\u2019re building a habit.' : 'Turn your own material into a quiz to get started.'}</p></div></div><a class="btn" href="create.html">+ New quiz</a></section><section class="grid dashboard"><div class="grid">${continuePanel}<article class="panel"><div class="row"><div><h2>Recent activity</h2><p class="sub">Your latest completed sessions</p></div><a class="muted" href="history.html">View all →</a></div><div class="list">${recent.length ? recent.map(s => `<div class="list-item"><i class="dot ${s.score >= 70 ? 'teal' : ''}"></i><div class="subject">${esc(s.title)}<div class="muted">${esc(s.dateLabel)} · ${esc(s.mode)}</div></div><b class="score">${s.score}%</b></div>`).join('') : `<div class="list-item"><span class="muted">No sessions yet. Try a sample topic, no upload needed.</span><a href="create.html" class="muted" style="margin-left:auto;color:var(--teal);font-weight:700">Create your first →</a></div>`}</div></article></div><div class="grid"><article class="panel"><p class="sub">CURRENT STREAK</p><div class="streak">${computeStreak(sessions)} days <span style="color:var(--coral)">✦</span></div><p class="muted">${sessions.length ? 'Keep a session going to extend it.' : 'Complete a quiz to start your streak.'}</p></article><article class="panel"><h2>This week</h2><p class="sub">Your study rhythm</p><div class="chart">${weekScores.map(d => `<div class="bar" style="height:${d.score}%"><span>${d.label}</span></div>`).join('')}</div></article><article class="panel"><h2>Quick start</h2><p class="sub">Pick up where curiosity leads.</p><div class="list"><a class="list-item" href="create.html"><i class="dot lime"></i><span class="subject">Make a quiz from your notes</span>→</a><a class="list-item" href="progress.html"><i class="dot teal"></i><span class="subject">See your progress</span>→</a><a class="list-item" href="tutor.html"><i class="dot lime"></i><span class="subject">Ask the AI Tutor</span>→</a></div></article></div></section>`;

  hydrateDashboardIdentity(sessions);
  syncRemoteSessions(dashboard);
  checkSessionReminder(sessions);
}

// Personalizes the greeting once we know whether this is a signed-in
// account - deliberately async and separate from the synchronous render
// above, so a guest (or a slow network) never blocks the dashboard on an
// identity check. Guests keep the exact default copy that was always
// there; nothing about their experience changes.
function hydrateDashboardIdentity(sessions) {
  Auth.getCurrentUser().then(res => {
    if (!(res.ok && res.data)) return;
    const user = res.data;
    const firstName = (user.name || '').trim().split(/\s+/)[0];
    const greetingEl = document.querySelector('#dashGreeting');
    const subEl = document.querySelector('#dashSub');
    if (greetingEl && firstName) greetingEl.innerHTML = `Hello, <span style="text-transform:uppercase">${esc(firstName)}</span>`;
    if (subEl) subEl.textContent = performanceEncouragement(sessions);
    const avatarSlot = document.querySelector('#dashAvatarSlot');
    if (avatarSlot) {
      avatarSlot.innerHTML = user.avatarUrl
        ? `<img src="${esc(user.avatarUrl)}" alt="" class="dash-avatar">`
        : `<div class="avatar-picker" style="border-style:solid">${esc((firstName || user.email || '?')[0].toUpperCase())}</div>`;
    }
  });
}

// Encouragement is keyed off the most recent completed score, not an
// average - "how did I just do" is what a returning user actually wants
// reflected back, not a running statistic.
function performanceEncouragement(sessions) {
  if (!sessions.length) return "Let's get your first quiz done.";
  const last = sessions[sessions.length - 1].score;
  if (last >= 90) return 'Outstanding work! Keep that momentum going!';
  if (last >= 70) return "Solid progress, you're building real recall.";
  if (last >= 50) return 'Good effort. A bit more practice and this will click.';
  return "Tough one. Let's revisit that material together.";
}

function lastNDaysAverageScore(sessions, n) {
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Date.getDay(): 0=Sun..6=Sat
  const days = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const dayScores = sessions.filter(s => s.completedAt && new Date(s.completedAt).toDateString() === key).map(s => s.score);
    days.push({
      score: dayScores.length ? Math.round(dayScores.reduce((a, b) => a + b, 0) / dayScores.length) : 0,
      label: dayLabels[d.getDay()]
    });
  }
  return days;
}

// Settings > Session reminders (real toggle, default on) - a gentle
// nudge shown at most once per calendar day, only when it's been a
// while since the last completed session. No-op if the user turned it
// off, or if there's nothing to remind them about yet.
function checkSessionReminder(sessions) {
  if (!store.get('sessionReminders', true)) return;
  if (!sessions.length) return;
  const lastCompleted = new Date(sessions[sessions.length - 1].completedAt);
  const daysSince = Math.floor((Date.now() - lastCompleted.getTime()) / 86400000);
  if (daysSince < 2) return;
  const today = new Date().toDateString();
  if (store.get('reminderShownDate', null) === today) return;
  store.set('reminderShownDate', today);
  setTimeout(() => toast(`It's been ${daysSince} days since your last session. Ready to pick it back up?`), 900);
}

function computeStreak(sessions) {
  if (!sessions.length) return 0;
  const dateSet = new Set(sessions.filter(s => s.completedAt).map(s => new Date(s.completedAt).toDateString()));
  let streak = 0;
  let cursor = new Date();
  while (dateSet.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/* ============================================================
   CREATE QUIZ
   ============================================================ */
function defaultDraft() {
  return {
    tab: 'file', // file | paste | sample | library
    // Phase C: saved-material selection. libraryText is the row's extracted
    // text fetched client-side (local checks and display); the AI provider
    // instead receives libraryMaterialId and the server resolves the text
    // itself (convex/quiz.ts).
    libraryMaterialId: null,
    libraryLabel: '',
    libraryText: '',
    sampleSubject: 'biology',
    customTitle: '',
    subject: '', // application-owned quiz context (subject/topic contamination fix)
    difficulty: 'medium',
    questionCount: 10,
    typeChoice: 'mixed', // mcq | short_answer | true_false | mixed
    timeChoice: 'none', // none | 5 | 10 | 15 | 20 | 30 | 45 | 60 | custom
    customMinutes: 20,
    mode: 'study',
    topics: '',
    instructions: '',
    moreOptionsOpen: false,
    generatedQuiz: null,
    generateError: ''
  };
}

let draft = null;

function create() {
  if (!draft) draft = defaultDraft();
  // Phase C: "Use for quiz" from the materials library hands off a
  // material id through sessionStorage; the create page then loads that
  // row (ownership-checked server-side) and preselects the library tab.
  const libraryPick = sessionStorage.getItem('studypath:library-pick');
  if (libraryPick) {
    sessionStorage.removeItem('studypath:library-pick');
    if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
      draft.tab = 'library';
      draft.libraryMaterialId = libraryPick;
      fetchLibraryMaterialForCreate(libraryPick);
    }
  }
  const pendingError = sessionStorage.getItem('studypath:create-error');
  if (pendingError) {
    sessionStorage.removeItem('studypath:create-error');
    setTimeout(() => toast(pendingError), 50);
  }
  const showGuestNotice = sessionStorage.getItem('studypath:showGuestNotice');
  if (showGuestNotice) {
    sessionStorage.removeItem('studypath:showGuestNotice');
    if (!(typeof Auth !== 'undefined' && Auth.isLoggedIn())) {
      setTimeout(() => toast(
        "You're browsing as a guest. Your progress stays on this device only. You can back it up anytime from Settings \u2192 Download my data, but signing up is the safest way to keep it.",
        16000
      ), 500);
    }
  }
  renderCreate();
}

function renderCreate() {
  const mat = Material.get();
  // Phase C: the library tab is a signed-in feature - guests stay on the
  // upload/paste/sample flow exactly as today.
  const signedIn = typeof Auth !== 'undefined' && Auth.isLoggedIn();

  const tabsHtml = `<div class="tabs" role="tablist" aria-label="Study material source">
    <button class="tab-btn ${draft.tab === 'file' ? 'selected' : ''}" data-tab="file" role="tab" aria-selected="${draft.tab === 'file'}">Upload file</button>
    <button class="tab-btn ${draft.tab === 'paste' ? 'selected' : ''}" data-tab="paste" role="tab" aria-selected="${draft.tab === 'paste'}">Paste text</button>
    <button class="tab-btn ${draft.tab === 'sample' ? 'selected' : ''}" data-tab="sample" role="tab" aria-selected="${draft.tab === 'sample'}">Sample topic</button>
    ${signedIn ? `<button class="tab-btn ${draft.tab === 'library' ? 'selected' : ''}" data-tab="library" role="tab" aria-selected="${draft.tab === 'library'}">My library</button>` : ''}
  </div>`;

  let materialBody = '';
  if (draft.tab === 'file') {
    materialBody = `<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Upload a PDF, DOCX, or TXT file"><div class="dropzone-icons"><i class="fa-regular fa-file-pdf" aria-hidden="true"></i><i class="fa-regular fa-file-word" aria-hidden="true"></i><i class="fa-regular fa-file-lines" aria-hidden="true"></i></div><b>Drop a file here, or click to browse</b><span class="hint">PDF, DOCX, or TXT · up to 15MB</span><input type="file" id="fileInput" accept=".pdf,.docx,.txt" style="display:none"></div>` + materialStatusMarkup(mat);
  } else if (draft.tab === 'paste') {
    materialBody = `<label class="field">Paste your study material<textarea id="pasteArea" placeholder="Paste notes, an article, a chapter: at least a few sentences.">${esc(mat.sourceType === 'paste' ? mat.extractedText : '')}</textarea><span class="char-count" id="pasteCount">${(mat.sourceType === 'paste' ? mat.characterCount : 0)} characters</span></label><div class="inline-actions"><button class="btn secondary" id="usePaste">Use this text</button></div>` + (mat.sourceType === 'paste' ? materialStatusMarkup(mat) : '');
  } else if (draft.tab === 'library') {
    materialBody = libraryTabMarkup();
  } else {
    materialBody = `<label class="field">Topic<select id="sampleSubject"><option value="biology" ${draft.sampleSubject === 'biology' ? 'selected' : ''}>Biology: Cellular systems</option><option value="history" ${draft.sampleSubject === 'history' ? 'selected' : ''}>History: World civilizations</option><option value="math" ${draft.sampleSubject === 'math' ? 'selected' : ''}>Math: Core skills</option></select></label><p class="sub">A small built-in sample bank, handy for trying Studypath without a document.</p>`;
  }

  // Short visible notice at the point of upload (2026-10-29 launch review):
  // full details stay in the Privacy Policy, this is just what happens here.
  const materialNotice = draft.tab === 'sample'
    ? `<p class="sub" style="margin-top:12px">Sample quizzes are made in your browser and are not sent to an AI service.</p>`
    : `<p class="sub" style="margin-top:12px"><b>What happens to my material?</b> Your file text is read in your browser. Only text you use for an AI quiz is sent to Google Gemini, and it is not saved unless you choose Save to library. See <a href="privacy.html" style="color:var(--teal);font-weight:700">Privacy Policy</a> for details.</p>`;

  const materialReady = draft.tab === 'sample' || Material.isReady() || (draft.tab === 'library' && !!draft.libraryMaterialId && !!draft.libraryText);

  const configHtml = `<article class="panel" style="margin-top:18px"><h2>Configure your quiz</h2><p class="sub">Choose how you want to study, then generate.</p>
    <h2 style="margin-top:22px">Session mode</h2>
    <p class="sub">Study gives instant feedback. Exam waits until the end. Flashcards skip scoring entirely.</p>
    <div class="mode">
      <button class="choice ${draft.mode === 'study' ? 'selected' : ''}" data-mode="study"><b>Study mode</b><small>Hints, explanations, and a gentle pace.</small></button>
      <button class="choice ${draft.mode === 'exam' ? 'selected' : ''}" data-mode="exam"><b>Exam mode</b><small>Timed, uninterrupted, and scored at the end.</small></button>
      <button class="choice ${draft.mode === 'flashcards' ? 'selected' : ''}" data-mode="flashcards"><b>Flashcards</b><small>Flip through cards at your own pace. No scoring.</small></button>
    </div>
    <details id="moreOptions" ${draft.moreOptionsOpen ? 'open' : ''} style="margin-top:22px"><summary style="cursor:pointer;font-weight:800;font-size:14px">More options</summary>
    <label class="field" style="margin-top:16px">Quiz title <span class="hint">(optional)</span><input type="text" id="quizTitle" value="${esc(draft.customTitle)}" placeholder="Leave blank to name it automatically" maxlength="80"></label>
    <label class="field">Subject <span class="hint">(optional)</span><input type="text" id="quizSubject" value="${esc(draft.subject)}" placeholder="e.g. Mathematics" maxlength="120"></label>
    <div class="form-grid" style="margin-top:16px">
      <label class="field">Difficulty<select id="difficulty">
        ${['easy', 'medium', 'hard', 'expert'].map(d => `<option value="${d}" ${draft.difficulty === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}
      </select></label>
      <label class="field">${draft.mode === 'flashcards' ? 'Number of cards' : 'Number of questions'}<input type="number" id="questionCount" min="1" max="${draft.tab === 'sample' ? QuizGen.sampleBankSize(draft.sampleSubject) : 100}" value="${draft.tab === 'sample' ? Math.min(draft.questionCount, QuizGen.sampleBankSize(draft.sampleSubject)) : draft.questionCount}">${draft.tab === 'sample' ? `<span class="hint">This sample bank has ${QuizGen.sampleBankSize(draft.sampleSubject)} built-in questions.</span>` : ''}</label>
    </div>
    ${draft.mode === 'flashcards' ? '' : `<label class="field" style="margin-top:16px">Question types</label>
    <div class="type-row">
      ${[['mcq', 'Multiple Choice'], ['short_answer', 'Short Answer'], ['true_false', 'True / False'], ['mixed', 'Mixed']].map(([v, l]) => `<button class="choice ${draft.typeChoice === v ? 'selected' : ''}" data-type="${v}"><b style="font-size:12px">${l}</b></button>`).join('')}
    </div>
    <div class="form-grid" style="margin-top:16px">
      <label class="field">Time limit<select id="timeChoice">
        <option value="none" ${draft.timeChoice === 'none' ? 'selected' : ''}>No limit</option>
        ${[5, 10, 15, 20, 30, 45, 60].map(m => `<option value="${m}" ${String(draft.timeChoice) === String(m) ? 'selected' : ''}>${m} min</option>`).join('')}
        <option value="custom" ${draft.timeChoice === 'custom' ? 'selected' : ''}>Custom</option>
      </select>${draft.timeChoice === 'custom' ? `<input type="number" id="customMinutes" min="1" max="240" value="${draft.customMinutes}" style="margin-top:8px" placeholder="Minutes">` : ''}</label>
      <label class="field">Topic focus <span class="hint">(optional, comma separated)</span><input type="text" id="topics" value="${esc(draft.topics)}" placeholder="e.g. photosynthesis, cell division"></label>
    </div>`}
    ${draft.mode === 'flashcards' ? `<label class="field" style="margin-top:16px">Topic focus <span class="hint">(optional, comma separated)</span><input type="text" id="topics" value="${esc(draft.topics)}" placeholder="e.g. photosynthesis, cell division"></label>` : ''}
    <label class="field" style="margin-top:16px">Custom instructions <span class="hint">(optional)</span><textarea id="instructions" placeholder="e.g. focus more on definitions than dates">${esc(draft.instructions)}</textarea></label>
    </details>
    <div class="row" style="margin-top:24px">
      <span class="muted">${materialReady ? 'Ready to generate.' : 'Add study material to continue.'}</span>
      <button id="generateBtn" class="btn" ${materialReady ? '' : 'disabled'}>Generate quiz</button>
    </div>
    ${draft.generateError ? `<div class="status-msg error">${esc(draft.generateError)}</div>` : ''}
  </article>`;

  document.querySelector('main').innerHTML = `<section class="creator"><div class="page-title"><div><div class="eyebrow">New learning session</div><h1>Create your quiz</h1><p>Add your material, set it up the way you like, and go.</p></div></div></section><div class="stepper"><i class="step active"></i><i class="step ${materialReady ? 'active' : ''}"></i></div><article class="panel"><h2>Add material</h2>${tabsHtml}${materialBody}${materialNotice}</article>${configHtml}`;

  attachCreateHandlers();
}

function fileTypeIcon(mat) {
  if (mat.sourceType === 'pdf') return 'fa-regular fa-file-pdf';
  if (mat.sourceType === 'docx') return 'fa-regular fa-file-word';
  if (mat.sourceType === 'txt') return 'fa-regular fa-file-lines';
  return 'fa-regular fa-note-sticky'; // pasted text
}

function materialStatusMarkup(mat) {
  if (mat.status === 'empty') return '';
  if (mat.status === 'processing') {
    return `<div class="status-msg info">Processing ${esc(mat.fileName || 'your text')}…</div>`;
  }
  if (mat.status === 'ready') {
    const lowQuality = mat.quality && !mat.quality.looksLikeRealText;
    const qualityWarning = lowQuality
      ? `<div class="status-msg warning">This text doesn't read like typical study material${mat.quality.reasons.length ? ' (' + esc(mat.quality.reasons.join(', ')) + ')' : ''}. You can still generate a quiz, but the questions may not make much sense. Double check what you pasted or uploaded.</div>`
      : '';
    // Phase C: signed-in users can keep the extracted text in their
    // private library for reuse. Guests never see this button.
    const canSave = typeof Auth !== 'undefined' && Auth.isLoggedIn();
    const saveBtn = canSave ? `<button class="btn secondary" id="saveToLibrary">Save to library</button>` : '';
    return `<div class="file-row"><div class="file-row-name"><i class="${fileTypeIcon(mat)}" aria-hidden="true"></i><div><b>${esc(mat.fileName || 'Pasted text')}</b><div class="meta">${mat.characterCount.toLocaleString()} characters extracted</div></div></div><div class="inline-actions"><button class="btn ghost" id="removeMaterial">Remove</button>${saveBtn}</div></div><div id="saveLibrarySlot"></div><div class="status-msg success">Content ready for quiz generation.</div>${qualityWarning}`;
  }
  if (mat.status === 'invalid' || mat.status === 'extraction_failed' || mat.status === 'empty_content') {
    return `<div class="status-msg error">${esc(mat.error || 'Something went wrong reading that file.')}</div><div class="inline-actions"><button class="btn ghost" id="removeMaterial">Remove</button>${mat.fileName ? '<button class="btn secondary" id="retryMaterial">Try again</button>' : ''}</div>`;
  }
  return '';
}

/* ============================================================
   Phase C: "My library" tab on Create Quiz (signed-in only).
   The list endpoint returns summaries without the text blob; the
   selected row's full text is fetched once via getMaterial and held in
   the draft for local use. The AI provider
   instead receives only the materialId and the server resolves the text
   itself (see convex/quiz.ts) - the client never round-trips the text.
   ============================================================ */
function kindLabel(kind) {
  return { pdf: 'PDF', docx: 'Word', txt: 'Text', paste: 'Pasted text' }[kind] || 'Text';
}

function libraryTabMarkup() {
  if (draft.libraryError) {
    return `<div class="status-msg error">${esc(draft.libraryError)}</div><div class="inline-actions"><button class="btn secondary" id="libraryRetry">Try again</button></div>`;
  }
  if (!draft.libraryList) {
    return `<div class="status-msg info">Loading your saved materials…</div>`;
  }
  if (!draft.libraryList.length) {
    return `<p class="sub">Your library is empty. Upload a file or paste text, then choose “Save to library” once it's ready - your saved materials will appear here for reuse.</p>`;
  }
  const items = draft.libraryList.map(m => `
    <button type="button" class="list-item library-pick ${draft.libraryMaterialId === m.id ? 'selected' : ''}" data-material-id="${esc(m.id)}" role="option" aria-selected="${draft.libraryMaterialId === m.id}">
      <div class="subject"><b>${esc(m.title)}</b><div class="meta">${m.charCount.toLocaleString()} characters · ${kindLabel(m.kind)}${m.subject ? ' · ' + esc(m.subject) : ''}</div></div>
      ${draft.libraryMaterialId === m.id ? '<span class="score">✓ selected</span>' : ''}
    </button>`).join('');
  const selectedNote = draft.libraryMaterialId && draft.libraryText
    ? `<div class="status-msg success">Using “${esc(draft.libraryLabel)}” for this quiz.</div>`
    : '';
  return `<div class="list library-picker" role="listbox" aria-label="Your saved materials">${items}</div>${selectedNote}`;
}

function loadLibraryTab() {
  Convex.query('materials:listMaterials', { sessionToken: Auth.getToken() }).then(res => {
    if (draft.tab !== 'library') return; // user moved on - don't clobber the new tab
    if (!res.ok) {
      draft.libraryList = [];
      draft.libraryError = (res.error && res.error.message) || 'Could not load your library.';
    } else {
      draft.libraryList = res.data.materials;
      draft.libraryError = '';
    }
    renderCreate();
  }).catch(() => {
    if (draft.tab !== 'library') return;
    draft.libraryList = [];
    draft.libraryError = 'Could not load your library. Check your connection and try again.';
    renderCreate();
  });
}

// Fetch one row's full text for the create flow (e.g. after the
// "Use for quiz" handoff from materials.html, or a library-tab pick).
function fetchLibraryMaterialForCreate(id) {
  if (!id) return;
  loadLibraryTab();
  selectLibraryMaterial(id, true);
}

function selectLibraryMaterial(id, quiet) {
  draft.libraryMaterialId = null;
  draft.libraryLabel = '';
  draft.libraryText = '';
  Convex.query('materials:getMaterial', { sessionToken: Auth.getToken(), materialId: id }).then(res => {
    if (!res.ok) {
      draft.libraryError = (res.error && res.error.message) || 'That saved material is no longer available.';
      draft.libraryMaterialId = null;
    } else {
      const m = res.data.material;
      draft.libraryMaterialId = m.id;
      draft.libraryLabel = m.title;
      draft.libraryText = m.extractedText;
      draft.libraryError = '';
      // Prefill the quiz subject from the material's stored subject when the
      // user hasn't typed their own - the library is where subjects live.
      if (m.subject && !draft.subject.trim()) draft.subject = m.subject;
      if (!quiet) toast('Using “' + m.title + '” for this quiz.');
    }
    if (document.body.dataset.page === 'create') renderCreate();
  }).catch(() => {
    draft.libraryError = 'Could not load that material. Please try again.';
    draft.libraryMaterialId = null;
    if (document.body.dataset.page === 'create') renderCreate();
  });
}

function attachCreateHandlers() {
  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => { draft.tab = b.dataset.tab; renderCreate(); });

  document.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { draft.typeChoice = b.dataset.type; renderCreate(); });
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { draft.mode = b.dataset.mode; renderCreate(); });

  const dz = document.querySelector('#dropzone');
  if (dz) {
    const fileInput = document.querySelector('#fileInput');
    dz.onclick = () => fileInput.click();
    dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
    ['dragover', 'dragenter'].forEach(evt => dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(evt => dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
    fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  }

  const removeBtn = document.querySelector('#removeMaterial');
  if (removeBtn) removeBtn.onclick = () => { Material.reset(); renderCreate(); };
  const retryBtn = document.querySelector('#retryMaterial');
  if (retryBtn) retryBtn.onclick = () => document.querySelector('#dropzone') ? document.querySelector('#fileInput').click() : null;

  const usePaste = document.querySelector('#usePaste');
  if (usePaste) usePaste.onclick = () => { Material.fromPaste(document.querySelector('#pasteArea').value); renderCreate(); };
  const pasteArea = document.querySelector('#pasteArea');
  if (pasteArea) pasteArea.oninput = () => { const c = document.querySelector('#pasteCount'); if (c) c.textContent = pasteArea.value.trim().length + ' characters'; };

  const sampleSelect = document.querySelector('#sampleSubject');
  if (sampleSelect) sampleSelect.onchange = () => { draft.sampleSubject = sampleSelect.value; draft.questionCount = Math.min(draft.questionCount, QuizGen.sampleBankSize(draft.sampleSubject)); renderCreate(); };

  const quizSubject = document.querySelector('#quizSubject');
  if (quizSubject) quizSubject.oninput = () => { draft.subject = quizSubject.value; };
  const quizTitle = document.querySelector('#quizTitle');
  if (quizTitle) quizTitle.oninput = () => { draft.customTitle = quizTitle.value; };
  const difficulty = document.querySelector('#difficulty');
  if (difficulty) difficulty.onchange = () => { draft.difficulty = difficulty.value; };
  const qCount = document.querySelector('#questionCount');
  if (qCount) qCount.oninput = () => {
    const max = draft.tab === 'sample' ? QuizGen.sampleBankSize(draft.sampleSubject) : 100;
    draft.questionCount = clamp(parseInt(qCount.value, 10) || 1, 1, max);
  };
  const timeChoice = document.querySelector('#timeChoice');
  if (timeChoice) timeChoice.onchange = () => { draft.timeChoice = timeChoice.value; renderCreate(); };
  const customMinutes = document.querySelector('#customMinutes');
  if (customMinutes) customMinutes.oninput = () => { draft.customMinutes = clamp(parseInt(customMinutes.value, 10) || 1, 1, 240); };
  const topics = document.querySelector('#topics');
  if (topics) topics.oninput = () => { draft.topics = topics.value; };
  const instructions = document.querySelector('#instructions');
  if (instructions) instructions.oninput = () => { draft.instructions = instructions.value; };

  const moreOptions = document.querySelector('#moreOptions');
  if (moreOptions) moreOptions.ontoggle = () => { draft.moreOptionsOpen = moreOptions.open; };

  const generateBtn = document.querySelector('#generateBtn');
  if (generateBtn) generateBtn.onclick = onGenerateClick;

  // Phase C: library tab wiring (signed-in only).
  if (draft.tab === 'library') {
    if (!draft.libraryList && !draft.libraryError) loadLibraryTab();
    const retryBtn = document.querySelector('#libraryRetry');
    if (retryBtn) retryBtn.onclick = () => { draft.libraryList = null; draft.libraryError = ''; renderCreate(); };
    document.querySelectorAll('.library-pick').forEach(el => {
      el.onclick = () => {
        if (el.dataset.materialId !== draft.libraryMaterialId) selectLibraryMaterial(el.dataset.materialId);
      };
    });
  }

  // Phase C: save-to-library wiring on the file/paste tabs (see
  // materialStatusMarkup's ready state). The inline title form is
  // rendered by toggleSaveToLibraryForm, which wires its own buttons.
  const saveLibBtn = document.querySelector('#saveToLibrary');
  if (saveLibBtn) saveLibBtn.onclick = toggleSaveToLibraryForm;
}

/* Phase C: save the currently extracted material into the signed-in
   user's private library. The server re-validates length, the 20-item
   cap, and title uniqueness - the client just forwards the text. */
function toggleSaveToLibraryForm() {
  const slot = document.querySelector('#saveLibrarySlot');
  if (!slot) return;
  if (slot.innerHTML.trim()) { slot.innerHTML = ''; return; } // toggle closed
  const mat = Material.get();
  const defaultTitle = ((mat.fileName || 'My study material').replace(/\.[^.]+$/, '') || 'My study material').slice(0, 80);
  slot.innerHTML = `<div class="panel" style="margin-top:12px"><label class="field">Title for your library<input type="text" id="saveLibraryTitle" value="${esc(defaultTitle)}" maxlength="80"></label><label class="field" style="margin-top:12px">Subject <span class="hint">(optional)</span><input type="text" id="saveLibrarySubject" placeholder="e.g. Mathematics" maxlength="120"></label><p class="sub" style="margin-top:8px">Saved to your account. Only you can see it, and you can delete it anytime.</p><div class="inline-actions" style="margin-top:12px"><button class="btn" id="confirmSaveToLibrary">Save</button><button class="btn ghost" id="cancelSaveToLibrary">Cancel</button></div><div class="status-msg error" id="saveLibraryError" style="display:none;margin-top:12px"></div></div>`;
  document.querySelector('#confirmSaveToLibrary').onclick = saveMaterialToLibrary;
  document.querySelector('#cancelSaveToLibrary').onclick = () => { slot.innerHTML = ''; };
  const input = document.querySelector('#saveLibraryTitle');
  if (input) { input.focus(); input.select(); }
}

function saveMaterialToLibrary() {
  const mat = Material.get();
  const errEl = document.querySelector('#saveLibraryError');
  const titleInput = document.querySelector('#saveLibraryTitle');
  const subjectInput = document.querySelector('#saveLibrarySubject');
  const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = ''; } };
  if (!Material.isReady()) { showErr('Nothing to save yet. Add your material first.'); return; }
  const kind = ['pdf', 'docx', 'txt', 'paste'].includes(mat.sourceType) ? mat.sourceType : 'paste';
  const fallbackTitle = ((mat.fileName || 'My study material').replace(/\.[^.]+$/, '') || 'My study material').slice(0, 80);
  const btn = document.querySelector('#confirmSaveToLibrary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  Convex.mutation('materials:saveMaterial', {
    sessionToken: Auth.getToken(),
    title: (titleInput && titleInput.value.trim()) || fallbackTitle,
    subject: (subjectInput && subjectInput.value.trim().slice(0, 120)) || '',
    kind: kind,
    extractedText: mat.extractedText
  }).then(res => {
    if (!res.ok) {
      showErr((res.error && res.error.message) || 'Could not save. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      return;
    }
    toast('Saved to your library. Only you can see it, and you can delete it anytime.');
    draft.libraryList = null; // invalidate the cached list so the library tab refetches
    renderCreate();
  }).catch(() => {
    showErr('Could not save. Check your connection and try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  });
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function handleFile(file) {
  renderCreate(); // shows "selected" state via next status pass
  Material.fromFile(file).then(() => renderCreate());
}

function timeLimitMinutesFromDraft() {
  if (draft.timeChoice === 'none') return null;
  if (draft.timeChoice === 'custom') return draft.customMinutes;
  return parseInt(draft.timeChoice, 10);
}

function onGenerateClick() {
  draft.targetedArea = null; // normal flow owns the draft from here
  const mat = Material.get();
  // Phase C: the library tab is ready only once a saved material has been
  // picked AND its text fetched (fetchLibraryMaterialForCreate /
  // selectLibraryMaterial). Guests can never reach this branch - the tab
  // only renders signed in.
  if (draft.tab === 'library') {
    if (!draft.libraryMaterialId || !draft.libraryText) {
      draft.generateError = 'Choose a saved material from your library first.';
      renderCreate();
      return;
    }
  } else if (draft.tab !== 'sample' && !Material.isReady()) {
    draft.generateError = 'Add usable study material before generating.';
    renderCreate();
    return;
  }
  draft.generateError = '';
  runGenerationSequence(mat);
}

function runGenerationSequence(mat) {
  const isFlashcards = draft.mode === 'flashcards';
  document.querySelector('main').innerHTML = `<section class="page-title"><div><div class="eyebrow">Generating</div><h1>Building your ${isFlashcards ? 'flashcards' : 'quiz'}\u2026</h1><p>This only takes a moment.</p></div></section><article class="panel gen-loading"><ul class="gen-steps">
    <li class="gen-step active" data-step="1"><span class="gen-dot"></span>Checking your material</li>
    <li class="gen-step" data-step="2"><span class="gen-dot"></span>Generating ${isFlashcards ? 'cards' : 'questions'}</li>
    <li class="gen-step" data-step="3"><span class="gen-dot"></span>Validating your ${isFlashcards ? 'deck' : 'quiz'}</li>
  </ul></article>`;

  function setStep(n) {
    document.querySelectorAll('.gen-step').forEach(el => {
      const s = parseInt(el.dataset.step, 10);
      el.classList.toggle('done', s < n);
      el.classList.toggle('active', s === n);
    });
  }

  const t1 = setTimeout(() => setStep(2), 450);
  const t2 = setTimeout(() => setStep(3), 950);

  const config = {
    material: draft.tab === 'sample' ? null : draft.tab === 'library'
      ? { text: draft.libraryText, label: draft.libraryLabel }
      : { text: mat.extractedText, label: mat.fileName || 'Pasted text' },
    // Phase C: only the real AI provider uses materialId (it resolves the
    // text server-side); the inline text above is a local copy from the
    // user's own getMaterial row, kept for validation and display.
    materialId: draft.tab === 'library' ? draft.libraryMaterialId : undefined,
    // Subject/topic contamination fix: the quiz config's subject is the
    // application-owned quiz context (server-validated, AI cannot set it).
    subject: draft.subject,
    sampleSubject: draft.tab === 'sample' ? draft.sampleSubject : null,
    difficulty: draft.difficulty,
    questionCount: draft.questionCount,
    questionTypes: [draft.typeChoice],
    timeLimitMinutes: timeLimitMinutesFromDraft(),
    mode: draft.mode,
    topics: draft.topics.split(',').map(t => t.trim()).filter(Boolean),
    instructions: draft.instructions
  };

  // A floor on perceived generation time keeps the staged steps legible even
  // though the underlying heuristic generator is usually near-instant; the
  // real work still happens in parallel, not after, this delay.
  const minDelay = new Promise(resolve => setTimeout(resolve, 1300));

  const genProvider = isFlashcards ? QuizGen.generateFlashcards(config) : withAgeEligibility(() => QuizGen.generateQuiz(config));

  Promise.all([genProvider, minDelay]).then(([resultObj]) => {
    clearTimeout(t1);
    clearTimeout(t2);
    setStep(4);
    if (draft.customTitle.trim()) resultObj.title = draft.customTitle.trim();
    const check = isFlashcards ? QuizValidate.validateFlashcards(resultObj) : QuizValidate.validateQuiz(resultObj);
    setTimeout(() => {
      if (!check.ok) {
        draft.generateError = 'Could not build a valid ' + (isFlashcards ? 'flashcard deck' : 'quiz') + ' from this material (' + check.errors[0] + '). Try different material or settings.';
        renderCreate();
        return;
      }
      draft.generatedQuiz = resultObj;
      // Phase C: carry the library link (if any) onto the quiz so it
      // threads through the session into the saved attempt. The backend
      // provider's response doesn't include it - config is the source.
      resultObj.materialId = config.materialId || null;
      renderReadyScreen();
    }, 250);
  }).catch(err => {
    clearTimeout(t1);
    clearTimeout(t2);
    draft.generateError = (err && err.message) || 'Generation failed. Please try again.';
    renderCreate();
  });
}

function renderReadyScreen() {
  const q = draft.generatedQuiz;
  const isFlashcards = q.mode === 'flashcards';
  const meta = isFlashcards
    ? `${q.cardCount} cards \u00b7 flashcards`
    : `${q.questionCount} questions \u00b7 ${esc(q.difficulty)} \u00b7 ${q.mode === 'exam' ? 'Exam mode' : 'Study mode'}${q.timeLimitMinutes ? ' \u00b7 ' + q.timeLimitMinutes + ' min' : ' \u00b7 no time limit'}`;
  document.querySelector('main').innerHTML = `<section class="ready-screen"><div class="ready-badge">✓ ${isFlashcards ? 'Deck' : 'Quiz'} ready</div><h1>${esc(q.title)}</h1><p class="sub">${meta}</p><div class="hero-cta"><button class="btn" id="startQuizBtn">${isFlashcards ? 'Start studying' : 'Start quiz'} →</button><button class="btn ghost" id="regenerateBtn">Generate a different set</button></div></section>`;
  document.querySelector('#startQuizBtn').onclick = onStartQuiz;
  // A2: a targeted quiz regenerates through the targeted flow, not the
  // normal create flow (there is no draft material for it). Frozen: when
  // the flag is off this path is unreachable (no targetedArea is ever
  // set), and the guard below keeps it that way even if one were.
  document.querySelector('#regenerateBtn').onclick = () => {
    if (draft.targetedArea && TARGETED_PRACTICE_ENABLED) {
      const key = draft.targetedArea;
      const rBtn = document.querySelector('#regenerateBtn');
      const sBtn = document.querySelector('#startQuizBtn');
      if (rBtn) { rBtn.disabled = true; rBtn.textContent = 'Generating…'; }
      if (sBtn) sBtn.disabled = true;
      runTargetedGeneration(key).catch((err) => {
        // The duplicate-click lock rejects silently if a generation is
        // already in flight; anything else gets a safe toast.
        if (err && err.code && err.code !== 'duplicate') {
          toast('Couldn\u2019t generate a new set right now. Please try again.');
        }
        if (rBtn) { rBtn.disabled = false; rBtn.textContent = 'Generate a different set'; }
        if (sBtn) sBtn.disabled = false;
      });
      return;
    }
    draft.generatedQuiz = null; onGenerateClick();
  };
}

function onStartQuiz() {
  const q = draft.generatedQuiz;
  if (!q) return;
  const isFlashcards = q.mode === 'flashcards';
  const sess = {
    quizId: q.id,
    title: q.title,
    subject: q.subject,
    difficulty: q.difficulty || null,
    mode: q.mode,
    timeLimitMinutes: isFlashcards ? null : q.timeLimitMinutes,
    questionCount: isFlashcards ? q.cards.length : q.questions.length,
    questions: isFlashcards ? null : q.questions,
    cards: isFlashcards ? q.cards : null,
    answers: {},
    visited: {},
    marked: {},
    checked: {},
    index: 0,
    startedAt: Date.now(),
    status: 'in_progress',
    sourceMaterial: q.sourceMaterial,
    retryOf: null,
    // Phase C: link back to the saved material this quiz came from, if any.
    materialId: q.materialId || null,
    // A2: how this quiz came to be ("normal" | "focused_history" |
    // "targeted_ai"); rides into the saved attempt for future analytics.
    practiceSource: q.practiceSource || null
  };
  activeSession.set(sess);
  location.href = 'quiz.html';
}

/* ============================================================
   MATERIALS (Phase C) - saved study materials library.
   Signed-in only: guests get a sign-in prompt. Every row belongs to
   the account resolved from the session token server-side; the client
   never sends a userId. Deleting a material unlinks it from attempts
   (the attempts themselves survive) - see convex/materials.ts.
   ============================================================ */
let materialsUI = null;

function materials() {
  materialsUI = { list: null, error: '', view: 'list', detail: null, renaming: false, confirmingDelete: false, actionError: '' };
  renderMaterials();
  loadMaterialsList();
}

function loadMaterialsList() {
  if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) return;
  Convex.query('materials:listMaterials', { sessionToken: Auth.getToken() }).then(res => {
    if (document.body.dataset.page !== 'materials') return;
    if (!res.ok) {
      materialsUI.list = [];
      materialsUI.error = (res.error && res.error.message) || 'Could not load your library.';
    } else {
      materialsUI.list = res.data.materials;
      materialsUI.error = '';
    }
    // Keep an open detail view in sync with the fresh list.
    if (materialsUI.view === 'detail' && materialsUI.detail) {
      const fresh = materialsUI.list.find(m => m.id === materialsUI.detail.id);
      if (!fresh) { materialsUI.view = 'list'; materialsUI.detail = null; }
    }
    renderMaterials();
  }).catch(() => {
    if (document.body.dataset.page !== 'materials') return;
    materialsUI.list = [];
    materialsUI.error = 'Could not load your library. Check your connection and try again.';
    renderMaterials();
  });
}

function materialMetaLine(m) {
  return `${m.charCount.toLocaleString()} characters · ${kindLabel(m.kind)}${m.subject ? ' · ' + esc(m.subject) : ''} · updated ${new Date(m.updatedAt).toLocaleDateString()}`;
}

function renderMaterials() {
  const main = document.querySelector('main');
  const signedIn = typeof Auth !== 'undefined' && Auth.isLoggedIn();
  if (!signedIn) {
    main.innerHTML = `<section class="page-title"><div><div class="eyebrow">My materials</div><h1>Saved study materials</h1><p>Keep the texts you study from, and turn them into quizzes again in one tap.</p></div></section><article class="panel"><h2>Sign in to use your library</h2><p class="sub">Saved materials live on your account, so they're here on any device. Without an account you can still upload or paste material on the Create page. It just won't be saved.</p><div class="hero-cta" style="margin-top:16px"><a class="btn" href="signin.html">Sign in</a><a class="btn ghost" href="signup.html">Create account</a></div></article>`;
    return;
  }
  if (materialsUI.view === 'detail' && materialsUI.detail) {
    renderMaterialDetail(main);
    return;
  }
  let body = '';
  if (materialsUI.error) {
    body = `<div class="status-msg error">${esc(materialsUI.error)}</div><div class="inline-actions"><button class="btn secondary" id="materialsRetry">Try again</button></div>`;
  } else if (!materialsUI.list) {
    body = `<div class="status-msg info">Loading your saved materials…</div>`;
  } else if (!materialsUI.list.length) {
    body = `<p class="sub">Nothing saved yet. Upload a file or paste text on the Create page, then choose “Save to library” once it's ready - your saved materials will live here.</p><div class="hero-cta" style="margin-top:16px"><a class="btn" href="create.html">Create a quiz</a></div>`;
  } else {
    body = `<div class="list">` + materialsUI.list.map(m => `
      <div class="list-item material-row">
        <button type="button" class="material-info material-open" data-open="${esc(m.id)}" title="Open"><b class="material-title">${esc(m.title)}</b><div class="material-meta">${materialMetaLine(m)}</div></button>
        <div class="material-actions"><button class="btn secondary" data-use="${esc(m.id)}">Use for quiz</button><a class="btn ghost" href="tutor.html?materialId=${esc(m.id)}" aria-label="Ask the tutor about ${esc(m.title)}"><i class="fa-solid fa-comments" aria-hidden="true"></i> Tutor</a></div>
      </div>`).join('') + `</div>`;
  }
  const count = materialsUI.list ? materialsUI.list.length : 0;
  main.innerHTML = `<section class="page-title"><div><div class="eyebrow">My materials</div><h1>Saved study materials</h1><p>${count} of 20 saved · visible only to you, deletable anytime.</p></div></section><article class="panel">${body}</article>`;
  attachMaterialsListHandlers();
}

function attachMaterialsListHandlers() {
  const retry = document.querySelector('#materialsRetry');
  if (retry) retry.onclick = () => { materialsUI.list = null; materialsUI.error = ''; renderMaterials(); loadMaterialsList(); };
  document.querySelectorAll('.material-open').forEach(el => { el.onclick = () => openMaterialDetail(el.dataset.open); });
  document.querySelectorAll('[data-use]').forEach(el => { el.onclick = () => useMaterialForQuiz(el.dataset.use); });
  // B1: open the AI Tutor on this saved material (new conversation).
  document.querySelectorAll('[data-tutor]').forEach(el => { el.onclick = () => { location.href = 'tutor.html?materialId=' + encodeURIComponent(el.dataset.tutor); }; });
}

function openMaterialDetail(id) {
  const cached = materialsUI.list && materialsUI.list.find(m => m.id === id);
  materialsUI.view = 'detail';
  materialsUI.renaming = false;
  materialsUI.confirmingDelete = false;
  materialsUI.actionError = '';
  materialsUI.detail = cached ? { ...cached, extractedText: null } : null;
  renderMaterials();
  Convex.query('materials:getMaterial', { sessionToken: Auth.getToken(), materialId: id }).then(res => {
    if (document.body.dataset.page !== 'materials' || materialsUI.view !== 'detail') return;
    if (!res.ok) {
      materialsUI.actionError = (res.error && res.error.message) || 'That saved material is no longer available.';
      materialsUI.detail = null;
    } else {
      materialsUI.detail = res.data.material;
    }
    renderMaterials();
  }).catch(() => {
    if (document.body.dataset.page !== 'materials' || materialsUI.view !== 'detail') return;
    materialsUI.actionError = 'Could not load that material. Please try again.';
    materialsUI.detail = null;
    renderMaterials();
  });
}

function renderMaterialDetail(main) {
  const m = materialsUI.detail;
  let body = '';
  if (!m || !m.extractedText) {
    body = materialsUI.actionError
      ? `<div class="status-msg error">${esc(materialsUI.actionError)}</div>`
      : `<div class="status-msg info">Loading…</div>`;
  } else {
    const titleBlock = materialsUI.renaming
      ? `<label class="field">Title<input type="text" id="renameTitle" value="${esc(m.title)}" maxlength="80"></label><div class="inline-actions" style="margin-top:10px"><button class="btn" id="renameSave">Save title</button><button class="btn ghost" id="renameCancel">Cancel</button></div>`
      : `<h2>${esc(m.title)}</h2>`;
    const deleteBlock = materialsUI.confirmingDelete
      ? `<div class="status-msg warning" style="margin-top:12px">Delete “${esc(m.title)}”? Quizzes you made from it keep their questions and scores - they just won't link back here. This can't be undone.<div class="inline-actions" style="margin-top:10px"><button class="btn" id="deleteConfirm">Yes, delete it</button><button class="btn ghost" id="deleteCancel">Keep it</button></div></div>`
      : '';
    body = `${titleBlock}<p class="sub" style="margin-top:6px">${materialMetaLine(m)}</p>
      <div class="inline-actions" style="margin-top:12px">
        <button class="btn" data-use="${esc(m.id)}">Use for quiz</button>
        <button class="btn secondary" data-tutor="${esc(m.id)}">Ask Tutor</button>
        ${materialsUI.renaming ? '' : '<button class="btn secondary" id="renameStart">Rename</button>'}
        ${materialsUI.confirmingDelete ? '' : '<button class="btn ghost" id="deleteStart">Delete</button>'}
      </div>
      ${deleteBlock}
      ${materialsUI.actionError ? `<div class="status-msg error" style="margin-top:12px">${esc(materialsUI.actionError)}</div>` : ''}
      <h3 style="margin:20px 0 8px">Saved text</h3>
      <div class="material-text">${esc(m.extractedText)}</div>`;
  }
  main.innerHTML = `<section class="page-title"><div><div class="eyebrow">My materials</div><h1>Material</h1></div></section><div class="inline-actions" style="margin-bottom:14px"><button class="btn ghost" id="materialsBack">← Back to library</button></div><article class="panel">${body}</article>`;
  const back = document.querySelector('#materialsBack');
  if (back) back.onclick = () => { materialsUI.view = 'list'; materialsUI.detail = null; renderMaterials(); };
  document.querySelectorAll('[data-use]').forEach(el => { el.onclick = () => useMaterialForQuiz(el.dataset.use); });
  // B1: open the AI Tutor on this saved material (new conversation).
  document.querySelectorAll('[data-tutor]').forEach(el => { el.onclick = () => { location.href = 'tutor.html?materialId=' + encodeURIComponent(el.dataset.tutor); }; });
  const renameStart = document.querySelector('#renameStart');
  if (renameStart) renameStart.onclick = () => { materialsUI.renaming = true; materialsUI.actionError = ''; renderMaterials(); const i = document.querySelector('#renameTitle'); if (i) { i.focus(); i.select(); } };
  const renameCancel = document.querySelector('#renameCancel');
  if (renameCancel) renameCancel.onclick = () => { materialsUI.renaming = false; renderMaterials(); };
  const renameSave = document.querySelector('#renameSave');
  if (renameSave) renameSave.onclick = () => {
    const input = document.querySelector('#renameTitle');
    const title = input ? input.value.trim() : '';
    if (!title) { materialsUI.actionError = 'Give your material a title first.'; renderMaterials(); return; }
    renameSave.disabled = true; renameSave.textContent = 'Saving…';
    Convex.mutation('materials:renameMaterial', { sessionToken: Auth.getToken(), materialId: m.id, title }).then(res => {
      if (!res.ok) { materialsUI.actionError = (res.error && res.error.message) || 'Could not rename. Please try again.'; }
      else {
        materialsUI.renaming = false;
        materialsUI.actionError = '';
        materialsUI.detail = { ...materialsUI.detail, title: res.data.material.title, updatedAt: res.data.material.updatedAt };
        const row = materialsUI.list && materialsUI.list.find(r => r.id === m.id);
        if (row) { row.title = res.data.material.title; row.updatedAt = res.data.material.updatedAt; }
        toast('Renamed.');
      }
      renderMaterials();
    }).catch(() => { materialsUI.actionError = 'Could not rename. Check your connection and try again.'; renderMaterials(); });
  };
  const deleteStart = document.querySelector('#deleteStart');
  if (deleteStart) deleteStart.onclick = () => { materialsUI.confirmingDelete = true; materialsUI.actionError = ''; renderMaterials(); };
  const deleteCancel = document.querySelector('#deleteCancel');
  if (deleteCancel) deleteCancel.onclick = () => { materialsUI.confirmingDelete = false; renderMaterials(); };
  const deleteConfirm = document.querySelector('#deleteConfirm');
  if (deleteConfirm) deleteConfirm.onclick = () => {
    deleteConfirm.disabled = true; deleteConfirm.textContent = 'Deleting…';
    Convex.mutation('materials:deleteMaterial', { sessionToken: Auth.getToken(), materialId: m.id }).then(res => {
      if (!res.ok) { materialsUI.actionError = (res.error && res.error.message) || 'Could not delete. Please try again.'; materialsUI.confirmingDelete = false; renderMaterials(); return; }
      if (materialsUI.list) materialsUI.list = materialsUI.list.filter(r => r.id !== m.id);
      materialsUI.view = 'list';
      materialsUI.detail = null;
      renderMaterials();
      toast('Material deleted.');
    }).catch(() => { materialsUI.actionError = 'Could not delete. Check your connection and try again.'; materialsUI.confirmingDelete = false; renderMaterials(); });
  };
}

// Hand the create page a material id through sessionStorage; create()
// picks it up, loads the row, and preselects the library tab.
function useMaterialForQuiz(id) {
  try { sessionStorage.setItem('studypath:library-pick', id); } catch (e) { /* storage unavailable - the create page just opens normally */ }
  location.href = 'create.html';
}

/* ============================================================
   QUIZ ENGINE
   ============================================================ */
function isSkipped(answer) {
  return answer === undefined || answer === null || String(answer).trim() === '';
}

function isCorrect(q, answer) {
  if (isSkipped(answer)) return false;
  if (q.type === 'mcq') return answer === q.correctOptionId;
  if (q.type === 'true_false') return String(answer) === String(q.correctAnswer);
  if (q.type === 'short_answer') {
    const norm = s => String(s).trim().toLowerCase().replace(/[^\w\s]/g, '');
    return (q.acceptableAnswers || []).some(a => norm(a) === norm(answer));
  }
  return false;
}

/* ============================================================
   TOPIC GROUPS
   Questions carry a fine-grained `topic` (e.g. "Waves"). To keep long
   lists readable we file each topic under a broader subject
   (e.g. Physics > Waves, Work & energy). A question's own `category`
   wins if the generator provided one; otherwise we classify by keyword
   so older attempts group too. Nothing here changes stored data.
   ============================================================ */
const TOPIC_GROUP_RULES = [
  ['University & Campus', 'oau|universit|campus|chancellor|registrar|bursar|senate|faculty|dean|convocation|matriculation|hostel'],
  ['Physics', 'wave|work|energy|power|force|motion|velocity|speed|accelerat|momentum|gravity|newton|electric|current|voltage|circuit|magnet|optic|light|lens|heat|thermal|thermodynamic|pressure|sound|nuclear|radioactiv|kinematic|dynamics|mechanic|physic'],
  ['Chemistry', 'atom|molecul|bond|acid|base|salt|reaction|periodic|element|mole|organic|electrolysis|oxidation|redox|solution|solubility|gas law|chemical|chemistry|titration|hydrocarbon|alkane|alkene'],
  ['Biology', 'cell|photosynthesis|genetic|dna|gene|evolution|ecology|ecosystem|enzyme|organism|respiration|mitosis|meiosis|species|plant|animal|hormone|digest|nutrition|reproduct|biology|bacteria|virus|immun'],
  ['Mathematics', 'algebra|equation|geometry|trigonometr|calculus|integral|derivative|differentiat|matri[xc]|probability|statistic|function|polynomial|logarithm|sequence|series|vector|fraction|percentage|ratio|mathematic|arithmetic|indices|surd'],
  ['Economics & Industry', 'econom|demand|supply|inflation|market|gdp|trade|money|fiscal|monetary|industr|production|business|finance|budget|tax'],
  ['Government & Civics', 'government|constitution|democra|election|citizen|civic|parliament|legislat|judiciary|executive|mandate|institution|principle|symbol|anthem|pledge|flag|coat of arms|law|right|politic|federal'],
  ['Geography', 'river|mountain|climate|capital|map|region|vegetation|population|relief|ocean|continent|state|latitude|longitude|weather|soil|geograph|confluence'],
  ['History', 'histor|independence|colonial|war|empire|dynasty|founding|revolution|ancient|medieval|kingdom|treaty'],
  ['Language & Literature', 'grammar|vocabulary|poem|poetry|literature|comprehension|essay|tense|figure of speech|synonym|antonym|novel|prose|drama|english'],
  ['Computing', 'algorithm|programming|computer|software|network|database|code|coding|internet|hardware|binary']
];
const TOPIC_GROUP_REGEXES = TOPIC_GROUP_RULES.map(([name, stems]) => [name, new RegExp('\\b(' + stems + ')', 'i')]);

function categoryForTopic(topic, hint) {
  if (hint && String(hint).trim()) return String(hint).trim();
  const t = String(topic || '');
  for (const [name, re] of TOPIC_GROUP_REGEXES) if (re.test(t)) return name;
  return 'Other topics';
}

// Map topic -> category from the questions that produced the results.
function topicCategoryMap(attempts) {
  const map = {};
  (attempts || []).forEach(a => (a.questions || []).forEach(q => {
    const topic = q.topic || 'General';
    if (!map[topic] || (q.category && !map[topic].fromQuestion)) {
      map[topic] = { name: categoryForTopic(topic, q.category), fromQuestion: !!q.category };
    }
  }));
  return map;
}

// entries: [[topic, {correct,total,lastPracticedAt?}], ...]
function groupTopics(entries, catMap) {
  const groups = {};
  entries.forEach(([topic, v]) => {
    const name = (catMap[topic] && catMap[topic].name) || categoryForTopic(topic);
    const g = groups[name] = groups[name] || { name, topics: [], correct: 0, total: 0, last: 0 };
    g.topics.push([topic, v]);
    g.correct += v.correct;
    g.total += v.total;
    if ((v.lastPracticedAt || 0) > g.last) g.last = v.lastPracticedAt;
  });
  const list = Object.values(groups);
  // "Other topics" always sinks to the bottom.
  list.sort((a, b) => (a.name === 'Other topics') - (b.name === 'Other topics') || b.last - a.last);
  return list;
}

function renderTopicGroup(g, showCounts) {
  const pct = g.total ? Math.round((g.correct / g.total) * 100) : 0;
  const right = showCounts ? g.correct + '/' + g.total : pct + '%';
  const rows = g.topics.map(([topic, v]) => {
    const p = v.total ? Math.round((v.correct / v.total) * 100) : 0;
    return `<div class="topic-sub"><div class="row"><span>${esc(topic)}</span><span class="muted">${showCounts ? v.correct + '/' + v.total : p + '%'}</span></div><div class="topic-bar-track"><div class="topic-bar-fill" style="width:${p}%"></div></div></div>`;
  }).join('');
  return `<details class="topic-group"><summary><div class="row"><span class="tg-name"><b>${esc(g.name)}</b><span class="muted tg-count">${g.topics.length} topic${g.topics.length === 1 ? '' : 's'}</span></span><span class="muted">${right}</span></div><div class="topic-bar-track"><div class="topic-bar-fill" style="width:${pct}%"></div></div></summary><div class="topic-subs">${rows}</div></details>`;
}

function buildResultRecord(sess) {
  let correct = 0, incorrect = 0, skipped = 0;
  const topicPerformance = {};
  sess.questions.forEach(q => {
    const ans = sess.answers[q.id];
    const topic = q.topic || 'General';
    topicPerformance[topic] = topicPerformance[topic] || { correct: 0, total: 0 };
    topicPerformance[topic].total++;
    if (isSkipped(ans)) {
      skipped++;
    } else if (isCorrect(q, ans)) {
      correct++;
      topicPerformance[topic].correct++;
    } else {
      incorrect++;
    }
  });
  const score = sess.questions.length ? Math.round((correct / sess.questions.length) * 100) : 0;
  const now = new Date();
  return {
    id: sess.quizId,
    title: sess.title,
    subject: sess.subject,
    difficulty: sess.difficulty,
    mode: sess.mode,
    timeLimitMinutes: sess.timeLimitMinutes,
    questionCount: sess.questions.length,
    questions: sess.questions,
    answers: sess.answers,
    correctCount: correct,
    incorrectCount: incorrect,
    skippedCount: skipped,
    score,
    completionTimeSeconds: Math.max(0, Math.round((Date.now() - sess.startedAt) / 1000)),
    completedAt: now.toISOString(),
    dateLabel: now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    topicPerformance,
    sourceMaterial: sess.sourceMaterial,
    retryOf: sess.retryOf || null,
    // Phase C: links the attempt to its saved material for the backend
    // (ownership re-verified server-side in attempts:saveAttempt).
    materialId: sess.materialId || null,
    // A2: practice origin; the backend union-validates it.
    practiceSource: sess.practiceSource || null
  };
}

function quiz() {
  let sess = activeSession.get();
  const hasQuestions = sess && Array.isArray(sess.questions) && sess.questions.length;
  const hasCards = sess && Array.isArray(sess.cards) && sess.cards.length;
  if (!sess || (!hasQuestions && !hasCards)) { location.href = 'create.html'; return; }
  if (sess.status === 'submitted') { location.href = 'results.html?id=' + encodeURIComponent(sess.quizId); return; }

  if (sess.mode === 'flashcards') {
    runFlashcards(sess);
    return;
  }

  // Defensive integrity check: a session can end up malformed if storage was
  // edited directly, corrupted, or came from an older/incompatible version.
  // Fail safe rather than crashing mid-render.
  const integrity = QuizValidate.validateQuiz({ id: sess.quizId, questions: sess.questions });
  if (!integrity.ok) {
    activeSession.clear();
    sessionStorage.setItem('studypath:create-error', 'Your quiz session couldn\u2019t be restored (' + integrity.errors[0] + '). Please generate a new one.');
    location.href = 'create.html';
    return;
  }

  let showConfirm = false;
  let submitting = false;
  let tickHandle = null;

  function persist() { activeSession.set(sess); }
  function q() { return sess.questions[sess.index]; }

  function finalize() {
    if (submitting || sess.status === 'submitted') return;
    submitting = true;
    clearInterval(tickHandle);
    sess.status = 'submitted';
    persist();
    const record = buildResultRecord(sess);
    store.set('last', record);
    const all = store.get('sessions', []);
    all.push(record);
    store.set('sessions', all);
    syncAttemptToConvex(record);
    activeSession.clear();
    location.href = 'results.html?id=' + encodeURIComponent(record.id);
  }

  // M11F wiring, path (a): localStorage stays the source of truth for
  // everything the UI reads (nothing above this line changes). This is
  // a best-effort background copy to Convex, fired right after the
  // real save and never awaited or allowed to affect navigation. A dropped
  // sync (offline, expired session, backend hiccup) must never interrupt
  // someone looking at their own results.
  //
  // Stabilization (M5/M6): a failed sync is no longer silent — the record
  // id is parked via markPendingSync and retried on the next app start;
  // history rows show "not synced yet" until the server confirms.
  function elapsedSeconds() { return Math.floor((Date.now() - sess.startedAt) / 1000); }
  function remainingSeconds() {
    if (!sess.timeLimitMinutes) return null;
    return sess.timeLimitMinutes * 60 - elapsedSeconds();
  }

  function timerMarkup() {
    if (!sess.timeLimitMinutes) {
      const s = elapsedSeconds();
      return `<span class="timer" id="timeDisplay"><b>${fmtTime(s)}</b> elapsed</span>`;
    }
    const rem = Math.max(0, remainingSeconds());
    const total = sess.timeLimitMinutes * 60;
    const warn = rem <= Math.max(60, total * 0.1);
    return `<span class="timer ${warn ? 'warning' : ''}" id="timeDisplay">⏱ <b>${fmtTime(rem)}</b> left</span>`;
  }

  function fmtTime(totalSec) {
    const s = Math.max(0, totalSec);
    const m = Math.floor(s / 60), r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function optionMarkup(question) {
    const selected = sess.answers[question.id];
    return `<div role="radiogroup" aria-label="Answer options">` + question.options.map((opt, i) => {
      const isSel = selected === opt.id;
      return `<button class="answer ${isSel ? 'selected' : ''}" role="radio" aria-checked="${isSel}" data-opt="${opt.id}"><span class="letter">${String.fromCharCode(65 + i)}</span>${esc(opt.text)}</button>`;
    }).join('') + `</div>` + studyFeedbackMcq(question, selected);
  }

  function studyFeedbackMcq(question, selected) {
    if (sess.mode !== 'study' || isSkipped(selected)) return '';
    const ok = selected === question.correctOptionId;
    const correctOpt = question.options.find(o => o.id === question.correctOptionId);
    return `<div class="feedback-box ${ok ? 'correct' : 'incorrect'}" role="status">${ok ? '✓ Correct.' : '✗ Not quite. Correct answer: ' + esc(correctOpt ? correctOpt.text : '')}<br>${esc(question.explanation || '')}</div>`;
  }

  function tfMarkup(question) {
    const selected = sess.answers[question.id];
    const opts = [['true', 'True'], ['false', 'False']];
    const buttons = `<div role="radiogroup" aria-label="True or False">` + opts.map(([v, l]) => `<button class="answer ${String(selected) === v ? 'selected' : ''}" role="radio" aria-checked="${String(selected) === v}" data-tf="${v}"><span class="letter">${l[0]}</span>${l}</button>`).join('') + `</div>`;
    let feedback = '';
    if (sess.mode === 'study' && !isSkipped(selected)) {
      const ok = String(selected) === String(question.correctAnswer);
      feedback = `<div class="feedback-box ${ok ? 'correct' : 'incorrect'}" role="status">${ok ? '✓ Correct.' : '✗ Not quite. Correct answer: ' + (question.correctAnswer ? 'True' : 'False')}<br>${esc(question.explanation || '')}</div>`;
    }
    return buttons + feedback;
  }

  function shortMarkup(question) {
    const val = sess.answers[question.id] || '';
    const checked = !!sess.checked[question.id];
    let feedback = '';
    if (sess.mode === 'study' && checked) {
      const ok = isCorrect(question, val);
      feedback = `<div class="feedback-box ${ok ? 'correct' : 'incorrect'}" id="shortFeedback" role="status">${ok ? '✓ Correct.' : '✗ Expected answer: ' + esc(question.acceptableAnswers[0])}<br><span class="muted">Your response: ${esc(val || '(no answer)')}</span><br>${esc(question.explanation || '')}</div>`;
    }
    return `<input type="text" class="short-input" id="shortInput" aria-label="Your answer" value="${esc(val)}" placeholder="Type your answer" autocomplete="off">` +
      (sess.mode === 'study' ? `<div class="inline-actions"><button class="btn secondary" id="checkAnswerBtn" ${checked ? 'disabled' : ''}>Check answer</button></div>` : '') +
      feedback;
  }

  function navStrip() {
    return `<div class="nav-strip" role="tablist" aria-label="Question navigator">${sess.questions.map((qq, i) => {
      const cls = ['nav-chip'];
      if (i === sess.index) cls.push('current');
      if (!isSkipped(sess.answers[qq.id])) cls.push('answered');
      if (sess.marked[qq.id]) cls.push('marked');
      const label = 'Question ' + (i + 1) + (isSkipped(sess.answers[qq.id]) ? ', unanswered' : ', answered') + (sess.marked[qq.id] ? ', marked for review' : '');
      return `<button class="${cls.join(' ')}" data-jump="${i}" aria-current="${i === sess.index}" aria-label="${label}">${i + 1}</button>`;
    }).join('')}</div>`;
  }

  function confirmModal() {
    if (!showConfirm) return '';
    const unanswered = sess.questions.filter(qq => isSkipped(sess.answers[qq.id])).length;
    const marked = Object.keys(sess.marked).length;
    return `<div class="modal-overlay" id="confirmOverlay"><article class="panel modal-card" role="dialog" aria-modal="true" aria-labelledby="confirmTitle"><h2 id="confirmTitle">Submit quiz?</h2><p class="sub">${unanswered} unanswered · ${marked} marked for review</p><div class="inline-actions"><button class="btn" id="confirmSubmit">Submit now</button><button class="btn ghost" id="cancelSubmit">Keep working</button></div></article></div>`;
  }

  let renderedIndex = -1;

  function render() {
    // Remember where the page was scrolled so a same-question re-render
    // (picking an answer, marking, opening the submit dialog) doesn't yank
    // the page and move the Next button out from under the user's thumb.
    const prevY = window.scrollY;
    const sameQuestion = renderedIndex === sess.index;
    sess.visited[q().id] = true;
    persist();
    const question = q();
    let body;
    if (question.type === 'mcq') body = optionMarkup(question);
    else if (question.type === 'true_false') body = tfMarkup(question);
    else body = shortMarkup(question);

    const kbdHint = question.type === 'mcq' ? 'Keyboard: 1\u20134 to answer \u00b7 \u2190 \u2192 to move \u00b7 M to mark' : question.type === 'true_false' ? 'Keyboard: T / F to answer \u00b7 \u2190 \u2192 to move \u00b7 M to mark' : 'Keyboard: \u2190 \u2192 to move \u00b7 M to mark';

    document.querySelector('main').innerHTML = `<section class="quiz-wrap"><div class="quiz-top"><a class="muted" href="dashboard.html">← Exit</a><div class="progressline"><i style="width:${(sess.index / sess.questions.length) * 100}%"></i></div>${timerMarkup()}</div><div id="timerAnnounce" aria-live="assertive" class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></div>${navStrip()}<article class="panel question"><div class="quiz-meta-row"><span>${esc(question.topic || sess.subject)} · Question ${sess.index + 1} of ${sess.questions.length}</span><button class="btn ghost mark-btn" id="markBtn" aria-pressed="${!!sess.marked[question.id]}">${sess.marked[question.id] ? '★ Marked' : '☆ Mark for review'}</button></div><h1 id="qHeading" class="${question.text.length > 90 ? 'long' : ''}" tabindex="-1">${esc(question.text)}</h1><div id="answerArea">${body}</div><div class="quiz-actions"><button class="btn ghost" id="backBtn" ${sess.index === 0 ? 'disabled' : ''}>← Back</button><button class="btn" id="nextBtn">${sess.index === sess.questions.length - 1 ? 'Review & submit' : 'Next question →'}</button></div><p class="kbd-hint muted">${kbdHint}</p></article></section>${confirmModal()}`;
    if (window.MathRender) MathRender.render(document.querySelector('.quiz-wrap'));

    // Move focus to the question heading only when the question actually
    // changed. Re-focusing on every same-question re-render (answering,
    // marking, checking) yanks focus for keyboard users and, on mobile
    // browsers, a programmatic focus right before the user's next tap can
    // cause that tap to be swallowed instead of activating the button.
    if (!sameQuestion) {
      const heading = document.querySelector('#qHeading');
      try { heading.focus({ preventScroll: true }); } catch (e) { heading.focus(); }
    }
    window.scrollTo(0, sameQuestion ? prevY : 0);
    renderedIndex = sess.index;
    attachHandlers();
  }

  function attachHandlers() {
    document.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { sess.answers[q().id] = b.dataset.opt; persist(); render(); });
    document.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { sess.answers[q().id] = b.dataset.tf; persist(); render(); });

    const shortInput = document.querySelector('#shortInput');
    if (shortInput) shortInput.oninput = () => {
      sess.answers[q().id] = shortInput.value;
      if (sess.checked[q().id]) { sess.checked[q().id] = false; }
      persist();
      const fb = document.querySelector('#shortFeedback');
      if (fb) fb.remove();
      const checkBtn = document.querySelector('#checkAnswerBtn');
      if (checkBtn) checkBtn.disabled = false;
    };
    const checkBtn = document.querySelector('#checkAnswerBtn');
    if (checkBtn) checkBtn.onclick = () => { sess.checked[q().id] = true; persist(); render(); };

    document.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => { sess.index = parseInt(b.dataset.jump, 10); persist(); render(); });

    const markBtn = document.querySelector('#markBtn');
    if (markBtn) markBtn.onclick = () => { sess.marked[q().id] = !sess.marked[q().id]; if (!sess.marked[q().id]) delete sess.marked[q().id]; persist(); render(); };

    document.querySelector('#backBtn').onclick = () => { if (sess.index > 0) { sess.index--; persist(); render(); } };
    document.querySelector('#nextBtn').onclick = () => {
      if (sess.index < sess.questions.length - 1) { sess.index++; persist(); render(); }
      else { showConfirm = true; render(); }
    };

    const confirmSubmit = document.querySelector('#confirmSubmit');
    if (confirmSubmit) confirmSubmit.onclick = finalize;
    const cancelSubmit = document.querySelector('#cancelSubmit');
    if (cancelSubmit) cancelSubmit.onclick = () => { showConfirm = false; render(); };
  }

  let warnAnnounced = false;

  function tick() {
    if (submitting) return;
    const el = document.querySelector('#timeDisplay');
    if (el) {
      const parent = el.closest('.timer') || el;
      if (sess.timeLimitMinutes) {
        const rem = remainingSeconds();
        if (rem <= 0) { finalize(); return; }
        el.innerHTML = '⏱ <b>' + fmtTime(rem) + '</b> left';
        const total = sess.timeLimitMinutes * 60;
        const warn = rem <= Math.max(60, total * 0.1);
        parent.classList.toggle('warning', warn);
        const announce = document.querySelector('#timerAnnounce');
        if (warn && !warnAnnounced && announce) {
          announce.textContent = 'Less than a minute remaining.';
          warnAnnounced = true;
        }
      } else {
        el.innerHTML = '<b>' + fmtTime(elapsedSeconds()) + '</b> elapsed';
      }
    }
  }

  function onKeydown(e) {
    if (submitting || sess.status === 'submitted') return;
    if (showConfirm) {
      if (e.key === 'Escape') { showConfirm = false; render(); }
      return;
    }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A'].indexOf(tag) !== -1) return;

    if (e.key === 'ArrowLeft') {
      if (sess.index > 0) { sess.index--; persist(); render(); }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      if (sess.index < sess.questions.length - 1) { sess.index++; persist(); render(); }
      else { showConfirm = true; render(); }
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      const qid = q().id;
      sess.marked[qid] = !sess.marked[qid];
      if (!sess.marked[qid]) delete sess.marked[qid];
      persist();
      render();
      return;
    }
    const question = q();
    if (question.type === 'mcq') {
      const idx = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
      if (idx !== -1 && question.options[idx]) {
        sess.answers[question.id] = question.options[idx].id;
        persist();
        render();
      }
    } else if (question.type === 'true_false') {
      if (e.key === 't' || e.key === 'T') { sess.answers[question.id] = 'true'; persist(); render(); }
      else if (e.key === 'f' || e.key === 'F') { sess.answers[question.id] = 'false'; persist(); render(); }
    }
  }
  document.addEventListener('keydown', onKeydown);

  render();
  tickHandle = setInterval(tick, 1000);
}

/* ============================================================
   FLASHCARDS
   No scoring, no timer - just flip through cards at your own pace.
   ============================================================ */
function runFlashcards(sess) {
  let index = sess.index || 0;
  let flipped = false;

  function persist() { sess.index = index; activeSession.set(sess); }
  function card() { return sess.cards[index]; }

  function finish() {
    activeSession.clear();
    toast('Nice, you reviewed ' + sess.cards.length + ' card' + (sess.cards.length === 1 ? '' : 's') + '.');
    location.href = 'dashboard.html';
  }

  function render() {
    const c = card();
    document.querySelector('main').innerHTML = `<section class="quiz-wrap"><div class="quiz-top"><a class="muted" href="dashboard.html">← Exit</a><div class="progressline"><i style="width:${(index / sess.cards.length) * 100}%"></i></div><span class="muted" id="cardProgress">${index + 1} / ${sess.cards.length}</span></div><div class="flashcard-stage"><div class="flashcard ${flipped ? 'flipped' : ''}" id="flashcard" tabindex="0" role="button" aria-label="${flipped ? 'Showing the answer. Activate to flip back.' : 'Showing the prompt. Activate to reveal the answer.'}"><div class="flashcard-face flashcard-front"><span class="muted">${esc(c.topic || '')}</span><p>${esc(c.front)}</p><span class="flip-hint">Tap to flip</span></div><div class="flashcard-face flashcard-back"><span class="muted">${esc(c.topic || '')}</span><p>${esc(c.back)}</p>${c.explanation ? `<p class="muted" style="margin-top:10px;font-size:13px">${esc(c.explanation)}</p>` : ''}<span class="flip-hint">Tap to flip back</span></div></div></div><div class="quiz-actions"><button class="btn ghost" id="prevCard" ${index === 0 ? 'disabled' : ''}>← Back</button><button class="btn" id="nextCard">${index === sess.cards.length - 1 ? 'Finish' : 'Next card →'}</button></div><p class="kbd-hint muted">Keyboard: Space to flip \u00b7 \u2190 \u2192 to move</p></section>`;

    document.querySelector('#flashcard').onclick = () => { flipped = !flipped; render(); };
    document.querySelector('#flashcard').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flipped = !flipped; render(); } };
    document.querySelector('#prevCard').onclick = () => { if (index > 0) { index--; flipped = false; persist(); render(); } };
    document.querySelector('#nextCard').onclick = () => {
      if (index < sess.cards.length - 1) { index++; flipped = false; persist(); render(); }
      else { finish(); }
    };
  }

  function onKeydown(e) {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    const isInteractive = ['INPUT', 'TEXTAREA', 'SELECT', 'A'].indexOf(tag) !== -1;
    if (isInteractive) return;
    if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); flipped = !flipped; render(); }
    else if (e.key === 'ArrowRight') { const btn = document.querySelector('#nextCard'); if (btn) btn.click(); }
    else if (e.key === 'ArrowLeft') { if (index > 0) { index--; flipped = false; persist(); render(); } }
  }
  document.addEventListener('keydown', onKeydown);

  render();
}

/* ============================================================
   RESULTS
   ============================================================ */
function getRecordFromQuery() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (id) {
    const found = store.get('sessions', []).find(r => r.id === id);
    if (isValidRecord(found)) return found;
  }
  const last = store.get('last', null);
  return isValidRecord(last) ? last : null;
}

function isValidRecord(r) {
  return !!(r && typeof r === 'object' && Array.isArray(r.questions) && r.questions.length &&
    r.answers && typeof r.answers === 'object' && typeof r.score === 'number');
}

// Converts a Convex `attempts` row (saveAttempt's shape) back into the
// same local record shape finalize() builds, so History/Progress/
// Dashboard can render either source through one code path.
function convexAttemptToRecord(a) {
  const d = new Date(a.completedAt);
  return {
    id: a.quizId, title: a.title, subject: a.subject, difficulty: a.difficulty, mode: a.mode,
    timeLimitMinutes: a.timeLimitMinutes, questionCount: a.questionCount, sourceMaterial: a.sourceMaterial,
    retryOf: a.retryOf, questions: a.questions, answers: a.answers,
    correctCount: a.correctCount, incorrectCount: a.incorrectCount, skippedCount: a.skippedCount,
    score: a.score, completionTimeSeconds: a.completionTimeSeconds,
    completedAt: d.toISOString(), dateLabel: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    topicPerformance: a.topicPerformance
  };
}

// Pulls down any attempts saved from a DIFFERENT device/browser for a
// signed-in account, merges them into local storage, and re-renders the
// calling page if anything new actually arrived. A no-op for guests
// (Auth.isLoggedIn() is false) - this only ever adds records, never
// removes or overwrites what is already local, so it can't undo an
// in-flight local save. finalize()'s existing background sync remains
// the write path; this is the read/pull-down path that was missing.
function syncRemoteSessions(rerender) {
  if (!(typeof Auth !== 'undefined' && Auth.isLoggedIn())) return;
  Convex.query('attempts:listAttempts', { anonymousId: getAnonId(), sessionToken: Auth.getToken() }).then(res => {
    if (!res.ok || !Array.isArray(res.data)) return;
    const local = store.get('sessions', []);
    const localIds = new Set(local.map(s => s.id));
    const remoteNew = res.data.filter(a => !localIds.has(a.quizId)).map(convexAttemptToRecord);
    if (!remoteNew.length) return;
    const merged = local.concat(remoteNew).sort((x, y) => new Date(x.completedAt) - new Date(y.completedAt));
    store.set('sessions', merged);
    if (rerender) rerender();
  }).catch(() => { /* best-effort - local data already rendered, nothing to roll back */ });
}

/* ---------------- Result share card ---------------- */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapCanvasText(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = String(text).split(/\s+/);
  let line = '';
  const lines = [];
  words.forEach(word => {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  const start = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, start + i * lineHeight));
}

function buildResultCardCanvas(record) {
  const W = 1080, H = 1080, pad = 60;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f7f5ef';
  ctx.fillRect(0, 0, W, H);

  roundRectPath(ctx, pad, pad, W - pad * 2, H - pad * 2, 40);
  ctx.fillStyle = '#27645d';
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 32px Manrope, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('studypath', W / 2, pad + 78);

  const cx = W / 2, cy = 430, r = 190;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#d6ec76';
  ctx.fill();
  ctx.fillStyle = '#18302b';
  ctx.font = '800 108px Manrope, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(record.score + '%', cx, cy);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 42px Manrope, sans-serif';
  ctx.textBaseline = 'alphabetic';
  wrapCanvasText(ctx, record.title, cx, cy + r + 110, W - pad * 2 - 120, 52);

  ctx.font = '500 28px Manrope, sans-serif';
  ctx.fillStyle = '#c3d9d3';
  ctx.fillText(record.correctCount + ' correct \u00b7 ' + record.incorrectCount + ' missed \u00b7 ' + record.skippedCount + ' skipped', cx, H - pad - 92);

  ctx.font = '500 22px "DM Mono", monospace';
  ctx.fillStyle = '#9fc2ba';
  ctx.fillText('Your own material, turned into your own quiz.', cx, H - pad - 40);

  return canvas;
}

async function shareResultCard(record) {
  try { await document.fonts.ready; } catch (e) { /* fonts API unsupported - draw with fallback font */ }
  const canvas = buildResultCardCanvas(record);
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('Could not create the image.'); return; }
    const file = new File([blob], 'studypath-result.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My Studypath result', text: 'I scored ' + record.score + '% on ' + record.title });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'studypath-result.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Image downloaded');
  }, 'image/png');
}

function results() {
  const r = getRecordFromQuery();
  if (!r) { location.href = 'dashboard.html'; return; }
  const msg = r.score >= 80 ? 'Excellent work. You own this.' : r.score >= 50 ? 'A useful session. Review, then build again.' : 'Tough session. Let\u2019s review the misses and go again.';
  const minutes = Math.max(1, Math.ceil(r.completionTimeSeconds / 60));

  const topics = Object.entries(r.topicPerformance || {});
  const topicHtml = topics.length >= 2
    ? groupTopics(topics, topicCategoryMap([r])).map(g => renderTopicGroup(g, true)).join('')
    : `<p class="muted">Not enough topic variety in this quiz yet to break down performance by topic.</p>`;

  document.querySelector('main').innerHTML = `<section class="result-hero"><div><div class="eyebrow" style="color:var(--lime)">Session complete · ${esc(r.mode)} mode${r.retryOf ? '<span class="retry-tag">RETRY</span>' : ''}</div><h1>${msg}</h1><p style="color:#c3d9d3">${r.correctCount} of ${r.questionCount} correct in ${minutes} min.</p></div><div class="grade">${r.score}%</div></section><section class="grid metric-grid"><article class="panel metric"><p class="sub">ACCURACY</p><b>${r.score}%</b></article><article class="panel metric"><p class="sub">CORRECT</p><b>${r.correctCount} / ${r.questionCount}</b></article><article class="panel metric"><p class="sub">INCORRECT</p><b>${r.incorrectCount}</b></article><article class="panel metric"><p class="sub">SKIPPED</p><b>${r.skippedCount}</b></article><article class="panel metric"><p class="sub">TIME</p><b>${minutes} min</b></article><article class="panel metric"><p class="sub">DIFFICULTY</p><b>${esc(r.difficulty)}</b></article></section><section class="panel" style="margin-top:18px"><h2>Performance by topic</h2>${topicHtml}</section><section class="panel" style="margin-top:18px"><h2>Make the learning stick</h2><p class="sub">Review the reasoning behind each response, or practise just the ones you missed.</p><div class="hero-cta"><a class="btn" href="review.html?id=${encodeURIComponent(r.id)}">Review answers →</a>${(r.incorrectCount + r.skippedCount) > 0 ? '<button class="btn secondary" id="retryBtn">Retry incorrect</button>' : ''}<button class="btn ghost" id="shareBtn">Share result</button><a class="btn ghost" href="dashboard.html">Back to dashboard</a></div></section>`;

  const retryBtn = document.querySelector('#retryBtn');
  if (retryBtn) retryBtn.onclick = () => retryIncorrect(r);
  const shareBtn = document.querySelector('#shareBtn');
  if (shareBtn) shareBtn.onclick = () => { shareBtn.disabled = true; shareResultCard(r).finally(() => { shareBtn.disabled = false; }); };
}

function retryIncorrect(record) {
  const retryQs = record.questions.filter(q => isSkipped(record.answers[q.id]) || !isCorrect(q, record.answers[q.id]));
  if (!retryQs.length) { toast('No incorrect or skipped questions to retry.'); return; }
  const sess = {
    quizId: 'retry_' + Date.now(),
    title: 'Retry: ' + record.title,
    subject: record.subject,
    difficulty: record.difficulty,
    mode: record.mode,
    timeLimitMinutes: record.timeLimitMinutes,
    questionCount: retryQs.length,
    questions: retryQs,
    answers: {},
    visited: {},
    marked: {},
    checked: {},
    index: 0,
    startedAt: Date.now(),
    status: 'in_progress',
    sourceMaterial: record.sourceMaterial,
    retryOf: record.id
  };
  activeSession.set(sess);
  location.href = 'quiz.html';
}

/* ============================================================
   REVIEW
   ============================================================ */
/* ---------------- Starred questions ---------------- */
function getStarred() { return store.get('starred', []); }
function isStarred(quizId, questionId) { return getStarred().some(s => s.quizId === quizId && s.questionId === questionId); }
function toggleStar(record, question) {
  const all = getStarred();
  const idx = all.findIndex(s => s.quizId === record.id && s.questionId === question.id);
  if (idx !== -1) {
    all.splice(idx, 1);
    store.set('starred', all);
    return false;
  }
  all.push({
    id: 'star_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    quizId: record.id,
    quizTitle: record.title,
    questionId: question.id,
    question: question,
    starredAt: new Date().toISOString()
  });
  store.set('starred', all);
  return true;
}

function review() {
  const r = getRecordFromQuery();
  if (!r) { location.href = 'dashboard.html'; return; }

  const items = r.questions.map((qq, i) => {
    const ans = r.answers[qq.id];
    const skipped = isSkipped(ans);
    const ok = !skipped && isCorrect(qq, ans);
    let userAnswerText, correctAnswerText;
    if (qq.type === 'mcq') {
      const userOpt = qq.options.find(o => o.id === ans);
      const correctOpt = qq.options.find(o => o.id === qq.correctOptionId);
      userAnswerText = userOpt ? userOpt.text : 'No answer';
      correctAnswerText = correctOpt ? correctOpt.text : '';
    } else if (qq.type === 'true_false') {
      userAnswerText = skipped ? 'No answer' : (String(ans) === 'true' ? 'True' : 'False');
      correctAnswerText = qq.correctAnswer ? 'True' : 'False';
    } else {
      userAnswerText = skipped ? 'No answer' : ans;
      correctAnswerText = qq.acceptableAnswers[0];
    }
    const starred = isStarred(r.id, qq.id);
    // B1D: wrong answers on material-grounded quizzes get an "Ask Tutor why"
    // button. The tutor opens on the same material with the question pre-filled.
    let tutorWhy = '';
    if (!ok && r.materialId) {
      const whyQ = 'I got this question wrong: "' + String(qq.text || '').slice(0, 500) +
        '" I answered "' + String(userAnswerText || '').slice(0, 300) +
        '". The correct answer is "' + String(correctAnswerText || '').slice(0, 300) + '". Why is my answer wrong?';
      tutorWhy = '<div class="inline-actions" style="margin-top:10px"><a class="btn secondary" href="tutor.html?materialId='
        + encodeURIComponent(r.materialId) + '&ask=' + encodeURIComponent(whyQ)
        + '"><i class="fa-solid fa-comments" aria-hidden="true"></i> Ask Tutor why</a></div>';
    }
    return `<article class="panel review-item ${skipped ? '' : (ok ? 'correct' : 'wrong')}"><div class="row"><span class="badge">${skipped ? 'Skipped' : (ok ? 'Correct' : 'Review this')}</span><div style="display:flex;align-items:center;gap:10px"><span class="muted">Question ${i + 1} · ${esc(qq.topic || '')}</span><button class="star-btn ${starred ? 'starred' : ''}" data-star="${qq.id}" aria-pressed="${starred}" aria-label="${starred ? 'Remove from starred questions' : 'Star this question'}">${starred ? '\u2605' : '\u2606'}</button></div></div><h2 style="margin-top:13px">${esc(qq.text)}</h2><p class="muted">Your response: <b>${esc(userAnswerText)}</b></p>${!ok ? `<p class="muted">Expected answer: <b>${esc(correctAnswerText)}</b></p>` : ''}<p>${esc(qq.explanation || '')}</p>${tutorWhy}<div class="report-row"><button class="report-btn" data-report="${qq.id}">Report a problem</button></div><div class="report-form" data-report-form="${qq.id}" hidden><label class="field">What&rsquo;s wrong with this question?<select data-report-reason><option value="incorrect">Incorrect or misleading</option><option value="offensive">Offensive or inappropriate</option><option value="off_topic">Unrelated to my material</option><option value="other">Something else</option></select></label><label class="field" style="margin-top:10px">Details <span class="hint">(optional)</span><textarea data-report-note maxlength="500" rows="2" placeholder="Tell us what you noticed"></textarea></label><div class="report-status" role="status"></div><div class="inline-actions"><button class="btn coral" data-report-send>Send report</button><button class="btn ghost" data-report-cancel>Cancel</button></div></div></article>`;
  }).join('');

  document.querySelector('main').innerHTML = `<section class="page-title"><div><div class="eyebrow">${esc(r.title)}</div><h1>Review with intent.</h1><p>Go through each answer and see why it was right or wrong.</p></div><a class="btn ghost" href="results.html?id=${encodeURIComponent(r.id)}">← Results</a></section>${items}`;
  if (window.MathRender) MathRender.render(document.querySelector('main'));

  document.querySelectorAll('[data-report]').forEach(btn => {
    const qid = btn.dataset.report;
    const form = document.querySelector(`[data-report-form="${qid}"]`);
    btn.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('select').focus(); };
    form.querySelector('[data-report-cancel]').onclick = () => { form.hidden = true; form.querySelector('.report-status').textContent = ''; };
    form.querySelector('[data-report-send]').onclick = () => {
      const qq = r.questions.find(q => q.id === qid);
      const sendBtn = form.querySelector('[data-report-send]');
      const status = form.querySelector('.report-status');
      sendBtn.disabled = true; status.textContent = 'Sending\u2026';
      Convex.mutation('reports:submitReport', {
        sessionToken: Auth.getToken() || undefined,
        anonymousId: getAnonId(),
        quizId: String(r.id),
        questionId: String(qq.id),
        questionText: String(qq.text || ''),
        topic: String(qq.topic || ''),
        reason: form.querySelector('[data-report-reason]').value,
        note: form.querySelector('[data-report-note]').value
      }).then(res => {
        if (res.ok && res.data && res.data.ok) {
          form.hidden = true; btn.textContent = 'Reported \u2713'; btn.disabled = true;
          toast('Thanks, we\u2019ll look into it');
        } else {
          sendBtn.disabled = false;
          status.textContent = (res.ok && res.data && res.data.error && res.data.error.message) || 'We couldn\u2019t send that. Please check your connection and try again.';
        }
      });
    };
  });

  document.querySelectorAll('[data-star]').forEach(btn => {
    btn.onclick = () => {
      const qq = r.questions.find(q => q.id === btn.dataset.star);
      const nowStarred = toggleStar(r, qq);
      btn.classList.toggle('starred', nowStarred);
      btn.setAttribute('aria-pressed', String(nowStarred));
      btn.textContent = nowStarred ? '\u2605' : '\u2606';
      btn.setAttribute('aria-label', nowStarred ? 'Remove from starred questions' : 'Star this question');
      toast(nowStarred ? 'Starred for later practice' : 'Removed from starred');
    };
  });
}

/* ============================================================
   HISTORY
   ============================================================ */
function history() {
  const all = store.get('sessions', []).filter(isValidRecord).slice().reverse();
  let query = '';
  let modeFilter = 'all';

  function matches(s) {
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || s.title.toLowerCase().includes(q) || (s.subject || '').toLowerCase().includes(q);
    const matchesMode = modeFilter === 'all' || s.mode === modeFilter;
    return matchesQuery && matchesMode;
  }

  function rowHtml(s) {
    // Stabilization (M6): a quiz whose server sync failed is honest about
    // it instead of silently local-only.
    const pending = getPendingSync().indexOf(s.id) !== -1;
    return `<div class="list-item history-row"><div class="subject">${esc(s.title)}${s.retryOf ? '<span class="retry-tag">RETRY</span>' : ''}${pending ? '<span class="retry-tag">NOT SYNCED</span>' : ''}<div class="muted">${s.questionCount} questions · ${Math.max(1, Math.ceil(s.completionTimeSeconds / 60))} min · <a href="results.html?id=${encodeURIComponent(s.id)}">Results</a> · <a href="review.html?id=${encodeURIComponent(s.id)}">Review</a></div></div><span class="badge">${esc(s.mode)}</span><b class="score">${s.score}%</b><span class="muted">${esc(s.dateLabel)}</span></div>`;
  }

  function renderList() {
    const list = document.querySelector('#historyList');
    if (!list) return;
    const filtered = all.filter(matches);
    if (!filtered.length) {
      list.innerHTML = `<p class="muted" style="padding:16px 0">${all.length ? 'No quizzes match your search.' : 'Nothing here yet. Complete a quiz and it will appear here, with your score and a link to review what you missed.'}</p>`;
      return;
    }
    list.innerHTML = `<div class="history-row muted" style="font-size:11px;font-weight:800"><span>SESSION</span><span>MODE</span><span>SCORE</span><span>DATE</span></div>` + filtered.map(rowHtml).join('');
  }

  document.querySelector('main').innerHTML = `<section class="page-title"><div><div class="eyebrow">Learning archive</div><h1>Session history</h1><p>Everything you practised, kept in one place.</p></div><a class="btn ghost" href="create.html">+ New quiz</a></section>${all.length ? `<div class="history-controls"><input type="text" id="historySearch" class="short-input" placeholder="Search by title or subject"><div class="tabs" style="margin:0"><button class="tab-btn selected" data-mode-filter="all">All</button><button class="tab-btn" data-mode-filter="study">Study</button><button class="tab-btn" data-mode-filter="exam">Exam</button></div></div>` : ''}<article class="panel"><div id="historyList"></div></article>`;

  renderList();

  const searchInput = document.querySelector('#historySearch');
  if (searchInput) searchInput.oninput = () => { query = searchInput.value; renderList(); };
  document.querySelectorAll('[data-mode-filter]').forEach(b => b.onclick = () => {
    modeFilter = b.dataset.modeFilter;
    document.querySelectorAll('[data-mode-filter]').forEach(x => x.classList.toggle('selected', x === b));
    renderList();
  });
  syncRemoteSessions(history);
}

/* ============================================================
   PROGRESS
   ============================================================ */
function weakTopicPracticeQuestions(all, topicAgg) {
  const weakTopics = Object.entries(topicAgg)
    .filter(([, v]) => v.total >= 2 && v.correct / v.total < 0.7)
    .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total)
    .slice(0, 3)
    .map(([topic]) => topic);
  if (!weakTopics.length) return [];
  const seen = {};
  const questions = [];
  all.forEach(record => {
    record.questions.forEach(q => {
      if (weakTopics.indexOf(q.topic) === -1) return;
      const ans = record.answers[q.id];
      const missed = isSkipped(ans) || !isCorrect(q, ans);
      if (missed && !seen[q.id]) {
        seen[q.id] = true;
        questions.push(q);
      }
    });
  });
  return questions;
}

/* ------------------------------------------------------------
   WEAK AREAS (A1) - signed-in accounts
   The weakness calculation itself lives on the server
   (convex/lib/weakness.ts, served by weakAreas:getWeakAreas) so there is one
   authoritative definition. The browser only displays that result and, when
   asked, builds a practice set from questions already on this device.
   Guests have no server-side per-question data, so they keep the original
   local "Weak topics" row below, unchanged.
   ------------------------------------------------------------ */
/* PARITY-PORT:BEGIN
   Browser copies of convex/lib/topics.ts (cleanTopicLabel, topicKeyFor) and
   convex/lib/results.ts (questionKeyFor). The server decides which topics and
   questions matter; the browser only needs to recognise the same ones in its
   own history. A test runs both implementations over the same inputs and
   fails if they ever disagree - change them together. */
const TOPIC_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'with', 'by', 'at', 'from', 'as', 'is', 'are']);
const TOPIC_TRAILING_ARTEFACTS = [
  /\s*[(\[]?\s*\d+\s*\/\s*\d+\s*[)\]]?\s*$/,
  /\s*[(\[]\s*\d{1,3}\s*[)\]]\s*$/,
  /\s*(?:#|no\.?\s*)\d{1,3}\s*$/i
];
function cleanTopicLabelClient(topic) {
  let s = typeof topic === 'string' ? topic : '';
  s = s.replace(/\s+/g, ' ').trim().replace(/^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g, '').trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const re of TOPIC_TRAILING_ARTEFACTS) {
      const t = s.replace(re, '').trim();
      if (t !== s) { s = t; changed = true; }
    }
    if (!changed) break;
  }
  return s;
}
function singulariseClient(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}
function topicKeyClient(topic) {
  const raw = cleanTopicLabelClient(topic);
  const cleaned = raw.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const meaningful = words.filter(w => !TOPIC_STOPWORDS.has(w));
  const chosen = (meaningful.length ? meaningful : words).map(singulariseClient);
  if (!chosen.length) return 'general';
  return chosen.sort().join('-').slice(0, 80);
}
// Mirrors subjectKeyFor in convex/lib/weakness.ts: light normalization only
// (lowercase/trim), so two subjects never silently merge. Keep in sync.
function subjectKeyClient(subject) {
  let s = typeof subject === 'string' ? subject : '';
  s = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}
function cyrb53Client(str, seed) {
  seed = seed || 0;
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
function questionKeyClient(q) {
  const text = q && typeof q.text === 'string' ? q.text : '';
  const normalised = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return 'qk_' + cyrb53Client((q && typeof q.type === 'string' ? q.type : '') + '|' + normalised);
}
/* PARITY-PORT:END */

const WEAK_PRACTICE_MAX = 15;
const WEAK_PRACTICE_AREAS = 3;
const WEAK_LIST_MAX = 4;
const WEAK_STATUS_LABEL = { established: 'Needs more practice', emerging: 'Early sign', improving: 'Improving' };
let weakAreasCache = null; // last good server result, so a re-render doesn't flash "checking" again

function normQuestionKey(q) {
  return (q.type || '') + '|' + String(q.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Questions from this device's history that belong to the weak areas and whose
// MOST RECENT answer was a miss (a question you later got right is not
// re-served). Interleaved across areas so the first area cannot crowd out the
// others; when an area's weakness is type-specific, that type comes first.
// Ids are reassigned: question ids (q_1, q_2...) repeat in every quiz, and two
// different questions sharing an id would overwrite each other's answers.
function weakAreaPracticeQuestions(all, areas) {
  const targets = (areas || []).filter(a => a.status === 'established' || a.status === 'emerging').slice(0, WEAK_PRACTICE_AREAS);
  if (!targets.length) return [];
  const areaOfTopic = new Map();
  const areaOfKey = new Map();
  // Legacy topic-only indexes: practice sets mix subjects by construction,
  // so they keep the old matching behavior.
  const anyOfTopic = new Map();
  const anyOfKey = new Map();
  targets.forEach((a, i) => {
    // Subject/topic contamination fix: weak areas are subject+topic
    // buckets, so index by subject key too - a "Waves" question from a
    // Physics quiz must not fill the "Waves · Mathematics" practice queue.
    const sKey = a.subjectKey || '';
    (a.topicVariants && a.topicVariants.length ? a.topicVariants : [a.topic]).forEach(t => {
      areaOfTopic.set(sKey + '|' + t, i);
      if (!anyOfTopic.has(t)) anyOfTopic.set(t, i);
    });
    if (a.topicKey) {
      areaOfKey.set(sKey + '|' + a.topicKey, i);
      if (!anyOfKey.has(a.topicKey)) anyOfKey.set(a.topicKey, i);
    }
  });
  const latest = new Map();
  let order = 0;
  all.slice().sort((x, y) => new Date(x.completedAt) - new Date(y.completedAt)).forEach(record => {
    // Practice sessions mix subjects by construction; real and retry
    // quizzes carry their true subject and match strictly.
    const scoped = !((record.quizId || '').startsWith('practice_') || record.subject === 'Practice');
    const sKey = scoped ? subjectKeyClient(record.subject) : null;
    (record.questions || []).forEach(q => {
      const topic = q.topic || 'General';
      // The key match is what lets old counter-suffixed names ("State Capitals 1/1")
      // and spelling variants of one topic all count toward the same area.
      let area;
      if (sKey !== null) {
        area = areaOfTopic.has(sKey + '|' + topic) ? areaOfTopic.get(sKey + '|' + topic) : areaOfKey.get(sKey + '|' + topicKeyClient(topic));
      } else {
        area = anyOfTopic.has(topic) ? anyOfTopic.get(topic) : anyOfKey.get(topicKeyClient(topic));
      }
      if (area === undefined) return;
      const ans = (record.answers || {})[q.id];
      latest.set(normQuestionKey(q), { q, missed: isSkipped(ans) || !isCorrect(q, ans), area, order: order++ });
    });
  });
  const queues = targets.map(() => []);
  Array.from(latest.values()).filter(e => e.missed).sort((a, b) => b.order - a.order).forEach(e => queues[e.area].push(e.q));
  targets.forEach((a, i) => {
    if (a.typeSpecific && a.weakestType) queues[i].sort((x, y) => (y.type === a.weakestType.type) - (x.type === a.weakestType.type));
  });
  const out = [];
  for (let round = 0; out.length < WEAK_PRACTICE_MAX; round++) {
    let added = false;
    queues.forEach(queue => { if (queue[round] && out.length < WEAK_PRACTICE_MAX) { out.push(queue[round]); added = true; } });
    if (!added) break;
  }
  return out.map((q, i) => Object.assign({}, q, { id: 'wp_' + (i + 1) }));
}

/* ------------------------------------------------------------
   QUESTIONS TO REVISIT (A1 patch) - signed-in accounts
   Individual questions the student missed and has not got right since. Unlike
   weak areas this needs no minimum sample and does not depend on topic names:
   the server ranks questions by identity (convex/lib/revisit.ts) and the
   browser resolves the question text from the history it already holds.
   ------------------------------------------------------------ */
const REVISIT_MAX = 15;
let revisitCache = null;

function revisitPracticeQuestions(all, items) {
  const wanted = new Set((items || []).map(it => it.questionKey));
  if (!wanted.size) return [];
  const found = new Map();
  // newest first, so the freshest copy of a question is the one practised
  all.slice().sort((x, y) => new Date(y.completedAt) - new Date(x.completedAt)).forEach(record => {
    (record.questions || []).forEach(q => {
      const key = questionKeyClient(q);
      if (wanted.has(key) && !found.has(key)) found.set(key, q);
    });
  });
  const out = [];
  items.forEach(it => { if (found.has(it.questionKey) && out.length < REVISIT_MAX) out.push(found.get(it.questionKey)); });
  // fresh ids: the original ids (q_1, q_2...) repeat across quizzes and would collide
  return out.map((q, i) => Object.assign({}, q, { id: 'rv_' + (i + 1) }));
}

function revisitHtml(res, resolvable) {
  const head = '<b>Questions to revisit</b>';
  if (!res) return `<div class="practice-row"><div>${head}<p class="muted">Checking your recent answers\u2026</p></div></div>`;
  if (!res.ok) return `<div class="practice-row"><div>${head}<p class="muted">Couldn\u2019t check right now.</p></div><button class="btn ghost" id="revisitRetry">Try again</button></div>`;
  if (!res.total) {
    return `<div class="practice-row"><div>${head}<p class="muted">Nothing to revisit. Questions you miss will appear here until you get them right.</p></div></div>`;
  }
  const n = res.total;
  const repeated = res.repeated ? ` ${res.repeated} missed more than once.` : '';
  const partial = resolvable < Math.min(n, REVISIT_MAX) ? ' Some of them aren\u2019t on this device yet.' : '';
  return `<div class="practice-row"><div>${head}<p class="muted">${n} question${n === 1 ? '' : 's'} you missed and haven\u2019t got right since.${repeated}${partial}</p></div><button class="btn ${resolvable ? '' : 'ghost'}" id="practiceRevisit" ${resolvable ? '' : 'disabled'}>Revisit questions</button></div>`;
}

function weakAreasHtml(res, practiceCount) {
  if (!res) {
    return `<div class="practice-row"><div><b>Weak areas</b><p class="muted">Checking your recent answers\u2026</p></div></div>`;
  }
  if (!res.ok) {
    return `<div class="practice-row"><div><b>Weak areas</b><p class="muted">Couldn\u2019t check your weak areas right now.</p></div><button class="btn ghost" id="weakRetry">Try again</button></div>`;
  }
  const s = res.summary || {};
  if (!s.tracked) {
    return `<div class="practice-row"><div><b>Weak areas</b><p class="muted">Finish a quiz while signed in and your weak areas will show up here.</p></div></div>`;
  }
  if (!res.areas.length) {
    const msg = s.insufficient === s.tracked
      ? 'Not enough data yet. A few more quizzes and patterns will start to show.'
      : 'Nothing stands out as a weak area right now. Keep it up.';
    return `<div class="practice-row"><div><b>Weak areas</b><p class="muted">${msg}</p></div></div>`;
  }
  const shown = res.areas.slice(0, WEAK_LIST_MAX);
  const more = res.areas.length - shown.length;
  const canPractice = practiceCount > 0;
  const items = shown.map(a => {
    const key = (a.subjectKey || '') + '|' + (a.topicKey || '');
    // A2 frozen (TARGETED_PRACTICE_ENABLED === false): the targeted
    // generation button is hidden; code is kept, not deleted.
    const targetedBlock = TARGETED_PRACTICE_ENABLED
      ? `<div class="wa-targeted"><button type="button" class="btn secondary wa-targeted-btn" data-targeted="${esc(key)}">Generate targeted practice</button><p class="muted wa-targeted-sub">New questions from your saved material.</p></div><p class="muted wa-targeted-msg" hidden></p>`
      : '';
    return `<div class="wa-item" data-wa="${esc(key)}"><div class="wa-head"><b>${esc(a.topic)}${a.subject ? `<span class="muted"> · ${esc(a.subject)}</span>` : ''}</b><span class="wa-chip wa-${a.status}">${WEAK_STATUS_LABEL[a.status]}</span></div><p class="muted wa-reason">${esc(a.reason)}</p><div class="inline-actions" style="margin-top:8px"><a class="btn secondary" href="tutor.html?subject=${encodeURIComponent(a.subject || '')}&topic=${encodeURIComponent(a.topic || '')}"><i class="fa-solid fa-comments" aria-hidden="true"></i> Ask Tutor to explain</a></div>${targetedBlock}</div>`;
  }).join('');
  const hasWeak = res.areas.some(a => a.status === 'established' || a.status === 'emerging');
  const note = !hasWeak
    ? 'Nothing needs practice right now.'
    : canPractice
      ? practiceCount + ' question' + (practiceCount === 1 ? '' : 's') + ' from your own history, mixed across these areas.'
      : 'Practice sets use questions already on this device, and none are available here yet.';
  return `<div class="wa-block"><div class="wa-title"><b>Weak areas</b><p class="muted wa-sub">Topics where mistakes keep coming up.</p></div>${items}${more > 0 ? `<p class="muted wa-more">+${more} more being tracked</p>` : ''}<div class="wa-action"><p class="muted">${note}</p><button class="btn ${canPractice ? '' : 'ghost'}" id="practiceWeakAreas" ${canPractice ? '' : 'disabled'}>Practice weak areas</button></div></div>`;
}

function startCustomPractice(title, questions) {
  if (!questions.length) { toast('Nothing to practice yet.'); return; }
  const sess = {
    quizId: 'practice_' + Date.now(),
    title: title,
    subject: 'Practice',
    difficulty: 'mixed',
    mode: 'study',
    timeLimitMinutes: null,
    questionCount: questions.length,
    // Practice sets assemble questions from different quizzes, and
    // AI-generated quizzes reuse per-quiz ids ("q_1" …) — two different
    // questions can share an id while the engine keys answers, marks
    // and checks by id. Re-key so per-question state can never collide.
    questions: rekeyQuestionsForPractice(questions),
    answers: {},
    visited: {},
    marked: {},
    checked: {},
    index: 0,
    startedAt: Date.now(),
    status: 'in_progress',
    sourceMaterial: 'Practice set',
    retryOf: null
  };
  activeSession.set(sess);
  location.href = 'quiz.html';
}

// Pure helper (unit-tested): give each question a session-unique id.
// Option ids ("o0"…) are per-question scoped and untouched.
function rekeyQuestionsForPractice(questions) {
  const stamp = Date.now().toString(36);
  return questions.map((q, i) => {
    const copy = Object.assign({}, q);
    copy.id = 'pq_' + stamp + '_' + i + '_' + Math.floor(Math.random() * 1e6).toString(36);
    return copy;
  });
}

function paintWeakAreas() {
  const host = document.querySelector('#weakAreas');
  if (!host) return; // page changed while the request was in flight
  const all = store.get('sessions', []).filter(isValidRecord);
  const count = weakAreasCache && weakAreasCache.ok ? weakAreaPracticeQuestions(all, weakAreasCache.areas).length : 0;
  host.innerHTML = weakAreasHtml(weakAreasCache, count);
  const btn = document.querySelector('#practiceWeakAreas');
  if (btn) btn.onclick = () => {
    const fresh = store.get('sessions', []).filter(isValidRecord);
    startCustomPractice('Weak areas practice', weakAreaPracticeQuestions(fresh, weakAreasCache.areas));
  };
  const retry = document.querySelector('#weakRetry');
  if (retry) retry.onclick = () => { weakAreasCache = null; paintWeakAreas(); loadWeakAreas(); };
  // A2: one targeted-practice action per weak area. Per-area lock map
  // prevents duplicate generations from repeated clicks.
  document.querySelectorAll('.wa-targeted-btn').forEach(b => {
    b.onclick = () => startTargetedGeneration(b.dataset.targeted, b);
  });
}

// In-flight targeted generations, keyed by "subjectKey|topicKey".
const targetedLocks = {};

/* ============================================================
   A2 TARGETED PRACTICE (frontend)
   One weak area -> the backend finds relevant saved material,
   generates NEW questions grounded in it, and returns a normal
   quiz object (+ materialId, + practiceSource). From here the
   quiz enters the existing engine exactly like a created quiz:
   ready screen -> Start -> quiz -> results -> saveAttempt.
   ============================================================ */
function targetedAreaByKey(key) {
  if (!weakAreasCache || !weakAreasCache.ok || !key) return null;
  const [sKey, tKey] = String(key).split('|');
  return (weakAreasCache.areas || []).find(a => (a.subjectKey || '') === sKey && (a.topicKey || '') === tKey) || null;
}

function targetedMsgEl(btn) {
  const item = btn.closest('.wa-item');
  return item ? item.querySelector('.wa-targeted-msg') : null;
}

function showTargetedMsg(btn, text, isError) {
  const el = targetedMsgEl(btn);
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('wa-targeted-err', !!isError);
}

function startTargetedGeneration(key, btn) {
  const area = targetedAreaByKey(key);
  if (!area) { if (btn) showTargetedMsg(btn, 'Could not find that weak area. Please reload and try again.', true); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  showTargetedMsg(btn, '');
  runTargetedGeneration(key).then(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate targeted practice'; }
  }).catch(err => {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate targeted practice'; }
    const code = err && err.code;
    let msg;
    if (code === 'no_material') {
      msg = 'No saved material found for this weak area yet. ';
    } else if (code === 'no_weak_area') {
      msg = 'This topic doesn\u2019t look like a weak area right now. ';
    } else if (code === 'rate_limited') {
      msg = 'You\u2019ve hit today\u2019s generation limit. Please try again tomorrow. ';
    } else if (code === 'not_authenticated') {
      msg = 'Please sign in again to use targeted practice. ';
    } else if (code === 'not_configured') {
      msg = 'AI question generation isn\u2019t set up on this deployment yet (the AI key is missing). ';
    } else if (code === 'provider_error' || code === 'timeout') {
      msg = 'The AI service is overloaded right now. Please try again in a little while. ';
    } else {
      msg = 'Couldn\u2019t generate targeted practice right now. ';
    }
    if (btn) {
      const el = targetedMsgEl(btn);
      if (el) {
        el.hidden = false;
        el.classList.toggle('wa-targeted-err', true);
        el.innerHTML = '';
        el.appendChild(document.createTextNode(msg + 'You can still practice your past questions below. '));
        if (code === 'no_material') {
          const link = document.createElement('a');
          link.href = 'materials.html';
          link.textContent = 'Add study material';
          el.appendChild(link);
        }
      }
    } else {
      toast(msg.trim());
    }
  });
}

/**
 * Core A2 generation: per-area duplicate-click lock, one backend call,
 * then hand the quiz to the existing engine (ready screen -> Start).
 * Returns the promise so other UI (ready-screen regenerate) can reuse it.
 */
function runTargetedGeneration(key) {
  if (targetedLocks[key]) return Promise.reject({ code: 'duplicate' });
  const area = targetedAreaByKey(key);
  if (!area) return Promise.reject({ code: 'no_weak_area' });
  targetedLocks[key] = true;
  return withAgeEligibility(() => QuizGen.generateTargetedPractice({
    subjectKey: area.subjectKey || '',
    topicKey: area.topicKey || '',
    questionCount: 8,
    difficulty: 'medium',
    questionTypes: ['mcq', 'true_false', 'short_answer']
  })).then(quiz => {
    delete targetedLocks[key];
    // Hand to the existing engine: ready screen -> Start -> quiz.html,
    // exactly like a normal generated quiz. materialId/practiceSource
    // ride on the quiz object into the session and the saved attempt.
    draft.generatedQuiz = quiz;
    draft.targetedArea = key;
    renderReadyScreen();
    return quiz;
  }).catch(err => {
    delete targetedLocks[key];
    throw err;
  });
}

function paintRevisit() {
  const host = document.querySelector('#revisitRow');
  if (!host) return;
  const all = store.get('sessions', []).filter(isValidRecord);
  const count = revisitCache && revisitCache.ok ? revisitPracticeQuestions(all, revisitCache.items).length : 0;
  host.innerHTML = revisitHtml(revisitCache, count);
  const btn = document.querySelector('#practiceRevisit');
  if (btn) btn.onclick = () => {
    const fresh = store.get('sessions', []).filter(isValidRecord);
    startCustomPractice('Questions to revisit', revisitPracticeQuestions(fresh, revisitCache.items));
  };
  const retry = document.querySelector('#revisitRetry');
  if (retry) retry.onclick = () => { revisitCache = null; paintRevisit(); loadRevisit(); };
}

function loadRevisit() {
  Convex.query('revisit:getQuestionsToRevisit', { sessionToken: Auth.getToken() }).then(res => {
    revisitCache = res.ok && res.data && res.data.ok ? Object.assign({ ok: true }, res.data) : { ok: false };
    paintRevisit();
  }).catch(() => { revisitCache = { ok: false }; paintRevisit(); });
}

function loadWeakAreas() {
  Convex.query('weakAreas:getWeakAreas', { sessionToken: Auth.getToken() }).then(res => {
    // A server-side "not signed in" (expired session) is shown like any other failure.
    weakAreasCache = res.ok && res.data && res.data.ok ? Object.assign({ ok: true }, res.data) : { ok: false };
    paintWeakAreas();
  }).catch(() => { weakAreasCache = { ok: false }; paintWeakAreas(); });
}

function progress() {
  const all = store.get('sessions', []).filter(isValidRecord);
  const avg = all.length ? Math.round(all.reduce((x, s) => x + s.score, 0) / all.length) : 0;
  const recent7 = all.slice(-7).map(s => s.score);
  const bars = recent7.concat(Array(Math.max(0, 7 - recent7.length)).fill(0)).slice(-7);

  const topicAgg = {};
  all.forEach(s => {
    const completedAt = s.completedAt ? new Date(s.completedAt).getTime() : 0;
    Object.entries(s.topicPerformance || {}).forEach(([topic, v]) => {
      topicAgg[topic] = topicAgg[topic] || { correct: 0, total: 0, lastPracticedAt: 0 };
      topicAgg[topic].correct += v.correct;
      topicAgg[topic].total += v.total;
      if (completedAt > topicAgg[topic].lastPracticedAt) topicAgg[topic].lastPracticedAt = completedAt;
    });
  });
  // Most-recently-practiced first (not insertion order, which would just
  // be "whichever topic was ever seen first") and capped to a preview so
  // this panel doesn't keep growing forever as quiz history accumulates -
  // the rest is one click away, not gone.
  const topicEntries = Object.entries(topicAgg);
  const topicGroups = groupTopics(topicEntries, topicCategoryMap(all));
  const TOPIC_PREVIEW_COUNT = 4;
  const visibleGroups = topicGroups.slice(0, TOPIC_PREVIEW_COUNT);
  const hiddenGroups = topicGroups.slice(TOPIC_PREVIEW_COUNT);
  const topicHtml = topicGroups.length
    ? visibleGroups.map(g => renderTopicGroup(g, false)).join('')
      + (hiddenGroups.length ? `<div id="hiddenTopics" style="display:none">${hiddenGroups.map(g => renderTopicGroup(g, false)).join('')}</div><button id="seeMoreTopics" class="btn ghost" style="margin-top:14px;width:100%">See ${hiddenGroups.length} more subject${hiddenGroups.length === 1 ? '' : 's'}</button>` : '')
    : `<p class="muted">Complete a quiz to see topic-level performance here.</p>`;

  const signedIn = typeof Auth !== 'undefined' && Auth.isLoggedIn();
  // Guests keep the original local row exactly as before; signed-in accounts
  // use the server's weak-area calculation instead (never both).
  const weakQuestions = signedIn ? [] : weakTopicPracticeQuestions(all, topicAgg);
  const starred = getStarred();
  const revisitRowHtml = signedIn
    ? `<div id="revisitRow">${revisitHtml(revisitCache, revisitCache && revisitCache.ok ? revisitPracticeQuestions(all, revisitCache.items).length : 0)}</div>`
    : '';
  const weakRowHtml = signedIn
    ? `<div id="weakAreas">${weakAreasHtml(weakAreasCache, weakAreasCache && weakAreasCache.ok ? weakAreaPracticeQuestions(all, weakAreasCache.areas).length : 0)}</div>`
    : `<div class="practice-row"><div><b>Weak topics</b><p class="muted">${weakQuestions.length ? weakQuestions.length + ' question' + (weakQuestions.length === 1 ? '' : 's') + ' from topics under 70% accuracy.' : 'Not enough history yet to spot a weak topic.'}</p></div><button class="btn ${weakQuestions.length ? '' : 'ghost'}" id="practiceWeak" ${weakQuestions.length ? '' : 'disabled'}>Practice weak topics</button></div>`;

  const practicePanel = `<section class="panel" style="margin-top:18px"><h2>Focused practice</h2><p class="sub">Built from your own past questions, not new AI-generated ones.</p>${weakRowHtml}${revisitRowHtml}<div class="practice-row"><div><b>Starred questions</b><p class="muted">${starred.length ? starred.length + ' question' + (starred.length === 1 ? '' : 's') + ' you starred from Review.' : 'Star questions from Review to build a custom set.'}</p></div><button class="btn ${starred.length ? 'secondary' : 'ghost'}" id="practiceStarred" ${starred.length ? '' : 'disabled'}>Practice starred</button></div></section>`;

  document.querySelector('main').innerHTML = `<section class="page-title"><div><div class="eyebrow">Your learning signal</div><h1>Progress, not pressure.</h1><p>Spot your patterns, keep your streak going, and decide what to practise next.</p></div></section><section class="grid metric-grid"><article class="panel metric"><p class="sub">SESSIONS</p><b>${all.length}</b></article><article class="panel metric"><p class="sub">AVERAGE SCORE</p><b>${avg}%</b></article><article class="panel metric"><p class="sub">CURRENT STREAK</p><b>${computeStreak(all)} days</b></article></section><section class="grid dashboard" style="margin-top:18px"><article class="panel"><h2>Accuracy over time</h2><p class="sub">Your last seven sessions</p><div class="chart">${bars.map((h, i) => `<div class="bar" style="height:${h}%"><span>${i + 1}</span></div>`).join('')}</div></article><article class="panel"><h2>Topic performance</h2><p class="sub">Aggregated across all completed quizzes</p>${topicHtml}</article></section>${practicePanel}<section class="panel" style="margin-top:18px"><h2>Suggested next move</h2><p class="sub">Based on your recent sessions</p><div class="streak">${avg >= 70 ? 'Try Exam mode' : 'Review then retry'}</div><p class="muted">${all.length ? 'A short focused set is the fastest way to reinforce recall.' : 'Finish one quiz and this page will show your accuracy over time, your strongest and weakest topics, and your streak.'}</p><a class="btn" href="create.html">Create a quiz →</a></section>`;

  const practiceWeakBtn = document.querySelector('#practiceWeak');
  if (practiceWeakBtn) practiceWeakBtn.onclick = () => startCustomPractice('Weak topics practice', weakQuestions);
  if (signedIn) { loadWeakAreas(); loadRevisit(); }
  const practiceStarredBtn = document.querySelector('#practiceStarred');
  if (practiceStarredBtn) practiceStarredBtn.onclick = () => startCustomPractice('Starred questions practice', starred.map(s => s.question));
  const seeMoreTopicsBtn = document.querySelector('#seeMoreTopics');
  if (seeMoreTopicsBtn) seeMoreTopicsBtn.onclick = () => { document.querySelector('#hiddenTopics').style.display = 'block'; seeMoreTopicsBtn.remove(); };
  syncRemoteSessions(progress);
}

/* ============================================================
   SETTINGS
   ============================================================ */
function renderAccountPanel() {
  const panel = document.querySelector('#accountPanel');
  if (!panel) return;
  Auth.getCurrentUser().then(res => {
    const loggedIn = res.ok && res.data;
    if (loggedIn) {
      const user = res.data;
      const avatarHtml = user.avatarUrl
        ? `<img src="${esc(user.avatarUrl)}" alt="" class="dash-avatar" style="width:56px;height:56px">`
        : `<div class="avatar-picker" style="width:56px;height:56px;font-size:20px;border-style:solid">${esc((user.name || user.email || '?')[0].toUpperCase())}</div>`;
      panel.innerHTML = `<h2>Account</h2><div style="display:flex;align-items:center;gap:14px;margin-top:10px"><div id="settingsAvatarPreview">${avatarHtml}</div><div><b>${esc(user.name || 'Studypath user')}</b><p class="sub" style="margin:2px 0 0">${esc(user.email)}</p></div></div><div class="inline-actions" style="margin-top:12px"><button id="changePhotoBtn" class="btn secondary">Change photo</button><input type="file" id="settingsAvatarInput" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none"></div><label class="field" style="margin-top:16px">Display name<input type="text" id="settingsNameInput" value="${esc(user.name || '')}" maxlength="60"></label><div id="nameStatus"></div><div class="inline-actions" style="margin-top:14px"><button id="saveNameBtn" class="btn ghost">Save name</button><button id="signOutBtn" class="btn ghost">Sign out</button></div><div class="danger-zone"><h3>Delete account</h3><p class="sub">Permanently deletes your account, profile photo and saved quiz history from our servers. This cannot be undone.</p><button id="deleteAccountBtn" class="btn ghost danger">Delete account\u2026</button><div id="deleteConfirm" hidden><label class="field">Enter your password to confirm (if you signed in with Google and never set a Studypath password, leave this blank)<input type="password" id="deletePassword" autocomplete="current-password"></label><div id="deleteStatus" role="alert"></div><div class="inline-actions"><button id="deleteConfirmBtn" class="btn coral">Delete permanently</button><button id="deleteCancelBtn" class="btn ghost">Cancel</button></div></div></div>`;

      document.querySelector('#deleteAccountBtn').onclick = () => {
        document.querySelector('#deleteConfirm').hidden = false;
        document.querySelector('#deleteAccountBtn').hidden = true;
        document.querySelector('#deletePassword').focus();
      };
      document.querySelector('#deleteCancelBtn').onclick = () => {
        document.querySelector('#deleteConfirm').hidden = true;
        document.querySelector('#deleteAccountBtn').hidden = false;
        document.querySelector('#deletePassword').value = '';
        document.querySelector('#deleteStatus').textContent = '';
      };
      document.querySelector('#deleteConfirmBtn').onclick = () => {
        const pw = document.querySelector('#deletePassword').value;
        const status = document.querySelector('#deleteStatus');
        const btn = document.querySelector('#deleteConfirmBtn');
        btn.disabled = true; status.textContent = 'Deleting\u2026';
        Auth.deleteAccount(pw).then(res => {
          if (res.ok) {
            // The account is gone server-side; also drop what this device
            // holds for it so nothing of the deleted account lingers here.
            store.remove('sessions'); store.remove('last'); store.remove('starred');
            activeSession.clear();
            try { Material.reset(); } catch (e) {}
            try { localStorage.removeItem('studypath:anonId'); } catch (e) {}
            toast('Your account has been deleted');
            settings();
          } else {
            btn.disabled = false;
            status.textContent = (res.error && res.error.message) || 'We couldn\u2019t delete your account. Please check your connection and try again.';
          }
        });
      };

      document.querySelector('#signOutBtn').onclick = () => {
        Auth.signOut().then(() => { toast('Signed out'); settings(); });
      };

      document.querySelector('#changePhotoBtn').onclick = () => document.querySelector('#settingsAvatarInput').click();
      document.querySelector('#settingsAvatarInput').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        toast('Uploading photo\u2026');
        Auth.uploadAvatar(file).then(uploadRes => {
          if (uploadRes.ok) { toast('Photo updated'); renderAccountPanel(); }
          else toast(uploadRes.error.message);
        });
      };

      document.querySelector('#saveNameBtn').onclick = () => {
        const nameStatus = document.querySelector('#nameStatus');
        const newName = document.querySelector('#settingsNameInput').value.trim();
        nameStatus.innerHTML = '';
        Auth.updateName(newName).then(nameRes => {
          if (nameRes.ok) { toast('Name updated'); renderAccountPanel(); }
          else nameStatus.innerHTML = `<div class="status-msg error" style="margin-top:8px">${esc(nameRes.error.message)}</div>`;
        });
      };
    } else {
      panel.innerHTML = `<h2>Account</h2><p class="sub">You're using Studypath as a guest. History stays on this device only. Create an account to keep it if you switch browsers or devices.</p><div class="inline-actions" style="margin-top:12px"><a href="signup.html" class="btn secondary">Create account</a><a href="signin.html" class="btn ghost">Sign in</a></div>`;
    }
  });
}

/* ============================================================
   AI TUTOR (B1) — material-grounded study conversations
   ============================================================ */

let tutorUI = null;

function tutor() {
  tutorUI = {
    mode: 'chat', // chat | history | picker
    conversationId: null,
    materialId: null,
    materialTitle: '',
    messages: [],
    history: [],
    pickerMaterials: [],
    pickerSubject: '',
    pickerTopic: '',
    sending: false,   // duplicate-send guard: one in-flight request at a time
    failedText: null, // last user text that failed, for Retry
    error: '',
    errorCode: '',
    loading: true,
  };
  renderTutor();
  if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) {
    tutorUI.loading = false;
    tutorUI.error = 'signin';
    renderTutor();
    return;
  }
  const params = new URLSearchParams(location.search);
  const conversationId = params.get('c');
  const materialId = params.get('materialId');
  const ask = params.get('ask');
  const subject = params.get('subject');
  const topic = params.get('topic');
  if (conversationId) loadTutorConversation(conversationId);
  else if (materialId) startTutorConversation(materialId, ask);
  else if (subject || topic) tutorMaterialPicker(subject || '', topic || '');
  else tutorHistoryList();
}

function startTutorConversation(materialId, ask) {
  withAgeEligibility(() => Convex.action('tutor:startConversation', {
    sessionToken: Auth.getToken(),
    materialId: materialId,
    initialMessage: ask || undefined,
  })).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    if (res.ok) {
      tutorUI.conversationId = res.data.conversationId;
      tutorUI.materialId = materialId;
      tutorUI.materialTitle = res.data.materialTitle;
      tutorUI.messages = [];
      // B1D: pin the conversation id into the URL so a refresh resumes
      // this conversation instead of starting a new one.
      try { window.history.replaceState(null, '', 'tutor.html?c=' + encodeURIComponent(res.data.conversationId)); } catch (e) {}
      if (ask && res.data.firstAnswer) {
        tutorUI.messages.push({ role: 'user', text: ask });
        tutorUI.messages.push({ role: 'tutor', text: res.data.firstAnswer, grounded: res.data.firstGrounded });
      }
    } else {
      tutorUI.errorCode = (res.error && res.error.code) || '';
      tutorUI.error = (res.error && res.error.message) || "Couldn't start the tutor. Please try again.";
    }
    renderTutor();
    focusTutorInput();
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    tutorUI.error = 'Could not reach the tutor. Check your connection and try again.';
    renderTutor();
  });
}

function loadTutorConversation(conversationId) {
  Convex.action('tutor:getConversation', {
    sessionToken: Auth.getToken(),
    conversationId: conversationId,
  }).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    if (res.ok) {
      tutorUI.conversationId = conversationId;
      tutorUI.materialId = res.data.conversation.materialId;
      tutorUI.materialTitle = res.data.materialTitle;
      tutorUI.messages = res.data.messages;
    } else {
      tutorUI.errorCode = (res.error && res.error.code) || '';
      tutorUI.error = (res.error && res.error.message) || "Couldn't load that conversation.";
    }
    renderTutor();
    scrollTutorToEnd();
    focusTutorInput();
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    tutorUI.error = 'Could not reach the tutor. Check your connection and try again.';
    renderTutor();
  });
}

// B1D: relative time for the conversation history list.
function tutorTimeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

// B1D: tutor home — list the user's recent conversations.
function tutorHistoryList() {
  tutorUI.mode = 'history';
  tutorUI.loading = true;
  renderTutor();
  Convex.action('tutor:listConversations', { sessionToken: Auth.getToken() }).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    if (res.ok) tutorUI.history = res.data.conversations || [];
    else {
      tutorUI.errorCode = (res.error && res.error.code) || '';
      tutorUI.error = (res.error && res.error.message) || "Couldn't load your conversations.";
    }
    renderTutor();
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    tutorUI.error = 'Could not reach the tutor. Check your connection and try again.';
    renderTutor();
  });
}

// B1D: delete one conversation (ownership enforced server-side).
function deleteTutorConversation(conversationId) {
  if (!confirm('Delete this conversation? This cannot be undone.')) return;
  Convex.action('tutor:deleteConversation', {
    sessionToken: Auth.getToken(),
    conversationId: conversationId,
  }).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    if (res.ok) {
      tutorUI.history = (tutorUI.history || []).filter(c => String(c.id) !== String(conversationId));
      toast('Conversation deleted.');
    } else {
      toast((res.error && res.error.message) || "Couldn't delete that conversation.");
    }
    renderTutor();
  });
}

// B1D: weak-area entry — pick which saved material explains this topic.
function tutorMaterialPicker(subject, topic) {
  tutorUI.mode = 'picker';
  tutorUI.pickerSubject = subject;
  tutorUI.pickerTopic = topic;
  tutorUI.loading = true;
  renderTutor();
  Convex.query('materials:listMaterials', { sessionToken: Auth.getToken() }).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    if (res.ok) tutorUI.pickerMaterials = res.data.materials || [];
    else tutorUI.error = (res.error && res.error.message) || "Couldn't load your materials.";
    renderTutor();
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.loading = false;
    tutorUI.error = 'Could not reach your library. Check your connection and try again.';
    renderTutor();
  });
}

// B1D: from the picker, start a conversation that opens with "explain this topic".
function tutorPickMaterial(materialId, title) {
  const topic = tutorUI.pickerTopic || '';
  const subject = tutorUI.pickerSubject || '';
  const ask = 'Explain ' + (topic || 'this topic') + (subject ? ' (' + subject + ')' : '') + ' in a way that helps me understand it.';
  tutorUI.mode = 'chat';
  tutorUI.loading = true;
  renderTutor();
  startTutorConversation(materialId, ask);
}

// Escape, then paragraphs on blank lines and <br> on single newlines.
// No markdown parser: the tutor contract is plain text.
function tutorTextHtml(text) {
  return esc(text).split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function tutorMessageHtml(m) {
  const who = m.role === 'user' ? 'user' : 'tutor';
  const honest = m.role === 'tutor' && m.grounded === false ? ' tutor-honest' : '';
  const pending = m.pending ? ' <span class="muted">· sending…</span>' : '';
  return `<div class="tutor-msg ${who}"><div class="tutor-bubble${honest}">${tutorTextHtml(m.text)}${pending}</div></div>`;
}

function renderTutor() {
  const main = document.querySelector('main');
  if (!tutorUI) return;
  if (tutorUI.error === 'signin') {
    main.innerHTML = `<section class="page-title"><div><div class="eyebrow">AI Tutor</div><h1>Study tutor</h1><p>Ask questions about your saved study material.</p></div></section><article class="panel"><h2>Sign in to meet your tutor</h2><p class="sub">The tutor works from your saved materials, which live on your account. Sign in (or create one) and open any material to start asking questions.</p><div class="hero-cta" style="margin-top:16px"><a class="btn" href="signin.html">Sign in</a><a class="btn ghost" href="signup.html">Create account</a></div></article>`;
    return;
  }
  const head = `<section class="page-title"><div><div class="eyebrow">AI Tutor</div><h1>Study tutor</h1><p>Explanations grounded in your material.</p></div><a class="btn ghost" href="materials.html">My materials</a></section>`;
  if (tutorUI.loading) {
    main.innerHTML = `${head}<div class="tutor-wrap"><article class="panel"><div class="status-msg info">Starting your tutor…</div></article></div>`;
    return;
  }
  if (tutorUI.error && !tutorUI.conversationId) {
    const signinCta = tutorUI.errorCode === 'not_authenticated'
      ? `<div class="hero-cta" style="margin-top:14px"><a class="btn" href="signin.html">Sign in</a></div>` : '';
    main.innerHTML = `${head}<div class="tutor-wrap"><article class="panel"><div class="status-msg error">${esc(tutorUI.error)}</div>${signinCta}<div class="inline-actions" style="margin-top:14px"><a class="btn secondary" href="materials.html">Back to materials</a></div></article></div>`;
    return;
  }
  // B1D: conversation history (tutor home).
  if (tutorUI.mode === 'history' && !tutorUI.loading && !tutorUI.error) {
    const items = (tutorUI.history || []).map(c => {
      const n = c.messageCount || 0;
      return `<div class="list-item tutor-hist-item"><a class="tutor-hist-link" href="tutor.html?c=${encodeURIComponent(c.id)}"><i class="fa-solid fa-comments" aria-hidden="true"></i><div class="subject">${esc(c.title)}<div class="muted">${n} message${n === 1 ? '' : 's'} · ${tutorTimeAgo(c.updatedAt)}</div></div></a><button class="icon-btn tutor-hist-del" data-del="${esc(c.id)}" aria-label="Delete conversation about ${esc(c.title)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></div>`;
    }).join('');
    main.innerHTML = `${head}<div class="tutor-wrap"><article class="panel"><div class="row"><div><h2>Recent conversations</h2><p class="sub">Pick up where you left off.</p></div><a class="btn secondary" href="materials.html">New conversation</a></div><div class="list" style="margin-top:14px">${items || `<div class="list-item"><span class="muted">No conversations yet. Open a saved material and ask the tutor anything.</span></div>`}</div></article></div>`;
    document.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => deleteTutorConversation(btn.dataset.del);
    });
    return;
  }
  // B1D: weak-area entry — choose the material that should explain the topic.
  if (tutorUI.mode === 'picker' && !tutorUI.loading && !tutorUI.error) {
    const mats = tutorUI.pickerMaterials || [];
    const subj = (tutorUI.pickerSubject || '').toLowerCase();
    const sorted = mats.slice().sort((a, b) => {
      const am = subj && String(a.subject || '').toLowerCase() === subj ? 0 : 1;
      const bm = subj && String(b.subject || '').toLowerCase() === subj ? 0 : 1;
      return am - bm;
    });
    const rows = sorted.map(m => `<div class="list-item"><button class="tutor-pick" data-pick="${esc(m.id)}" data-title="${esc(m.title)}"><i class="fa-solid fa-book-open" aria-hidden="true"></i><div class="subject">${esc(m.title)}${m.subject ? `<div class="muted">${esc(m.subject)}</div>` : ''}</div><span aria-hidden="true">→</span></button></div>`).join('');
    const label = tutorUI.pickerTopic ? `“${esc(tutorUI.pickerTopic)}”${tutorUI.pickerSubject ? ` · ${esc(tutorUI.pickerSubject)}` : ''}` : 'this topic';
    main.innerHTML = `${head}<div class="tutor-wrap"><article class="panel"><h2>Which material should explain ${label}?</h2><p class="sub">The tutor answers from the material you pick.</p><div class="list" style="margin-top:14px">${rows || `<div class="list-item"><span class="muted">No saved materials yet. Save one from Create first.</span></div>`}</div><div class="inline-actions" style="margin-top:14px"><a class="btn ghost" href="tutor.html">Back</a></div></article></div>`;
    document.querySelectorAll('[data-pick]').forEach(btn => {
      btn.onclick = () => tutorPickMaterial(btn.dataset.pick, btn.dataset.title);
    });
    return;
  }
  const sourceBar = `<div class="tutor-source" role="note"><i class="fa-solid fa-book-open" aria-hidden="true"></i><div><b>Tutoring from: ${esc(tutorUI.materialTitle || 'your material')}</b><div class="muted">Answers come from this material first. The tutor says so when it doesn't cover something.${tutorDisclosureSuffix()}</div></div></div>`;
  const log = tutorUI.messages.length
    ? `<div class="tutor-log" id="tutorLog" role="log" aria-live="polite" aria-label="Conversation">${tutorUI.messages.map(tutorMessageHtml).join('')}${tutorUI.sending ? `<div class="tutor-msg tutor"><div class="tutor-bubble"><span class="tutor-typing" aria-label="Tutor is thinking"><i></i><i></i><i></i></span></div></div>` : ''}</div>`
    : `<div class="tutor-empty"><div class="tutor-big" aria-hidden="true"><i class="fa-solid fa-comments"></i></div><p><b>Ask me anything about “${esc(tutorUI.materialTitle || 'your material')}”.</b></p><p class="sub">I'll explain using your material, and tell you honestly when it doesn't cover something.</p></div>`;
  const errBar = tutorUI.error
    ? `<div class="status-msg error" role="alert">${esc(tutorUI.error)}${tutorUI.failedText ? ` <button class="btn secondary" id="tutorRetry" style="margin-left:8px">Retry</button>` : ''}</div>`
    : '';
  main.innerHTML = `${head}<div class="tutor-wrap">${sourceBar}${log}${errBar}
    <div class="tutor-inputbar">
      <label class="sr-only" for="tutorInput">Ask the tutor</label>
      <textarea id="tutorInput" rows="1" maxlength="2000" placeholder="Ask about ${esc(tutorUI.materialTitle || 'your material')}…" aria-label="Ask the tutor a question"></textarea>
      <button class="btn" id="tutorSend" ${tutorUI.sending ? 'disabled' : ''}>Send</button>
    </div></div>`;
  const input = document.querySelector('#tutorInput');
  const sendBtn = document.querySelector('#tutorSend');
  if (sendBtn) sendBtn.onclick = () => sendTutorMessage();
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTutorMessage(); }
    };
    // Auto-grow up to the CSS max-height.
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
  }
  const retry = document.querySelector('#tutorRetry');
  if (retry) retry.onclick = () => retryTutorSend();
}

function scrollTutorToEnd() {
  const log = document.querySelector('#tutorLog');
  if (log) log.scrollTop = log.scrollHeight;
  else window.scrollTo(0, document.body.scrollHeight);
}

function focusTutorInput() {
  const input = document.querySelector('#tutorInput');
  if (input && !('ontouchstart' in window)) input.focus();
}

function sendTutorMessage(retryText) {
  if (!tutorUI || tutorUI.sending) return; // duplicate-send guard
  const input = document.querySelector('#tutorInput');
  const text = String(retryText || (input ? input.value : '') || '').trim();
  if (!text || !tutorUI.conversationId) return;
  tutorUI.sending = true;
  tutorUI.error = '';
  tutorUI.errorCode = '';
  tutorUI.failedText = null;
  if (!retryText) {
    tutorUI.messages.push({ role: 'user', text: text, pending: true });
    if (input) input.value = '';
  } else {
    // Retry reuses the existing user bubble; mark it pending again.
    const last = [...tutorUI.messages].reverse().find(m => m.role === 'user');
    if (last) last.pending = true;
  }
  renderTutor();
  scrollTutorToEnd();
  withAgeEligibility(() => Convex.action('tutor:sendMessage', {
    sessionToken: Auth.getToken(),
    conversationId: tutorUI.conversationId,
    message: text,
  })).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.sending = false;
    const pending = [...tutorUI.messages].reverse().find(m => m.pending);
    if (pending) delete pending.pending;
    if (res.ok) {
      tutorUI.messages.push({ role: 'tutor', text: res.data.answer, grounded: res.data.groundedInMaterial });
    } else {
      tutorUI.errorCode = (res.error && res.error.code) || '';
      tutorUI.error = (res.error && res.error.message) || "The tutor couldn't answer right now. Please try again.";
      tutorUI.failedText = text;
    }
    renderTutor();
    scrollTutorToEnd();
    focusTutorInput();
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.sending = false;
    const pending = [...tutorUI.messages].reverse().find(m => m.pending);
    if (pending) delete pending.pending;
    tutorUI.error = 'Could not reach the tutor. Check your connection and try again.';
    tutorUI.failedText = text;
    renderTutor();
    scrollTutorToEnd();
  });
}

function retryTutorSend() {
  if (!tutorUI || !tutorUI.failedText || tutorUI.sending) return;
  const text = tutorUI.failedText;
  // The failure may have happened after the server saved everything (a
  // lost response). Reload first: if the answer is already there, adopt
  // it instead of sending a duplicate.
  Convex.action('tutor:getConversation', {
    sessionToken: Auth.getToken(),
    conversationId: tutorUI.conversationId,
  }).then(res => {
    if (document.body.dataset.page !== 'tutor') return;
    if (res.ok && res.data.messages.length > tutorUI.messages.length) {
      tutorUI.messages = res.data.messages;
      tutorUI.error = '';
      tutorUI.errorCode = '';
      tutorUI.failedText = null;
      renderTutor();
      scrollTutorToEnd();
      return;
    }
    tutorUI.error = '';
    tutorUI.errorCode = '';
    tutorUI.failedText = null;
    sendTutorMessage(text);
  }).catch(() => {
    if (document.body.dataset.page !== 'tutor') return;
    tutorUI.error = '';
    tutorUI.errorCode = '';
    tutorUI.failedText = null;
    sendTutorMessage(text);
  });
}

// B1: honesty notice for the Tutor page. Questions and material excerpts
// are sent to Google's AI, so the free-plan disclosure applies here too.
// Plain muted suffix: wraps, theme-aware, no popup.
function tutorDisclosureSuffix() {
  if (typeof geminiFreePlan === 'function' && geminiFreePlan()) {
    return ' Your questions and material excerpts are sent to Google\u2019s AI. On our current free plan, Google may use them to improve its products.';
  }
  return '';
}


/* Final notification system (2026-10-27): notifications are a default
   part of the app, not a Settings option. New users are asked once, at
   signup, the way other apps ask for permissions: Allow subscribes them
   silently, Not now leaves the native permission untouched and Settings
   will show a turn-on option instead. Existing users who never decided
   get the same prompt once, on the dashboard. Once notifications are
   allowed, no push option is shown in Settings at all. */
function accountHash() {
  // A short, non-reversible fingerprint of the current session token, so
  // per-account flags never leak across accounts on a shared browser.
  // The token itself is never written into another key.
  try {
    const t = (typeof Auth !== 'undefined' && Auth.getToken()) || '';
    if (!t) return 'guest';
    let h = 0;
    for (let i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
    return 'acc' + (h >>> 0).toString(36);
  } catch (e) { return 'guest'; }
}
let currentAccountId = null;
async function resolveAccountId() {
  if (currentAccountId) return currentAccountId;
  try {
    if (typeof Auth !== 'undefined' && Auth.isLoggedIn()) {
      const res = await Auth.getCurrentUser();
      if (res && res.ok && res.data && res.data.id) currentAccountId = String(res.data.id);
    }
  } catch (e) {}
  if (!currentAccountId) currentAccountId = accountHash();
  return currentAccountId;
}
function notificationPromptNeeded(accountId) {
  try {
    if (!('Notification' in window)) return false;
    if (Notification.permission !== 'default') return false;
    if (store.get('notificationPromptShown:' + (accountId || accountHash()), false)) return false;
    return true;
  } catch (e) { return false; }
}
async function syncAccountReminderPrefs() {
  // BUG FIX (2026-10-28): reminder time lived in device-wide localStorage,
  // so a new account on the same browser inherited the previous account's
  // time, and Settings then synced that wrong time to the new account's
  // server row. Now, the first time a new account is seen on this device,
  // its prefs come from its own server row, or the 19:00 default if it has
  // no row yet. The same account keeps its own local changes afterwards.
  try {
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) return;
    const hash = await resolveAccountId();
    if (store.get('reminderAccount', '') === hash) return;
    store.set('reminderAccount', hash);
    const res = await Auth.getMySubscription();
    if (res && res.ok && res.data && res.data.hasSubscription) {
      store.set('reminderTime', res.data.reminderTime || '19:00');
      store.set('sessionReminders', res.data.remindersOn !== false);
    } else {
      store.set('reminderTime', '19:00');
      store.set('sessionReminders', true);
    }
    const inp = document.querySelector('#reminderTimeInput');
    if (inp) inp.value = store.get('reminderTime', '19:00');
    const tog = document.querySelector('#reminderToggle');
    if (tog) tog.classList.toggle('on', store.get('sessionReminders', true));
  } catch (e) {}
}
async function ensureAccountNotifications(onDone) {
  // Runs after every sign-in, including Google. Two cases the old code missed:
  // (1) permission already granted on this browser: no native prompt can
  //     appear (permission is per-browser, not per-account), so subscribe
  //     this account silently instead of leaving it with no server row;
  // (2) permission still undecided for this account: ask once, per account.
  const done = () => { if (onDone) onDone(); };
  try {
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) { done(); return; }
    const accountId = await resolveAccountId();
    await syncAccountReminderPrefs();
    if (!('Notification' in window)) { done(); return; }
    if (Notification.permission === 'granted') {
      await subscribePush();
      done(); return;
    }
    if (Notification.permission === 'default' && notificationPromptNeeded(accountId)) {
      showNotificationPrompt(done, accountId); return;
    }
    done();
  } catch (e) { done(); }
}
async function subscribePush() {
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return false;
    if (Notification.permission === 'denied') {
      toast('Notifications are blocked for Studypath in your browser settings. Allow them there, then try again.');
      return false;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const vapid = window.STUDYPATH_SITE && window.STUDYPATH_SITE.vapidPublicKey;
    if (!vapid) { toast('Push is not set up yet.'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(vapid.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    const res = await Auth.savePushSubscription({ endpoint: json.endpoint, keys: json.keys });
    return !!(res && res.ok);
  } catch (e) { return false; }
}
function showNotificationPrompt(onDone, accountId) {
  if (document.querySelector('#notificationOverlay')) { if (onDone) onDone(); return; }
  store.set('notificationPromptShown:' + (accountId || accountHash()), true);
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay" id="notificationOverlay"><article class="panel modal-card"><h2>Stay on track with Studypath</h2><p class="sub">Allow notifications so Studypath can remind you at your study time and nudge you through the day, even when the app is closed.</p><div class="inline-actions"><button class="btn" id="notificationAllowBtn">Allow notifications</button><button class="btn ghost" id="notificationLaterBtn">Not now</button></div></article></div>`);
  document.querySelector('#notificationAllowBtn').onclick = async () => {
    const btn = document.querySelector('#notificationAllowBtn');
    btn.disabled = true; btn.textContent = 'Enabling…';
    await subscribePush();
    document.querySelector('#notificationOverlay').remove();
    if (onDone) onDone();
  };
  document.querySelector('#notificationLaterBtn').onclick = () => {
    document.querySelector('#notificationOverlay').remove();
    if (onDone) onDone();
  };
}
function goToDashboardWithPrompt() {
  ensureAccountNotifications(() => { location.href = 'dashboard.html'; });
}

function settings() {
  const dark = store.get('theme', 'light') === 'dark';
  const remindersOn = store.get('sessionReminders', true);
  const motionOn = store.get('reducedMotion', false);
  document.querySelector('main').innerHTML = `<section class="page-title"><div><div class="eyebrow">Make it yours</div><h1>Settings</h1><p>A quieter, more comfortable study space.</p></div></section><article class="panel" id="accountPanel"><h2>Account</h2><p class="sub">Checking\u2026</p></article><article class="panel" style="margin-top:18px"><div class="setting"><div><h2>Dark appearance</h2><p class="sub">Use a low-light canvas for evening study.</p></div><button class="toggle ${dark ? 'on' : ''}" id="themeToggle"><i></i></button></div><div class="setting"><div><h2>Session reminders</h2><p class="sub">A gentle reminder to keep the habit going.</p></div><button class="toggle ${remindersOn ? 'on' : ''}" id="reminderToggle"><i></i></button></div><div class="setting"><div><h2>Daily reminder time</h2><p class="sub">When should Studypath remind you, once a day at most?</p></div><input type="time" id="reminderTimeInput" value="${esc(store.get('reminderTime', '19:00'))}" style="padding:8px;border-radius:8px;border:1px solid var(--line,#ddd)"></div><div class="setting" id="notificationSetting" hidden><div><h2>Notifications</h2><p class="sub" id="notificationSettingSub">Notifications are off on this device.</p></div><button class="btn ghost" id="notificationTurnOnBtn">Turn on notifications</button></div><div class="setting"><div><h2>Reduced motion</h2><p class="sub">Minimise interface transitions.</p></div><button class="toggle ${motionOn ? 'on' : ''}" id="motionToggle"><i></i></button></div></article><article class="panel" style="margin-top:18px"><h2>Your data</h2><p class="sub">Your quiz history and preferences are kept in this browser. Completed quizzes are also saved to our servers.See the <a href="privacy.html" style="color:var(--teal);font-weight:700">Privacy Policy</a> for details.</p><div class="inline-actions" style="margin-top:14px"><button id="exportData" class="btn secondary">Download my data</button><button id="importDataBtn" class="btn ghost">Restore from file</button><input type="file" id="importFileInput" accept="application/json" style="display:none"></div><div id="importPreview"></div><button id="clearData" class="btn ghost" style="margin-top:18px">Clear all local data</button></article><article class="panel" style="margin-top:18px"><h2>About &amp; legal</h2><p class="sub" style="margin-bottom:0"><a href="privacy.html" style="color:var(--teal);font-weight:700">Privacy Policy</a> \u00b7 <a href="terms.html" style="color:var(--teal);font-weight:700">Terms of Use</a> \u00b7 <a href="delete-account.html" style="color:var(--teal);font-weight:700">Delete account (web)</a></p><p class="sub" style="margin-top:12px">Studypath by Vortex</p><p class="sub" style="margin-top:6px">Studypath version ${window.STUDYPATH_SITE && window.STUDYPATH_SITE.version ? window.STUDYPATH_SITE.version : '1.0.0'}</p></article>`;

  renderAccountPanel();

  document.querySelector('#themeToggle').onclick = () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', n); theme(); settings(); };
  document.querySelector('#reminderToggle').onclick = () => { store.set('sessionReminders', !store.get('sessionReminders', true)); try { Auth.updatePushReminder(); } catch (e) {} settings(); };
  const timeInput = document.querySelector('#reminderTimeInput');
  if (timeInput) timeInput.onchange = () => { store.set('reminderTime', timeInput.value || '19:00'); try { Auth.updatePushReminder(); } catch (e) {} toast('Reminder time saved'); fireDailyReminder(); };
  // Final notification system: no push/test/browser buttons in Settings.
  // The Notifications row below is ONLY shown when notifications are off
  // on this device (no subscription, or browser permission denied). Once
  // notifications are allowed, the row is removed entirely, because
  // notifications are a default part of the app. Existing subscribers
  // still get their Settings time synced on opening Settings.
  try {
    const notifRow = document.querySelector('#notificationSetting');
    const notifSub = document.querySelector('#notificationSettingSub');
    const notifBtn = document.querySelector('#notificationTurnOnBtn');
    if (notifRow && notifBtn) {
      const showRow = (text) => { if (notifSub) notifSub.textContent = text; notifRow.hidden = false; };
      if (!('Notification' in window)) {
        showRow('Notifications are not supported in this browser.');
        notifBtn.disabled = true;
      } else if (Notification.permission === 'denied') {
        showRow('Notifications are blocked for Studypath in your browser settings. Allow them there, then tap below to try again.');
        notifBtn.onclick = async () => { await subscribePush(); settings(); };
      } else if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => {
          if (sub) {
            // Allowed: row stays hidden (option removed by design).
            // Load this account's own time from the server; never push
            // the device's leftover time into this account's row.
            try { syncAccountReminderPrefs(); } catch (e) {}
          } else {
            showRow('Notifications are off on this device. Turn them on to get study reminders.');
            notifBtn.onclick = async () => { if (await subscribePush()) settings(); };
          }
        }).catch(() => {
          showRow('Notifications are off on this device. Turn them on to get study reminders.');
          notifBtn.onclick = async () => { if (await subscribePush()) settings(); };
        });
      } else {
        showRow('Notifications are off on this device. Turn them on to get study reminders.');
        notifBtn.onclick = async () => { if (await subscribePush()) settings(); };
      }
    }
  } catch (e) {}
  document.querySelector('#motionToggle').onclick = () => { store.set('reducedMotion', !store.get('reducedMotion', false)); applyReducedMotion(); settings(); };

  document.querySelector('#exportData').onclick = () => {
    const payload = {
      app: 'studypath',
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: store.get('sessions', []),
      starred: store.get('starred', []),
      theme: store.get('theme', 'light')
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'studypath-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded');
  };

  const importInput = document.querySelector('#importFileInput');
  document.querySelector('#importDataBtn').onclick = () => importInput.click();
  importInput.onchange = () => {
    const file = importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const preview = document.querySelector('#importPreview');
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        preview.innerHTML = `<div class="status-msg error">That file isn\u2019t valid JSON.</div>`;
        return;
      }
      if (!data || data.app !== 'studypath' || !Array.isArray(data.sessions)) {
        preview.innerHTML = `<div class="status-msg error">This doesn\u2019t look like a Studypath backup file.</div>`;
        return;
      }
      preview.innerHTML = `<div class="status-msg warning">Found ${data.sessions.length} quiz session${data.sessions.length === 1 ? '' : 's'}${data.exportedAt ? ', exported ' + new Date(data.exportedAt).toLocaleDateString() : ''}. Restoring will replace your current local data. This can\u2019t be undone.</div><div class="inline-actions"><button id="confirmImport" class="btn">Replace my data</button><button id="cancelImport" class="btn ghost">Cancel</button></div>`;
      document.querySelector('#confirmImport').onclick = () => {
        store.set('sessions', data.sessions);
        if (Array.isArray(data.starred)) store.set('starred', data.starred);
        if (data.theme) store.set('theme', data.theme);
        importInput.value = '';
        toast('Data restored');
        settings();
      };
      document.querySelector('#cancelImport').onclick = () => { importInput.value = ''; preview.innerHTML = ''; };
    };
    reader.readAsText(file);
  };

  document.querySelector('#clearData').onclick = () => {
    store.remove('sessions');
    store.remove('last');
    store.remove('starred');
    activeSession.clear();
    Material.reset();
    toast('Local data cleared');
  };
}

document.addEventListener('DOMContentLoaded', () => { init(); startDailyReminderTimer(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support just won't be available - non-fatal */ });
  });
}

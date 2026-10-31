/* Studypath service worker - caches the static app shell so the app opens
   offline once visited. Same-origin files are fetched network-first (so a
   new deploy shows up immediately, not one reload later) and fall back to
   the cache when offline. Cross-origin requests - Convex, CDN scripts,
   fonts, images - are never touched, so account and quiz calls always go
   straight to the network. */
const CACHE = 'studypath-v12'; // v12: final notification system - service-worker message rotation for payload-less pushes
const ASSETS = [
  'index.html', 'dashboard.html', 'create.html', 'quiz.html', 'results.html',
  'review.html', 'history.html', 'progress.html', 'settings.html',
  'signin.html', 'signup.html', 'materials.html', 'tutor.html', 'privacy.html', 'terms.html', 'delete-account.html',
  'css/styles.css',
  'js/app.js', 'js/material.js', 'js/generator.js', 'js/validate.js', 'js/math-render.js',
  'js/convex-config.js', 'js/convex-client.js', 'js/anon-id.js', 'js/auth-client.js', 'js/site-config.js',
  'assets/icon-mark.png', 'assets/favicon-32.png', 'assets/favicon-16.png',
  'assets/apple-touch-icon.png', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/icon-maskable-192.png', 'assets/icon-maskable-512.png', 'assets/og-image.jpg', 'assets/studypath-og.png',
  'assets/hero-slide-1.jpg', 'assets/hero-slide-2.jpg', 'assets/photo-band.jpg',
  'manifest.json'
];

self.addEventListener('install', (e) => {
  // Cache each file on its own so one missing file can never abort the
  // whole install (addAll is all-or-nothing).
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (e.request.headers.has('range') || e.request.destination === 'video') return; // media streams straight from the network; a failed load just skips the intro
  if (url.pathname.indexOf('/.well-known/') === 0) return; // Digital Asset Links etc. always live

  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('index.html')))
  );
});

/* Final notification system: pushes are payload-less, so the message is
   chosen here on the device, by Lagos time of day. A payload, if one ever
   arrives, still wins. Session reminders and general nudges therefore
   share this display; the server decides when to wake the app, this
   file decides what the nudge says. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : '' }; }
  let body = data.body;
  if (!body) {
    const hour = new Date(Date.now() + 60 * 60 * 1000).getUTCHours(); // Lagos, UTC+1, no DST
    if (hour >= 5 && hour < 12) body = 'Hey, time to study. A quick session now beats a long one later.';
    else if (hour >= 12 && hour < 17) body = 'Hey, time to study. Pick up where you left off.';
    else if (hour >= 17 && hour < 22) body = 'Hey, time to study. One focused session before the day ends.';
    else body = 'Hey, a quick study session now will pay off tomorrow.';
  }
  const title = data.title || 'Studypath reminder';
  const options = {
    body: body,
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
    data: { url: data.url || '/dashboard.html' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/dashboard.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

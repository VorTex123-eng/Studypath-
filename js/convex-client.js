/* Studypath - minimal Convex client.

   Convex exposes a plain HTTP API alongside its JS SDK:
     POST {CONVEX_URL}/api/query     - queries  (read-only)
     POST {CONVEX_URL}/api/mutation  - mutations (writes)
     POST {CONVEX_URL}/api/action    - actions  (can call external APIs,
                                        e.g. Gemini in a later phase)
   Using the HTTP API directly (instead of the JS SDK) keeps this frontend
   dependency-free and bundler-free, matching how the rest of the app is
   built - a plain <script> tag, nothing to compile.

   Every call normalizes to the same envelope regardless of success/
   failure, so callers never need to know whether a problem was a bad
   response from Convex, a network failure, or missing configuration:
     { ok: true,  data: <value> }
     { ok: false, error: { code, message } } */
(function (global) {
  'use strict';

  function callConvex(kind, path, args, opts) {
    const base = global.CONVEX_URL;
    if (!base) {
      // The ONLY way to get here: js/convex-config.js did not run with a
      // URL on this page load (missing from the deploy, stale placeholder,
      // or the script request failed). Every Convex feature shares this
      // one client, so a missing config breaks all of them — never just
      // one flow. Say exactly what to check.
      return Promise.resolve({
        ok: false,
        error: { code: 'not_configured', message: 'Not connected to the backend: CONVEX_URL is missing. The deployed js/convex-config.js must contain your Convex URL.' }
      });
    }
    const url = base.replace(/\/$/, '') + '/api/' + kind;
    const fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path, args: args || {}, format: 'json' })
    };
    // keepalive lets this specific request survive a page navigation that
    // happens right after it's fired (e.g. finalize() redirecting to
    // results.html before the response comes back). Without it, the
    // browser cancels any in-flight fetch the instant the page unloads -
    // that's a real net::ERR_ABORTED, not a flaky network. Only opt in
    // when asked: keepalive has a combined ~64KB body budget across all
    // in-flight keepalive requests, so it's not the right default for
    // every call (e.g. large material uploads), just beacon-style ones.
    if (opts && opts.keepalive) fetchOpts.keepalive = true;
    return fetch(url, fetchOpts)
      .then(function (resp) {
        return resp.json().catch(function () {
          throw new Error('Backend returned a non-JSON response (HTTP ' + resp.status + ').');
        });
      })
      .then(function (body) {
        if (body && body.status === 'success') {
          return { ok: true, data: body.value };
        }
        return {
          ok: false,
          error: {
            code: (body && body.errorData && body.errorData.code) || 'backend_error',
            message: (body && body.errorMessage) || 'The backend returned an error.'
          }
        };
      })
      .catch(function (err) {
        return {
          ok: false,
          error: { code: 'network_error', message: (err && err.message) || 'Could not reach the backend.' }
        };
      });
  }

  global.Convex = {
    query: function (path, args) { return callConvex('query', path, args); },
    mutation: function (path, args, opts) { return callConvex('mutation', path, args, opts); },
    action: function (path, args) { return callConvex('action', path, args); }
  };
})(window);

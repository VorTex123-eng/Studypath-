/* Studypath - client-side auth helper.

   Mirrors js/anon-id.js's pattern: a small localStorage-backed identity
   helper, not a framework. The session token is a bearer token (not a
   cookie) because this is a static multi-page app talking to Convex's
   HTTP API across origins - see convex/auth.ts for why.

   Every function here returns the same { ok, data } / { ok, error }
   envelope Convex.js already uses, so callers handle it the same way
   they handle any other Convex call. */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'studypath:sessionToken';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage unavailable */ }
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function signUp(email, password, claimAnonymous, name, ageConfirmed) {
    return global.Convex.mutation('auth:signUp', {
      email: email,
      password: password,
      name: name,
      anonymousId: global.getAnonId(),
      claimAnonymous: !!claimAnonymous,
      ageConfirmed: !!ageConfirmed
    }).then(function (res) {
      if (res.ok && res.data.ok) { setToken(res.data.token); return { ok: true, data: res.data.user, needsVerification: !!res.data.needsVerification }; }
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      return res; // network/config-level failure - already { ok: false, error }
    });
  }

  // Phase 1 (2026-10-27): email verification and Google sign in.
  function requestVerificationCode() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    return global.Convex.action('emailVerification:requestVerificationCode', { sessionToken: token });
  }

  function verifyCode(code) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    return global.Convex.mutation('emailVerification:verifyCode', { sessionToken: token, code: code });
  }

  function verificationStatus() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: true, data: { verified: false } });
    return global.Convex.query('emailVerification:verificationStatus', { sessionToken: token });
  }

  function signInWithGoogle(idToken, name) {
    return global.Convex.action('googleAuth:signInWithGoogle', { idToken: idToken, name: name || '' }).then(function (res) {
      if (res.ok && res.data.ok) { setToken(res.data.token); return { ok: true, data: res.data.user }; }
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      return res;
    });
  }

  function signIn(email, password) {
    return global.Convex.mutation('auth:signIn', { email: email, password: password }).then(function (res) {
      if (res.ok && res.data.ok) { setToken(res.data.token); return { ok: true, data: res.data.user }; }
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      return res;
    });
  }

  function signOut() {
    var token = getToken();
    clearToken(); // local logout always succeeds regardless of network
    // An account that claimed this browser's history keeps this device id,
    // and account rows are (rightly) unreachable by device id alone. Drop
    // it so the signed-out browser starts a fresh guest identity instead
    // of being locked out of guest sync.
    try { localStorage.removeItem('studypath:anonId'); } catch (e) {}
    // Stabilization: the signed-in account's local quiz data must not
    // survive sign-out. Without this, the next account (or a guest) on a
    // shared browser would see the previous user's sessions, streak and
    // starred questions. Mirrors what account deletion already does.
    clearLocalAccountData();
    if (!token) return Promise.resolve({ ok: true });
    return global.Convex.mutation('auth:signOut', { token: token });
  }

  // Local quiz data that belongs to the signed-in session: completed
  // sessions, starred questions, the last result, and any in-progress
  // quiz. Cleared on sign-out and on stale-token cleanup so it can never
  // leak to the next account or guest on this browser.
  function clearLocalAccountData() {
    try {
      localStorage.removeItem('sessions');
      localStorage.removeItem('starred');
      localStorage.removeItem('last');
      // Reminder prefs are per-account, not per-device: a new account on
      // this browser must never inherit the previous account's time.
      localStorage.removeItem('reminderTime');
      localStorage.removeItem('sessionReminders');
    } catch (e) {}
    try { sessionStorage.removeItem('studypath:active'); } catch (e) {}
  }

  function getCurrentUser() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: true, data: null });
    return global.Convex.query('auth:getCurrentUser', { token: token }).then(function (res) {
      // A rejected/expired token isn't an error state for the caller -
      // it just means "not logged in", so clean up the stale token and
      // report it the same way as never having had one. The account's
      // local quiz data goes too: an expired session is a signed-out
      // session, and leaving it behind would leak it to the next account
      // on a shared browser (same as Auth.signOut).
      if (res.ok && res.data === null) { clearToken(); clearLocalAccountData(); }
      return res;
    });
  }

  function checkAnonymousHistory() {
    return global.Convex.query('auth:checkAnonymousHistory', { anonymousId: global.getAnonId() });
  }

  function updateName(name) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    return global.Convex.mutation('auth:updateName', { sessionToken: token, name: name }).then(function (res) {
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      if (res.ok) return { ok: true, data: { name: res.data.name } };
      return res;
    });
  }

  var MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB - fast client-side feedback only; convex/auth.ts:setAvatar is what actually enforces this
  var ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  // Two-step Convex file upload: mint a URL, POST the raw bytes to it,
  // then attach the storageId it returns to the account. All plain
  // fetch - no Convex JS SDK needed, consistent with the rest of this
  // client.
  function uploadAvatar(file) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    if (ALLOWED_AVATAR_TYPES.indexOf(file.type) === -1) {
      return Promise.resolve({ ok: false, error: { code: 'invalid_image', message: 'Please choose a JPEG, PNG, WebP, or GIF image.' } });
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return Promise.resolve({ ok: false, error: { code: 'invalid_image', message: 'Image must be under 5MB.' } });
    }
    return global.Convex.mutation('auth:generateAvatarUploadUrl', { sessionToken: token }).then(function (res) {
      if (!(res.ok && res.data.ok)) return (res.ok ? { ok: false, error: res.data.error } : res);
      return fetch(res.data.uploadUrl, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
        .then(function (r) { return r.json(); })
        .then(function (uploadResult) {
          return global.Convex.mutation('auth:setAvatar', { sessionToken: token, storageId: uploadResult.storageId });
        })
        .then(function (res2) {
          if (res2.ok && res2.data.ok) return { ok: true, data: { avatarUrl: res2.data.avatarUrl } };
          if (res2.ok && !res2.data.ok) return { ok: false, error: res2.data.error };
          return res2;
        })
        .catch(function () { return { ok: false, error: { code: 'upload_failed', message: 'Upload failed. Please try again.' } }; });
    });
  }

  // In-app deletion: needs the live session AND, for password accounts, the password again. Google-only accounts send a blank password and the live session is the proof.
  // On success the local session is dropped too - the account it pointed
  // at no longer exists.
  function deleteAccount(password) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    return global.Convex.mutation('auth:deleteAccount', { sessionToken: token, password: password }).then(function (res) {
      if (res.ok && res.data.ok) { clearToken(); return { ok: true }; }
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      return res;
    });
  }

  // Public web page path (delete-account.html): email + password, no
  // session needed. If this browser happens to hold a session for that
  // same account it's now dangling, so drop it.
  function deleteAccountByCredentials(email, password) {
    return global.Convex.mutation('auth:deleteAccountByCredentials', { email: email, password: password }).then(function (res) {
      if (res.ok && res.data.ok) { clearToken(); return { ok: true }; }
      if (res.ok && !res.data.ok) return { ok: false, error: res.data.error };
      return res;
    });
  }

  // Password recovery (2026-10-06). Always resolves with the generic
  // server message; never reveals whether the email exists.
  function requestPasswordReset(email) {
    return global.Convex.action('passwordReset:requestPasswordReset', {
      email: email,
      siteUrl: location.origin
    });
  }

  function resetPassword(token, newPassword, confirmPassword) {
    return global.Convex.action('passwordReset:resetPassword', {
      token: token,
      newPassword: newPassword,
      confirmPassword: confirmPassword
    });
  }

  // Age eligibility (2026-10-06). One-time confirmation for accounts that
  // predate the requirement.
  function sendTestPush() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    return global.Convex.action('push:sendTestPush', { sessionToken: token });
  }

  function localReminderPrefs() {
    var time = '19:00';
    var on = true;
    try { var t = JSON.parse(localStorage.getItem('reminderTime') || 'null'); if (t) time = t; } catch (e) {}
    try { var o = JSON.parse(localStorage.getItem('sessionReminders') || 'null'); if (o !== null) on = !!o; } catch (e) {}
    return { reminderTime: time, remindersOn: on };
  }

  function getMySubscription() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false });
    return global.Convex.query('push:mySubscription', { sessionToken: token });
  }

  function savePushSubscription(sub) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: { code: 'not_authenticated', message: 'Please sign in again.' } });
    var prefs = localReminderPrefs();
    return global.Convex.mutation('push:saveSubscription', { sessionToken: token, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, reminderTime: prefs.reminderTime, remindersOn: prefs.remindersOn });
  }

  function removePushSubscription(endpoint) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false });
    return global.Convex.mutation('push:removeSubscription', { sessionToken: token, endpoint: endpoint });
  }

  function updatePushReminder() {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false });
    var prefs = localReminderPrefs();
    return global.Convex.mutation('push:updateReminder', { sessionToken: token, reminderTime: prefs.reminderTime, remindersOn: prefs.remindersOn });
  }

  function setAgeEligibility(eligible) {
    return global.Convex.mutation('auth:setAgeEligibility', {
      sessionToken: getToken(),
      eligible: !!eligible
    });
  }

  global.Auth = {
    getToken: getToken,
    isLoggedIn: function () { return !!getToken(); },
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    getCurrentUser: getCurrentUser,
    checkAnonymousHistory: checkAnonymousHistory,
    updateName: updateName,
    uploadAvatar: uploadAvatar,
    deleteAccount: deleteAccount,
    deleteAccountByCredentials: deleteAccountByCredentials,
    requestPasswordReset: requestPasswordReset,
    resetPassword: resetPassword,
    setAgeEligibility: setAgeEligibility,
    savePushSubscription: savePushSubscription,
    getMySubscription: getMySubscription,
    updatePushReminder: updatePushReminder,
    removePushSubscription: removePushSubscription,
    sendTestPush: sendTestPush,
    requestVerificationCode: requestVerificationCode,
    verifyCode: verifyCode,
    verificationStatus: verificationStatus,
    signInWithGoogle: signInWithGoogle
  };
})(window);

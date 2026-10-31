/* Studypath - anonymous identity placeholder.

   No authentication exists yet (that's M11G). This generates a random ID
   once per browser, stores it in localStorage, and reuses it from then
   on - just enough identity to let attempts be saved and read back by
   "whoever this browser is" before real accounts exist. When M11G adds
   real auth, this becomes the guest/fallback path rather than being torn
   out - the `attempts` table's `userId` foreign key doesn't change either
   way, only what gets used to look up/create that user. */
(function (global) {
  'use strict';

  var KEY = 'studypath:anonId';

  function getAnonId() {
    try {
      var existing = localStorage.getItem(KEY);
      if (existing) return existing;
      var id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : 'anon_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, id);
      return id;
    } catch (e) {
      // localStorage unavailable (private browsing, etc.) - fall back to
      // an in-memory id that's stable for this page load only.
      return 'anon_session_' + Math.random().toString(36).slice(2, 10);
    }
  }

  global.getAnonId = getAnonId;
})(window);

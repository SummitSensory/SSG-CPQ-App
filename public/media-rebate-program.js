/**
 * The Customer Project Media Rebate program, fetched once at sign-in — same
 * fetch-once-at-sign-in shape as public/contract-pages.js and
 * public/reference-documents.js, and for the same reason: `current()` is called
 * synchronously deep inside the proposal builder and the document renderer, neither
 * of which can await anything.
 *
 * Always the LIVE program (`/media-partnership-program/effective`), never a pinned
 * per-version snapshot — same as contract-pages.js's legal text. A released or signed
 * proposal's own answer (offered/participate/exact terms, pinned once the version
 * offering it was released) is read server-side by src/mediaRebate/service.ts's
 * `mediaRebateForVersion`, not through this module.
 *
 * Registers itself on window.SSGMediaRebateProgram. app.js calls init({ authed })
 * alongside the other modules; without that call `current()` returns null and every
 * caller already treats that the same as "program not configured/inactive".
 */
(function () {
  'use strict';

  var H = null;
  var CURRENT = null;
  var loading = null;

  function load() {
    if (!H || !H.authed) return Promise.resolve(false);
    if (loading) return loading;
    loading = H.authed('/media-partnership-program/effective')
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d) return false;
        CURRENT = d;
        return true;
      })
      .catch(function () {
        return false;
      });
    return loading;
  }

  window.SSGMediaRebateProgram = {
    init: function (helpers) {
      H = helpers;
      load();
    },
    load: load,
    /** The program as Administration has it right now, or null before/if the fetch never lands. */
    current: function () {
      return CURRENT;
    },
  };
})();

/**
 * Manual pixel nudges for the six signature/date boxes the proposal and acknowledgment
 * pages print — see src/routes/signatureFieldLayout.ts and SIGNATURE_FIELD_SLOT_IDS in
 * src/integrations/docuseal/assembly.ts for what the six ids are and why.
 *
 * Fetched once at sign-in, fire-and-forget, same pattern as public/contract-pages.js's
 * own legal-text fetch: `styleFor()` is called synchronously deep inside the document
 * builder in proposal-document.js and contract-pages.js and cannot await anything. In
 * practice the fetch resolves long before anyone opens a proposal; if it has not, or it
 * fails, every box renders with no nudge at all — exactly what printed before this file
 * existed, never a broken or half-applied layout.
 *
 * Registers itself on window.SSGSignatureFieldLayout. app.js calls init({ authed })
 * alongside the other modules; without that call every box just renders unnudged.
 */
(function () {
  'use strict';

  /** Loaded offsets, by slot id. Null until the fetch resolves. */
  var LOADED = null;
  var loading = null;
  var H = null;

  function offsetFor(id) {
    var o = LOADED && LOADED[id];
    return o && typeof o.top === 'number' && typeof o.left === 'number' ? o : null;
  }

  /**
   * The inline CSS to splice into a box's own `style="position:relative;...` attribute.
   * Empty string when there is no saved nudge for this id, so an unset box's markup is
   * byte-for-byte what it always was.
   */
  function styleFor(id) {
    var o = offsetFor(id);
    if (!o || (!o.top && !o.left)) return '';
    return 'top:' + o.top + 'px;left:' + o.left + 'px;';
  }

  function load() {
    if (!H || !H.authed) return Promise.resolve(false);
    if (loading) return loading;
    loading = H.authed('/signature-field-layout/effective')
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        LOADED = (d && d.offsets) || {};
        return true;
      })
      .catch(function () {
        return false;
      });
    return loading;
  }

  function init(opts) {
    H = opts || {};
    load();
  }

  window.SSGSignatureFieldLayout = {
    init: init,
    load: load,
    styleFor: styleFor,
    offsetFor: offsetFor,
  };
})();

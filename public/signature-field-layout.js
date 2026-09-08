/**
 * Manual placement AND size for the six signature/date boxes the proposal and
 * acknowledgment pages print — see src/routes/signatureFieldLayout.ts and
 * SIGNATURE_FIELD_SLOT_IDS in src/integrations/docuseal/assembly.ts for what the six
 * ids are and why.
 *
 * `top`/`left` (position) and `width`/`height` (size) are applied here, to the printed
 * BLANK box, for the same reason: so the unsigned template a rep or customer sees
 * always matches the actual DocuSeal field size/position set at send time
 * (sendProposalForSignature in service.ts reads the same saved row to build that
 * field) — a box resized here without also resizing the line it sits on would let a
 * field silently grow past, or sit oddly small inside, a line that never changed to
 * match. `fontSize` is deliberately NOT applied here: the blank box has no visible text
 * before signing, so a font size has nothing to size yet — it only reaches DocuSeal's
 * own tag, at send time.
 *
 * Fetched once at sign-in, fire-and-forget, same pattern as public/contract-pages.js's
 * own legal-text fetch: `styleFor()` is called synchronously deep inside the document
 * builder in proposal-document.js and contract-pages.js and cannot await anything. In
 * practice the fetch resolves long before anyone opens a proposal; if it has not, or it
 * fails, every box renders with no override at all — exactly what printed before this
 * file existed, never a broken or half-applied layout.
 *
 * Registers itself on window.SSGSignatureFieldLayout. app.js calls init({ authed })
 * alongside the other modules; without that call every box just renders unmodified.
 */
(function () {
  'use strict';

  /** Loaded per-slot overrides. Null until the fetch resolves. */
  var LOADED = null;
  var loading = null;
  var H = null;

  function overrideFor(id) {
    return (LOADED && LOADED[id]) || null;
  }

  /**
   * The inline CSS to splice into a box's own `style="position:relative;...` attribute.
   * Empty string when nothing was ever saved for this id, so an unset box's markup is
   * byte-for-byte what it always was.
   */
  function styleFor(id) {
    var o = overrideFor(id);
    if (!o) return '';
    var css = '';
    if (typeof o.top === 'number' || typeof o.left === 'number') {
      css += 'top:' + (o.top || 0) + 'px;left:' + (o.left || 0) + 'px;';
    }
    if (typeof o.width === 'number') css += 'width:' + o.width + 'px;';
    if (typeof o.height === 'number') css += 'height:' + o.height + 'px;';
    return css;
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
    overrideFor: overrideFor,
  };
})();

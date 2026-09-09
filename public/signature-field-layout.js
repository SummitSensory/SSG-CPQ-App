/**
 * Manual placement AND size for the six signature/date boxes the proposal and
 * acknowledgment pages print — see src/routes/signatureFieldLayout.ts and
 * SIGNATURE_FIELD_SLOT_IDS in src/integrations/docuseal/assembly.ts for what the six
 * ids are and why.
 *
 * `width`/`height` (size) and `top`/`left` (position) are applied to two DIFFERENT
 * elements, not the same box's style twice — see proposal-document.js/
 * contract-pages.js's own box markup for the two-element shape this assumes. They used
 * to be one box: `top`/`left` shifted the same element that carries the visible
 * border-bottom line, which moved the LINE itself every time a rep nudged where a
 * signature or date should land — reported on a real proposal (P-2026-000084) where
 * moving the Acceptance signature/date up to clear the line took the line with it,
 * leaving the signature and date exactly as misaligned as before, just against a line
 * that had also moved. `styleFor()` now answers only "how big is this field" (still
 * applied to the outer, LINE-owning box — so the unsigned template's reserved space
 * still matches the actual DocuSeal field size set at send time, same reasoning as
 * before) and `offsetStyleFor()` answers only "how far is the field nudged from where
 * it already sits" (applied to an inner, absolutely-positioned box the line-owning box
 * does not otherwise move). `fontSize` is deliberately in neither: the blank box has no
 * visible text before signing, so a font size has nothing to size yet — it only reaches
 * DocuSeal's own tag, at send time.
 *
 * Fetched once at sign-in, fire-and-forget, same pattern as public/contract-pages.js's
 * own legal-text fetch: both functions are called synchronously deep inside the
 * document builder in proposal-document.js and contract-pages.js and cannot await
 * anything. In practice the fetch resolves long before anyone opens a proposal; if it
 * has not, or it fails, every box renders with no override at all — exactly what
 * printed before this file existed, never a broken or half-applied layout.
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
   * The inline CSS to splice into the outer, LINE-owning box's own
   * `style="position:relative;...` attribute — size only. Empty string when nothing
   * was ever saved for this id, so an unset box's markup is byte-for-byte what it
   * always was.
   */
  function styleFor(id) {
    var o = overrideFor(id);
    if (!o) return '';
    var css = '';
    if (typeof o.width === 'number') css += 'width:' + o.width + 'px;';
    if (typeof o.height === 'number') css += 'height:' + o.height + 'px;';
    return css;
  }

  /**
   * The inline CSS to splice into the INNER box's own `style="position:absolute;
   * top:0;left:0;...` attribute — position only. That inner box is where DocuSeal's
   * own invisible field tag actually lives (see injectSignatureFields in
   * src/integrations/docuseal/assembly.ts), so this is the one place a saved nudge can
   * move the SIGNATURE/DATE without moving the outer box's own border-bottom line.
   * Empty string when nothing was ever saved, same as styleFor().
   */
  function offsetStyleFor(id) {
    var o = overrideFor(id);
    if (!o) return '';
    if (typeof o.top !== 'number' && typeof o.left !== 'number') return '';
    return 'top:' + (o.top || 0) + 'px;left:' + (o.left || 0) + 'px;';
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
    offsetStyleFor: offsetStyleFor,
    overrideFor: overrideFor,
  };
})();

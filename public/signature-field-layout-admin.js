/**
 * Drag-to-place editor for the six signature/date boxes on the acceptance page and the
 * acknowledgment: Administration -> Proposal content -> "Signature & date placement".
 *
 * The two blocks of markup below (`ACCEPTANCE_ROW` and `ackBlock`) are kept
 * byte-for-byte identical to the real boxes in public/proposal-document.js and
 * public/contract-pages.js — same ids, same widths/heights/gaps, same border and label
 * styling. That is deliberate: the box a rep drags here IS the exact box that prints,
 * not a facsimile that could quietly drift out of sync with it. If either source file's
 * box markup ever changes, this preview needs the same edit made here by hand — there
 * is no shared function to keep the two in lock-step, because proposal-document.js and
 * contract-pages.js build those boxes inline, deep inside much larger documents that
 * are not meant to be called from here.
 *
 * Dragging a box updates its on-screen position live and stages a `{ top, left }` pixel
 * offset in memory; nothing is saved until "Save placement" writes the whole map to
 * PUT /signature-field-layout. From that moment public/signature-field-layout.js's
 * `styleFor()` applies the same offset every time any of these two documents render —
 * the screen preview, the customer's own PDF copy, the monday push, and the DocuSeal
 * signing package alike, since all four build from the same generated HTML.
 *
 * Registers on window.SSGSignatureFieldLayoutAdmin. Needs authed and esc from the shell.
 */
(function () {
  'use strict';

  var H = null;
  var SLOT_IDS = [
    'ssgSigAcceptanceSignature',
    'ssgSigAcceptanceDate',
    'ssgSigAckCustomerSignature',
    'ssgSigAckCustomerDate',
    'ssgSigAckSummitSignature',
    'ssgSigAckSummitDate',
  ];
  /** slot id -> { top, left }, in memory. Loaded fresh on every render(). */
  var OFFSETS = {};
  var host = null;

  var LABELS = {
    ssgSigAcceptanceSignature: 'Acceptance — Signature',
    ssgSigAcceptanceDate: 'Acceptance — Date',
    ssgSigAckCustomerSignature: 'Acknowledgment — Customer signature',
    ssgSigAckCustomerDate: 'Acknowledgment — Customer date',
    ssgSigAckSummitSignature: 'Acknowledgment — Summit signature',
    ssgSigAckSummitDate: 'Acknowledgment — Summit date',
  };

  var BTN =
    'border:1px solid #d8dcd2;background:#fff;border-radius:6px;padding:7px 13px;font-family:inherit;' +
    'font-size:12.5px;cursor:pointer;color:#3d4a55;white-space:nowrap;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;white-space:nowrap;';
  var NUM =
    'width:56px;box-sizing:border-box;padding:4px 6px;border:1px solid #d8dcd2;border-radius:5px;' +
    'font-family:inherit;font-size:12px;color:#20241f;';

  function esc(s) {
    return H && H.esc ? H.esc(s) : String(s == null ? '' : s);
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) n = 0;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  function offsetOf(id) {
    return OFFSETS[id] || { top: 0, left: 0 };
  }

  /* ------------------------------------------------------------------ markup */

  // Exact copy of the two boxes in proposal-document.js's Acceptance page.
  function acceptanceRowHtml() {
    return (
      '<div style="display:flex;gap:26px;margin-top:6px;">' +
      '<div style="flex:1.35;"><div id="ssgSigAcceptanceSignature" tabindex="0" style="position:relative;border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Signature</div></div>' +
      '<div style="flex:1;"><div id="ssgSigAcceptanceDate" tabindex="0" style="position:relative;border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Date</div></div>' +
      '</div>'
    );
  }

  // Exact copy of contract-pages.js's sigBlock(), reduced to the two rows that carry an
  // id (By:/Date:) — Name: and Title: take no field and are not draggable.
  function ackBlockHtml(role, entity, sigId, dateId) {
    var line = function (label, depth, id) {
      return (
        '<div style="display:flex;gap:6px;align-items:baseline;margin-top:9px;">' +
        '<div style="flex:none;">' +
        label +
        '</div>' +
        '<div id="' +
        id +
        '" tabindex="0" style="flex:1;border-bottom:1px solid #20241f;' +
        (depth
          ? 'height:' + depth + 'px;display:flex;align-items:flex-end;'
          : 'padding-bottom:1px;') +
        'position:relative;">' +
        '</div></div>'
      );
    };
    return (
      '<div style="flex:1;">' +
      '<div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.09em;color:#5b6478;margin-bottom:5px;">' +
      esc(role) +
      '</div>' +
      '<div style="font-weight:700;">' +
      esc(entity) +
      '</div>' +
      line('By:', 46, sigId) +
      line('Date:', null, dateId) +
      '</div>'
    );
  }

  function draw() {
    if (!host) return;
    host.innerHTML =
      '<div style="border:1px solid #e7e8e3;border-radius:8px;padding:18px 20px;max-width:820px;background:#fff;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<div class="muted" style="font-size:12px;">Drag a box (or focus it and use the arrow keys — hold Shift for 10px steps) to nudge it from its default spot. Nothing prints differently until you save.</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button type="button" id="sflReset" style="' +
      BTN +
      '">Reset all to default</button>' +
      '<button type="button" id="sflSave" disabled style="' +
      PRIMARY +
      '">Save placement</button>' +
      '</div></div>' +
      '<div id="sflStatus" style="margin-top:8px;font-size:12px;min-height:16px;"></div>' +
      '<div style="margin-top:16px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8190;font-weight:700;">Acceptance page</div>' +
      '<div style="margin-top:10px;padding:14px 16px;border:1px dashed #d8dcd2;border-radius:6px;font-family:Georgia,\'Times New Roman\',serif;">' +
      acceptanceRowHtml() +
      '</div>' +
      '<div style="margin-top:22px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8190;font-weight:700;">Product Use, Safety &amp; Responsibility Acknowledgment</div>' +
      '<div style="margin-top:10px;padding:14px 16px;border:1px dashed #d8dcd2;border-radius:6px;font-family:Georgia,\'Times New Roman\',serif;display:flex;gap:44px;">' +
      ackBlockHtml(
        'Customer',
        'Jane Customer',
        'ssgSigAckCustomerSignature',
        'ssgSigAckCustomerDate',
      ) +
      ackBlockHtml(
        'Summit',
        'Summit Sensory Gym',
        'ssgSigAckSummitSignature',
        'ssgSigAckSummitDate',
      ) +
      '</div>' +
      '<div style="margin-top:22px;">' +
      '<table style="border-collapse:collapse;width:100%;font-size:12px;">' +
      '<thead><tr style="text-align:left;color:#7b8190;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;">' +
      '<th style="padding:4px 8px 4px 0;">Box</th><th style="padding:4px 8px;">Top (px)</th><th style="padding:4px 8px;">Left (px)</th><th></th></tr></thead>' +
      '<tbody>' +
      SLOT_IDS.map(rowHtml).join('') +
      '</tbody></table>' +
      '</div>' +
      '</div>';

    SLOT_IDS.forEach(function (id) {
      var box = document.getElementById(id);
      if (box) attachDrag(box, id);
    });
    document.getElementById('sflSave').addEventListener('click', save);
    document.getElementById('sflReset').addEventListener('click', function () {
      SLOT_IDS.forEach(function (id) {
        setOffset(id, 0, 0);
      });
      markDirty();
    });
    SLOT_IDS.forEach(function (id) {
      var t = document.getElementById('sfl_t_' + id);
      var l = document.getElementById('sfl_l_' + id);
      if (t)
        t.addEventListener('change', function () {
          setOffset(id, clamp(t.value, -300, 300), offsetOf(id).left);
          markDirty();
        });
      if (l)
        l.addEventListener('change', function () {
          setOffset(id, offsetOf(id).top, clamp(l.value, -300, 300));
          markDirty();
        });
    });
  }

  function rowHtml(id) {
    var o = offsetOf(id);
    return (
      '<tr style="border-top:1px solid #eef0ea;">' +
      '<td style="padding:6px 8px 6px 0;">' +
      esc(LABELS[id] || id) +
      '</td>' +
      '<td style="padding:6px 8px;"><input type="number" id="sfl_t_' +
      id +
      '" value="' +
      o.top +
      '" style="' +
      NUM +
      '"></td>' +
      '<td style="padding:6px 8px;"><input type="number" id="sfl_l_' +
      id +
      '" value="' +
      o.left +
      '" style="' +
      NUM +
      '"></td>' +
      '<td style="padding:6px 8px;"><button type="button" data-reset="' +
      id +
      '" style="' +
      BTN +
      '">Reset</button></td>' +
      '</tr>'
    );
  }

  /** Applies an offset to state, the box's own inline style, and its two number inputs. */
  function setOffset(id, top, left) {
    top = clamp(top, -300, 300);
    left = clamp(left, -300, 300);
    if (!top && !left) delete OFFSETS[id];
    else OFFSETS[id] = { top: top, left: left };
    var box = document.getElementById(id);
    if (box) {
      box.style.top = top ? top + 'px' : '';
      box.style.left = left ? left + 'px' : '';
    }
    var t = document.getElementById('sfl_t_' + id);
    var l = document.getElementById('sfl_l_' + id);
    if (t) t.value = top;
    if (l) l.value = left;
  }

  function markDirty() {
    var btn = document.getElementById('sflSave');
    if (btn) btn.disabled = false;
    status('Unsaved changes.', false);
  }

  function status(text, good) {
    var el = document.getElementById('sflStatus');
    if (!el) return;
    el.style.color = good ? '#3f6212' : '#8a6d1a';
    el.textContent = text || '';
  }

  /** Reset-row buttons are added after draw() via delegation, so one row's click
   *  handler still works after a later draw() rebuilds the table. */
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (
      t &&
      t.getAttribute &&
      t.getAttribute('data-reset') &&
      SLOT_IDS.indexOf(t.getAttribute('data-reset')) !== -1
    ) {
      setOffset(t.getAttribute('data-reset'), 0, 0);
      markDirty();
    }
  });

  function attachDrag(box, id) {
    var dragging = false;
    var start = null;
    var base = null;
    box.style.cursor = 'move';
    box.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      box.focus();
      dragging = true;
      base = offsetOf(id);
      start = { x: e.clientX, y: e.clientY };
      try {
        box.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;
      setOffset(id, base.top + dy, base.left + dx);
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      markDirty();
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 1;
      var o = offsetOf(id);
      if (e.key === 'ArrowUp') setOffset(id, o.top - step, o.left);
      else if (e.key === 'ArrowDown') setOffset(id, o.top + step, o.left);
      else if (e.key === 'ArrowLeft') setOffset(id, o.top, o.left - step);
      else if (e.key === 'ArrowRight') setOffset(id, o.top, o.left + step);
      else return;
      e.preventDefault();
      markDirty();
    });
  }

  /* ------------------------------------------------------------------ actions */

  async function load() {
    if (!H || !H.authed) return;
    var r = await H.authed('/signature-field-layout/effective');
    var d = r && r.ok ? await r.json() : null;
    OFFSETS = (d && d.offsets) || {};
    if (d && d.slotIds && d.slotIds.length) SLOT_IDS = d.slotIds;
  }

  async function save() {
    var btn = document.getElementById('sflSave');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving…';
    }
    var r = await H.authed('/signature-field-layout', {
      method: 'PUT',
      body: { offsets: OFFSETS },
    });
    if (btn) btn.textContent = 'Save placement';
    if (!r || !r.ok) {
      var msg = '';
      try {
        msg = ((await r.json()) || {}).message || '';
      } catch (e) {}
      // Still dirty — re-enabled so the same click can be retried without redragging.
      if (btn) btn.disabled = false;
      status(msg || 'Could not save (' + (r ? r.status : 0) + ').', false);
      return;
    }
    var d = await r.json();
    OFFSETS = (d && d.offsets) || OFFSETS;
    status('Saved — every proposal now prints at this placement.', true);
  }

  async function render(el) {
    host = el;
    if (host) host.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
    await load();
    draw();
  }

  function init(opts) {
    H = opts || {};
  }

  window.SSGSignatureFieldLayoutAdmin = { init: init, render: render };
})();

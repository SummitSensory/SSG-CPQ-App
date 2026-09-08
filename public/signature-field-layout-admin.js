/**
 * Drag-to-place, drag-to-resize editor for the six signature/date boxes on the
 * acceptance page and the acknowledgment: Administration -> Proposal content ->
 * "Signature & date placement".
 *
 * The two blocks of markup below (`acceptanceRowHtml` and `ackBlockHtml`) are kept
 * byte-for-byte identical to the real boxes in public/proposal-document.js and
 * public/contract-pages.js — same ids, same flex ratios, same border and label
 * styling. That is deliberate: the box a rep drags/resizes here IS the exact box that
 * prints, not a facsimile that could quietly drift out of sync with it. If either
 * source file's box markup ever changes, this preview needs the same edit made here by
 * hand — there is no shared function to keep the two in lock-step, because
 * proposal-document.js and contract-pages.js build those boxes inline, deep inside
 * much larger documents that are not meant to be called from here.
 *
 * Position (top/left) and size (width/height/font size) are saved the same way but
 * apply in two different places — see public/signature-field-layout.js's own comment
 * for why: position and width/height are applied to the printed BLANK box (so the
 * unsigned template always matches what DocuSeal will actually create), while font
 * size only ever reaches DocuSeal's own tag at send time, since a blank box has no
 * text yet to size. This editor shows a realistic placeholder value in every box, at
 * its current width/height/font size, so a size decision is judged against what a
 * signature or date will actually look like — not an empty rectangle.
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
  /** slot id -> { width, height, fontSize }, as shipped — from the server's own
   *  SIGNATURE_FIELD_DEFAULTS (assembly.ts), never a hand-kept copy of it. */
  var DEFAULTS = {};
  /** slot id -> a saved subset of { top, left, width, height, fontSize }, in memory.
   *  Loaded fresh on every render(). */
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
  /** Realistic placeholder VALUE shown inside each box, at its current font size, so
   *  resizing is judged against what a signed value actually looks like. */
  var PLACEHOLDERS = {
    ssgSigAcceptanceSignature: { text: 'Jane Customer', cursive: true },
    ssgSigAcceptanceDate: { text: '09/07/2026', cursive: false },
    ssgSigAckCustomerSignature: { text: 'Jane Customer', cursive: true },
    ssgSigAckCustomerDate: { text: '09/07/2026', cursive: false },
    ssgSigAckSummitSignature: { text: 'Bryan Shepherd', cursive: true },
    ssgSigAckSummitDate: { text: '09/07/2026', cursive: false },
  };
  var FALLBACK_DEFAULT = { width: 150, height: 30, fontSize: 12 };

  // Position bounds match the server's; size bounds match its own per-property min/max.
  var TOP_MIN = -300,
    TOP_MAX = 300;
  var WIDTH_MIN = 40,
    WIDTH_MAX = 500;
  var HEIGHT_MIN = 12,
    HEIGHT_MAX = 140;
  var FONT_MIN = 8,
    FONT_MAX = 40;

  var BTN =
    'border:1px solid #d8dcd2;background:#fff;border-radius:6px;padding:7px 13px;font-family:inherit;' +
    'font-size:12.5px;cursor:pointer;color:#3d4a55;white-space:nowrap;';
  var PRIMARY =
    'border:1px solid #203060;background:#203060;color:#fff;border-radius:6px;padding:7px 15px;' +
    'font-family:inherit;font-size:12.5px;cursor:pointer;font-weight:600;white-space:nowrap;';
  var NUM =
    'width:52px;box-sizing:border-box;padding:4px 5px;border:1px solid #d8dcd2;border-radius:5px;' +
    'font-family:inherit;font-size:12px;color:#20241f;';

  function esc(s) {
    return H && H.esc ? H.esc(s) : String(s == null ? '' : s);
  }

  function clamp(n, lo, hi, fallback) {
    n = Number(n);
    if (!isFinite(n)) n = fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  function defaultsOf(id) {
    return DEFAULTS[id] || FALLBACK_DEFAULT;
  }

  /** The current, fully-resolved placement/size for a box — saved override where one
   *  exists, that property's shipped default otherwise. */
  function effective(id) {
    var d = defaultsOf(id);
    var o = OFFSETS[id] || {};
    return {
      top: typeof o.top === 'number' ? o.top : 0,
      left: typeof o.left === 'number' ? o.left : 0,
      width: typeof o.width === 'number' ? o.width : d.width,
      height: typeof o.height === 'number' ? o.height : d.height,
      fontSize: typeof o.fontSize === 'number' ? o.fontSize : d.fontSize,
    };
  }

  /** Sets one property, storing it only when it differs from that property's
   *  default — an untouched box therefore has no entry at all in OFFSETS, and a box
   *  touched on only one property (say, resized but never moved) keeps the others
   *  absent rather than pinned to whatever they happened to read as. */
  function setField(id, key, value, defaultValue) {
    var entry = OFFSETS[id] || {};
    if (value === defaultValue) delete entry[key];
    else entry[key] = value;
    if (Object.keys(entry).length) OFFSETS[id] = entry;
    else delete OFFSETS[id];
  }

  /* ------------------------------------------------------------------ markup */

  function fieldBoxHtml(id, extraOuterStyle) {
    return (
      '<div id="' +
      id +
      '" tabindex="0" style="position:relative;border-bottom:1px solid #20241f;' +
      'display:flex;align-items:flex-end;justify-content:flex-start;overflow:visible;' +
      extraOuterStyle +
      '">' +
      '<span data-placeholder="' +
      id +
      '" style="white-space:nowrap;color:#1a1a1a;line-height:1;"></span>' +
      '<div data-resize="' +
      id +
      '" title="Drag to resize" style="position:absolute;right:-5px;bottom:-5px;width:11px;height:11px;' +
      'border:1px solid #203060;background:#fff;border-radius:2px;cursor:nwse-resize;"></div>' +
      '</div>'
    );
  }

  // Same three-column row as proposal-document.js's Acceptance page: printed name
  // (not a field, not draggable — context only), then Signature, then Date.
  function acceptanceRowHtml() {
    return (
      '<div style="display:flex;gap:26px;margin-top:6px;">' +
      '<div style="flex:1.35;"><div style="border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"><span style="font-size:11.5px;line-height:1.35;color:#20241f;">Donnica Nicholas</span></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Authorized Signer&rsquo;s Name</div></div>' +
      '<div style="flex:1.35;">' +
      fieldBoxHtml('ssgSigAcceptanceSignature', 'padding-bottom:3px;') +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Signature</div></div>' +
      '<div style="flex:1;">' +
      fieldBoxHtml('ssgSigAcceptanceDate', 'padding-bottom:3px;') +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Date</div></div>' +
      '</div>'
    );
  }

  // Exact copy of contract-pages.js's sigBlock(), reduced to the two rows that carry an
  // id (By:/Date:) — Name: and Title: take no field and are not draggable/resizable.
  function ackBlockHtml(role, entity, sigId, dateId) {
    var line = function (label, id) {
      return (
        '<div style="display:flex;gap:6px;align-items:baseline;margin-top:9px;">' +
        '<div style="flex:none;">' +
        label +
        '</div>' +
        fieldBoxHtml(id, 'flex:1;') +
        '</div>'
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
      line('By:', sigId) +
      line('Date:', dateId) +
      '</div>'
    );
  }

  function draw() {
    if (!host) return;
    host.innerHTML =
      '<div style="border:1px solid #e7e8e3;border-radius:8px;padding:18px 20px;max-width:860px;background:#fff;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<div class="muted" style="font-size:12px;max-width:520px;">Drag a box to move it, or its bottom-right corner to resize it — the placeholder name/date shows roughly how it will look once signed. Focus a box and use the arrow keys to nudge position (hold Shift for 10px steps). Nothing prints differently until you save.</div>' +
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
      '<div style="margin-top:10px;padding:14px 16px 26px;border:1px dashed #d8dcd2;border-radius:6px;font-family:Georgia,\'Times New Roman\',serif;overflow:visible;">' +
      acceptanceRowHtml() +
      '</div>' +
      '<div style="margin-top:22px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8190;font-weight:700;">Product Use, Safety &amp; Responsibility Acknowledgment</div>' +
      '<div style="margin-top:10px;padding:14px 16px 26px;border:1px dashed #d8dcd2;border-radius:6px;font-family:Georgia,\'Times New Roman\',serif;display:flex;gap:44px;overflow:visible;">' +
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
      '<div style="margin-top:22px;overflow-x:auto;">' +
      '<table style="border-collapse:collapse;width:100%;font-size:12px;">' +
      '<thead><tr style="text-align:left;color:#7b8190;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;">' +
      '<th style="padding:4px 8px 4px 0;">Box</th>' +
      '<th style="padding:4px 6px;">Top</th><th style="padding:4px 6px;">Left</th>' +
      '<th style="padding:4px 6px;">Width</th><th style="padding:4px 6px;">Height</th>' +
      '<th style="padding:4px 6px;">Font size</th><th></th></tr></thead>' +
      '<tbody>' +
      SLOT_IDS.map(rowHtml).join('') +
      '</tbody></table>' +
      '</div>' +
      '</div>';

    SLOT_IDS.forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      applyBox(id);
      attachDrag(box, id);
      var handle = box.querySelector('[data-resize]');
      if (handle) attachResize(handle, id);
    });
    document.getElementById('sflSave').addEventListener('click', save);
    document.getElementById('sflReset').addEventListener('click', function () {
      SLOT_IDS.forEach(function (id) {
        delete OFFSETS[id];
        applyBox(id);
        syncRow(id);
      });
      markDirty();
    });
    SLOT_IDS.forEach(function (id) {
      bindNumberInput('sfl_t_' + id, function (v) {
        setField(id, 'top', clamp(v, TOP_MIN, TOP_MAX, 0), 0);
      });
      bindNumberInput('sfl_l_' + id, function (v) {
        setField(id, 'left', clamp(v, TOP_MIN, TOP_MAX, 0), 0);
      });
      bindNumberInput('sfl_w_' + id, function (v) {
        setField(
          id,
          'width',
          clamp(v, WIDTH_MIN, WIDTH_MAX, defaultsOf(id).width),
          defaultsOf(id).width,
        );
      });
      bindNumberInput('sfl_h_' + id, function (v) {
        setField(
          id,
          'height',
          clamp(v, HEIGHT_MIN, HEIGHT_MAX, defaultsOf(id).height),
          defaultsOf(id).height,
        );
      });
      bindNumberInput('sfl_f_' + id, function (v) {
        setField(
          id,
          'fontSize',
          clamp(v, FONT_MIN, FONT_MAX, defaultsOf(id).fontSize),
          defaultsOf(id).fontSize,
        );
      });
    });
  }

  function bindNumberInput(elId, apply) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.addEventListener('change', function () {
      var id = elId.replace(/^sfl_[a-z]_/, '');
      apply(el.value);
      applyBox(id);
      syncRow(id);
      markDirty();
    });
  }

  function rowHtml(id) {
    var e = effective(id);
    var cell = function (inputId, value) {
      return (
        '<td style="padding:6px 6px;"><input type="number" id="' +
        inputId +
        '" value="' +
        value +
        '" style="' +
        NUM +
        '"></td>'
      );
    };
    return (
      '<tr style="border-top:1px solid #eef0ea;" data-row="' +
      id +
      '">' +
      '<td style="padding:6px 8px 6px 0;">' +
      esc(LABELS[id] || id) +
      '</td>' +
      cell('sfl_t_' + id, e.top) +
      cell('sfl_l_' + id, e.left) +
      cell('sfl_w_' + id, e.width) +
      cell('sfl_h_' + id, e.height) +
      cell('sfl_f_' + id, e.fontSize) +
      '<td style="padding:6px 8px;"><button type="button" data-reset="' +
      id +
      '" style="' +
      BTN +
      '">Reset</button></td>' +
      '</tr>'
    );
  }

  /** Rewrites one row's five number inputs from current state — used after a drag,
   *  a resize, or a reset changes state some OTHER control did not itself set. */
  function syncRow(id) {
    var e = effective(id);
    var set = function (suffix, value) {
      var el = document.getElementById('sfl_' + suffix + '_' + id);
      if (el) el.value = value;
    };
    set('t', e.top);
    set('l', e.left);
    set('w', e.width);
    set('h', e.height);
    set('f', e.fontSize);
  }

  /** Applies the current effective placement/size/placeholder to a box's own DOM. */
  function applyBox(id) {
    var box = document.getElementById(id);
    if (!box) return;
    var e = effective(id);
    box.style.top = e.top ? e.top + 'px' : '';
    box.style.left = e.left ? e.left + 'px' : '';
    box.style.width = e.width + 'px';
    box.style.height = e.height + 'px';
    var span = box.querySelector('[data-placeholder]');
    var ph = PLACEHOLDERS[id] || { text: '', cursive: false };
    if (span) {
      span.textContent = ph.text;
      span.style.fontSize = e.fontSize + 'px';
      span.style.fontFamily = ph.cursive
        ? "'Segoe Script','Brush Script MT',cursive"
        : "Georgia,'Times New Roman',serif";
    }
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
    var id = t && t.getAttribute && t.getAttribute('data-reset');
    if (id && SLOT_IDS.indexOf(id) !== -1) {
      delete OFFSETS[id];
      applyBox(id);
      syncRow(id);
      markDirty();
    }
  });

  function attachDrag(box, id) {
    var dragging = false;
    var start = null;
    var base = null;
    box.style.cursor = 'move';
    box.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-resize')) return;
      e.preventDefault();
      box.focus();
      dragging = true;
      base = effective(id);
      start = { x: e.clientX, y: e.clientY };
      try {
        box.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;
      setField(id, 'top', clamp(base.top + dy, TOP_MIN, TOP_MAX, 0), 0);
      setField(id, 'left', clamp(base.left + dx, TOP_MIN, TOP_MAX, 0), 0);
      applyBox(id);
      syncRow(id);
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
      var cur = effective(id);
      var top = cur.top,
        left = cur.left;
      if (e.key === 'ArrowUp') top -= step;
      else if (e.key === 'ArrowDown') top += step;
      else if (e.key === 'ArrowLeft') left -= step;
      else if (e.key === 'ArrowRight') left += step;
      else return;
      e.preventDefault();
      setField(id, 'top', clamp(top, TOP_MIN, TOP_MAX, 0), 0);
      setField(id, 'left', clamp(left, TOP_MIN, TOP_MAX, 0), 0);
      applyBox(id);
      syncRow(id);
      markDirty();
    });
  }

  function attachResize(handle, id) {
    var dragging = false;
    var start = null;
    var base = null;
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation(); // do not also start the box's own move-drag
      dragging = true;
      base = effective(id);
      start = { x: e.clientX, y: e.clientY };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - start.x;
      var dy = e.clientY - start.y;
      var d = defaultsOf(id);
      setField(id, 'width', clamp(base.width + dx, WIDTH_MIN, WIDTH_MAX, d.width), d.width);
      setField(id, 'height', clamp(base.height + dy, HEIGHT_MIN, HEIGHT_MAX, d.height), d.height);
      applyBox(id);
      syncRow(id);
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      markDirty();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ------------------------------------------------------------------ actions */

  async function load() {
    if (!H || !H.authed) return;
    var r = await H.authed('/signature-field-layout/effective');
    var d = r && r.ok ? await r.json() : null;
    OFFSETS = (d && d.offsets) || {};
    DEFAULTS = (d && d.defaults) || {};
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
      // Still dirty — re-enabled so the same click can be retried without redoing the edit.
      if (btn) btn.disabled = false;
      status(msg || 'Could not save (' + (r ? r.status : 0) + ').', false);
      return;
    }
    var d = await r.json();
    OFFSETS = (d && d.offsets) || OFFSETS;
    status('Saved — every proposal now prints, and signs, at this placement and size.', true);
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

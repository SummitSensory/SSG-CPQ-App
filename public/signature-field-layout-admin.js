/**
 * Drag-to-place, drag-to-resize editor for the six signature/date boxes on the
 * acceptance page and the acknowledgment: Administration -> Proposal content ->
 * "Signature & date placement".
 *
 * Renders a REAL proposal, picked from a dropdown, through the exact same
 * proposalDocData/proposalDocHtml/paginateProposalArea pipeline the proposal
 * preview and PDF/DocuSeal send paths use (handed in via init() — see
 * app.js's own comment at the call site). That is deliberate, and replaces an
 * earlier version of this file that hand-copied the six boxes' markup into a
 * standalone mockup: a byte-for-byte copy had no way to stay in sync with
 * proposal-document.js/contract-pages.js except a human remembering to edit
 * both, and — more importantly — showed the boxes in isolation, with no
 * header, pricing table, or surrounding page for a rep to judge placement
 * against. Rendering the real document means the six boxes ARE exactly what
 * will print, on exactly the page they print on, every time.
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
 * Registers on window.SSGSignatureFieldLayoutAdmin. Needs authed, esc, proposalDocData,
 * proposalDocHtml and paginateProposalArea from the shell.
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
   *  Loaded fresh on every render(). Persists across a proposal-preview switch —
   *  this setting is global, not per-proposal. */
  var OFFSETS = {};
  var host = null;

  /** Proposals available to preview against, loaded once per render(). */
  var PROPOSALS = [];
  var currentProposalId = null;

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
  var SEL =
    'padding:6px 8px;border:1px solid #d8dcd2;border-radius:6px;font-family:inherit;font-size:12.5px;' +
    'color:#20241f;max-width:420px;';

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

  /* ------------------------------------------------------------------ live preview */

  /** proposal.versions is already fully populated by GET /proposals (see app.js's own
   *  loadProposals) — no per-selection fetch needed. The most-recently-touched one is
   *  the most useful default: whatever a rep is actively working on right now. */
  function sortedProposals() {
    return PROPOSALS.slice().sort(function (a, b) {
      var ta = new Date(a.lastModifiedAt || a.updatedAt || a.createdAt || 0).getTime();
      var tb = new Date(b.lastModifiedAt || b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
  }

  function proposalPickerHtml() {
    if (!PROPOSALS.length) {
      return (
        '<div class="muted" style="font-size:12.5px;">' +
        'No proposals to preview against yet — the table below still works.</div>'
      );
    }
    var opts = sortedProposals()
      .slice(0, 60)
      .map(function (p) {
        return (
          '<option value="' +
          esc(p.id) +
          '"' +
          (p.id === currentProposalId ? ' selected' : '') +
          '>' +
          esc((p.number || '') + ' — ' + (p.title || 'Untitled')) +
          '</option>'
        );
      })
      .join('');
    return (
      '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:#5b6478;">' +
      'Preview against<select id="sflProposal" style="' +
      SEL +
      '">' +
      opts +
      '</select></label>'
    );
  }

  /** Injects the drag handle + a realistic placeholder value into an already-rendered
   *  REAL box (an actual element the real document just produced), then wires the same
   *  drag/resize/keyboard behavior this file has always used. Idempotent per element —
   *  a proposal switch re-renders the whole preview from scratch, so there is never a
   *  stale handle left over from a previous mount. */
  function mountBox(id) {
    var box = document.getElementById(id);
    if (!box) return false;
    box.setAttribute('tabindex', '0');
    box.style.position = 'relative';
    box.style.overflow = 'visible';
    box.style.outline = '1px dashed #9aa0c8';
    box.style.outlineOffset = '1px';
    var span = document.createElement('span');
    span.setAttribute('data-placeholder', id);
    span.style.whiteSpace = 'nowrap';
    span.style.color = '#1a1a1a';
    span.style.lineHeight = '1';
    box.appendChild(span);
    var handle = document.createElement('div');
    handle.setAttribute('data-resize', id);
    handle.title = 'Drag to resize';
    handle.style.cssText =
      'position:absolute;right:-5px;bottom:-5px;width:11px;height:11px;' +
      'border:1px solid #203060;background:#fff;border-radius:2px;cursor:nwse-resize;';
    box.appendChild(handle);
    applyBox(id);
    attachDrag(box, id);
    attachResize(handle, id);
    return true;
  }

  /** Fetches the picked proposal's real document, renders and paginates it exactly as
   *  the proposal preview does, then mounts drag/resize onto whichever of the six real
   *  boxes that document's own template actually produced (a cover-only template has
   *  no acknowledgment page, so those four ids legitimately will not exist). */
  async function loadPreview(proposalId) {
    var canvas = document.getElementById('sflCanvas');
    if (!canvas) return;
    var p = PROPOSALS.filter(function (x) {
      return x.id === proposalId;
    })[0];
    if (!p) {
      canvas.innerHTML =
        '<div class="muted" style="padding:16px;">Could not find that proposal.</div>';
      return;
    }
    var v = (p.versions || [])[(p.versions || []).length - 1];
    if (!v) {
      canvas.innerHTML =
        '<div class="muted" style="padding:16px;">That proposal has no version to preview.</div>';
      return;
    }
    currentProposalId = proposalId;
    canvas.innerHTML = '<div class="muted" style="padding:16px;">Loading proposal…</div>';
    var doc;
    try {
      doc = await H.proposalDocData(p, v);
    } catch (e) {
      canvas.innerHTML =
        '<div class="err" style="padding:16px;">Could not load that proposal.</div>';
      return;
    }
    canvas.innerHTML = H.proposalDocHtml(doc);
    H.paginateProposalArea(canvas);
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (e) {}
    }
    var mounted = {};
    SLOT_IDS.forEach(function (id) {
      mounted[id] = mountBox(id);
    });
    document.querySelectorAll('[data-missing]').forEach(function (el) {
      el.remove();
    });
    SLOT_IDS.filter(function (id) {
      return !mounted[id];
    }).forEach(function (id) {
      var note = document.createElement('div');
      note.setAttribute('data-missing', '1');
      note.className = 'muted';
      note.style.cssText = 'font-size:12px;margin-top:6px;';
      note.textContent = (LABELS[id] || id) + ' does not appear on this proposal’s template.';
      canvas.appendChild(note);
    });
  }

  /* ------------------------------------------------------------------ table markup */

  function draw() {
    if (!host) return;
    host.innerHTML =
      '<div style="border:1px solid #e7e8e3;border-radius:8px;padding:18px 20px;max-width:900px;background:#fff;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<div class="muted" style="font-size:12px;max-width:520px;">Drag a box to move it, or its bottom-right corner to resize it — shown on a real proposal, at full page size, so the printed name, the pricing table and the rest of the page are the same reference you would judge placement against on paper. Focus a box and use the arrow keys to nudge position (hold Shift for 10px steps). Nothing prints differently until you save.</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button type="button" id="sflReset" style="' +
      BTN +
      '">Reset all to default</button>' +
      '<button type="button" id="sflSave" disabled style="' +
      PRIMARY +
      '">Save placement</button>' +
      '</div></div>' +
      '<div id="sflStatus" style="margin-top:8px;font-size:12px;min-height:16px;"></div>' +
      '<div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
      proposalPickerHtml() +
      '</div>' +
      '<div id="sflCanvas" style="margin-top:12px;border:1px solid #d8dcd2;border-radius:6px;' +
      'max-height:70vh;overflow:auto;background:#e7e8e3;padding:16px;"></div>' +
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

    var picker = document.getElementById('sflProposal');
    if (picker) {
      picker.addEventListener('change', function () {
        loadPreview(picker.value);
      });
    }
    if (currentProposalId) loadPreview(currentProposalId);

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

    PROPOSALS = [];
    try {
      var rp = await H.authed('/proposals');
      if (rp.ok) PROPOSALS = (await rp.json()) || [];
    } catch (e) {}
    // Not archived, has at least one version to render — a bare draft with nothing
    // saved yet has no pricing table or contact to show, which defeats the point of
    // previewing against a real page. The most recently touched one is the most
    // useful default: whatever a rep is actively working on right now.
    var candidates = sortedProposals().filter(function (p) {
      return !p.archivedAt && p.versions && p.versions.length;
    });
    currentProposalId = candidates.length ? candidates[0].id : null;
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

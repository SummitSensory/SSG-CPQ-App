/**
 * Portal colour areas — Administration → Orders → Portal colour areas.
 *
 * The customer portal asks for colours by AREA ("Structure frame paint — Legs",
 * "Slide — Slide color"); the Bill of Materials holds one colour per PART line.
 * This screen is the bridge: for each area the portal has used, which catalog parts
 * it paints. When staff mark an order's colour step reviewed, the customer's pick
 * for each area is written onto that order's lines for exactly these parts
 * (src/portal/colorAreas.ts).
 *
 * A separate file from app.js for the same reason as vendor-colors.js and
 * portal-delivery.js: one workflow with one owner, readable and replaceable without
 * touching the shell. app.js only gives it a container and its fetch.
 *
 * The rows are not configured — they are every area any customer has answered, plus
 * any area already mapped. An area nobody has mapped yet is flagged, because its
 * picks will be listed as "unmapped" on every review until someone maps it.
 *
 * A part may be a PATTERN with * (e.g. R-SSG-*CLM* — the Adventure floor padding's
 * number changes with the mat size), and may name a PIECE (one part number that takes
 * a colour per piece, like a Palisades or 90° Climb & Slide mat system).
 *
 * "Add an area" lets an area be mapped BEFORE any customer answers it — e.g. when the
 * portal starts asking a new question, so the first order that answers it already
 * lands on the right parts. The server has always kept mapped keys on this list
 * (src/portal/colorAreaMapping.ts); the added row only persists once parts are saved.
 *
 * Entry point: window.SSGPortalColorAreas.render(container, { authed: authed })
 */
(function () {
  'use strict';

  var U = window.SSGUI;
  var esc = U.esc,
    toast = U.toast,
    serverMessage = U.serverMessage,
    bomFieldStyle = U.bomFieldStyle;

  var INK = '#1c4039',
    MUTED = '#8a8f85',
    LINE = '#eceee8',
    RED = '#9c3327',
    RED_BG = '#fbeeec';

  var AREA_KEY_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  var H = null; // { authed } from app.js
  var state = { el: null, areas: [], drafts: {}, onlyUnmapped: false };

  function authed(path, opts) {
    return H.authed(path, opts);
  }

  function chip(text, color, bg, title) {
    return (
      '<span class="chip" style="font-size:10.5px;color:' +
      (color || MUTED) +
      ';background:' +
      (bg || '#f2f3ef') +
      ';"' +
      (title ? ' title="' + esc(title) + '"' : '') +
      '>' +
      esc(text) +
      '</span>'
    );
  }

  /** The parts shown for an area: the unsaved draft if there is one, else what is saved. */
  function partsOf(a) {
    return state.drafts[a.areaKey] || a.parts;
  }

  function isDirty(a) {
    var d = state.drafts[a.areaKey];
    if (!d) return false;
    var sig = function (p) {
      return p.sku.toUpperCase() + '#' + (p.piece || '');
    };
    return d.map(sig).join('|') !== a.parts.map(sig).join('|');
  }

  function humanizePart(x) {
    var w = String(x || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
  }

  function areaLabel(key) {
    var dot = key.indexOf('.');
    if (dot < 0) return humanizePart(key);
    return [humanizePart(key.slice(0, dot)), humanizePart(key.slice(dot + 1))]
      .filter(Boolean)
      .join(' — ');
  }

  function addAreaHtml() {
    return (
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;font-size:12.5px;">' +
      '<input type="text" id="pcaNewArea" placeholder="Add an area — e.g. adventure_mat.adventure_mat_system" autocomplete="off" style="' +
      bomFieldStyle('360px') +
      'font-family:monospace;">' +
      '<button class="btn" type="button" id="pcaAddArea" style="width:auto;padding:7px 13px;">Add area</button>' +
      '<span class="muted" style="font-size:11.5px;">For an area the portal asks about that no customer has answered yet. Add its parts and Save to keep it.</span>' +
      '</div>'
    );
  }

  function addArea() {
    var input = state.el.querySelector('#pcaNewArea');
    if (!input) return;
    var key = input.value.trim();
    if (!key) return;
    if (!AREA_KEY_RE.test(key)) {
      toast(
        '"' + key + '" is not an area key. Area keys look like structure_frame_paint.legs.',
        true,
      );
      return;
    }
    var existing = state.areas.filter(function (a) {
      return a.areaKey === key;
    })[0];
    if (!existing) {
      state.areas.push({
        areaKey: key,
        label: areaLabel(key),
        orderCount: 0,
        samples: [],
        parts: [],
      });
      state.areas.sort(function (a, b) {
        return a.areaKey.localeCompare(b.areaKey);
      });
    } else {
      toast(key + ' is already listed.');
    }
    // Keep the new (unmapped) row visible even with "Unmapped only" off or on.
    draw();
    var idx = state.areas.indexOf(
      existing ||
        state.areas.filter(function (a) {
          return a.areaKey === key;
        })[0],
    );
    var search = state.el.querySelector('[data-pca-search="' + idx + '"]');
    if (search) search.focus();
  }

  function pickText(s) {
    return [s.brand, s.code].filter(Boolean).join(' ');
  }

  /**
   * Which piece of the part this area colours. "Whole part" for an ordinary part;
   * "Piece 2" when one part number takes a colour per piece (a Palisades or 90°
   * Climb & Slide mat system) — the piece is that part's colour-spec slot under
   * Administration → Manufacturers → Colours.
   */
  function pieceSelect(i, j, piece) {
    var opts = '<option value="">whole part</option>';
    for (var n = 1; n <= 12; n += 1) {
      opts +=
        '<option value="' +
        n +
        '"' +
        (piece === n ? ' selected' : '') +
        '>piece ' +
        n +
        '</option>';
    }
    return (
      '<select data-pca-piece="' +
      i +
      ':' +
      j +
      '" title="Which piece of this part the area colours" style="font-size:10.5px;border:1px solid #e1e3dc;border-radius:5px;padding:1px 3px;background:#fff;color:' +
      INK +
      ';">' +
      opts +
      '</select>'
    );
  }

  function rowHtml(a, i) {
    var parts = partsOf(a);
    var unmapped = !a.parts.length;
    var dirty = isDirty(a);
    return (
      '<tr data-pca-row="' +
      i +
      '" style="' +
      (unmapped ? 'background:' + RED_BG + ';' : '') +
      '">' +
      '<td style="padding:11px 14px;border-bottom:1px solid ' +
      LINE +
      ';vertical-align:top;' +
      (unmapped ? 'box-shadow:inset 3px 0 0 ' + RED + ';' : '') +
      '">' +
      '<div style="font-weight:600;color:' +
      INK +
      ';">' +
      esc(a.label) +
      '</div>' +
      '<div class="muted" style="font-size:11px;font-family:monospace;margin-top:2px;">' +
      esc(a.areaKey) +
      '</div>' +
      (unmapped
        ? '<div style="margin-top:5px;">' +
          chip('Unmapped', RED, '#f6dcd8', 'Picks for this area are not applied to any part') +
          '</div>'
        : '') +
      '</td>' +
      '<td style="padding:11px 14px;border-bottom:1px solid ' +
      LINE +
      ';vertical-align:top;text-align:right;white-space:nowrap;">' +
      (a.orderCount ? a.orderCount : '<span class="muted">—</span>') +
      '</td>' +
      '<td style="padding:11px 14px;border-bottom:1px solid ' +
      LINE +
      ';vertical-align:top;">' +
      (a.samples.length
        ? a.samples
            .map(function (s) {
              return chip(pickText(s) + (s.count > 1 ? ' ×' + s.count : ''), INK);
            })
            .join(' ')
        : '<span class="muted" style="font-size:12px;">No customer has answered this yet</span>') +
      '</td>' +
      '<td style="padding:11px 14px;border-bottom:1px solid ' +
      LINE +
      ';vertical-align:top;min-width:320px;">' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px;">' +
      (parts.length
        ? parts
            .map(function (p, j) {
              var pattern = p.sku.indexOf('*') !== -1;
              return (
                '<span class="chip" style="font-size:11px;color:' +
                (p.name || pattern ? INK : RED) +
                ';background:#f2f3ef;display:inline-flex;align-items:center;gap:5px;"' +
                ' title="' +
                esc(
                  pattern
                    ? 'Pattern — every part number it matches, e.g. each mat size'
                    : p.name || 'Not in the catalog — check the part number',
                ) +
                '">' +
                esc(p.sku) +
                (pattern ? ' <span class="muted">(pattern)</span>' : '') +
                pieceSelect(i, j, p.piece) +
                '<button type="button" data-pca-remove="' +
                i +
                ':' +
                j +
                '" aria-label="Remove ' +
                esc(p.sku) +
                '" style="border:none;background:none;cursor:pointer;color:' +
                MUTED +
                ';padding:0;font-size:12px;line-height:1;">×</button>' +
                '</span>'
              );
            })
            .join('')
        : '<span class="muted" style="font-size:12px;">No parts</span>') +
      '</div>' +
      '<div style="position:relative;display:flex;gap:6px;align-items:center;">' +
      '<input type="text" data-pca-search="' +
      i +
      '" placeholder="Add a part — number, name, or pattern like R-SSG-*CLM*" autocomplete="off" style="' +
      bomFieldStyle('220px') +
      '">' +
      '<button class="btn" type="button" data-pca-save="' +
      i +
      '" style="width:auto;padding:7px 13px;' +
      (dirty ? '' : 'opacity:.45;') +
      '"' +
      (dirty ? '' : ' disabled') +
      '>Save</button>' +
      (dirty
        ? '<button class="link-btn" type="button" data-pca-revert="' +
          i +
          '" style="width:auto;padding:7px 10px;">Undo</button>'
        : '') +
      '<div data-pca-results="' +
      i +
      '" style="display:none;position:absolute;top:100%;left:0;z-index:40;background:#fff;border:1px solid #e7e8e3;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.08);min-width:340px;max-height:260px;overflow:auto;margin-top:3px;"></div>' +
      '</div>' +
      '</td>' +
      '</tr>'
    );
  }

  function draw() {
    var el = state.el;
    if (!el) return;
    var areas = state.areas;
    var unmappedCount = areas.filter(function (a) {
      return !a.parts.length;
    }).length;
    var shown = [];
    areas.forEach(function (a, i) {
      if (!state.onlyUnmapped || !a.parts.length) shown.push(rowHtml(a, i));
    });
    el.innerHTML =
      addAreaHtml() +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:12.5px;">' +
      '<span><b>' +
      areas.length +
      '</b> area' +
      (areas.length === 1 ? '' : 's') +
      '</span>' +
      (unmappedCount
        ? '<span style="color:' + RED + ';"><b>' + unmappedCount + '</b> unmapped</span>'
        : '<span style="color:#2f6b4c;">every area is mapped</span>') +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-left:auto;">' +
      '<input type="checkbox" id="pcaOnlyUnmapped"' +
      (state.onlyUnmapped ? ' checked' : '') +
      '> Unmapped only' +
      '</label>' +
      '</div>' +
      (areas.length
        ? '<div style="border:1px solid #e7e8e3;border-radius:8px;overflow:visible;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="background:#fafbf9;text-align:left;color:' +
          MUTED +
          ';font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;">' +
          '<th style="padding:9px 14px;font-weight:600;">Area</th>' +
          '<th style="padding:9px 14px;font-weight:600;text-align:right;">Orders</th>' +
          '<th style="padding:9px 14px;font-weight:600;">Customer picks</th>' +
          '<th style="padding:9px 14px;font-weight:600;">Parts it colours</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (shown.join('') ||
            '<tr><td colspan="4" class="muted" style="padding:16px;">Nothing unmapped.</td></tr>') +
          '</tbody>' +
          '</table>' +
          '</div>'
        : '<div class="muted" style="padding:16px;">No customer has answered the portal colour step yet. Areas appear here the first time one is answered, or add one above.</div>');
    wire();
  }

  var searchTimer = null;

  async function search(i, term, box) {
    if (term.length < 2) {
      box.style.display = 'none';
      return;
    }
    var r = await authed('/skus?pageSize=15&q=' + encodeURIComponent(term));
    if (!r.ok) {
      box.style.display = 'none';
      return;
    }
    var d = null;
    try {
      d = await r.json();
    } catch (e) {
      d = null;
    }
    var items = (d && d.items) || [];
    var have = {};
    partsOf(state.areas[i]).forEach(function (p) {
      have[p.sku.toUpperCase()] = true;
    });
    var html = items
      .map(function (it) {
        var added = have[String(it.part).toUpperCase()];
        return (
          '<button type="button" data-pca-add="' +
          esc(it.part) +
          '" data-pca-name="' +
          esc(it.description || '') +
          '"' +
          (added ? ' disabled' : '') +
          ' style="display:block;width:100%;text-align:left;border:none;background:none;padding:8px 12px;cursor:' +
          (added ? 'default' : 'pointer') +
          ';font-family:inherit;font-size:12.5px;border-bottom:1px solid #f2f3ef;' +
          (added ? 'opacity:.45;' : '') +
          '">' +
          '<b style="font-family:monospace;">' +
          esc(it.part) +
          '</b> <span class="muted">' +
          esc(it.description || '') +
          '</span>' +
          (added ? ' <span class="muted">(added)</span>' : '') +
          '</button>'
        );
      })
      .join('');
    // Not in the catalog is allowed — a hand-added BOM line can carry such a part —
    // but offered separately so it is a deliberate choice rather than a stray Enter.
    var exact = items.some(function (it) {
      return String(it.part).toUpperCase() === term.toUpperCase();
    });
    if (!exact && !have[term.toUpperCase()]) {
      html +=
        '<button type="button" data-pca-add="' +
        esc(term) +
        '" data-pca-name="" style="display:block;width:100%;text-align:left;border:none;background:#fafbf9;padding:8px 12px;cursor:pointer;font-family:inherit;font-size:12px;color:' +
        MUTED +
        ';">' +
        'Add “' +
        esc(term) +
        (term.indexOf('*') !== -1
          ? '” as a pattern (every matching part number)'
          : '” (not in the catalog)') +
        '</button>';
    }
    box.innerHTML =
      html || '<div class="muted" style="padding:10px 12px;font-size:12px;">No parts match.</div>';
    box.style.display = 'block';
    box.querySelectorAll('[data-pca-add]').forEach(function (b) {
      b.addEventListener('mousedown', function (ev) {
        // mousedown, not click: the input's blur hides the list before a click lands.
        ev.preventDefault();
        if (b.disabled) return;
        var a = state.areas[i];
        var next = partsOf(a).slice();
        next.push({
          sku: b.getAttribute('data-pca-add'),
          name: b.getAttribute('data-pca-name') || null,
          piece: null,
        });
        state.drafts[a.areaKey] = next;
        draw();
        var input = state.el.querySelector('[data-pca-search="' + i + '"]');
        if (input) input.focus();
      });
    });
  }

  function wire() {
    var el = state.el;
    var addBtn = el.querySelector('#pcaAddArea');
    var addInput = el.querySelector('#pcaNewArea');
    if (addBtn) addBtn.addEventListener('click', addArea);
    if (addInput)
      addInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          addArea();
        }
      });
    var only = el.querySelector('#pcaOnlyUnmapped');
    if (only)
      only.addEventListener('change', function () {
        state.onlyUnmapped = only.checked;
        draw();
      });

    el.querySelectorAll('[data-pca-search]').forEach(function (input) {
      var i = Number(input.getAttribute('data-pca-search'));
      var box = el.querySelector('[data-pca-results="' + i + '"]');
      input.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var term = input.value.trim();
        searchTimer = setTimeout(function () {
          search(i, term, box);
        }, 220);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () {
          box.style.display = 'none';
        }, 120);
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          box.style.display = 'none';
          input.value = '';
        }
      });
    });

    el.querySelectorAll('[data-pca-piece]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var ij = sel.getAttribute('data-pca-piece').split(':');
        var a = state.areas[Number(ij[0])];
        var next = partsOf(a).map(function (p) {
          return { sku: p.sku, name: p.name, piece: p.piece || null };
        });
        var n = sel.value ? Number(sel.value) : null;
        next[Number(ij[1])].piece = n;
        state.drafts[a.areaKey] = next;
        draw();
      });
    });

    el.querySelectorAll('[data-pca-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ij = b.getAttribute('data-pca-remove').split(':');
        var a = state.areas[Number(ij[0])];
        var next = partsOf(a).slice();
        next.splice(Number(ij[1]), 1);
        state.drafts[a.areaKey] = next;
        draw();
      });
    });

    el.querySelectorAll('[data-pca-revert]').forEach(function (b) {
      b.addEventListener('click', function () {
        delete state.drafts[state.areas[Number(b.getAttribute('data-pca-revert'))].areaKey];
        draw();
      });
    });

    el.querySelectorAll('[data-pca-save]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var a = state.areas[Number(b.getAttribute('data-pca-save'))];
        var parts = partsOf(a).map(function (p) {
          return { sku: p.sku, piece: p.piece || null };
        });
        b.disabled = true;
        b.textContent = 'Saving…';
        try {
          var r = await authed('/admin/portal-color-areas/' + encodeURIComponent(a.areaKey), {
            method: 'PUT',
            body: { parts: parts },
          });
          if (!r.ok) {
            toast(await serverMessage(r, 'Could not save (' + r.status + ').'), true);
            draw();
            return;
          }
          var d = await r.json();
          a.parts = d.parts || [];
          delete state.drafts[a.areaKey];
          toast(
            a.label +
              ': ' +
              (a.parts.length
                ? a.parts.length + ' part' + (a.parts.length === 1 ? '' : 's')
                : 'no parts') +
              (d.unknownSkus && d.unknownSkus.length
                ? ' — not in the catalog: ' + d.unknownSkus.join(', ')
                : ''),
            !!(d.unknownSkus && d.unknownSkus.length),
          );
        } catch (e) {
          toast('Could not reach the server.', true);
        }
        draw();
      });
    });
  }

  async function load() {
    var el = state.el;
    var r = await authed('/admin/portal-color-areas');
    if (!r.ok) {
      // A person without catalog administration sees why, rather than a blank panel.
      el.innerHTML =
        '<div class="muted" style="padding:16px;">' +
        esc(
          await serverMessage(
            r,
            r.status === 403
              ? 'Catalog administration is needed to map portal colour areas.'
              : 'Could not load the portal colour areas.',
          ),
        ) +
        '</div>';
      return;
    }
    var d = await r.json();
    state.areas = (d && d.areas) || [];
    state.drafts = {};
    draw();
  }

  window.SSGPortalColorAreas = {
    render: function (el, host) {
      if (!el) return;
      H = host;
      state.el = el;
      el.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
      load().catch(function () {
        el.innerHTML = '<div class="muted" style="padding:16px;">Could not reach the server.</div>';
      });
    },
  };
})();

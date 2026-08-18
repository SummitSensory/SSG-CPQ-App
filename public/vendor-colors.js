/**
 * Vendor colours — the administration screen.
 *
 * A separate file from app.js on purpose, the same arrangement as the freight
 * true-up module: one workflow with one owner (whoever maintains vendor charts),
 * readable and replaceable without touching the 12,000-line shell. It borrows the
 * shell's helpers rather than reimplementing them — see init() — so styling, auth,
 * modals and field sizing stay identical to everything around it.
 *
 * What it maintains, per vendor:
 *   * palettes — one chart per finish. Resilite's vinyl list is one; a vendor who
 *     also sells painted steel gets a second.
 *   * colours  — the named entries on a chart, with the vendor's own code and an
 *     optional upcharge. Named, not typed: "Royal Blue" is a thing Resilite make.
 *   * products — which product takes how many colours (1–7) from which chart.
 *
 * The Goldberg powder-coat chart under Administration → Formulas → Paint colour is
 * untouched and unrelated: a powder coat colour is a paint brand's code and the
 * grouping there belongs to the part, not to the product.
 *
 * Entry point: window.VendorColors.openVendorColors(manufacturer, user)
 */
(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js

  var INK = '#1c4039',
    MUTED = '#8a8f85',
    LINE = '#eceee8',
    SURFACE = '#fbfbf9',
    RED = '#9c3327';

  var MAX_SLOTS = 7;

  var FINISHES = [
    { v: 'VINYL', label: 'Vinyl' },
    { v: 'POWDER_COAT', label: 'Powder coat' },
    { v: 'PAINT', label: 'Paint' },
    { v: 'OTHER', label: 'Other' },
  ];

  function finishLabel(v) {
    for (var i = 0; i < FINISHES.length; i += 1) if (FINISHES[i].v === v) return FINISHES[i].label;
    return 'Other';
  }

  function esc(s) {
    return H.esc(String(s == null ? '' : s));
  }

  /** Minor units → "$25.00". Null is not zero: it is "not priced". */
  function money(minor) {
    if (minor == null || minor === '') return '—';
    var v = (Number(minor) || 0) / 100;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** "25", "$25.00", "" → minor units, null for blank, NaN for nonsense. */
  function toMinor(text) {
    var s = String(text == null ? '' : text).replace(/[$,\s]/g, '');
    if (!s) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function chip(text, color, bg) {
    return (
      '<span class="chip" style="font-size:10.5px;color:' +
      (color || MUTED) +
      ';background:' +
      (bg || '#f2f3ef') +
      ';">' +
      esc(text) +
      '</span>'
    );
  }

  function fieldStyle(w) {
    return H.bomFieldStyle(w || null);
  }

  /** Slot labels for a spec: named where the admin named them, numbered elsewhere. */
  function slotNames(spec) {
    var labels = [];
    var given = spec && spec.slotLabels && spec.slotLabels.length ? spec.slotLabels : [];
    for (var i = 0; i < spec.slotCount; i += 1) {
      var named = given[i] && String(given[i]).trim();
      labels.push(named || 'Colour ' + (i + 1));
    }
    return labels;
  }

  /**
   * One vendor's colour charts.
   *
   * State is held in the closure and redrawn wholesale after every write, which is
   * what the rest of the admin screens do — a chart is tens of rows, not thousands,
   * and a redraw is cheaper to reason about than patching cells in place.
   */
  async function openVendorColors(m, user) {
    var admin = H.canAdmin ? H.canAdmin(user.role) : true;
    var palettes = [];
    var targets = { products: [], parts: [] };
    var loadError = '';
    var msg = '';
    var openId = null; // which palette is expanded
    var busy = false;
    var ov = null;
    var $ = function (sel) {
      return ov ? ov.querySelector(sel) : null;
    };

    function note(text) {
      msg = text || '';
    }

    async function load() {
      var r = await H.authed('/manufacturers/' + m.id + '/color-palettes');
      if (!r.ok) {
        loadError =
          r.status === 404
            ? 'That vendor no longer exists.'
            : 'Could not load the colour charts (' +
              r.status +
              '). Run migration 0056 if this persists — anything already saved is unaffected.';
        palettes = [];
      } else {
        loadError = '';
        var data = await r.json();
        palettes = data.palettes || [];
        if (!openId && palettes.length) openId = palettes[0].id;
      }
      draw();
    }

    async function loadTargets() {
      try {
        var r = await H.authed('/manufacturers/' + m.id + '/color-targets');
        if (r.ok) targets = await r.json();
      } catch (e) {
        /* the picker falls back to a typed part number */
      }
    }

    ov = H.openModal(
      'Colours — ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' +
        'The colours ' +
        esc(m.name) +
        ' publishes, and which of their products take how many of them. A product can take up to seven. ' +
        'Colours are chosen from this chart on the proposal and carried onto the Bill of Materials — the vendor’s own code prints there beside the name and is never shown to a customer.' +
        '</div>' +
        '<div id="vcBody"><div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div></div>',
      null,
      null,
    );

    // ---------------- colour rows ----------------

    function colorRow(c) {
      return (
        '<tr' +
        (c.active ? '' : ' style="opacity:.55;"') +
        '>' +
        H.td(
          admin
            ? '<input class="vcCName" data-id="' +
                c.id +
                '" value="' +
                esc(c.name) +
                '" style="' +
                fieldStyle('170px') +
                '">'
            : '<b style="font-weight:600;">' + esc(c.name) + '</b>',
        ) +
        H.td(
          admin
            ? '<input class="vcCCode" data-id="' +
                c.id +
                '" value="' +
                esc(c.vendorCode || '') +
                '" placeholder="Vendor code" style="' +
                fieldStyle('120px') +
                'font-family:ui-monospace,monospace;">'
            : esc(c.vendorCode || '—'),
        ) +
        H.td(
          admin
            ? '<input class="vcCUp" data-id="' +
                c.id +
                '" value="' +
                (c.upchargeMinor == null ? '' : (c.upchargeMinor / 100).toFixed(2)) +
                '" placeholder="0.00" style="' +
                fieldStyle('90px') +
                'text-align:right;">'
            : money(c.upchargeMinor),
        ) +
        H.td(
          admin
            ? '<input class="vcCOrd" data-id="' +
                c.id +
                '" type="number" value="' +
                (c.sortOrder || 0) +
                '" style="' +
                fieldStyle('72px') +
                '">'
            : String(c.sortOrder || 0),
        ) +
        H.td(
          admin
            ? '<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;cursor:pointer;">' +
                '<input type="checkbox" class="vcCAct" data-id="' +
                c.id +
                '"' +
                (c.active ? ' checked' : '') +
                '> On chart</label>'
            : c.active
              ? 'On chart'
              : chip('Discontinued'),
        ) +
        H.td(
          admin
            ? '<button type="button" class="vcCDel link-btn" data-id="' +
                c.id +
                '" style="width:auto;padding:5px 10px;font-size:12px;color:' +
                RED +
                ';">Remove</button>'
            : '',
        ) +
        '</tr>'
      );
    }

    function specRow(p, s) {
      var target = s.productId
        ? '<b style="font-weight:600;">' +
          esc(s.productName || '(product)') +
          '</b>' +
          (s.productSku
            ? '<div class="muted" style="font-size:11.5px;font-family:ui-monospace,monospace;">' +
              esc(s.productSku) +
              '</div>'
            : '')
        : '<b style="font-weight:600;font-family:ui-monospace,monospace;">' +
          esc(s.sku || '') +
          '</b>' +
          '<div class="muted" style="font-size:11.5px;">Part number</div>';
      var names = slotNames(s);
      return (
        '<tr>' +
        H.td(target) +
        H.td(
          admin
            ? '<select class="vcSCount" data-id="' +
                s.id +
                '" style="' +
                fieldStyle('80px') +
                '">' +
                slotOptions(s.slotCount) +
                '</select>'
            : String(s.slotCount),
        ) +
        H.td(
          '<div style="display:flex;flex-wrap:wrap;gap:5px;">' +
            names
              .map(function (n) {
                return chip(n, INK, '#eef0ea');
              })
              .join('') +
            '</div>' +
            (admin
              ? '<button type="button" class="vcSLabels link-btn" data-id="' +
                s.id +
                '" style="width:auto;padding:3px 8px;font-size:11.5px;margin-top:4px;">Name the slots…</button>'
              : ''),
        ) +
        H.td(
          admin
            ? '<input class="vcSUp" data-id="' +
                s.id +
                '" value="' +
                (s.slotUpchargeMinor == null ? '' : (s.slotUpchargeMinor / 100).toFixed(2)) +
                '" placeholder="0.00" style="' +
                fieldStyle('90px') +
                'text-align:right;">'
            : money(s.slotUpchargeMinor),
        ) +
        H.td(
          admin
            ? '<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;cursor:pointer;">' +
                '<input type="checkbox" class="vcSReq" data-id="' +
                s.id +
                '"' +
                (s.required ? ' checked' : '') +
                '> Required</label>'
            : s.required
              ? 'Required'
              : 'Optional',
        ) +
        H.td(
          admin
            ? '<button type="button" class="vcSDel link-btn" data-id="' +
                s.id +
                '" style="width:auto;padding:5px 10px;font-size:12px;color:' +
                RED +
                ';">Remove</button>'
            : '',
        ) +
        '</tr>'
      );
    }

    function slotOptions(selected) {
      var out = '';
      for (var i = 1; i <= MAX_SLOTS; i += 1)
        out +=
          '<option value="' + i + '"' + (i === selected ? ' selected' : '') + '>' + i + '</option>';
      return out;
    }

    function paletteCard(p) {
      var open = p.id === openId;
      var live = (p.colors || []).filter(function (c) {
        return c.active;
      }).length;
      var head =
        '<div class="vcHead" data-id="' +
        p.id +
        '" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;cursor:pointer;padding:11px 13px;">' +
        '<b style="font-weight:600;font-size:13.5px;color:' +
        INK +
        ';">' +
        esc(p.name) +
        '</b>' +
        chip(finishLabel(p.finishType), INK, '#eef0ea') +
        chip(live + ' colour' + (live === 1 ? '' : 's')) +
        chip((p.specs || []).length + ' product' + ((p.specs || []).length === 1 ? '' : 's')) +
        (p.active ? '' : chip('Inactive')) +
        '<span style="margin-left:auto;font-size:12px;color:' +
        MUTED +
        ';">' +
        (open ? 'Hide' : 'Open') +
        '</span>' +
        '</div>';
      if (!open)
        return (
          '<div style="border:1px solid ' +
          LINE +
          ';border-radius:10px;margin-bottom:9px;background:#fff;">' +
          head +
          '</div>'
        );

      var colorTable = H.tableShell(
        ['Colour', 'Vendor code', 'Upcharge', 'Order', '', ''],
        (p.colors || []).map(colorRow).join(''),
        6,
        'No colours on this chart yet. Add one below, or paste the vendor’s list.',
      );

      var addColour = admin
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;">' +
          '<div><div class="k">Colour</div><input id="vcNewName" placeholder="Royal Blue" style="' +
          fieldStyle('170px') +
          '"></div>' +
          '<div><div class="k">Vendor code</div><input id="vcNewCode" placeholder="Optional" style="' +
          fieldStyle('120px') +
          'font-family:ui-monospace,monospace;"></div>' +
          '<div><div class="k">Upcharge</div><input id="vcNewUp" placeholder="0.00" style="' +
          fieldStyle('90px') +
          'text-align:right;"></div>' +
          '<button type="button" class="btn" id="vcAddColour" style="width:auto;padding:9px 15px;">Add</button>' +
          '<button type="button" class="link-btn" id="vcPaste" style="width:auto;padding:9px 15px;">Paste a chart…</button>' +
          '</div>'
        : '';

      var specTable = H.tableShell(
        ['Product', '# colours', 'Slots', 'Per-slot upcharge', '', ''],
        (p.specs || [])
          .map(function (s) {
            return specRow(p, s);
          })
          .join(''),
        6,
        'No products take colours from this chart yet.',
      );

      var addSpec = admin
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;">' +
          '<div style="flex:1;min-width:220px;"><div class="k">Catalog product</div>' +
          '<select id="vcSpecProduct" style="' +
          fieldStyle() +
          '"><option value="">Choose a product…</option>' +
          (targets.products || [])
            .map(function (pr) {
              return (
                '<option value="' +
                esc(pr.id) +
                '">' +
                esc(pr.name) +
                ' — ' +
                esc(pr.sku) +
                '</option>'
              );
            })
            .join('') +
          '</select></div>' +
          '<div><div class="k">…or a part number</div><input id="vcSpecSku" list="vcPartList" placeholder="A-3204" style="' +
          fieldStyle('150px') +
          'text-transform:uppercase;font-family:ui-monospace,monospace;"></div>' +
          '<div><div class="k"># colours</div><select id="vcSpecCount" style="' +
          fieldStyle('80px') +
          '">' +
          slotOptions(1) +
          '</select></div>' +
          '<div><div class="k">Per-slot upcharge</div><input id="vcSpecUp" placeholder="0.00" style="' +
          fieldStyle('100px') +
          'text-align:right;"></div>' +
          '<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;cursor:pointer;padding-bottom:9px;">' +
          '<input type="checkbox" id="vcSpecReq"> Required to quote</label>' +
          '<button type="button" class="btn" id="vcAddSpec" style="width:auto;padding:9px 15px;">Attach</button>' +
          (targets.parts && targets.parts.length
            ? '<datalist id="vcPartList">' +
              targets.parts
                .map(function (x) {
                  return '<option value="' + esc(x.sku) + '">';
                })
                .join('') +
              '</datalist>'
            : '') +
          '</div>'
        : '';

      return (
        '<div style="border:1px solid ' +
        LINE +
        ';border-radius:10px;margin-bottom:9px;background:#fff;">' +
        head +
        '<div style="padding:0 13px 13px;">' +
        (admin
          ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:2px 0 12px;border-bottom:1px solid ' +
            LINE +
            ';margin-bottom:12px;">' +
            '<div><div class="k">Chart name</div><input class="vcPName" data-id="' +
            p.id +
            '" value="' +
            esc(p.name) +
            '" style="' +
            fieldStyle('190px') +
            '"></div>' +
            '<div><div class="k">Finish</div><select class="vcPFinish" data-id="' +
            p.id +
            '" style="' +
            fieldStyle('130px') +
            '">' +
            FINISHES.map(function (f) {
              return (
                '<option value="' +
                f.v +
                '"' +
                (f.v === p.finishType ? ' selected' : '') +
                '>' +
                f.label +
                '</option>'
              );
            }).join('') +
            '</select></div>' +
            '<div style="flex:1;min-width:180px;"><div class="k">Note</div><input class="vcPNotes" data-id="' +
            p.id +
            '" value="' +
            esc(p.notes || '') +
            '" placeholder="Where the chart came from" style="' +
            fieldStyle() +
            '"></div>' +
            '<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;cursor:pointer;padding-bottom:9px;">' +
            '<input type="checkbox" class="vcPAct" data-id="' +
            p.id +
            '"' +
            (p.active ? ' checked' : '') +
            '> Offered</label>' +
            '<button type="button" class="vcPDel link-btn" data-id="' +
            p.id +
            '" style="width:auto;padding:9px 13px;color:' +
            RED +
            ';">Delete chart</button>' +
            '</div>'
          : '') +
        '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;margin-bottom:7px;">Colours on this chart</div>' +
        '<div style="max-height:36vh;overflow:auto;">' +
        colorTable +
        '</div>' +
        addColour +
        '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;margin:16px 0 7px;">Products that use it</div>' +
        '<div class="muted" style="font-size:11.5px;margin-bottom:7px;">How many colours the customer chooses for one unit. A product with two slots is asked twice; seven is the ceiling.</div>' +
        specTable +
        addSpec +
        '</div>' +
        '</div>'
      );
    }

    function draw() {
      var box = $('#vcBody');
      if (!box) return;
      box.innerHTML =
        (loadError ? '<div class="err">' + esc(loadError) + '</div>' : '') +
        (msg
          ? '<div style="font-size:12.5px;color:#2f7d5d;background:#eef6f0;border:1px solid #d5e7dc;border-radius:8px;padding:8px 11px;margin-bottom:10px;">' +
            esc(msg) +
            '</div>'
          : '') +
        (palettes.length
          ? palettes.map(paletteCard).join('')
          : '<div class="placeholder" style="padding:22px;"><h3>No colour charts yet</h3><p>Add the chart ' +
            esc(m.name) +
            ' publishes, then say which of their products take colours from it.</p></div>') +
        (admin
          ? '<div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid ' +
            LINE +
            ';">' +
            '<button type="button" class="btn" id="vcNewPalette" style="width:auto;padding:9px 15px;">New colour chart</button>' +
            '</div>'
          : '');
      bind();
    }

    // ---------------- writes ----------------

    /**
     * One write. Returns the response body, or null with the reason left in
     * lastError — a dialog shows it inline through its own fail(), the main screen
     * alerts, and neither has to parse an error shape of its own.
     */
    var lastError = '';

    async function send(path, method, body, okMsg) {
      if (busy) return null;
      busy = true;
      lastError = '';
      try {
        var r = await H.authed(path, { method: method, body: body });
        if (!r.ok) {
          var text = '';
          try {
            var j = await r.json();
            text = j.message || j.error || '';
          } catch (e) {}
          lastError = text || 'That did not save (' + r.status + ').';
          note('');
          return null;
        }
        note(okMsg || '');
        return r.status === 204 ? {} : await r.json();
      } finally {
        busy = false;
      }
    }

    /** A write from the main screen, where there is no inline error slot. */
    async function sendLoud(path, method, body, okMsg) {
      var r = await send(path, method, body, okMsg);
      if (!r && lastError) alert(lastError);
      return r;
    }

    function bind() {
      var box = $('#vcBody');
      if (!box) return;

      box.querySelectorAll('.vcHead').forEach(function (h) {
        h.addEventListener('click', function () {
          var id = h.getAttribute('data-id');
          openId = openId === id ? null : id;
          note('');
          draw();
        });
      });

      var newBtn = $('#vcNewPalette');
      if (newBtn) newBtn.addEventListener('click', newPalette);

      // Palette header fields save on blur, which is what the rest of the admin
      // screens do — no save button to forget.
      box.querySelectorAll('.vcPName, .vcPNotes').forEach(function (el) {
        el.addEventListener('blur', async function () {
          var field = el.classList.contains('vcPName') ? 'name' : 'notes';
          var body = {};
          body[field] = el.value.trim();
          if (field === 'name' && !body.name) return;
          await sendLoud('/color-palettes/' + el.getAttribute('data-id'), 'PATCH', body);
          await load();
        });
      });
      box.querySelectorAll('.vcPFinish').forEach(function (el) {
        el.addEventListener('change', async function () {
          await sendLoud('/color-palettes/' + el.getAttribute('data-id'), 'PATCH', {
            finishType: el.value,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcPAct').forEach(function (el) {
        el.addEventListener('change', async function () {
          await sendLoud('/color-palettes/' + el.getAttribute('data-id'), 'PATCH', {
            active: el.checked,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcPDel').forEach(function (el) {
        el.addEventListener('click', async function () {
          if (!confirm('Delete this colour chart? Products using it must be detached first.'))
            return;
          await sendLoud(
            '/color-palettes/' + el.getAttribute('data-id'),
            'DELETE',
            undefined,
            'Chart deleted.',
          );
          openId = null;
          await load();
        });
      });

      // Colours.
      box.querySelectorAll('.vcCName, .vcCCode, .vcCUp, .vcCOrd').forEach(function (el) {
        el.addEventListener('blur', async function () {
          var id = el.getAttribute('data-id');
          var body = {};
          if (el.classList.contains('vcCName')) {
            if (!el.value.trim()) return;
            body.name = el.value.trim();
          } else if (el.classList.contains('vcCCode')) {
            body.vendorCode = el.value.trim();
          } else if (el.classList.contains('vcCOrd')) {
            body.sortOrder = parseInt(el.value, 10) || 0;
          } else {
            var minor = toMinor(el.value);
            if (isNaN(minor)) {
              alert('An upcharge has to be an amount like 25 or 25.00.');
              return;
            }
            body.upchargeMinor = minor;
          }
          await sendLoud('/vendor-colors/' + id, 'PATCH', body);
          await load();
        });
      });
      box.querySelectorAll('.vcCAct').forEach(function (el) {
        el.addEventListener('change', async function () {
          await sendLoud('/vendor-colors/' + el.getAttribute('data-id'), 'PATCH', {
            active: el.checked,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcCDel').forEach(function (el) {
        el.addEventListener('click', async function () {
          if (
            !confirm(
              'Remove this colour from the chart? Lines that already carry it keep reading correctly — untick “On chart” instead if it is merely discontinued.',
            )
          )
            return;
          await sendLoud(
            '/vendor-colors/' + el.getAttribute('data-id'),
            'DELETE',
            undefined,
            'Colour removed.',
          );
          await load();
        });
      });

      var addColour = $('#vcAddColour');
      if (addColour)
        addColour.addEventListener('click', async function () {
          var name = ($('#vcNewName') || {}).value || '';
          if (!name.trim()) {
            alert('Give the colour the name the vendor uses.');
            return;
          }
          var up = toMinor(($('#vcNewUp') || {}).value || '');
          if (isNaN(up)) {
            alert('An upcharge has to be an amount like 25 or 25.00.');
            return;
          }
          var r = await sendLoud(
            '/color-palettes/' + openId + '/colors',
            'POST',
            {
              name: name.trim(),
              vendorCode: (($('#vcNewCode') || {}).value || '').trim(),
              upchargeMinor: up,
            },
            'Added ' + name.trim() + '.',
          );
          if (r) await load();
        });

      var paste = $('#vcPaste');
      if (paste) paste.addEventListener('click', openPaste);

      // Product rules.
      box.querySelectorAll('.vcSCount').forEach(function (el) {
        el.addEventListener('change', async function () {
          await sendLoud('/product-color-specs/' + el.getAttribute('data-id'), 'PATCH', {
            slotCount: parseInt(el.value, 10) || 1,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcSReq').forEach(function (el) {
        el.addEventListener('change', async function () {
          await sendLoud('/product-color-specs/' + el.getAttribute('data-id'), 'PATCH', {
            required: el.checked,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcSUp').forEach(function (el) {
        el.addEventListener('blur', async function () {
          var minor = toMinor(el.value);
          if (isNaN(minor)) {
            alert('An upcharge has to be an amount like 25 or 25.00.');
            return;
          }
          await sendLoud('/product-color-specs/' + el.getAttribute('data-id'), 'PATCH', {
            slotUpchargeMinor: minor,
          });
          await load();
        });
      });
      box.querySelectorAll('.vcSDel').forEach(function (el) {
        el.addEventListener('click', async function () {
          if (!confirm('Stop asking for colours on this product?')) return;
          await sendLoud(
            '/product-color-specs/' + el.getAttribute('data-id'),
            'DELETE',
            undefined,
            'Detached.',
          );
          await load();
        });
      });
      box.querySelectorAll('.vcSLabels').forEach(function (el) {
        el.addEventListener('click', function () {
          openSlotLabels(el.getAttribute('data-id'));
        });
      });

      var addSpec = $('#vcAddSpec');
      if (addSpec)
        addSpec.addEventListener('click', async function () {
          var productId = (($('#vcSpecProduct') || {}).value || '').trim();
          var sku = (($('#vcSpecSku') || {}).value || '').trim();
          if (!productId && !sku) {
            alert('Choose a catalog product, or type the part number the colours apply to.');
            return;
          }
          if (productId && sku) {
            alert('Attach the colours to a catalog product or to a part number, not both.');
            return;
          }
          var up = toMinor(($('#vcSpecUp') || {}).value || '');
          if (isNaN(up)) {
            alert('A per-slot upcharge has to be an amount like 25 or 25.00.');
            return;
          }
          var r = await sendLoud(
            '/product-color-specs',
            'POST',
            {
              paletteId: openId,
              productId: productId || null,
              sku: productId ? null : sku.toUpperCase(),
              slotCount: parseInt(($('#vcSpecCount') || {}).value || '1', 10) || 1,
              required: !!($('#vcSpecReq') || {}).checked,
              slotUpchargeMinor: up,
            },
            'Attached.',
          );
          if (r) await load();
        });
    }

    /**
     * A new chart for this vendor.
     *
     * Every lookup is scoped to the dialog's own overlay. openModal returns it for
     * exactly this reason: two stacked dialogs share the ids #mSave and #mErr, and
     * document.getElementById would hand back the older one.
     */
    function newPalette() {
      var sub = H.openModal(
        'New colour chart — ' + m.name,
        '<div style="display:grid;gap:11px;">' +
          '<div><div class="k">Chart name</div><input id="vcPNewName" placeholder="2026 Vinyl Chart" style="' +
          fieldStyle() +
          '"></div>' +
          '<div><div class="k">Finish</div><select id="vcPNewFinish" style="' +
          fieldStyle() +
          '">' +
          FINISHES.map(function (f) {
            return '<option value="' + f.v + '">' + f.label + '</option>';
          }).join('') +
          '</select></div>' +
          '<div><div class="k">Note</div><input id="vcPNewNotes" placeholder="Optional — where the chart came from" style="' +
          fieldStyle() +
          '"></div>' +
          '</div>',
        async function (close, fail) {
          var name = (sub.querySelector('#vcPNewName').value || '').trim();
          if (!name) return fail('Give the chart a name.');
          var r = await send(
            '/manufacturers/' + m.id + '/color-palettes',
            'POST',
            {
              name: name,
              finishType: sub.querySelector('#vcPNewFinish').value || 'VINYL',
              notes: sub.querySelector('#vcPNewNotes').value || '',
            },
            'Chart added. Now add the colours on it.',
          );
          if (!r) return fail(lastError);
          openId = r.id;
          close();
          await load();
        },
        'Add chart',
      );
    }

    /**
     * Name the slots. Optional: unnamed slots read "Colour 1…N", which is enough for
     * a mat whose panels are interchangeable and not enough for one where the border
     * and the surface are different decisions.
     */
    function openSlotLabels(specId) {
      var spec = null;
      palettes.forEach(function (p) {
        (p.specs || []).forEach(function (x) {
          if (x.id === specId) spec = x;
        });
      });
      if (!spec) return;
      var names = slotNames(spec);
      var given = spec.slotLabels && spec.slotLabels.length ? spec.slotLabels : [];
      var rows = '';
      for (var i = 0; i < spec.slotCount; i += 1)
        rows +=
          '<div><div class="k">Slot ' +
          (i + 1) +
          '</div><input class="vcSlotName" data-i="' +
          i +
          '" value="' +
          esc(given[i] || '') +
          '" placeholder="' +
          esc(names[i]) +
          '" style="' +
          fieldStyle() +
          '"></div>';
      var sub = H.openModal(
        'Name the colour slots',
        '<div class="muted" style="font-size:12.5px;margin-bottom:11px;">Leave a slot blank to keep the numbered label. Names appear on the proposal and on the Bill of Materials.</div>' +
          '<div style="display:grid;gap:10px;">' +
          rows +
          '</div>',
        async function (close, fail) {
          var labels = [];
          sub.querySelectorAll('.vcSlotName').forEach(function (el) {
            labels[parseInt(el.getAttribute('data-i'), 10)] = el.value.trim();
          });
          var any = labels.some(function (l) {
            return !!l;
          });
          var r = await send(
            '/product-color-specs/' + specId,
            'PATCH',
            { slotLabels: any ? labels : null },
            'Slot names saved.',
          );
          if (!r) return fail(lastError);
          close();
          await load();
        },
        'Save',
      );
    }

    /**
     * Paste the vendor's chart. One colour per line — name, optional vendor code,
     * optional upcharge — comma or tab separated, so a paste out of a PDF chart or a
     * spreadsheet column lands the same way.
     *
     * The first press previews and the second writes, the same two-step the vendor
     * part numbers and the paint chart use: a paste that turns out to have read a
     * price column as a colour name should be visible before it is saved.
     */
    function openPaste() {
      var paletteId = openId;
      var confirmed = false;
      var sub = H.openModal(
        'Paste a colour chart',
        '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:10px;">' +
          'One colour per line: <b>name</b>, then optionally the vendor’s code and an upcharge.<br>' +
          '<span style="font-family:ui-monospace,monospace;font-size:11.5px;">Royal Blue, RB-124, 25.00</span><br>' +
          'Colours already on the chart are updated rather than duplicated, and the paste sets their order.' +
          '</div>' +
          '<textarea id="vcPasteText" rows="10" style="' +
          fieldStyle() +
          'resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px;"></textarea>' +
          '<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;margin-top:9px;cursor:pointer;">' +
          '<input type="checkbox" id="vcPasteRetire"> Mark colours missing from this paste as discontinued</label>' +
          '<div id="vcPastePreview" style="margin-top:10px;"></div>',
        async function (close, fail) {
          var text = sub.querySelector('#vcPasteText').value || '';
          if (!text.trim()) return fail('Paste the chart first.');
          var retire = !!sub.querySelector('#vcPasteRetire').checked;

          if (!confirmed) {
            var dry = await send('/color-palettes/' + paletteId + '/colors/import', 'POST', {
              text: text,
              dryRun: true,
              retireMissing: retire,
            });
            if (!dry) return fail(lastError);
            confirmed = true;
            sub.querySelector('#vcPastePreview').innerHTML =
              '<div style="background:' +
              SURFACE +
              ';border:1px solid ' +
              LINE +
              ';border-radius:9px;padding:10px 12px;font-size:12.5px;line-height:1.6;">' +
              '<b>' +
              dry.created.length +
              '</b> new, <b>' +
              dry.updated.length +
              '</b> updated' +
              (retire ? ', <b>' + dry.retired.length + '</b> to discontinue' : '') +
              (dry.skipped.length
                ? '<div style="color:' +
                  RED +
                  ';margin-top:5px;">' +
                  dry.skipped.length +
                  ' line' +
                  (dry.skipped.length === 1 ? '' : 's') +
                  ' could not be read: ' +
                  esc(dry.skipped.slice(0, 3).join(' | ')) +
                  '</div>'
                : '') +
              '<div class="muted" style="margin-top:5px;">Press Import again to write it.</div>' +
              '</div>';
            // Re-enable the button the shell disabled for the request: this pass was
            // a preview, and the write is the next press.
            var save = sub.querySelector('#mSave');
            save.disabled = false;
            save.textContent = 'Import';
            return;
          }

          var r = await send(
            '/color-palettes/' + paletteId + '/colors/import',
            'POST',
            { text: text, retireMissing: retire },
            'Chart imported.',
          );
          if (!r) return fail(lastError);
          close();
          await load();
        },
        'Import',
      );
    }

    await loadTargets();
    await load();
  }

  window.VendorColors = {
    /**
     * Borrow the shell's helpers. Everything this module needs from app.js, named
     * explicitly — so what it depends on is a list, not a search.
     */
    init: function (host) {
      H = host;
    },
    openVendorColors: openVendorColors,
    /** Exposed for the proposal editor and the BOM sheet. */
    slotNames: slotNames,
    money: money,
    toMinor: toMinor,
    MAX_SLOTS: MAX_SLOTS,
  };
})();

// Vendor part numbers — window.SSGVendorParts.
//
// What a vendor calls a part we sell under our own number: the per-vendor dialog, the
// bulk paste importer, and the export of every mapping as one sheet. Lifted out of
// public/app.js under AUD-003.
//
// Why it is its own file
// ---------------------
// The dialog lived in the Catalog section of app.js and Administration called it, from
// about ten thousand lines further down. That is the exact mirror of the standard-notes
// panel, which lived in Administration and was called from Catalog — the same defect
// twice, in opposite directions, and between them the only thing left coupling those two
// screens to each other.
//
// Neither screen owns this dialog. Both open it. So it belongs to neither, and with this
// and the notes panel out, the Catalog screen can be lifted into its own file with one
// entry point and one injected dependency.
//
// What it needs
// -------------
// Nine primitives off window.SSGUI, bound below under their original names, and `authed`
// from the shell. Binding them as bare names rather than calling SSGUI.esc(...) is what
// let the 270 lines beneath move VERBATIM — not retyped, not reformatted, so the diff
// can be read as the move it is. ssg-ui.js is the first script in index.html and
// client-scripts.test.ts asserts it, so reading the globals at load is safe.
//
// The export and the paste importer are two halves of one round trip, which is why they
// are in here together: export every mapping, correct it in a spreadsheet, copy one
// vendor's rows, paste them into that vendor's dialog. The importer is per-vendor by
// design and will not read the manufacturer column, which is why that column leads and
// the three the importer wants sit together at the end.

(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js

  // Bound at load, under their original names, so everything below is unchanged.
  var U = window.SSGUI;
  var esc = U.esc,
    td = U.td,
    tableShell = U.tableShell,
    openModal = U.openModal,
    IN = U.IN,
    bomFieldStyle = U.bomFieldStyle,
    downloadCsv = U.downloadCsv,
    todayISO = U.todayISO,
    serverMessage = U.serverMessage;

  /** The shell's fetch, with its session and its one refresh-retry on 401. */
  function authed(path, opts) {
    return H.authed(path, opts);
  }

  /** The vendor-number sheet's columns, in the order the paste importer reads them. */
  var VENDOR_PART_COLUMNS = ['Our part', 'Vendor part', 'Description'];

  /**
   * Every vendor number on record, as one sheet.
   *
   * `Manufacturer` leads so a sheet spanning vendors can be read and filtered;
   * the three columns after it are exactly what the paste importer expects, in its
   * order, so the round trip is: export, correct it in a spreadsheet, copy one
   * vendor's rows, paste them into that vendor's dialog. The importer is
   * per-vendor by design — it will not read the manufacturer column — so the
   * copy has to be of the last three, which is why they sit together at the end.
   */
  async function exportAllVendorParts(btn) {
    var was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    var r = await authed('/vendor-parts/export');
    btn.disabled = false; btn.textContent = was;
    if (!r.ok) { alert(await serverMessage(r, 'Could not export the part numbers (' + r.status + ').')); return; }
    var d = await r.json();
    var items = (d && d.items) || [];
    if (!items.length) { alert('There are no vendor part numbers on record yet.'); return; }
    downloadCsv('vendor-part-numbers-' + todayISO() + '.csv',
      [['Manufacturer'].concat(VENDOR_PART_COLUMNS).concat(['Active'])].concat(
        items.map(function (x) {
          return [x.manufacturer, x.ourPart, x.vendorPart, x.description, x.active];
        })));
  }
  /**
   * What a vendor calls a part we sell under our own number.
   *
   * The Adventure mats are the case this was built for: the configurator generates
   * R-SSG-1010CLM when a size is chosen, that number goes on the proposal and the
   * customer knows the pad by it, and Resilite sell the same pad as A-3204. Both are
   * kept — the proposal prints ours, the Bill of Materials prints both — so nothing
   * here is ever seen by a customer.
   *
   * Mat numbers are generated at price time and have no catalog row, so a mapping
   * can be typed for any part number, catalog or not.
   */
  async function openVendorParts(m, user) {
    if (!m) return;
    var rows = [];
    var busy = false;
    var loadError = '';
    // Held across a redraw, so the confirmation for a row that was just added is
    // still on screen beside it rather than wiped by the render that shows it.
    var pendingMsg = '';
    var ov = null;
    // Scoped to this overlay: a stacked dialog must not be reachable by id.
    var $ = function (sel) { return ov ? ov.querySelector(sel) : null; };

    var load = async function () {
      var r = await authed('/manufacturers/' + m.id + '/vendor-parts');
      if (!r.ok) {
        // Saying so matters more than it looks. A failed reload used to leave an
        // empty table, which reads as "nothing saved" when the rows are sitting in
        // the database.
        loadError = 'Could not load the list (' + r.status + '). Numbers already on record are unaffected.';
        rows = [];
      } else {
        loadError = '';
        rows = await r.json();
      }
      draw();
    };

    ov = openModal('Vendor part numbers — ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' +
        'Our part number on the left, ' + esc(m.name) + '&rsquo;s on the right. The vendor&rsquo;s number prints on the Bill of Materials beside ours and appears nowhere a customer can see. ' +
        'A part with no entry here keeps our number on the sheet.</div>' +
      '<div id="vpBody"><div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div></div>',
      null, null);

    function row(x) {
      return '<tr>' +
        td('<input class="vpOur" data-id="' + x.id + '" value="' + esc(x.ourPart) + '" style="' + bomFieldStyle('150px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;">') +
        td('<input class="vpTheirs" data-id="' + x.id + '" value="' + esc(x.vendorPart) + '" style="' + bomFieldStyle('150px') + 'font-family:ui-monospace,monospace;">') +
        td('<input class="vpDesc" data-id="' + x.id + '" value="' + esc(x.description || '') + '" placeholder="Optional note" style="' + bomFieldStyle('200px') + '">') +
        td('<button type="button" class="vpDel link-btn" data-id="' + x.id + '" style="width:auto;padding:5px 10px;font-size:12px;color:#a2402f;">Remove</button>') +
        '</tr>';
    }

    function draw() {
      var box = $('#vpBody');
      if (!box) return;
      box.innerHTML =
        (loadError ? '<div class="err">' + esc(loadError) + '</div>' : '') +
        '<div style="max-height:46vh;overflow:auto;">' +
          tableShell(['Our part #', esc(m.name) + ' part #', 'Note', ''], rows.map(row).join(''), 4,
            'No vendor numbers yet. Add one below, or paste a list.') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid #eceee8;">' +
          '<div><div class="k">Our part #</div><input id="vpNewOur" placeholder="R-SSG-1010CLM" style="' + bomFieldStyle('160px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;"></div>' +
          '<div><div class="k">Their part #</div><input id="vpNewTheirs" placeholder="A-3204" style="' + bomFieldStyle('150px') + 'font-family:ui-monospace,monospace;"></div>' +
          '<div style="flex:1;min-width:160px;"><div class="k">Note</div><input id="vpNewDesc" placeholder="Optional" style="' + bomFieldStyle() + '"></div>' +
          '<button type="button" class="btn" id="vpAdd" style="width:auto;padding:9px 15px;">Add</button>' +
          '<button type="button" class="link-btn" id="vpPaste" style="width:auto;padding:9px 15px;">Paste a list…</button>' +
          '<button type="button" class="link-btn" id="vpExport" style="width:auto;padding:9px 15px;">Export…</button>' +
        '</div>' +
        '<div id="vpMsg" class="muted" style="font-size:12px;margin-top:8px;"></div>';

      var msg = function (t, bad) {
        var el = $('#vpMsg');
        if (el) { el.style.color = bad ? '#9c3327' : '#5c6157'; el.textContent = t; }
      };

      var patch = async function (el, field) {
        if (busy) return;
        var body = {};
        body[field] = el.value.trim();
        if (field !== 'description' && !body[field]) { msg('A part number cannot be blank.', 1); load(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/vendor-parts/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { msg(await serverMessage(r, 'Could not save that (' + r.status + ').'), 1); return; }
        msg('Saved.');
      };
      box.querySelectorAll('.vpOur').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'ourPart'); }); });
      box.querySelectorAll('.vpTheirs').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'vendorPart'); }); });
      box.querySelectorAll('.vpDesc').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'description'); }); });

      box.querySelectorAll('.vpDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Remove this vendor number?\n\nThe part keeps our number on the Bill of Materials.')) return;
          var r = await authed('/vendor-parts/' + b.getAttribute('data-id'), { method: 'DELETE' });
          if (!r.ok && r.status !== 204) { msg('Could not remove that (' + r.status + ').', 1); return; }
          load();
        });
      });

      var addBtn = $('#vpAdd');
      var add = async function () {
        if (busy) return;
        var ourEl = $('#vpNewOur'), theirsEl = $('#vpNewTheirs'), descEl = $('#vpNewDesc');
        var ourPart = ourEl.value.trim().toUpperCase();
        var vendorPart = theirsEl.value.trim();
        if (!ourPart || !vendorPart) {
          msg('Both part numbers are needed.', 1);
          (ourPart ? theirsEl : ourEl).focus();
          return;
        }
        busy = true;
        addBtn.disabled = true; addBtn.textContent = 'Adding…';
        var r = await authed('/manufacturers/' + m.id + '/vendor-parts', {
          method: 'POST',
          body: { ourPart: ourPart, vendorPart: vendorPart, description: descEl.value.trim() },
        });
        busy = false;
        addBtn.disabled = false; addBtn.textContent = 'Add';
        if (!r.ok) {
          // 409 is the useful one: this vendor already has a number for that part and
          // the server names it. What was typed is left alone so it can be corrected.
          msg(await serverMessage(r, 'Could not add that (' + r.status + ').'), 1);
          return;
        }
        ourEl.value = ''; theirsEl.value = ''; descEl.value = '';
        pendingMsg = 'Added ' + ourPart + ' → ' + vendorPart + '.';
        await load();
        // Straight back to the first field: these are entered a dozen at a time.
        var next = $('#vpNewOur');
        if (next) next.focus();
      };
      addBtn.addEventListener('click', add);

      // Enter in any of the three fields adds the row. This dialog has no submit of
      // its own, so Enter previously did nothing.
      [$('#vpNewOur'), $('#vpNewTheirs'), $('#vpNewDesc')].forEach(function (el) {
        if (!el) return;
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); add(); }
        });
      });

      $('#vpPaste').addEventListener('click', function () { openVendorPartPaste(m, load); });

      // Built from the rows already on screen rather than a second request: this is
      // the list the operator is looking at, and exporting something that differs
      // from it would be worse than not offering the button.
      $('#vpExport').addEventListener('click', function () {
        if (!rows.length) { msg('There is nothing to export yet.', 1); return; }
        var slug = String(m.name || 'vendor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // The header is worded so the importer's own header check skips it — the
        // sheet can be pasted back whole, without deleting the first line.
        downloadCsv('vendor-part-numbers-' + slug + '-' + todayISO() + '.csv',
          [VENDOR_PART_COLUMNS].concat(rows.map(function (x) {
            return [x.ourPart, x.vendorPart, x.description || ''];
          })));
        msg(rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' exported.');
      });

      if (pendingMsg) { msg(pendingMsg); pendingMsg = ''; }
    }

    load();
  }

  /**
   * Bulk load. A vendor with a number for every mat size has dozens of rows, and a
   * mapping typed one row at a time is a mapping that ends up half-loaded. The
   * paste is checked before anything is written, so the count and any clash are
   * seen first.
   */
  function openVendorPartPaste(m, done) {
    var pv = openModal('Paste part numbers — ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:10px;">' +
        'One row per part: our number, then theirs, separated by a tab or a comma. A third column is kept as a note. ' +
        'Paste straight out of a spreadsheet — including the header row, which is skipped. ' +
        'To correct numbers already on record, use <b>Export…</b> first and edit that sheet.</div>' +
      '<textarea id="vpText" rows="10" placeholder="R-SSG-1010CLM&#9;A-3204&#10;R-SSG-1012CLM&#9;A-3205" style="' + IN + 'resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px;"></textarea>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;cursor:pointer;">' +
        '<input type="checkbox" id="vpOverwrite"> Replace numbers already on record</label>' +
      '<div id="vpPreview" class="muted" style="font-size:12.5px;line-height:1.6;margin-top:10px;"></div>',
      async function (close, showErr) {
        var text = pv.querySelector('#vpText').value;
        if (!text.trim()) return showErr('Nothing pasted.');
        var overwrite = pv.querySelector('#vpOverwrite').checked;
        var pre = pv.querySelector('#vpPreview');

        // First press checks, second press writes — the same two-step the catalog
        // import uses, so the count is seen before anything lands.
        if (!pre.getAttribute('data-checked')) {
          var rc = await authed('/manufacturers/' + m.id + '/vendor-parts/import', {
            method: 'POST', body: { text: text, dryRun: true, overwrite: overwrite },
          });
          if (!rc.ok) return showErr(await serverMessage(rc, 'Could not read that list (' + rc.status + ').'));
          var d = await rc.json();
          pre.innerHTML =
            '<b style="color:#3d4a55;">' + d.parsed + ' row' + (d.parsed === 1 ? '' : 's') + ' read.</b> ' +
            d.created + ' to add, ' + d.updated + ' to update, ' + d.skipped + ' unchanged or skipped.' +
            ((d.conflicts || []).length
              ? '<div style="margin-top:6px;color:#8a6d1f;">Already on record and left alone: ' +
                d.conflicts.slice(0, 6).map(function (c) { return esc(c.ourPart) + ' (' + esc(c.current) + ' → ' + esc(c.incoming) + ')'; }).join(', ') +
                ((d.conflicts || []).length > 6 ? ' and ' + (d.conflicts.length - 6) + ' more' : '') +
                '. Tick the box above to replace them.</div>'
              : '') +
            ((d.errors || []).length ? '<div style="margin-top:6px;color:#9c3327;">' + d.errors.map(esc).join('<br>') + '</div>' : '') +
            '<div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
              '<button type="button" class="link-btn" id="vpReport" style="width:auto;padding:6px 12px;font-size:12.5px;">Download this check</button>' +
              '<span>Press Import again to write these.</span>' +
            '</div>';
          // The counts answer "did it read my list"; the report answers "what
          // happened to MY part", which is the question asked the week after.
          var rep = pv.querySelector('#vpReport');
          if (rep) rep.addEventListener('click', function () {
            downloadCsv('vendor-part-check-' + todayISO() + '.csv',
              [['Our part', 'Vendor part', 'Currently on record', 'Note', 'Outcome']].concat(
                (d.rows || []).map(function (x) {
                  return [x.ourPart, x.vendorPart, x.current, x.description, x.outcome];
                })));
          });
          pre.setAttribute('data-checked', '1');
          return;
        }

        var r = await authed('/manufacturers/' + m.id + '/vendor-parts/import', {
          method: 'POST', body: { text: text, overwrite: overwrite },
        });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not import (' + r.status + ').'));
        close();
        if (done) done();
      }, 'Import');

    // Any edit invalidates the check, so the two presses always describe the same
    // text.
    var t = pv.querySelector('#vpText'), o = pv.querySelector('#vpOverwrite');
    var reset = function () { var p = pv.querySelector('#vpPreview'); if (p) { p.removeAttribute('data-checked'); p.innerHTML = ''; } };
    if (t) t.addEventListener('input', reset);
    if (o) o.addEventListener('change', reset);
  }
  window.SSGVendorParts = {
    /** `authed` from the shell. Called once during boot. */
    init: function (host) {
      H = host;
    },
    /** The per-vendor dialog. `m` is a manufacturer row. */
    open: openVendorParts,
    /** Every mapping on record, as one CSV. `btn` is the button to disable while it runs. */
    exportAll: exportAllVendorParts,
    /** The columns the paste importer reads, in its order. */
    COLUMNS: VENDOR_PART_COLUMNS,
  };
})();

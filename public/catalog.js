// The Catalog screen — window.SSGCatalog.
//
// Six tabs: the merged Product + SKU list, the product tree, bundles, manufacturers,
// BOM build, and proposal notes. Plus the SKU/pricing editor with its Excel and CSV
// import, the product-tree workbook round trip, and the change-history dialog. Lifted
// out of public/app.js under AUD-003.
//
// This is the extraction the whole shared-primitives exercise was for. It was measured
// before step 1 and needed twenty-one things from the shell, seventeen of which were UI
// primitives every other screen also needed. After ssg-ui.js, and after the standard-
// notes panel and the vendor-parts dialog were rehoused into files of their own, it
// needs exactly two: `authed`, injected below, and `canCatalogAdmin`, which came with it
// because all ten of its call sites were in here.
//
// One entry point
// ---------------
// `render(user)`. Eighty-six top-level names live in here and eighty-five of them are
// referenced nowhere else in the application — including `openHistory`, which reads like
// a general facility and is only ever opened from this screen's History button.
//
// Three apparent dependencies were phantoms, and each was checked by eye rather than
// trusted: `cat` looks exported but the hits outside are a local
// `var cat = Number(p.catalogCostMinor)` in the Bill of Materials; `rep` looks needed but
// the matches are the word "rep" inside description strings; and `m`, `ov`, `q`, `t`,
// `lines` and `opts` are ordinary locals that collide with names declared elsewhere. An
// identifier scan finds candidates. It does not tell you which are real.
//
// What it needs
// -------------
// Sixteen primitives off window.SSGUI, bound below under their original names, and
// `authed` from the shell through a three-line shim. That is what let the 2,451 lines
// beneath move VERBATIM — brace-, paren- and bracket-balanced against the original — so
// the diff reads as the move it is rather than as a rewrite. ssg-ui.js is the first
// script in index.html and client-scripts.test.ts asserts it, so reading the globals at
// load is safe.
//
// The two panels this screen shares with Administration are NOT in here. Proposal notes
// is ssg-standard-notes.js and the vendor-parts dialog is ssg-vendor-parts.js, both
// reached through their own globals. That was the point of moving them first: those two
// couplings ran in opposite directions and were the only things tying this screen to
// Administration.

(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js

  // Bound at load, under their original names, so everything below is unchanged.
  var U = window.SSGUI;
  var esc = U.esc,
    titleCase = U.titleCase,
    td = U.td,
    tableShell = U.tableShell,
    fieldRow = U.fieldRow,
    selectEl = U.selectEl,
    IN = U.IN,
    bomFieldStyle = U.bomFieldStyle,
    openModal = U.openModal,
    toast = U.toast,
    fmtMoney = U.fmtMoney,
    // NOT money: the merged-list renderer declares its own local `money` for the
    // two-decimal, em-dash-for-null form it wants, so the SSGUI one is shadowed
    // everywhere and binding it here is a dead variable. ESLint's no-unused-vars caught
    // that on the pre-commit hook, which is what promoting this file to 'error' is for.
    costMoney = U.costMoney,
    d2m = U.d2m,
    todayISO = U.todayISO,
    downloadCsv = U.downloadCsv;

  /** The shell's fetch, with its session and its one refresh-retry on 401. */
  function authed(path, opts) {
    return H.authed(path, opts);
  }

  /** Moved with the screen: all ten call sites were in here, and it is pure. */
  function canCatalogAdmin(role) {
    return role === 'SYSTEM_ADMIN';
  }

  /* --- Catalog --- */
  var cat = { q: '', status: '', page: 1, tab: 'items', rows: [], filters: {}, sort: { key: 'sku', dir: 'asc' } };
  var catCategories = [];
  var KINDS = ['PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE'];
  var STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
  function catById(id) { return catCategories.filter(function (x) { return x.id === id; })[0] || null; }
  function catName(id) { var c = catById(id); return c ? c.name : '—'; }
  /** Full tier path for a category, e.g. ["Adventure Series", "Zip Line", "Complete Zip Line Kit"]. */
  function catPath(id) {
    var out = [], seen = {}, c = catById(id);
    while (c && !seen[c.id]) { seen[c.id] = 1; out.unshift(c); c = c.parentId ? catById(c.parentId) : null; }
    return out;
  }
  function catPathLabel(id, sep) {
    var p = catPath(id);
    return p.length ? p.map(function (c) { return c.name; }).join(sep || ' › ') : '—';
  }
  /** Categories ordered by their path, for an indented picker. */
  function catOptionsTree(selectedId) {
    var rows = catCategories.map(function (c) {
      var p = catPath(c.id);
      return { id: c.id, depth: Math.max(0, p.length - 1), sortKey: p.map(function (x) { return x.name.toLowerCase(); }).join(' / '), name: c.name, tier: c.tierLevel || p.length };
    }).sort(function (a, b) { return a.sortKey.localeCompare(b.sortKey); });
    return rows.map(function (r) {
      var pad = '';
      for (var i = 0; i < r.depth; i++) pad += '\u00a0\u00a0\u00a0';
      return '<option value="' + r.id + '"' + (r.id === selectedId ? ' selected' : '') + '>' + pad + esc(r.name) + ' · tier ' + r.tier + '</option>';
    }).join('');
  }
  function slugify(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  function renderCatalog(user) {
    function ctab(id, label){var on=cat.tab===id;return '<button data-ctab="'+id+'" style="border:none;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:'+(on?'600':'500')+';cursor:pointer;background:'+(on?'#fff':'transparent')+';color:'+(on?'#1c4039':'#6b7065')+';box-shadow:'+(on?'0 1px 2px rgba(0,0,0,.06)':'none')+';">'+label+'</button>';}
    document.getElementById('view').innerHTML = '<div style="display:flex;gap:5px;background:#eef0ea;padding:4px;border-radius:10px;width:max-content;margin-bottom:18px;">'+ctab('items','Catalog')+ctab('products','Product tree')+ctab('bundles','Bundles')+ctab('manufacturers','Manufacturers')+ctab('bombuild','BOM build')+ctab('notes','Proposal notes')+'</div>' +
      // One History button rather than six: which screen you are on is already known,
      // so the button asks for that screen's history and the tabs stay uncluttered.
      '<div style="display:flex;justify-content:flex-end;margin:-8px 0 12px;"><button class="link-btn" id="catHistory" title="Who changed what on this screen, and when" style="width:auto;padding:7px 13px;font-size:13px;">History</button></div>' +
      '<div id="catBody"></div>';
    document.getElementById('catHistory').addEventListener('click', function () {
      var areas = { items: 'catalog', products: 'tree', bundles: 'bundles', manufacturers: 'manufacturers', bombuild: 'bom', notes: 'notes' };
      var titles = { items: 'Catalog history', products: 'Product tree history', bundles: 'Bundle history', manufacturers: 'Manufacturer history', bombuild: 'BOM build history', notes: 'Proposal note history' };
      openHistory({ area: areas[cat.tab] || 'catalog', title: titles[cat.tab] || 'Change history' });
    });
    document.querySelectorAll('[data-ctab]').forEach(function(b){b.addEventListener('click',function(){cat.tab=b.getAttribute('data-ctab');renderCatalog(user);});});
    if(cat.tab==='products') renderCatalogProducts(user);
    else if(cat.tab==='bundles') renderBundles(user);
    else if(cat.tab==='manufacturers') renderManufacturers(user);
    else if(cat.tab==='bombuild') renderBomBuild(user);
    else if(cat.tab==='notes') window.SSGStandardNotes.renderTab();
    else renderItems(user);
  }

  /**
   * Catalog → BOM build: the two ways the Bill of Materials is allowed to differ
   * from the proposal, as configuration rather than a code change.
   *
   *   * COMPONENTS — a part that is made of other parts. The customer sees one line
   *     (UEU-HARKIT); purchasing sees the four parts we actually order. The parent is
   *     replaced by its components on the sheet unless it is set to stay.
   *   * FREE ISSUE — a part we buy from one vendor and have shipped to another. It
   *     lands on the RECEIVING vendor's sheet at no cost, because Summit has already
   *     paid for it, and out of their cost total. The cost stays on the order, so the
   *     margin on the deal is unchanged.
   *
   * Neither can touch a proposal, a price or an accepted order's totals. Both apply
   * to new orders at lock time; an order already locked picks them up from the
   * "Apply BOM build rules" button on its Bill of Materials.
   */
  var bbState = { parents: [], vendors: [], q: '', draft: [] };

  async function renderBomBuild(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="bbSearch" placeholder="Search part number or description…" value="' + esc(bbState.q) + '" style="' + IN + 'flex:1;min-width:240px;max-width:380px;">' +
        (admin ? '<div style="margin-left:auto;"><button class="btn" id="bbNew" style="width:auto;padding:10px 17px;">Add a part rule</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:14px;line-height:1.6;max-width:860px;">' +
        'Two rules per part, both read only when a Bill of Materials is built. <b>Components</b> replace a part with the parts it is made of, so one proposal line becomes the several parts we order. ' +
        '<b>Free issue</b> moves a part onto the sheet of the vendor it is shipped to, at no cost, for parts Summit buys elsewhere and has delivered there. ' +
        'A proposal, a price and a deal total are never affected.</div>' +
      '<div id="bbList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('bbSearch'), t;
    s.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { bbState.q = s.value.trim(); drawBomBuild(user); }, 200);
    });
    if (admin) document.getElementById('bbNew').addEventListener('click', function () { openBomBuildNew(user); });
    loadBomBuild(user);
  }

  async function loadBomBuild(user) {
    var box = document.getElementById('bbList');
    if (!box) return;
    try {
      var r = await authed('/bom-build');
      if (!r.ok) {
        box.innerHTML = '<div class="err">Could not load the BOM build rules (' + r.status + '). Run the 0058 migration if this persists.</div>';
        return;
      }
      bbState.parents = ((await r.json()) || {}).parents || [];
      var rv = await authed('/manufacturers');
      bbState.vendors = rv.ok ? ((await rv.json()) || []) : [];
      drawBomBuild(user);
    } catch (e) {
      box.innerHTML = '<div class="err">Could not reach the server.</div>';
    }
  }

  function bbVendorSelect(part, current) {
    var opts = '<option value="">Not free issue — bought and billed normally</option>' +
      bbState.vendors.map(function (v) {
        return '<option value="' + esc(v.name) + '"' + (v.name === current ? ' selected' : '') + '>' + esc(v.name) + '</option>';
      }).join('');
    return '<select class="bbFree" data-part="' + esc(part) + '" style="' + bomFieldStyle('280px') + '">' + opts + '</select>';
  }

  function drawBomBuild(user) {
    var box = document.getElementById('bbList');
    if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var q = bbState.q.toLowerCase();
    // Draft cards are parts someone has just opened a rule for. They hold nothing yet,
    // so they live in the browser until a component or a setting is saved.
    var all = bbState.draft.filter(function (d) {
      return !bbState.parents.some(function (p) { return p.parentPart === d.parentPart; });
    }).concat(bbState.parents);
    var rows = all.filter(function (p) {
      return !q || (p.parentPart + ' ' + (p.name || '')).toLowerCase().indexOf(q) !== -1;
    });
    var money2 = function (m) { return m == null ? '—' : '$' + (Number(m) / 100).toFixed(2); };

    var card = function (p) {
      var comps = (p.components || []).map(function (c) {
        return '<tr>' +
          td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(c.childPart) + '</code>' +
            (c.unknown ? ' <span class="chip" style="font-size:10px;background:#fdf6e6;color:#6b5a24;" title="Not in the SKU master, so it will cost $0.00 on the sheet. Add it on the Catalog tab.">Not in catalog</span>' : '')) +
          td('<span style="font-size:13px;">' + esc(c.name || '—') + '</span>') +
          td(admin
            ? '<input class="bbQty" data-id="' + c.id + '" type="number" min="1" step="1" value="' + (Number(c.quantity) || 1) + '" style="' + bomFieldStyle('80px') + '">'
            : String(c.quantity)) +
          td('<span style="font-size:13px;">' + esc(c.vendor || '—') + '</span>') +
          td('<span style="font-size:13px;">' + money2(c.unitCostMinor) + '</span>') +
          td(admin ? '<button class="bbDel link-btn" data-id="' + c.id + '" style="width:auto;padding:5px 10px;font-size:12px;color:#a2402f;">Remove</button>' : '') +
          '</tr>';
      }).join('');

      return '<div class="card" style="margin-bottom:18px;padding:0;overflow:hidden;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:14px 18px;background:#fbfbf9;border-bottom:1px solid #e7e8e3;">' +
          '<div>' +
            '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;">' +
              '<code style="font-size:14px;font-weight:600;color:#1c4039;">' + esc(p.parentPart) + '</code>' +
              (p.freeIssueVendor ? '<span class="chip" style="font-size:10.5px;background:#eef0ea;">Free issue → ' + esc(p.freeIssueVendor) + '</span>' : '') +
              (p.keepParentOnBom ? '<span class="chip" style="font-size:10.5px;background:#eef0ea;">Parent kept on sheet</span>' : '') +
            '</div>' +
            '<div class="muted" style="font-size:12.5px;margin-top:3px;">' + esc(p.name || 'Not in the SKU master') + '</div>' +
          '</div>' +
          '<div class="muted" style="font-size:12px;">' + ((p.components || []).length || 'No') + ' component' + ((p.components || []).length === 1 ? '' : 's') + '</div>' +
        '</div>' +
        '<div style="padding:14px 18px;">' +
          '<div style="overflow:auto;">' +
            tableShell(['Component part #', 'Description', 'Qty per', 'Vendor', 'Unit cost', ''], comps, 6,
              'No components yet. A part with no components is only affected by its free-issue setting.') +
          '</div>' +
          (admin
            ? '<div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;flex-wrap:wrap;">' +
                '<div><div class="k">Component part #</div><input class="bbAddPart" data-part="' + esc(p.parentPart) + '" placeholder="e.g. P-2526" style="' + bomFieldStyle('180px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;"></div>' +
                '<div><div class="k">Qty per</div><input class="bbAddQty" data-part="' + esc(p.parentPart) + '" type="number" min="1" step="1" value="1" style="' + bomFieldStyle('90px') + '"></div>' +
                '<button class="bbAdd link-btn" data-part="' + esc(p.parentPart) + '" style="width:auto;padding:8px 14px;">Add component</button>' +
                '<span class="bbMsg muted" data-part="' + esc(p.parentPart) + '" style="font-size:11.5px;flex:1;min-width:200px;"></span>' +
              '</div>'
            : '') +
          '<div style="display:flex;gap:18px;align-items:flex-end;margin-top:14px;padding-top:14px;border-top:1px solid #f2f3ef;flex-wrap:wrap;">' +
            '<div><div class="k">Shipped to (free issue)</div>' + bbVendorSelect(p.parentPart, p.freeIssueVendor || '') +
              '<div class="muted" style="font-size:11px;margin-top:4px;max-width:300px;line-height:1.45;">Prints on that vendor’s sheet with no cost and stays out of their total.</div></div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:#5c6157;cursor:pointer;padding-bottom:20px;">' +
              '<input type="checkbox" class="bbKeep" data-part="' + esc(p.parentPart) + '"' + (p.keepParentOnBom ? ' checked' : '') + (admin ? '' : ' disabled') + '> Keep the parent line on the sheet beside its components</label>' +
          '</div>' +
        '</div>' +
      '</div>';
    };

    box.innerHTML = rows.length
      ? rows.map(card).join('')
      : '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">' +
        (all.length ? 'No part matches that search.' : 'No rules yet. Add one for a part that should arrive on the Bill of Materials as several parts, or that ships to a different vendor than the one we buy it from.') +
        '</p></div>';

    var note = function (part, text, bad) {
      var el = box.querySelector('.bbMsg[data-part="' + part.replace(/"/g, '\\"') + '"]');
      if (el) { el.textContent = text; el.style.color = bad ? '#9c3327' : '#5c6157'; }
    };

    box.querySelectorAll('.bbAdd').forEach(function (b) {
      b.addEventListener('click', async function () {
        var part = b.getAttribute('data-part');
        var pick = function (sel) { return box.querySelector(sel + '[data-part="' + part.replace(/"/g, '\\"') + '"]'); };
        var child = (pick('.bbAddPart').value || '').trim().toUpperCase();
        var qty = parseInt(pick('.bbAddQty').value, 10) || 1;
        if (!child) return note(part, 'Type the component’s part number.', 1);
        b.disabled = true;
        var r = await authed('/bom-build/components', {
          method: 'POST',
          body: { parentPart: part, childPart: child, quantity: qty },
        });
        b.disabled = false;
        if (!r.ok) {
          var m = '';
          try { m = ((await r.json()) || {}).message || ''; } catch (e) {}
          return note(part, m || 'Could not add that component.', 1);
        }
        loadBomBuild(user);
      });
    });

    box.querySelectorAll('.bbQty').forEach(function (i) {
      i.addEventListener('change', async function () {
        var qty = parseInt(i.value, 10) || 1;
        await authed('/bom-build/components/' + i.getAttribute('data-id'), {
          method: 'PATCH',
          body: { quantity: qty },
        });
        loadBomBuild(user);
      });
    });

    box.querySelectorAll('.bbDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        var r = await authed('/bom-build/components/' + b.getAttribute('data-id'), { method: 'DELETE' });
        if (!r.ok) { b.disabled = false; return; }
        loadBomBuild(user);
      });
    });

    var saveSetting = async function (part, body, el) {
      var r = await authed('/bom-build/settings/' + encodeURIComponent(part), {
        method: 'PATCH',
        body: body,
      });
      if (!r.ok) {
        var m = '';
        try { m = ((await r.json()) || {}).message || ''; } catch (e) {}
        alert(m || 'Could not save that setting.');
      }
      loadBomBuild(user);
    };
    box.querySelectorAll('.bbFree').forEach(function (sel) {
      sel.addEventListener('change', function () {
        saveSetting(sel.getAttribute('data-part'), { freeIssueVendor: sel.value || null }, sel);
      });
    });
    box.querySelectorAll('.bbKeep').forEach(function (cb) {
      cb.addEventListener('change', function () {
        saveSetting(cb.getAttribute('data-part'), { keepParentOnBom: cb.checked }, cb);
      });
    });
  }

  /**
   * Open a rule for a part. Nothing is written yet — the card appears and the first
   * component or setting saved is what creates the rule.
   */
  function openBomBuildNew(user) {
    openModal('Add a part rule',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">The part as it appears on the proposal. Its components, or the vendor it ships to, are set on the card that opens.</div>' +
      fieldRow('Part #', '<input id="bbNewPart" placeholder="e.g. UEU-HARKIT" style="' + IN + 'text-transform:uppercase;font-family:ui-monospace,monospace;">'),
      async function (close, showErr) {
        var part = (document.getElementById('bbNewPart').value || '').trim().toUpperCase();
        if (!part) return showErr('Type a part number.');
        // Checked against the MERGED catalog — a part may be carried as a Product, as a
        // flat SKU, or both — so a typo cannot become a rule that never fires while a
        // real part is never refused.
        var r = await authed('/catalog/items?q=' + encodeURIComponent(part) + '&pageSize=100');
        var hit = null;
        if (r.ok) {
          var d = (await r.json()) || {};
          var items = d.items || d.skus || (Array.isArray(d) ? d : []);
          hit = items.filter(function (x) { return String(x.part || '').toUpperCase() === part; })[0] || null;
        }
        if (!hit) return showErr(part + ' is not in the catalog. Add it under Catalog first.');
        if (!bbState.draft.some(function (x) { return x.parentPart === part; }))
          bbState.draft.push({ parentPart: part, name: hit.name || hit.description || '', components: [], keepParentOnBom: false, freeIssueVendor: null });
        close();
        bbState.q = '';
        renderBomBuild(user);
      }, 'Open');
  }


  /* --- The one catalog list: Product + SKU merged, one row per part number --- */
  var itemState = { q: '', page: 1, categories: [], manufacturers: [], rows: [], filters: {}, sort: { key: 'part', dir: 'asc' } };
  function renderItems(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="itSearch" placeholder="Search part #, name, category or manufacturer…" value="' + esc(itemState.q) + '" style="flex:1;min-width:240px;max-width:420px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<button class="link-btn" id="itSkuOnly" title="Parts in the SKU master with no place in the product tree — purchasable, but not selectable in the builder" style="width:auto;padding:10px 15px;">SKU-only parts</button>' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="itExport" style="width:auto;padding:10px 15px;">Export Excel / CSV</button><button class="link-btn" id="itImport" style="width:auto;padding:10px 15px;">Import Excel / CSV</button><button class="btn" id="itNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">Every product on one line — name, category, manufacturer, cost, price and weight. Edit any cell and it saves as you leave the field. These prices and weights are what the Adventure Series engine and the proposal builder multiply against. <b>Override OK</b> lets a rep substitute that part number in the Adventure Series builder — leave it off and the part is fixed.</div>' +
      '<div id="itList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('itSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { itemState.q = s.value.trim(); itemState.page = 1; loadItems(user); }, 300); });
    if (admin) {
      document.getElementById('itNew').addEventListener('click', function () { openSkuForm(user); });
      // Exports what the search box is filtering to, not always the whole table —
      // repricing one manufacturer's parts should not mean opening a 3,000-row file.
      document.getElementById('itExport').addEventListener('click', exportSkuMaster);
      document.getElementById('itImport').addEventListener('click', function () { openSkuImport(user); });
    }
    var so = document.getElementById('itSkuOnly');
    if (so) so.addEventListener('click', openSkuOnlyReport);
    loadItems(user);
  }

  /**
   * Parts that live in the SKU master and nowhere in the product tree.
   *
   * The two lists are separate: a SKU row carries cost, weight and vendor, a product
   * row carries a category and a place in the tree, and neither creates the other. A
   * SKU-only part cannot be picked in the builder and can still reach a vendor sheet
   * through a component list, a kit or a hand-added line — so this is the list of parts
   * that can appear on a Bill of Materials without appearing on a proposal.
   */
  async function openSkuOnlyReport() {
    var r = await authed('/catalog/sku-only');
    if (!r.ok) { toast('Could not read the catalog.', true); return; }
    var d = await r.json();
    var rows = d.rows || [];
    var money = function (m) { return m == null ? '—' : '$' + (Number(m) / 100).toFixed(2); };
    var refs = function (x) {
      var out = [];
      if (x.componentOf.length) out.push('pulled in by ' + x.componentOf.map(esc).join(', '));
      if (x.explodesInto.length) out.push('explodes into ' + x.explodesInto.map(esc).join(', '));
      if (x.orderLines) out.push(x.orderLines + ' order line' + (x.orderLines === 1 ? '' : 's'));
      return out.length ? out.join(' · ') : 'not used anywhere';
    };
    var body = !rows.length
      ? '<div class="muted" style="font-size:13px;line-height:1.6;">Every part in the SKU master has a place in the product tree.</div>'
      : '<div class="muted" style="font-size:12.5px;line-height:1.6;margin-bottom:12px;">' +
        '<b>' + rows.length + ' part' + (rows.length === 1 ? '' : 's') + '</b> exist in the SKU master with no product-tree entry. ' +
        'They cannot be chosen in the proposal builder, but they price, weigh and resolve a vendor normally when a component list, a kit or a hand-added line puts them on an order. ' +
        'Anything used below that should be sellable needs a product record; anything genuinely purchasing-only is fine as it is.' +
        '</div>' +
        '<div style="max-height:420px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
        '<thead><tr>' +
        ['Part #', 'Description', 'Vendor', 'Cost', 'Where it is used'].map(function (h) {
          return '<th style="padding:8px 11px;text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #e7e8e3;background:#fbfbf9;position:sticky;top:0;">' + h + '</th>';
        }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function (x) {
          return '<tr>' +
            '<td style="padding:7px 11px;border-bottom:1px solid #f0f1ec;"><code>' + esc(x.part) + '</code>' +
              (x.active ? '' : ' <span class="muted" style="font-size:11px;">inactive</span>') + '</td>' +
            '<td style="padding:7px 11px;border-bottom:1px solid #f0f1ec;">' + esc(x.description || '—') + '</td>' +
            '<td style="padding:7px 11px;border-bottom:1px solid #f0f1ec;">' + esc(x.vendor || '—') + '</td>' +
            '<td style="padding:7px 11px;border-bottom:1px solid #f0f1ec;">' + money(x.unitCostMinor) + '</td>' +
            '<td style="padding:7px 11px;border-bottom:1px solid #f0f1ec;color:#5c6157;">' + refs(x) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div>';
    openModal('SKU-only parts', body, null, 'Done', { maxWidth: '860px' });
  }
  /* --- column filters (shared by the catalog list and the product tree) --- */
  var FCELL = 'width:100%;padding:5px 7px;border:1px solid #e2e5dd;border-radius:6px;font-size:12px;background:#fff;color:#3d4a55;outline:none;';
  /** Numeric column filter: 250, >250, <=0, >=1.5 … */
  function numFilter(expr) {
    var m = /^\s*(>=|<=|>|<|=)?\s*(-?[\d.]+)\s*$/.exec(expr || '');
    if (!m) return null;
    var op = m[1] || '=', v = parseFloat(m[2]);
    return function (x) {
      if (op === '>') return x > v; if (op === '<') return x < v;
      if (op === '>=') return x >= v; if (op === '<=') return x <= v;
      return Math.abs(x - v) < 1e-9;
    };
  }
  function enumOptions(c, rows) {
    if (c.options) return c.options;
    var seen = {}, out = [];
    rows.forEach(function (r) { var v = r[c.key]; if (v != null && v !== '' && !seen[v]) { seen[v] = 1; out.push([String(v), String(v)]); } });
    return out.sort(function (a, b) { return a[1].localeCompare(b[1]); });
  }
  function filterCell(cls, c, rows, filters) {
    if (!c.key) return '<td style="padding:5px 8px 9px;border-bottom:1px solid #e7e8e3;"></td>';
    var val = filters[c.key] || '';
    var inner;
    if (c.type === 'enum') {
      inner = '<select class="' + cls + '" data-k="' + c.key + '" style="' + FCELL + '"><option value="">All</option>' +
        enumOptions(c, rows).map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    } else {
      inner = '<input class="' + cls + '" data-k="' + c.key + '" value="' + esc(val) + '" placeholder="' + (c.type === 'num' ? '>0' : 'contains') + '" title="' + (c.type === 'num' ? 'Number, or an expression: >100, <=0, >=1.5' : 'Matches any part of the text') + '" style="' + FCELL + (c.align === 'right' ? 'text-align:right;' : '') + '">';
    }
    return '<td style="padding:5px 8px 9px;border-bottom:1px solid #e7e8e3;">' + inner + '</td>';
  }
  function passFilters(row, cols, filters) {
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i]; if (!c.key) continue;
      var f = String(filters[c.key] == null ? '' : filters[c.key]).trim();
      if (!f) continue;
      var v = row[c.key];
      if (c.type === 'num') {
        var fn = numFilter(f); if (!fn) continue;
        if (!fn((Number(v) || 0) / (c.scale || 1))) return false;
      } else if (c.type === 'enum') {
        if (String(v == null ? '' : v) !== f) return false;
      } else if (String(v == null ? '' : v).toLowerCase().indexOf(f.toLowerCase()) === -1) return false;
    }
    return true;
  }
  function sortByCol(rows, key, dir) {
    var d = dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === 'number' || typeof y === 'number') { x = Number(x) || 0; y = Number(y) || 0; }
      else { x = String(x == null ? '' : x).toLowerCase(); y = String(y == null ? '' : y).toLowerCase(); }
      return x < y ? -d : x > y ? d : 0;
    });
  }
  function colHead(cols, state, extraStyle) {
    return cols.map(function (c) {
      var on = c.key && state.sort && state.sort.key === c.key;
      var arrow = !c.key ? '' : on ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.3;">↕</span>';
      return '<th' + (c.key ? ' data-sk="' + c.key + '" style="cursor:pointer;' : ' style="') +
        'text-align:' + (c.align || 'left') + ';padding:10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:' + (on ? '#3d4a55' : '#8a8f85') + ';font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;' + (extraStyle || '') + '">' + esc(c.label) + arrow + '</th>';
    }).join('');
  }
  /** Wire the header sort + filter row of a filterable table. */
  function wireColTable(box, cols, state, redraw) {
    box.querySelectorAll('th[data-sk]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sk');
        if (state.sort && state.sort.key === k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else state.sort = { key: k, dir: 'asc' };
        redraw();
      });
    });
    box.querySelectorAll('.colFilter').forEach(function (el) {
      var apply = function () { state.filters[el.getAttribute('data-k')] = el.value; state.page = 1; redraw(el.getAttribute('data-k')); };
      if (el.tagName === 'SELECT') el.addEventListener('change', apply);
      else {
        var t;
        el.addEventListener('input', function () { clearTimeout(t); t = setTimeout(apply, 250); });
      }
    });
  }

  var IT_COLS = [
    { key: 'part', label: 'Part #', w: 128, type: 'text' },
    { key: 'name', label: 'Product name', w: 0, type: 'text' },
    { key: 'category', label: 'Category', w: 210, type: 'enum' },
    { key: 'manufacturer', label: 'Manufacturer', w: 200, type: 'enum' },
    { key: 'unitCostMinor', label: 'Unit cost', w: 108, type: 'num', scale: 100, align: 'right' },
    { key: 'unitPriceMinor', label: 'Unit price', w: 108, type: 'num', scale: 100, align: 'right' },
    { key: 'margin', label: 'Margin', w: 78, type: 'num', align: 'right' },
    { key: 'weightLbs', label: 'Weight (lb)', w: 96, type: 'num', align: 'right' },
    { key: 'record', label: 'Record', w: 132, type: 'enum', options: [['Product + priced', 'Product + priced'], ['Product only', 'Product only'], ['Priced only', 'Priced only']] },
    { key: 'statusLabel', label: 'Status', w: 118, type: 'enum' },
    { key: 'defaultQty', label: 'Default qty', w: 104, type: 'num', align: 'center' },
    { key: 'freightDisplay', label: 'Auto freight', w: 116, type: 'num', align: 'right' },
    { key: 'ovrLabel', label: 'Override OK', w: 104, type: 'enum', options: [['Yes', 'Yes'], ['No', 'No']], align: 'center' },
    { key: 'productUrl', label: 'Buy link', w: 150, type: 'text' },
    { key: 'packagingBag', label: 'Bag #', w: 96, type: 'text' },
    { key: 'colorLabel', label: 'Needs colour', w: 110, type: 'enum', options: [['Yes', 'Yes'], ['No', 'No']], align: 'center' },
    { key: '', label: '', w: 96 },
  ];

  async function loadItems(user) {
    var box = document.getElementById('itList'); if (!box) return;
    try {
      if (!itemState.manufacturers.length) {
        try { var rm = await authed('/catalog/manufacturers'); if (rm.ok) itemState.manufacturers = ((await rm.json()) || []).map(function (m) { return m.name; }); } catch (e0) {}
      }
      // The whole catalog is loaded once so the column filters and sorting apply
      // across every part, not just the page you happen to be looking at.
      var qs = itemState.q ? '&q=' + encodeURIComponent(itemState.q) : '';
      var r = await authed('/catalog/items?page=1&pageSize=500' + qs);
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      itemState.categories = (d.categories || []).map(function (c) { return c.name; });
      var all = (d.items || []).slice(), total = d.total || all.length, page = 1;
      while (all.length < total && page < 8) {
        page++;
        var rn = await authed('/catalog/items?page=' + page + '&pageSize=500' + qs);
        if (!rn.ok) break;
        all = all.concat(((await rn.json()) || {}).items || []);
      }
      itemState.rows = all.map(function (k) {
        var margin = k.unitPriceMinor ? Math.round(((k.unitPriceMinor - k.unitCostMinor) / k.unitPriceMinor) * 1000) / 10 : 0;
        var rec = k.productId ? (k.skuId ? 'Product + priced' : 'Product only') : 'Priced only';
        var row = {}; for (var kk in k) row[kk] = k[kk];
        row.margin = margin; row.record = rec;
        // One readable status across both records: the product workflow when there
        // is a Product, otherwise the flat SKU's active flag.
        row.statusLabel = k.productStatus ? titleCase(k.productStatus) : (k.active === false ? 'Inactive' : 'Active');
        row.ovrLabel = k.overrideAllowed ? 'Yes' : 'No';
        row.defaultQty = k.defaultQty == null ? '' : Number(k.defaultQty);
        row.freightMinor = k.freightMinor == null ? '' : Number(k.freightMinor);
        row.freightLabel = k.freightLabel || '';
        row.freightDisplay = k.freightMinor == null ? '' : Number(k.freightMinor) / 100;
        row.productUrl = k.productUrl || '';
        row.packagingBag = k.packagingBag || '';
        row.colorLabel = k.requiresPowderColor ? 'Yes' : 'No';
        row.isActive = k.productStatus ? k.productStatus === 'ACTIVE' : k.active !== false;
        return row;
      });
      itemState.page = 1;
      drawItems(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawItems(user, focusKey) {
    var box = document.getElementById('itList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var all = itemState.rows || [];
    var rowsData = all.filter(function (r) { return passFilters(r, IT_COLS, itemState.filters); });
    if (itemState.sort) rowsData = sortByCol(rowsData, itemState.sort.key, itemState.sort.dir);
    var size = 100;
    var totalPages = Math.max(1, Math.ceil(rowsData.length / size));
    if (itemState.page > totalPages) itemState.page = totalPages;
    var pageRows = rowsData.slice((itemState.page - 1) * size, itemState.page * size);
    var activeFilters = IT_COLS.filter(function (c) { return c.key && String(itemState.filters[c.key] || '').trim(); }).length;

    var CELL = 'width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:13px;background:#fff;';
    var NUM = CELL + 'text-align:right;';
    function txt(part, field, value, style) {
      var v = value == null ? '' : String(value);
      return '<input class="itEdit" data-part="' + esc(part) + '" data-f="' + field + '" value="' + esc(v) + '" title="' + esc(v) + '" style="' + (style || CELL) + '">';
    }
    function sel(part, field, value, options) {
      return '<select class="itEdit" data-part="' + esc(part) + '" data-f="' + field + '" style="' + CELL + '">' +
        ['<option value="">—</option>'].concat(options.map(function (o) {
          return '<option value="' + esc(o) + '"' + (String(value) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
        })).join('') + '</select>';
    }
    var rows = pageRows.map(function (k) {
      var where = (k.productId ? '<span class="chip" style="font-size:10px;">Product</span>' : '') + (k.skuId ? ' <span class="chip" style="font-size:10px;background:#fdfcf7;">Priced</span>' : '');
      function cell(v, extra) { return '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;vertical-align:middle;' + (extra || '') + '">' + v + '</td>'; }
      return '<tr>' +
        cell('<code style="font-size:12.5px;color:#4a4f47;white-space:nowrap;">' + esc(k.part) + '</code>') +
        cell(admin ? txt(k.part, 'name', k.name) : '<span style="font-size:13px;" title="' + esc(k.name) + '">' + esc(k.name) + '</span>') +
        cell(admin ? (k.categoryOptions && itemState.categories.length ? sel(k.part, 'category', k.category, itemState.categories) : txt(k.part, 'category', k.category)) : '<span title="' + esc(k.category) + '">' + esc(k.category) + '</span>') +
        cell(admin ? txt(k.part, 'manufacturer', k.manufacturer) : '<span title="' + esc(k.manufacturer) + '">' + esc(k.manufacturer) + '</span>') +
        cell(admin ? txt(k.part, 'unitCostMinor', (Number(k.unitCostMinor) / 100).toFixed(2), NUM + 'background:#fdfcf7;border-color:#e4dfd0;') : '$' + (Number(k.unitCostMinor) / 100).toFixed(2), 'text-align:right;') +
        cell(admin ? txt(k.part, 'unitPriceMinor', (Number(k.unitPriceMinor) / 100).toFixed(2), NUM) : '$' + (Number(k.unitPriceMinor) / 100).toFixed(2), 'text-align:right;') +
        cell('<span style="font-size:13px;font-weight:600;color:' + (k.margin >= 0 ? '#2f7d5d' : '#9c3327') + ';">' + k.margin + '%</span>', 'text-align:right;') +
        cell(admin ? txt(k.part, 'weightLbs', k.weightLbs, NUM) : String(k.weightLbs), 'text-align:right;') +
        cell(where, 'white-space:nowrap;') +
        cell('<span style="display:inline-block;background:' + (k.isActive ? '#eaf3ee' : '#f2f3ef') + ';border:1px solid ' + (k.isActive ? '#cfe3d7' : '#dcded7') + ';color:' + (k.isActive ? '#2f7d5d' : '#8a8f85') + ';border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:600;white-space:nowrap;">' + esc(k.statusLabel) + '</span>', 'white-space:nowrap;') +
        // The quantity the proposal builder starts this part at. Blank = no default,
        // so the field opens at 0 and nothing reaches a proposal unasked.
        cell(admin
          ? '<input type="number" min="0" class="itDefQty" data-part="' + esc(k.part) + '" value="' + (k.defaultQty === '' || k.defaultQty == null ? '' : k.defaultQty) + '" placeholder="—" title="Quantity the Adventure Series builder starts this part at. Blank for none." style="' + NUM + 'text-align:center;">'
          : (k.defaultQty === '' || k.defaultQty == null ? '<span style="color:#b6bab1;">—</span>' : '<span style="font-size:13px;font-weight:600;">' + k.defaultQty + '</span>'), 'text-align:center;') +
        // A fixed freight charge added to this part's proposal line automatically.
        // Blank = none. Prints as the line's 3rd-party freight row.
        cell(admin
          ? '<input class="itFreight" data-part="' + esc(k.part) + '" value="' + (k.freightMinor === '' || k.freightMinor == null ? '' : (Number(k.freightMinor) / 100).toFixed(2)) + '" placeholder="—" title="Freight added automatically when this part is put on a proposal. Blank for none." style="' + NUM + 'text-align:right;">'
          : (k.freightMinor === '' || k.freightMinor == null ? '<span style="color:#b6bab1;">—</span>' : '<span style="font-size:13px;font-weight:600;">' + fmtMoney(Number(k.freightMinor), 'USD') + '</span>'), 'text-align:right;') +
        // Pre-approval to substitute this part number in the Adventure Series
        // builder. Off unless an admin says otherwise.
        cell(admin
          ? '<input type="checkbox" class="itFlag" data-part="' + esc(k.part) + '"' + (k.overrideAllowed ? ' checked' : '') + ' title="Allow reps to substitute this part number in the Adventure Series builder" style="width:16px;height:16px;cursor:pointer;">'
          : (k.overrideAllowed ? '<span style="font-size:12px;color:#2f7d5d;font-weight:600;">Yes</span>' : '<span style="color:#b6bab1;">—</span>'), 'text-align:center;') +
        // Where this part is bought. Becomes a "Buy" link on the Bill of Materials
        // so a purchaser goes straight to the vendor's order page.
        cell(admin
          ? '<input class="itUrl" data-part="' + esc(k.part) + '" value="' + esc(k.productUrl || '') + '" placeholder="—" title="Vendor order page. Shown as a Buy link on the Bill of Materials." style="width:100%;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12px;">'
          : (k.productUrl ? '<a href="' + esc(k.productUrl) + '" target="_blank" rel="noopener" style="font-size:12px;">Buy ↗</a>' : '<span style="color:#b6bab1;">—</span>')) +
        // Which packaging bag the part ships in. Only about thirty hardware items
        // carry one; blank everywhere else and never printed unless asked for.
        cell(admin
          ? '<input class="itBag" data-part="' + esc(k.part) + '" value="' + esc(k.packagingBag || '') + '" placeholder="—" title="Packaging bag this part ships in, e.g. Bag 7. Shown on the Bill of Materials when the bag column is turned on." style="width:100%;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12px;">'
          : (k.packagingBag ? '<span style="font-size:12.5px;font-weight:600;">' + esc(k.packagingBag) + '</span>' : '<span style="color:#b6bab1;">—</span>')) +
        // Whether this part must carry a powder colour before its BOM section can be
        // submitted. Off by default — most parts are not powder coated at all.
        cell(admin
          ? '<input type="checkbox" class="itColor" data-part="' + esc(k.part) + '"' + (k.requiresPowderColor ? ' checked' : '') + ' title="Block BOM submission until this part has a powder colour" style="width:16px;height:16px;cursor:pointer;">'
          : (k.requiresPowderColor ? '<span style="font-size:12px;color:#2f7d5d;font-weight:600;">Yes</span>' : '<span style="color:#b6bab1;">—</span>'), 'text-align:center;') +
        cell(admin ? '<div style="display:flex;gap:5px;justify-content:flex-end;">' +
          '<button class="itToggle" data-part="' + esc(k.part) + '" data-to="' + (k.isActive ? 'false' : 'true') + '" title="' + (k.isActive ? 'Stop offering this part on new proposals' : 'Offer this part again') + '" style="border:1px solid #dcded7;background:#fff;border-radius:7px;padding:5px 9px;font-size:11.5px;color:#3d4a55;cursor:pointer;white-space:nowrap;">' + (k.isActive ? 'Deactivate' : 'Activate') + '</button>' +
          '<button class="itDel" data-part="' + esc(k.part) + '" title="Delete this part" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;padding:5px 8px;font-size:11.5px;color:#9c3327;cursor:pointer;">✕</button></div>' : '', 'text-align:right;') + '</tr>';
    }).join('');

    box.innerHTML =
      '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
        '<table style="width:100%;min-width:1500px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
        '<colgroup>' + IT_COLS.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
        '<thead><tr>' + colHead(IT_COLS, itemState) + '</tr>' +
        '<tr>' + IT_COLS.map(function (c) { return filterCell('colFilter', c, all, itemState.filters); }).join('') + '</tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="13" style="padding:28px;text-align:center;color:#8a8f85;">' + (all.length ? 'No parts match these filters.' : 'Nothing in the catalog yet. Import a sheet or add a product.') + '</td></tr>') + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;flex-wrap:wrap;gap:8px;">' +
        '<span>' + rowsData.length.toLocaleString() + (activeFilters ? ' of ' + all.length.toLocaleString() : '') + ' items' +
          (activeFilters ? ' · <button id="itClearF" class="link-btn" style="width:auto;padding:4px 10px;display:inline-block;">Clear filters</button>' : '') + '</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="itPrev" ' + (itemState.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + itemState.page + ' of ' + totalPages + '</span><button id="itNext" ' + (itemState.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';

    var pv = document.getElementById('itPrev'), nx = document.getElementById('itNext');
    if (pv) pv.addEventListener('click', function () { if (itemState.page > 1) { itemState.page--; drawItems(user); } });
    if (nx) nx.addEventListener('click', function () { if (itemState.page < totalPages) { itemState.page++; drawItems(user); } });
    var cf = document.getElementById('itClearF');
    if (cf) cf.addEventListener('click', function () { itemState.filters = {}; itemState.page = 1; drawItems(user); });
    wireColTable(box, IT_COLS, itemState, function (key) { drawItems(user, key); });
    if (focusKey) {
      var back = box.querySelector('.colFilter[data-k="' + focusKey + '"]');
      if (back && back.tagName === 'INPUT') { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
    box.querySelectorAll('.itEdit').forEach(function (el) {
      el.addEventListener('change', async function () {
        var f = el.getAttribute('data-f'), part = el.getAttribute('data-part'), body = {};
        if (f === 'unitPriceMinor' || f === 'unitCostMinor') body[f] = d2m(el.value);
        else if (f === 'weightLbs') body[f] = parseFloat(el.value) || 0;
        else body[f] = el.value.trim();
        el.style.borderColor = '#c9a227';
        var r2 = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: body });
        el.style.borderColor = r2.ok ? '#3f9d78' : '#c2452f';
        if (!r2.ok) { var msg = ''; try { msg = (await r2.json()).message || ''; } catch (e3) {} alert('Could not save' + (msg ? ': ' + msg : ' (' + r2.status + ').')); return; }
        // Keep the in-memory row in step so filters and margin stay correct.
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) {
          row[f] = body[f];
          row.margin = row.unitPriceMinor ? Math.round(((row.unitPriceMinor - row.unitCostMinor) / row.unitPriceMinor) * 1000) / 10 : 0;
        }
        if (f === 'unitCostMinor' || f === 'unitPriceMinor') drawItems(user);
        setTimeout(function () { el.style.borderColor = f === 'unitCostMinor' ? '#e4dfd0' : '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itFreight').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), raw = el.value.trim();
        var to = raw === '' ? null : d2m(raw);
        el.style.borderColor = '#c9a227';
        var rf = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { freightMinor: to } });
        el.style.borderColor = rf.ok ? '#3f9d78' : '#c2452f';
        if (!rf.ok) {
          var mf = ''; try { mf = ((await rf.json()) || {}).message || ''; } catch (ef) {}
          alert(mf || 'Could not save that freight amount (' + rf.status + '). If this says the column is missing, migration 0027 has not been deployed.');
          return;
        }
        el.value = to == null ? '' : (to / 100).toFixed(2);
        var rowf = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowf) { rowf.freightMinor = to == null ? '' : to; rowf.freightDisplay = to == null ? '' : to / 100; }
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itDefQty').forEach(function (el) {      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), raw = el.value.trim();
        var to = raw === '' ? null : Math.max(0, Math.round(parseFloat(raw) || 0));
        el.style.borderColor = '#c9a227';
        var rq = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { defaultQty: to } });
        el.style.borderColor = rq.ok ? '#3f9d78' : '#c2452f';
        if (!rq.ok) {
          var mq = ''; try { mq = ((await rq.json()) || {}).message || ''; } catch (eq) {}
          alert(mq || 'Could not save that default (' + rq.status + '). If this says the column is missing, migration 0025 has not been deployed.');
          return;
        }
        el.value = to == null ? '' : String(to);
        var rowq = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowq) { rowq.defaultQty = to == null ? '' : to; }
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itBag').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), v = el.value.trim();
        el.style.borderColor = '#c9a227';
        var rb = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { packagingBag: v || null } });
        el.style.borderColor = rb.ok ? '#3f9d78' : '#c2452f';
        if (!rb.ok) {
          var mb = ''; try { mb = ((await rb.json()) || {}).message || ''; } catch (eb) {}
          alert(mb || 'Could not save that bag number (' + rb.status + '). If this says the column is missing, migration 0033 has not been deployed.');
          return;
        }
        var rowb = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowb) rowb.packagingBag = v;
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itUrl').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), v = el.value.trim();
        // Validated before it is saved: a mistyped link becomes an unclickable
        // "Buy" button on a purchasing document, which is worse than no link.
        if (v && !/^https?:\/\//i.test(v)) { alert('A buy link must start with http:// or https://'); el.focus(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { productUrl: v || null } });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save the link (' + r.status + ').'); return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) row.productUrl = v;
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itColor').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), to = el.checked;
        el.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { requiresPowderColor: to } });
        el.disabled = false;
        if (!r.ok) { el.checked = !to; var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save (' + r.status + ').'); return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) { row.requiresPowderColor = to; row.colorLabel = to ? 'Yes' : 'No'; }
      });
    });
    box.querySelectorAll('.itFlag').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), to = el.checked;
        el.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { overrideAllowed: to } });
        el.disabled = false;
        if (!r.ok) {
          el.checked = !to;
          var m0 = ''; try { m0 = ((await r.json()) || {}).message || ''; } catch (e2) {}
          alert(m0 || 'Could not save that change (' + r.status + '). If this says the column is missing, migration 0024 has not been deployed.');
          return;
        }
        var row0 = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row0) { row0.overrideAllowed = to; row0.ovrLabel = to ? 'Yes' : 'No'; }
      });
    });
    box.querySelectorAll('.itToggle').forEach(function (b) {
      b.addEventListener('click', async function () {
        var part = b.getAttribute('data-part'), to = b.getAttribute('data-to') === 'true';
        b.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part) + '/active', { method: 'POST', body: { active: to } });
        if (!r.ok) { var m1 = ''; try { m1 = ((await r.json()) || {}).message || ''; } catch (e1) {} alert(m1 || 'Could not change status (' + r.status + ').'); b.disabled = false; return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) {
          row.isActive = to;
          if (row.productStatus) { row.productStatus = to ? 'ACTIVE' : 'INACTIVE'; row.statusLabel = to ? 'Active' : 'Inactive'; }
          else { row.active = to; row.statusLabel = to ? 'Active' : 'Inactive'; }
        }
        drawItems(user);
      });
    });
    box.querySelectorAll('.itDel').forEach(function (b) {
      b.addEventListener('click', function () { openItemDeleteForm(b.getAttribute('data-part'), user); });
    });
  }

  /**
   * Deleting a catalog part is only safe when no proposal references it — otherwise
   * a historical document would silently change. The dialog says which it is and
   * offers deactivation as the alternative.
   */
  async function openItemDeleteForm(part, user) {
    var u = null;
    try { var r = await authed('/catalog/items/' + encodeURIComponent(part) + '/usage'); if (r.ok) u = await r.json(); } catch (e) {}
    if (!u) { alert('Could not check where this part is used.'); return; }
    var safe = u.deletable;
    openModal('Remove ' + part,
      (safe
        ? '<div style="font-size:13.5px;line-height:1.6;">Nothing references this part, so it can be deleted outright. This removes the catalog record, its price/cost and its sourcing — permanently.</div>'
        : '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;line-height:1.55;">' + esc(u.reason || 'This part cannot be deleted.') + '</div>') +
      '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.55;">' +
        (u.active === false ? 'This part is already inactive.' : 'Deactivating keeps every existing proposal exactly as priced and simply stops the part being offered on new ones.') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;">' +
        (u.active !== false ? '<button type="button" class="link-btn" id="idDeact" style="width:auto;padding:9px 15px;">Deactivate instead</button>' : '') +
      '</div>',
      safe
        ? async function (close, showErr) {
          var rr = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'DELETE' });
          if (!rr.ok && rr.status !== 204) { var m = ''; try { m = ((await rr.json()) || {}).message || ''; } catch (e2) {} return showErr(m || 'Could not delete (' + rr.status + ').'); }
          close(); loadItems(user);
        }
        : async function (close) { close(); },
      safe ? 'Delete permanently' : 'Close');
    var da = document.getElementById('idDeact');
    if (da) da.addEventListener('click', async function () {
      var rr = await authed('/catalog/items/' + encodeURIComponent(part) + '/active', { method: 'POST', body: { active: false } });
      if (!rr.ok) { alert('Could not deactivate (' + rr.status + ').'); return; }
      var form = document.getElementById('mForm');
      if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
      loadItems(user);
    });
  }
  async function renderCatalogProducts(user) {
    var admin = canCatalogAdmin(user.role);
    try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : []; } catch (e) { catCategories = []; }
    var statusOpts = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (cat.status === s ? ' selected' : '') + '>' + titleCase(s) + '</option>'; }).join('');
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
        '<input id="catSearch" placeholder="Search SKU or name…" value="' + esc(cat.q) + '" style="flex:1;min-width:220px;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<select id="catStatus" style="padding:10px 12px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;">' + statusOpts + '</select>' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;"><button class="link-btn" id="catCats" style="width:auto;padding:10px 14px;">Categories &amp; tiers</button><button class="link-btn" id="catOrder" style="width:auto;padding:10px 14px;">Sort order by tier</button><button class="link-btn" id="catSortAudit" style="width:auto;padding:10px 14px;">Sort order</button><button class="link-btn" id="catExport" style="width:auto;padding:10px 14px;">Export tree</button><button class="link-btn" id="catListCsv" style="width:auto;padding:10px 14px;">Export product list</button><button class="link-btn" id="catImport" style="width:auto;padding:10px 14px;">Import tree</button><button class="btn" id="catNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div id="catList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var search = document.getElementById('catSearch'), t;
    search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { cat.q = search.value.trim(); cat.page = 1; loadProducts(user); }, 300); });
    document.getElementById('catStatus').addEventListener('change', function (e) {
      // The toolbar dropdown is the Status column filter — no refetch needed.
      cat.status = e.target.value; cat.filters.status = cat.status; cat.page = 1;
      if ((cat.rows || []).length) drawProductTree(user); else loadProducts(user);
    });
    if (admin) {
      document.getElementById('catNew').addEventListener('click', function () { openProductForm(user); });
      document.getElementById('catCats').addEventListener('click', function () { openCategoryManager(user); });
      document.getElementById('catOrder').addEventListener('click', function () { openProductReorder(user); });
      document.getElementById('catExport').addEventListener('click', exportProductTree);
      document.getElementById('catListCsv').addEventListener('click', exportCategoryProductList);
      document.getElementById('catSortAudit').addEventListener('click', function () { openSortAudit(user); });
      document.getElementById('catImport').addEventListener('click', function () { openTreeImport(user); });
    }
    loadProducts(user);
  }

  /* --- SKU / Pricing manager (in-app editor + Excel/CSV import) --- */
  /*
   * The "Pricing & SKUs" tab used to live here — renderSkus, loadSkus and their own
   * skuState — replaced by the merged Catalog tab (renderItems / loadItems), which
   * lists every product on one line with price, cost and weight editable in place.
   * Nothing has dispatched to it in a long time.
   *
   * Its search box was the last thing writing skuState, which is why the two catalog
   * exports below had quietly stopped honouring a typed search: they read a filter
   * that nothing could set any more. They read itemState now.
   */
  /** Reload whichever catalog list is showing. */
  function refreshCatalogList(user) { if (cat.tab === 'products') loadProducts(user); else { itemState.page = 1; loadItems(user); } }

  function openSkuForm(user) {
    openModal('New catalog item',
      fieldRow('Part #', '<input id="kPart" style="' + IN + '" required>') +
      fieldRow('Description', '<input id="kDesc" style="' + IN + '" required>') +
      '<div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Unit price ($)</label><input id="kPrice" value="0.00" style="' + IN + '"></div><div class="field" style="flex:1;"><label>Unit cost ($)</label><input id="kCost" value="0.00" style="' + IN + '"></div><div class="field" style="flex:1;"><label>Weight (lb)</label><input id="kWt" value="0" style="' + IN + '"></div></div>' +
      fieldRow('Category', '<input id="kCat" value="OTHER" style="' + IN + '">') +
      fieldRow('Manufacturer', '<input id="kMfr" placeholder="e.g. Summit Sensory Gym" style="' + IN + '">') +
      fieldRow('Proposal group (optional)', '<input id="kGroup" style="' + IN + '">'),
      async function (close, showErr) {
        var part = document.getElementById('kPart').value.trim(); if (!part) return showErr('Part # is required.');
        var desc = document.getElementById('kDesc').value.trim(); if (!desc) return showErr('Description is required.');
        var body = { part: part, description: desc, unitPriceMinor: d2m(document.getElementById('kPrice').value), unitCostMinor: d2m(document.getElementById('kCost').value), weightLbs: parseFloat(document.getElementById('kWt').value) || 0, category: document.getElementById('kCat').value.trim() || 'OTHER', manufacturer: document.getElementById('kMfr').value.trim() || undefined, proposalGroup: document.getElementById('kGroup').value.trim() || undefined };
        var r = await authed('/skus', { method: 'POST', body: body });
        if (!r.ok) return showErr(r.status === 400 ? 'That part # may already exist.' : 'Could not create (' + r.status + ').');
        close(); refreshCatalogList(user);
      });
  }
  /**
   * Import prices and catalog columns from a sheet. Two passes: the first is a
   * preview (which columns the file carries, what will be created and changed, and
   * which catalog parts the file leaves out), the second commits. Only the columns
   * present in the file are written — leaving `unitCost` out of the sheet leaves
   * every cost alone.
   */
  /**
   * The SKU master as a CSV the importer on this same screen reads back without
   * edits — same column names, same order, prices as dollars. That round trip is
   * the point: export, reprice a column in Excel, import. `active` is included so
   * a retired part is visible in the sheet, but the importer ignores it (status is
   * changed in the app, or by the missing-parts review on import).
   *
   * Exports what the search box is currently filtering to, not always the whole
   * table — repricing one manufacturer's parts should not require a 3,000-row file.
   */
  async function exportSkuMaster() {
    var qs = itemState.q ? '?q=' + encodeURIComponent(itemState.q) : '';
    var r = await authed('/skus/export' + qs);
    if (!r.ok) { alert('Could not export the catalog (' + r.status + ').'); return; }
    var d = await r.json();
    var cols = d.columns || [];
    var rows = [cols].concat((d.items || []).map(function (it) {
      return cols.map(function (c) { return it[c]; });
    }));
    downloadCsv('catalog-skus-' + todayISO() + (itemState.q ? '-filtered' : '') + '.csv', rows);
  }

  /**
   * A worksheet holding only the columns a repricing touches.
   *
   * The full export carries every field, and repricing from it means opening a sheet
   * of twenty columns to change one — with every other column still in the file, and
   * so still overwritten on the way back in. A stale weight or a category someone
   * edited in the meantime rides along silently.
   *
   * This is the same list, cut to part, description, cost and price. Description is
   * included and read-only in practice: without something human beside the part number
   * the sheet cannot be checked by eye, which is the whole point of doing it in Excel.
   */
  async function exportSkuPrices() {
    var qs = itemState.q ? '?q=' + encodeURIComponent(itemState.q) : '';
    var r = await authed('/skus/export' + qs);
    if (!r.ok) { alert('Could not build the price sheet (' + r.status + ').'); return; }
    var d = await r.json();
    var cols = ['part', 'description', 'unitCost', 'unitPrice'];
    var have = d.columns || [];
    // Fall back to whatever the export actually names these, rather than guessing.
    var pick = function (names) {
      for (var i = 0; i < names.length; i++) if (have.indexOf(names[i]) >= 0) return names[i];
      return null;
    };
    var costCol = pick(['unitCost', 'unitCostMinor', 'cost']);
    var priceCol = pick(['unitPrice', 'unitPriceMinor', 'price']);
    var descCol = pick(['description', 'name']);
    var rows = [cols].concat((d.items || []).map(function (it) {
      return [it.part, descCol ? it[descCol] : '', costCol ? it[costCol] : '', priceCol ? it[priceCol] : ''];
    }));
    downloadCsv('catalog-prices-' + todayISO() + (itemState.q ? '-filtered' : '') + '.csv', rows);
  }

  var skuImportConfirmed = false;
  function openSkuImport(user) {
    skuImportConfirmed = false;
    openModal('Import products from Excel / CSV',
      '<div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.55;">Save your sheet as <b>CSV</b> with a header row. Recognised columns: <code>part, description, unitPrice, unitCost, weightLbs, category, manufacturer, proposalGroup</code>. <b>part</b> is the match key and is required; every other column is optional.</div>' +
      // The rule that makes a repricing safe, stated where someone is about to rely on
      // it: a column you leave OUT is not touched, so a two-column file changes two
      // things. A column you include but leave blank is a value, and it clears.
      '<div style="font-size:12.5px;line-height:1.6;background:#f4faf6;border:1px solid #cfe3d7;border-radius:9px;padding:10px 12px;margin-bottom:10px;">' +
        '<b>Only the columns in your file are changed.</b> A sheet of just <code>part,unitCost</code> reprices the catalog and leaves names, categories, weights, vendors and tier placements exactly as they are. ' +
        'A column you include but leave <i>blank</i> is different — that clears the field.' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">' +
        '<button class="link-btn" id="siPriceSheet" style="width:auto;padding:8px 13px;">Download a price-only sheet</button>' +
        '<span class="muted" style="font-size:11.5px;">part, description, cost and price. Edit the figures and upload it back.</span>' +
      '</div>' +
      '<input type="file" id="skuFile" accept=".csv,text/csv" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">' +
      '<div id="siReview" style="margin-top:12px;"></div>',
      async function (close, showErr) {
        var fi = document.getElementById('skuFile').files[0]; if (!fi) return showErr('Choose a CSV file first.');
        var text = await fi.text();
        var rows = parseCsv(text);
        if (!rows.length) return showErr('No data rows found in that file.');
        if (!Object.prototype.hasOwnProperty.call(rows[0], 'part')) return showErr('The sheet needs a “part” column — it is how rows are matched.');
        var missingSel = document.getElementById('siMissing');
        var r = await authed('/skus/import', { method: 'POST', body: {
          rows: rows, dryRun: !skuImportConfirmed, missingAction: missingSel ? missingSel.value : 'leave'
        } });
        var d = null; try { d = await r.json(); } catch (e) {}
        if (!d) return showErr('Import failed (' + r.status + ').');
        if (d.issues && d.issues.length) {
          document.getElementById('siReview').innerHTML =
            '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;max-height:180px;overflow:auto;">' +
            '<b>' + d.issues.length + ' row(s) could not be read:</b><ul style="margin:6px 0 0;padding-left:18px;line-height:1.5;">' +
            d.issues.slice(0, 30).map(function (i) { return '<li>' + esc(i.part || 'Row ' + i.row) + ': ' + esc(i.message) + '</li>'; }).join('') + '</ul></div>';
          skuImportConfirmed = false;
          return showErr('Fix those rows and try again.');
        }
        if (!skuImportConfirmed) {
          var p = d.plan || {};
          document.getElementById('siReview').innerHTML =
            '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;">' +
              '<b>Ready to import ' + (d.willUpsert || 0) + ' row(s)</b><br>' +
              (p.create || 0) + ' new part(s), ' + (p.update || 0) + ' updated<br>' +
              'Columns this file will overwrite: <b>' + ((p.columns || []).join(', ') || 'none — part numbers only') + '</b>' +
            '</div>' +
            ((p.missing && p.missing.length)
              ? '<div style="margin-top:10px;background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7a6320;line-height:1.55;">' +
                  '<b>' + p.missing.length + ' active catalog part(s) are not in this file.</b>' +
                  '<div style="max-height:120px;overflow:auto;margin:6px 0;">' + p.missing.slice(0, 60).map(function (mm) { return esc(mm.part + ' — ' + mm.name); }).join('<br>') + '</div>' +
                  '<label style="display:block;margin-top:6px;">What should happen to them? ' +
                    '<select id="siMissing" style="padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
                      '<option value="leave">Leave them exactly as they are</option>' +
                      '<option value="deactivate">Deactivate them</option>' +
                    '</select></label></div>'
              : '') +
            '<div class="muted" style="font-size:12px;margin-top:8px;">Press Import again to commit.</div>';
          skuImportConfirmed = true;
          return showErr('Review the summary above, then press Import to commit.');
        }
        skuImportConfirmed = false;
        close();
        refreshCatalogList(user);
        showImportReceipt(d);
      }, 'Import');

    // Bound after the modal is in the document. Downloading the sheet must not close
    // the dialog — the next thing you do is upload the edited file into it.
    setTimeout(function () {
      var b = document.getElementById('siPriceSheet');
      if (b) b.addEventListener('click', function (ev) { ev.preventDefault(); exportSkuPrices(); });
    }, 0);
  }
  /**
   * What the import actually did, part by part.
   *
   * The counts answer "did it work". They do not answer "did MY part go in", which is
   * the question asked a week later when a price looks wrong — so every row is listed
   * with its outcome, failures first, and the whole thing downloads as a CSV that can
   * be kept beside the file that was uploaded.
   */
  function showImportReceipt(d) {
    var results = d.results || [];
    var failed = results.filter(function (r) { return r.outcome === 'failed'; });
    var unreadable = d.issues || [];
    var created = results.filter(function (r) { return r.outcome === 'created'; });
    var updated = results.filter(function (r) { return r.outcome === 'updated'; });
    var unchanged = results.filter(function (r) { return r.outcome === 'unchanged'; });

    var tile = function (n, label, color) {
      return '<div style="flex:1;min-width:96px;padding:10px 12px;border:1px solid #e7e8e3;border-radius:9px;background:#fff;">' +
        '<div style="font-size:21px;font-weight:650;color:' + color + ';font-variant-numeric:tabular-nums;">' + n + '</div>' +
        '<div class="muted" style="font-size:11.5px;margin-top:1px;">' + label + '</div></div>';
    };
    var list = function (title, rows, color, showWhy) {
      if (!rows.length) return '';
      return '<div style="margin-top:12px;">' +
        '<div style="font-size:12px;font-weight:650;color:' + color + ';margin-bottom:5px;">' + title + '</div>' +
        '<div style="max-height:190px;overflow:auto;border:1px solid #e7e8e3;border-radius:8px;">' +
        rows.map(function (r, i) {
          return '<div style="padding:6px 10px;font-size:12px;line-height:1.5;' +
            (i ? 'border-top:1px solid #f0f1ed;' : '') + '">' +
            '<span style="font-family:ui-monospace,monospace;">' + esc(r.part || ('Row ' + r.row)) + '</span>' +
            (showWhy && r.message ? '<div style="color:#9c3327;font-size:11.5px;">' + esc(r.message) + '</div>' : '') +
            (!showWhy && r.columns && r.columns.length
              ? '<span class="muted" style="font-size:11px;"> \u00b7 ' + esc(r.columns.join(', ')) + '</span>' : '') +
          '</div>';
        }).join('') + '</div></div>';
    };

    var allClear = !failed.length && !unreadable.length;
    openModal('Import ' + (allClear ? 'complete' : 'finished with problems'),
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;">' +
        tile(created.length, 'added', '#2f7d5d') +
        tile(updated.length, 'updated', '#20241f') +
        tile(failed.length + unreadable.length, 'not imported', (failed.length + unreadable.length) ? '#a2402f' : '#8a8f85') +
        (d.deactivated ? tile(d.deactivated, 'deactivated', '#8a6d1f') : '') +
      '</div>' +
      (allClear
        ? '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.6;">Every row in the file was applied. Only the columns your file carried were written; everything else on these parts is untouched.</div>'
        : '<div style="font-size:12.5px;margin-top:10px;line-height:1.6;background:#fbe9e6;border:1px solid #f0cdc7;border-radius:9px;padding:10px 12px;color:#7d2b20;">' +
          '<b>' + (failed.length + unreadable.length) + ' row(s) did not import.</b> Everything else did \u2014 the file was not rolled back. Fix these rows and upload them on their own.</div>') +
      list('Not imported', unreadable.concat(failed), '#a2402f', true) +
      list('Added', created, '#2f7d5d') +
      list('Updated', updated, '#20241f') +
      list('Matched, but the file carried nothing to change', unchanged, '#8a6d1f') +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:14px;">' +
        '<button class="link-btn" id="siReceiptCsv" style="width:auto;padding:8px 13px;">Download this report</button>' +
        '<span class="muted" style="font-size:11.5px;">Keep it beside the file you uploaded.</span>' +
      '</div>',
      null, 'Close', { maxWidth: '620px' });

    setTimeout(function () {
      var b = document.getElementById('siReceiptCsv');
      if (!b) return;
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        var rows = [['part', 'row', 'outcome', 'columns written', 'message']];
        unreadable.forEach(function (u) {
          rows.push([u.part || '', u.row, 'not imported', '', u.message]);
        });
        results.forEach(function (r) {
          rows.push([r.part, r.row, r.outcome === 'failed' ? 'not imported' : r.outcome,
            (r.columns || []).join(' '), r.message || '']);
        });
        downloadCsv('import-report-' + todayISO() + '.csv', rows);
      });
    }, 0);
  }

  function parseCsv(text) {
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return [];
    function splitLine(line) { var out = [], cur = '', q = false; for (var i = 0; i < line.length; i++) { var c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } } out.push(cur); return out; }
    var headers = splitLine(lines[0]).map(function (h) { return h.trim(); });
    return lines.slice(1).map(function (ln) { var cells = splitLine(ln); var o = {}; headers.forEach(function (h, i) { o[h] = (cells[i] || '').trim(); }); return o; });
  }

  var PT_COLS = [
    { key: 'sku', label: 'SKU', w: 160, type: 'text' },
    { key: 'name', label: 'Name', w: 0, type: 'text' },
    { key: 'kind', label: 'Kind', w: 140, type: 'enum' },
    { key: 'categoryName', label: 'Category', w: 210, type: 'enum' },
    { key: 'sortOrder', label: 'Order', w: 90, type: 'num' },
    { key: 'status', label: 'Status', w: 170, type: 'enum' },
    { key: '', label: 'QuickBooks', w: 150 },
    { key: '', label: '', w: 96 },
  ];

  /**
   * productId → QuickBooks item id, for the catalog's QuickBooks column. Null until
   * loaded; an empty object means loaded and nothing is linked. Loaded once per
   * visit to the Catalog, and refreshed in place after a sync rather than re-fetched.
   */
  var qboItemLinks = null;
  /** The income account the last sync used, so the dialog remembers the answer. */
  var qboIncomeAccount = null;
  try { qboIncomeAccount = JSON.parse(localStorage.getItem('ssg.qboIncomeAccount') || 'null'); } catch (e) {}

  async function loadQboItemLinks() {
    try {
      var r = await authed('/integrations/quickbooks/items/links');
      if (!r.ok) { qboItemLinks = {}; return; }
      var d = await r.json();
      var map = {};
      (d.links || []).forEach(function (l) { map[l.productId] = l; });
      qboItemLinks = map;
    } catch (e) { qboItemLinks = {}; }
  }

  async function loadProducts(user) {
    var box = document.getElementById('catList'); if (!box) return;
    try {
      // Load the whole tree (100 per request) so column filters and sorting cover
      // every product rather than the current page.
      var qs = (cat.q ? '&q=' + encodeURIComponent(cat.q) : '');
      var all = [], page = 0, total = 1;
      while (all.length < total && page < 20) {
        page++;
        var r = await authed('/catalog/products?page=' + page + '&pageSize=100' + qs);
        if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
        var d = await r.json();
        total = d.total || 0;
        var got = d.items || [];
        all = all.concat(got);
        if (!got.length) break;
      }
      cat.rows = all.map(function (p) {
        var row = {}; for (var k in p) row[k] = p[k];
        row.categoryName = catName(p.categoryId) || '';
        row.categoryPath = catPathLabel(p.categoryId);
        row.kindLabel = titleCase(p.kind);
        return row;
      });
      cat.page = 1;
      drawProductTree(user);
      // Not awaited above: the tree is useful before the link state arrives, and the
      // column redraws itself when it does.
      if (qboItemLinks === null) { await loadQboItemLinks(); drawProductTree(user); }
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawProductTree(user, focusKey) {
    var box = document.getElementById('catList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var all = cat.rows || [];
    var rowsData = all.filter(function (r) { return passFilters(r, PT_COLS, cat.filters); });
    if (cat.sort) rowsData = sortByCol(rowsData, cat.sort.key, cat.sort.dir);
    var size = 25;
    var totalPages = Math.max(1, Math.ceil(rowsData.length / size));
    if (cat.page > totalPages) cat.page = totalPages;
    var pageRows = rowsData.slice((cat.page - 1) * size, cat.page * size);
    var activeFilters = PT_COLS.filter(function (c) { return c.key && String(cat.filters[c.key] || '').trim(); }).length;

    var kindOpts = PT_COLS[2]; kindOpts.options = KINDS.map(function (k) { return [k, titleCase(k)]; });
    var statusCol = PT_COLS[4]; statusCol.options = STATUSES.map(function (st) { return [st, titleCase(st)]; });

    var rows = pageRows.map(function (p) {
      var statusCell = admin
        ? '<select data-pid="' + p.id + '" class="rowStatus" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;width:100%;">' + STATUSES.map(function (st) { return '<option value="' + st + '"' + (p.status === st ? ' selected' : '') + '>' + titleCase(st) + '</option>'; }).join('') + '</select>'
        : '<span class="chip">' + titleCase(p.status) + '</span>';
      return '<tr>' + td('<code style="font-size:13px;color:#4a4f47;">' + esc(p.sku) + '</code>') +
        td('<b style="font-weight:600;">' + esc(p.name) + '</b>' + (p.proposalDescription ? '<div class="muted" style="font-size:12px;max-width:420px;line-height:1.45;">' + esc(String(p.proposalDescription).slice(0, 120)) + (String(p.proposalDescription).length > 120 ? '…' : '') + '</div>' : '')) +
        td(esc(titleCase(p.kind))) + td('<span style="font-size:13px;">' + esc(p.categoryName || '—') + '</span>' + (p.categoryPath && p.categoryPath !== p.categoryName ? '<div class="muted" style="font-size:11.5px;line-height:1.4;">' + esc(p.categoryPath) + '</div>' : '')) +
        // The number that decides where this part lands on a proposal. Sort by this
        // column and filter Category to read a tier in its proposal order.
        td('<span style="font-variant-numeric:tabular-nums;font-size:13px;color:#5c6157;">' + (Number(p.sortOrder) || 0) + '</span>') + td(statusCell) +
        td(qboCell(p, admin)) +
        td(admin ? '<button class="prodEdit" data-pid="' + p.id + '" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;color:#3d4a55;cursor:pointer;">Edit</button>' : '') + '</tr>';
    }).join('');

    box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
      '<table style="width:100%;min-width:1280px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
      '<colgroup>' + PT_COLS.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
      '<thead><tr>' + colHead(PT_COLS, cat, 'background:#f7f8f4;') + '</tr>' +
      '<tr>' + PT_COLS.map(function (c) { return filterCell('colFilter', c, all, cat.filters); }).join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="8">' + (all.length ? 'No products match these filters.' : 'No products yet.') + '</td></tr>') + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;flex-wrap:wrap;gap:8px;">' +
        '<span>' + rowsData.length.toLocaleString() + (activeFilters ? ' of ' + all.length.toLocaleString() : '') + ' products' +
          (activeFilters ? ' · <button id="ptClearF" class="link-btn" style="width:auto;padding:4px 10px;display:inline-block;">Clear filters</button>' : '') + '</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="cPrev" ' + (cat.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + cat.page + ' of ' + totalPages + '</span><button id="cNext" ' + (cat.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';

    var pv = document.getElementById('cPrev'), nx = document.getElementById('cNext');
    if (pv) pv.addEventListener('click', function () { if (cat.page > 1) { cat.page--; drawProductTree(user); } });
    if (nx) nx.addEventListener('click', function () { if (cat.page < totalPages) { cat.page++; drawProductTree(user); } });
    var cf = document.getElementById('ptClearF');
    if (cf) cf.addEventListener('click', function () {
      cat.filters = {}; cat.status = ''; cat.page = 1;
      var sSel = document.getElementById('catStatus'); if (sSel) sSel.value = '';
      drawProductTree(user);
    });
    wireColTable(box, PT_COLS, cat, function (key) {
      // Keep the toolbar dropdown in step when Status is filtered from the header.
      if (key === 'status') { cat.status = cat.filters.status || ''; var sSel2 = document.getElementById('catStatus'); if (sSel2) sSel2.value = cat.status; }
      drawProductTree(user, key);
    });
    if (focusKey) {
      var back = box.querySelector('.colFilter[data-k="' + focusKey + '"]');
      if (back && back.tagName === 'INPUT') { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
    Array.prototype.forEach.call(box.querySelectorAll('.rowStatus'), function (sel) {
      sel.addEventListener('change', async function () {
        var r2 = await authed('/catalog/products/' + sel.getAttribute('data-pid') + '/status', { method: 'PATCH', body: { status: sel.value, reason: 'changed from workspace' } });
        if (!r2.ok) { alert('Could not change status (' + r2.status + ').'); loadProducts(user); return; }
        var row = (cat.rows || []).filter(function (x) { return x.id === sel.getAttribute('data-pid'); })[0];
        if (row) row.status = sel.value;
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.qboSync'), function (b) {
      b.addEventListener('click', function () {
        var p = (cat.rows || []).filter(function (x) { return x.id === b.getAttribute('data-pid'); })[0];
        if (p) openQboSyncForm(p, user);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.prodEdit'), function (b) {
      b.addEventListener('click', function () {
        var p = (cat.rows || []).filter(function (x) { return x.id === b.getAttribute('data-pid'); })[0];
        if (p) openProductEditForm(p, user);
      });
    });
  }

  /**
   * The QuickBooks column for one product.
   *
   * Three states worth distinguishing: not yet known (the link fetch is still in
   * flight), linked, and not linked. A product that is not ACTIVE cannot be synced —
   * syncItem refuses it — so the cell says so rather than offering a button that
   * will fail.
   */
  function qboCell(p, admin) {
    var chip = function (bg, bd, fg, text, title) {
      return '<span' + (title ? ' title="' + esc(title) + '"' : '') + ' style="display:inline-block;background:' + bg + ';border:1px solid ' + bd + ';color:' + fg + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;">' + esc(text) + '</span>';
    };
    if (qboItemLinks === null) return '<span class="muted" style="font-size:12px;">…</span>';
    var link = qboItemLinks[p.id];
    if (link && link.state === 'ERROR') return chip('#fbe9e6', '#f0cdc7', '#9c3327', 'Sync error', 'The last sync failed. Try again.');
    if (link) return chip('#eef5f0', '#cfe3d6', '#2f7d5d', 'Linked', 'QuickBooks item ' + link.qboId);
    if (p.status !== 'ACTIVE') return chip('#f2f3ef', '#e2e4dd', '#8a8f85', 'Not active', 'Only an active product can be synced to QuickBooks.');
    if (!admin) return chip('#fdf6e3', '#eadfbe', '#8a6d1f', 'Not linked');
    return '<button class="qboSync" data-pid="' + p.id + '" style="border:1px solid #3d4a55;background:#fff;border-radius:8px;padding:6px 11px;font-size:12.5px;color:#3d4a55;cursor:pointer;white-space:nowrap;">Sync to QBO</button>';
  }

  /**
   * Create (or adopt) the QuickBooks item for one product and record the link.
   *
   * QuickBooks needs an income account on a new item, so the first sync of a session
   * asks which one and remembers the answer. The account list comes from the
   * connected company — no typing account names, no guessing ids.
   */
  async function openQboSyncForm(p, user) {
    var accounts = null, err = '';
    try {
      var ra = await authed('/integrations/quickbooks/accounts');
      if (ra.status === 409) err = 'QuickBooks is not connected. Connect it under Administration → Integrations first.';
      else if (!ra.ok) err = 'Could not read the account list from QuickBooks (' + ra.status + ').';
      else accounts = ((await ra.json()) || {}).accounts || [];
    } catch (e) { err = 'Could not reach QuickBooks.'; }

    if (err) { openModal('Sync ' + p.sku, '<div class="err" style="font-size:13px;line-height:1.6;">' + esc(err) + '</div>', async function (close) { close(); }, 'Close'); return; }
    if (!accounts.length) { openModal('Sync ' + p.sku, '<div class="err" style="font-size:13px;line-height:1.6;">This QuickBooks company has no active income accounts, so an item cannot be created.</div>', async function (close) { close(); }, 'Close'); return; }

    var remembered = qboIncomeAccount && accounts.filter(function (x) { return x.id === qboIncomeAccount.id; })[0] ? qboIncomeAccount.id : accounts[0].id;
    openModal('Sync ' + p.sku + ' to QuickBooks',
      '<div style="font-size:13.5px;line-height:1.6;">Creates a QuickBooks item for <b>' + esc(p.name) + '</b> and links it to this catalog record, so proposal lines carrying this part can reach an estimate or invoice.</div>' +
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-top:8px;">If an item with SKU <code>' + esc(p.sku) + '</code> already exists in QuickBooks, it is adopted rather than duplicated. ' +
        (p.kind === 'SERVICE' ? 'It will be created as a Service item.' : 'It will be created as a Non-inventory item — Summit does not track QuickBooks stock quantities.') + '</div>' +
      '<div style="margin-top:14px;"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">Income account</label>' +
        '<select id="qboAcct" style="width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:14px;background:#fff;">' +
        accounts.map(function (ac) { return '<option value="' + esc(ac.id) + '"' + (ac.id === remembered ? ' selected' : '') + '>' + esc(ac.name) + (ac.subType ? ' — ' + esc(titleCase(String(ac.subType).replace(/([A-Z])/g, ' $1').trim())) : '') + '</option>'; }).join('') +
        '</select>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Where sales of this item post. Use the same account as the rest of your product lines unless you report on this one separately.</div></div>',
      async function (close, showErr) {
        var sel = document.getElementById('qboAcct');
        var acctId = sel ? sel.value : '';
        if (!acctId) return showErr('Choose an income account.');
        var r = await authed('/integrations/quickbooks/items/' + encodeURIComponent(p.id) + '/sync', { method: 'POST', body: { incomeAccountRef: acctId } });
        if (r.status === 409) return showErr('QuickBooks is not connected.');
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'The sync failed (' + r.status + ').'); }
        var out = (await r.json()) || {};
        var chosen = accounts.filter(function (x) { return x.id === acctId; })[0];
        qboIncomeAccount = { id: acctId, name: chosen ? chosen.name : '' };
        try { localStorage.setItem('ssg.qboIncomeAccount', JSON.stringify(qboIncomeAccount)); } catch (e) {}
        if (qboItemLinks) qboItemLinks[p.id] = { productId: p.id, qboId: out.qboId, state: 'OK' };
        close();
        drawProductTree(user);
      },
      'Sync to QuickBooks');
  }

  /** Edit a product-tree record in place: name, kind, category, descriptions, dimensions. */
  function openProductEditForm(p, user) {
    var catOpts = catOptionsTree(p.categoryId);
    var num = function (v) { return v == null || v === '' ? '' : String(v); };
    /** Where this product sits, and what else is filed in the same category. */
    function tierPanel(categoryId) {
      var c = catById(categoryId);
      var path = catPath(categoryId);
      var siblings = (cat.rows || []).filter(function (x) { return x.categoryId === categoryId && x.id !== p.id; })
        .sort(function (a, b) { return ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name); });
      var crumbs = path.length
        ? path.map(function (node, i) {
          return '<span style="' + (i === path.length - 1 ? 'font-weight:600;color:#20241f;' : 'color:#5c6157;') + '">' + esc(node.name) + '</span>';
        }).join('<span style="color:#b3b7ac;"> › </span>')
        : '<span class="muted">No category</span>';
      return '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:10px 12px;margin-bottom:12px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:3px;">Where this sits</div>' +
        '<div style="font-size:12.5px;line-height:1.55;">' + crumbs + '</div>' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">Tier ' + ((c && c.tierLevel) || path.length || '—') +
          (path.length > 1 ? ' · parent: ' + esc(path[path.length - 2].name) : ' · top level') + '</div>' +
        '<div style="margin-top:8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Also in this category, in order (' + siblings.length + ')</div>' +
        (siblings.length
          ? '<div style="max-height:132px;overflow:auto;margin-top:4px;">' + siblings.slice(0, 40).map(function (x) {
            return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0;">' +
              '<span style="color:#20241f;"><code style="color:#8a8f85;font-size:11px;font-variant-numeric:tabular-nums;">' + (Number(x.sortOrder) || 0) + '</code> ' + esc(x.name) + '</span>' +
              '<code style="color:#7a7f75;font-size:11px;white-space:nowrap;">' + esc(x.sku) + '</code></div>';
          }).join('') + (siblings.length > 40 ? '<div class="muted" style="font-size:11.5px;">…and ' + (siblings.length - 40) + ' more</div>' : '') + '</div>'
          : '<div class="muted" style="font-size:12px;margin-top:2px;">Nothing else — this is the only part filed here.</div>') +
        '</div>';
    }
    openModal('Edit ' + p.sku,
      '<div id="ePTier">' + tierPanel(p.categoryId) + '</div>' +
      fieldRow('SKU', '<input style="' + IN + 'background:#f2f3ef;" value="' + esc(p.sku) + '" disabled>') +
      fieldRow('Name', '<input id="ePName" style="' + IN + '" value="' + esc(p.name) + '">') +
      fieldRow('Kind', '<select id="ePKind" style="' + IN + '">' + KINDS.map(function (k) { return '<option value="' + k + '"' + (k === p.kind ? ' selected' : '') + '>' + titleCase(k) + '</option>'; }).join('') + '</select>') +
      fieldRow('Category / tier position', '<select id="ePCat" style="' + IN + '">' + catOpts + '</select>') +
      '<div class="field"><label>Sort order</label><input id="ePSort" type="number" min="0" step="1" style="' + IN + '" value="' + (Number(p.sortOrder) || 0) + '">' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">Position among the parts above. Lower comes first, and this is where the proposal builder files the part when a rep adds it. Ties break alphabetically — leaving gaps of 10 makes room to slot one in later. Catalog → Sort order by tier does the same thing with arrows.</div></div>' +
      '<div class="field"><label>Proposal description</label><textarea id="ePDesc" rows="3" style="' + IN + 'resize:vertical;">' + esc(p.proposalDescription || '') + '</textarea>' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">This is the text that prints under the line item on a proposal.</div></div>' +
      '<div class="field"><label>Internal description</label><textarea id="ePInt" rows="2" style="' + IN + 'resize:vertical;">' + esc(p.internalDescription || '') + '</textarea></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div class="field" style="flex:1;"><label>Length (in)</label><input id="ePL" type="number" min="0" style="' + IN + '" value="' + num(p.lengthIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Width (in)</label><input id="ePW" type="number" min="0" style="' + IN + '" value="' + num(p.widthIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Height (in)</label><input id="ePH" type="number" min="0" style="' + IN + '" value="' + num(p.heightIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Weight (oz)</label><input id="ePWt" type="number" min="0" style="' + IN + '" value="' + num(p.weightOz) + '"></div>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="ePShowDims"' + (p.showDimensions ? ' checked' : '') + '> Print dimensions on the proposal</label>' +
      '<div class="muted" style="font-size:12px;margin-top:8px;">Price, cost and weight in pounds live on the SKU — edit those on the Catalog tab. Status has its own dropdown in the list.</div>',
      async function (close, showErr) {
        var body = {
          name: document.getElementById('ePName').value.trim(),
          kind: document.getElementById('ePKind').value,
          categoryId: document.getElementById('ePCat').value,
          proposalDescription: document.getElementById('ePDesc').value.trim(),
          internalDescription: document.getElementById('ePInt').value.trim(),
          showDimensions: document.getElementById('ePShowDims').checked,
        };
        if (body.name.length < 2) return showErr('Name must be at least 2 characters.');
        var sortRaw = document.getElementById('ePSort').value;
        if (sortRaw !== '') {
          var sortNum = Number(sortRaw);
          if (!isFinite(sortNum) || sortNum < 0 || Math.floor(sortNum) !== sortNum) return showErr('Sort order must be a whole number, 0 or more.');
          body.sortOrder = sortNum;
        }
        [['ePL', 'lengthIn'], ['ePW', 'widthIn'], ['ePH', 'heightIn'], ['ePWt', 'weightOz']].forEach(function (f) {
          var v = document.getElementById(f[0]).value;
          if (v !== '') body[f[1]] = Number(v);
        });
        var r = await authed('/catalog/products/' + p.id, { method: 'PATCH', body: body });
        if (!r.ok) return showErr('Could not save (' + r.status + ').');
        close(); loadProducts(user);
      }, 'Save changes');
    var catSel = document.getElementById('ePCat');
    if (catSel) catSel.addEventListener('change', function () {
      var host = document.getElementById('ePTier');
      if (host) host.innerHTML = tierPanel(catSel.value);
    });
  }

  function openProductForm(user) {
    if (!catCategories.length) { alert('Create a category first — products must belong to one.'); return; }
    var catOpts = catCategories.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    openModal('New product',
      fieldRow('SKU', '<input id="pSku" placeholder="ABC-001" style="' + IN + 'text-transform:uppercase;" required>') +
      fieldRow('Name', '<input id="pName" style="' + IN + '" required>') +
      fieldRow('Kind', selectEl('pKind', KINDS, 'PRODUCT')) +
      fieldRow('Category', '<select id="pCat" style="' + IN + '">' + catOpts + '</select>') +
      fieldRow('Proposal description', '<textarea id="pDesc" rows="3" style="' + IN + 'resize:vertical;"></textarea>') +
      '<div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Length (in)</label><input id="pL" type="number" min="0" style="' + IN + '"></div>' +
      '<div class="field" style="flex:1;"><label>Width (in)</label><input id="pW" type="number" min="0" style="' + IN + '"></div>' +
      '<div class="field" style="flex:1;"><label>Height (in)</label><input id="pH" type="number" min="0" style="' + IN + '"></div></div>',
      async function (close, showErr) {
        var sku = document.getElementById('pSku').value.trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(sku)) return showErr('SKU must be 3–40 chars: letters, numbers, hyphens.');
        var name = document.getElementById('pName').value.trim();
        if (name.length < 2) return showErr('Name must be at least 2 characters.');
        var body = { sku: sku, name: name, kind: document.getElementById('pKind').value, categoryId: document.getElementById('pCat').value };
        var desc = document.getElementById('pDesc').value.trim(); if (desc) body.proposalDescription = desc;
        ['L', 'W', 'H'].forEach(function (k) { var v = document.getElementById('p' + k).value; if (v !== '') body[{ L: 'lengthIn', W: 'widthIn', H: 'heightIn' }[k]] = parseInt(v, 10); });
        var r = await authed('/catalog/products', { method: 'POST', body: body });
        if (r.status === 409) return showErr('That SKU already exists.');
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); cat.page = 1; loadProducts(user);
      });
  }

  /* ==================== Manufacturers ====================
   * The vendor of record: where a purchase order goes, who is called about it,
   * and whether their parts count toward the BOM's steel weight. */
  var mfrState = { rows: [], q: '', showInactive: false };

  async function renderManufacturers(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="mfSearch" placeholder="Search name, city or contact…" value="' + esc(mfrState.q) + '" style="flex:1;min-width:240px;max-width:380px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<label style="display:flex;gap:7px;align-items:center;font-size:13px;color:#5c6157;cursor:pointer;"><input type="checkbox" id="mfInactive"' + (mfrState.showInactive ? ' checked' : '') + '> Show inactive</label>' +
        '<button class="link-btn" id="mfExportParts" title="Every vendor part number on record, as a spreadsheet" style="width:auto;padding:10px 15px;">Export part numbers</button>' +
        (admin ? '<div style="margin-left:auto;"><button class="btn" id="mfNew" style="width:auto;padding:10px 17px;">New manufacturer</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">Each manufacturer is the vendor of record for the parts sourced from it. The address and point of contact print as the <b>Ship from</b> block on a Bill of Materials, and vendors marked as steel fabricators are the ones whose weight rolls into a BOM’s total steel weight.</div>' +
      '<div id="mfList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('mfSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { mfrState.q = s.value.trim(); drawManufacturers(user); }, 250); });
    document.getElementById('mfInactive').addEventListener('change', function (e) { mfrState.showInactive = e.target.checked; loadManufacturers(user); });
    if (admin) document.getElementById('mfNew').addEventListener('click', function () { openManufacturerForm(null, user); });
    document.getElementById('mfExportParts').addEventListener('click', function (e) { window.SSGVendorParts.exportAll(e.currentTarget); });
    loadManufacturers(user);
  }

  async function loadManufacturers(user) {
    var box = document.getElementById('mfList'); if (!box) return;
    try {
      var r = await authed('/manufacturers' + (mfrState.showInactive ? '?includeInactive=true' : ''));
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load manufacturers (' + r.status + '). Run the 0022 migration if this persists.</div>'; return; }
      mfrState.rows = (await r.json()) || [];
      drawManufacturers(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function mfrCityLine(m) {
    var right = [m.region, m.postalCode].filter(Boolean).join(' ');
    return [m.city, right].filter(Boolean).join(', ');
  }

  function drawManufacturers(user) {
    var box = document.getElementById('mfList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var q = mfrState.q.toLowerCase();
    var rows = (mfrState.rows || []).filter(function (m) {
      return !q || (m.name + ' ' + (m.city || '') + ' ' + (m.contactName || '') + ' ' + (m.contactEmail || '')).toLowerCase().indexOf(q) !== -1;
    });
    var body = rows.map(function (m) {
      var parts = (m.productCount || 0) + (m.skuCount || 0);
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(m.name) + '</b>' +
          (m.isSteelFabricator ? ' <span class="chip" style="font-size:10.5px;background:#eef0ea;">Steel</span>' : '') +
          (m.isActive === false ? ' <span class="chip" style="font-size:10.5px;background:#f2f3ef;color:#8a8f85;">Inactive</span>' : '') +
          (m.accountNumber ? '<div class="muted" style="font-size:11.5px;">Acct ' + esc(m.accountNumber) + '</div>' : '')) +
        td(m.contactName
          ? '<span style="font-size:13px;">' + esc(m.contactName) + '</span>' +
            (m.contactEmail ? '<div class="muted" style="font-size:11.5px;">' + esc(m.contactEmail) + '</div>' : '') +
            (m.contactPhone ? '<div class="muted" style="font-size:11.5px;">' + esc(m.contactPhone) + '</div>' : '')
          : '<span class="muted">—</span>') +
        td(m.addressLine1
          ? '<span style="font-size:13px;">' + esc(m.addressLine1) + '</span><div class="muted" style="font-size:11.5px;">' + esc(mfrCityLine(m)) + '</div>'
          : '<span class="muted">—</span>') +
        td(esc(m.paymentTerms || '—')) +
        td(m.defaultLeadTimeDays == null ? '—' : m.defaultLeadTimeDays + ' days') +
        td(parts
          ? '<button class="mfPartsList link-btn" data-id="' + m.id + '" title="Show the parts sourced from this vendor" style="width:auto;padding:4px 10px;font-variant-numeric:tabular-nums;">' + parts + '</button>'
          : '<span class="muted">0</span>') +
        td(admin ? '<div style="display:flex;gap:6px;justify-content:flex-end;">' +
          '<button class="mfParts link-btn" data-id="' + m.id + '" title="What this vendor calls parts we number ourselves" style="width:auto;padding:6px 12px;">Part numbers</button>' +
          '<button class="mfEdit link-btn" data-id="' + m.id + '" style="width:auto;padding:6px 12px;">Edit</button>' +
          '<button class="mfDel link-btn" data-id="' + m.id + '" style="width:auto;padding:6px 10px;color:#9c3327;">Remove</button></div>' : '') +
        '</tr>';
    }).join('');
    box.innerHTML = tableShell(['Manufacturer', 'Primary contact', 'Address', 'Terms', 'Lead time', 'Parts', ''], body, 7,
      mfrState.rows.length ? 'No manufacturers match that search.' : 'No manufacturers yet. Add the vendors you buy from.');
    box.querySelectorAll('.mfEdit').forEach(function (b) {
      b.addEventListener('click', function () {
        openManufacturerForm((mfrState.rows || []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0], user);
      });
    });
    box.querySelectorAll('.mfDel').forEach(function (b) {
      b.addEventListener('click', function () { openManufacturerDelete(b.getAttribute('data-id'), user); });
    });
    box.querySelectorAll('.mfParts').forEach(function (b) {
      b.addEventListener('click', function () {
        window.SSGVendorParts.open((mfrState.rows || []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0], user);
      });
    });
    box.querySelectorAll('.mfPartsList').forEach(function (b) {
      b.addEventListener('click', function () {
        openManufacturerPartsList((mfrState.rows || []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0], user);
      });
    });
  }

  /**
   * The parts sourced from one vendor.
   *
   * The PARTS column was a bare count with nothing behind it — it said 134 and
   * there was no way to see which 134. This is that list, and it is data the API
   * has always returned: GET /manufacturers/:id carries a merged `parts` array
   * the front end threw away.
   *
   * Two kinds of row are merged there, which is worth knowing when a number looks
   * wrong. A CATALOG row is linked by id through ProductSourcing. A SKU-MASTER row
   * is linked by manufacturer NAME — that is the only link a generated frame or
   * hardware part has, so an exact-name near-duplicate ("Southpaw Enterprise" vs
   * "Southpaw Enterprises") splits one vendor's parts across two records, and
   * renaming a vendor drops the name-matched ones.
   *
   * Not to be confused with "Part numbers", which is this vendor's own numbering
   * for parts we number ourselves.
   */
  async function openManufacturerPartsList(m, user) {
    if (!m) return;
    var all = [];
    var q = '';
    var loadError = '';
    var loading = true;
    var ov = null;
    var $ = function (sel) { return ov ? ov.querySelector(sel) : null; };
    var cash = function (minor) {
      if (minor == null || minor === '') return '<span class="muted">—</span>';
      return '$' + (Number(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    ov = openModal('Parts from ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' +
        'Every part this vendor is on record as the source for. Costs are what we pay ' + esc(m.name) + ', not what a customer sees.</div>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">' +
        '<input id="mpSearch" placeholder="Search part number or description…" style="' + IN + 'max-width:320px;">' +
        '<div id="mpCount" class="muted" style="font-size:12px;white-space:nowrap;"></div>' +
      '</div>' +
      '<div id="mpBody"><div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div></div>',
      null, null, { maxWidth: '840px' });

    var s = $('#mpSearch'), t;
    if (s) s.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { q = s.value.trim().toLowerCase(); draw(); }, 180);
    });

    function row(p) {
      return '<tr>' +
        td('<span style="font-family:ui-monospace,monospace;font-size:12.5px;">' + esc(p.part) + '</span>' +
          (p.active === false ? ' <span class="chip" style="font-size:10px;background:#f2f3ef;color:#8a8f85;">Inactive</span>' : '')) +
        td('<span style="font-size:13px;">' + esc(p.name || '') + '</span>') +
        td(p.vendorPartNo
          ? '<span style="font-family:ui-monospace,monospace;font-size:12.5px;">' + esc(p.vendorPartNo) + '</span>'
          : '<span class="muted">—</span>') +
        td('<span style="font-size:13px;">' + cash(p.unitCostMinor) + '</span>') +
        td(p.weightLbs ? '<span style="font-size:13px;">' + Number(p.weightLbs).toFixed(1) + ' lb</span>' : '<span class="muted">—</span>') +
        '</tr>';
    }

    function draw() {
      var box = $('#mpBody'), count = $('#mpCount');
      if (!box) return;
      if (loading) { box.innerHTML = '<div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div>'; return; }
      var rows = all.filter(function (p) {
        return !q || ((p.part || '') + ' ' + (p.name || '') + ' ' + (p.vendorPartNo || '')).toLowerCase().indexOf(q) !== -1;
      });
      if (count) count.innerHTML = rows.length === all.length
        ? esc(all.length + (all.length === 1 ? ' part' : ' parts'))
        : esc(rows.length + ' of ' + all.length);
      box.innerHTML =
        (loadError ? '<div class="err">' + esc(loadError) + '</div>' : '') +
        '<div style="max-height:52vh;overflow:auto;">' +
          tableShell(['Part #', 'Description', esc(m.name) + ' part #', 'Unit cost', 'Weight'], rows.map(row).join(''), 5,
            all.length ? 'No parts match that search.' : 'No parts are sourced from this vendor yet.') +
        '</div>';
    }

    draw();
    try {
      var r = await authed('/manufacturers/' + m.id);
      loading = false;
      if (!r.ok) {
        loadError = 'Could not load the parts list (' + r.status + ').';
      } else {
        var d = await r.json();
        all = (d.parts || []).slice();
      }
    } catch (e) {
      loading = false;
      loadError = 'Could not reach the server.';
    }
    draw();
  }

  function openManufacturerForm(m, user) {
    m = m || {};
    var v = function (k) { return esc(m[k] == null ? '' : m[k]); };
    var two = function (a, b) { return '<div style="display:flex;gap:8px;"><div style="flex:1;">' + a + '</div><div style="flex:1;">' + b + '</div></div>'; };
    // Mirrors vendorAbbrev() in src/handoff/freightRfq.ts — shown as the placeholder
    // so the field says what it will do when left blank.
    function derivedAbbrev(name) {
      var words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/)
        .filter(function (w) { return w && !/^(the|and|of|inc|llc|co|company|corp|ltd)$/i.test(w); });
      if (!words.length) return '';
      if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
      return words.map(function (w) { return w[0]; }).join('').slice(0, 4).toUpperCase();
    }
    openModal(m.id ? 'Edit ' + m.name : 'New manufacturer',
      fieldRow('Manufacturer name', '<input id="mfName" style="' + IN + '" value="' + v('name') + '" required>') +
      fieldRow('Freight RFQ code',
        '<input id="mfRfqAbbrev" maxlength="8" style="' + IN + 'text-transform:uppercase;" value="' + v('rfqAbbrev') + '" placeholder="' + esc(derivedAbbrev(m.name) || 'SE') + '">' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Appended to this vendor\'s freight requests so several on one project are told apart — <b>RFQ-12414494509-' + esc(derivedAbbrev(m.name) || 'SE') + '</b>, where the middle number is the monday Project ID. Leave it blank to use the initials shown.</div>') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Primary point of contact</div>' +
      two(fieldRow('Name', '<input id="mfCName" style="' + IN + '" value="' + v('contactName') + '">'),
          fieldRow('Title', '<input id="mfCTitle" style="' + IN + '" value="' + v('contactTitle') + '">')) +
      two(fieldRow('Email', '<input id="mfCEmail" type="email" style="' + IN + '" value="' + v('contactEmail') + '">'),
          fieldRow('Phone', '<input id="mfCPhone" style="' + IN + '" value="' + v('contactPhone') + '">')) +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Secondary contact</div>' +
      two(fieldRow('Name', '<input id="mfAName" style="' + IN + '" value="' + v('altContactName') + '">'),
          fieldRow('Phone', '<input id="mfAPhone" style="' + IN + '" value="' + v('altContactPhone') + '">')) +
      fieldRow('Email', '<input id="mfAEmail" type="email" style="' + IN + '" value="' + v('altContactEmail') + '">') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Address</div>' +
      fieldRow('Street', '<input id="mfAddr1" style="' + IN + '" value="' + v('addressLine1') + '">') +
      fieldRow('Suite / unit', '<input id="mfAddr2" placeholder="Suite 100" style="' + IN + '" value="' + v('addressLine2') + '">') +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:2;">' + fieldRow('City', '<input id="mfCity" style="' + IN + '" value="' + v('city') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('State', '<input id="mfRegion" style="' + IN + '" value="' + v('region') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('ZIP', '<input id="mfZip" style="' + IN + '" value="' + v('postalCode') + '">') + '</div>' +
      '</div>' +
      two(fieldRow('Country', '<input id="mfCountry" style="' + IN + '" value="' + esc(m.country == null ? 'USA' : m.country) + '">'),
          fieldRow('Website', '<input id="mfWeb" placeholder="https://" style="' + IN + '" value="' + v('website') + '">')) +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Purchasing</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;">' + fieldRow('Our account #', '<input id="mfAcct" style="' + IN + '" value="' + v('accountNumber') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Payment terms', '<input id="mfTerms" placeholder="e.g. Net 30" style="' + IN + '" value="' + v('paymentTerms') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Lead time (days)', '<input id="mfLead" type="number" min="0" style="' + IN + '" value="' + (m.defaultLeadTimeDays == null ? '' : m.defaultLeadTimeDays) + '">') + '</div>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:4px;"><input type="checkbox" id="mfSteel"' + (m.isSteelFabricator ? ' checked' : '') + '> Steel fabricator — their lines count toward total steel weight on a BOM</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfThird"' + (m.id ? (m.isThirdParty ? ' checked' : '') : ' checked') + '> Third-party vendor (unchecked = made in-house)</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfActive"' + (m.id ? (m.isActive !== false ? ' checked' : '') : ' checked') + '> Active — offered when assigning a vendor</label>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfFreightTbd" style="margin-top:3px;"' + (m.freightTbd ? ' checked' : '') + '><span>Freight quoted after approval<span class="muted" style="display:block;font-size:11.5px;line-height:1.5;">Every part from this vendor carries the standing “freight not yet determined” note on its proposal line, until a freight amount is entered on that line.</span></span></label>' +
      '<div class="field" style="margin-top:10px;"><label>Notes</label><textarea id="mfNotes" rows="2" style="' + IN + 'resize:vertical;">' + esc(m.notes || '') + '</textarea></div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:16px 0 6px;">Request for Freight (RFQ)</div>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="mfRfq" style="margin-top:3px;"' + (m.rfqEnabled ? ' checked' : '') + '><span>Can receive freight quote requests<span class="muted" style="display:block;font-size:11.5px;line-height:1.5;">Offered as an RFQ recipient on any proposal carrying their parts. Vendors who do not quote freight stay off the list.</span></span></label>' +
      '<div class="muted" style="font-size:12px;margin:10px 0 8px;line-height:1.5;">The freight desk is rarely the purchasing contact the BOM goes to. Left blank, these fall back to the primary contact above. Tokens for the message: <code>{{customer}}</code> <code>{{vendor}}</code> <code>{{reference}}</code> <code>{{projectId}}</code> <code>{{total}}</code>.</div>' +
      two(fieldRow('Freight contact', '<input id="mfRfqName" style="' + IN + '" value="' + v('rfqContactName') + '">'),
          fieldRow('Phone', '<input id="mfRfqPhone" style="' + IN + '" value="' + v('rfqContactPhone') + '">')) +
      two(fieldRow('Send RFQs to', '<input id="mfRfqTo" type="email" placeholder="Falls back to the contact email" style="' + IN + '" value="' + v('rfqEmailTo') + '">'),
          fieldRow('Cc', '<input id="mfRfqCc" placeholder="Optional" style="' + IN + '" value="' + v('rfqEmailCc') + '">')) +
      fieldRow('Freight contact email', '<input id="mfRfqEmail" type="email" placeholder="Named contact, if different from the send-to address" style="' + IN + '" value="' + v('rfqContactEmail') + '">') +
      fieldRow('Subject', '<input id="mfRfqSubject" placeholder="Freight quote request {{reference}} — {{customer}}" style="' + IN + '" value="' + v('rfqEmailSubject') + '">') +
      '<div class="field"><label>Default message</label><textarea id="mfRfqBody" rows="4" placeholder="Left blank, a standard covering note is used." style="' + IN + 'resize:vertical;">' + esc(m.rfqEmailBody || '') + '</textarea></div>' +
      fieldRow('Freight figure on the deal',
        '<select id="mfFreightSrc" style="' + IN + '">' +
          '<option value="STRUCTURE"' + (m.bomFreightSource === 'MATS' || m.bomFreightSource === 'NONE' ? '' : ' selected') + '>Structure freight</option>' +
          '<option value="MATS"' + (m.bomFreightSource === 'MATS' ? ' selected' : '') + '>Mats freight</option>' +
          '<option value="NONE"' + (m.bomFreightSource === 'NONE' ? ' selected' : '') + '>None — this vendor quotes no freight</option>' +
        '</select>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">The structure and the mats ship as two loads and are quoted separately on the deal. This says which figure lands on this vendor&rsquo;s sheet.</div>') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:16px 0 6px;">Bill of Materials email</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:8px;line-height:1.5;">Pre-fills the send dialog for this vendor — a fabricator and a distributor rarely want the same note or the same format. Tokens: <code>{{customer}}</code> <code>{{vendor}}</code> <code>{{order}}</code> <code>{{job}}</code> <code>{{submittedOn}}</code>. Left blank, the subject matches the attachment name: <code>{{customer}}-{{order}}-{{vendor}}</code>.</div>' +
      two(fieldRow('Send BOMs to', '<input id="mfBomTo" type="email" placeholder="Falls back to the contact email" style="' + IN + '" value="' + v('bomEmailTo') + '">'),
          fieldRow('Cc', '<input id="mfBomCc" placeholder="Optional" style="' + IN + '" value="' + v('bomEmailCc') + '">')) +
      fieldRow('Subject', '<input id="mfBomSubject" placeholder="{{customer}}-{{order}}-{{vendor}}" style="' + IN + '" value="' + v('bomEmailSubject') + '">') +
      fieldRow('Attach as', '<select id="mfBomFormat" style="' + IN + '">' +
        ['PDF', 'EXCEL', 'BOTH'].map(function (f) { return '<option value="' + f + '"' + ((m.bomEmailFormat || 'PDF') === f ? ' selected' : '') + '>' + (f === 'BOTH' ? 'Both' : f === 'EXCEL' ? 'Excel' : 'PDF') + '</option>'; }).join('') +
        '</select>') +
      '<div class="field"><label>Default message</label><textarea id="mfBomBody" rows="5" placeholder="Left blank, a standard covering note is used." style="' + IN + 'resize:vertical;">' + esc(m.bomEmailBody || '') + '</textarea></div>',
      async function (close, showErr) {
        var name = document.getElementById('mfName').value.trim();
        if (name.length < 2) return showErr('Manufacturer name is required.');
        var lead = document.getElementById('mfLead').value;
        var body = {
          name: name,
          contactName: document.getElementById('mfCName').value.trim(),
          contactTitle: document.getElementById('mfCTitle').value.trim(),
          contactEmail: document.getElementById('mfCEmail').value.trim(),
          contactPhone: document.getElementById('mfCPhone').value.trim(),
          altContactName: document.getElementById('mfAName').value.trim(),
          altContactEmail: document.getElementById('mfAEmail').value.trim(),
          altContactPhone: document.getElementById('mfAPhone').value.trim(),
          bomEmailTo: document.getElementById('mfBomTo').value.trim(),
          bomEmailCc: document.getElementById('mfBomCc').value.trim(),
          bomEmailSubject: document.getElementById('mfBomSubject').value.trim(),
          bomEmailBody: document.getElementById('mfBomBody').value,
          bomEmailFormat: document.getElementById('mfBomFormat').value,
          bomFreightSource: document.getElementById('mfFreightSrc').value,
          rfqEnabled: document.getElementById('mfRfq').checked,
          rfqContactName: document.getElementById('mfRfqName').value.trim(),
          rfqContactEmail: document.getElementById('mfRfqEmail').value.trim(),
          rfqContactPhone: document.getElementById('mfRfqPhone').value.trim(),
          rfqEmailTo: document.getElementById('mfRfqTo').value.trim(),
          rfqEmailCc: document.getElementById('mfRfqCc').value.trim(),
          rfqEmailSubject: document.getElementById('mfRfqSubject').value.trim(),
          rfqEmailBody: document.getElementById('mfRfqBody').value,
          addressLine1: document.getElementById('mfAddr1').value.trim(),
          addressLine2: document.getElementById('mfAddr2').value.trim(),
          city: document.getElementById('mfCity').value.trim(),
          region: document.getElementById('mfRegion').value.trim(),
          postalCode: document.getElementById('mfZip').value.trim(),
          country: document.getElementById('mfCountry').value.trim(),
          website: document.getElementById('mfWeb').value.trim(),
          accountNumber: document.getElementById('mfAcct').value.trim(),
          paymentTerms: document.getElementById('mfTerms').value.trim(),
          defaultLeadTimeDays: lead === '' ? null : parseInt(lead, 10) || 0,
          isSteelFabricator: document.getElementById('mfSteel').checked,
          isThirdParty: document.getElementById('mfThird').checked,
          freightTbd: document.getElementById('mfFreightTbd').checked,
          rfqAbbrev: document.getElementById('mfRfqAbbrev').value.trim().toUpperCase(),
          isActive: document.getElementById('mfActive').checked,
          notes: document.getElementById('mfNotes').value.trim()
        };
        var r = m.id
          ? await authed('/manufacturers/' + m.id, { method: 'PATCH', body: body })
          : await authed('/manufacturers', { method: 'POST', body: body });
        if (!r.ok) { var msg = ''; try { msg = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(msg || 'Could not save (' + r.status + ').'); }
        close(); loadManufacturers(user);
      }, m.id ? 'Save manufacturer' : 'Create manufacturer');
  }

  /** Removing a vendor is only safe when nothing points at it. */
  async function openManufacturerDelete(id, user) {
    var u = null;
    try { var r = await authed('/manufacturers/' + id + '/usage'); if (r.ok) u = await r.json(); } catch (e) {}
    if (!u) { alert('Could not check where this vendor is used.'); return; }
    openModal('Remove ' + u.name,
      (u.deletable
        ? '<div style="font-size:13.5px;line-height:1.6;">Nothing references this vendor, so it can be deleted outright.</div>'
        : '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;line-height:1.55;">' + esc(u.reason) + '</div>') +
      '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.55;">Deactivating keeps every part, order and past BOM exactly as it is, and simply stops the vendor being offered.</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;"><button type="button" class="link-btn" id="mfDeact" style="width:auto;padding:9px 15px;">Deactivate instead</button></div>',
      u.deletable
        ? async function (close, showErr) {
          var rr = await authed('/manufacturers/' + id, { method: 'DELETE' });
          if (!rr.ok && rr.status !== 204) { var msg = ''; try { msg = ((await rr.json()) || {}).message || ''; } catch (e) {} return showErr(msg || 'Could not delete (' + rr.status + ').'); }
          close(); loadManufacturers(user);
        }
        : async function (close) { close(); },
      u.deletable ? 'Delete permanently' : 'Close');
    var da = document.getElementById('mfDeact');
    if (da) da.addEventListener('click', async function () {
      var rr = await authed('/manufacturers/' + id, { method: 'PATCH', body: { isActive: false } });
      if (!rr.ok) { alert('Could not deactivate (' + rr.status + ').'); return; }
      var form = document.getElementById('mForm');
      if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
      loadManufacturers(user);
    });
  }

  /* ==================== Bundles ====================
   * A bundle is one catalog part whose contents are other catalog parts. It has no
   * price of its own — price, cost and weight are always the sum of its
   * components, so repricing a component can never leave a stale bundle behind. */
  var bundleState = { rows: [], q: '' };

  async function renderBundles(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="bnSearch" placeholder="Search bundles…" value="' + esc(bundleState.q) + '" style="flex:1;min-width:220px;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (admin ? '<div style="margin-left:auto;"><button class="btn" id="bnNew" style="width:auto;padding:10px 17px;">New bundle</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">A bundle is a single proposal line priced as the sum of its parts, with the parts listed beneath it. Because those sub-lines carry the real part numbers, the Bill of Materials, the cost of goods and the freight weight all see the actual components.</div>' +
      '<div id="bnList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('bnSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { bundleState.q = s.value.trim(); drawBundles(user); }, 250); });
    if (admin) document.getElementById('bnNew').addEventListener('click', function () { openBundleForm(user); });
    loadBundles(user);
  }

  async function loadBundles(user) {
    var box = document.getElementById('bnList'); if (!box) return;
    try {
      var r = await authed('/catalog/bundles');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load bundles (' + r.status + ').</div>'; return; }
      bundleState.rows = (await r.json()) || [];
      drawBundles(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawBundles(user) {
    var box = document.getElementById('bnList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var q = bundleState.q.toLowerCase();
    var rows = (bundleState.rows || []).filter(function (b) { return !q || (b.name + ' ' + b.sku).toLowerCase().indexOf(q) !== -1; });
    if (!rows.length) {
      box.innerHTML = '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">' +
        (bundleState.rows.length ? 'No bundles match that search.' : 'No bundles yet. Create one, then add the parts it contains.') + '</p></div>';
      return;
    }
    box.innerHTML = rows.map(function (b) {
      var comp = b.components || [];
      var inner = comp.length
        ? '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
            '<thead><tr>' + ['Part #', 'Component', 'Qty', 'Unit price', 'Extended'].map(function (h, i) {
              return '<th style="text-align:' + (i > 1 ? 'right' : 'left') + ';padding:7px 10px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;border-bottom:1px solid #eef0ea;">' + h + '</th>';
            }).join('') + '</tr></thead><tbody>' +
            comp.map(function (c) {
              return '<tr>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;"><code style="font-size:12px;color:#4a4f47;">' + esc(c.sku) + '</code></td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;">' + esc(c.name) + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">' + c.quantity + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">$' + (Number(c.unitPriceMinor) / 100).toFixed(2) + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">$' + (Number(c.extendedPriceMinor) / 100).toFixed(2) + '</td></tr>';
            }).join('') +
          '</tbody></table>'
        : '<div class="muted" style="padding:12px 10px;font-size:13px;">Nothing in this bundle yet.</div>';
      return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;padding:14px 16px;margin-bottom:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
          '<div><div style="font-weight:600;font-size:15px;">' + esc(b.name) + ' <code style="font-size:12px;color:#7a7f75;font-weight:400;">' + esc(b.sku) + '</code></div>' +
            '<div class="muted" style="font-size:12px;margin-top:2px;">' + comp.length + ' component' + (comp.length === 1 ? '' : 's') +
              ' · rolls up to <b style="color:#20241f;">$' + (Number(b.unitPriceMinor) / 100).toFixed(2) + '</b>' +
              ' · cost $' + (Number(b.unitCostMinor) / 100).toFixed(2) + ' · ' + b.weightLbs + ' lb' +
              (b.missingPrice && b.missingPrice.length ? ' · <span style="color:#9c3327;">' + b.missingPrice.length + ' component(s) have no price</span>' : '') + '</div></div>' +
          (admin ? '<div style="display:flex;gap:6px;">' +
            '<button class="bnEdit link-btn" data-id="' + b.id + '" style="width:auto;padding:7px 13px;">Edit contents</button>' +
            '<button class="bnDel link-btn" data-id="' + b.id + '" style="width:auto;padding:7px 11px;color:#9c3327;">Delete</button></div>' : '') +
        '</div>' +
        '<div style="margin-top:10px;">' + inner + '</div>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.bnEdit').forEach(function (bt) {
      bt.addEventListener('click', function () {
        openBundleComponents((bundleState.rows || []).filter(function (x) { return x.id === bt.getAttribute('data-id'); })[0], user);
      });
    });
    box.querySelectorAll('.bnDel').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        if (!confirm('Delete this bundle? Its component parts are not touched.')) return;
        var r = await authed('/catalog/bundles/' + bt.getAttribute('data-id'), { method: 'DELETE' });
        if (!r.ok && r.status !== 204) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not delete (' + r.status + ').'); return; }
        loadBundles(user);
      });
    });
  }

  async function openBundleForm(user) {
    if (!catCategories.length) {
      try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : []; } catch (e) {}
    }
    if (!catCategories.length) { alert('Create a category first — a bundle is filed like any other product.'); return; }
    openModal('New bundle',
      fieldRow('Part #', '<input id="bnSku" placeholder="e.g. SSG-STARTER-BUNDLE" style="' + IN + 'text-transform:uppercase;" required>') +
      fieldRow('Bundle name', '<input id="bnName" style="' + IN + '" required>') +
      fieldRow('Category', '<select id="bnCat" style="' + IN + '">' + catOptionsTree('') + '</select>') +
      fieldRow('Proposal description', '<textarea id="bnDesc" rows="3" style="' + IN + 'resize:vertical;"></textarea>') +
      '<div class="muted" style="font-size:12px;">You add the parts it contains next. The price is always the sum of those parts.</div>',
      async function (close, showErr) {
        var sku = document.getElementById('bnSku').value.trim().toUpperCase();
        if (sku.length < 2) return showErr('A part # is required.');
        var name = document.getElementById('bnName').value.trim();
        if (name.length < 2) return showErr('Give the bundle a name.');
        var r = await authed('/catalog/bundles', { method: 'POST', body: {
          sku: sku, name: name, categoryId: document.getElementById('bnCat').value,
          proposalDescription: document.getElementById('bnDesc').value.trim() || undefined
        } });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not create (' + r.status + ').'); }
        var created = await r.json();
        close();
        await loadBundles(user);
        openBundleComponents({ id: created.id, sku: created.sku, name: created.name, components: [] }, user);
      }, 'Create bundle');
  }

  /** Search-and-add panel for a bundle's contents. Sends the whole list at once. */
  async function openBundleComponents(bundle, user) {
    if (!bundle) return;
    var picked = (bundle.components || []).map(function (c) { return { productId: c.productId, sku: c.sku, name: c.name, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor }; });
    var products = [];
    try {
      var r = await authed('/catalog/products?pageSize=500');
      if (r.ok) products = ((await r.json()) || {}).items || [];
    } catch (e) {}
    products = products.filter(function (p) { return p.kind !== 'BUNDLE'; });

    function pickedHtml() {
      if (!picked.length) return '<div class="muted" style="padding:12px;font-size:13px;">Nothing added yet — search below.</div>';
      var total = picked.reduce(function (a, c) { return a + (Number(c.unitPriceMinor) || 0) * (Number(c.quantity) || 0); }, 0);
      return picked.map(function (c, i) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #f2f3ef;">' +
          '<div style="flex:1;font-size:13px;">' + esc(c.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(c.sku) + '</code></div>' +
          '<input class="bcQty" data-i="' + i + '" type="number" min="1" value="' + (c.quantity || 1) + '" style="width:64px;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;text-align:right;font-size:13px;">' +
          '<div style="width:88px;text-align:right;font-size:12.5px;color:#5c6157;">$' + ((Number(c.unitPriceMinor) || 0) * (Number(c.quantity) || 0) / 100).toFixed(2) + '</div>' +
          '<button type="button" class="bcRm" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 9px;font-size:12px;">✕</button>' +
        '</div>';
      }).join('') +
      '<div style="display:flex;justify-content:flex-end;gap:10px;padding:9px 10px;font-size:13px;font-weight:600;">Bundle price $' + (total / 100).toFixed(2) + '</div>';
    }
    function searchHtml(list) {
      return (list.slice(0, 60).map(function (p) {
        return '<button type="button" class="bcAdd" data-id="' + p.id + '" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid #f2f3ef;background:#fff;padding:8px 11px;cursor:pointer;font-size:13px;">' +
          esc(p.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(p.sku) + '</code></button>';
      }).join('')) || '<div class="muted" style="padding:12px;font-size:13px;">No parts match.</div>';
    }

    openModal('Contents of ' + bundle.name,
      '<div style="border:1px solid #e7e8e3;border-radius:10px;overflow:hidden;margin-bottom:12px;"><div id="bcPicked">' + pickedHtml() + '</div></div>' +
      '<input id="bcSearch" placeholder="Search a part to add…" style="' + IN + 'margin-bottom:8px;">' +
      '<div id="bcResults" style="max-height:220px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' + searchHtml(products) + '</div>',
      async function (close, showErr) {
        var r2 = await authed('/catalog/bundles/' + bundle.id + '/components', { method: 'PUT', body: {
          components: picked.map(function (c) { return { productId: c.productId, quantity: Number(c.quantity) || 1 }; })
        } });
        if (!r2.ok) { var m = ''; try { m = ((await r2.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not save (' + r2.status + ').'); }
        close(); loadBundles(user);
      }, 'Save contents');

    function repaint() {
      var host = document.getElementById('bcPicked'); if (!host) return;
      host.innerHTML = pickedHtml();
      host.querySelectorAll('.bcQty').forEach(function (el) {
        el.addEventListener('change', function () { picked[Number(el.getAttribute('data-i'))].quantity = Math.max(1, parseInt(el.value, 10) || 1); repaint(); });
      });
      host.querySelectorAll('.bcRm').forEach(function (el) {
        el.addEventListener('click', function () { picked.splice(Number(el.getAttribute('data-i')), 1); repaint(); });
      });
    }
    function wireResults(list) {
      var box = document.getElementById('bcResults'); if (!box) return;
      box.querySelectorAll('.bcAdd').forEach(function (b) {
        b.addEventListener('click', async function () {
          var p = list.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
          if (!p || picked.some(function (c) { return c.productId === p.id; })) return;
          var price = 0;
          try {
            var rp = await authed('/catalog/items?q=' + encodeURIComponent(p.sku) + '&pageSize=5');
            if (rp.ok) {
              var hit = (((await rp.json()) || {}).items || []).filter(function (x) { return x.part === p.sku; })[0];
              if (hit) price = hit.unitPriceMinor || 0;
            }
          } catch (e) {}
          picked.push({ productId: p.id, sku: p.sku, name: p.name, quantity: 1, unitPriceMinor: price });
          repaint();
        });
      });
    }
    setTimeout(function () {
      repaint(); wireResults(products);
      var s = document.getElementById('bcSearch');
      if (s) s.addEventListener('input', function () {
        var q = s.value.toLowerCase();
        var list = products.filter(function (p) { return (p.name + ' ' + p.sku).toLowerCase().indexOf(q) !== -1; });
        document.getElementById('bcResults').innerHTML = searchHtml(list);
        wireResults(list);
      });
    }, 50);
  }

  /* ==================== Product tree: categories, order, workbook ==================== */

  /** Rename, reorder, hide and delete the tier categories. */
  async function openCategoryManager(user) {
    try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : catCategories; } catch (e) {}
    var list = (catCategories || []).slice().sort(function (a, b) {
      return ((a.tierLevel || 1) - (b.tierLevel || 1)) || ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
    });
    var counts = {};
    (cat.rows || []).forEach(function (p) { counts[p.categoryId] = (counts[p.categoryId] || 0) + 1; });

    function rowHtml(c, i) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #f2f3ef;">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button type="button" class="cmUp" data-i="' + i + '" title="Move up" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;line-height:1;padding:2px 5px;">▲</button>' +
          '<button type="button" class="cmDown" data-i="' + i + '" title="Move down" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;line-height:1;padding:2px 5px;">▼</button>' +
        '</div>' +
        '<input class="cmName" data-id="' + c.id + '" value="' + esc(c.name) + '" style="flex:1;padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:13px;">' +
        '<select class="cmTier" data-id="' + c.id + '" style="padding:6px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
          [1, 2, 3, 4].map(function (t) { return '<option value="' + t + '"' + ((c.tierLevel || 1) === t ? ' selected' : '') + '>Tier ' + t + '</option>'; }).join('') +
        '</select>' +
        '<span class="muted" style="font-size:11.5px;width:74px;text-align:right;">' + (counts[c.id] || 0) + ' part' + ((counts[c.id] || 0) === 1 ? '' : 's') + '</span>' +
        '<label style="display:flex;gap:5px;align-items:center;font-size:11.5px;color:#5c6157;"><input type="checkbox" class="cmActive" data-id="' + c.id + '"' + (c.isActive === false ? '' : ' checked') + '> shown</label>' +
        '<button type="button" class="cmDel" data-id="' + c.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 8px;font-size:12px;">✕</button>' +
      '</div>';
    }
    openModal('Categories & tiers',
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">Renaming a category never moves a product — the name is only a label. The arrows set the order categories appear in; the tier is the level it sits at in the tree.</div>' +
      '<div id="cmList" style="border:1px solid #e7e8e3;border-radius:10px;max-height:380px;overflow:auto;">' + list.map(rowHtml).join('') + '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:10px;"><button type="button" class="link-btn" id="cmAdd" style="width:auto;padding:8px 14px;">+ New category</button></div>',
      async function (close, showErr) {
        // Names, tiers and visibility first, then one reorder call for the lot.
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var nameEl = document.querySelector('.cmName[data-id="' + c.id + '"]');
          var tierEl = document.querySelector('.cmTier[data-id="' + c.id + '"]');
          var actEl = document.querySelector('.cmActive[data-id="' + c.id + '"]');
          if (!nameEl) continue;
          var body = {};
          if (nameEl.value.trim() && nameEl.value.trim() !== c.name) body.name = nameEl.value.trim();
          if (tierEl && Number(tierEl.value) !== (c.tierLevel || 1)) body.tierLevel = Number(tierEl.value);
          if (actEl && actEl.checked !== (c.isActive !== false)) body.isActive = actEl.checked;
          if (!Object.keys(body).length) continue;
          var r = await authed('/catalog/categories/' + c.id, { method: 'PATCH', body: body });
          if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e2) {} return showErr(m || 'Could not save “' + c.name + '” (' + r.status + ').'); }
        }
        var rr = await authed('/catalog/categories/reorder', { method: 'POST', body: { ids: list.map(function (c2) { return c2.id; }) } });
        if (!rr.ok) return showErr('Saved the names, but could not save the order (' + rr.status + ').');
        close();
        try { var rc2 = await authed('/catalog/categories'); catCategories = rc2.ok ? await rc2.json() : catCategories; } catch (e3) {}
        loadProducts(user);
      }, 'Save categories');

    function repaint() {
      var host = document.getElementById('cmList'); if (!host) return;
      host.innerHTML = list.map(rowHtml).join('');
      wire();
    }
    function wire() {
      var host = document.getElementById('cmList'); if (!host) return;
      host.querySelectorAll('.cmUp').forEach(function (b) {
        b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i > 0) { var t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; repaint(); } });
      });
      host.querySelectorAll('.cmDown').forEach(function (b) {
        b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i < list.length - 1) { var t = list[i + 1]; list[i + 1] = list[i]; list[i] = t; repaint(); } });
      });
      host.querySelectorAll('.cmDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.getAttribute('data-id');
          if (!confirm('Delete this category? It must be empty.')) return;
          var r = await authed('/catalog/categories/' + id, { method: 'DELETE' });
          if (!r.ok && r.status !== 204) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not delete (' + r.status + ').'); return; }
          list = list.filter(function (c) { return c.id !== id; });
          catCategories = (catCategories || []).filter(function (c) { return c.id !== id; });
          repaint();
        });
      });
    }
    setTimeout(function () {
      wire();
      var add = document.getElementById('cmAdd');
      if (add) add.addEventListener('click', async function () {
        var name = prompt('New category name');
        if (!name || name.trim().length < 2) return;
        var r = await authed('/catalog/categories', { method: 'POST', body: { name: name.trim(), slug: slugify(name), sortOrder: list.length, isActive: true } });
        if (!r.ok) { alert('Could not create (' + r.status + ').'); return; }
        var created = await r.json();
        list.push(created); catCategories.push(created); repaint();
      });
    }, 50);
  }

  /**
   * The default product list order. The arrows move a part within the whole list;
   * saving writes the order the proposal picker and the tier listings read.
   */
  function openProductReorder(user) {
    // The whole catalogue, in its current order, is always what gets saved. The
    // tier filter narrows what is SHOWN; moving a row swaps it with its neighbour in
    // the same tier, and every other product keeps the number it has. Saving a
    // filtered view used to renumber the catalogue from the filtered rows alone.
    var list = (cat.rows || []).slice().sort(function (a, b) {
      return ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
    });
    var pick = '';

    /** Indices into `list`, in display order, for the tier on screen. */
    function view() {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (!pick || list[i].categoryId === pick) out.push(i);
      }
      return out;
    }

    var tierOpts = '<option value="">Every tier · ' + list.length + ' products</option>' +
      (catCategories || []).slice().map(function (c) {
        return { id: c.id, label: catPathLabel(c.id), n: list.filter(function (p) { return p.categoryId === c.id; }).length };
      }).filter(function (o) { return o.n > 0; })
        .sort(function (a, b) { return a.label.localeCompare(b.label); })
        .map(function (o) { return '<option value="' + o.id + '">' + esc(o.label) + ' · ' + o.n + '</option>'; }).join('');

    function rowsHtml() {
      var v = view();
      if (!v.length) return '<div class="muted" style="padding:16px;font-size:13px;">No products in this tier.</div>';
      return v.map(function (idx, n) {
        var p = list[idx];
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #f2f3ef;">' +
          '<span class="muted" style="width:26px;font-size:11.5px;text-align:right;">' + (n + 1) + '</span>' +
          '<code style="width:52px;font-size:11px;color:#8a8f85;text-align:right;font-variant-numeric:tabular-nums;">' + (Number(p.sortOrder) || 0) + '</code>' +
          '<div style="flex:1;font-size:13px;">' + esc(p.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(p.sku) + '</code>' +
            (pick ? '' : '<div class="muted" style="font-size:11px;line-height:1.4;">' + esc(p.categoryName || '') + '</div>') + '</div>' +
          '<button type="button" class="prUp" data-n="' + n + '"' + (n === 0 ? ' disabled' : '') + ' style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▲</button>' +
          '<button type="button" class="prDown" data-n="' + n + '"' + (n === v.length - 1 ? ' disabled' : '') + ' style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▼</button>' +
        '</div>';
      }).join('');
    }

    openModal('Sort order within a tier',
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">This is the order parts are offered and printed in. A part picked in the proposal builder is filed into its tier at this position, so the order here is the order a proposal comes out in. Pick a tier to see just that group.</div>' +
      '<select id="prTier" style="' + IN + 'margin-bottom:10px;">' + tierOpts + '</select>' +
      '<div id="prList" style="border:1px solid #e7e8e3;border-radius:10px;max-height:380px;overflow:auto;"></div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:8px;">The middle column is the stored order number. Saving writes the whole list back in the order shown, so parts outside the tier on screen keep their place.</div>',
      async function (close, showErr) {
        var r = await authed('/catalog/products/reorder', { method: 'POST', body: { ids: list.map(function (p) { return p.id; }) } });
        if (!r.ok) return showErr('Could not save the order (' + r.status + ').');
        close(); loadProducts(user);
      }, 'Save order');

    function swap(a, b) { var t = list[a]; list[a] = list[b]; list[b] = t; }

    function repaint() {
      var host = document.getElementById('prList'); if (!host) return;
      host.innerHTML = rowsHtml();
      host.querySelectorAll('.prUp').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = view(), n = Number(b.getAttribute('data-n'));
          if (n > 0) { swap(v[n - 1], v[n]); repaint(); }
        });
      });
      host.querySelectorAll('.prDown').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = view(), n = Number(b.getAttribute('data-n'));
          if (n < v.length - 1) { swap(v[n], v[n + 1]); repaint(); }
        });
      });
    }

    setTimeout(function () {
      var sel = document.getElementById('prTier');
      if (sel) sel.addEventListener('change', function () { pick = sel.value; repaint(); });
      repaint();
    }, 50);
  }

  /* --- Product-tree workbook: export and import, the same shape both ways ---
   * SpreadsheetML (.xls) so one file can carry a sheet per level and Excel opens
   * it natively; the importer reads exactly what the exporter writes. */
  var TREE_SHEETS = [
    { name: 'Categories', key: 'categories', cols: ['slug', 'name', 'parentSlug', 'tierLevel', 'sortOrder', 'isActive'] },
    { name: 'Products', key: 'products', cols: ['sku', 'name', 'categorySlug', 'kind', 'status', 'sortOrder', 'proposalDescription'] },
    { name: 'Bundles', key: 'bundles', cols: ['bundleSku', 'bundleName', 'componentSku', 'componentName', 'quantity'] }
  ];
  function xmlEsc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function treeWorkbookXml(data) {
    var sheets = TREE_SHEETS.map(function (sh) {
      var rows = (data[sh.key] || []).map(function (r) {
        return '<Row>' + sh.cols.map(function (c) {
          var v = r[c];
          var num = typeof v === 'number';
          return '<Cell><Data ss:Type="' + (num ? 'Number' : 'String') + '">' + xmlEsc(num ? v : (v === true ? 'true' : v === false ? 'false' : v)) + '</Data></Cell>';
        }).join('') + '</Row>';
      }).join('');
      return '<Worksheet ss:Name="' + xmlEsc(sh.name) + '"><Table>' +
        '<Row>' + sh.cols.map(function (c) { return '<Cell><Data ss:Type="String">' + c + '</Data></Cell>'; }).join('') + '</Row>' +
        rows + '</Table></Worksheet>';
    }).join('');
    return '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' + sheets + '</Workbook>';
  }
  function downloadText(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  /** Read a workbook this app wrote back into the same row shape. */
  function parseWorkbookXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    var out = {};
    var sheets = doc.getElementsByTagName('Worksheet');
    for (var i = 0; i < sheets.length; i++) {
      var name = sheets[i].getAttribute('ss:Name') || sheets[i].getAttribute('Name') || '';
      var def = TREE_SHEETS.filter(function (s) { return s.name.toLowerCase() === String(name).toLowerCase(); })[0];
      if (!def) continue;
      var rows = sheets[i].getElementsByTagName('Row'), headers = [], data = [];
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].getElementsByTagName('Cell'), vals = [];
        for (var c = 0; c < cells.length; c++) {
          var dd = cells[c].getElementsByTagName('Data')[0];
          vals.push(dd ? dd.textContent : '');
        }
        if (r === 0) { headers = vals.map(function (h) { return String(h).trim(); }); continue; }
        if (!vals.join('').trim()) continue;
        var o = {};
        headers.forEach(function (h, idx) { if (h) o[h] = (vals[idx] == null ? '' : String(vals[idx]).trim()); });
        data.push(o);
      }
      out[def.key] = data;
    }
    return out;
  }
  /** A blank cell means "no value given" on import, so drop it from the row. */
  function pruneBlanks(rows, keep) {
    return (rows || []).map(function (r) {
      var o = {};
      Object.keys(r).forEach(function (k) {
        if (r[k] === '' && keep.indexOf(k) === -1) return;
        if (k === 'isActive') o[k] = String(r[k]).toLowerCase() === 'true';
        else o[k] = r[k];
      });
      return o;
    });
  }

  /**
   * The change history for one record, or for a whole screen.
   *
   * Everything in this application already recorded who changed what. Until now there
   * was nowhere to read it outside Administration's global list, capped at the most
   * recent 200 rows across the entire system — so a price changed last month was
   * recorded and unfindable, which is why the audit trail felt absent.
   *
   * Where a before/after snapshot was kept, the row shows the change itself. Where only
   * an audit row exists, it shows who and when. Both are listed together, because to
   * the person reading it they are the same question.
   */
  function historyActionLabel(a) {
    var map = {
      create: 'Created', update: 'Changed', delete: 'Deleted', restore: 'Restored',
      'catalog.product.update': 'Product edited',
      'catalog.product.create': 'Product created',
      'catalog.product.status': 'Status changed',
      'catalog.product.delete': 'Product deleted',
      'catalog.product.reorder': 'Products reordered',
      'catalog.category.create': 'Category created',
      'catalog.category.update': 'Category renamed',
      'catalog.category.delete': 'Category deleted',
      'catalog.category.reorder': 'Categories reordered',
      'catalog.family.create': 'Family created',
      'catalog.tree.import': 'Tree imported',
      'catalog.import': 'Catalog imported',
      'catalog.item.update': 'Item edited',
      'catalog.bundle.create': 'Bundle created',
      'catalog.bundle.components': 'Components changed',
      'catalog.bundle.delete': 'Bundle deleted',
      'sku.update': 'SKU edited',
      'sku.import': 'SKUs imported'
    };
    return map[a] || a;
  }

  /** A value as it should read in a history row. Minor units are money. */
  function histVal(k, v) {
    if (v === null || v === undefined || v === '') return '—';
    if (/Minor$/.test(k) && !isNaN(Number(v))) return costMoney(Number(v));
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.length + ' item' + (v.length === 1 ? '' : 's');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  var HIST_FIELD_LABELS = {
    unitCostMinor: 'Cost', listPriceMinor: 'List price', manufacturer: 'Manufacturer',
    vendorPartNumber: 'Vendor part', part: 'Part', description: 'Description',
    name: 'Name', sku: 'SKU', status: 'Status', components: 'Components',
    unitWeightLbs: 'Weight', active: 'Active', leadTimeDays: 'Lead time',
    requiresPowderColor: 'Requires colour', freeIssueVendor: 'Free-issue vendor'
  };

  function historyRow(r) {
    var when = new Date(r.createdAt);
    var who = r.actorName || 'Unknown';
    var head = '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;">' +
      '<div style="font-size:13px;font-weight:600;color:#20241f;">' + esc(historyActionLabel(r.action)) +
        (r.label ? ' <span style="font-family:ui-monospace,monospace;font-weight:500;color:#5c6157;">' + esc(r.label) + '</span>' : '') + '</div>' +
      '<div class="muted" style="font-size:11.5px;">' + esc(who) + ' · ' + when.toLocaleString() + '</div>' +
    '</div>';

    // A revision knows what the value was before, which is the whole reason it exists.
    if (r.source === 'revision' && (r.changed || []).length) {
      var b = r.before || {}, af = r.after || {};
      var rows = r.changed.map(function (k) {
        return '<tr>' +
          '<td style="padding:3px 12px 3px 0;color:#8a8f85;white-space:nowrap;">' + esc(HIST_FIELD_LABELS[k] || k) + '</td>' +
          '<td style="padding:3px 12px 3px 0;color:#9c3327;text-decoration:line-through;">' + esc(histVal(k, b[k])) + '</td>' +
          '<td style="padding:3px 0;color:#2f6b4f;font-weight:600;">' + esc(histVal(k, af[k])) + '</td>' +
        '</tr>';
      }).join('');
      return '<div style="padding:11px 13px;border:1px solid #e7e8e3;border-radius:10px;margin-bottom:8px;background:#fff;">' +
        head + '<table style="margin-top:6px;font-size:12.5px;border-collapse:collapse;">' + rows + '</table></div>';
    }

    // An audit row can only say what was sent. Shown plainly rather than dressed up as
    // a before/after it does not have.
    var det = r.details && Object.keys(r.details).length
      ? '<div class="muted" style="font-size:11.5px;margin-top:4px;font-family:ui-monospace,monospace;word-break:break-word;">' +
          esc(Object.keys(r.details).map(function (k) { return k + ': ' + histVal(k, r.details[k]); }).join(' · ')) + '</div>'
      : '';
    return '<div style="padding:11px 13px;border:1px solid #e7e8e3;border-radius:10px;margin-bottom:8px;background:#fbfbf9;">' + head + det + '</div>';
  }

  /**
   * `opts` is { entity, entityId, area, title }. Give it an entity for one record's
   * history, or an area for a whole screen's.
   */
  async function openHistory(opts) {
    var qs = [];
    if (opts.entity) qs.push('entity=' + encodeURIComponent(opts.entity));
    if (opts.entityId) qs.push('entityId=' + encodeURIComponent(opts.entityId));
    if (opts.area) qs.push('area=' + encodeURIComponent(opts.area));
    var r = await authed('/history?' + qs.join('&'));
    if (!r.ok) {
      alert(r.status === 403
        ? 'You do not have permission to read change history.'
        : 'Could not load the history (' + r.status + ').');
      return;
    }
    var d = await r.json();
    var body = !d.rows.length
      ? '<div class="muted" style="font-size:13.5px;line-height:1.6;">Nothing recorded yet.' +
        (opts.entity ? ' Changes made from here on will appear in this list.' : '') + '</div>'
      : '<input id="histQ" placeholder="Filter by what changed, or who changed it" style="' + IN + 'margin-bottom:10px;">' +
        '<div id="histList" style="max-height:60vh;overflow:auto;">' + d.rows.map(historyRow).join('') + '</div>' +
        '<div class="muted" style="font-size:11.5px;margin-top:8px;line-height:1.5;">' +
          'Rows on a white ground record what the value was before the change. Rows on a grey ground come from the audit log, which records what was sent — it can say who and when, but not what it was before.' +
        '</div>';
    openModal(opts.title || 'Change history', body, null, null, { wide: true });
    var q = document.getElementById('histQ');
    if (q) {
      q.addEventListener('input', function () {
        var term = q.value.trim().toLowerCase();
        var list = document.getElementById('histList');
        list.innerHTML = (term
          ? d.rows.filter(function (row) {
              return JSON.stringify(row).toLowerCase().indexOf(term) >= 0;
            })
          : d.rows
        ).map(historyRow).join('') || '<div class="muted" style="font-size:13px;">Nothing matches that.</div>';
      });
    }
  }

  /** Duplicate sort orders in the live tree, with a one-click renumber. */
  async function openSortAudit(user) {
    var r = await authed('/catalog/tree/sort-audit');
    if (!r.ok) { alert('Could not audit sort order (' + r.status + ').'); return; }
    var d = await r.json();
    function block(title, list) {
      if (!list.length) return '';
      return '<div style="margin-bottom:14px;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:6px;">' + title + '</div>' +
        list.map(function (c) {
          return '<div style="border:1px solid #e7e8e3;border-radius:9px;padding:9px 11px;margin-bottom:6px;">' +
            '<div style="font-size:12.5px;color:#5c6157;">' + esc(c.scope) + ' · order <b>' + c.sortOrder + '</b></div>' +
            c.members.map(function (m) { return '<div style="font-size:13px;">' + esc(m.label) + '</div>'; }).join('') +
          '</div>';
        }).join('') + '</div>';
    }
    var body = d.clashCount === 0
      ? '<div class="muted" style="font-size:13.5px;">No duplicates — every sibling has a distinct sort order.</div>'
      : '<div style="font-size:13.5px;margin-bottom:12px;"><b>' + d.clashCount + '</b> collision' + (d.clashCount === 1 ? '' : 's') +
        ' across <b>' + d.affected + '</b> rows. Ties break alphabetically, so these print in an arbitrary order.</div>' +
        block('Categories', d.categoryClashes) + block('Products', d.productClashes) +
        '<div class="muted" style="font-size:12px;">Renumber rewrites every sibling group to 10, 20, 30… keeping the order things are in now. Gaps of 10 leave room to slot one item in later by hand.</div>';
    openModal('Sort order', body, d.clashCount === 0 ? null : async function (close, showErr) {
      var r2 = await authed('/catalog/tree/renumber', { method: 'POST', body: {} });
      if (!r2.ok) return showErr('Could not renumber (' + r2.status + ').');
      var out = await r2.json();
      close();
      alert('Renumbered ' + out.categories + ' categor' + (out.categories === 1 ? 'y' : 'ies') + ' and ' + out.products + ' product' + (out.products === 1 ? '' : 's') + '.');
      refreshCatalogList(user);
    }, 'Renumber all');
  }

  /**
   * The category → product list as a flat CSV: one row per part, its full category
   * path spelled out, and the price and weight from the SKU master joined on part
   * number. This is the file to hand someone who wants to read or filter the
   * catalog — the workbook above is for round-tripping edits back in, and its
   * sheet-per-level shape makes it useless for a sort or a pivot.
   *
   * Category path is built from parentSlug, so a part four tiers down reads
   * "Adventure Series › Frames › Uprights › 3in" rather than a bare slug.
   *
   * Parts with no SKU-master row export with blank price and weight rather than a
   * zero — the tree and the pricing master are separate records and a real 0.00
   * must not be indistinguishable from "not priced yet".
   */
  async function exportCategoryProductList() {
    var r = await authed('/catalog/tree/export');
    if (!r.ok) { alert('Could not export the product list (' + r.status + ').'); return; }
    var d = await r.json();

    var bySlug = {};
    (d.categories || []).forEach(function (c) { bySlug[c.slug] = c; });
    function pathOf(slug) {
      var parts = [], seen = {}, cur = bySlug[slug];
      while (cur && !seen[cur.slug]) { seen[cur.slug] = 1; parts.unshift(cur.name || cur.slug); cur = cur.parentSlug ? bySlug[cur.parentSlug] : null; }
      return parts.join(' \u203a ');
    }

    // Price and weight live on the SKU master, not the tree. Joined here so one
    // file answers "what do we sell and what does it cost".
    var priced = {};
    var rs = await authed('/skus/export');
    if (rs.ok) {
      var sd = await rs.json();
      (sd.items || []).forEach(function (s) { priced[String(s.part).trim().toUpperCase()] = s; });
    }

    var cols = ['sku', 'name', 'categoryPath', 'categorySlug', 'kind', 'status', 'sortOrder', 'unitPrice', 'unitCost', 'weightLbs', 'proposalDescription'];
    var rows = [cols];
    (d.products || []).forEach(function (p) {
      var m = priced[String(p.sku || '').trim().toUpperCase()];
      rows.push([
        p.sku, p.name, pathOf(p.categorySlug), p.categorySlug, p.kind, p.status, p.sortOrder,
        m ? m.unitPrice : '', m ? m.unitCost : '', m ? m.weightLbs : '',
        p.proposalDescription
      ]);
    });
    downloadCsv('catalog-product-list-' + todayISO() + '.csv', rows);
  }

  async function exportProductTree() {
    var r = await authed('/catalog/tree/export');
    if (!r.ok) { alert('Could not export the tree (' + r.status + ').'); return; }
    var data = await r.json();
    downloadText('product-tree-' + todayISO() + '.xls', treeWorkbookXml(data), 'application/vnd.ms-excel');
  }

  /**
   * Import a product-tree workbook. Always previewed first: the review step says
   * what will be created and changed, and lists the parts the file leaves out so
   * the operator decides whether to leave or deactivate them.
   */
  var treeImportConfirmed = false;
  function openTreeImport(user) {
    treeImportConfirmed = false;
    openModal('Import product tree',
      '<div class="muted" style="font-size:13px;line-height:1.55;margin-bottom:10px;">Use a workbook exported from this screen — sheets <b>Categories</b>, <b>Products</b> and <b>Bundles</b>. Only the columns present in the file are written; anything you leave out stays exactly as it is. Nothing is ever deleted.</div>' +
      '<input type="file" id="tiFile" accept=".xls,.xml" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">' +
      '<div id="tiReview" style="margin-top:12px;"></div>',
      async function (close, showErr) {
        var fi = document.getElementById('tiFile').files[0];
        if (!fi) return showErr('Choose a workbook first.');
        var text = await fi.text();
        var parsed = /<Workbook/i.test(text) ? parseWorkbookXml(text) : null;
        if (!parsed) return showErr('That file is not a workbook exported from this screen.');
        var missingSel = document.getElementById('tiMissing');
        var payload = {
          dryRun: !treeImportConfirmed,
          missingAction: missingSel ? missingSel.value : 'leave',
          categories: pruneBlanks(parsed.categories, ['name']),
          products: pruneBlanks(parsed.products, ['name']),
          bundles: (parsed.bundles || []).map(function (b) { return { bundleSku: b.bundleSku, componentSku: b.componentSku, quantity: Number(b.quantity) || 1 }; })
            .filter(function (b) { return b.bundleSku && b.componentSku; })
        };
        var r = await authed('/catalog/tree/import', { method: 'POST', body: payload });
        var d = null; try { d = await r.json(); } catch (e) {}
        if (!d) return showErr('Import failed (' + r.status + ').');
        if (d.issues && d.issues.length) {
          document.getElementById('tiReview').innerHTML =
            '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;max-height:200px;overflow:auto;">' +
            '<b>' + d.issues.length + ' problem(s) — nothing was written:</b><ul style="margin:6px 0 0;padding-left:18px;line-height:1.5;">' +
            d.issues.slice(0, 40).map(function (i) { return '<li>' + esc(i.sheet + ' · ' + i.key + ': ' + i.message) + '</li>'; }).join('') + '</ul></div>';
          treeImportConfirmed = false;
          return showErr('Fix the problems listed and try again.');
        }
        if (!treeImportConfirmed) {
          var p = d.plan || {};
          document.getElementById('tiReview').innerHTML =
            '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;">' +
              '<b>Ready to import</b><br>Categories: ' + (p.categories ? p.categories.create + ' new, ' + p.categories.update + ' updated' : '—') +
              '<br>Products: ' + (p.products ? p.products.create + ' new, ' + p.products.update + ' updated' : '—') +
              '<br>Bundle links: ' + ((p.bundles && p.bundles.links) || 0) +
            '</div>' +
            ((p.missing && p.missing.length)
              ? '<div style="margin-top:10px;background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7a6320;line-height:1.55;">' +
                  '<b>' + p.missing.length + ' catalog part(s) are not in this file.</b>' +
                  '<div style="max-height:120px;overflow:auto;margin:6px 0;">' + p.missing.slice(0, 60).map(function (mm) { return esc(mm.sku + ' — ' + mm.name); }).join('<br>') + '</div>' +
                  '<label style="display:block;margin-top:6px;">What should happen to them? ' +
                    '<select id="tiMissing" style="padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
                      '<option value="leave">Leave them exactly as they are</option>' +
                      '<option value="deactivate">Deactivate them</option>' +
                    '</select></label></div>'
              : '') +
            '<div class="muted" style="font-size:12px;margin-top:8px;">Press Import again to commit.</div>';
          treeImportConfirmed = true;
          return showErr('Review the summary above, then press Import to commit.');
        }
        treeImportConfirmed = false;
        close();
        var res = d.result || {};
        alert('Import complete: ' + (res.created || 0) + ' created, ' + (res.updated || 0) + ' updated, ' + (res.links || 0) + ' bundle link(s)' +
          (res.deactivated ? ', ' + res.deactivated + ' deactivated' : '') + '.');
        loadProducts(user);
      }, 'Import');
  }
  window.SSGCatalog = {
    /** `authed` from the shell. Called once during boot. */
    init: function (host) {
      H = host;
    },
    /** The whole screen, drawn into #view. The only way in. */
    render: renderCatalog,
  };
})();

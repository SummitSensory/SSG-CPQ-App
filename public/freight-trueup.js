/**
 * Freight true-up — the screen for freight that arrives after the proposal went out.
 *
 * A separate file from app.js on purpose: this is one workflow with one owner (the
 * person who manages vendor freight pricing), and it needs to be readable and
 * replaceable without touching the 10,000-line application shell. It borrows the
 * shell's helpers rather than reimplementing them — see init() — so the styling,
 * auth, modals and money formatting stay identical to everything around it.
 *
 * Three entry points:
 *   dashboardSection(user)      → the "Freight outstanding" block on the dashboard
 *   openWorkspace(pid, vid, u)  → the entry screen for one job
 *   panelHtml / mountPanel      → the same entry form embedded in the freight review
 */
(function () {
  'use strict';

  var H = null; // host helpers, injected by app.js

  var WRITE_ROLES = [
    'SYSTEM_ADMIN',
    'EXECUTIVE',
    'SALES_MANAGER',
    'SALES_REP',
    'ESTIMATOR',
    'OPERATIONS',
    'PROJECT_MANAGER',
    'ACCOUNTING',
  ];
  var PUSH_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'OPERATIONS', 'ACCOUNTING'];

  var INK = '#1c4039',
    MUTED = '#6b7065',
    LINE = '#e7e8e3',
    SURFACE = '#fbfbf9';
  var RED = '#9c3327',
    REDLINE = '#f0ccc6',
    REDBG = '#fdf1ef',
    AMBER = '#8a6d1f',
    GREEN = '#2f7d5d';

  function can(user, roles) {
    return !!user && roles.indexOf(user.role) !== -1;
  }
  function esc(s) {
    return H.esc(String(s == null ? '' : s));
  }
  function money(minor) {
    var v = (Number(minor) || 0) / 100;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /** "1,234.50" / "$1234.5" / "" → minor units. Blank is not zero: it is unanswered. */
  function toMinor(text) {
    var s = String(text == null ? '' : text).replace(/[$,\s]/g, '');
    if (!s) return null;
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }
  function el(id) {
    return document.getElementById(id);
  }
  function chip(text, color, bg) {
    return (
      '<span style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' +
      color +
      ';background:' +
      bg +
      ';padding:3px 8px;border-radius:999px;white-space:nowrap;">' +
      esc(text) +
      '</span>'
    );
  }
  function ageChip(row) {
    var c =
      row.urgency === 'ESCALATED'
        ? [RED, REDBG]
        : row.urgency === 'AGEING'
          ? [AMBER, '#fdf6e6']
          : [MUTED, '#f2f3ef'];
    return chip(row.ageDays + (row.ageDays === 1 ? ' day' : ' days'), c[0], c[1]);
  }
  function stateChip(row) {
    if (row.trueUpStatus === 'VOID') return chip('No freight', GREEN, '#eef6f0');
    if (row.invoicePushed) return chip('On invoice', GREEN, '#eef6f0');
    if (row.trueUpStatus === 'APPLIED')
      return chip(row.hasInvoice ? 'Invoice to update' : 'On proposal', AMBER, '#fdf6e6');
    if (row.trueUpStatus === 'STAGED') return chip('Entered', AMBER, '#fdf6e6');
    return chip('Not started', RED, '#fbecea');
  }

  var INPUT =
    'width:120px;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:13.5px;background:#fff;outline:none;text-align:right;';
  var TEXT =
    'width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:13.5px;background:#fff;outline:none;';

  // ------------------------------------------------------------------ dashboard

  /**
   * The dashboard block. Ordered oldest-first and coloured by age, because the
   * failure this is designed against is not "we do not know the freight" — it is
   * "nobody has looked at it for two weeks".
   */
  async function dashboardSection(user) {
    var data = null;
    try {
      var r = await H.authed('/freight/queue');
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (!data || !data.rows || !data.rows.length) return '';
    var rows = data.rows;
    var escalated = data.escalated || 0;

    var html =
      '<div style="margin-bottom:10px;"><div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;flex-wrap:wrap;">' +
      '<span style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' +
      RED +
      ';">Freight outstanding \u00b7 ' +
      rows.length +
      '</span>' +
      '<span class="muted" style="font-size:11.5px;">' +
      (escalated
        ? escalated + ' past ' + data.threshold + ' days'
        : 'jobs sent without final freight costs') +
      '</span></div>' +
      '<div style="background:' +
      REDBG +
      ';border:1px solid ' +
      REDLINE +
      ';border-radius:12px;overflow:hidden;">' +
      rows
        .slice(0, 8)
        .map(function (r, i) {
          var detail = [];
          if (r.gapLineCount)
            detail.push(
              r.gapLineCount + ' line' + (r.gapLineCount === 1 ? '' : 's') + ' third-party',
            );
          if (r.gapBuckets.indexOf('STRUCTURE') !== -1) detail.push('structure');
          if (r.gapBuckets.indexOf('STANDARD') !== -1) detail.push('standard');
          if (r.vendors && r.vendors.length) detail.push(r.vendors.join(', '));
          if (r.stagedMinor) detail.push(money(r.stagedMinor) + ' entered');
          return (
            '<div class="ftuRow" data-pid="' +
            esc(r.proposalId) +
            '" data-vid="' +
            esc(r.versionId) +
            '" ' +
            'style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' +
            (i ? 'border-top:1px solid #f6dcd7;' : '') +
            '">' +
            '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' +
            esc(r.customer) +
            '</b>' +
            '<div class="muted" style="font-size:12px;">' +
            esc(r.title) +
            ' \u00b7 ' +
            esc(r.number) +
            ' v' +
            r.version +
            '</div></div>' +
            '<div style="display:flex;align-items:center;gap:7px;white-space:nowrap;">' +
            '<span class="muted" style="font-size:11.5px;">' +
            esc(detail.join(' \u00b7 ')) +
            '</span>' +
            ageChip(r) +
            stateChip(r) +
            '</div></div>'
          );
        })
        .join('') +
      (rows.length > 8
        ? '<div style="padding:8px 14px;border-top:1px solid #f6dcd7;font-size:12px;color:' +
          RED +
          ';">and ' +
          (rows.length - 8) +
          ' more</div>'
        : '') +
      '</div></div>';
    return html;
  }

  /** Wire the rows the section just rendered. Called after innerHTML is set. */
  function bindDashboard(user) {
    Array.prototype.forEach.call(document.querySelectorAll('.ftuRow'), function (node) {
      node.addEventListener('click', function () {
        openWorkspace(node.getAttribute('data-pid'), node.getAttribute('data-vid'), user);
      });
    });
  }

  // ------------------------------------------------------------------ workspace

  var st = null; // { pid, vid, user, state }

  async function openWorkspace(proposalId, versionId, user) {
    var view = el('view');
    view.innerHTML = '<div class="muted" style="padding:24px;">Loading freight\u2026</div>';
    st = { pid: proposalId, vid: versionId, user: user, state: null };
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(versionId) + '/freight-state',
    );
    if (!r.ok) {
      view.innerHTML = '<div class="err">Could not load the freight state for this proposal.</div>';
      return;
    }
    st.state = await r.json();
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
      '<button class="link-btn" id="ftuBack" style="width:auto;padding:7px 13px;">\u2039 Back</button>' +
      '</div><div id="ftuPanel"></div>';
    el('ftuBack').addEventListener('click', function () {
      H.goToProposals(user);
    });
    render();
  }

  /** Re-read the state and repaint, after any write. */
  async function reload() {
    var r = await H.authed('/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-state');
    if (r.ok) st.state = await r.json();
    render();
  }

  function header(s) {
    var late = s.ageDays >= s.threshold;
    return (
      '<div class="card" style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">' +
      '<div><div class="k">' +
      esc(s.number) +
      ' \u00b7 v' +
      s.version +
      '</div>' +
      '<h2 style="font-size:22px;margin-top:2px;">' +
      esc(s.title) +
      '</h2>' +
      '<div class="muted" style="font-size:12.5px;margin-top:3px;">' +
      esc(H.titleCase(s.status)) +
      (s.releasedAt ? ' \u00b7 out with the customer since ' + esc(H.fmtDate(s.releasedAt)) : '') +
      '</div></div>' +
      '<div style="text-align:right;">' +
      '<div style="font-size:20px;font-weight:600;">' +
      money(s.totals.totalMinor) +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;">current proposal total</div>' +
      '<div style="margin-top:6px;">' +
      (late ? chip(s.ageDays + ' days outstanding', RED, REDBG) : '') +
      '</div>' +
      '</div></div></div>'
    );
  }

  /** Freight already on the document, so nobody enters a figure that is there. */
  function existing(s) {
    var t = s.totals;
    function cell(label, v) {
      return (
        '<div><div class="muted" style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;">' +
        label +
        '</div>' +
        '<div style="font-size:15px;font-weight:600;color:' +
        (v ? INK : RED) +
        ';">' +
        (v ? money(v) : 'none') +
        '</div></div>'
      );
    }
    return (
      '<div style="display:flex;gap:26px;flex-wrap:wrap;background:' +
      SURFACE +
      ';border:1px solid ' +
      LINE +
      ';border-radius:12px;padding:12px 15px;margin-bottom:16px;">' +
      cell('Third-party freight', t.tpFreightMinor) +
      cell('Structure freight', t.structureFreightMinor) +
      cell('Standard freight', t.stdFreightMinor) +
      '</div>'
    );
  }

  function stagedFor(ref) {
    var live = st.state.live;
    var lines = live && live.thirdPartyLines ? live.thirdPartyLines : [];
    for (var i = 0; i < lines.length; i++) if (lines[i].ref === ref) return lines[i].amountMinor;
    return null;
  }
  function dollars(minor) {
    return minor == null ? '' : (Number(minor) / 100).toFixed(2);
  }

  function entryForm(s) {
    var g = s.gaps,
      live = s.live;
    var rows = '';
    if (g.thirdParty.length) {
      rows +=
        '<div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' +
        MUTED +
        ';margin:4px 0 8px;">Third-party freight \u00b7 per line</div>';
      rows += g.thirdParty
        .map(function (l) {
          return (
            '<div style="display:flex;align-items:center;gap:11px;background:#fff;border:1px solid ' +
            LINE +
            ';border-radius:10px;padding:9px 12px;margin-bottom:6px;">' +
            '<div style="flex:1;min-width:0;"><div style="font-size:13.5px;font-weight:600;">' +
            esc(l.name) +
            '</div>' +
            '<div class="muted" style="font-size:11.5px;">' +
            esc(l.sku) +
            (l.vendor ? ' \u00b7 ' + esc(l.vendor) : '') +
            ' \u00b7 ' +
            l.quantity +
            '\u00d7</div></div>' +
            '<input class="ftuTp" data-ref="' +
            esc(l.ref) +
            '" data-sku="' +
            esc(l.sku) +
            '" data-name="' +
            esc(l.name) +
            '" placeholder="0.00" value="' +
            dollars(stagedFor(l.ref)) +
            '" style="' +
            INPUT +
            '"></div>'
          );
        })
        .join('');
    }
    if (g.structureMissing || g.standardMissing) {
      rows +=
        '<div style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' +
        MUTED +
        ';margin:14px 0 8px;">Job freight</div>';
      if (g.structureMissing) {
        rows +=
          '<div style="display:flex;align-items:center;gap:11px;background:#fff;border:1px solid ' +
          LINE +
          ';border-radius:10px;padding:9px 12px;margin-bottom:6px;">' +
          '<div style="flex:1;"><div style="font-size:13.5px;font-weight:600;">Structure freight</div>' +
          '<div class="muted" style="font-size:11.5px;">' +
          (g.structureTbdText
            ? 'currently prints \u201c' + esc(g.structureTbdText) + '\u201d'
            : 'nothing on the proposal') +
          '</div></div>' +
          '<input id="ftuStructure" placeholder="0.00" value="' +
          dollars(live ? live.structureFreightMinor : null) +
          '" style="' +
          INPUT +
          '"></div>';
      }
      if (g.standardMissing) {
        rows +=
          '<div style="display:flex;align-items:center;gap:11px;background:#fff;border:1px solid ' +
          LINE +
          ';border-radius:10px;padding:9px 12px;margin-bottom:6px;">' +
          '<div style="flex:1;"><div style="font-size:13.5px;font-weight:600;">Standard freight</div>' +
          '<div class="muted" style="font-size:11.5px;">switched on, no amount entered</div></div>' +
          '<input id="ftuStandard" placeholder="0.00" value="' +
          dollars(live ? live.stdFreightMinor : null) +
          '" style="' +
          INPUT +
          '"></div>';
      }
    }

    return (
      rows +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px;">' +
      '<div class="field"><label for="ftuVendor">Vendor</label>' +
      '<input id="ftuVendor" style="' +
      TEXT +
      '" placeholder="e.g. Southpaw" value="' +
      esc(live && live.vendorName ? live.vendorName : '') +
      '"></div>' +
      '<div class="field"><label for="ftuRef">Vendor quote reference</label>' +
      '<input id="ftuRef" style="' +
      TEXT +
      '" placeholder="quote or BOL number" value="' +
      esc(live && live.vendorQuoteRef ? live.vendorQuoteRef : '') +
      '"></div>' +
      '</div>' +
      '<div class="field"><label for="ftuNote">Note</label>' +
      '<textarea id="ftuNote" rows="2" style="' +
      TEXT +
      'resize:vertical;">' +
      esc(live && live.note ? live.note : '') +
      '</textarea></div>' +
      '<div class="muted" style="font-size:11.5px;margin:-4px 0 12px;">A quote reference is required before an amount can be saved \u2014 a freight figure has to be traceable to the vendor who gave it.</div>'
    );
  }

  function appliedBlock(s) {
    var t = (s.history || []).filter(function (h) {
      return h.status === 'APPLIED';
    })[0];
    if (!t) return '';
    var delta = Number(t.newTotalMinor) - Number(t.previousTotalMinor);
    var pushed = !!t.qboPushedAt;
    return (
      '<div style="border:1px solid #cfe3d7;background:#f4faf6;border-radius:12px;padding:13px 15px;margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;">' +
      '<div><div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' +
      GREEN +
      ';">Freight applied</div>' +
      '<div style="font-size:13px;margin-top:3px;">' +
      money(t.previousTotalMinor) +
      ' \u2192 <b>' +
      money(t.newTotalMinor) +
      '</b> (' +
      (delta >= 0 ? '+' : '\u2212') +
      money(Math.abs(delta)) +
      ')</div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:2px;">' +
      esc(H.fmtDate(t.appliedAt)) +
      (t.vendorQuoteRef ? ' \u00b7 vendor quote ' + esc(t.vendorQuoteRef) : '') +
      '</div></div>' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;">' +
      (pushed
        ? chip(
            t.qboMode === 'SUPPLEMENT' ? 'Freight invoice raised' : 'Invoice amended',
            GREEN,
            '#eef6f0',
          )
        : chip('Not on the invoice yet', AMBER, '#fdf6e6')) +
      (t.customerNotifiedAt
        ? chip('Customer sent revised total', GREEN, '#eef6f0')
        : chip('Customer not notified', AMBER, '#fdf6e6')) +
      '</div></div>' +
      (t.qboError
        ? '<div class="err" style="margin-top:10px;">QuickBooks: ' + esc(t.qboError) + '</div>'
        : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
      (!pushed && can(st.user, PUSH_ROLES)
        ? '<button class="btn" id="ftuPush" data-id="' +
          esc(t.id) +
          '" style="width:auto;padding:9px 15px;">Add to the QuickBooks invoice</button>'
        : '') +
      (!t.customerNotifiedAt
        ? '<button class="link-btn" id="ftuNotified" data-id="' +
          esc(t.id) +
          '" style="width:auto;padding:9px 15px;">I have sent the customer the revised total</button>'
        : '') +
      '</div></div>'
    );
  }

  function render() {
    var s = st.state,
      box = el('ftuPanel');
    if (!box) return;
    var writable = can(st.user, WRITE_ROLES);
    var frozen = s.frozen || s.status === 'RELEASED' || s.status === 'ACCEPTED';
    var live = s.live;
    var voided = (s.history || []).filter(function (h) {
      return h.status === 'VOID';
    })[0];

    var body = header(s) + existing(s) + appliedBlock(s);

    if (!s.gaps.any && !live) {
      body +=
        '<div style="border:1px solid #cfe3d7;background:#f4faf6;border-radius:12px;padding:14px 15px;">' +
        '<div style="font-size:13px;color:' +
        GREEN +
        ';">Every freight figure on this proposal is filled in.</div>' +
        (voided
          ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">Recorded as no freight applicable: ' +
            esc(voided.noFreightReason || '') +
            '</div>'
          : '') +
        '</div>';
      box.innerHTML = body;
      bindPanel();
      return;
    }

    body +=
      '<div style="border:2px solid #c8483a;background:' +
      REDBG +
      ';border-radius:14px;padding:15px 16px;">' +
      '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' +
      RED +
      ';margin-bottom:4px;">Enter the vendor freight</div>' +
      '<div style="font-size:12.5px;color:#7d2a20;line-height:1.55;margin-bottom:14px;">' +
      (frozen
        ? 'This version is frozen. Freight is the only thing that can be changed here, and only through this form \u2014 the line items, the discount and the tax stay exactly as the customer received them.'
        : 'This proposal is still a draft. Freight entered here is written straight onto it.') +
      '</div>' +
      (writable
        ? entryForm(s)
        : '<div class="muted" style="font-size:12.5px;">You do not have permission to enter freight costs.</div>') +
      (writable
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
          '<button class="btn" id="ftuSave" style="width:auto;padding:10px 16px;">Save the amounts</button>' +
          '<button class="btn" id="ftuApply" style="width:auto;padding:10px 16px;' +
          (live && live.status === 'STAGED' ? '' : 'opacity:.55;') +
          '">Apply to the proposal</button>' +
          '<button class="link-btn" id="ftuNone" style="width:auto;padding:10px 15px;">No freight applies\u2026</button>' +
          '<span id="ftuMsg" class="muted" style="font-size:12px;"></span>' +
          '</div>'
        : '') +
      '</div>';

    box.innerHTML = body;
    bindPanel();
  }

  function collect() {
    var lines = [];
    var bad = null;
    Array.prototype.forEach.call(document.querySelectorAll('.ftuTp'), function (input) {
      var v = toMinor(input.value);
      if (v == null) return; // left blank — still outstanding
      if (isNaN(v)) {
        bad = input.getAttribute('data-name');
        return;
      }
      lines.push({
        ref: input.getAttribute('data-ref'),
        sku: input.getAttribute('data-sku'),
        name: input.getAttribute('data-name'),
        amountMinor: v,
      });
    });
    var structure = el('ftuStructure') ? toMinor(el('ftuStructure').value) : undefined;
    var standard = el('ftuStandard') ? toMinor(el('ftuStandard').value) : undefined;
    if (isNaN(structure)) bad = 'Structure freight';
    if (isNaN(standard)) bad = 'Standard freight';
    if (bad)
      return {
        error: '\u201c' + bad + '\u201d is not an amount. Use dollars and cents, e.g. 1250.00.',
      };
    return {
      thirdPartyLines: lines,
      structureFreightMinor: structure === undefined ? undefined : structure,
      stdFreightMinor: standard === undefined ? undefined : standard,
      vendorName: el('ftuVendor') ? el('ftuVendor').value.trim() : undefined,
      vendorQuoteRef: el('ftuRef') ? el('ftuRef').value.trim() : undefined,
      note: el('ftuNote') ? el('ftuNote').value.trim() : undefined,
    };
  }

  function say(text, bad) {
    var m = el('ftuMsg');
    if (m) {
      m.textContent = text || '';
      m.style.color = bad ? RED : MUTED;
    }
  }

  async function ensureTrueUp() {
    if (st.state.live) return st.state.live.id;
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-true-up',
      { method: 'POST' },
    );
    if (!r.ok) throw new Error(await errorText(r));
    var row = await r.json();
    return row.id;
  }

  async function errorText(r) {
    try {
      var j = await r.json();
      return j.message || j.error || 'Request failed (' + r.status + ')';
    } catch (e) {
      return 'Request failed (' + r.status + ')';
    }
  }

  function bindPanel() {
    var save = el('ftuSave');
    if (save)
      save.addEventListener('click', async function () {
        var payload = collect();
        if (payload.error) return say(payload.error, true);
        save.disabled = true;
        say('Saving\u2026');
        try {
          var id = await ensureTrueUp();
          var r = await H.authed('/freight-true-up/' + id, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          if (!r.ok) throw new Error(await errorText(r));
          say('Saved.');
          await reload();
        } catch (e) {
          save.disabled = false;
          say(e.message, true);
        }
      });

    var apply = el('ftuApply');
    if (apply)
      apply.addEventListener('click', async function () {
        var live = st.state.live;
        if (!live || live.status !== 'STAGED') return say('Save the amounts first.', true);
        confirmApply(live);
      });

    var none = el('ftuNone');
    if (none)
      none.addEventListener('click', function () {
        askNoFreight();
      });

    var pushBtn = el('ftuPush');
    if (pushBtn)
      pushBtn.addEventListener('click', function () {
        openPushDialog(pushBtn.getAttribute('data-id'));
      });

    var notified = el('ftuNotified');
    if (notified)
      notified.addEventListener('click', async function () {
        notified.disabled = true;
        var r = await H.authed(
          '/freight-true-up/' + notified.getAttribute('data-id') + '/customer-notified',
          { method: 'POST' },
        );
        if (!r.ok) {
          notified.disabled = false;
          return;
        }
        await reload();
      });
  }

  /**
   * Applying changes what a signed document says. The dialog states the current
   * total and the new one before anything is written, because "add the freight" and
   * "raise the price the customer agreed by $3,400" are the same act.
   */
  function confirmApply(live) {
    var staged =
      (Number(live.thirdPartyTotalMinor) || 0) +
      (Number(live.structureFreightMinor) || 0) +
      (Number(live.stdFreightMinor) || 0);
    var current = st.state.totals.totalMinor;
    H.openModal(
      'Apply freight to ' + st.state.number,
      '<div style="font-size:13.5px;line-height:1.6;">' +
        '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ' +
        LINE +
        ';"><span class="muted">Proposal total now</span><b>' +
        money(current) +
        '</b></div>' +
        '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ' +
        LINE +
        ';"><span class="muted">Freight being added</span><b>' +
        money(staged) +
        '</b></div>' +
        '<div style="display:flex;justify-content:space-between;padding:7px 0;"><span class="muted">New total</span><b style="font-size:15px;">' +
        money(current + staged) +
        '</b></div>' +
        '<div class="muted" style="font-size:12px;margin-top:12px;line-height:1.55;">The proposal keeps its number, its version and its signature. The price snapshot is re-frozen, the operational order is updated, and the customer is <b>not</b> emailed \u2014 the job stays flagged until someone sends the revised total.</div>' +
        '</div>',
      async function (close, showErr) {
        var r = await H.authed('/freight-true-up/' + live.id + '/apply', { method: 'POST' });
        if (!r.ok) return showErr(await errorText(r));
        close();
        await reload();
      },
      'Apply freight',
    );
  }

  function askNoFreight() {
    H.openModal(
      'No freight applies',
      '<div class="field"><label for="ftuReason">Why does this job carry no freight?</label>' +
        '<textarea id="ftuReason" rows="3" style="' +
        TEXT +
        'resize:vertical;" placeholder="e.g. customer is collecting from the vendor"></textarea></div>' +
        '<div class="muted" style="font-size:12px;">Recorded against the proposal with your name on it. It closes the freight alert and unblocks the Bill of Materials.</div>',
      async function (close, showErr) {
        var reason = (el('ftuReason').value || '').trim();
        if (reason.length < 5) return showErr('Give a reason \u2014 one line is enough.');
        try {
          var id = await ensureTrueUp();
          var r = await H.authed('/freight-true-up/' + id + '/no-freight', {
            method: 'POST',
            body: JSON.stringify({ reason: reason }),
          });
          if (!r.ok) return showErr(await errorText(r));
          close();
          await reload();
        } catch (e) {
          return showErr(e.message);
        }
      },
      'Record it',
    );
  }

  /**
   * The QuickBooks step. The preview is read live from QuickBooks and the confirmed
   * figures are sent back with the push, so an invoice that moved in the meantime
   * aborts instead of being amended against stale numbers.
   */
  async function openPushDialog(trueUpId) {
    H.openModal(
      'Add freight to the QuickBooks invoice',
      '<div id="ftuPreview" class="muted" style="font-size:13px;padding:8px 0;">Reading the invoice from QuickBooks\u2026</div>',
      async function (close, showErr) {
        var p = openPushDialog.preview;
        if (!p) return showErr('The invoice has not been read yet.');
        var r = await H.authed('/freight-true-up/' + trueUpId + '/qbo-push', {
          method: 'POST',
          body: JSON.stringify({
            expectedCurrentTotalMinor: p.invoice.currentTotalMinor,
            expectedNewTotalMinor: p.newTotalMinor,
          }),
        });
        if (!r.ok) return showErr(await errorText(r));
        close();
        await reload();
      },
      'Send to QuickBooks',
    );

    var r = await H.authed('/freight-true-up/' + trueUpId + '/qbo-preview');
    var box = el('ftuPreview');
    if (!box) return;
    if (!r.ok) {
      box.className = 'err';
      box.textContent = await errorText(r);
      openPushDialog.preview = null;
      return;
    }
    var p = await r.json();
    openPushDialog.preview = p;
    box.className = '';
    box.innerHTML =
      '<div style="font-size:13.5px;line-height:1.6;">' +
      '<div style="margin-bottom:10px;">' +
      chip(
        p.mode === 'AMEND'
          ? 'Amend invoice ' + (p.invoice.docNumber || '')
          : 'New freight invoice ' + (p.supplementDocNumber || ''),
        INK,
        '#f2f3ef',
      ) +
      '</div>' +
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;">' +
      esc(p.reason) +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ' +
      LINE +
      ';"><span class="muted">Invoice now</span><b>' +
      esc(p.formatted.current) +
      '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ' +
      LINE +
      ';"><span class="muted">Freight</span><b>' +
      esc(p.formatted.freight) +
      '</b></div>' +
      '<div style="display:flex;justify-content:space-between;padding:7px 0;"><span class="muted">' +
      (p.mode === 'AMEND' ? 'Invoice becomes' : 'Freight invoice total') +
      '</span><b style="font-size:15px;">' +
      esc(p.formatted.next) +
      '</b></div>' +
      (p.warnings && p.warnings.length
        ? '<div style="background:#fdf6e6;border:1px solid #ecdcb0;border-radius:10px;padding:10px 12px;margin-top:12px;font-size:12.5px;color:#6b5512;">' +
          p.warnings
            .map(function (w) {
              return '<div>' + esc(w) + '</div>';
            })
            .join('') +
          '</div>'
        : '') +
      '</div>';
  }

  // ------------------------------------------------- embedded panel (freight review)

  /** Mount the same entry form inside another screen, e.g. the freight review. */
  async function mountPanel(containerId, proposalId, versionId, user) {
    var host = el(containerId);
    if (!host) return;
    host.innerHTML =
      '<div id="ftuPanel"><div class="muted" style="padding:14px 0;">Loading freight\u2026</div></div>';
    st = { pid: proposalId, vid: versionId, user: user, state: null };
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(versionId) + '/freight-state',
    );
    if (!r.ok) {
      el('ftuPanel').innerHTML = '<div class="err">Could not load the freight state.</div>';
      return;
    }
    st.state = await r.json();
    render();
  }

  window.FreightTrueUp = {
    /**
     * Borrow the shell's helpers. Everything this module needs from app.js, named
     * explicitly — so what it depends on is a list, not a search.
     */
    init: function (host) {
      H = host;
    },
    dashboardSection: dashboardSection,
    bindDashboard: bindDashboard,
    openWorkspace: openWorkspace,
    mountPanel: mountPanel,
  };
})();

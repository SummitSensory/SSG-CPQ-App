/*
 * Accounts receivable.
 *
 * Answers three questions and nothing else:
 *
 *   1. What was each customer originally invoiced, and what do they still owe?
 *   2. What is their purchase-order number, and does the QuickBooks invoice carry it?
 *   3. Send them a request for payment — from the signed-in person's own Outlook
 *      mailbox, under their own signature, with the invoice, a letterhead letter and
 *      the customer's own PO attached.
 *
 * Self-contained on purpose. It installs its own nav entry and uses its own copy of
 * the auth helpers rather than borrowing the shell's, so app.js needs no edit to
 * carry it — the same reason belt-shipments.js and freight-trueup.js are separate
 * files, taken one step further. If this script fails to load, the tab is simply
 * absent and nothing else in the workspace notices.
 *
 * Server side: src/routes/receivables.ts (reads and the PO) and
 * src/routes/receivablesRender.ts (the send, which renders a PDF and therefore runs
 * on the renderer function).
 */
(function () {
  'use strict';

  var AT = 'ssg_at',
    RT = 'ssg_rt';

  /* The workspace's own palette. Nothing new is introduced here — this screen has
   * to look like it was always part of the app, not like a bolt-on. */
  var INK = '#20241f',
    MUTE = '#82877d',
    SOFT = '#5c6357',
    LINE = '#dcded7',
    HAIR = '#f2f3ef',
    ACCENT = '#3d4a55',
    GREEN = '#3f9d78',
    AMBER = '#b7873a',
    RED = '#c2452f';

  var VIEW_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'ACCOUNTING'];
  var WRITE_ROLES = ['SYSTEM_ADMIN', 'ACCOUNTING'];
  var TEMPLATE_ROLES = ['SYSTEM_ADMIN'];

  var user = null;
  var installed = false;
  var tab = 'ledger';
  var showPaid = false;
  /* Which customer the ledger is narrowed to, by organization id. A name would look
   * the same on screen and break the moment two customers share one. */
  var custFilter = '';
  var data = null;
  var templates = null;
  var busy = false;

  /* Sort order, remembered between sessions. Defaults to the order the server
   * returns — due date, soonest first — because the question this screen is usually
   * open to answer is what needs chasing next. */
  var SORT_KEY = 'ssg.ar.sort';
  var sortKey = 'dueDate';
  var sortDir = 'asc';
  try {
    var savedSort = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (savedSort && savedSort.key) {
      sortKey = savedSort.key;
      sortDir = savedSort.dir === 'desc' ? 'desc' : 'asc';
    }
  } catch (e) {
    /* private mode, or a value from an older build */
  }

  /* ----------------------------------------------------------------- plumbing */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (!opts.noAuth) {
      var at = localStorage.getItem(AT);
      if (at) headers.Authorization = 'Bearer ' + at;
    }
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  /** One transparent refresh-retry on 401, the same contract the shell's authed has. */
  async function authed(path, opts) {
    var r = await api(path, opts);
    if (r.status === 401) {
      var rt = localStorage.getItem(RT);
      if (!rt) return r;
      var rr = await api('/auth/refresh', {
        method: 'POST',
        noAuth: true,
        body: { refreshToken: rt },
      });
      if (!rr.ok) return r;
      var d = await rr.json();
      if (d.accessToken) localStorage.setItem(AT, d.accessToken);
      if (d.refreshToken) localStorage.setItem(RT, d.refreshToken);
      r = await api(path, opts);
    }
    return r;
  }

  /** The message the server actually sent, not "Something went wrong". */
  async function failureText(res, fallback) {
    try {
      var j = await res.json();
      return j.message || j.error || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function can(list) {
    return !!user && list.indexOf(user.role) !== -1;
  }

  function fmtMoney(minor, cur) {
    if (minor == null || minor === '') return '—';
    var n = Number(minor) / 100;
    if (!isFinite(n)) return '—';
    return (
      (cur && cur !== 'USD' ? cur + ' ' : '$') +
      n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (p.length !== 3 || !mo[Number(p[1]) - 1]) return String(iso);
    return mo[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return fmtDate(iso) + ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtBytes(n) {
    var kb = Number(n) / 1024;
    return kb < 1024 ? Math.max(1, Math.round(kb)) + ' KB' : (kb / 1024).toFixed(1) + ' MB';
  }

  function titleCase(v) {
    return String(v || '')
      .toLowerCase()
      .split('_')
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
  }

  var FIELD =
    'width:100%;box-sizing:border-box;padding:8px 10px;font-size:13px;border:1px solid ' +
    LINE +
    ';border-radius:8px;font-family:inherit;color:' +
    INK +
    ';background:#fff;';

  function btn(label, attrs, kind) {
    var base =
      'font:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid ' +
      LINE +
      ';background:#fff;color:' +
      INK +
      ';';
    if (kind === 'primary')
      base = base
        .replace('background:#fff', 'background:' + ACCENT)
        .replace('color:' + INK, 'color:#fff;border-color:' + ACCENT);
    if (kind === 'danger') base += 'color:' + RED + ';';
    return '<button ' + (attrs || '') + ' style="' + base + '">' + label + '</button>';
  }

  function toast(message, bad) {
    var el = document.createElement('div');
    el.textContent = message;
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:9999;max-width:560px;' +
      'padding:11px 16px;border-radius:9px;font-size:13px;line-height:1.45;box-shadow:0 8px 26px rgba(0,0,0,.16);' +
      'background:' +
      (bad ? '#fdf1ef' : '#eef7f2') +
      ';color:' +
      (bad ? '#8d2f20' : '#22624a') +
      ';border:1px solid ' +
      (bad ? '#f3d3cd' : '#cfe7dc') +
      ';';
    document.body.appendChild(el);
    setTimeout(
      function () {
        el.remove();
      },
      bad ? 7000 : 3600,
    );
  }

  /* -------------------------------------------------------------------- modal */

  var modalEl = null;

  /**
   * One modal at a time, closed on Escape and on the backdrop.
   *
   * Its own rather than the shell's: this file deliberately borrows nothing, and a
   * dialog is thirty lines.
   */
  function openModal(title, bodyHtml, footerHtml, width) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.style.cssText =
      'position:fixed;inset:0;z-index:9000;background:rgba(24,26,22,.42);display:flex;align-items:flex-start;justify-content:center;padding:36px 18px;overflow:auto;';
    modalEl.innerHTML =
      '<div id="arModalCard" style="background:#fff;border-radius:14px;width:100%;max-width:' +
      (width || 620) +
      'px;box-shadow:0 24px 60px rgba(0,0,0,.22);overflow:hidden;">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 22px;border-bottom:1px solid ' +
      HAIR +
      ';">' +
      '<h3 style="margin:0;font-size:15.5px;font-weight:600;color:' +
      INK +
      ';line-height:1.35;">' +
      title +
      '</h3>' +
      '<button id="arModalX" aria-label="Close" style="border:0;background:none;font-size:20px;line-height:1;color:' +
      MUTE +
      ';cursor:pointer;padding:0 2px;">&times;</button>' +
      '</div>' +
      '<div style="padding:20px 22px;">' +
      bodyHtml +
      '</div>' +
      (footerHtml
        ? '<div style="display:flex;justify-content:flex-end;gap:9px;padding:15px 22px;border-top:1px solid ' +
          HAIR +
          ';background:#fbfcfa;">' +
          footerHtml +
          '</div>'
        : '') +
      '</div>';
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeModal();
    });
    document.getElementById('arModalX').addEventListener('click', closeModal);
    document.addEventListener('keydown', escClose);
    return modalEl;
  }

  function escClose(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    if (modalEl) modalEl.remove();
    modalEl = null;
    document.removeEventListener('keydown', escClose);
  }

  /* ------------------------------------------------------------------ install */

  /**
   * Put the tab in the sidebar without touching app.js.
   *
   * The shell's nav handler looks its own NAV array up by data-view and would throw
   * on an id it does not know, taking the whole nav down — so the click is caught in
   * the CAPTURE phase and stopped before it reaches that handler. The active-class
   * bookkeeping is then done here, identically to what the shell does.
   */
  function install() {
    var nav = document.getElementById('nav');
    if (!nav || document.getElementById('arNavItem')) return;
    if (!can(VIEW_ROLES)) return;

    var afterOrders = null;
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (b) {
      if (b.getAttribute('data-view') === 'orders') afterOrders = b;
    });

    var item = document.createElement('button');
    item.className = 'nav-item';
    item.id = 'arNavItem';
    item.setAttribute('data-view', 'receivables');
    item.innerHTML = '<span>Accounts Receivable</span>';
    if (afterOrders && afterOrders.nextSibling) nav.insertBefore(item, afterOrders.nextSibling);
    else nav.appendChild(item);

    nav.addEventListener(
      'click',
      function (e) {
        var hit = e.target.closest && e.target.closest('#arNavItem');
        if (!hit) return;
        e.stopPropagation();
        e.preventDefault();
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
          b.classList.remove('active');
        });
        hit.classList.add('active');
        var t = document.getElementById('viewTitle');
        if (t) t.textContent = 'Accounts Receivable';
        mount();
      },
      true,
    );
    installed = true;
  }

  /* -------------------------------------------------------------------- loads */

  async function loadLedger() {
    var r = await authed('/receivables' + (showPaid ? '?all=1' : ''));
    if (!r.ok) {
      data = { error: await failureText(r, 'The receivables list could not be read.') };
      return;
    }
    data = await r.json();
  }

  async function loadTemplates() {
    var r = await authed('/admin/payment-templates');
    templates = r.ok
      ? await r.json()
      : { error: await failureText(r, 'The templates could not be read.'), templates: [] };
  }

  /* ------------------------------------------------------------------- ledger */

  /**
   * A sortable column heading.
   *
   * The whole heading is the control rather than a small caret, because the caret is
   * a five-pixel target and the heading is not. `key` omitted leaves the heading
   * inert — the actions column has nothing to sort by.
   */
  function th(label, right, key) {
    var active = key && key === sortKey;
    var base =
      'text-align:' +
      (right ? 'right' : 'left') +
      ';padding:9px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' +
      (active ? SOFT : MUTE) +
      ';font-weight:600;border-bottom:1px solid ' +
      LINE +
      ';white-space:nowrap;';
    if (!key) return '<th style="' + base + '">' + label + '</th>';
    return (
      '<th data-ar="sort" data-key="' +
      key +
      '" title="Sort by ' +
      String(label).replace(/&amp;/g, '&') +
      '" style="' +
      base +
      'cursor:pointer;user-select:none;">' +
      label +
      '<span style="display:inline-block;width:11px;color:' +
      (active ? ACCENT : 'transparent') +
      ';">' +
      (active ? (sortDir === 'asc' ? '\u25b4' : '\u25be') : '\u25b4') +
      '</span></th>'
    );
  }

  /**
   * The value a row sorts on for a given column.
   *
   * Returns a number for money and dates and a lower-cased string for text, so the
   * comparator never has to know which column it is looking at. Null means "no
   * value", which always sorts last — in both directions. An invoice with no due
   * date is not the most urgent thing on the screen just because someone clicked
   * ascending.
   */
  function sortValue(r, key) {
    switch (key) {
      case 'customer':
        return (
          (r.organization && r.organization.name ? r.organization.name : '').toLowerCase() || null
        );
      case 'invoice':
        return (r.docNumber || '').toLowerCase() || null;
      case 'invoiced':
        return r.initialTotalMinor == null ? null : Number(r.initialTotalMinor);
      case 'received':
        return r.paidMinor == null ? null : Number(r.paidMinor);
      case 'balance':
        return r.balanceMinor == null ? null : Number(r.balanceMinor);
      case 'status':
        // Most overdue first when descending. Days past due is the only ordering of
        // OPEN / OVERDUE / PARTIALLY_PAID that means anything operationally.
        return Number(r.daysPastDue || 0);
      case 'invoiceDate':
        return r.invoiceDate ? Date.parse(r.invoiceDate) : null;
      case 'dueDate':
        return r.dueDate ? Date.parse(r.dueDate) : null;
      case 'po':
        return (r.poNumber || '').toLowerCase() || null;
      case 'lastRequest':
        return r.lastRequest ? Date.parse(r.lastRequest.at) : null;
      default:
        return null;
    }
  }

  function sortRows(rows) {
    var dir = sortDir === 'desc' ? -1 : 1;
    // Copied before sorting: `data.rows` is what the server sent, and mutating it
    // would make the order depend on how many times the heading has been clicked
    // since the last load.
    return rows.slice().sort(function (a, b) {
      var av = sortValue(a, sortKey);
      var bv = sortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // A stable tiebreak, so two invoices for the same customer do not swap places
      // on every repaint.
      return String(a.docNumber || '').localeCompare(String(b.docNumber || ''));
    });
  }

  function td(html, right) {
    return (
      '<td style="padding:11px 14px;border-bottom:1px solid ' +
      HAIR +
      ';font-size:13px;vertical-align:top;' +
      (right ? 'text-align:right;' : '') +
      '">' +
      html +
      '</td>'
    );
  }

  function statusChip(status, daysPastDue) {
    var tone = { PAID: GREEN, PARTIALLY_PAID: AMBER, OVERDUE: RED, OPEN: SOFT }[status] || MUTE;
    var label = titleCase(status || 'Open');
    if (daysPastDue > 0 && status !== 'PAID') label += ' · ' + daysPastDue + 'd';
    return (
      '<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;color:' +
      tone +
      ';border:1px solid ' +
      tone +
      '33;white-space:nowrap;">' +
      esc(label) +
      '</span>'
    );
  }

  function summaryCard(label, value, note, tone) {
    return (
      '<div style="flex:1 1 170px;border:1px solid ' +
      LINE +
      ';border-radius:11px;padding:13px 15px;background:#fff;">' +
      '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' +
      MUTE +
      ';">' +
      label +
      '</div>' +
      '<div style="font-size:20px;font-weight:600;margin-top:5px;color:' +
      (tone || INK) +
      ';">' +
      value +
      '</div>' +
      (note
        ? '<div style="font-size:11.5px;color:' + MUTE + ';margin-top:3px;">' + note + '</div>'
        : '') +
      '</div>'
    );
  }

  function paintLedger(host) {
    if (data && data.error) {
      host.innerHTML = '<div style="padding:18px;color:' + RED + ';">' + esc(data.error) + '</div>';
      return;
    }
    var allRows = (data && data.rows) || [];

    /* One entry per customer that actually has an invoice in view, so the picker can
     * never offer a name that would empty the table. */
    var custMap = {};
    allRows.forEach(function (r) {
      var o = r.organization;
      if (!o || !o.id) return;
      if (!custMap[o.id]) custMap[o.id] = { id: o.id, name: o.name || '—', count: 0 };
      custMap[o.id].count++;
    });
    var custList = Object.keys(custMap)
      .map(function (k) {
        return custMap[k];
      })
      .sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      });
    // A filter whose customer has dropped out of the current view (Include paid turned
    // off, an invoice closed) is cleared rather than left showing an empty table.
    if (custFilter && !custMap[custFilter]) custFilter = '';

    var rows = sortRows(
      custFilter
        ? allRows.filter(function (r) {
            return r.organization && r.organization.id === custFilter;
          })
        : allRows,
    );

    /* The server's totals cover the whole ledger. Under a filter they would describe
     * invoices the table is not showing, so the four cards are recomputed from the rows
     * in view — the numbers always add up to what is on screen. */
    var t = (data && data.totals) || {};
    if (custFilter) {
      var sum = { invoicedMinor: 0, paidMinor: 0, outstandingMinor: 0, pastDueMinor: 0 };
      rows.forEach(function (r) {
        sum.invoicedMinor += Number(r.initialTotalMinor || 0);
        sum.paidMinor += Number(r.paidMinor || 0);
        sum.outstandingMinor += Number(r.balanceMinor || 0);
        if (Number(r.daysPastDue || 0) > 0) sum.pastDueMinor += Number(r.balanceMinor || 0);
      });
      t = sum;
    }
    var writable = can(WRITE_ROLES);

    var body = rows.length
      ? rows
          .map(function (r) {
            var poBadge = r.poNumber
              ? esc(r.poNumber) +
                (r.poNeedsPush
                  ? '<div style="font-size:11.5px;color:' +
                    AMBER +
                    ';margin-top:2px;">Not on the QuickBooks invoice yet</div>'
                  : '')
              : '<span style="color:' + MUTE + ';">None</span>';
            var edited =
              r.currentTotalMinor !== r.initialTotalMinor
                ? '<div style="font-size:11.5px;color:' +
                  AMBER +
                  ';">now ' +
                  fmtMoney(r.currentTotalMinor, r.currency) +
                  '</div>'
                : '';
            return (
              '<tr>' +
              td(
                (r.organization && r.organization.id
                  ? '<button type="button" data-ar="filterCust" data-cust="' +
                    esc(r.organization.id) +
                    '" style="all:unset;cursor:pointer;font-weight:600;color:' +
                    INK +
                    ';text-decoration:underline;text-decoration-color:' +
                    LINE +
                    ';text-underline-offset:3px;">' +
                    esc(r.organization.name || '—') +
                    '</button>'
                  : '<b style="font-weight:600;">' +
                    esc((r.organization && r.organization.name) || '—') +
                    '</b>') +
                  '<div style="font-size:11.5px;color:' +
                  MUTE +
                  ';margin-top:2px;">' +
                  esc(r.proposal.number || '') +
                  (r.order ? ' · ' + esc(r.order.number) : '') +
                  '</div>',
              ) +
              td(
                '<b style="font-weight:600;">' +
                  esc(r.docNumber || '—') +
                  '</b>' +
                  '<div style="font-size:11.5px;color:' +
                  MUTE +
                  ';margin-top:2px;">' +
                  (r.invoiceDate ? esc(fmtDate(r.invoiceDate)) : 'Date not synced') +
                  '</div>',
              ) +
              td(fmtMoney(r.initialTotalMinor, r.currency) + edited, true) +
              td(fmtMoney(r.paidMinor, r.currency), true) +
              td(
                '<b style="font-weight:600;">' + fmtMoney(r.balanceMinor, r.currency) + '</b>',
                true,
              ) +
              td(
                statusChip(r.status, r.daysPastDue) +
                  '<div style="font-size:11.5px;color:' +
                  MUTE +
                  ';margin-top:3px;">' +
                  (r.dueDate ? 'Due ' + esc(fmtDate(r.dueDate)) : 'No due date') +
                  '</div>',
              ) +
              td(poBadge) +
              td(
                r.lastRequest
                  ? '<div style="font-size:12px;">' +
                      (r.lastRequest.status === 'sent'
                        ? esc(fmtStamp(r.lastRequest.at))
                        : '<span style="color:' +
                          RED +
                          ';">failed ' +
                          esc(fmtStamp(r.lastRequest.at)) +
                          '</span>') +
                      '<div style="color:' +
                      MUTE +
                      ';font-size:11.5px;">' +
                      esc(r.lastRequest.by || '') +
                      '</div></div>'
                  : '<span style="color:' + MUTE + ';">Never</span>',
              ) +
              td(
                '<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">' +
                  (writable
                    ? btn(
                        'Request payment',
                        'data-ar="compose" data-id="' + r.transactionId + '"',
                        'primary',
                      ) + btn('Purchase order', 'data-ar="po" data-id="' + r.transactionId + '"')
                    : '<span style="color:' + MUTE + ';font-size:12px;">View only</span>') +
                  '</div>',
                true,
              ) +
              '</tr>'
            );
          })
          .join('')
      : '<tr><td colspan="9" style="padding:26px 16px;color:' +
        MUTE +
        ';font-size:13px;">' +
        (showPaid
          ? 'No invoices in QuickBooks for this environment yet.'
          : 'Nothing outstanding. Every invoice in QuickBooks is paid in full.') +
        '</td></tr>';

    host.innerHTML =
      '<div style="display:flex;gap:11px;flex-wrap:wrap;margin-bottom:16px;">' +
      summaryCard('Invoiced', fmtMoney(t.invoicedMinor), 'as originally issued') +
      summaryCard('Received', fmtMoney(t.paidMinor)) +
      summaryCard('Outstanding', fmtMoney(t.outstandingMinor), null, INK) +
      summaryCard(
        'Past due',
        fmtMoney(t.pastDueMinor),
        'due date has passed',
        Number(t.pastDueMinor) > 0 ? RED : INK,
      ) +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
      '<div style="font-size:12px;color:' +
      MUTE +
      ';">' +
      'Balances are read back from QuickBooks — swept nightly, and whenever you press Refresh.' +
      (data && data.environment
        ? ' <b style="color:' + SOFT + ';">' + esc(titleCase(data.environment)) + '</b>'
        : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<select id="arCustomer" style="' +
      FIELD +
      'width:auto;min-width:190px;max-width:280px;font-size:12.5px;padding:7px 9px;">' +
      '<option value="">All customers (' +
      allRows.length +
      ')</option>' +
      custList
        .map(function (c) {
          return (
            '<option value="' +
            esc(c.id) +
            '"' +
            (custFilter === c.id ? ' selected' : '') +
            '>' +
            esc(c.name) +
            ' (' +
            c.count +
            ')</option>'
          );
        })
        .join('') +
      '</select>' +
      (custFilter ? btn('Clear', 'data-ar="clearCust"') : '') +
      '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:' +
      SOFT +
      ';cursor:pointer;">' +
      '<input type="checkbox" id="arShowPaid"' +
      (showPaid ? ' checked' : '') +
      ' style="width:15px;height:15px;accent-color:' +
      ACCENT +
      ';cursor:pointer;"> Include paid' +
      '</label>' +
      (can(WRITE_ROLES) ? btn('Refresh from QuickBooks', 'data-ar="refreshAll"') : '') +
      (can(TEMPLATE_ROLES) ? btn('Letters &amp; email', 'data-ar="tab-templates"') : '') +
      '</div></div>' +
      '<div style="border:1px solid ' +
      LINE +
      ';border-radius:12px;overflow:auto;background:#fff;">' +
      '<table style="width:100%;border-collapse:collapse;min-width:1120px;"><thead><tr>' +
      th('Customer', false, 'customer') +
      th('Invoice', false, 'invoice') +
      th('Invoiced', true, 'invoiced') +
      th('Received', true, 'received') +
      th('Balance', true, 'balance') +
      th('Status', false, 'status') +
      th('Customer PO', false, 'po') +
      th('Last request', false, 'lastRequest') +
      th('') +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
  }

  /* -------------------------------------------------------- purchase order */

  function rowById(id) {
    return ((data && data.rows) || []).filter(function (r) {
      return r.transactionId === id;
    })[0];
  }

  async function openPoPanel(txnId) {
    var row = rowById(txnId);
    if (!row) return;
    if (!row.order) {
      toast(
        'This invoice has no accepted order, so there is nowhere to file a purchase order.',
        true,
      );
      return;
    }

    var listRes = await authed('/orders/' + encodeURIComponent(row.order.id) + '/purchase-orders');
    var files = listRes.ok ? await listRes.json() : { files: [], storageConfigured: false };

    openModal(
      'Purchase order &middot; ' +
        esc((row.organization && row.organization.name) || '') +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';font-weight:400;margin-top:3px;">Order ' +
        esc(row.order.number) +
        ' &middot; invoice ' +
        esc(row.docNumber || '—') +
        '</div>',
      '<label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:5px;">Purchase-order number</label>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
        '<input id="arPo" value="' +
        esc(row.poNumber || '') +
        '" placeholder="e.g. PO-88431" style="' +
        FIELD +
        '">' +
        btn('Save', 'id="arPoSave"') +
        '</div>' +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';margin-top:7px;line-height:1.5;">' +
        'Saved on the order, which is what the QuickBooks push, the shop paperwork and the invoice all read. ' +
        (row.poPushedValue
          ? 'The QuickBooks invoice currently carries <b>' + esc(row.poPushedValue) + '</b>.'
          : 'The QuickBooks invoice does not carry a purchase order yet.') +
        '</div>' +
        '<div id="arPoPushBox" style="margin-top:12px;">' +
        (row.poNeedsPush || (row.poNumber && row.poNumber !== row.poPushedValue)
          ? '<div style="border:1px solid #f0e2c2;background:#fdf9ee;border-radius:9px;padding:11px 13px;font-size:12.5px;color:#6b5a24;line-height:1.5;">' +
            'The invoice in QuickBooks does not match. Pushing writes it into the invoice’s purchase-order field and its note to the customer, and changes nothing else.' +
            '<div style="margin-top:9px;">' +
            btn('Push to QuickBooks', 'id="arPoPush"', 'primary') +
            '</div></div>'
          : '') +
        '</div>' +
        '<hr style="border:0;border-top:1px solid ' +
        HAIR +
        ';margin:18px 0;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
        '<div style="font-size:13px;font-weight:600;">The customer’s PO document</div>' +
        (files.storageConfigured
          ? '<label style="font-size:12.5px;color:' +
            ACCENT +
            ';cursor:pointer;">Upload…' +
            '<input type="file" id="arPoFile" style="display:none;" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.heic,.doc,.docx,.xls,.xlsx"></label>'
          : '<span style="font-size:12px;color:' + MUTE + ';">Storage not configured</span>') +
        '</div>' +
        '<div id="arPoFiles" style="margin-top:10px;">' +
        poFileList(row.order.id, files.files || []) +
        '</div>' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin-top:10px;line-height:1.5;">' +
        'Up to 3 MB per file, which is also the largest attachment Outlook takes through this route. ' +
        'Anything filed here can be attached to a payment request.' +
        '</div>',
      btn('Close', 'data-ar="close"'),
      620,
    );

    document.getElementById('arPoSave').addEventListener('click', function () {
      savePo(row);
    });
    var push = document.getElementById('arPoPush');
    if (push)
      push.addEventListener('click', function () {
        pushPo(row);
      });
    var file = document.getElementById('arPoFile');
    if (file)
      file.addEventListener('change', function () {
        uploadPo(row, file);
      });
  }

  function poFileList(orderId, files) {
    if (!files.length) {
      return '<div style="font-size:12.5px;color:' + MUTE + ';">Nothing filed yet.</div>';
    }
    return files
      .map(function (f) {
        return (
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid ' +
          HAIR +
          ';">' +
          '<div style="min-width:0;"><div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          esc(f.filename) +
          '</div>' +
          '<div style="font-size:11.5px;color:' +
          MUTE +
          ';">' +
          fmtBytes(f.byteSize) +
          (f.poNumber ? ' · ' + esc(f.poNumber) : '') +
          ' · ' +
          esc(f.uploadedBy || '') +
          ', ' +
          esc(fmtDate(f.uploadedAt)) +
          '</div></div>' +
          '<div style="display:flex;gap:6px;flex:0 0 auto;">' +
          btn(
            'Open',
            'data-ar="poOpen" data-order="' +
              orderId +
              '" data-file="' +
              f.id +
              '" data-name="' +
              esc(f.filename) +
              '"',
          ) +
          btn(
            'Remove',
            'data-ar="poDelete" data-order="' + orderId + '" data-file="' + f.id + '"',
            'danger',
          ) +
          '</div></div>'
        );
      })
      .join('');
  }

  async function savePo(row) {
    var value = document.getElementById('arPo').value.trim();
    var r = await authed('/orders/' + encodeURIComponent(row.order.id) + '/po-number', {
      method: 'PUT',
      body: { poNumber: value || null },
    });
    if (!r.ok) {
      toast(await failureText(r, 'The purchase-order number was not saved.'), true);
      return;
    }
    var out = await r.json();
    toast(
      out.poNumber
        ? 'Purchase order saved.' +
            (out.invoicesNeedingPush
              ? ' ' + out.invoicesNeedingPush + ' invoice(s) now need pushing to QuickBooks.'
              : '')
        : 'Purchase order cleared.',
    );
    closeModal();
    await loadLedger();
    paint();
  }

  async function pushPo(row) {
    if (busy) return;
    busy = true;
    var b = document.getElementById('arPoPush');
    if (b) {
      b.disabled = true;
      b.textContent = 'Pushing…';
    }
    var r = await authed('/receivables/' + encodeURIComponent(row.transactionId) + '/push-po', {
      method: 'POST',
    });
    busy = false;
    if (!r.ok) {
      toast(await failureText(r, 'QuickBooks would not take the purchase order.'), true);
      if (b) {
        b.disabled = false;
        b.textContent = 'Push to QuickBooks';
      }
      return;
    }
    var out = await r.json();
    toast(
      'Purchase order ' +
        out.poNumber +
        ' written to invoice ' +
        (out.docNumber || '') +
        ' (' +
        out.wroteTo +
        ').',
    );
    closeModal();
    await loadLedger();
    paint();
  }

  function uploadPo(row, input) {
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      toast('That file is ' + fmtBytes(file.size) + '. The limit is 3 MB.', true);
      input.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = async function () {
      var base64 = String(reader.result || '').split(',')[1] || '';
      var r = await authed('/orders/' + encodeURIComponent(row.order.id) + '/purchase-orders', {
        method: 'POST',
        body: {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          base64: base64,
          poNumber: (document.getElementById('arPo') || {}).value || null,
        },
      });
      if (!r.ok) {
        toast(await failureText(r, 'The purchase order was not uploaded.'), true);
        return;
      }
      toast('Purchase order filed.');
      openPoPanel(row.transactionId);
      loadLedger().then(function () {
        if (tab === 'ledger') return;
      });
    };
    reader.onerror = function () {
      toast('That file could not be read.', true);
    };
    reader.readAsDataURL(file);
  }

  /** Fetch with auth, then hand the bytes to the browser as a download. */
  async function download(path, opts, filename) {
    var r = await authed(path, opts);
    if (!r.ok) {
      toast(await failureText(r, 'That document could not be produced.'), true);
      return;
    }
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /* ----------------------------------------------------------------- composer */

  var compose = null;

  async function openComposer(txnId) {
    var r = await authed('/receivables/' + encodeURIComponent(txnId) + '/compose');
    if (!r.ok) {
      toast(await failureText(r, 'The composer could not be opened.'), true);
      return;
    }
    compose = await r.json();

    var inv = compose.invoice;
    var emailTemplate = (compose.emailTemplates || [])[0] || null;

    var blockers = (compose.blockers || []).length
      ? '<div style="border:1px solid #f3d3cd;background:#fdf1ef;border-radius:9px;padding:11px 13px;margin-bottom:15px;font-size:12.5px;color:#8d2f20;line-height:1.55;">' +
        compose.blockers
          .map(function (b) {
            return '<div>' + esc(b) + '</div>';
          })
          .join('') +
        '</div>'
      : '';

    var figures =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:15px;">' +
      summaryCard(
        'Invoiced',
        fmtMoney(inv.initialTotalMinor, inv.currency),
        esc(fmtDate(inv.invoiceDate) || 'date not synced'),
      ) +
      summaryCard('Received', fmtMoney(inv.paidMinor, inv.currency)) +
      summaryCard(
        'Balance now',
        fmtMoney(inv.balanceMinor, inv.currency),
        inv.daysPastDue
          ? inv.daysPastDue + ' days past due'
          : inv.dueDate
            ? 'due ' + esc(fmtDate(inv.dueDate))
            : '',
        Number(inv.balanceMinor) > 0 ? INK : GREEN,
      ) +
      '</div>';

    var contactOptions = (compose.contacts || [])
      .map(function (c) {
        return (
          '<option value="' +
          esc(c.email) +
          '"' +
          (c.email === compose.defaultToEmail ? ' selected' : '') +
          '>' +
          esc(c.name || c.email) +
          (c.title ? ' — ' + esc(c.title) : '') +
          ' · ' +
          esc(c.email) +
          '</option>'
        );
      })
      .join('');

    var letterOptions =
      '<option value="">No letter attached</option>' +
      (compose.letterTemplates || [])
        .map(function (t) {
          return '<option value="' + esc(t.key) + '">' + esc(t.name) + '</option>';
        })
        .join('');

    var poChecks = (compose.poFiles || []).length
      ? compose.poFiles
          .map(function (f) {
            return (
              '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer;">' +
              '<input type="checkbox" class="arPoAttach" value="' +
              f.id +
              '" style="width:15px;height:15px;accent-color:' +
              ACCENT +
              ';cursor:pointer;">' +
              esc(f.filename) +
              ' <span style="color:' +
              MUTE +
              ';">' +
              fmtBytes(f.byteSize) +
              '</span></label>'
            );
          })
          .join('')
      : '<div style="font-size:12px;color:' +
        MUTE +
        ';">No purchase-order document filed. Add one from the Purchase order panel.</div>';

    openModal(
      'Request payment &middot; ' +
        esc((compose.customer && compose.customer.name) || '') +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';font-weight:400;margin-top:3px;">Invoice ' +
        esc(inv.docNumber || '—') +
        (compose.order ? ' &middot; order ' + esc(compose.order.number) : '') +
        '</div>',
      blockers +
        figures +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">To</label>' +
        (contactOptions
          ? '<select id="arToPick" style="' +
            FIELD +
            'margin-bottom:6px;">' +
            contactOptions +
            '</select>'
          : '') +
        '<input id="arTo" value="' +
        esc(compose.defaultToEmail || '') +
        '" placeholder="name@example.com" style="' +
        FIELD +
        '"></div>' +
        '<div><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Cc (optional)</label>' +
        '<input id="arCc" placeholder="Comma separated" style="' +
        FIELD +
        '"></div>' +
        '</div>' +
        '<div style="margin-top:12px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Template</label>' +
        '<select id="arEmailTemplate" style="' +
        FIELD +
        '">' +
        (compose.emailTemplates || [])
          .map(function (t) {
            return '<option value="' + esc(t.key) + '">' + esc(t.name) + '</option>';
          })
          .join('') +
        '</select></div>' +
        '<div style="margin-top:12px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Subject</label>' +
        '<input id="arSubject" style="' +
        FIELD +
        '"></div>' +
        '<div style="margin-top:12px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Message</label>' +
        '<div id="arBody" contenteditable="true" style="' +
        FIELD +
        'min-height:210px;max-height:340px;overflow:auto;line-height:1.55;"></div>' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin-top:6px;line-height:1.5;">' +
        'Edit it as freely as you like. It is sent from <b>' +
        esc(compose.sender.mailbox || compose.sender.email || 'your mailbox') +
        '</b>' +
        (compose.sender.hasSignature
          ? ' and your saved Outlook signature is added underneath.'
          : ' — you have no signature saved, so nothing is appended. Add one from your profile.') +
        '</div></div>' +
        '<div style="margin-top:16px;padding-top:14px;border-top:1px solid ' +
        HAIR +
        ';">' +
        '<div style="font-size:13px;font-weight:600;margin-bottom:9px;">Attachments</div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0;cursor:pointer;">' +
        '<input type="checkbox" id="arAttachInvoice" checked style="width:15px;height:15px;accent-color:' +
        ACCENT +
        ';cursor:pointer;">' +
        'The invoice, as QuickBooks renders it</label>' +
        '<div style="margin-top:9px;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;">' +
        '<div><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Letter on letterhead</label>' +
        '<select id="arLetter" style="' +
        FIELD +
        '">' +
        letterOptions +
        '</select></div>' +
        btn('Preview letter', 'id="arLetterPreview"') +
        '</div>' +
        '<div style="margin-top:11px;font-size:12px;color:' +
        SOFT +
        ';">The customer’s purchase order</div>' +
        '<div style="margin-top:4px;">' +
        poChecks +
        '</div>' +
        '</div>' +
        '<div style="margin-top:16px;padding-top:14px;border-top:1px solid ' +
        HAIR +
        ';">' +
        '<div style="font-size:13px;font-weight:600;">Dates you are committing to</div>' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin:4px 0 9px;line-height:1.5;">' +
        'Only needed if the letter or email you chose refers to them. Nothing here is guessed from the invoice.' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px;">' +
        '<div><label style="display:block;font-size:11.5px;color:' +
        SOFT +
        ';margin-bottom:4px;">Tentative ship date</label>' +
        '<input id="ar_tentative_ship_date" placeholder="e.g. May 18, 2026" style="' +
        FIELD +
        '"></div>' +
        '<div><label style="display:block;font-size:11.5px;color:' +
        SOFT +
        ';margin-bottom:4px;">Payment deadline</label>' +
        '<input id="ar_payment_deadline" placeholder="e.g. April 30, 2026" style="' +
        FIELD +
        '"></div>' +
        '<div><label style="display:block;font-size:11.5px;color:' +
        SOFT +
        ';margin-bottom:4px;">Final payment deadline</label>' +
        '<input id="ar_final_payment_deadline" placeholder="e.g. May 11, 2026" style="' +
        FIELD +
        '"></div>' +
        '</div></div>' +
        (compose.history && compose.history.length
          ? '<div style="margin-top:16px;padding-top:14px;border-top:1px solid ' +
            HAIR +
            ';">' +
            '<div style="font-size:13px;font-weight:600;margin-bottom:8px;">Already sent</div>' +
            compose.history
              .map(function (h) {
                return (
                  '<div style="font-size:12px;color:' +
                  SOFT +
                  ';padding:4px 0;">' +
                  esc(fmtStamp(h.at)) +
                  ' · ' +
                  esc(h.toEmail) +
                  ' · ' +
                  fmtMoney(h.balanceMinor) +
                  ' outstanding' +
                  (h.letter ? ' · ' + esc(h.letter) : '') +
                  (h.status !== 'sent' ? ' · <span style="color:' + RED + ';">failed</span>' : '') +
                  '<div style="color:' +
                  MUTE +
                  ';font-size:11.5px;">' +
                  esc(h.subject) +
                  ' — ' +
                  esc(h.by) +
                  '</div></div>'
                );
              })
              .join('') +
            '</div>'
          : ''),
      btn('Cancel', 'data-ar="close"') +
        btn(
          'Send from my Outlook',
          'id="arSend"' + ((compose.blockers || []).length ? ' disabled' : ''),
          'primary',
        ),
      760,
    );

    if (emailTemplate) await applyTemplate(emailTemplate.key);
    document.getElementById('arEmailTemplate').addEventListener('change', function (e) {
      applyTemplate(e.target.value);
    });
    var pick = document.getElementById('arToPick');
    if (pick) {
      pick.addEventListener('change', function (e) {
        document.getElementById('arTo').value = e.target.value;
      });
    }
    document.getElementById('arLetterPreview').addEventListener('click', previewLetter);
    document.getElementById('arSend').addEventListener('click', send);
  }

  function enteredValues() {
    var out = {};
    ['tentative_ship_date', 'payment_deadline', 'final_payment_deadline'].forEach(function (k) {
      var el = document.getElementById('ar_' + k);
      if (el && el.value.trim()) out[k] = el.value.trim();
    });
    return out;
  }

  /**
   * Render the chosen template on the server and drop the result into the form.
   *
   * Rendered server-side rather than substituting here, so the preview is the exact
   * string the send would produce — two implementations of the same substitution
   * eventually disagree, and the first anyone would know is a customer receiving the
   * disagreement.
   */
  /**
   * Attach the letter this email is normally sent with.
   *
   * A default, not a rule: the sender can change or clear it afterwards, and a
   * pairing naming a letter that has since been retired is ignored rather than
   * forced into a select that has no such option.
   */
  function applyPairedLetter(key) {
    var chosen = (compose.emailTemplates || []).filter(function (t) {
      return t.key === key;
    })[0];
    var sel = document.getElementById('arLetter');
    if (!sel || !chosen) return;
    var paired = chosen.pairedLetterKey || '';
    var exists = [].some.call(sel.options, function (o) {
      return o.value === paired;
    });
    sel.value = paired && exists ? paired : '';
  }

  async function applyTemplate(key) {
    applyPairedLetter(key);
    var r = await authed(
      '/receivables/' + encodeURIComponent(compose.invoice.transactionId) + '/preview',
      {
        method: 'POST',
        body: { emailTemplateKey: key, entered: enteredValues() },
      },
    );
    if (!r.ok) {
      toast(await failureText(r, 'That template could not be rendered.'), true);
      return;
    }
    var out = await r.json();
    document.getElementById('arSubject').value = out.subject;
    document.getElementById('arBody').innerHTML = out.bodyHtml;
    if (out.missing && out.missing.length) {
      toast(
        'The template refers to ' +
          out.missing
            .map(function (m) {
              return '{{' + m + '}}';
            })
            .join(', ') +
          ', which has no value for this invoice. Fill it in below or edit the message.',
        true,
      );
    }
  }

  function previewLetter() {
    var key = document.getElementById('arLetter').value;
    if (!key) {
      toast('Choose a letter first.', true);
      return;
    }
    download(
      '/render/receivables/' +
        encodeURIComponent(compose.invoice.transactionId) +
        '/letter-preview.pdf',
      { method: 'POST', body: { letterTemplateKey: key, entered: enteredValues() } },
      'letter-preview.pdf',
    );
  }

  async function send() {
    if (busy) return;
    var b = document.getElementById('arSend');
    var poIds = Array.prototype.slice
      .call(document.querySelectorAll('.arPoAttach'))
      .filter(function (c) {
        return c.checked;
      })
      .map(function (c) {
        return c.value;
      });

    var payload = {
      to: document.getElementById('arTo').value.trim(),
      cc: document.getElementById('arCc').value.trim() || null,
      subject: document.getElementById('arSubject').value.trim(),
      bodyHtml: document.getElementById('arBody').innerHTML,
      emailTemplateKey: document.getElementById('arEmailTemplate').value || null,
      letterTemplateKey: document.getElementById('arLetter').value || null,
      attachInvoicePdf: document.getElementById('arAttachInvoice').checked,
      poFileIds: poIds,
      entered: enteredValues(),
    };
    if (!payload.to) {
      toast('Give at least one recipient.', true);
      return;
    }
    if (!payload.subject) {
      toast('Give the email a subject.', true);
      return;
    }

    busy = true;
    b.disabled = true;
    // The letter is printed by headless Chromium on the renderer function, which is
    // a few seconds on a cold start. Saying so beats a button that looks stuck.
    b.textContent = payload.letterTemplateKey ? 'Printing the letter…' : 'Sending…';

    var r = await authed(
      '/render/receivables/' +
        encodeURIComponent(compose.invoice.transactionId) +
        '/payment-request/send',
      { method: 'POST', body: payload },
    );
    busy = false;

    if (!r.ok) {
      b.disabled = false;
      b.textContent = 'Send from my Outlook';
      toast(await failureText(r, 'The email was not sent.'), true);
      return;
    }
    var out = await r.json();
    closeModal();
    toast(
      'Sent from ' +
        out.mailbox +
        ' to ' +
        out.to.join(', ') +
        (out.attachments.length
          ? ' with ' +
            out.attachments.length +
            ' attachment' +
            (out.attachments.length === 1 ? '' : 's')
          : '') +
        '. It is in your Sent Items.',
    );
    await loadLedger();
    paint();
  }

  /* ---------------------------------------------------------------- templates */

  function paintTemplates(host) {
    var list = (templates && templates.templates) || [];
    var emails = list.filter(function (t) {
      return t.kind === 'EMAIL';
    });
    var letters = list.filter(function (t) {
      return t.kind === 'LETTER';
    });

    function card(t) {
      return (
        '<div style="border:1px solid ' +
        LINE +
        ';border-radius:11px;padding:14px 16px;background:#fff;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">' +
        '<div><div style="font-size:14px;font-weight:600;">' +
        esc(t.name) +
        (t.active
          ? ''
          : ' <span style="font-size:11.5px;color:' +
            MUTE +
            ';font-weight:400;">(retired)</span>') +
        '</div>' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin-top:3px;">' +
        esc(t.key) +
        ' · stage ' +
        t.stage +
        (t.usedCount ? ' · used ' + t.usedCount + '×' : '') +
        '</div></div>' +
        '<div style="display:flex;gap:6px;flex:0 0 auto;">' +
        (t.kind === 'LETTER'
          ? btn(
              'Preview PDF',
              'data-ar="tplPdf" data-id="' + t.id + '" data-name="' + esc(t.name) + '"',
            )
          : '') +
        btn('Edit', 'data-ar="tplEdit" data-id="' + t.id + '"') +
        (t.isBuiltIn
          ? btn('Reset', 'data-ar="tplReset" data-id="' + t.id + '"')
          : btn('Retire', 'data-ar="tplRetire" data-id="' + t.id + '"', 'danger')) +
        '</div></div>' +
        (t.whenToUse
          ? '<div style="font-size:12.5px;color:' +
            SOFT +
            ';margin-top:8px;line-height:1.5;">' +
            esc(t.whenToUse) +
            '</div>'
          : '') +
        '<div style="font-size:12.5px;color:' +
        INK +
        ';margin-top:9px;"><b>' +
        esc(t.preview.subject) +
        '</b></div>' +
        '<div style="font-size:12.5px;color:' +
        SOFT +
        ';margin-top:7px;max-height:132px;overflow:auto;border-top:1px solid ' +
        HAIR +
        ';padding-top:8px;line-height:1.5;">' +
        t.preview.bodyHtml +
        '</div>' +
        (t.preview.unknown && t.preview.unknown.length
          ? '<div style="font-size:11.5px;color:' +
            RED +
            ';margin-top:7px;">Unknown field(s): ' +
            t.preview.unknown
              .map(function (u) {
                return '{{' + esc(u) + '}}';
              })
              .join(', ') +
            '</div>'
          : '') +
        '</div>'
      );
    }

    /* An email and the letter it goes out with are one thing to a sender and two
     * records to the database. Two flat lists made the reader match them up by name,
     * which is exactly the work the pairing already knows how to do — so the screen is
     * grouped by pair, and anything unpaired says so rather than sitting silently in
     * the wrong half of the page. */
    function codeOf(t) {
      var m = /^\s*([A-Za-z]{2,6}-\d+)/.exec((t && t.name) || '');
      return m ? m[1].toUpperCase() : '';
    }

    function topicOf(t) {
      return String((t && t.name) || '').replace(/^\s*[A-Za-z]{2,6}-\d+\s*[—:–-]?\s*/, '');
    }

    var lettersByKey = {};
    letters.forEach(function (l) {
      lettersByKey[l.key] = l;
    });

    var claimed = {};
    var groups = emails.map(function (e) {
      var l = e.pairedLetterKey ? lettersByKey[e.pairedLetterKey] : null;
      if (l) claimed[l.key] = true;
      return { email: e, letter: l };
    });
    letters.forEach(function (l) {
      if (!claimed[l.key]) groups.push({ email: null, letter: l });
    });

    function slot(kind, note, inner) {
      return (
        '<div>' +
        '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' +
        MUTE +
        ';margin-bottom:7px;display:flex;gap:8px;align-items:baseline;">' +
        kind +
        '<span style="letter-spacing:0;text-transform:none;font-size:11.5px;">' +
        note +
        '</span></div>' +
        inner +
        '</div>'
      );
    }

    function emptySlot(text) {
      return (
        '<div style="border:1px dashed ' +
        LINE +
        ';border-radius:11px;padding:16px;font-size:12.5px;color:' +
        SOFT +
        ';line-height:1.55;background:#fff;">' +
        text +
        '</div>'
      );
    }

    function groupHtml(g) {
      var lead = g.email || g.letter;
      var code = codeOf(lead) || codeOf(g.letter);
      var topic = topicOf(g.email) || topicOf(g.letter) || (lead && lead.name) || '';
      var status = g.email && g.letter ? 'Email + letter' : g.email ? 'Email only' : 'Letter only';
      return (
        '<section style="border:1px solid ' +
        LINE +
        ';border-radius:14px;padding:16px 16px 18px;background:' +
        '#f7f7f5' +
        ';">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:13px;">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
        (code
          ? '<span style="font-size:12px;font-weight:700;letter-spacing:.04em;color:' +
            ACCENT +
            ';">' +
            esc(code) +
            '</span>'
          : '') +
        '<span style="font-size:14.5px;font-weight:600;color:' +
        INK +
        ';">' +
        esc(topic) +
        '</span></div>' +
        '<span style="font-size:11.5px;color:' +
        MUTE +
        ';">' +
        status +
        '</span>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px;align-items:start;">' +
        slot(
          'Email',
          'what the customer reads',
          g.email
            ? card(g.email)
            : emptySlot(
                'No email points to this letter yet. Open an email above, choose this letter under <b>Letter attached</b>, and the two travel together.',
              ),
        ) +
        slot(
          'Letter',
          'attached as a PDF',
          g.letter
            ? card(g.letter)
            : emptySlot('This email sends on its own. Edit it to attach a letter.'),
        ) +
        '</div></section>'
      );
    }
    host.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
      '<div style="font-size:12.5px;color:' +
      SOFT +
      ';max-width:680px;line-height:1.55;">' +
      'Each pair below is one email and the letter attached to it. Previews use sample figures; merge fields are ' +
      'written <b>{{like_this}}</b>, and <b>{{FIGURES}}</b> drops in the invoice figures table.<br>' +
      '<b>To send one:</b> go back to receivables, find the invoice, and press <b>Request payment</b>. Pick the email ' +
      'there and its letter attaches itself as a PDF.' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
      btn('Back to receivables', 'data-ar="tab-ledger"') +
      btn('New letter', 'data-ar="tplNew" data-kind="LETTER"', 'primary') +
      btn('New email', 'data-ar="tplNew" data-kind="EMAIL"') +
      '</div></div>' +
      '<div style="display:grid;gap:14px;margin-top:18px;">' +
      (groups.length
        ? groups.map(groupHtml).join('')
        : '<div style="border:1px dashed ' +
          LINE +
          ';border-radius:11px;padding:18px;font-size:12.5px;color:' +
          SOFT +
          ';line-height:1.6;">' +
          'Nothing here yet. Paste each letter in with <b>New letter</b>, then add the email it travels with using <b>New email</b> and pair the two.' +
          '</div>') +
      '</div>' +
      '<div style="margin-top:26px;border-top:1px solid ' +
      HAIR +
      ';padding-top:16px;">' +
      '<div style="font-size:13px;font-weight:600;margin-bottom:9px;">Merge fields</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px 18px;">' +
      ((templates && templates.mergeFields) || [])
        .map(function (f) {
          return (
            '<div style="font-size:12px;color:' +
            SOFT +
            ';display:flex;gap:8px;">' +
            '<code style="font-family:ui-monospace,monospace;color:' +
            ACCENT +
            ';">{{' +
            esc(f.token) +
            '}}</code>' +
            '<span style="color:' +
            MUTE +
            ';">' +
            esc(f.means) +
            (f.entered ? ' *' : '') +
            '</span></div>'
          );
        })
        .join('') +
      '</div>' +
      '<div style="font-size:11.5px;color:' +
      MUTE +
      ';margin-top:10px;">* typed in on the send form, not held in the CRM.</div>' +
      '</div>';
  }

  function templateById(id) {
    return ((templates && templates.templates) || []).filter(function (t) {
      return t.id === id;
    })[0];
  }

  function openTemplateEditor(t, kind) {
    var isNew = !t;
    var k = t ? t.kind : kind;

    // Only an email carries a letter. Retired letters are left out of the list but an
    // existing pairing to one is kept, so editing an email's subject cannot silently
    // drop the letter it has always gone out with.
    var pairedNow = (t && t.pairedLetterKey) || '';
    var pairable = ((templates && templates.templates) || []).filter(function (x) {
      return x.kind === 'LETTER' && (x.active || x.key === pairedNow);
    });
    var pairedField =
      k === 'EMAIL'
        ? '<div style="margin-top:10px;"><label style="display:block;font-size:12px;color:' +
          SOFT +
          ';margin-bottom:4px;">Sent with this letter</label>' +
          '<select id="arTplPaired" style="' +
          FIELD +
          '"><option value="">No letter</option>' +
          pairable
            .map(function (x) {
              return (
                '<option value="' +
                esc(x.key) +
                '"' +
                (x.key === pairedNow ? ' selected' : '') +
                '>' +
                esc(x.name) +
                '</option>'
              );
            })
            .join('') +
          '</select>' +
          '<div style="font-size:11.5px;color:' +
          MUTE +
          ';margin-top:4px;">Choosing this email in the composer attaches this letter automatically. It can still be changed before sending.</div></div>'
        : '';
    openModal(
      (isNew ? 'New ' : 'Edit ') + (k === 'LETTER' ? 'letter' : 'email'),
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;">' +
        '<div><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Name</label>' +
        '<input id="arTplName" value="' +
        esc(t ? t.name : '') +
        '" placeholder="e.g. First notice" style="' +
        FIELD +
        '"></div>' +
        '<div><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Stage</label>' +
        '<input id="arTplStage" type="number" min="1" max="99" value="' +
        (t ? t.stage : 1) +
        '" style="' +
        FIELD +
        '"></div>' +
        '</div>' +
        '<div style="margin-top:10px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Key</label>' +
        '<input id="arTplKey" value="' +
        esc(t ? t.key : '') +
        '" placeholder="first-notice" ' +
        (t && t.usedCount ? 'disabled' : '') +
        ' style="' +
        FIELD +
        '">' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin-top:4px;">Lower-case letters, numbers and hyphens. Fixed once the template has been used — the history refers to it.</div></div>' +
        '<div style="margin-top:10px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">When to use it (guidance only, never sent)</label>' +
        '<input id="arTplWhen" value="' +
        esc(t ? t.whenToUse || '' : '') +
        '" style="' +
        FIELD +
        '"></div>' +
        pairedField +
        '<div style="margin-top:10px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">' +
        (k === 'LETTER' ? 'Heading printed on the letter' : 'Email subject') +
        '</label>' +
        '<input id="arTplSubject" value="' +
        esc(t ? t.subject : '') +
        '" style="' +
        FIELD +
        '"></div>' +
        '<div style="margin-top:10px;"><label style="display:block;font-size:12px;color:' +
        SOFT +
        ';margin-bottom:4px;">Body</label>' +
        '<textarea id="arTplBody" rows="14" style="' +
        FIELD +
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;resize:vertical;">' +
        esc(
          t ? t.bodyHtml : '<p>Hello {{customer_first_name}},</p>\n\n<p></p>\n\n<p>Thank you,</p>',
        ) +
        '</textarea>' +
        '<div style="font-size:11.5px;color:' +
        MUTE +
        ';margin-top:5px;line-height:1.5;">' +
        'HTML: <code>&lt;p&gt;</code> for paragraphs, <code>&lt;b&gt;</code> for bold. Merge fields in <code>{{braces}}</code>. ' +
        'Scripts and styles are stripped on save.</div></div>',
      btn('Cancel', 'data-ar="close"') + btn('Save', 'id="arTplSave"', 'primary'),
      720,
    );

    document.getElementById('arTplSave').addEventListener('click', async function () {
      var body = {
        key: document.getElementById('arTplKey').value.trim(),
        kind: k,
        name: document.getElementById('arTplName').value.trim(),
        stage: Number(document.getElementById('arTplStage').value) || 1,
        whenToUse: document.getElementById('arTplWhen').value.trim() || null,
        subject: document.getElementById('arTplSubject').value.trim(),
        bodyHtml: document.getElementById('arTplBody').value.trim(),
        // Always sent, including as '' — that is how a pairing is cleared.
        pairedLetterKey: k === 'EMAIL' ? document.getElementById('arTplPaired').value || '' : '',
      };
      if (!body.name || !body.subject || !body.bodyHtml || (isNew && !body.key)) {
        toast('Name, key, subject and body are all needed.', true);
        return;
      }
      var r = isNew
        ? await authed('/admin/payment-templates', { method: 'POST', body: body })
        : await authed('/admin/payment-templates/' + encodeURIComponent(t.id), {
            method: 'PATCH',
            body: body,
          });
      if (!r.ok) {
        toast(await failureText(r, 'The template was not saved.'), true);
        return;
      }
      closeModal();
      toast('Saved.');
      await loadTemplates();
      paint();
    });
  }

  /* -------------------------------------------------------------------- paint */

  function paint() {
    var host = document.getElementById('view');
    if (!host) return;
    if (tab === 'templates') paintTemplates(host);
    else paintLedger(host);
  }

  /* One delegated handler for the whole screen, bound once. */
  document.addEventListener('click', async function (e) {
    var el = e.target.closest && e.target.closest('[data-ar]');
    if (!el) return;
    var action = el.getAttribute('data-ar');
    var id = el.getAttribute('data-id');

    if (action === 'close') {
      closeModal();
      return;
    }
    if (action === 'sort') {
      var key = el.getAttribute('data-key');
      if (!key) return;
      // Clicking the active column flips it; a new column starts ascending, except
      // for the ones where the interesting end is the top: nobody opens this screen
      // wanting to see the smallest balance or the least overdue invoice first.
      if (key === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else
        sortDir =
          key === 'balance' || key === 'invoiced' || key === 'received' || key === 'status'
            ? 'desc'
            : 'asc';
      sortKey = key;
      try {
        localStorage.setItem(SORT_KEY, JSON.stringify({ key: sortKey, dir: sortDir }));
      } catch (e) {
        /* private mode */
      }
      paint();
      return;
    }
    if (action === 'filterCust') {
      custFilter = el.getAttribute('data-cust') || '';
      paint();
      return;
    }
    if (action === 'clearCust') {
      custFilter = '';
      paint();
      return;
    }
    if (action === 'compose') {
      openComposer(id);
      return;
    }
    if (action === 'po') {
      openPoPanel(id);
      return;
    }
    if (action === 'tab-templates') {
      tab = 'templates';
      if (!templates) await loadTemplates();
      paint();
      return;
    }
    if (action === 'tab-ledger') {
      tab = 'ledger';
      paint();
      return;
    }
    if (action === 'refreshAll') {
      if (busy) return;
      busy = true;
      el.disabled = true;
      el.textContent = 'Reading QuickBooks…';
      var r = await authed('/receivables/refresh', { method: 'POST' });
      busy = false;
      if (!r.ok) toast(await failureText(r, 'QuickBooks could not be read.'), true);
      else {
        var out = await r.json();
        toast(
          'Refreshed ' +
            out.refreshed +
            ' of ' +
            out.checked +
            ' invoice(s).' +
            (out.errors && out.errors.length
              ? ' ' + out.errors.length + ' could not be read.'
              : '') +
            (out.note ? ' ' + out.note : ''),
          out.errors && out.errors.length ? true : false,
        );
      }
      await loadLedger();
      paint();
      return;
    }
    if (action === 'poOpen') {
      download(
        '/orders/' +
          encodeURIComponent(el.getAttribute('data-order')) +
          '/purchase-orders/' +
          encodeURIComponent(el.getAttribute('data-file')) +
          '/download',
        null,
        el.getAttribute('data-name') || 'purchase-order',
      );
      return;
    }
    if (action === 'poDelete') {
      if (!window.confirm('Remove this purchase-order document?')) return;
      var dr = await authed(
        '/orders/' +
          encodeURIComponent(el.getAttribute('data-order')) +
          '/purchase-orders/' +
          encodeURIComponent(el.getAttribute('data-file')),
        { method: 'DELETE' },
      );
      if (!dr.ok) toast(await failureText(dr, 'It was not removed.'), true);
      else {
        toast('Removed.');
        closeModal();
        await loadLedger();
        paint();
      }
      return;
    }
    if (action === 'tplNew') {
      openTemplateEditor(null, el.getAttribute('data-kind'));
      return;
    }
    if (action === 'tplEdit') {
      openTemplateEditor(templateById(id));
      return;
    }
    if (action === 'tplPdf') {
      download(
        '/render/admin/payment-templates/' + encodeURIComponent(id) + '/preview.pdf',
        { method: 'POST' },
        (el.getAttribute('data-name') || 'letter') + '.pdf',
      );
      return;
    }
    if (action === 'tplRetire') {
      if (
        !window.confirm(
          'Retire this template? It stays in the history but can no longer be chosen.',
        )
      )
        return;
      var rr = await authed('/admin/payment-templates/' + encodeURIComponent(id), {
        method: 'DELETE',
      });
      if (!rr.ok) toast(await failureText(rr, 'It was not retired.'), true);
      else {
        toast('Retired.');
        await loadTemplates();
        paint();
      }
      return;
    }
    if (action === 'tplReset') {
      var xr = await authed('/admin/payment-templates/' + encodeURIComponent(id) + '/reset', {
        method: 'POST',
      });
      if (!xr.ok) toast(await failureText(xr, 'It was not restored.'), true);
      else {
        toast('Restored to the original wording.');
        await loadTemplates();
        paint();
      }
      return;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'arCustomer') {
      custFilter = e.target.value || '';
      paint();
      return;
    }
    if (e.target && e.target.id === 'arShowPaid') {
      showPaid = e.target.checked;
      loadLedger().then(paint);
    }
  });

  /* ------------------------------------------------------------------- mount */

  async function mount() {
    var host = document.getElementById('view');
    if (host)
      host.innerHTML =
        '<div style="padding:18px;color:' + MUTE + ';font-size:13px;">Loading&hellip;</div>';
    tab = 'ledger';
    await loadLedger();
    paint();
  }

  /**
   * Wait for the shell to exist, then install the tab.
   *
   * The shell renders asynchronously after the session is checked, so there is
   * nothing to attach to at parse time. The observer disconnects the moment the nav
   * appears, and stops watching after fifteen seconds either way rather than
   * observing the document for the life of the tab.
   */
  function boot() {
    authed('/auth/me')
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (me) {
        if (!me) return;
        user = me;
        install();
        if (installed) return;
        var obs = new MutationObserver(function () {
          install();
          if (installed) obs.disconnect();
        });
        obs.observe(document.getElementById('root') || document.body, {
          childList: true,
          subtree: true,
        });
        setTimeout(function () {
          obs.disconnect();
        }, 15000);
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.SSGAccountsReceivable = { mount: mount, install: install };
})();

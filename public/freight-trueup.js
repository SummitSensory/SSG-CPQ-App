/**
 * Freight — the screen for freight that arrives after the proposal went out.
 *
 * A separate file from app.js on purpose: this is one workflow with one owner (the
 * person who manages vendor freight pricing), and it needs to be readable and
 * replaceable without touching the 10,000-line application shell. It borrows the
 * shell's helpers rather than reimplementing them — see init() — so the styling,
 * auth, modals and money formatting stay identical to everything around it.
 *
 * FOUR buckets, because freight reaches Summit four different ways:
 *
 *   Steel and Mats are quoted on the monday deal board by the people who arrange the
 *   trucks. This screen READS them — on open, on Refresh, overnight, and on the
 *   board's own webhook — and typing one in by hand is an override that asks for a
 *   reason. Nobody should be retyping a number that already exists in the system
 *   that produced it.
 *
 *   Therapeutic equipment & accessories and Other are entered by hand against the
 *   items they cover. One amount over a selection of items, split pro-rata, because
 *   that is how a vendor quotes it: "$1,840 to ship the swing, the platform and the
 *   crash pad".
 *
 * Every screen shows WHAT IS BEING SHIPPED. The version this replaced showed a bare
 * "Structure freight — 0.00" box with no indication of which job's equipment it
 * covered, which is the complaint that prompted the rebuild. The item table is
 * present on all four buckets, including the two where the amount is one job-level
 * figure: the person approving $4,250 of steel freight should be able to see the
 * structure it is shipping.
 *
 * Entry points:
 *   dashboardSection(user)      → the "Freight outstanding" block on the dashboard
 *   mountBanner(user)           → the persistent "invoice is short of freight" banner
 *   openWorkspace(pid, vid, u)  → the entry screen for one job
 *   mountPanel(host, pid, vid)  → the same panel embedded in the freight review screen
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
  var BLUEBG = '#eef3f7',
    BLUE = '#2f5d7d';

  /** Rows shown before a list folds. The rest are rendered and hidden, not dropped. */
  var VISIBLE = 8;

  var BUCKET_ORDER = ['STEEL', 'MATS', 'THERAPEUTIC', 'OTHER'];

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
    if (row.appliedNotPushedMinor > 0 && row.hasInvoice)
      return chip('Invoice short', RED, '#fbecea');
    if (row.invoicePushed && !row.gapBuckets.length) return chip('On invoice', GREEN, '#eef6f0');
    if (row.trueUpStatus === 'APPLIED') return chip('On proposal', AMBER, '#fdf6e6');
    if (row.stagedMinor > 0) return chip('Entered', AMBER, '#fdf6e6');
    return chip('Not started', RED, '#fbecea');
  }
  function timeAgo(iso) {
    if (!iso) return '';
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return '';
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  var INPUT =
    'width:130px;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:13.5px;background:#fff;outline:none;text-align:right;font-variant-numeric:tabular-nums;';
  var TEXT =
    'width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:13.5px;background:#fff;outline:none;';
  var LABEL =
    'display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:' +
    MUTED +
    ';margin-bottom:5px;';
  var BTN_DARK =
    'padding:10px 16px;border:0;border-radius:9px;background:' +
    INK +
    ';color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;';
  var BTN_PLAIN =
    'padding:10px 16px;border:1px solid #dcded7;border-radius:9px;background:#fff;color:' +
    INK +
    ';font-size:13.5px;cursor:pointer;';
  var BTN_LINK =
    'padding:0;border:0;background:none;color:' +
    RED +
    ';font-size:12.5px;cursor:pointer;text-decoration:underline;';

  async function errorText(r) {
    try {
      var j = await r.json();
      return j.message || j.error || 'Request failed (' + r.status + ')';
    } catch (e) {
      return 'Request failed (' + r.status + ')';
    }
  }

  /* ══════════════════════════ the dashboard block ══════════════════════════ */

  async function dashboardSection(user) {
    var data = null;
    try {
      var r = await H.authed('/freight/queue');
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (!data || !data.rows || !data.rows.length) return '';
    var rows = data.rows;

    return (
      '<div style="margin-bottom:18px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:8px;">' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' +
      RED +
      ';">' +
      'Freight outstanding \u00b7 ' +
      rows.length +
      '</div>' +
      (data.escalated
        ? '<span class="muted" style="font-size:11.5px;">' +
          data.escalated +
          ' past ' +
          data.threshold +
          ' days</span>'
        : '') +
      '</div>' +
      '<div style="background:' +
      REDBG +
      ';border:1px solid ' +
      REDLINE +
      ';border-radius:12px;overflow:hidden;">' +
      foldRows(
        rows.map(function (r, i) {
          var detail = [];
          if (r.gapBuckets.length) detail.push(r.gapBuckets.map(bucketShort).join(', '));
          if (r.vendors && r.vendors.length) detail.push(r.vendors.join(', '));
          if (r.appliedNotPushedMinor) detail.push(money(r.appliedNotPushedMinor) + ' not billed');
          else if (r.stagedMinor) detail.push(money(r.stagedMinor) + ' entered');
          return (
            '<div class="ftuRow" data-pid="' +
            esc(r.proposalId) +
            '" data-vid="' +
            esc(r.versionId) +
            '" ' +
            'style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' +
            (i ? 'border-top:1px solid ' + REDLINE + ';' : '') +
            '">' +
            '<div style="min-width:0;">' +
            '<b style="font-weight:600;font-size:13.5px;">' +
            esc(r.customer) +
            '</b>' +
            '<div class="muted" style="font-size:12px;">' +
            esc(r.title) +
            ' \u00b7 ' +
            esc(r.number) +
            ' v' +
            r.version +
            '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;white-space:nowrap;">' +
            '<span class="muted" style="font-size:11.5px;">' +
            esc(detail.join(' \u00b7 ')) +
            '</span>' +
            stateChip(r) +
            ageChip(r) +
            '</div>' +
            '</div>'
          );
        }),
        VISIBLE,
        REDLINE,
        RED,
      ) +
      '</div></div>'
    );
  }

  function bucketShort(b) {
    return (
      {
        STEEL: 'steel',
        MATS: 'mats',
        THERAPEUTIC: 'therapeutic',
        OTHER: 'other',
        STRUCTURE: 'steel',
        STANDARD: 'other',
        THIRD_PARTY: 'therapeutic',
      }[b] || String(b).toLowerCase()
    );
  }

  /**
   * Lists FOLD rather than truncate.
   *
   * Every row is rendered; the ones past the limit start hidden behind a footer that
   * opens them. A block headed "30" that shows eight and ends in a dead "and 22 more"
   * is a count nobody can act on, and this is the list the day is worked from.
   */
  function foldRows(rowHtmls, limit, lineColor, textColor) {
    var extra = rowHtmls.length - limit;
    if (extra <= 0) return rowHtmls.join('');
    return (
      rowHtmls.slice(0, limit).join('') +
      rowHtmls
        .slice(limit)
        .map(function (h) {
          return '<div class="ftuExtra" style="display:none;">' + h + '</div>';
        })
        .join('') +
      '<button type="button" class="ftuMore" data-shown="0" data-limit="' +
      limit +
      '" data-total="' +
      rowHtmls.length +
      '" data-hidden="' +
      extra +
      '" ' +
      'style="display:block;width:100%;text-align:left;background:none;border:0;border-top:1px solid ' +
      lineColor +
      ';padding:9px 14px;font:inherit;font-size:12px;color:' +
      textColor +
      ';cursor:pointer;">' +
      'Show all ' +
      rowHtmls.length +
      ' \u00b7 ' +
      extra +
      ' more</button>'
    );
  }

  /** Wire the rows the section just rendered. Called after innerHTML is set. */
  function bindDashboard(user) {
    Array.prototype.forEach.call(document.querySelectorAll('.ftuRow'), function (node) {
      node.addEventListener('click', function () {
        openWorkspace(node.getAttribute('data-pid'), node.getAttribute('data-vid'), user);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ftuMore'), function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('data-shown') === '1';
        Array.prototype.forEach.call(btn.parentNode.querySelectorAll('.ftuExtra'), function (n) {
          n.style.display = open ? 'none' : '';
        });
        btn.setAttribute('data-shown', open ? '0' : '1');
        btn.textContent = open
          ? 'Show all ' +
            btn.getAttribute('data-total') +
            ' \u00b7 ' +
            btn.getAttribute('data-hidden') +
            ' more'
          : 'Show the oldest ' + btn.getAttribute('data-limit') + ' only';
      });
    });
  }

  /* ══════════════════════════ the banner ══════════════════════════ */

  /**
   * The persistent notice that an invoice is short of freight.
   *
   * Mounted once by the shell and left alone: it sits above every screen, because an
   * invoice that is missing money should not be discoverable only by whoever happens
   * to open the freight panel. Dismissing it is possible — the screen underneath has
   * to be readable — and quiet for a day, after which it returns. The alert stops
   * when the freight is billed or somebody records that none applies, not when it is
   * clicked away.
   */
  async function mountBanner(user) {
    var host = el('ftuBanner');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ftuBanner';
      document.body.insertBefore(host, document.body.firstChild);
    }
    bannerUser = user;
    await refreshBanner();
    if (bannerTimer) clearInterval(bannerTimer);
    // Five minutes. Freight lands during the working day and the point of the banner
    // is that nobody has to go looking for it.
    bannerTimer = setInterval(refreshBanner, 300000);
  }

  var bannerUser = null,
    bannerTimer = null;

  async function refreshBanner() {
    var host = el('ftuBanner');
    if (!host) return;
    var data = null;
    try {
      var r = await H.authed('/freight/alerts');
      if (r.ok) data = await r.json();
    } catch (e) {}
    if (!data || !data.alerts || !data.alerts.length) {
      host.innerHTML = '';
      return;
    }

    var alerts = data.alerts;
    var short = alerts.filter(function (a) {
      return a.severity === 'BILLED_SHORT';
    });
    var lead = short[0] || alerts[0];
    var loud = short.length > 0;

    host.innerHTML =
      '<div style="background:' +
      (loud ? '#8c2b20' : '#7a6318') +
      ';color:#fff;padding:11px 18px;' +
      'display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13.5px;line-height:1.5;">' +
      '<span style="font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-size:11px;' +
      'background:rgba(255,255,255,.18);padding:3px 8px;border-radius:999px;white-space:nowrap;">' +
      (loud ? 'Invoice short of freight' : 'Freight outstanding on an invoiced job') +
      '</span>' +
      '<span style="min-width:0;flex:1 1 320px;">' +
      esc(lead.headline) +
      '. ' +
      esc(lead.detail) +
      '</span>' +
      (loud && data.unbilledMinor
        ? '<span style="font-weight:700;white-space:nowrap;">' +
          money(data.unbilledMinor) +
          ' unbilled</span>'
        : '') +
      (alerts.length > 1
        ? '<button type="button" id="ftuAlertList" style="background:rgba(255,255,255,.16);border:0;color:#fff;' +
          'padding:7px 12px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;">' +
          'All ' +
          alerts.length +
          '</button>'
        : '') +
      '<button type="button" id="ftuAlertOpen" style="background:#fff;border:0;color:' +
      (loud ? '#8c2b20' : '#7a6318') +
      ';padding:7px 13px;border-radius:8px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;">' +
      (loud ? 'Add it to the invoice' : 'Open the freight panel') +
      '</button>' +
      (can(bannerUser, WRITE_ROLES)
        ? '<button type="button" id="ftuAlertAck" title="Hidden for a day, then it comes back" ' +
          'style="background:none;border:0;color:rgba(255,255,255,.75);padding:4px;font:inherit;font-size:18px;' +
          'line-height:1;cursor:pointer;">\u00d7</button>'
        : '') +
      '</div>';

    var open = el('ftuAlertOpen');
    if (open)
      open.addEventListener('click', function () {
        openWorkspace(lead.proposalId, lead.versionId, bannerUser);
      });

    var ack = el('ftuAlertAck');
    if (ack)
      ack.addEventListener('click', async function () {
        ack.disabled = true;
        await H.authed('/freight/alerts/' + encodeURIComponent(lead.versionId) + '/acknowledge', {
          method: 'POST',
        });
        await refreshBanner();
      });

    var list = el('ftuAlertList');
    if (list)
      list.addEventListener('click', function () {
        H.openModal(
          'Invoices short of freight',
          '<div style="max-height:60vh;overflow:auto;">' +
            alerts
              .map(function (a) {
                return (
                  '<div style="padding:11px 0;border-bottom:1px solid ' +
                  LINE +
                  ';">' +
                  '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">' +
                  '<b style="font-size:13.5px;">' +
                  esc(a.number) +
                  ' \u00b7 ' +
                  esc(a.customer) +
                  '</b>' +
                  (a.unbilledMinor
                    ? '<span style="color:' +
                      RED +
                      ';font-weight:700;white-space:nowrap;">' +
                      money(a.unbilledMinor) +
                      '</span>'
                    : chip('outstanding', AMBER, '#fdf6e6')) +
                  '</div>' +
                  '<div class="muted" style="font-size:12.5px;margin-top:3px;">' +
                  esc(a.detail) +
                  '</div>' +
                  '<button type="button" class="ftuAlertGo" data-pid="' +
                  esc(a.proposalId) +
                  '" data-vid="' +
                  esc(a.versionId) +
                  '" ' +
                  'style="' +
                  BTN_LINK +
                  'margin-top:6px;">Open ' +
                  esc(a.number) +
                  '</button>' +
                  '</div>'
                );
              })
              .join('') +
            '</div>',
          null,
        );
        setTimeout(function () {
          Array.prototype.forEach.call(document.querySelectorAll('.ftuAlertGo'), function (b) {
            b.addEventListener('click', function () {
              openWorkspace(b.getAttribute('data-pid'), b.getAttribute('data-vid'), bannerUser);
            });
          });
        }, 0);
      });
  }

  /* ══════════════════════════ the workspace ══════════════════════════ */

  var st = null; // { pid, vid, user, state, draft }

  async function openWorkspace(proposalId, versionId, user) {
    var view = el('view');
    if (!view) return;
    view.innerHTML = '<div class="muted" style="padding:24px;">Loading freight\u2026</div>';
    st = { pid: proposalId, vid: versionId, user: user, state: null, draft: {}, showItems: {} };
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(versionId) + '/freight-state',
    );
    if (!r.ok) {
      view.innerHTML =
        '<div class="err" style="padding:18px;">Could not load the freight for this proposal.</div>';
      return;
    }
    st.state = await r.json();
    view.innerHTML =
      '<button type="button" id="ftuBack" style="' +
      BTN_PLAIN +
      'margin-bottom:16px;">\u2039 Back</button>' +
      '<div id="ftuPanel"></div>';
    el('ftuBack').addEventListener('click', function () {
      H.goToProposals(user);
    });
    render();
  }

  async function mountPanel(hostId, proposalId, versionId, user) {
    var host = typeof hostId === 'string' ? el(hostId) : hostId;
    if (!host) return;
    host.innerHTML =
      '<div id="ftuPanel"><div class="muted" style="padding:14px 0;">Loading freight\u2026</div></div>';
    st = { pid: proposalId, vid: versionId, user: user, state: null, draft: {}, showItems: {} };
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(versionId) + '/freight-state',
    );
    if (!r.ok) {
      el('ftuPanel').innerHTML = '<div class="err">Could not load the freight.</div>';
      return;
    }
    st.state = await r.json();
    render();
  }

  /** Re-read the state and repaint, after any write. Drafts are deliberately kept. */
  async function reload(opts) {
    var q = opts && opts.sync === false ? '?sync=0' : '';
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-state' + q,
    );
    if (r.ok) st.state = await r.json();
    render();
    refreshBanner();
  }

  function render() {
    var host = el('ftuPanel');
    if (!host || !st || !st.state) return;
    var s = st.state;
    var writeable = can(st.user, WRITE_ROLES);

    host.innerHTML =
      headerHtml(s) +
      mondayNoteHtml(s) +
      itemsHtml(s) +
      '<div style="display:grid;gap:12px;margin-top:14px;">' +
      BUCKET_ORDER.map(function (b) {
        return bucketCardHtml(s, b, writeable);
      }).join('') +
      '</div>' +
      footerHtml(s, writeable) +
      historyHtml(s);

    bindPanel();
  }

  function headerHtml(s) {
    var out = s.outstanding || [];
    return (
      '<div style="background:' +
      SURFACE +
      ';border:1px solid ' +
      LINE +
      ';border-radius:14px;padding:16px 18px;">' +
      '<div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:baseline;">' +
      '<div>' +
      '<div class="muted" style="font-size:11.5px;letter-spacing:.05em;">' +
      esc(s.number) +
      ' \u00b7 V' +
      s.version +
      '</div>' +
      '<div style="font-size:20px;font-weight:600;margin-top:2px;">' +
      esc(s.title) +
      '</div>' +
      '<div class="muted" style="font-size:12.5px;margin-top:3px;">' +
      esc(H.titleCase ? H.titleCase(s.status) : s.status) +
      (s.releasedAt ? ' \u00b7 out with the customer since ' + esc(H.fmtDate(s.releasedAt)) : '') +
      '</div>' +
      '</div>' +
      '<div style="text-align:right;">' +
      '<div style="font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;">' +
      money(s.totals.totalMinor) +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;">current proposal total</div>' +
      '<div style="margin-top:6px;">' +
      (out.length
        ? chip(
            s.ageDays + (s.ageDays === 1 ? ' day outstanding' : ' days outstanding'),
            s.ageDays >= s.threshold ? RED : AMBER,
            s.ageDays >= s.threshold ? REDBG : '#fdf6e6',
          )
        : chip('all four buckets answered', GREEN, '#eef6f0')) +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:14px;padding-top:13px;border-top:1px solid ' +
      LINE +
      ';">' +
      BUCKET_ORDER.map(function (b) {
        var card = bucketOf(s, b);
        var amount = card.onProposalMinor;
        return (
          '<div>' +
          '<div class="muted" style="font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;">' +
          esc(card.short) +
          '</div>' +
          '<div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:' +
          (amount > 0 ? INK : card.notApplicable ? MUTED : RED) +
          ';">' +
          (amount > 0 ? money(amount) : card.notApplicable ? 'n/a' : 'none') +
          '</div>' +
          '</div>'
        );
      }).join('') +
      '</div>' +
      '</div>'
    );
  }

  function bucketOf(s, bucket) {
    for (var i = 0; i < s.buckets.length; i++)
      if (s.buckets[i].bucket === bucket) return s.buckets[i];
    return {
      bucket: bucket,
      label: bucket,
      short: bucket,
      source: 'MANUAL',
      scopes: ['JOB'],
      entries: [],
      onProposalMinor: 0,
      stagedMinor: 0,
      appliedMinor: 0,
      pushedMinor: 0,
      outstanding: false,
      notApplicable: false,
    };
  }

  /**
   * What the board says, and what it says that this screen will not act on.
   *
   * The mats freight TAX is the second half of that. monday quotes it next to the
   * mats freight, and a freight true-up may not move tax — so it is reported here
   * rather than silently dropped, and somebody decides what to do about it.
   */
  function mondayNoteHtml(s) {
    var m = s.monday;
    if (!m) return '';
    var bits = [];
    if (m.error) {
      bits.push(
        '<div style="color:' +
          AMBER +
          ';">The deal board could not be read: ' +
          esc(m.error) +
          ' Steel and mats can still be entered by hand below, with a reason.</div>',
      );
    } else if (m.readAt) {
      bits.push(
        '<div class="muted">Deal board read ' +
          esc(timeAgo(m.readAt)) +
          (m.itemId ? ' \u00b7 item ' + esc(m.itemId) : '') +
          '.</div>',
      );
    }
    if (m.matsTaxMinor) {
      bits.push(
        '<div style="color:' +
          BLUE +
          ';">The board also holds ' +
          money(m.matsTaxMinor) +
          ' of mats freight <b>tax</b>. That is a tax pass-through, not freight, so it is not one of these ' +
          'buckets \u2014 changing it needs a new proposal version.</div>',
      );
    }
    (m.conflicts || []).forEach(function (c) {
      bits.push(
        '<div style="color:' +
          RED +
          ';"><b>' +
          esc(bucketShort(c.bucket)) +
          ' freight disagrees with the board.</b> ' +
          'The board now says ' +
          money(c.boardMinor) +
          '; ' +
          money(c.recordedMinor) +
          ' is already ' +
          (c.status === 'PUSHED' ? 'on the customer\u2019s invoice' : 'on the proposal') +
          '. ' +
          'Nothing was changed. If the board is right, bill the difference as a new amount.</div>',
      );
    });
    if (!bits.length) return '';
    return (
      '<div style="margin-top:12px;background:' +
      BLUEBG +
      ';border:1px solid #d7e2ea;border-radius:12px;' +
      'padding:12px 15px;font-size:12.5px;line-height:1.6;display:grid;gap:6px;">' +
      bits.join('') +
      '</div>'
    );
  }

  /**
   * What is being shipped.
   *
   * Always available, on every bucket. The old screen asked for a freight amount
   * without ever saying what it covered.
   */
  function itemsHtml(s) {
    var lines = s.lines || [];
    if (!lines.length) return '';
    var open = st.showItems.all;
    return (
      '<div style="margin-top:12px;border:1px solid ' +
      LINE +
      ';border-radius:12px;overflow:hidden;background:#fff;">' +
      '<button type="button" id="ftuItemsToggle" style="display:flex;width:100%;justify-content:space-between;' +
      'align-items:center;gap:12px;background:' +
      SURFACE +
      ';border:0;padding:11px 15px;font:inherit;cursor:pointer;text-align:left;">' +
      '<span style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:' +
      MUTED +
      ';">' +
      'What is shipping \u00b7 ' +
      lines.length +
      ' item' +
      (lines.length === 1 ? '' : 's') +
      '</span>' +
      '<span class="muted" style="font-size:12px;">' +
      (open ? 'Hide' : 'Show') +
      '</span>' +
      '</button>' +
      (open
        ? '<div style="max-height:280px;overflow:auto;">' +
          lines
            .map(function (l, i) {
              return (
                '<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 15px;' +
                (i ? 'border-top:1px solid #f2f3ef;' : '') +
                '">' +
                '<div style="min-width:0;">' +
                '<div style="font-size:13px;">' +
                esc(l.name) +
                '</div>' +
                '<div class="muted" style="font-size:11.5px;">' +
                esc(l.sku || '\u2014') +
                (l.vendor ? ' \u00b7 ' + esc(l.vendor) : '') +
                (l.quantity ? ' \u00b7 qty ' + l.quantity : '') +
                (l.freightQuoted ? ' \u00b7 vendor quotes freight' : '') +
                '</div>' +
                '</div>' +
                '<div style="text-align:right;white-space:nowrap;font-size:12.5px;font-variant-numeric:tabular-nums;">' +
                esc(H.fmt0 ? H.fmt0(l.extendedMinor / 100) : money(l.extendedMinor)) +
                '<div class="muted" style="font-size:11.5px;">' +
                (l.currentMinor ? money(l.currentMinor) + ' freight' : 'no freight') +
                '</div>' +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>'
        : '') +
      '</div>'
    );
  }

  /* ─────────────────────────── one bucket ─────────────────────────── */

  function bucketCardHtml(s, bucket, writeable) {
    var c = bucketOf(s, bucket);
    var board = s.monday || {};
    var isBoard = c.source === 'MONDAY';
    var d =
      st.draft[bucket] || (st.draft[bucket] = { scope: c.scopes[0], refs: {}, manual: false });
    var tone = c.notApplicable ? MUTED : c.outstanding ? RED : GREEN;
    var toneBg = c.notApplicable ? '#f4f5f2' : c.outstanding ? REDBG : '#f2f8f4';

    var head =
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap;">' +
      '<div>' +
      '<div style="font-size:14.5px;font-weight:600;">' +
      esc(c.label) +
      '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:2px;max-width:520px;">' +
      esc(c.help) +
      '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
      chip(
        isBoard ? 'from the deal board' : 'entered by hand',
        isBoard ? BLUE : MUTED,
        isBoard ? BLUEBG : '#f2f3ef',
      ) +
      (c.notApplicable
        ? chip('not applicable', MUTED, '#f4f5f2')
        : c.pushedMinor
          ? chip('on the invoice', GREEN, '#eef6f0')
          : c.appliedMinor
            ? chip('on the proposal', AMBER, '#fdf6e6')
            : c.stagedMinor
              ? chip('entered', AMBER, '#fdf6e6')
              : c.outstanding
                ? chip('outstanding', RED, '#fbecea')
                : chip('nothing to do', MUTED, '#f2f3ef')) +
      '</div>' +
      '</div>';

    if (c.notApplicable) {
      return card(
        tone,
        toneBg,
        head +
          '<div style="margin-top:10px;font-size:12.5px;color:' +
          MUTED +
          ';">' +
          'Recorded as not applicable: \u201c' +
          esc(c.notApplicableReason || '') +
          '\u201d' +
          '</div>',
      );
    }

    var body = entriesHtml(c, writeable);

    if (!writeable) return card(tone, toneBg, head + body);

    if (isBoard) {
      var figure = bucket === 'STEEL' ? board.steelMinor : board.matsMinor;
      var hasFigure = figure != null && figure !== undefined;
      var onBoard =
        (board.updated || []).filter(function (u) {
          return u.bucket === bucket;
        }).length > 0;
      body +=
        '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed ' +
        LINE +
        ';">' +
        '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">' +
        '<div style="font-size:13px;">' +
        (onBoard
          ? 'The board says <b style="font-variant-numeric:tabular-nums;">' +
            money(figure) +
            '</b>, read into the entry below.'
          : hasFigure
            ? 'The board says <b style="font-variant-numeric:tabular-nums;">' +
              money(figure) +
              '</b>.'
            : 'The board has no figure for this yet.') +
        '</div>' +
        '<button type="button" class="ftuRefresh" style="' +
        BTN_PLAIN +
        'padding:7px 12px;font-size:12.5px;">Refresh from the board</button>' +
        (d.manual
          ? ''
          : '<button type="button" class="ftuManual" data-bucket="' +
            bucket +
            '" style="' +
            BTN_LINK +
            '">Enter it by hand instead\u2026</button>') +
        '</div>' +
        (d.manual ? manualFormHtml(bucket, c, d, true) : '') +
        '</div>';
    } else {
      body +=
        '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed ' +
        LINE +
        ';">' +
        manualFormHtml(bucket, c, d, false) +
        '</div>';
    }

    body +=
      '<div style="margin-top:10px;">' +
      '<button type="button" class="ftuNoFreight" data-bucket="' +
      bucket +
      '" style="' +
      BTN_LINK +
      'color:' +
      MUTED +
      ';">' +
      'No ' +
      esc(c.short.toLowerCase()) +
      ' freight applies to this job\u2026</button>' +
      '</div>';

    return card(tone, toneBg, head + body);
  }

  function card(tone, bg, inner) {
    return (
      '<div style="background:' +
      bg +
      ';border:1px solid ' +
      tone +
      '33;border-left:3px solid ' +
      tone +
      ';border-radius:12px;padding:14px 16px;">' +
      inner +
      '</div>'
    );
  }

  function entriesHtml(c, writeable) {
    if (!c.entries.length) return '';
    return (
      '<div style="margin-top:11px;display:grid;gap:7px;">' +
      c.entries
        .filter(function (e) {
          return e.status !== 'VOID';
        })
        .map(function (e) {
          var where =
            e.scope === 'LINES'
              ? (e.allocations || []).length +
                ' item' +
                ((e.allocations || []).length === 1 ? '' : 's')
              : 'whole job';
          var badge =
            e.status === 'PUSHED'
              ? chip('billed', GREEN, '#eef6f0')
              : e.status === 'APPLIED'
                ? chip('on the proposal', AMBER, '#fdf6e6')
                : chip('entered', MUTED, '#f2f3ef');
          var evidence = [];
          if (e.vendorName) evidence.push(e.vendorName);
          if (e.vendorQuoteRef) evidence.push('quote ' + e.vendorQuoteRef);
          if (e.description) evidence.push(e.description);
          if (e.source === 'MONDAY')
            evidence.push('board column ' + (e.mondayColumnId || '\u2014'));
          if (e.overrideReason) evidence.push('typed in by hand: ' + e.overrideReason);
          if (e.qboDocNumber) evidence.push('invoice ' + e.qboDocNumber);
          return (
            '<div style="background:#fff;border:1px solid ' +
            LINE +
            ';border-radius:9px;padding:9px 12px;">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;">' +
            '<div style="font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;">' +
            money(e.amountMinor) +
            '<span class="muted" style="font-weight:400;font-size:12px;"> \u00b7 ' +
            esc(where) +
            '</span></div>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
            badge +
            (writeable && e.status === 'STAGED'
              ? '<button type="button" class="ftuDropEntry" data-id="' +
                esc(e.id) +
                '" ' +
                'style="' +
                BTN_LINK +
                'color:' +
                MUTED +
                ';">Remove</button>'
              : '') +
            '</div>' +
            '</div>' +
            (evidence.length
              ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' +
                esc(evidence.join(' \u00b7 ')) +
                '</div>'
              : '') +
            (e.scope === 'LINES' && (e.allocations || []).length
              ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">' +
                e.allocations
                  .map(function (a) {
                    return esc(a.name || a.ref) + ' ' + money(a.amountMinor);
                  })
                  .join(' \u00b7 ') +
                '</div>'
              : '') +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  /**
   * The entry form for one bucket.
   *
   * `isOverride` means this bucket normally comes off the board, so the reason field
   * appears and is required. That is not ceremony: a hand-typed steel figure that
   * quietly disagrees with the board is the exact failure this feature exists to
   * prevent, and the reason is what lets somebody reconcile it later.
   */
  function manualFormHtml(bucket, c, d, isOverride) {
    var scopes = c.scopes || ['JOB'];
    var scope = scopes.indexOf(d.scope) === -1 ? scopes[0] : d.scope;
    var needsItems = scope === 'LINES';

    return (
      '<div style="margin-top:11px;display:grid;gap:11px;">' +
      (scopes.length > 1
        ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<span style="' +
          LABEL +
          'margin:0;">This amount covers</span>' +
          scopes
            .map(function (sc) {
              var on = sc === scope;
              return (
                '<button type="button" class="ftuScope" data-bucket="' +
                bucket +
                '" data-scope="' +
                sc +
                '" ' +
                'style="padding:6px 12px;border:1px solid ' +
                (on ? INK : '#dcded7') +
                ';border-radius:999px;' +
                'background:' +
                (on ? INK : '#fff') +
                ';color:' +
                (on ? '#fff' : INK) +
                ';font-size:12.5px;cursor:pointer;">' +
                (sc === 'JOB' ? 'the whole job' : 'chosen items') +
                '</button>'
              );
            })
            .join('') +
          '</div>'
        : '') +
      (needsItems ? itemPickerHtml(bucket, d) : '') +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">' +
      '<label><span style="' +
      LABEL +
      '">Amount</span>' +
      '<input class="ftuAmount" data-bucket="' +
      bucket +
      '" placeholder="0.00" style="' +
      INPUT +
      '"></label>' +
      '<label style="flex:1 1 180px;min-width:150px;"><span style="' +
      LABEL +
      '">Vendor</span>' +
      '<input class="ftuVendor" data-bucket="' +
      bucket +
      '" placeholder="e.g. Southpaw" style="' +
      TEXT +
      '"></label>' +
      '<label style="flex:1 1 180px;min-width:150px;"><span style="' +
      LABEL +
      '">' +
      (isOverride ? 'Quote or BOL reference' : 'Vendor quote reference') +
      '</span>' +
      '<input class="ftuRef" data-bucket="' +
      bucket +
      '" placeholder="quote or BOL number" style="' +
      TEXT +
      '"></label>' +
      '</div>' +
      (bucket === 'OTHER'
        ? '<label><span style="' +
          LABEL +
          '">What is this freight for' +
          (scope === 'JOB' ? ' (required)' : '') +
          '</span>' +
          '<input class="ftuDesc" data-bucket="' +
          bucket +
          '" ' +
          'placeholder="e.g. Redelivery after the site was not ready" style="' +
          TEXT +
          '"></label>'
        : '') +
      (isOverride
        ? '<label><span style="' +
          LABEL +
          '">Why is this being typed in rather than read from the board (required)</span>' +
          '<input class="ftuReason" data-bucket="' +
          bucket +
          '" ' +
          'placeholder="e.g. Board column not filled; figure from the carrier\u2019s emailed quote" style="' +
          TEXT +
          '"></label>'
        : '') +
      '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;">' +
      '<button type="button" class="ftuSave" data-bucket="' +
      bucket +
      '" style="' +
      BTN_DARK +
      'padding:8px 15px;font-size:13px;">' +
      'Save this amount</button>' +
      '<span class="ftuSaveNote muted" data-bucket="' +
      bucket +
      '" style="font-size:12px;"></span>' +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;line-height:1.6;">' +
      (isOverride
        ? 'Saved by hand it is kept as an override, with the reason, next to whatever the board says.'
        : 'An amount cannot be saved without a quote reference \u2014 a freight figure has to be traceable to the vendor who gave it.') +
      '</div>' +
      '</div>'
    );
  }

  /**
   * The item picker.
   *
   * One amount over a selection, split pro-rata on extended price. The split is shown
   * live because a coordinator entering $1,840 over three items is entitled to see
   * what each item is about to be charged before it reaches a customer's invoice.
   */
  function itemPickerHtml(bucket, d) {
    var lines = st.state.lines || [];
    if (!lines.length) {
      return '<div class="muted" style="font-size:12.5px;">This proposal has no product items, so freight can only be entered for the whole job.</div>';
    }
    var chosen = lines.filter(function (l) {
      return d.refs[l.ref];
    });
    var amount = toMinor(d.amount);
    var split = amount && chosen.length ? previewSplit(amount, chosen) : null;

    return (
      '<div style="border:1px solid ' +
      LINE +
      ';border-radius:10px;background:#fff;overflow:hidden;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 12px;background:' +
      SURFACE +
      ';">' +
      '<span style="' +
      LABEL +
      'margin:0;">Which items is this freight for</span>' +
      '<span style="display:flex;gap:8px;">' +
      '<button type="button" class="ftuPickAll" data-bucket="' +
      bucket +
      '" style="' +
      BTN_LINK +
      'font-size:12px;">' +
      'All with vendor freight</button>' +
      '<button type="button" class="ftuPickNone" data-bucket="' +
      bucket +
      '" style="' +
      BTN_LINK +
      'font-size:12px;color:' +
      MUTED +
      ';">' +
      'Clear</button>' +
      '</span>' +
      '</div>' +
      '<div style="max-height:230px;overflow:auto;">' +
      lines
        .map(function (l, i) {
          var on = !!d.refs[l.ref];
          var alloc = split ? split[l.ref] : null;
          return (
            '<label style="display:flex;gap:10px;align-items:center;padding:8px 12px;cursor:pointer;' +
            (i ? 'border-top:1px solid #f2f3ef;' : '') +
            (on ? 'background:#f6faf7;' : '') +
            '">' +
            '<input type="checkbox" class="ftuPick" data-bucket="' +
            bucket +
            '" data-ref="' +
            esc(l.ref) +
            '"' +
            (on ? ' checked' : '') +
            ' style="width:16px;height:16px;flex:none;">' +
            '<span style="min-width:0;flex:1;">' +
            '<span style="font-size:13px;">' +
            esc(l.name) +
            '</span>' +
            '<span class="muted" style="display:block;font-size:11.5px;">' +
            esc(l.sku || '\u2014') +
            (l.vendor ? ' \u00b7 ' + esc(l.vendor) : '') +
            (l.quantity ? ' \u00b7 qty ' + l.quantity : '') +
            (l.currentMinor ? ' \u00b7 ' + money(l.currentMinor) + ' freight already' : '') +
            '</span>' +
            '</span>' +
            '<span style="text-align:right;white-space:nowrap;font-size:12.5px;font-variant-numeric:tabular-nums;">' +
            money(l.extendedMinor) +
            (alloc != null
              ? '<span style="display:block;color:' +
                GREEN +
                ';font-weight:600;">+ ' +
                money(alloc) +
                '</span>'
              : '') +
            '</span>' +
            '</label>'
          );
        })
        .join('') +
      '</div>' +
      '<div class="muted" style="padding:8px 12px;font-size:11.5px;border-top:1px solid ' +
      LINE +
      ';">' +
      (chosen.length
        ? chosen.length +
          ' item' +
          (chosen.length === 1 ? '' : 's') +
          ' chosen' +
          (split ? ' \u00b7 split pro-rata on price' : ' \u00b7 enter an amount to see the split')
        : 'Nothing chosen yet.') +
      '</div>' +
      '</div>'
    );
  }

  /**
   * The same largest-remainder split the server does, so the screen and the record
   * agree. Duplicated on purpose: a preview that guesses differently from the write
   * is worse than no preview.
   */
  function previewSplit(total, lines) {
    var weights = lines.map(function (l) {
      return Math.max(0, Math.round(l.extendedMinor || 0));
    });
    var sum = weights.reduce(function (a, b) {
      return a + b;
    }, 0);
    var basis =
      sum > 0
        ? weights
        : lines.map(function () {
            return 1;
          });
    var basisSum = basis.reduce(function (a, b) {
      return a + b;
    }, 0);
    var exact = basis.map(function (w) {
      return (total * w) / basisSum;
    });
    var floors = exact.map(function (v) {
      return Math.floor(v);
    });
    var left =
      total -
      floors.reduce(function (a, b) {
        return a + b;
      }, 0);
    exact
      .map(function (v, i) {
        return { i: i, frac: v - Math.floor(v), w: basis[i] };
      })
      .sort(function (a, b) {
        return b.frac - a.frac || b.w - a.w || a.i - b.i;
      })
      .forEach(function (o) {
        if (left > 0) {
          floors[o.i] += 1;
          left -= 1;
        }
      });
    var out = {};
    lines.forEach(function (l, i) {
      out[l.ref] = floors[i];
    });
    return out;
  }

  /* ─────────────────────────── footer ─────────────────────────── */

  function footerHtml(s, writeable) {
    var staged = 0,
      applied = 0;
    s.buckets.forEach(function (c) {
      staged += c.stagedMinor;
      applied += c.appliedMinor - c.pushedMinor;
    });
    var live = s.live;
    var bits = [];

    if (staged > 0) {
      bits.push(
        '<button type="button" id="ftuApply" style="' +
          BTN_DARK +
          '">' +
          'Apply ' +
          money(staged) +
          ' to the proposal</button>',
      );
    }
    if (applied > 0 && can(st.user, PUSH_ROLES)) {
      bits.push(
        '<button type="button" id="ftuPush" style="' +
          BTN_DARK +
          'background:' +
          RED +
          ';">' +
          'Add ' +
          money(applied) +
          ' to the invoice</button>',
      );
    }
    if (live && live.status === 'APPLIED' && !live.customerNotifiedAt) {
      bits.push(
        '<button type="button" id="ftuNotified" data-id="' +
          esc(live.id) +
          '" style="' +
          BTN_PLAIN +
          '">' +
          'Revised total sent to the customer</button>',
      );
    }
    if (!bits.length && !staged && !applied) {
      return (
        '<div class="muted" style="margin-top:14px;font-size:12.5px;">' +
        'Nothing is waiting to be applied or billed on this job.</div>'
      );
    }

    return (
      '<div style="margin-top:16px;padding-top:14px;border-top:1px solid ' +
      LINE +
      ';">' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">' +
      bits.join('') +
      '</div>' +
      (applied > 0
        ? '<div class="muted" style="font-size:12px;margin-top:9px;max-width:620px;line-height:1.6;">' +
          money(applied) +
          ' of freight is on the proposal and not on the customer\u2019s invoice. ' +
          'Billing it appends to the existing invoice if nothing has been paid, or raises a freight-only ' +
          'invoice if a payment has landed \u2014 you confirm the before and after totals either way.</div>'
        : '') +
      (live && live.status === 'APPLIED' && !live.customerNotifiedAt
        ? '<div style="font-size:12px;margin-top:9px;color:' +
          AMBER +
          ';">' +
          'The customer holds a document with the old total and has not been told. Nothing is emailed automatically.</div>'
        : '') +
      '</div>'
    );
  }

  function historyHtml(s) {
    var rows = [];
    (s.buckets || []).forEach(function (c) {
      (c.entries || []).forEach(function (e) {
        if (e.status === 'APPLIED' || e.status === 'PUSHED' || e.status === 'VOID')
          rows.push({ c: c, e: e });
      });
    });
    if (!rows.length) return '';
    rows.sort(function (a, b) {
      return String(b.e.createdAt).localeCompare(String(a.e.createdAt));
    });
    return (
      '<div style="margin-top:16px;">' +
      '<div style="font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' +
      MUTED +
      ';margin-bottom:7px;">' +
      'Freight history</div>' +
      '<div style="border:1px solid ' +
      LINE +
      ';border-radius:11px;overflow:hidden;background:#fff;">' +
      foldRows(
        rows.map(function (r, i) {
          var e = r.e;
          var what =
            e.status === 'VOID'
              ? 'recorded as not applicable \u2014 \u201c' + esc(e.voidReason || '') + '\u201d'
              : e.status === 'PUSHED'
                ? 'billed on invoice ' +
                  esc(e.qboDocNumber || '\u2014') +
                  (e.qboMode === 'SUPPLEMENT' ? ' (freight-only invoice)' : '')
                : 'applied to the proposal';
          return (
            '<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 13px;font-size:12.5px;' +
            (i ? 'border-top:1px solid #f2f3ef;' : '') +
            '">' +
            '<span style="min-width:0;"><b>' +
            esc(r.c.short) +
            '</b> ' +
            (e.amountMinor ? money(e.amountMinor) + ' \u00b7 ' : '') +
            what +
            '</span>' +
            '<span class="muted" style="white-space:nowrap;">' +
            esc(H.fmtDate(e.qboPushedAt || e.appliedAt || e.createdAt)) +
            '</span>' +
            '</div>'
          );
        }),
        6,
        LINE,
        MUTED,
      ) +
      '</div></div>'
    );
  }

  /* ─────────────────────────── wiring ─────────────────────────── */

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }
  function draftOf(node) {
    var b = node.getAttribute('data-bucket');
    return st.draft[b] || (st.draft[b] = { scope: 'JOB', refs: {}, manual: false });
  }
  function noteFor(bucket, text, bad) {
    each('.ftuSaveNote[data-bucket="' + bucket + '"]', function (n) {
      n.textContent = text || '';
      n.style.color = bad ? RED : MUTED;
    });
  }

  function bindPanel() {
    var toggle = el('ftuItemsToggle');
    if (toggle)
      toggle.addEventListener('click', function () {
        st.showItems.all = !st.showItems.all;
        render();
      });

    each('.ftuScope', function (b) {
      b.addEventListener('click', function () {
        draftOf(b).scope = b.getAttribute('data-scope');
        render();
      });
    });

    each('.ftuManual', function (b) {
      b.addEventListener('click', function () {
        draftOf(b).manual = true;
        render();
      });
    });

    each('.ftuPick', function (input) {
      input.addEventListener('change', function () {
        var d = draftOf(input);
        var ref = input.getAttribute('data-ref');
        if (input.checked) d.refs[ref] = true;
        else delete d.refs[ref];
        render();
      });
    });
    each('.ftuPickAll', function (b) {
      b.addEventListener('click', function () {
        var d = draftOf(b);
        (st.state.lines || []).forEach(function (l) {
          if (l.freightQuoted) d.refs[l.ref] = true;
        });
        render();
      });
    });
    each('.ftuPickNone', function (b) {
      b.addEventListener('click', function () {
        draftOf(b).refs = {};
        render();
      });
    });

    // The amount is held in the draft so the live split survives a repaint.
    each('.ftuAmount', function (input) {
      var d = draftOf(input);
      input.value = d.amount || '';
      input.addEventListener('input', function () {
        d.amount = input.value;
        if (d.scope === 'LINES') {
          var pos = input.selectionStart;
          render();
          var again = document.querySelector(
            '.ftuAmount[data-bucket="' + input.getAttribute('data-bucket') + '"]',
          );
          if (again) {
            again.focus();
            try {
              again.setSelectionRange(pos, pos);
            } catch (e) {}
          }
        }
      });
    });
    ['ftuVendor', 'ftuRef', 'ftuDesc', 'ftuReason'].forEach(function (cls) {
      each('.' + cls, function (input) {
        var d = draftOf(input);
        var key = cls.replace('ftu', '').toLowerCase();
        input.value = d[key] || '';
        input.addEventListener('input', function () {
          d[key] = input.value;
        });
      });
    });

    each('.ftuSave', function (b) {
      b.addEventListener('click', function () {
        saveBucket(b.getAttribute('data-bucket'), b);
      });
    });
    each('.ftuRefresh', function (b) {
      b.addEventListener('click', function () {
        refreshBoard(b);
      });
    });
    each('.ftuDropEntry', function (b) {
      b.addEventListener('click', function () {
        dropEntry(b.getAttribute('data-id'));
      });
    });
    each('.ftuNoFreight', function (b) {
      b.addEventListener('click', function () {
        noFreightDialog(b.getAttribute('data-bucket'));
      });
    });

    var apply = el('ftuApply');
    if (apply) apply.addEventListener('click', applyDialog);
    var push = el('ftuPush');
    if (push) push.addEventListener('click', pushDialog);
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
        await reload({ sync: false });
      });
  }

  async function refreshBoard(button) {
    button.disabled = true;
    button.textContent = 'Reading the board\u2026';
    var r = await H.authed(
      '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-refresh',
      { method: 'POST' },
    );
    if (!r.ok) {
      button.disabled = false;
      button.textContent = 'Refresh from the board';
      return;
    }
    await reload({ sync: false });
  }

  async function saveBucket(bucket, button) {
    var d = st.draft[bucket] || {};
    var c = bucketOf(st.state, bucket);
    var amount = toMinor(d.amount);
    if (amount == null) return noteFor(bucket, 'Enter an amount first.', true);
    if (isNaN(amount))
      return noteFor(bucket, 'Enter the amount as plain dollars \u2014 275 or 275.00.', true);

    var scope = c.scopes.indexOf(d.scope) === -1 ? c.scopes[0] : d.scope;
    var refs = Object.keys(d.refs || {});
    if (scope === 'LINES' && !refs.length)
      return noteFor(bucket, 'Pick the items this freight is for.', true);

    var payload = {
      bucket: bucket,
      scope: scope,
      amountMinor: amount,
      lineRefs: scope === 'LINES' ? refs : undefined,
      vendorName: d.vendor || null,
      vendorQuoteRef: d.ref || null,
      description: d.desc || null,
      overrideReason: d.reason || null,
    };

    button.disabled = true;
    noteFor(bucket, 'Saving\u2026');
    try {
      var r = await H.authed(
        '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-entries',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) {
        noteFor(bucket, await errorText(r), true);
        button.disabled = false;
        return;
      }
      st.draft[bucket] = { scope: scope, refs: {}, manual: d.manual };
      await reload({ sync: false });
    } catch (e) {
      noteFor(bucket, String(e.message || e), true);
      button.disabled = false;
    }
  }

  async function dropEntry(id) {
    var r = await H.authed('/freight-entries/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.ok) await reload({ sync: false });
  }

  function noFreightDialog(bucket) {
    var c = bucketOf(st.state, bucket);
    H.openModal(
      'No ' + c.short.toLowerCase() + ' freight on this job',
      '<p style="font-size:13.5px;line-height:1.6;">This closes out <b>' +
        esc(c.label) +
        '</b> so it stops being ' +
        'reported as outstanding. It is kept on the record with your name against it, because "no freight applies" ' +
        'is the answer that most resembles a job somebody forgot.</p>' +
        '<label style="display:block;margin-top:12px;"><span style="' +
        LABEL +
        '">Why does none apply</span>' +
        '<input id="ftuNoReason" placeholder="e.g. Resilite ships this order freight-included" style="' +
        TEXT +
        '"></label>',
      async function (close, showErr) {
        var reason = (el('ftuNoReason') || {}).value || '';
        if (reason.trim().length < 5) return showErr('One line is enough, but it cannot be blank.');
        var r = await H.authed(
          '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-not-applicable',
          {
            method: 'POST',
            body: JSON.stringify({ bucket: bucket, reason: reason }),
          },
        );
        if (!r.ok) return showErr(await errorText(r));
        close();
        await reload({ sync: false });
      },
      'Record it',
    );
  }

  function applyDialog() {
    var s = st.state;
    var staged = [];
    s.buckets.forEach(function (c) {
      (c.entries || []).forEach(function (e) {
        if (e.status === 'STAGED') staged.push({ c: c, e: e });
      });
    });
    var total = staged.reduce(function (a, x) {
      return a + x.e.amountMinor;
    }, 0);

    H.openModal(
      'Apply freight to ' + s.number,
      '<p style="font-size:13.5px;line-height:1.6;">This writes the freight onto the frozen version. The line items, ' +
        'the discount and the tax stay exactly as the customer received them \u2014 the amendment is refused if any of ' +
        'them moves by a cent.</p>' +
        '<div style="margin-top:12px;border:1px solid ' +
        LINE +
        ';border-radius:10px;overflow:hidden;">' +
        staged
          .map(function (x, i) {
            return (
              '<div style="display:flex;justify-content:space-between;gap:10px;padding:9px 12px;font-size:13px;' +
              (i ? 'border-top:1px solid #f2f3ef;' : '') +
              '">' +
              '<span>' +
              esc(x.c.label) +
              '<span class="muted"> \u00b7 ' +
              (x.e.scope === 'LINES' ? (x.e.allocations || []).length + ' items' : 'whole job') +
              '</span></span>' +
              '<b style="font-variant-numeric:tabular-nums;">' +
              money(x.e.amountMinor) +
              '</b>' +
              '</div>'
            );
          })
          .join('') +
        '<div style="display:flex;justify-content:space-between;gap:10px;padding:10px 12px;background:' +
        SURFACE +
        ';border-top:1px solid ' +
        LINE +
        ';font-size:13.5px;font-weight:600;">' +
        '<span>Proposal total after</span>' +
        '<span style="font-variant-numeric:tabular-nums;">' +
        money(s.totals.totalMinor + total) +
        '</span>' +
        '</div></div>' +
        '<p class="muted" style="font-size:12px;margin-top:11px;line-height:1.6;">The deposit is recomputed on the new ' +
        'total. If a deposit invoice has already gone out at the old figure, the order will show a higher deposit due ' +
        'than was billed.</p>',
      async function (close, showErr) {
        var r = await H.authed(
          '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-apply',
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) return showErr(await errorText(r));
        close();
        await reload({ sync: false });
      },
      'Apply ' + money(total),
    );
  }

  /**
   * Billing a batch.
   *
   * The preview is read live from QuickBooks and its two totals are sent back with
   * the push: if the invoice moved in between — a payment landed, someone edited it —
   * nothing is sent and the new figures are shown. This is the one operation in the
   * application that changes what a customer owes after they have been told.
   */
  function pushDialog() {
    var body =
      '<div id="ftuPreview" class="muted" style="font-size:13px;padding:8px 0;">Reading the invoice from QuickBooks\u2026</div>';

    H.openModal(
      'Add freight to the invoice',
      body,
      async function (close, showErr) {
        var p = pushDialog.preview;
        if (!p) return showErr('The invoice has not been read yet.');
        var r = await H.authed(
          '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-qbo-push',
          {
            method: 'POST',
            body: JSON.stringify({
              entryIds: p.entryIds,
              expectedCurrentTotalMinor: p.invoice.currentTotalMinor,
              expectedNewTotalMinor: p.newTotalMinor,
            }),
          },
        );
        if (!r.ok) return showErr(await errorText(r));
        close();
        await reload({ sync: false });
      },
      'Send to QuickBooks',
    );

    (async function () {
      var r = await H.authed(
        '/proposals/versions/' + encodeURIComponent(st.vid) + '/freight-qbo-preview',
      );
      var box = el('ftuPreview');
      if (!box) return;
      if (!r.ok) {
        pushDialog.preview = null;
        box.innerHTML = '<div class="err">' + esc(await errorText(r)) + '</div>';
        return;
      }
      var p = await r.json();
      pushDialog.preview = p;
      box.innerHTML =
        '<div style="font-size:13.5px;line-height:1.6;">' +
        esc(p.reason) +
        '</div>' +
        '<div style="margin-top:12px;border:1px solid ' +
        LINE +
        ';border-radius:10px;overflow:hidden;">' +
        p.freight
          .map(function (f, i) {
            return (
              '<div style="display:flex;justify-content:space-between;gap:10px;padding:9px 12px;font-size:13px;' +
              (i ? 'border-top:1px solid #f2f3ef;' : '') +
              '">' +
              '<span>' +
              esc(f.label) +
              (f.reference
                ? '<span class="muted"> \u00b7 quote ' + esc(f.reference) + '</span>'
                : '') +
              '</span>' +
              '<b style="font-variant-numeric:tabular-nums;">' +
              money(f.amountMinor) +
              '</b>' +
              '</div>'
            );
          })
          .join('') +
        '</div>' +
        '<div style="margin-top:12px;display:grid;gap:5px;font-size:13.5px;">' +
        row('Invoice ' + (p.invoice.docNumber || '\u2014') + ' now', p.formatted.current) +
        row('Freight being added', p.formatted.freight) +
        row(
          p.mode === 'AMEND'
            ? 'That invoice becomes'
            : 'New freight invoice ' + (p.supplementDocNumber || ''),
          p.formatted.next,
          true,
        ) +
        '</div>' +
        (p.warnings || [])
          .map(function (w) {
            return (
              '<div style="margin-top:9px;color:' +
              AMBER +
              ';font-size:12.5px;line-height:1.6;">' +
              esc(w) +
              '</div>'
            );
          })
          .join('');
    })();

    function row(label, value, strong) {
      return (
        '<div style="display:flex;justify-content:space-between;gap:12px;' +
        (strong ? 'font-weight:700;padding-top:5px;border-top:1px solid ' + LINE + ';' : '') +
        '">' +
        '<span>' +
        esc(label) +
        '</span><span style="font-variant-numeric:tabular-nums;">' +
        esc(value) +
        '</span></div>'
      );
    }
  }

  /* ══════════════════════════ exports ══════════════════════════ */

  window.FreightTrueUp = {
    /**
     * Borrow the shell's helpers. Everything this module needs from app.js, named
     * rather than reached for, so the coupling is one object in one place.
     */
    init: function (helpers) {
      H = helpers;
    },
    dashboardSection: dashboardSection,
    bindDashboard: bindDashboard,
    mountBanner: mountBanner,
    refreshBanner: refreshBanner,
    openWorkspace: openWorkspace,
    mountPanel: mountPanel,
  };
})();

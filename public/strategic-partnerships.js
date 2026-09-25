/*
 * Strategic Partnership Proposals.
 *
 * A multi-site partnership proposal for one customer: the rep enters the terms, the
 * server calculates the economics (3-Year Equipment Savings among them), and one
 * button fills the US Letter Canva master and archives the PDF. Nothing is
 * calculated here — every figure on this screen came back from the server.
 *
 * Self-contained the way goals.js is: installs its own nav entry, so app.js needs no
 * edit. Server side: src/routes/strategicPartnership.ts, src/strategicPartnership/.
 */
(function () {
  'use strict';

  var AT = 'ssg_at',
    RT = 'ssg_rt';

  var INK = '#20241f',
    MUTE = '#82877d',
    LINE = '#dcded7',
    HAIR = '#f2f3ef',
    ACCENT = '#3d4a55',
    GREEN = '#3f9d78',
    AMBER = '#c98a1e',
    RED = '#c2452f';

  var STATUS_LABEL = {
    DRAFT: 'Draft',
    READY_TO_GENERATE: 'Ready To Generate',
    CALCULATING: 'Calculating',
    GENERATING_CANVA: 'Generating Canva Proposal',
    READY_FOR_REVIEW: 'Ready For Review',
    APPROVED: 'Approved',
    SENT: 'Sent',
    ERROR: 'Error',
  };
  var STATUS_COLOR = {
    DRAFT: MUTE,
    READY_TO_GENERATE: ACCENT,
    CALCULATING: AMBER,
    GENERATING_CANVA: AMBER,
    READY_FOR_REVIEW: '#2f6fb0',
    APPROVED: GREEN,
    SENT: GREEN,
    ERROR: RED,
  };
  var PHASE_LABEL = {
    ASSETS: 'Uploading images to Canva',
    AUTOFILL_START: 'Filling the Canva master',
    AUTOFILL: 'Canva is building the design',
    EXPORT_START: 'Exporting the PDF',
    EXPORT: 'Canva is exporting the PDF',
    DONE: 'Done',
    FAILED: 'Failed',
  };

  var user = null;
  var installed = false;
  var view = 'list';
  var list = [];
  var listCan = {};
  var current = null;
  var settings = null;
  var canva = null;
  var error = '';
  var notice = '';
  var pollTimer = null;
  var busy = false;

  /* ------------------------------------------------------------------ plumbing */

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var at = localStorage.getItem(AT);
    if (at && !opts.noAuth) headers.Authorization = 'Bearer ' + at;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

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

  async function failureText(res, fallback) {
    try {
      var j = await res.json();
      return j.message || j.error || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Whole dollars from cents, "$86,699" — the form the Canva document prints. */
  function dollars(minor) {
    if (minor == null) return '—';
    return '$' + Math.round(Number(minor) / 100).toLocaleString('en-US');
  }
  /** Dollars and cents from cents, "$86,698.50". */
  function dollarsCents(minor) {
    if (minor == null) return '—';
    return (
      '$' +
      (Number(minor) / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  function hours(h100) {
    if (h100 == null) return '—';
    return (Number(h100) / 100).toLocaleString('en-US') + ' hrs';
  }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  var FIELD =
    'box-sizing:border-box;width:100%;padding:7px 9px;font-size:13px;border:1px solid ' +
    LINE +
    ';border-radius:8px;font-family:inherit;color:' +
    INK +
    ';background:#fff;';
  var CARD =
    'background:#fff;border:1px solid ' +
    LINE +
    ';border-radius:12px;padding:16px 18px;margin-bottom:14px;';

  function btn(label, id, kind, disabled, title) {
    var primary = kind === 'primary';
    var danger = kind === 'danger';
    var bg = primary ? ACCENT : '#fff';
    var fg = primary ? '#fff' : danger ? RED : ACCENT;
    var border = primary ? ACCENT : danger ? RED : LINE;
    return (
      '<button id="' +
      id +
      '"' +
      (disabled ? ' disabled' : '') +
      (title ? ' title="' + esc(title) + '"' : '') +
      ' style="font:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:' +
      (disabled ? 'not-allowed' : 'pointer') +
      ';border:1px solid ' +
      border +
      ';background:' +
      bg +
      ';color:' +
      fg +
      ';opacity:' +
      (disabled ? '0.5' : '1') +
      ';white-space:nowrap;">' +
      esc(label) +
      '</button>'
    );
  }

  function chip(status) {
    var c = STATUS_COLOR[status] || MUTE;
    return (
      '<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:' +
      c +
      ';border:1px solid ' +
      c +
      ';background:#fff;">' +
      esc(STATUS_LABEL[status] || status) +
      '</span>'
    );
  }

  function host() {
    return document.getElementById('view');
  }

  function banner() {
    var out = '';
    if (error)
      out +=
        '<div role="alert" style="' +
        CARD +
        'border-color:' +
        RED +
        ';color:' +
        RED +
        ';">' +
        esc(error) +
        '</div>';
    if (notice)
      out +=
        '<div style="' +
        CARD +
        'border-color:' +
        GREEN +
        ';color:' +
        GREEN +
        ';">' +
        esc(notice) +
        '</div>';
    return out;
  }

  function on(id, ev, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  /* ---------------------------------------------------------------------- nav */

  function install() {
    var nav = document.getElementById('nav');
    if (!nav || document.getElementById('sppNavItem')) return;
    var after = null;
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (b) {
      if (b.getAttribute('data-view') === 'proposals') after = b;
    });
    var item = document.createElement('button');
    item.className = 'nav-item';
    item.id = 'sppNavItem';
    item.setAttribute('data-view', 'strategic-partnerships');
    item.innerHTML = '<span>Strategic Partnerships</span>';
    if (after && after.nextSibling) nav.insertBefore(item, after.nextSibling);
    else nav.appendChild(item);

    nav.addEventListener(
      'click',
      function (e) {
        var hit = e.target.closest && e.target.closest('#sppNavItem');
        if (!hit) {
          stopPolling();
          return;
        }
        e.stopPropagation();
        e.preventDefault();
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
          b.classList.remove('active');
        });
        hit.classList.add('active');
        var t = document.getElementById('viewTitle');
        if (t) t.textContent = 'Strategic Partnership Proposals';
        openList();
      },
      true,
    );
    installed = true;
  }

  /* --------------------------------------------------------------------- list */

  async function openList() {
    stopPolling();
    view = 'list';
    error = '';
    var h = host();
    if (h)
      h.innerHTML =
        '<div style="padding:18px;color:' + MUTE + ';font-size:13px;">Loading&hellip;</div>';
    var r = await authed('/strategic-partnerships');
    if (!r.ok) {
      error = await failureText(r, 'The partnership proposals could not be read.');
      list = [];
    } else {
      var d = await r.json();
      list = d.items || [];
      listCan = d.can || {};
    }
    paintList();
  }

  function paintList() {
    var h = host();
    if (!h) return;
    var rows = list
      .map(function (p) {
        return (
          '<tr data-open="' +
          esc(p.id) +
          '" style="cursor:pointer;border-top:1px solid ' +
          HAIR +
          ';">' +
          '<td style="padding:9px 10px;font-weight:600;">' +
          esc(p.number) +
          '</td><td style="padding:9px 10px;">' +
          esc(p.customerShortName || p.organizationName) +
          '<div style="color:' +
          MUTE +
          ';font-size:12px;">' +
          esc(p.organizationName || '') +
          '</div></td><td style="padding:9px 10px;">' +
          chip(p.status) +
          '</td><td style="padding:9px 10px;text-align:right;">' +
          (p.outputs ? dollars(p.outputs.threeYearEquipmentSavingsMinor) : '—') +
          '</td><td style="padding:9px 10px;color:' +
          MUTE +
          ';font-size:12px;">' +
          esc(when(p.updatedAt)) +
          '</td></tr>'
        );
      })
      .join('');
    h.innerHTML =
      '<div style="max-width:1100px;">' +
      banner() +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;color:' +
      MUTE +
      ';font-size:13px;line-height:1.5;">A partnership proposal for one customer’s rollout: enter the terms, the CRM calculates the economics, and Generate fills the US Letter Canva master.</div>' +
      (listCan.write ? btn('New partnership proposal', 'sppNew', 'primary') : '') +
      btn('Settings', 'sppSettings') +
      '</div>' +
      '<div id="sppNewBox"></div>' +
      '<div style="' +
      CARD +
      'padding:0;overflow:auto;">' +
      '<table style="width:100%;border-collapse:collapse;font-size:13.5px;">' +
      '<thead><tr style="text-align:left;color:' +
      MUTE +
      ';font-size:12px;"><th style="padding:9px 10px;">Number</th><th style="padding:9px 10px;">Customer</th><th style="padding:9px 10px;">Status</th><th style="padding:9px 10px;text-align:right;">3-Year Equipment Savings</th><th style="padding:9px 10px;">Updated</th></tr></thead><tbody>' +
      (rows ||
        '<tr><td colspan="5" style="padding:18px;color:' +
          MUTE +
          ';">No partnership proposals yet.</td></tr>') +
      '</tbody></table></div></div>';
    Array.prototype.forEach.call(h.querySelectorAll('[data-open]'), function (tr) {
      tr.addEventListener('click', function () {
        openDetail(tr.getAttribute('data-open'));
      });
    });
    on('sppNew', 'click', paintNewBox);
    on('sppSettings', 'click', openSettings);
  }

  function paintNewBox() {
    var box = document.getElementById('sppNewBox');
    if (!box) return;
    box.innerHTML =
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:8px;">Which customer is this for?</div>' +
      '<div style="color:' +
      MUTE +
      ';font-size:12.5px;margin-bottom:8px;">Anyone in the CRM, customer or prospect. Search by organization, a contact’s name or email, or a deal name.</div>' +
      '<input id="sppOrgQ" placeholder="Organization, contact, email or deal" style="' +
      FIELD +
      'max-width:420px;"><div id="sppOrgResults" style="margin-top:8px;"></div></div>';
    var t = null;
    on('sppOrgQ', 'input', function (e) {
      clearTimeout(t);
      var q = e.target.value.trim();
      t = setTimeout(function () {
        searchOrgs(q);
      }, 250);
    });
    var q = document.getElementById('sppOrgQ');
    if (q) q.focus();
  }

  async function searchOrgs(q) {
    var out = document.getElementById('sppOrgResults');
    if (!out) return;
    if (!q) {
      out.innerHTML = '';
      return;
    }
    var r = await authed('/strategic-partnerships/organization-search?q=' + encodeURIComponent(q));
    if (!r.ok) {
      out.innerHTML =
        '<div style="color:' + RED + ';">' + esc(await failureText(r, 'Search failed.')) + '</div>';
      return;
    }
    var d = await r.json();
    var items = d.items || [];
    out.innerHTML = items.length
      ? items
          .map(function (o) {
            return (
              '<button data-org="' +
              esc(o.id) +
              '" style="display:block;width:100%;max-width:420px;text-align:left;font:inherit;font-size:13px;padding:8px 10px;margin-bottom:4px;border:1px solid ' +
              LINE +
              ';border-radius:8px;background:#fff;cursor:pointer;">' +
              esc(o.name) +
              // A match on a contact or a deal says so, so the rep can see why an
              // organization they did not type is in the list.
              (o.via
                ? '<span style="display:block;color:' +
                  MUTE +
                  ';font-size:12px;margin-top:2px;">' +
                  (o.via.kind === 'contact' ? 'Contact: ' : 'Deal: ') +
                  esc(o.via.label) +
                  '</span>'
                : '') +
              '</button>'
            );
          })
          .join('')
      : '<div style="color:' +
        MUTE +
        ';font-size:13px;">Nothing in the CRM matches. Check the spelling, or add the organization in CRM first.</div>';
    Array.prototype.forEach.call(out.querySelectorAll('[data-org]'), function (b) {
      b.addEventListener('click', async function () {
        var res = await authed('/strategic-partnerships', {
          method: 'POST',
          body: { organizationId: b.getAttribute('data-org') },
        });
        if (!res.ok) {
          error = await failureText(res, 'The partnership proposal could not be created.');
          paintList();
          return;
        }
        var created = await res.json();
        openDetail(created.id);
      });
    });
  }

  /* ------------------------------------------------------------------- detail */

  /** `message` is a one-time confirmation shown above the refreshed record. */
  async function openDetail(id, message) {
    stopPolling();
    view = 'detail';
    error = '';
    notice = message || '';
    var r = await authed('/strategic-partnerships/' + encodeURIComponent(id));
    if (!r.ok) {
      error = await failureText(r, 'That partnership proposal could not be read.');
      notice = '';
      paintList();
      return;
    }
    current = await r.json();
    paintDetail();
    notice = '';
    schedulePoll();
  }

  function inFlight(p) {
    return p && (p.status === 'GENERATING_CANVA' || p.status === 'CALCULATING');
  }

  function schedulePoll() {
    stopPolling();
    if (!inFlight(current) || view !== 'detail') return;
    pollTimer = setTimeout(async function () {
      if (view !== 'detail' || !current) return;
      var r = await authed(
        '/strategic-partnerships/' + encodeURIComponent(current.id) + '/advance',
        {
          method: 'POST',
        },
      );
      if (r.ok) {
        var d = await r.json();
        var wasRunning = inFlight(current);
        current = Object.assign({}, current, d);
        if (wasRunning && !inFlight(current)) {
          // Re-read for the fresh generation blockers and links.
          return openDetail(current.id);
        }
        paintDetail();
      }
      schedulePoll();
    }, 3500);
  }

  function input(id, label, value, opts) {
    opts = opts || {};
    var disabled = !current.can.write || !editable();
    return (
      '<label style="display:block;font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">' +
      esc(label) +
      (opts.required ? ' <span style="color:' + RED + ';">*</span>' : '') +
      '<input id="' +
      id +
      '" value="' +
      esc(value == null ? '' : value) +
      '"' +
      (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') +
      (opts.inputmode ? ' inputmode="' + opts.inputmode + '"' : '') +
      (disabled ? ' disabled' : '') +
      ' style="' +
      FIELD +
      'margin-top:4px;"></label>'
    );
  }

  function editable() {
    return (
      ['DRAFT', 'READY_TO_GENERATE', 'READY_FOR_REVIEW', 'ERROR'].indexOf(current.status) !== -1
    );
  }

  function metric(label, value, strong) {
    return (
      '<div style="padding:10px 12px;border:1px solid ' +
      (strong ? ACCENT : LINE) +
      ';border-radius:10px;background:' +
      (strong ? '#f4f6f8' : '#fff') +
      ';"><div style="font-size:11.5px;color:' +
      MUTE +
      ';">' +
      esc(label) +
      '</div><div style="font-size:' +
      (strong ? '22px' : '16px') +
      ';font-weight:600;margin-top:2px;">' +
      value +
      '</div></div>'
    );
  }

  function outputsCard(o) {
    if (!o) {
      return (
        '<div style="' +
        CARD +
        '"><div style="font-weight:600;margin-bottom:6px;">Economics</div><div style="color:' +
        MUTE +
        ';font-size:13px;">Calculated by the CRM once the discount, project value, PM hours, PM hourly value and Years 1–3 are entered and saved.</div></div>'
      );
    }
    var grid = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;';
    return (
      '<div style="' +
      CARD +
      '"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;"><div style="font-weight:600;">Economics</div><div style="font-size:11.5px;color:' +
      MUTE +
      ';">Calculated by the CRM ' +
      esc(when(o.calculatedAt)) +
      '</div></div>' +
      '<div style="' +
      grid +
      'margin-bottom:10px;">' +
      metric('3-Year Equipment Savings', dollars(o.threeYearEquipmentSavingsMinor), true) +
      metric('5-Year Equipment Savings', dollars(o.fiveYearEquipmentSavingsMinor), true) +
      '</div><div style="' +
      grid +
      '">' +
      metric('Partner Project Value', dollarsCents(o.partnerProjectValueMinor)) +
      metric('Savings Per Center', dollarsCents(o.savingsPerCenterMinor)) +
      metric('PM Hours Returned / Center', hours(o.pmHoursReturnedPerCenterHundredths)) +
      metric('PM Capacity Value / Center', dollarsCents(o.pmCapacityValuePerCenterMinor)) +
      metric('3-Year PM Capacity Value', dollars(o.threeYearPmCapacityValueMinor)) +
      metric('5-Year PM Capacity Value', dollars(o.fiveYearPmCapacityValueMinor)) +
      metric('3-Year Combined Economic Value', dollars(o.threeYearCombinedValueMinor)) +
      metric('5-Year Combined Economic Value', dollars(o.fiveYearCombinedValueMinor)) +
      metric('3-Year Cumulative Centers', String(o.threeYearCumulativeCenters)) +
      metric('5-Year Cumulative Centers', String(o.fiveYearCumulativeCenters)) +
      '</div></div>'
    );
  }

  function imageSlot(slot, label, file) {
    var canEdit = current.can.write && editable();
    return (
      '<div style="border:1px solid ' +
      LINE +
      ';border-radius:10px;padding:10px;text-align:center;">' +
      '<div style="font-size:12px;color:' +
      MUTE +
      ';margin-bottom:6px;">' +
      esc(label) +
      '</div>' +
      '<div style="height:90px;display:flex;align-items:center;justify-content:center;background:' +
      HAIR +
      ';border-radius:8px;overflow:hidden;">' +
      (file
        ? '<img data-thumb="' +
          slot +
          '" alt="' +
          esc(file.filename) +
          '" style="max-width:100%;max-height:90px;">'
        : '<span style="font-size:12px;color:' + MUTE + ';">None</span>') +
      '</div>' +
      (canEdit
        ? '<div style="margin-top:8px;display:flex;gap:6px;justify-content:center;">' +
          '<label style="font-size:12px;color:' +
          ACCENT +
          ';cursor:pointer;border:1px solid ' +
          LINE +
          ';border-radius:7px;padding:4px 8px;">' +
          (file ? 'Replace' : 'Upload') +
          '<input type="file" accept="image/png,image/jpeg" data-upload="' +
          slot +
          '" style="display:none;"></label>' +
          (file
            ? '<button data-remove="' +
              slot +
              '" style="font:inherit;font-size:12px;color:' +
              RED +
              ';background:#fff;border:1px solid ' +
              LINE +
              ';border-radius:7px;padding:4px 8px;cursor:pointer;">Remove</button>'
            : '') +
          '</div>'
        : '') +
      '</div>'
    );
  }

  function generationCard(p) {
    var g = p.generation;
    var blockers = p.generationBlockers || [];
    var canGenerate =
      p.can.write &&
      ['READY_TO_GENERATE', 'READY_FOR_REVIEW', 'ERROR'].indexOf(p.status) !== -1 &&
      !blockers.length;
    var why = blockers.length ? blockers.join(' ') : '';
    var out =
      '<div style="' +
      CARD +
      '"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">' +
      '<div style="font-weight:600;flex:1;">Proposal document</div>' +
      chip(p.status) +
      '</div>';

    if (inFlight(p)) {
      out +=
        '<div style="font-size:13.5px;margin-bottom:8px;"><span style="color:' +
        AMBER +
        ';font-weight:600;">' +
        esc((g && PHASE_LABEL[g.phase]) || 'Working') +
        '&hellip;</span> <span style="color:' +
        MUTE +
        ';">This page keeps checking; it is safe to leave and come back.</span></div>';
    } else if (p.status !== 'APPROVED' && p.status !== 'SENT') {
      out +=
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">' +
        btn(
          p.status === 'READY_FOR_REVIEW' || p.status === 'ERROR'
            ? 'Regenerate Strategic Partnership Proposal'
            : 'Generate Strategic Partnership Proposal',
          'sppGenerate',
          'primary',
          !canGenerate,
          why,
        ) +
        btn('Preview Canva copy', 'sppPreview', '', !p.outputs) +
        '</div>';
      if (blockers.length) {
        out +=
          '<ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;color:' +
          MUTE +
          ';">' +
          blockers
            .map(function (b) {
              return '<li>' + esc(b) + '</li>';
            })
            .join('') +
          '</ul>';
      }
    }

    if (p.status === 'ERROR' && p.errorMessage) {
      out +=
        '<div role="alert" style="margin-top:8px;padding:9px 11px;border-radius:8px;background:#fbeeeb;color:' +
        RED +
        ';font-size:13px;">' +
        esc(p.errorMessage) +
        '</div>';
    }

    if (p.canvaDesignUrl || p.hasPdf) {
      out +=
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">' +
        (p.canvaDesignUrl
          ? '<a href="' +
            esc(p.canvaDesignUrl) +
            '" target="_blank" rel="noopener" style="font-size:13px;color:' +
            ACCENT +
            ';">Open in Canva</a>'
          : '') +
        (p.hasPdf ? btn('Download PDF', 'sppPdf') : '') +
        (p.generatedAt
          ? '<span style="font-size:12px;color:' +
            MUTE +
            ';align-self:center;">Generated ' +
            esc(when(p.generatedAt)) +
            '</span>'
          : '') +
        '</div>';
    }

    var actions = '';
    if (p.can.review && p.status === 'READY_FOR_REVIEW')
      actions += btn('Approve', 'sppApprove', 'primary');
    if (p.can.write && p.status === 'APPROVED')
      actions += btn('Mark as sent', 'sppSent', 'primary');
    if (p.can.review && ['APPROVED', 'SENT', 'ERROR'].indexOf(p.status) !== -1)
      actions += btn('Reopen', 'sppReopen');
    if (actions) out += '<div style="display:flex;gap:10px;margin-top:12px;">' + actions + '</div>';

    if (g && g.warnings && g.warnings.length) {
      out +=
        '<details style="margin-top:10px;font-size:12.5px;color:' +
        MUTE +
        ';"><summary>Notes from the last run (' +
        g.warnings.length +
        ')</summary><ul style="margin:6px 0 0 18px;padding:0;">' +
        g.warnings
          .map(function (w) {
            return '<li>' + esc(w) + '</li>';
          })
          .join('') +
        '</ul></details>';
    }
    if (g && g.log && g.log.length) {
      out +=
        '<details style="margin-top:6px;font-size:12.5px;color:' +
        MUTE +
        ';"><summary>Run ' +
        esc(g.runId) +
        '</summary><ul style="margin:6px 0 0 18px;padding:0;">' +
        g.log
          .map(function (l) {
            return '<li>' + esc(when(l.at)) + ' — ' + esc(l.message) + '</li>';
          })
          .join('') +
        '</ul></details>';
    }
    return out + '</div>';
  }

  function paintDetail() {
    var h = host();
    if (!h || !current) return;
    var p = current;
    var i = p.inputs;
    var canEdit = p.can.write && editable();
    var two = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 14px;';
    h.innerHTML =
      '<div style="max-width:1100px;">' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">' +
      btn('← All partnership proposals', 'sppBack') +
      '<div style="font-family:\'Newsreader\',serif;font-size:21px;font-weight:600;flex:1;">' +
      esc(p.number) +
      ' · ' +
      esc(i.customerShortName || p.organizationName) +
      '</div></div>' +
      banner() +
      generationCard(p) +
      outputsCard(p.outputs) +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:10px;">Customer</div><div style="' +
      two +
      '">' +
      input('sppShort', 'Customer short name', i.customerShortName, { required: true }) +
      input('sppFull', 'Customer full legal / brand name', i.customerFullName, { required: true }) +
      input('sppExec', 'Executive name', i.executiveName, { required: true }) +
      input('sppTitle', 'Executive title', i.executiveTitle, { required: true }) +
      input('sppIndustry', 'Industry / segment', i.industry, { required: true }) +
      '</div></div>' +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:10px;">Commercial terms</div><div style="' +
      two +
      '">' +
      input('sppDiscount', 'Partner discount (%)', i.partnerDiscountPercent, {
        required: true,
        placeholder: 'Enter the discount, e.g. 17.5',
        inputmode: 'decimal',
      }) +
      input('sppSpv', 'Standard project value ($)', i.standardProjectValue, {
        required: true,
        placeholder: 'Enter the dollar value',
        inputmode: 'decimal',
      }) +
      input('sppHours', 'PM hours returned / center', i.pmHoursReturnedPerCenter, {
        required: true,
        placeholder: 'Enter hours',
        inputmode: 'decimal',
      }) +
      input('sppRate', 'Internal PM hourly value ($)', i.pmHourValue, {
        required: true,
        placeholder: 'Enter dollars per hour',
        inputmode: 'decimal',
      }) +
      input(
        'sppMargin',
        'Contribution margin / productive hour ($, optional)',
        i.contributionMarginPerHour,
        {
          inputmode: 'decimal',
        },
      ) +
      '</div></div>' +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:4px;">Rollout plan</div><div style="font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">Planned new centers per year. Years 4 and 5 are optional; left blank they repeat Year 3.</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:0 12px;">' +
      input('sppY1', 'Year 1', i.year1PlannedCenters, { required: true, inputmode: 'numeric' }) +
      input('sppY2', 'Year 2', i.year2PlannedCenters, { required: true, inputmode: 'numeric' }) +
      input('sppY3', 'Year 3', i.year3PlannedCenters, { required: true, inputmode: 'numeric' }) +
      input('sppY4', 'Year 4', i.year4PlannedCenters, {
        inputmode: 'numeric',
        placeholder: 'as Year 3',
      }) +
      input('sppY5', 'Year 5', i.year5PlannedCenters, {
        inputmode: 'numeric',
        placeholder: 'as Year 3',
      }) +
      '</div>' +
      (canEdit
        ? '<div style="display:flex;gap:10px;align-items:center;">' +
          btn('Save and calculate', 'sppSave', 'primary') +
          (p.missingInputs && p.missingInputs.length
            ? '<span style="font-size:12.5px;color:' +
              MUTE +
              ';">Still needed: ' +
              esc(p.missingInputs.join(', ')) +
              '</span>'
            : '') +
          '</div>'
        : !editable()
          ? '<div style="font-size:12.5px;color:' +
            MUTE +
            ';">' +
            (inFlight(p)
              ? 'Locked while the document is generating.'
              : 'Locked: reopen to change the terms.') +
            '</div>'
          : '') +
      '</div>' +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:4px;">Images</div><div style="font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">PNG or JPEG, up to 3 MB. The logo is required to generate; a project image left empty keeps the Canva master’s own photo.</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;">' +
      imageSlot('logo', 'Customer logo', p.images.customerLogo) +
      p.images.projectImages
        .map(function (f, idx) {
          return imageSlot(String(idx + 1), 'Project image ' + (idx + 1), f);
        })
        .join('') +
      '</div></div>' +
      '<div id="sppCopyBox"></div>' +
      '</div>';

    on('sppBack', 'click', openList);
    on('sppSave', 'click', save);
    on('sppGenerate', 'click', generate);
    on('sppPreview', 'click', previewCopy);
    on('sppPdf', 'click', downloadPdf);
    on('sppApprove', 'click', function () {
      transition('approve', 'Approved.');
    });
    on('sppSent', 'click', function () {
      transition('sent', 'Marked as sent.');
    });
    on('sppReopen', 'click', function () {
      if (
        confirm(
          'Reopen this proposal? Its approval is cleared and the terms become editable again.',
        )
      )
        transition('reopen', 'Reopened.');
    });
    Array.prototype.forEach.call(h.querySelectorAll('[data-upload]'), function (el) {
      el.addEventListener('change', function () {
        upload(el.getAttribute('data-upload'), el.files && el.files[0]);
      });
    });
    Array.prototype.forEach.call(h.querySelectorAll('[data-remove]'), function (el) {
      el.addEventListener('click', function () {
        removeImage(el.getAttribute('data-remove'));
      });
    });
    loadThumbs();
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function centers(id) {
    var v = val(id);
    if (v === '') return null;
    var n = Number(v);
    return Number.isInteger(n) ? n : v;
  }

  async function save() {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    var body = {
      customerShortName: val('sppShort'),
      customerFullName: val('sppFull'),
      executiveName: val('sppExec'),
      executiveTitle: val('sppTitle'),
      industry: val('sppIndustry'),
      partnerDiscountPercent: val('sppDiscount') || null,
      standardProjectValue: val('sppSpv') || null,
      pmHoursReturnedPerCenter: val('sppHours') || null,
      pmHourValue: val('sppRate') || null,
      contributionMarginPerHour: val('sppMargin') || null,
      year1PlannedCenters: centers('sppY1'),
      year2PlannedCenters: centers('sppY2'),
      year3PlannedCenters: centers('sppY3'),
      year4PlannedCenters: centers('sppY4'),
      year5PlannedCenters: centers('sppY5'),
    };
    var r = await authed('/strategic-partnerships/' + encodeURIComponent(current.id), {
      method: 'PATCH',
      body: body,
    });
    busy = false;
    if (!r.ok) {
      error = await failureText(r, 'The terms could not be saved.');
      paintDetail();
      return;
    }
    await openDetail(current.id, 'Saved. The economics were recalculated.');
  }

  async function generate() {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    var btnEl = document.getElementById('sppGenerate');
    if (btnEl) btnEl.disabled = true;
    var r = await authed(
      '/strategic-partnerships/' + encodeURIComponent(current.id) + '/generate',
      {
        method: 'POST',
      },
    );
    busy = false;
    if (!r.ok) {
      error = await failureText(r, 'Generation could not start.');
      paintDetail();
      return;
    }
    current = Object.assign({}, current, await r.json());
    paintDetail();
    schedulePoll();
  }

  async function transition(action, message) {
    error = '';
    var r = await authed(
      '/strategic-partnerships/' + encodeURIComponent(current.id) + '/' + action,
      {
        method: 'POST',
      },
    );
    if (!r.ok) {
      error = await failureText(r, 'That did not work.');
      paintDetail();
      return;
    }
    await openDetail(current.id, message);
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        resolve(String(fr.result));
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function upload(slot, file) {
    if (!file) return;
    error = '';
    if (['image/png', 'image/jpeg'].indexOf(file.type) === -1) {
      error = 'Images must be PNG or JPEG.';
      paintDetail();
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      error = 'Images are limited to 3 MB.';
      paintDetail();
      return;
    }
    var data = await readAsDataUrl(file);
    var r = await authed(
      '/strategic-partnerships/' +
        encodeURIComponent(current.id) +
        '/images/' +
        encodeURIComponent(slot),
      { method: 'POST', body: { filename: file.name, contentType: file.type, base64: data } },
    );
    if (!r.ok) {
      error = await failureText(r, 'The image could not be uploaded.');
      paintDetail();
      return;
    }
    await openDetail(current.id);
  }

  async function removeImage(slot) {
    var r = await authed(
      '/strategic-partnerships/' +
        encodeURIComponent(current.id) +
        '/images/' +
        encodeURIComponent(slot),
      { method: 'DELETE' },
    );
    if (!r.ok) {
      error = await failureText(r, 'The image could not be removed.');
      paintDetail();
      return;
    }
    await openDetail(current.id);
  }

  /** Thumbnails come through the authenticated proxy; the blob store is private. */
  function loadThumbs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-thumb]'), async function (img) {
      var slot = img.getAttribute('data-thumb');
      try {
        var r = await authed(
          '/strategic-partnerships/' +
            encodeURIComponent(current.id) +
            '/images/' +
            encodeURIComponent(slot),
        );
        if (!r.ok) return;
        var blob = await r.blob();
        img.src = await readAsDataUrl(blob);
      } catch (e) {
        /* a missing thumbnail is cosmetic */
      }
    });
  }

  async function downloadPdf() {
    var r = await authed('/strategic-partnerships/' + encodeURIComponent(current.id) + '/pdf');
    if (!r.ok) {
      error = await failureText(r, 'The PDF could not be downloaded.');
      paintDetail();
      return;
    }
    var blob = await r.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download =
      (current.inputs.customerShortName || 'Customer') +
      ' Strategic Partnership Proposal ' +
      current.number +
      '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
  }

  async function previewCopy() {
    var box = document.getElementById('sppCopyBox');
    if (!box) return;
    var r = await authed('/strategic-partnerships/' + encodeURIComponent(current.id) + '/copy');
    if (!r.ok) {
      box.innerHTML =
        '<div style="' +
        CARD +
        'color:' +
        RED +
        ';">' +
        esc(await failureText(r, 'Preview failed.')) +
        '</div>';
      return;
    }
    var d = await r.json();
    var rows = Object.keys(d.textFields)
      .map(function (k) {
        return (
          '<tr style="border-top:1px solid ' +
          HAIR +
          ';"><td style="padding:7px 10px;font-family:monospace;font-size:12px;vertical-align:top;white-space:nowrap;">' +
          esc(k) +
          '</td><td style="padding:7px 10px;white-space:pre-wrap;">' +
          esc(d.textFields[k]) +
          '</td></tr>'
        );
      })
      .join('');
    box.innerHTML =
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:4px;">Canva copy preview</div><div style="font-size:12px;color:' +
      MUTE +
      ';margin-bottom:8px;">Design title: ' +
      esc(d.title) +
      '. The wording is edited in Settings.</div><table style="width:100%;border-collapse:collapse;font-size:13px;">' +
      rows +
      '</table></div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ----------------------------------------------------------------- settings */

  async function openSettings() {
    stopPolling();
    view = 'settings';
    error = '';
    notice = '';
    var r = await authed('/strategic-partnerships/settings');
    if (!r.ok) {
      error = await failureText(r, 'The settings could not be read.');
      paintList();
      return;
    }
    settings = await r.json();
    canva = null;
    if (settings.can && settings.can.manage) {
      var c = await authed('/integrations/canva');
      if (c.ok) canva = await c.json();
    }
    paintSettings();
  }

  function paintSettings() {
    var h = host();
    if (!h || !settings) return;
    var manage = settings.can && settings.can.manage;
    var c = settings.content;
    var dis = manage ? '' : ' disabled';
    var fieldRows = c.fields
      .map(function (f, idx) {
        return (
          '<div data-row="' +
          idx +
          '" style="border-top:1px solid ' +
          HAIR +
          ';padding:10px 0;display:grid;grid-template-columns:minmax(160px,240px) 1fr auto;gap:10px;align-items:start;">' +
          '<input data-fname="' +
          idx +
          '" value="' +
          esc(f.field) +
          '"' +
          dis +
          ' style="' +
          FIELD +
          'font-family:monospace;font-size:12px;">' +
          '<textarea data-ftpl="' +
          idx +
          '" rows="' +
          Math.min(6, Math.max(1, Math.ceil(f.template.length / 90))) +
          '"' +
          dis +
          ' style="' +
          FIELD +
          'resize:vertical;">' +
          esc(f.template) +
          '</textarea>' +
          (manage
            ? '<div style="display:flex;gap:4px;">' +
              '<button data-up="' +
              idx +
              '" title="Move up" style="font:inherit;border:1px solid ' +
              LINE +
              ';background:#fff;border-radius:6px;cursor:pointer;padding:4px 7px;">↑</button>' +
              '<button data-down="' +
              idx +
              '" title="Move down" style="font:inherit;border:1px solid ' +
              LINE +
              ';background:#fff;border-radius:6px;cursor:pointer;padding:4px 7px;">↓</button>' +
              '<button data-del="' +
              idx +
              '" title="Remove" style="font:inherit;border:1px solid ' +
              LINE +
              ';background:#fff;color:' +
              RED +
              ';border-radius:6px;cursor:pointer;padding:4px 7px;">×</button></div>'
            : '<span></span>') +
          '</div>'
        );
      })
      .join('');
    var canvaCard = '';
    if (manage) {
      var cs = canva || {};
      canvaCard =
        '<div style="' +
        CARD +
        '"><div style="font-weight:600;margin-bottom:6px;">Canva connection</div><div style="font-size:13px;margin-bottom:10px;">' +
        (!cs.configured
          ? '<span style="color:' +
            RED +
            ';">Not configured on this deployment.</span> Set CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REDIRECT_URI and CANVA_TOKEN_ENC_KEY.'
          : cs.connected
            ? '<span style="color:' + GREEN + ';">Connected</span> ' + esc(when(cs.connectedAt))
            : '<span style="color:' +
              AMBER +
              ';">Not connected.</span> Connect as the Canva user who owns the brand template.') +
        (cs.lastError
          ? '<div style="color:' +
            RED +
            ';font-size:12.5px;margin-top:4px;">' +
            esc(cs.lastError) +
            '</div>'
          : '') +
        '</div><div style="display:flex;gap:10px;">' +
        (cs.configured
          ? btn(cs.connected ? 'Reconnect Canva' : 'Connect Canva', 'sppCanvaConnect', 'primary')
          : '') +
        (cs.connected ? btn('Disconnect', 'sppCanvaDisconnect', 'danger') : '') +
        '</div></div>';
    }
    h.innerHTML =
      '<div style="max-width:1100px;">' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">' +
      btn('← All partnership proposals', 'sppBack') +
      '<div style="font-family:\'Newsreader\',serif;font-size:21px;font-weight:600;">Strategic Partnership settings</div></div>' +
      banner() +
      canvaCard +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:10px;">Canva master</div>' +
      '<label style="display:block;font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">Brand template ID (the US Letter portrait, 8.5 × 11 in master; Autofill needs a brand template, not a design ID)<input id="sppTpl" value="' +
      esc(settings.brandTemplateId || '') +
      '"' +
      dis +
      ' style="' +
      FIELD +
      'margin-top:4px;max-width:420px;"></label>' +
      '<label style="display:block;font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">Design title<input id="sppTitleTpl" value="' +
      esc(c.titleTemplate) +
      '"' +
      dis +
      ' style="' +
      FIELD +
      'margin-top:4px;"></label>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0 14px;">' +
      '<label style="display:block;font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">Scale scenario centers (comma-separated)<input id="sppScale" value="' +
      esc(c.scaleCenters.join(', ')) +
      '"' +
      dis +
      ' style="' +
      FIELD +
      'margin-top:4px;"></label>' +
      '<label style="display:block;font-size:12px;color:' +
      MUTE +
      ';margin-bottom:10px;">Chart field (blank: the template’s only chart)<input id="sppChart" value="' +
      esc(c.chartField || '') +
      '"' +
      dis +
      ' style="' +
      FIELD +
      'margin-top:4px;"></label></div></div>' +
      '<div style="' +
      CARD +
      '"><div style="font-weight:600;margin-bottom:4px;">Canva text fields</div><div style="font-size:12px;color:' +
      MUTE +
      ';margin-bottom:6px;">Each row fills one text field on the brand template. Every text field on the template needs a row, or generation stops and names the field. Placeholders are listed below.</div>' +
      fieldRows +
      (manage
        ? '<div style="display:flex;gap:10px;margin-top:12px;">' +
          btn('Add field', 'sppAddField') +
          btn('Save settings', 'sppSaveSettings', 'primary') +
          '</div>'
        : '<div style="font-size:12.5px;color:' +
          MUTE +
          ';margin-top:10px;">Only an administrator can change these.</div>') +
      '</div>' +
      '<details style="' +
      CARD +
      '"><summary style="font-weight:600;cursor:pointer;">Placeholders</summary><table style="margin-top:8px;font-size:12.5px;border-collapse:collapse;">' +
      (settings.tokens || [])
        .map(function (t) {
          return (
            '<tr><td style="padding:3px 12px 3px 0;font-family:monospace;">{{' +
            esc(t.token) +
            '}}</td><td style="color:' +
            MUTE +
            ';">' +
            esc(t.description) +
            '</td></tr>'
          );
        })
        .join('') +
      '</table><div style="font-size:12px;color:' +
      MUTE +
      ';margin-top:8px;">Image fields filled from uploads: ' +
      esc((settings.imageFields || []).join(', ')) +
      '.</div></details>' +
      '</div>';

    on('sppBack', 'click', openList);
    if (!manage) return;
    on('sppSaveSettings', 'click', saveSettings);
    on('sppAddField', 'click', function () {
      readSettingsForm();
      settings.content.fields.push({ field: '', template: '' });
      paintSettings();
    });
    on('sppCanvaConnect', 'click', async function () {
      var r = await authed('/integrations/canva/connect', { method: 'POST' });
      if (!r.ok) {
        error = await failureText(r, 'Canva could not be connected.');
        paintSettings();
        return;
      }
      window.location.href = (await r.json()).url;
    });
    on('sppCanvaDisconnect', 'click', async function () {
      if (!confirm('Disconnect Canva? Generation stops until it is connected again.')) return;
      await authed('/integrations/canva', { method: 'DELETE' });
      openSettings();
    });
    function move(idx, delta) {
      readSettingsForm();
      var f = settings.content.fields;
      var j = idx + delta;
      if (j < 0 || j >= f.length) return;
      var t = f[idx];
      f[idx] = f[j];
      f[j] = t;
      paintSettings();
    }
    Array.prototype.forEach.call(h.querySelectorAll('[data-up]'), function (b) {
      b.addEventListener('click', function () {
        move(Number(b.getAttribute('data-up')), -1);
      });
    });
    Array.prototype.forEach.call(h.querySelectorAll('[data-down]'), function (b) {
      b.addEventListener('click', function () {
        move(Number(b.getAttribute('data-down')), 1);
      });
    });
    Array.prototype.forEach.call(h.querySelectorAll('[data-del]'), function (b) {
      b.addEventListener('click', function () {
        readSettingsForm();
        settings.content.fields.splice(Number(b.getAttribute('data-del')), 1);
        paintSettings();
      });
    });
  }

  function readSettingsForm() {
    var c = settings.content;
    settings.brandTemplateId = val('sppTpl');
    c.titleTemplate = val('sppTitleTpl');
    c.chartField = val('sppChart') || null;
    var scale = val('sppScale');
    c.scaleCenters = scale
      .split(',')
      .map(function (s) {
        return Number(s.trim());
      })
      .filter(function (n) {
        return n > 0;
      });
    c.fields = c.fields.map(function (f, idx) {
      var n = document.querySelector('[data-fname="' + idx + '"]');
      var t = document.querySelector('[data-ftpl="' + idx + '"]');
      return { field: n ? n.value.trim() : f.field, template: t ? t.value : f.template };
    });
  }

  async function saveSettings() {
    readSettingsForm();
    error = '';
    notice = '';
    var r = await authed('/strategic-partnerships/settings', {
      method: 'PUT',
      body: {
        brandTemplateId: settings.brandTemplateId || null,
        content: settings.content,
      },
    });
    if (!r.ok) {
      error = await failureText(r, 'The settings could not be saved.');
      paintSettings();
      return;
    }
    var keepCan = settings.can;
    settings = await r.json();
    settings.can = settings.can || keepCan;
    notice = 'Settings saved.';
    paintSettings();
    notice = '';
  }

  /* --------------------------------------------------------------------- boot */

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

  window.SSGStrategicPartnerships = {
    open: openList,
    install: install,
    user: function () {
      return user;
    },
  };
})();

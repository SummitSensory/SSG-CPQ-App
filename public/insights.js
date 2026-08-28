/*
 * Insights: signed deals, and a report builder.
 *
 * Two questions this screen exists to answer:
 *
 *   1. How many deals have we signed, and for how much? Four milestones —
 *      accepted, ordered, first payment, paid in full — because the gaps between
 *      them are where the month is won or lost.
 *   2. Anything else, without waiting for someone to write a report. Group by up to
 *      three things, filter on a dozen, pick the numbers, sort any column, download
 *      it, save it, have it emailed.
 *
 * Self-contained on purpose, the same way accounts-receivable.js is: it installs its
 * own nav entry and carries its own copy of the auth helpers, so app.js needs no
 * edit. If this file fails to load, the tab is simply absent.
 *
 * Server side: src/routes/insights.ts, src/reporting/*.
 */
(function () {
  'use strict';

  var AT = 'ssg_at',
    RT = 'ssg_rt';

  /* The workspace palette. Nothing new — this has to look like it was always here. */
  var INK = '#20241f',
    MUTE = '#82877d',
    SOFT = '#5c6357',
    LINE = '#dcded7',
    HAIR = '#f2f3ef',
    NAVY = '#203060',
    ACCENT = '#3d4a55',
    AMBER = '#b7873a',
    RED = '#c2452f';

  var VIEW_ROLES = [
    'SYSTEM_ADMIN',
    'EXECUTIVE',
    'SALES_MANAGER',
    'SALES_REP',
    'ACCOUNTING',
    'OPERATIONS',
    'PROJECT_MANAGER',
    'ESTIMATOR',
    'DESIGNER',
    'READ_ONLY',
  ];

  var user = null;
  var installed = false;
  var tab = 'signed';
  var busy = false;

  /* Signed-deals state. */
  var sd = { data: null, milestone: 'ACCEPTED', months: 12, error: '' };

  /* Report-builder state. The definition IS the report — it is what gets posted,
   * saved, scheduled and turned into a goal, so there is one shape of it. */
  var vocab = null;
  var saved = [];
  var def = null;
  var result = null;
  var runError = '';
  var loadedReportId = '';

  function freshDefinition() {
    var to = new Date();
    var from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth() + 1, 1));
    return {
      dateBasis: 'CREATED',
      from: from.toISOString().slice(0, 10),
      to: '',
      groupBy: ['MONTH'],
      measures: ['PROPOSALS', 'PROPOSAL_VALUE'],
      filters: { optional: 'ANY', financing: 'ANY' },
      sort: null,
      limit: 500,
    };
  }

  /* ------------------------------------------------------------------- plumbing */

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

  /** One transparent refresh-retry on 401, the contract the shell's authed has. */
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

  function can(list) {
    return !!user && list.indexOf(user.role) !== -1;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money0(minor) {
    var n = Math.round((Number(minor) || 0) / 100);
    return '$' + n.toLocaleString();
  }

  function money2(minor) {
    var n = (Number(minor) || 0) / 100;
    return (
      '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }

  function fmtCell(v, kind) {
    if (kind === 'money') return money2(v);
    if (kind === 'pct') return (Number(v) || 0) + '%';
    if (kind === 'int') return (Number(v) || 0).toLocaleString();
    return esc(v);
  }

  var FIELD =
    'box-sizing:border-box;padding:7px 9px;font-size:13px;border:1px solid ' +
    LINE +
    ';border-radius:8px;font-family:inherit;color:' +
    INK +
    ';background:#fff;';

  function btn(label, id, kind, extra) {
    var bg = kind === 'primary' ? ACCENT : '#fff';
    var fg = kind === 'primary' ? '#fff' : ACCENT;
    return (
      '<button id="' +
      id +
      '" style="font:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid ' +
      (kind === 'primary' ? ACCENT : LINE) +
      ';background:' +
      bg +
      ';color:' +
      fg +
      ';white-space:nowrap;' +
      (extra || '') +
      '">' +
      esc(label) +
      '</button>'
    );
  }

  function chip(label, on, attrs) {
    return (
      '<button ' +
      attrs +
      ' style="border:1px solid ' +
      (on ? ACCENT : LINE) +
      ';background:' +
      (on ? ACCENT : '#fff') +
      ';color:' +
      (on ? '#fff' : ACCENT) +
      ';border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap;">' +
      esc(label) +
      '</button>'
    );
  }

  function card(inner, pad) {
    return (
      '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;padding:' +
      (pad || '14px 16px') +
      ';">' +
      inner +
      '</div>'
    );
  }

  function kpi(label, value, sub, color) {
    return card(
      '<div style="font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:' +
        MUTE +
        ';font-weight:600;">' +
        esc(label) +
        '</div>' +
        '<div style="font-family:Georgia,serif;font-size:25px;font-weight:600;margin-top:3px;color:' +
        (color || INK) +
        ';">' +
        value +
        '</div>' +
        (sub
          ? '<div style="font-size:12px;color:' + MUTE + ';margin-top:2px;">' + sub + '</div>'
          : ''),
    );
  }

  /* ---------------------------------------------------------------------- nav */

  function install() {
    var nav = document.getElementById('nav');
    if (!nav || document.getElementById('insightsNavItem')) return;
    if (!can(VIEW_ROLES)) return;

    var afterReports = null;
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (b) {
      if (b.getAttribute('data-view') === 'reports') afterReports = b;
    });

    var item = document.createElement('button');
    item.className = 'nav-item';
    item.id = 'insightsNavItem';
    item.setAttribute('data-view', 'insights');
    item.innerHTML = '<span>Insights</span>';
    if (afterReports && afterReports.nextSibling) nav.insertBefore(item, afterReports.nextSibling);
    else nav.appendChild(item);

    nav.addEventListener(
      'click',
      function (e) {
        var hit = e.target.closest && e.target.closest('#insightsNavItem');
        if (!hit) return;
        e.stopPropagation();
        e.preventDefault();
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
          b.classList.remove('active');
        });
        hit.classList.add('active');
        var t = document.getElementById('viewTitle');
        if (t) t.textContent = 'Insights';
        mount();
      },
      true,
    );
    installed = true;
  }

  /* -------------------------------------------------------------------- loads */

  async function loadSigned() {
    sd.error = '';
    var to = new Date();
    var from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - (sd.months - 1), 1));
    var r = await authed('/insights/signed-deals?from=' + from.toISOString().slice(0, 10));
    if (!r.ok) {
      sd.error = await failureText(r, 'The signed-deals figures could not be read.');
      sd.data = null;
      return;
    }
    sd.data = await r.json();
  }

  async function loadVocab() {
    if (vocab) return;
    var r = await authed('/insights/vocabulary');
    vocab = r.ok
      ? await r.json()
      : { error: await failureText(r, 'Could not read the report options.') };
  }

  async function loadSaved() {
    var r = await authed('/insights/reports');
    saved = r.ok ? await r.json() : [];
  }

  async function runReport() {
    runError = '';
    busy = true;
    paint();
    var r = await authed('/insights/query', { method: 'POST', body: def });
    busy = false;
    if (!r.ok) {
      runError = await failureText(r, 'The report could not be run.');
      result = null;
    } else {
      result = await r.json();
    }
    paint();
  }

  /* ------------------------------------------------------- signed-deals chart */

  var MILESTONES = [
    ['ACCEPTED', 'Accepted / signed'],
    ['ORDERED', 'Order created'],
    ['DEPOSIT_PAID', 'First payment'],
    ['PAID', 'Paid in full'],
  ];

  /**
   * Count as bars, dollars as a line, on two axes.
   *
   * Drawn as SVG rather than with a charting library: one file, no dependency, and
   * the axes can say what they mean. Bars are the count because a count is a whole
   * thing you can point at; dollars are the line because the shape of the money over
   * a year is what people look for.
   */
  function drawSignedChart(series) {
    var pts = series.points || [];
    if (!pts.length)
      return '<div style="padding:20px;color:' + MUTE + ';">No months in range.</div>';

    var W = 940,
      H = 260,
      padL = 46,
      padR = 66,
      padT = 16,
      padB = 34;
    var iw = W - padL - padR,
      ih = H - padT - padB;
    var maxCount = Math.max(
      1,
      Math.max.apply(
        null,
        pts.map(function (p) {
          return p.count;
        }),
      ),
    );
    var maxValue = Math.max(
      1,
      Math.max.apply(
        null,
        pts.map(function (p) {
          return p.valueMinor;
        }),
      ),
    );
    // Round the axes up to something a person would have chosen.
    var niceCount = Math.max(1, Math.ceil(maxCount / 4) * 4);
    var niceValue = Math.ceil(maxValue / 100 / 5000) * 5000 * 100 || maxValue;

    var slot = iw / pts.length;
    var barW = Math.min(34, slot * 0.56);
    var out = [];

    // Horizontal guides and both axis scales.
    for (var g = 0; g <= 4; g++) {
      var y = padT + (ih * g) / 4;
      var cv = Math.round((niceCount * (4 - g)) / 4);
      var mv = (niceValue * (4 - g)) / 4;
      out.push(
        '<line x1="' +
          padL +
          '" y1="' +
          y +
          '" x2="' +
          (W - padR) +
          '" y2="' +
          y +
          '" stroke="' +
          HAIR +
          '" stroke-width="1"/>',
      );
      out.push(
        '<text x="' +
          (padL - 8) +
          '" y="' +
          (y + 4) +
          '" text-anchor="end" font-size="10.5" fill="' +
          MUTE +
          '">' +
          cv +
          '</text>',
      );
      out.push(
        '<text x="' +
          (W - padR + 8) +
          '" y="' +
          (y + 4) +
          '" font-size="10.5" fill="' +
          MUTE +
          '">' +
          money0(mv) +
          '</text>',
      );
    }

    var linePts = [];
    pts.forEach(function (p, i) {
      var cx = padL + slot * i + slot / 2;
      var bh = (p.count / niceCount) * ih;
      var by = padT + ih - bh;
      if (p.count) {
        out.push(
          '<rect x="' +
            (cx - barW / 2) +
            '" y="' +
            by +
            '" width="' +
            barW +
            '" height="' +
            Math.max(1, bh) +
            '" rx="3" fill="' +
            NAVY +
            '" opacity="0.82"><title>' +
            esc(p.label) +
            ': ' +
            p.count +
            ' deal' +
            (p.count === 1 ? '' : 's') +
            ', ' +
            money0(p.valueMinor) +
            '</title></rect>',
        );
        out.push(
          '<text x="' +
            cx +
            '" y="' +
            (by - 5) +
            '" text-anchor="middle" font-size="10.5" font-weight="600" fill="' +
            NAVY +
            '">' +
            p.count +
            '</text>',
        );
      }
      var ly = padT + ih - (p.valueMinor / niceValue) * ih;
      linePts.push(cx.toFixed(1) + ',' + ly.toFixed(1));
      // Every other label when the year is long, so they never overlap.
      if (pts.length <= 14 || i % 2 === 0) {
        out.push(
          '<text x="' +
            cx +
            '" y="' +
            (H - 12) +
            '" text-anchor="middle" font-size="10.5" fill="' +
            MUTE +
            '">' +
            esc(p.label) +
            '</text>',
        );
      }
    });

    out.push(
      '<polyline points="' +
        linePts.join(' ') +
        '" fill="none" stroke="' +
        AMBER +
        '" stroke-width="2" stroke-linejoin="round"/>',
    );
    pts.forEach(function (p, i) {
      var xy = linePts[i].split(',');
      out.push(
        '<circle cx="' +
          xy[0] +
          '" cy="' +
          xy[1] +
          '" r="3" fill="#fff" stroke="' +
          AMBER +
          '" stroke-width="2"><title>' +
          esc(p.label) +
          ': ' +
          money2(p.valueMinor) +
          '</title></circle>',
      );
    });

    return (
      '<div style="overflow-x:auto;">' +
      '<svg viewBox="0 0 ' +
      W +
      ' ' +
      H +
      '" width="100%" height="' +
      H +
      '" role="img" aria-label="Signed deals by month">' +
      out.join('') +
      '</svg></div>' +
      '<div style="display:flex;gap:18px;align-items:center;margin-top:6px;font-size:12px;color:' +
      SOFT +
      ';">' +
      '<span style="display:flex;gap:6px;align-items:center;"><span style="width:12px;height:12px;border-radius:3px;background:' +
      NAVY +
      ';opacity:.82;"></span>Deals (left axis)</span>' +
      '<span style="display:flex;gap:6px;align-items:center;"><span style="width:16px;height:2px;background:' +
      AMBER +
      ';"></span>Value (right axis)</span>' +
      '</div>'
    );
  }

  function drawSigned() {
    if (sd.error) return '<div class="err">' + esc(sd.error) + '</div>';
    if (!sd.data)
      return '<div style="padding:22px;color:' + MUTE + ';">Reading the pipeline&hellip;</div>';

    var byId = {};
    (sd.data.series || []).forEach(function (s) {
      byId[s.milestone] = s;
    });
    var current = byId[sd.milestone] || (sd.data.series || [])[0];
    if (!current)
      return '<div style="padding:22px;color:' + MUTE + ';">Nothing to chart yet.</div>';

    var cards = MILESTONES.map(function (m) {
      var s = byId[m[0]];
      if (!s) return '';
      return kpi(
        m[1],
        String(s.totalCount),
        money0(s.totalValueMinor) + ' over ' + sd.months + ' months',
        m[0] === sd.milestone ? NAVY : INK,
      );
    }).join('');

    var gaps = sd.data.gaps || {};

    return (
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px;">' +
      cards +
      '</div>' +
      card(
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          MILESTONES.map(function (m) {
            return chip(m[1], sd.milestone === m[0], 'data-ms="' + m[0] + '"');
          }).join('') +
          '</div>' +
          '<select id="sdMonths" style="' +
          FIELD +
          '">' +
          [6, 12, 18, 24, 36]
            .map(function (n) {
              return (
                '<option value="' +
                n +
                '"' +
                (sd.months === n ? ' selected' : '') +
                '>Last ' +
                n +
                ' months</option>'
              );
            })
            .join('') +
          '</select>' +
          '</div>' +
          drawSignedChart(current),
        '16px 18px',
      ) +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:12px;">' +
      kpi(
        'Accepted, no order yet',
        String(gaps.acceptedNotOrdered || 0),
        'Signed but never turned into an order',
        gaps.acceptedNotOrdered ? AMBER : INK,
      ) +
      kpi(
        'Ordered, no payment yet',
        String(gaps.orderedNotPaid || 0),
        money0(gaps.openBalanceMinor) + ' of order value with nothing received',
        gaps.orderedNotPaid ? RED : INK,
      ) +
      '</div>' +
      '<div style="font-size:12px;color:' +
      MUTE +
      ';margin-top:10px;line-height:1.5;max-width:760px;">' +
      'Dated by the milestone itself: a deal accepted in March and paid in May counts in March on the accepted view and in May on the paid view. The two gap figures above are as of today, not filtered to the window — a deal accepted in March with no order is still missing one.' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------ report builder */

  function multiSelect(id, options, selected, size) {
    var sel = selected || [];
    return (
      '<select id="' +
      id +
      '" multiple size="' +
      (size || 5) +
      '" style="' +
      FIELD +
      'width:100%;padding:5px 6px;">' +
      options
        .map(function (o) {
          var v = o.value !== undefined ? o.value : o;
          var l = o.label !== undefined ? o.label : o;
          return (
            '<option value="' +
            esc(v) +
            '"' +
            (sel.indexOf(String(v)) !== -1 ? ' selected' : '') +
            '>' +
            esc(l) +
            '</option>'
          );
        })
        .join('') +
      '</select>'
    );
  }

  function labelled(label, control, hint) {
    return (
      '<div style="min-width:0;">' +
      '<div style="font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:' +
      MUTE +
      ';font-weight:600;margin-bottom:4px;">' +
      esc(label) +
      '</div>' +
      control +
      (hint
        ? '<div style="font-size:11.5px;color:' +
          MUTE +
          ';margin-top:3px;line-height:1.4;">' +
          esc(hint) +
          '</div>'
        : '') +
      '</div>'
    );
  }

  function builderControls() {
    if (!vocab || vocab.error) {
      return (
        '<div class="err">' +
        esc((vocab && vocab.error) || 'Could not read the report options.') +
        '</div>'
      );
    }
    var f = def.filters || {};
    var dims = vocab.dimensions.map(function (d) {
      return { value: d.id, label: d.label + (d.grain === 'LINE' ? ' (per line)' : '') };
    });

    return (
      card(
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
          labelled(
            'Dated by',
            '<select id="rbBasis" style="' +
              FIELD +
              'width:100%;">' +
              vocab.bases
                .map(function (b) {
                  return (
                    '<option value="' +
                    b.id +
                    '"' +
                    (def.dateBasis === b.id ? ' selected' : '') +
                    '>' +
                    esc(b.label) +
                    '</option>'
                  );
                })
                .join('') +
              '</select>',
            'A proposal with no date for this milestone is left out entirely.',
          ) +
          labelled(
            'From',
            '<input id="rbFrom" type="date" value="' +
              esc(def.from || '') +
              '" style="' +
              FIELD +
              'width:100%;">',
          ) +
          labelled(
            'To',
            '<input id="rbTo" type="date" value="' +
              esc(def.to || '') +
              '" style="' +
              FIELD +
              'width:100%;">',
            'Blank means up to today.',
          ) +
          labelled(
            'Group by (up to 3)',
            multiSelect('rbGroup', dims, def.groupBy, 6),
            'Ctrl/⌘-click for more than one. Order matters.',
          ) +
          labelled(
            'Show',
            multiSelect(
              'rbMeasures',
              vocab.measures.map(function (m) {
                return { value: m.id, label: m.label };
              }),
              def.measures,
              6,
            ),
          ) +
          '</div>' +
          '<div style="border-top:1px solid ' +
          HAIR +
          ';margin:14px 0 12px;"></div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
          labelled(
            'Product contains',
            '<input id="rbProduct" value="' +
              esc(f.productLike || '') +
              '" placeholder="e.g. Soar, or K-4002" style="' +
              FIELD +
              'width:100%;">',
            'Matched against the SKU and the line name.',
          ) +
          labelled(
            'Status',
            multiSelect(
              'rbStatus',
              vocab.statuses.map(function (s) {
                return { value: s, label: s.replace(/_/g, ' ') };
              }),
              f.status,
              4,
            ),
          ) +
          labelled(
            'Prepared by',
            multiSelect(
              'rbRep',
              vocab.reps.map(function (r) {
                return { value: r.id, label: r.name };
              }),
              f.repIds,
              4,
            ),
          ) +
          labelled(
            'Tier category',
            multiSelect('rbGroups', vocab.proposalGroups, f.proposalGroups, 4),
          ) +
          labelled('Catalog category', multiSelect('rbCat', vocab.categories, f.categories, 4)) +
          labelled('Manufacturer', multiSelect('rbMfr', vocab.manufacturers, f.manufacturers, 4)) +
          labelled('State / province', multiSelect('rbRegion', vocab.regions, f.regions, 4)) +
          labelled(
            'Optional lines',
            '<select id="rbOptional" style="' +
              FIELD +
              'width:100%;">' +
              [
                ['ANY', 'Include everything'],
                ['INCLUDED_ONLY', 'Included lines only'],
                ['OPTIONAL_ONLY', 'Optional lines only'],
              ]
                .map(function (o) {
                  return (
                    '<option value="' +
                    o[0] +
                    '"' +
                    ((f.optional || 'ANY') === o[0] ? ' selected' : '') +
                    '>' +
                    o[1] +
                    '</option>'
                  );
                })
                .join('') +
              '</select>',
          ) +
          labelled(
            'Financing',
            '<select id="rbFinancing" style="' +
              FIELD +
              'width:100%;">' +
              [
                ['ANY', 'Either'],
                ['FINANCED', 'Financing quoted'],
                ['CASH', 'No financing'],
              ]
                .map(function (o) {
                  return (
                    '<option value="' +
                    o[0] +
                    '"' +
                    ((f.financing || 'ANY') === o[0] ? ' selected' : '') +
                    '>' +
                    o[1] +
                    '</option>'
                  );
                })
                .join('') +
              '</select>',
          ) +
          labelled(
            'Discount % between',
            '<div style="display:flex;gap:6px;"><input id="rbDiscMin" type="number" step="0.5" value="' +
              (f.discountPctMin == null ? '' : f.discountPctMin) +
              '" placeholder="min" style="' +
              FIELD +
              'width:100%;">' +
              '<input id="rbDiscMax" type="number" step="0.5" value="' +
              (f.discountPctMax == null ? '' : f.discountPctMax) +
              '" placeholder="max" style="' +
              FIELD +
              'width:100%;"></div>',
          ) +
          labelled(
            'Margin % between',
            '<div style="display:flex;gap:6px;"><input id="rbMarMin" type="number" step="0.5" value="' +
              (f.marginPctMin == null ? '' : f.marginPctMin) +
              '" placeholder="min" style="' +
              FIELD +
              'width:100%;">' +
              '<input id="rbMarMax" type="number" step="0.5" value="' +
              (f.marginPctMax == null ? '' : f.marginPctMax) +
              '" placeholder="max" style="' +
              FIELD +
              'width:100%;"></div>',
          ) +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center;">' +
          btn(busy ? 'Running…' : 'Run report', 'rbRun', 'primary') +
          btn('Reset', 'rbReset') +
          btn('Download CSV', 'rbCsv') +
          btn(loadedReportId ? 'Update saved report' : 'Save this report', 'rbSave') +
          (loadedReportId ? btn('Save as new', 'rbSaveNew') : '') +
          '<span style="flex:1;"></span>' +
          '<span id="rbNote" style="font-size:12px;color:' +
          MUTE +
          ';"></span>' +
          '</div>',
        '16px 18px',
      ) + presetRow()
    );
  }

  /**
   * Three examples, because a builder with nineteen dimensions and twelve measures
   * is a blank page. Each one is a real question somebody asked for.
   */
  var PRESETS = [
    {
      label: 'Summit Soar units by month',
      def: function () {
        var d = freshDefinition();
        d.groupBy = ['MONTH'];
        d.measures = ['UNITS', 'PROPOSALS', 'LINE_VALUE'];
        d.filters = { productLike: 'soar', optional: 'INCLUDED_ONLY', financing: 'ANY' };
        return d;
      },
    },
    {
      label: 'Signed value by rep, this year',
      def: function () {
        var d = freshDefinition();
        d.dateBasis = 'ACCEPTED';
        d.from = new Date().getUTCFullYear() + '-01-01';
        d.groupBy = ['REP'];
        d.measures = ['PROPOSALS', 'PROPOSAL_VALUE', 'MARGIN_PCT'];
        return d;
      },
    },
    {
      label: 'Product demand by tier category',
      def: function () {
        var d = freshDefinition();
        d.groupBy = ['PROPOSAL_GROUP', 'PRODUCT'];
        d.measures = ['UNITS', 'LINE_VALUE', 'PROPOSALS'];
        return d;
      },
    },
    {
      label: 'Won vs lost by customer type',
      def: function () {
        var d = freshDefinition();
        d.dateBasis = 'DECIDED';
        d.groupBy = ['CUSTOMER_TYPE'];
        d.measures = ['PROPOSALS', 'WON_PROPOSALS', 'WIN_RATE', 'WON_VALUE'];
        return d;
      },
    },
  ];

  function presetRow() {
    return (
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px;">' +
      '<span style="font-size:11.5px;color:' +
      MUTE +
      ';">Start from:</span>' +
      PRESETS.map(function (p, i) {
        return chip(p.label, false, 'data-preset="' + i + '"');
      }).join('') +
      '</div>'
    );
  }

  function readControls() {
    var val = function (id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    };
    var multi = function (id) {
      var el = document.getElementById(id);
      if (!el) return [];
      return Array.prototype.slice.call(el.selectedOptions).map(function (o) {
        return o.value;
      });
    };
    var numOrNull = function (id) {
      var v = val(id);
      return v === '' ? null : Number(v);
    };

    def.dateBasis = val('rbBasis') || def.dateBasis;
    def.from = val('rbFrom');
    def.to = val('rbTo');
    var g = multi('rbGroup');
    def.groupBy = (g.length ? g : ['MONTH']).slice(0, 3);
    var m = multi('rbMeasures');
    def.measures = m.length ? m : ['PROPOSALS', 'PROPOSAL_VALUE'];
    def.filters = {
      productLike: val('rbProduct'),
      status: multi('rbStatus'),
      repIds: multi('rbRep'),
      proposalGroups: multi('rbGroups'),
      categories: multi('rbCat'),
      manufacturers: multi('rbMfr'),
      regions: multi('rbRegion'),
      optional: val('rbOptional') || 'ANY',
      financing: val('rbFinancing') || 'ANY',
      discountPctMin: numOrNull('rbDiscMin'),
      discountPctMax: numOrNull('rbDiscMax'),
      marginPctMin: numOrNull('rbMarMin'),
      marginPctMax: numOrNull('rbMarMax'),
    };
  }

  /** The result as a table. Every heading sorts, because every column is a ranking. */
  function drawTable() {
    if (runError) return '<div class="err">' + esc(runError) + '</div>';
    if (busy) return '<div style="padding:22px;color:' + MUTE + ';">Running&hellip;</div>';
    if (!result) {
      return (
        '<div style="padding:26px;text-align:center;color:' +
        MUTE +
        ';font-size:13px;">' +
        'Pick a grouping and press Run report — or start from one of the examples above.' +
        '</div>'
      );
    }
    if (!result.rows.length) {
      return (
        '<div style="padding:26px;text-align:center;color:' +
        MUTE +
        ';font-size:13px;">Nothing matched. Widen the dates or drop a filter.</div>'
      );
    }

    var head = result.columns
      .map(function (c) {
        var active = def.sort && def.sort.key === c.key;
        var caret = active ? (def.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
        return (
          '<th data-sort="' +
          c.key +
          '" style="text-align:' +
          c.align +
          ';padding:9px 12px;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:' +
          (active ? ACCENT : MUTE) +
          ';font-weight:600;border-bottom:1px solid ' +
          LINE +
          ';white-space:nowrap;cursor:pointer;user-select:none;">' +
          esc(c.label) +
          caret +
          '</th>'
        );
      })
      .join('');

    var body = result.rows
      .map(function (r) {
        return (
          '<tr>' +
          result.columns
            .map(function (c) {
              return (
                '<td style="text-align:' +
                c.align +
                ';padding:8px 12px;border-bottom:1px solid ' +
                HAIR +
                ';font-size:13px;white-space:nowrap;' +
                (c.kind === 'text' ? '' : 'font-variant-numeric:tabular-nums;') +
                '">' +
                fmtCell(r[c.key], c.kind) +
                '</td>'
              );
            })
            .join('') +
          '</tr>'
        );
      })
      .join('');

    var totals = result.columns
      .map(function (c, i) {
        var v = i === 0 ? 'Total' : c.kind === 'text' ? '' : fmtCell(result.totals[c.key], c.kind);
        return (
          '<td style="text-align:' +
          c.align +
          ';padding:9px 12px;border-top:2px solid ' +
          NAVY +
          ';font-size:13px;font-weight:700;color:' +
          NAVY +
          ';white-space:nowrap;">' +
          v +
          '</td>'
        );
      })
      .join('');

    return (
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin:16px 0 8px;">' +
      '<div style="font-size:13px;color:' +
      SOFT +
      ';">' +
      result.rows.length +
      ' row' +
      (result.rows.length === 1 ? '' : 's') +
      ' · ' +
      result.meta.proposalsMatched +
      ' proposal' +
      (result.meta.proposalsMatched === 1 ? '' : 's') +
      ' matched · grouped per ' +
      (result.meta.grain === 'LINE' ? 'line' : 'proposal') +
      '</div>' +
      (result.meta.truncated
        ? '<div style="font-size:12px;color:' +
          AMBER +
          ';">Showing the first ' +
          result.rows.length +
          ' rows. Download the CSV for everything.</div>'
        : '') +
      '</div>' +
      (result.meta.notes.length
        ? '<div style="font-size:12px;color:' +
          MUTE +
          ';line-height:1.5;margin-bottom:10px;max-width:820px;">' +
          result.meta.notes.map(esc).join(' ') +
          '</div>'
        : '') +
      drawResultChart() +
      '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:auto;">' +
      '<table style="width:100%;border-collapse:collapse;"><thead><tr>' +
      head +
      '</tr></thead>' +
      '<tbody>' +
      body +
      '<tr>' +
      totals +
      '</tr></tbody></table></div>'
    );
  }

  /**
   * The result as bars.
   *
   * Only the first numeric measure is charted, and only when the rows are few enough
   * to read. A chart of ninety product rows is a decoration, not information.
   */
  function drawResultChart() {
    if (!result || result.rows.length < 2 || result.rows.length > 40) return '';
    var series = (result.chart.series || []).filter(function (s) {
      return s.kind !== 'text';
    })[0];
    if (!series) return '';
    var labels = result.chart.labels || [];
    var max = Math.max.apply(null, series.values.concat([1]));
    var W = 940,
      H = 190,
      padL = 8,
      padB = 44,
      padT = 18;
    var n = series.values.length;
    var slot = (W - padL * 2) / n;
    var barW = Math.min(46, slot * 0.6);
    var bars = series.values
      .map(function (v, i) {
        var h = (Math.max(0, v) / max) * (H - padT - padB);
        var x = padL + slot * i + slot / 2;
        var y = H - padB - h;
        var lab =
          series.kind === 'money'
            ? money0(v)
            : series.kind === 'pct'
              ? v + '%'
              : Number(v).toLocaleString();
        return (
          '<rect x="' +
          (x - barW / 2) +
          '" y="' +
          y +
          '" width="' +
          barW +
          '" height="' +
          Math.max(1, h) +
          '" rx="3" fill="' +
          NAVY +
          '" opacity="0.8"><title>' +
          esc(labels[i]) +
          ': ' +
          lab +
          '</title></rect>' +
          '<text x="' +
          x +
          '" y="' +
          (y - 5) +
          '" text-anchor="middle" font-size="10" fill="' +
          NAVY +
          '">' +
          esc(lab) +
          '</text>' +
          '<text x="' +
          x +
          '" y="' +
          (H - padB + 14) +
          '" text-anchor="middle" font-size="10" fill="' +
          MUTE +
          '" transform="rotate(0)">' +
          esc(String(labels[i] || '').slice(0, 16)) +
          '</text>'
        );
      })
      .join('');
    return (
      card(
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:' +
          MUTE +
          ';font-weight:600;margin-bottom:2px;">' +
          esc(series.label) +
          ' by ' +
          esc(result.columns[0].label) +
          '</div>' +
          '<div style="overflow-x:auto;"><svg viewBox="0 0 ' +
          W +
          ' ' +
          H +
          '" width="100%" height="' +
          H +
          '">' +
          bars +
          '</svg></div>',
        '14px 16px',
      ) + '<div style="height:12px;"></div>'
    );
  }

  function downloadCsv() {
    if (!result) return;
    var q = function (v) {
      var s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var lines = [
      result.columns
        .map(function (c) {
          return q(c.label);
        })
        .join(','),
    ];
    result.rows.forEach(function (r) {
      lines.push(
        result.columns
          .map(function (c) {
            return q(c.kind === 'money' ? (Number(r[c.key]) || 0) / 100 : r[c.key]);
          })
          .join(','),
      );
    });
    lines.push(
      result.columns
        .map(function (c, i) {
          if (i === 0) return q('Total');
          if (c.kind === 'text') return '';
          return q(
            c.kind === 'money' ? (Number(result.totals[c.key]) || 0) / 100 : result.totals[c.key],
          );
        })
        .join(','),
    );
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ssg-report-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 4000);
  }

  /* -------------------------------------------------------------- saved reports */

  function drawSaved() {
    if (!saved.length) {
      return (
        '<div style="padding:26px;text-align:center;color:' +
        MUTE +
        ';font-size:13px;">' +
        'No saved reports yet. Build one under Report builder and press Save.' +
        '</div>'
      );
    }
    return (
      '<div style="display:flex;flex-direction:column;gap:10px;">' +
      saved
        .map(function (r) {
          var sched =
            r.cadence === 'NONE'
              ? 'Not scheduled'
              : r.cadence === 'WEEKLY'
                ? 'Weekly, day ' + (r.scheduleDay || 1)
                : 'Monthly, day ' + (r.scheduleDay || 1);
          return card(
            '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">' +
              '<div style="min-width:220px;">' +
              '<div style="font-size:14px;font-weight:600;color:' +
              INK +
              ';">' +
              esc(r.name) +
              '</div>' +
              (r.description
                ? '<div style="font-size:12.5px;color:' +
                  SOFT +
                  ';margin-top:2px;">' +
                  esc(r.description) +
                  '</div>'
                : '') +
              '<div style="font-size:12px;color:' +
              MUTE +
              ';margin-top:4px;">' +
              esc(sched) +
              (r.recipients ? ' → ' + esc(r.recipients) : '') +
              (r.lastSentAt ? ' · last sent ' + esc(String(r.lastSentAt).slice(0, 10)) : '') +
              (r.shared ? '' : ' · private') +
              '</div>' +
              (r.lastSendError
                ? '<div style="font-size:12px;color:' +
                  RED +
                  ';margin-top:3px;">Last send failed: ' +
                  esc(r.lastSendError) +
                  '</div>'
                : '') +
              '</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
              '<button data-open="' +
              r.id +
              '" style="font:inherit;font-size:12.5px;padding:7px 12px;border:1px solid ' +
              LINE +
              ';background:#fff;border-radius:8px;cursor:pointer;color:' +
              ACCENT +
              ';">Open</button>' +
              '<button data-sched="' +
              r.id +
              '" style="font:inherit;font-size:12.5px;padding:7px 12px;border:1px solid ' +
              LINE +
              ';background:#fff;border-radius:8px;cursor:pointer;color:' +
              ACCENT +
              ';">Schedule…</button>' +
              '<button data-del="' +
              r.id +
              '" style="font:inherit;font-size:12.5px;padding:7px 12px;border:1px solid ' +
              LINE +
              ';background:#fff;border-radius:8px;cursor:pointer;color:' +
              RED +
              ';">Delete</button>' +
              '</div>' +
              '</div>',
          );
        })
        .join('') +
      '</div>'
    );
  }

  async function saveReport(asNew) {
    readControls();
    var name = prompt(
      'Name this report:\n\nIt appears under Saved reports for everyone, and can be scheduled to email itself.',
      loadedReportId && !asNew
        ? (
            saved.filter(function (s) {
              return s.id === loadedReportId;
            })[0] || {}
          ).name || ''
        : '',
    );
    if (name === null) return;
    name = name.trim();
    if (!name) return;

    var r;
    if (loadedReportId && !asNew) {
      r = await authed('/insights/reports/' + loadedReportId, {
        method: 'PATCH',
        body: { name: name, definition: def },
      });
    } else {
      r = await authed('/insights/reports', {
        method: 'POST',
        body: { name: name, definition: def },
      });
    }
    if (!r.ok) {
      alert(await failureText(r, 'The report could not be saved.'));
      return;
    }
    var row = await r.json();
    loadedReportId = row.id;
    await loadSaved();
    paint();
  }

  async function scheduleReport(id) {
    var row = saved.filter(function (s) {
      return s.id === id;
    })[0];
    if (!row) return;
    var cadence = prompt(
      'How often should "' + row.name + '" email itself?\n\nType: none, weekly, or monthly',
      String(row.cadence || 'NONE').toLowerCase(),
    );
    if (cadence === null) return;
    cadence = cadence.trim().toUpperCase();
    if (['NONE', 'WEEKLY', 'MONTHLY'].indexOf(cadence) === -1) {
      alert('Type none, weekly or monthly.');
      return;
    }
    var day = row.scheduleDay || 1;
    var recipients = row.recipients || '';
    if (cadence !== 'NONE') {
      var dayIn = prompt(
        cadence === 'WEEKLY'
          ? 'Which day? 1 = Monday … 7 = Sunday'
          : 'Which day of the month? 1–28',
        String(day),
      );
      if (dayIn === null) return;
      day = Math.max(1, Math.min(cadence === 'WEEKLY' ? 7 : 28, Number(dayIn) || 1));
      var recIn = prompt(
        'Email it to (comma separated):\n\nSent from your own Outlook mailbox, so it has to be connected under your profile.',
        recipients,
      );
      if (recIn === null) return;
      recipients = recIn.trim();
      if (!recipients) {
        alert('A scheduled report needs at least one recipient.');
        return;
      }
    }
    var r = await authed('/insights/reports/' + id, {
      method: 'PATCH',
      body: { cadence: cadence, scheduleDay: day, recipients: recipients },
    });
    if (!r.ok) {
      alert(await failureText(r, 'The schedule could not be saved.'));
      return;
    }
    await loadSaved();
    paint();
  }

  async function deleteReport(id) {
    var row = saved.filter(function (s) {
      return s.id === id;
    })[0];
    if (!row) return;
    if (!confirm('Delete "' + row.name + '"?\n\nAny goal reading it will stop reporting a figure.'))
      return;
    var r = await authed('/insights/reports/' + id, { method: 'DELETE' });
    if (!r.ok) {
      alert(await failureText(r, 'The report could not be deleted.'));
      return;
    }
    if (loadedReportId === id) loadedReportId = '';
    await loadSaved();
    paint();
  }

  /* -------------------------------------------------------------------- paint */

  var TABS = [
    ['signed', 'Signed deals'],
    ['builder', 'Report builder'],
    ['saved', 'Saved reports'],
  ];

  function paint() {
    var host = document.getElementById('view');
    if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
      TABS.map(function (t) {
        return chip(t[1], tab === t[0], 'data-tab="' + t[0] + '"');
      }).join('') +
      '</div>' +
      '<div style="font-size:12px;color:' +
      MUTE +
      ';">' +
      (sd.data
        ? 'Figures as of ' +
          new Date(sd.data.generatedAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })
        : '') +
      '</div>' +
      '</div>' +
      '<div id="insBody">' +
      (tab === 'signed'
        ? drawSigned()
        : tab === 'builder'
          ? builderControls() + drawTable()
          : drawSaved()) +
      '</div>';
    wire();
  }

  function wire() {
    var host = document.getElementById('view');
    if (!host) return;

    host.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', async function () {
        tab = b.getAttribute('data-tab');
        if (tab === 'builder') {
          await loadVocab();
          if (!def) def = freshDefinition();
        }
        if (tab === 'saved') await loadSaved();
        paint();
      });
    });

    host.querySelectorAll('[data-ms]').forEach(function (b) {
      b.addEventListener('click', function () {
        sd.milestone = b.getAttribute('data-ms');
        paint();
      });
    });
    var months = document.getElementById('sdMonths');
    if (months) {
      months.addEventListener('change', async function () {
        sd.months = Number(months.value) || 12;
        sd.data = null;
        paint();
        await loadSigned();
        paint();
      });
    }

    host.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        def = PRESETS[Number(b.getAttribute('data-preset'))].def();
        loadedReportId = '';
        paint();
        runReport();
      });
    });

    var run = document.getElementById('rbRun');
    if (run) {
      run.addEventListener('click', function () {
        readControls();
        runReport();
      });
    }
    var reset = document.getElementById('rbReset');
    if (reset) {
      reset.addEventListener('click', function () {
        def = freshDefinition();
        result = null;
        loadedReportId = '';
        paint();
      });
    }
    var csv = document.getElementById('rbCsv');
    if (csv) csv.addEventListener('click', downloadCsv);
    var save = document.getElementById('rbSave');
    if (save) {
      save.addEventListener('click', function () {
        saveReport(false);
      });
    }
    var saveNew = document.getElementById('rbSaveNew');
    if (saveNew) {
      saveNew.addEventListener('click', function () {
        saveReport(true);
      });
    }

    host.querySelectorAll('[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        var dir = def.sort && def.sort.key === key && def.sort.dir === 'desc' ? 'asc' : 'desc';
        def.sort = { key: key, dir: dir };
        runReport();
      });
    });

    host.querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-open');
        var row = saved.filter(function (s) {
          return s.id === id;
        })[0];
        if (!row) return;
        await loadVocab();
        def = Object.assign(freshDefinition(), row.definition || {});
        loadedReportId = id;
        tab = 'builder';
        paint();
        runReport();
      });
    });
    host.querySelectorAll('[data-sched]').forEach(function (b) {
      b.addEventListener('click', function () {
        scheduleReport(b.getAttribute('data-sched'));
      });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        deleteReport(b.getAttribute('data-del'));
      });
    });
  }

  async function mount() {
    var host = document.getElementById('view');
    if (host)
      host.innerHTML =
        '<div style="padding:18px;color:' + MUTE + ';font-size:13px;">Loading&hellip;</div>';
    tab = 'signed';
    sd.data = null;
    await loadSigned();
    paint();
  }

  /**
   * Wait for the shell, then install the tab. The shell renders after the session
   * check, so there is nothing to attach to at parse time.
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

  window.SSGInsights = { mount: mount, install: install };
})();

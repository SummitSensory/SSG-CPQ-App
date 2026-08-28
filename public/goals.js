/*
 * Goals.
 *
 * A target, the period it has to be hit in, and a glass that fills as it is.
 *
 * The glass is not decoration: a bar chart tells you 62%, and a glass tells you
 * whether it is nearly there at a glance from across the room, which is the point of
 * putting a number on a wall. Pace is shown beside it because 62% on the tenth of the
 * month and 62% on the twenty-eighth are opposite news.
 *
 * Progress reads ACCEPTED proposals dated by acceptance. Payment milestones are on
 * the Insights → Signed deals chart; a sales goal is about closing.
 *
 * Self-contained the way accounts-receivable.js is: installs its own nav entry, so
 * app.js needs no edit. Server side: src/routes/insights.ts, src/reporting/goals.ts.
 */
(function () {
  'use strict';

  var AT = 'ssg_at',
    RT = 'ssg_rt';

  var INK = '#20241f',
    MUTE = '#82877d',
    SOFT = '#5c6357',
    LINE = '#dcded7',
    HAIR = '#f2f3ef',
    NAVY = '#203060',
    ACCENT = '#3d4a55',
    GREEN = '#3f9d78',
    AMBER = '#c98a1e',
    FOAM = '#f6efe0',
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
  var MANAGE_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER'];

  var user = null;
  var installed = false;
  var data = null;
  var error = '';
  var showRetired = false;
  var formOpen = false;
  var editing = null;
  var reps = [];
  var reports = [];
  var expanded = {};

  /* ------------------------------------------------------------------ plumbing */

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
    return '$' + Math.round((Number(minor) || 0) / 100).toLocaleString();
  }

  function fmtValue(v, unit) {
    return unit === 'money' ? money0(v) : (Number(v) || 0).toLocaleString();
  }

  var FIELD =
    'box-sizing:border-box;width:100%;padding:7px 9px;font-size:13px;border:1px solid ' +
    LINE +
    ';border-radius:8px;font-family:inherit;color:' +
    INK +
    ';background:#fff;';

  function btn(label, id, kind) {
    return (
      '<button id="' +
      id +
      '" style="font:inherit;font-size:13px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid ' +
      (kind === 'primary' ? ACCENT : LINE) +
      ';background:' +
      (kind === 'primary' ? ACCENT : '#fff') +
      ';color:' +
      (kind === 'primary' ? '#fff' : ACCENT) +
      ';white-space:nowrap;">' +
      esc(label) +
      '</button>'
    );
  }

  function card(inner, pad) {
    return (
      '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;padding:' +
      (pad || '16px 18px') +
      ';">' +
      inner +
      '</div>'
    );
  }

  /* ---------------------------------------------------------------------- nav */

  function install() {
    var nav = document.getElementById('nav');
    if (!nav || document.getElementById('goalsNavItem')) return;
    if (!can(VIEW_ROLES)) return;

    var after = null;
    Array.prototype.forEach.call(nav.querySelectorAll('.nav-item'), function (b) {
      var v = b.getAttribute('data-view');
      if (v === 'insights' || (!after && v === 'reports')) after = b;
    });

    var item = document.createElement('button');
    item.className = 'nav-item';
    item.id = 'goalsNavItem';
    item.setAttribute('data-view', 'goals');
    item.innerHTML = '<span>Goals</span>';
    if (after && after.nextSibling) nav.insertBefore(item, after.nextSibling);
    else nav.appendChild(item);

    nav.addEventListener(
      'click',
      function (e) {
        var hit = e.target.closest && e.target.closest('#goalsNavItem');
        if (!hit) return;
        e.stopPropagation();
        e.preventDefault();
        Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
          b.classList.remove('active');
        });
        hit.classList.add('active');
        var t = document.getElementById('viewTitle');
        if (t) t.textContent = 'Goals';
        mount();
      },
      true,
    );
    installed = true;
  }

  /* -------------------------------------------------------------------- loads */

  async function load() {
    error = '';
    var r = await authed('/insights/goals' + (showRetired ? '?all=1' : ''));
    if (!r.ok) {
      error = await failureText(r, 'The goals could not be read.');
      data = null;
      return;
    }
    data = await r.json();
  }

  async function loadPickers() {
    if (reps.length) return;
    try {
      var v = await authed('/insights/vocabulary');
      if (v.ok) {
        var d = await v.json();
        reps = d.reps || [];
      }
      var s = await authed('/insights/reports');
      if (s.ok) reports = await s.json();
    } catch (e) {
      /* the form still works without the pickers; they are conveniences */
    }
  }

  /* --------------------------------------------------------------- the glass */

  /**
   * A tapered pint glass, filled to `fill` (0–1).
   *
   * Drawn as SVG with the liquid clipped to the glass interior, so the fill follows
   * the taper instead of being a rectangle inside an outline. The foam band sits on
   * top of the liquid and rises with it; at 100% it swells and spills over the rim,
   * which is the only animation-free way to make "hit" read differently from "97%".
   */
  var glassSeq = 0;

  function glassSvg(fill, hit, unitLabel) {
    // Unique per glass: two goals at the same percentage would otherwise emit the
    // same clipPath id, and a duplicate id is a bug waiting for a third caller.
    var clipId = 'ssgGlass' + ++glassSeq;
    var W = 132,
      H = 200;
    var topY = 18,
      botY = 178;
    var topHalf = 40,
      botHalf = 27; // half-widths: wider at the rim
    var cx = W / 2;
    var f = Math.max(0, Math.min(1, Number(fill) || 0));
    var innerTop = topY + 4,
      innerBot = botY - 4;
    var liquidTop = innerBot - (innerBot - innerTop) * f;
    var foamH = f <= 0 ? 0 : hit ? 16 : 10;
    var foamTop = Math.max(innerTop - (hit ? 8 : 0), liquidTop - foamH);

    var glassPath =
      'M' +
      (cx - topHalf) +
      ',' +
      topY +
      ' L' +
      (cx - botHalf) +
      ',' +
      botY +
      ' Q' +
      cx +
      ',' +
      (botY + 9) +
      ' ' +
      (cx + botHalf) +
      ',' +
      botY +
      ' L' +
      (cx + topHalf) +
      ',' +
      topY +
      ' Z';

    return (
      '<svg viewBox="0 0 ' +
      W +
      ' ' +
      H +
      '" width="' +
      W +
      '" height="' +
      H +
      '" role="img" aria-label="' +
      esc(Math.round(f * 100) + '% of ' + unitLabel) +
      '">' +
      '<defs><clipPath id="' +
      clipId +
      '"><path d="' +
      glassPath +
      '"/></clipPath></defs>' +
      // The glass body, so an empty goal still looks like a glass.
      '<path d="' +
      glassPath +
      '" fill="#f7f8f5" stroke="' +
      LINE +
      '" stroke-width="2"/>' +
      '<g clip-path="url(#' +
      clipId +
      ')">' +
      (f > 0
        ? '<rect x="0" y="' +
          liquidTop +
          '" width="' +
          W +
          '" height="' +
          (innerBot - liquidTop + 6) +
          '" fill="' +
          AMBER +
          '" opacity="0.9"/>' +
          '<rect x="0" y="' +
          foamTop +
          '" width="' +
          W +
          '" height="' +
          Math.max(0, liquidTop - foamTop) +
          '" fill="' +
          FOAM +
          '"/>' +
          // Two fill lines, so progress is readable without the caption.
          '<line x1="0" y1="' +
          (innerBot - (innerBot - innerTop) * 0.5) +
          '" x2="' +
          W +
          '" y2="' +
          (innerBot - (innerBot - innerTop) * 0.5) +
          '" stroke="#fff" stroke-width="1" opacity="0.5"/>' +
          '<line x1="0" y1="' +
          (innerBot - (innerBot - innerTop) * 0.75) +
          '" x2="' +
          W +
          '" y2="' +
          (innerBot - (innerBot - innerTop) * 0.75) +
          '" stroke="#fff" stroke-width="1" opacity="0.35"/>'
        : '') +
      '</g>' +
      // Spill over the rim when the target is met.
      (hit
        ? '<path d="M' +
          (cx - topHalf - 4) +
          ',' +
          (topY + 2) +
          ' q10,-12 22,-2 q12,-12 24,-2 q12,-10 22,2 q-4,10 -14,8 q-10,6 -20,-1 q-12,7 -22,0 q-10,3 -12,-5 Z" fill="' +
          FOAM +
          '" stroke="' +
          LINE +
          '" stroke-width="1"/>'
        : '') +
      // The rim, drawn last so the foam sits behind it.
      '<line x1="' +
      (cx - topHalf) +
      '" y1="' +
      topY +
      '" x2="' +
      (cx + topHalf) +
      '" y2="' +
      topY +
      '" stroke="' +
      SOFT +
      '" stroke-width="2.5" stroke-linecap="round"/>' +
      '<text x="' +
      cx +
      '" y="' +
      (H - 4) +
      '" text-anchor="middle" font-size="12" font-weight="700" fill="' +
      (hit ? GREEN : NAVY) +
      '">' +
      Math.round(f * 100) +
      '%</text>' +
      '</svg>'
    );
  }

  var METRIC_LABEL = {
    REVENUE: 'Revenue',
    DEAL_COUNT: 'Deals signed',
    PRODUCT_UNITS: 'Product units',
    SAVED_REPORT: 'Saved report',
  };

  function goalCard(g) {
    var pace =
      g.paceDelta === 0
        ? 'Exactly on pace'
        : g.paceDelta > 0
          ? fmtValue(g.paceDelta, g.unit) + ' ahead of pace'
          : fmtValue(-g.paceDelta, g.unit) + ' behind pace';
    var paceColor = g.hit
      ? GREEN
      : g.paceDelta >= 0
        ? GREEN
        : g.elapsedFraction > 0.5
          ? RED
          : AMBER;
    var scope =
      (g.ownerName ? g.ownerName : 'Company') +
      ' · ' +
      METRIC_LABEL[g.metric] +
      (g.skuMatch ? ' matching “' + g.skuMatch + '”' : '');

    var contributors = expanded[g.id]
      ? '<div style="border-top:1px solid ' +
        HAIR +
        ';margin-top:12px;padding-top:10px;">' +
        (g.contributors.length
          ? '<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
            g.contributors
              .map(function (c) {
                return (
                  '<tr>' +
                  '<td style="padding:4px 0;color:' +
                  SOFT +
                  ';white-space:nowrap;">' +
                  esc(String(c.at).slice(0, 10)) +
                  '</td>' +
                  '<td style="padding:4px 8px;color:' +
                  INK +
                  ';">' +
                  esc(c.customer) +
                  '</td>' +
                  '<td style="padding:4px 0;color:' +
                  MUTE +
                  ';white-space:nowrap;">' +
                  esc(c.number) +
                  '</td>' +
                  '<td style="padding:4px 0;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">' +
                  (g.metric === 'PRODUCT_UNITS' ? c.units + ' units' : money0(c.amountMinor)) +
                  '</td></tr>'
                );
              })
              .join('') +
            '</table>'
          : '<div style="font-size:12.5px;color:' +
            MUTE +
            ';">Nothing has landed in this period yet.</div>') +
        '</div>'
      : '';

    return card(
      '<div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">' +
        '<div style="flex:0 0 auto;">' +
        glassSvg(g.fill, g.hit, g.name) +
        '</div>' +
        '<div style="flex:1;min-width:200px;">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap;">' +
        '<div style="font-size:15px;font-weight:600;color:' +
        INK +
        ';">' +
        esc(g.name) +
        '</div>' +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';">' +
        esc(g.periodLabel) +
        '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';margin-top:2px;">' +
        esc(scope) +
        '</div>' +
        '<div style="font-family:Georgia,serif;font-size:27px;font-weight:600;color:' +
        NAVY +
        ';margin-top:8px;line-height:1.1;">' +
        fmtValue(g.actual, g.unit) +
        '<span style="font-family:inherit;font-size:14px;color:' +
        MUTE +
        ';font-weight:400;"> of ' +
        fmtValue(g.target, g.unit) +
        '</span>' +
        '</div>' +
        '<div style="font-size:12.5px;color:' +
        paceColor +
        ';font-weight:600;margin-top:4px;">' +
        (g.hit ? 'Target hit' : esc(pace)) +
        '</div>' +
        '<div style="font-size:12px;color:' +
        MUTE +
        ';margin-top:2px;">' +
        (g.hit
          ? fmtValue(g.actual - g.target, g.unit) + ' past the target'
          : fmtValue(g.remaining, g.unit) + ' to go') +
        ' · ' +
        g.daysLeft +
        ' day' +
        (g.daysLeft === 1 ? '' : 's') +
        ' left' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">' +
        '<button data-detail="' +
        g.id +
        '" style="font:inherit;font-size:12.5px;padding:6px 11px;border:1px solid ' +
        LINE +
        ';background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;color:' +
        ACCENT +
        ';">' +
        (expanded[g.id] ? 'Hide deals' : 'Show deals') +
        '</button>' +
        (can(MANAGE_ROLES)
          ? '<button data-edit="' +
            g.id +
            '" style="font:inherit;font-size:12.5px;padding:6px 11px;border:1px solid ' +
            LINE +
            ';background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;color:' +
            ACCENT +
            ';">Edit</button>' +
            '<button data-retire="' +
            g.id +
            '" style="font:inherit;font-size:12.5px;padding:6px 11px;border:1px solid ' +
            LINE +
            ';background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;color:' +
            SOFT +
            ';">' +
            (g.active === false ? 'Reinstate' : 'Retire') +
            '</button>' +
            '<button data-del="' +
            g.id +
            '" style="font:inherit;font-size:12.5px;padding:6px 11px;border:1px solid ' +
            LINE +
            ';background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;color:' +
            RED +
            ';">Delete</button>'
          : '') +
        '</div>' +
        '</div>' +
        '</div>' +
        contributors,
    );
  }

  /* ----------------------------------------------------------------- the form */

  function periodStartDefault() {
    var n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  function goalForm() {
    var g = editing || {};
    var metric = g.metric || 'REVENUE';
    return card(
      '<div style="font-size:14px;font-weight:600;color:' +
        INK +
        ';margin-bottom:12px;">' +
        (editing ? 'Edit goal' : 'New goal') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">' +
        field(
          'Name',
          '<input id="gfName" value="' +
            esc(g.name || '') +
            '" placeholder="e.g. October company revenue" style="' +
            FIELD +
            '">',
        ) +
        field(
          'What it measures',
          '<select id="gfMetric" style="' +
            FIELD +
            '">' +
            Object.keys(METRIC_LABEL)
              .map(function (k) {
                return (
                  '<option value="' +
                  k +
                  '"' +
                  (metric === k ? ' selected' : '') +
                  '>' +
                  METRIC_LABEL[k] +
                  '</option>'
                );
              })
              .join('') +
            '</select>',
        ) +
        field(
          'Period',
          '<select id="gfPeriod" style="' +
            FIELD +
            '">' +
            [
              ['MONTH', 'Month'],
              ['QUARTER', 'Quarter'],
              ['YEAR', 'Year'],
            ]
              .map(function (o) {
                return (
                  '<option value="' +
                  o[0] +
                  '"' +
                  ((g.period || 'MONTH') === o[0] ? ' selected' : '') +
                  '>' +
                  o[1] +
                  '</option>'
                );
              })
              .join('') +
            '</select>',
        ) +
        field(
          'Any date inside the period',
          '<input id="gfStart" type="date" value="' +
            esc((g.periodStart || '').slice(0, 10) || periodStartDefault()) +
            '" style="' +
            FIELD +
            '">',
          'The period is snapped to the whole month, quarter or year this date falls in.',
        ) +
        field(
          'Dollar target',
          '<input id="gfTargetMoney" type="number" step="1000" value="' +
            (g.unit === 'money' && g.target ? Math.round(g.target / 100) : '') +
            '" placeholder="250000" style="' +
            FIELD +
            '">',
          'Whole dollars. Used by the Revenue metric.',
        ) +
        field(
          'Count target',
          '<input id="gfTargetCount" type="number" step="1" value="' +
            (g.unit === 'count' && g.target ? g.target : '') +
            '" placeholder="12" style="' +
            FIELD +
            '">',
          'Deals, or units. Used by every metric except Revenue.',
        ) +
        field(
          'Whose goal',
          '<select id="gfOwner" style="' +
            FIELD +
            '"><option value="">Company (everyone)</option>' +
            reps
              .map(function (r) {
                return (
                  '<option value="' +
                  esc(r.id) +
                  '"' +
                  (g.ownerId === r.id ? ' selected' : '') +
                  '>' +
                  esc(r.name) +
                  '</option>'
                );
              })
              .join('') +
            '</select>',
        ) +
        field(
          'Part number or fragment',
          '<input id="gfSku" value="' +
            esc(g.skuMatch || '') +
            '" placeholder="e.g. SOAR, or K-4002" style="' +
            FIELD +
            '">',
          'Product units only. Matched against the SKU and the line name; optional lines are not counted.',
        ) +
        field(
          'Saved report',
          '<select id="gfReport" style="' +
            FIELD +
            '"><option value="">—</option>' +
            reports
              .map(function (r) {
                return (
                  '<option value="' +
                  esc(r.id) +
                  '"' +
                  (g.savedReportId === r.id ? ' selected' : '') +
                  '>' +
                  esc(r.name) +
                  '</option>'
                );
              })
              .join('') +
            '</select>',
          'Saved report only. The report\u2019s first number becomes the progress figure, measured over this period.',
        ) +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;">' +
        btn(editing ? 'Save changes' : 'Create goal', 'gfSave', 'primary') +
        btn('Cancel', 'gfCancel') +
        '</div>',
    );
  }

  function field(label, control, hint) {
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

  async function submitForm() {
    var v = function (id) {
      var el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    var metric = v('gfMetric') || 'REVENUE';
    var body = {
      name: v('gfName'),
      metric: metric,
      period: v('gfPeriod') || 'MONTH',
      periodStart: v('gfStart'),
      targetMinor: metric === 'REVENUE' ? Math.round(Number(v('gfTargetMoney') || 0) * 100) : 0,
      targetCount: metric === 'REVENUE' ? null : Math.round(Number(v('gfTargetCount') || 0)),
      ownerId: v('gfOwner') || null,
      skuMatch: v('gfSku') || null,
      savedReportId: v('gfReport') || null,
    };
    if (!body.name) {
      alert('Give the goal a name.');
      return;
    }
    var r = editing
      ? await authed('/insights/goals/' + editing.id, { method: 'PATCH', body: body })
      : await authed('/insights/goals', { method: 'POST', body: body });
    if (!r.ok) {
      alert(await failureText(r, 'The goal could not be saved.'));
      return;
    }
    formOpen = false;
    editing = null;
    await load();
    paint();
  }

  /* -------------------------------------------------------------------- paint */

  function summaryRow() {
    var goals = (data && data.goals) || [];
    var live = goals.filter(function (g) {
      return g.active !== false;
    });
    var hit = live.filter(function (g) {
      return g.hit;
    }).length;
    var behind = live.filter(function (g) {
      return !g.hit && g.paceDelta < 0;
    }).length;
    if (!live.length) return '';
    return (
      '<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:' +
      SOFT +
      ';margin-bottom:14px;">' +
      '<span><b style="color:' +
      INK +
      ';">' +
      live.length +
      '</b> live goal' +
      (live.length === 1 ? '' : 's') +
      '</span>' +
      '<span><b style="color:' +
      GREEN +
      ';">' +
      hit +
      '</b> hit</span>' +
      '<span><b style="color:' +
      (behind ? RED : INK) +
      ';">' +
      behind +
      '</b> behind pace</span>' +
      '</div>'
    );
  }

  function paint() {
    var host = document.getElementById('view');
    if (!host) return;
    var goals = (data && data.goals) || [];

    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
      '<div style="font-size:13px;color:' +
      MUTE +
      ';max-width:620px;line-height:1.5;">' +
      'Progress counts proposals the customer has accepted, dated by acceptance. Payment milestones are on Insights → Signed deals.' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      (can(MANAGE_ROLES)
        ? btn(formOpen ? 'Close form' : 'New goal', 'gNew', formOpen ? '' : 'primary')
        : '') +
      btn(showRetired ? 'Hide retired' : 'Show retired', 'gRetired') +
      '</div>' +
      '</div>' +
      (error ? '<div class="err">' + esc(error) + '</div>' : '') +
      (formOpen ? goalForm() + '<div style="height:14px;"></div>' : '') +
      summaryRow() +
      (goals.length
        ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;">' +
          goals
            .map(function (g) {
              return (
                '<div style="opacity:' +
                (g.active === false ? '0.55' : '1') +
                ';">' +
                goalCard(g) +
                '</div>'
              );
            })
            .join('') +
          '</div>'
        : '<div style="padding:34px;text-align:center;color:' +
          MUTE +
          ';font-size:13px;">' +
          'No goals yet.' +
          (can(MANAGE_ROLES)
            ? ' Press New goal to set the first one.'
            : ' Ask a manager to set one.') +
          '</div>');

    wire();
  }

  function wire() {
    var host = document.getElementById('view');
    if (!host) return;

    var nw = document.getElementById('gNew');
    if (nw) {
      nw.addEventListener('click', async function () {
        formOpen = !formOpen;
        editing = null;
        if (formOpen) await loadPickers();
        paint();
      });
    }
    var rt = document.getElementById('gRetired');
    if (rt) {
      rt.addEventListener('click', async function () {
        showRetired = !showRetired;
        await load();
        paint();
      });
    }
    var save = document.getElementById('gfSave');
    if (save) save.addEventListener('click', submitForm);
    var cancel = document.getElementById('gfCancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        formOpen = false;
        editing = null;
        paint();
      });
    }

    host.querySelectorAll('[data-detail]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-detail');
        expanded[id] = !expanded[id];
        paint();
      });
    });
    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-edit');
        editing = ((data && data.goals) || []).filter(function (g) {
          return g.id === id;
        })[0];
        if (!editing) return;
        formOpen = true;
        await loadPickers();
        paint();
      });
    });
    host.querySelectorAll('[data-retire]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-retire');
        var g = ((data && data.goals) || []).filter(function (x) {
          return x.id === id;
        })[0];
        if (!g) return;
        var r = await authed('/insights/goals/' + id, {
          method: 'PATCH',
          body: { active: g.active === false },
        });
        if (!r.ok) {
          alert(await failureText(r, 'The goal could not be changed.'));
          return;
        }
        await load();
        paint();
      });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-del');
        var g = ((data && data.goals) || []).filter(function (x) {
          return x.id === id;
        })[0];
        if (!g) return;
        if (
          !confirm(
            'Delete “' +
              g.name +
              '”?\n\nRetiring it instead keeps the record of a target that was set.',
          )
        )
          return;
        var r = await authed('/insights/goals/' + id, { method: 'DELETE' });
        if (!r.ok) {
          alert(await failureText(r, 'The goal could not be deleted.'));
          return;
        }
        await load();
        paint();
      });
    });
  }

  async function mount() {
    var host = document.getElementById('view');
    if (host)
      host.innerHTML =
        '<div style="padding:18px;color:' + MUTE + ';font-size:13px;">Loading&hellip;</div>';
    formOpen = false;
    editing = null;
    await load();
    paint();
  }

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

  window.SSGGoals = { mount: mount, install: install };
})();

// Customer-portal steps on the Orders pages — window.SSGOrderPortal.
//
// Three pieces, all about the same five portal steps (Delivery, Color, Billing,
// Contact, Required) that src/portal/orderPortal.ts records per order:
//
//   1. The Orders list's portal columns — the chip, the CSV value and the sort key
//      for each step, as column definitions app.js drops straight into ORDER_COLS.
//   2. The Orders list's filters — the row of controls under the header and the
//      Filters panel. They live here rather than in app.js because the filter model
//      is what the portal columns were added for ("what do I need to work next?"),
//      and because app.js is the busiest file in the repo: the less of this sits in
//      it, the less it collides with everything else being changed there.
//   3. The order page's Customer Portal card: every step, what the customer said,
//      who reviewed it, and the "Mark reviewed" / "Sync from portal" buttons.
//
// What it needs
// -------------
// Primitives off window.SSGUI (ssg-ui.js is the first script in index.html, and
// client-scripts.test.ts asserts it), and `authed` from the shell, passed in by
// each call rather than injected at boot so app.js needs no boot-time wiring for it.
//
// The pure helpers (chips, sort keys, filter matching, phone formatting, answer
// rendering) are exposed on window.SSGOrderPortal as well, and pinned by
// tests/unit/order-portal.test.ts without a browser.

(function () {
  'use strict';

  var U = window.SSGUI;
  var esc = U.esc,
    titleCase = U.titleCase,
    fmtDate = U.fmtDate,
    isoLocal = U.isoLocal,
    openModal = U.openModal,
    serverMessage = U.serverMessage;

  /* ────────────────────────── the five steps ────────────────────────── */

  /** Column order, and the order the order page lists them in. */
  var KINDS = ['DELIVERY', 'COLOR', 'BILLING', 'CONTACT', 'REQUIRED'];

  /** Column headers on the list. Contact and Required carry a "Portal:" prefix because
   *  on their own the words read as something else entirely (a contact, a flag). */
  var COLUMN_LABEL = {
    DELIVERY: 'Delivery',
    COLOR: 'Color',
    BILLING: 'Billing',
    CONTACT: 'Portal: Contact',
    REQUIRED: 'Portal: Required',
  };
  /** The same steps as the order page's card names them. */
  var CARD_LABEL = {
    DELIVERY: 'Delivery & site details',
    COLOR: 'Color selections',
    BILLING: 'Billing details',
    CONTACT: 'Contact information',
    REQUIRED: 'Required information',
  };
  /** On by default in the list; the other two are in the Columns chooser. */
  var DEFAULT_VISIBLE = ['DELIVERY', 'COLOR', 'BILLING'];

  /** The four things a step can show, and what a filter calls them. */
  var DISPLAY_OPTIONS = [
    { value: 'NEW', label: 'New' },
    { value: 'REVIEWED', label: 'Reviewed' },
    { value: 'NONE', label: '- (not provided)' },
    { value: 'NA', label: 'N/A' },
  ];

  /** Sort rank: new first (it's the work), then reviewed, then N/A, then nothing yet. */
  var RANK = { NEW: 0, REVIEWED: 1, NA: 2, NONE: 3 };

  // Chip colours are the app's own: amber is the In-progress chip, green the
  // Complete chip, grey the Cancelled chip (ssg-ui.js handoffStatusChip).
  var CHIP = {
    NEW: ['#fdf6e3', '#eadfbe', '#8a6d1f'],
    REVIEWED: ['#eaf3ee', '#cfe3d7', '#2f7d5d'],
    NA: ['#f2f3ef', '#dcded7', '#8a8f85'],
  };
  /** The amber of the "new portal information" row marker. Same as the proposals
   *  list's "soon" bar, so the two lists speak one visual language. */
  var NEW_MARKER = '#c9a227';

  /** A missing or malformed step reads as "nothing yet", never as a crash. */
  function entryOf(row, kind) {
    var p = row && row.portal;
    var e = p && p[kind];
    var d = e && e.display;
    return { display: RANK[d] == null ? 'NONE' : d, obtainedAt: (e && e.obtainedAt) || null };
  }

  function toDate(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    return isNaN(d) ? null : d;
  }

  /** "Sep 22" this year, "Sep 22, 2025" otherwise. */
  function shortDate(v, now) {
    var d = toDate(v);
    if (!d) return '';
    var n = now ? new Date(now) : new Date();
    var o = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== n.getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }

  function chipSpan(c, text, title) {
    return (
      '<span' +
      (title ? ' title="' + esc(title) + '"' : '') +
      ' style="display:inline-block;background:' +
      c[0] +
      ';border:1px solid ' +
      c[1] +
      ';color:' +
      c[2] +
      ';border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;white-space:nowrap;">' +
      esc(text) +
      '</span>'
    );
  }

  /** The cell: amber "New · Sep 22", green "Reviewed · Sep 22", muted "-", grey "N/A". */
  function chipHtml(entry, now) {
    var e = entry || { display: 'NONE' };
    if (e.display === 'NA') return chipSpan(CHIP.NA, 'N/A', 'Not applicable to this job');
    if (e.display !== 'NEW' && e.display !== 'REVIEWED') {
      return '<span class="muted" title="Not provided by the customer yet">-</span>';
    }
    var word = e.display === 'NEW' ? 'New' : 'Reviewed';
    var day = shortDate(e.obtainedAt, now);
    var title =
      (e.display === 'NEW' ? 'Not reviewed yet' : 'Reviewed') +
      (e.obtainedAt ? ' — received ' + fmtDate(e.obtainedAt) : '');
    return chipSpan(CHIP[e.display], day ? word + ' · ' + day : word, title);
  }

  /** The CSV value: "New 2026-09-22", "Reviewed 2026-09-22", "-", "N/A". */
  function plainOf(entry) {
    var e = entry || { display: 'NONE' };
    if (e.display === 'NA') return 'N/A';
    if (e.display !== 'NEW' && e.display !== 'REVIEWED') return '-';
    var d = toDate(e.obtainedAt);
    return (e.display === 'NEW' ? 'New' : 'Reviewed') + (d ? ' ' + isoLocal(d) : '');
  }

  /** Rank first (New < Reviewed < N/A < -), then the date it was obtained. */
  function sortKeyOf(entry) {
    var e = entry || { display: 'NONE' };
    var d = toDate(e.obtainedAt);
    return (RANK[e.display] == null ? 3 : RANK[e.display]) * 1e13 + (d ? d.getTime() : 0);
  }

  /** Any step with information nobody has reviewed yet — the "work this next" rows. */
  function hasNew(row) {
    for (var i = 0; i < KINDS.length; i++)
      if (entryOf(row, KINDS[i]).display === 'NEW') return true;
    return false;
  }

  /**
   * One ORDER_COLS entry per step. Adding a sixth portal step to the list is adding
   * it to KINDS and the two label maps above — nothing in app.js changes.
   */
  function columns() {
    return KINDS.map(function (k) {
      return {
        key: 'portal' + k.charAt(0) + k.slice(1).toLowerCase(),
        label: COLUMN_LABEL[k],
        portalKind: k,
        filter: 'portal',
        defaultOn: DEFAULT_VISIBLE.indexOf(k) !== -1,
        cell: function (o) {
          return chipHtml(entryOf(o, k));
        },
        plain: function (o) {
          return plainOf(entryOf(o, k));
        },
        sort: function (o) {
          return sortKeyOf(entryOf(o, k));
        },
      };
    });
  }

  /* ────────────────────────── small formatters ────────────────────────── */

  /** "(555) 123-4567" for a ten-digit North American number; anything else as given. */
  function fmtPhone(v) {
    var s = String(v == null ? '' : v).trim();
    var digits = s.replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    if (digits.length !== 10 || /[a-z]/i.test(s.replace(/\b(ext|x)\b.*$/i, ''))) return s;
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  /** "just now", "4 min ago", "3 h ago", "2 days ago", then the date. */
  function relTime(iso, now) {
    var d = toDate(iso);
    if (!d) return 'never';
    var s = Math.max(0, Math.round(((now == null ? Date.now() : now) - d.getTime()) / 1000));
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var days = Math.round(h / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return 'on ' + fmtDate(iso);
  }

  /** "preferredDeliveryDate" / "billing_zip" → "Preferred delivery date" / "Billing zip". */
  function humanize(key) {
    var s = String(key || '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim()
      .toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ────────────────────────── list filters ────────────────────────── */

  // A filter value per column, by the column's `filter` type:
  //   text   — a string. Contains, case-insensitive; or ">1000", "<=5", "=3" for a
  //            number, compared against the column's CSV value.
  //   date   — { preset, from, to }. preset '' is any; '7' / '30' / '90' days back;
  //            'year' this calendar year; 'none' no date; 'custom' uses from/to.
  //   status — an array of order statuses (the row's dropdown sets one; the Filters
  //            panel can set several).
  //   portal — one of NEW / REVIEWED / NONE / NA, or '' for all.
  //   choice — one of the column's distinct CSV values, or '' for all.

  var DATE_PRESETS = [
    { value: '', label: 'Any' },
    { value: '7', label: 'Last 7 days' },
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
    { value: 'year', label: 'This year' },
    { value: 'none', label: 'No date' },
    { value: 'custom', label: 'From / to…' },
  ];

  function typeOf(col) {
    return col.filter || 'text';
  }

  function isActive(col, v) {
    var t = typeOf(col);
    if (v == null) return false;
    if (t === 'date') return !!(v.preset && (v.preset !== 'custom' || v.from || v.to));
    if (t === 'status') return Array.isArray(v) ? v.length > 0 : !!v;
    return String(v).trim() !== '';
  }

  var NUM_TEST = /^(<=|>=|<|>|=)\s*\$?\s*(-?[\d,]*\.?\d+)$/;

  function matchText(col, row, v) {
    var q = String(v).trim();
    var plain = String(col.plain(row) == null ? '' : col.plain(row));
    var m = NUM_TEST.exec(q);
    if (m) {
      var x = parseFloat(plain.replace(/[$,\s]/g, ''));
      var n = parseFloat(m[2].replace(/,/g, ''));
      if (isNaN(x)) return false;
      if (m[1] === '<') return x < n;
      if (m[1] === '<=') return x <= n;
      if (m[1] === '>') return x > n;
      if (m[1] === '>=') return x >= n;
      return x === n;
    }
    return plain.toLowerCase().indexOf(q.toLowerCase()) !== -1;
  }

  function matchDate(col, row, v, now) {
    var d = toDate(col.plain(row));
    if (v.preset === 'none') return !d;
    if (!d) return false;
    var day = isoLocal(d);
    var n = now == null ? new Date() : new Date(now);
    if (v.preset === 'custom') return (!v.from || day >= v.from) && (!v.to || day <= v.to);
    if (v.preset === 'year') return d.getFullYear() === n.getFullYear();
    var back = new Date(n.getFullYear(), n.getMonth(), n.getDate() - Number(v.preset));
    return day >= isoLocal(back);
  }

  /** Whether one row passes one column's filter. An inactive filter passes everything. */
  function matchFilter(col, row, v, now) {
    if (!isActive(col, v)) return true;
    var t = typeOf(col);
    if (t === 'date') return matchDate(col, row, v, now);
    if (t === 'status') {
      var list = Array.isArray(v) ? v : [v];
      return list.indexOf(row.status) !== -1;
    }
    if (t === 'portal') return entryOf(row, col.portalKind).display === v;
    if (t === 'choice') return String(col.plain(row) || '') === String(v);
    return matchText(col, row, v);
  }

  /**
   * Whether a row passes every column filter in `state.cols` (visible or not — a
   * filter on a hidden column still applies, and still counts) plus "has anything
   * unreviewed".
   */
  function rowPasses(allCols, state, row, now) {
    if (state.unreviewed && !hasNew(row)) return false;
    var f = state.cols || {};
    for (var i = 0; i < allCols.length; i++) {
      var c = allCols[i];
      if (!matchFilter(c, row, f[c.key], now)) return false;
    }
    return true;
  }

  /** How many filters are on, counting "has anything unreviewed" as one. */
  function activeCount(allCols, state) {
    var f = (state && state.cols) || {};
    var n = state && state.unreviewed ? 1 : 0;
    for (var i = 0; i < allCols.length; i++) if (isActive(allCols[i], f[allCols[i].key])) n++;
    return n;
  }

  var FIELD =
    'padding:5px 7px;border:1px solid #dcded7;border-radius:7px;font-size:12px;background:#fff;color:#20241f;font-weight:400;text-transform:none;letter-spacing:0;';

  function optionsHtml(opts, selected) {
    return opts
      .map(function (o) {
        return (
          '<option value="' +
          esc(o.value) +
          '"' +
          (String(o.value) === String(selected) ? ' selected' : '') +
          '>' +
          esc(o.label) +
          '</option>'
        );
      })
      .join('');
  }

  /** The date control: a preset dropdown, and from/to boxes when "From / to…" is picked. */
  function dateControlHtml(key, v, cls, wide) {
    v = v || {};
    var custom = v.preset === 'custom';
    return (
      '<select class="' +
      cls +
      '" data-fk="' +
      esc(key) +
      '" data-part="preset" style="' +
      FIELD +
      (wide ? '' : 'width:100%;') +
      '">' +
      optionsHtml(DATE_PRESETS, v.preset || '') +
      '</select>' +
      (custom
        ? '<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">' +
          '<input type="date" class="' +
          cls +
          '" data-fk="' +
          esc(key) +
          '" data-part="from" value="' +
          esc(v.from || '') +
          '" title="From" style="' +
          FIELD +
          '">' +
          '<input type="date" class="' +
          cls +
          '" data-fk="' +
          esc(key) +
          '" data-part="to" value="' +
          esc(v.to || '') +
          '" title="To" style="' +
          FIELD +
          '">' +
          '</div>'
        : '')
    );
  }

  /** Distinct CSV values of a column, for its dropdown. */
  function choicesOf(col, rows) {
    var seen = {};
    var out = [];
    rows.forEach(function (r) {
      var p = String(col.plain(r) || '');
      if (p && !seen[p]) {
        seen[p] = true;
        out.push(p);
      }
    });
    return out.sort();
  }

  /** One cell of the filter row. */
  function filterCellHtml(col, v, ctx) {
    var t = typeOf(col);
    var key = col.key;
    if (t === 'date') return dateControlHtml(key, v, 'ordFilt', false);
    if (t === 'status') {
      var list = Array.isArray(v) ? v : v ? [v] : [];
      var opts = [{ value: '', label: 'All' }].concat(
        ctx.statuses.map(function (s) {
          return { value: s, label: titleCase(s) };
        }),
      );
      // Several statuses picked in the Filters panel can't be shown as one pick here;
      // say so rather than pretend it's "All".
      if (list.length > 1) opts.push({ value: '__multi', label: list.length + ' selected' });
      var sel = list.length > 1 ? '__multi' : list[0] || '';
      return (
        '<select class="ordFilt" data-fk="' +
        esc(key) +
        '" style="' +
        FIELD +
        'width:100%;">' +
        optionsHtml(opts, sel) +
        '</select>'
      );
    }
    if (t === 'portal') {
      return (
        '<select class="ordFilt" data-fk="' +
        esc(key) +
        '" style="' +
        FIELD +
        'width:100%;">' +
        optionsHtml([{ value: '', label: 'All' }].concat(DISPLAY_OPTIONS), v || '') +
        '</select>'
      );
    }
    if (t === 'choice') {
      return (
        '<select class="ordFilt" data-fk="' +
        esc(key) +
        '" style="' +
        FIELD +
        'width:100%;">' +
        optionsHtml(
          [{ value: '', label: 'All' }].concat(
            choicesOf(col, ctx.rows).map(function (p) {
              return { value: p, label: p };
            }),
          ),
          v || '',
        ) +
        '</select>'
      );
    }
    return (
      '<input class="ordFilt" data-fk="' +
      esc(key) +
      '" value="' +
      esc(v || '') +
      '" placeholder="Filter…" title="Contains this text. For numbers you can also type >1000, <=5 or =3." style="' +
      FIELD +
      'width:100%;min-width:70px;box-sizing:border-box;">'
    );
  }

  /** Read one date control back out of the DOM it was rendered into. */
  function readDate(scope, key, cls) {
    var get = function (part) {
      var el = scope.querySelector('.' + cls + '[data-fk="' + key + '"][data-part="' + part + '"]');
      return el ? el.value : '';
    };
    var preset = get('preset');
    return {
      preset: preset,
      from: preset === 'custom' ? get('from') : '',
      to: preset === 'custom' ? get('to') : '',
    };
  }

  /**
   * The filter row, directly under the header row. Built into the table's <thead>
   * once per full repaint; typing into it only repaints the body (`onChange`), so the
   * box being typed into keeps its focus.
   */
  function mountFilterRow(opts) {
    var thead = opts.table.querySelector('thead');
    if (!thead) return;
    var ctx = { statuses: opts.statuses, rows: opts.rows };
    var f = opts.state.cols || (opts.state.cols = {});
    var tr = document.createElement('tr');
    tr.className = 'ordFilterRow';
    tr.innerHTML = opts.cols
      .map(function (c) {
        return (
          '<th data-fcell="' +
          esc(c.key) +
          '" style="text-align:left;padding:6px 10px 8px;border-bottom:1px solid #eef0ea;background:#f7f8f4;vertical-align:top;font-weight:400;">' +
          filterCellHtml(c, f[c.key], ctx) +
          '</th>'
        );
      })
      .join('');
    thead.appendChild(tr);

    function read(el) {
      var key = el.getAttribute('data-fk');
      var col = opts.cols.filter(function (c) {
        return c.key === key;
      })[0];
      if (!col) return;
      var t = typeOf(col);
      if (t === 'date') {
        var before = (f[key] && f[key].preset) || '';
        f[key] = readDate(tr, key, 'ordFilt');
        // Picking "From / to…" has to show the two boxes, so that one cell re-renders.
        if ((before === 'custom') !== (f[key].preset === 'custom')) {
          var cell = tr.querySelector('[data-fcell="' + key + '"]');
          if (cell) {
            cell.innerHTML = filterCellHtml(col, f[key], ctx);
            wire(cell);
          }
        }
      } else if (t === 'status') {
        if (el.value === '__multi') return;
        f[key] = el.value ? [el.value] : [];
      } else {
        f[key] = el.value;
      }
      opts.onChange();
    }
    function wire(scope) {
      scope.querySelectorAll('.ordFilt').forEach(function (el) {
        // Clicking into a filter must not count as a click on the header (a sort).
        el.addEventListener('click', function (e) {
          e.stopPropagation();
        });
        el.addEventListener(
          el.tagName === 'INPUT' && el.type !== 'date' ? 'input' : 'change',
          function () {
            read(el);
          },
        );
      });
    }
    wire(tr);
  }

  /**
   * The Filters panel: the handful of filters people actually combine, in one place.
   * It edits the same state as the filter row, so the two can never disagree.
   */
  function openFiltersPanel(opts) {
    var state = opts.state;
    var f = state.cols || (state.cols = {});
    var byKey = function (k) {
      return opts.allCols.filter(function (c) {
        return c.key === k;
      })[0];
    };
    var statusVal = Array.isArray(f.status) ? f.status : f.status ? [f.status] : [];
    var portalCols = opts.allCols.filter(function (c) {
      return c.filter === 'portal';
    });
    var lab = 'font-size:12px;font-weight:600;color:#5c6157;margin:14px 0 6px;';
    var body =
      '<div class="muted" style="font-size:12.5px;line-height:1.5;">These work together with the search box, the status list and the filter row under the table headings. Filters on columns you have hidden still apply.</div>' +
      '<div style="' +
      lab +
      '">Status</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px 12px;">' +
      opts.statuses
        .map(function (s) {
          return (
            '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" class="fpStatus" value="' +
            esc(s) +
            '"' +
            (statusVal.indexOf(s) !== -1 ? ' checked' : '') +
            '>' +
            esc(titleCase(s)) +
            '</label>'
          );
        })
        .join('') +
      '</div>' +
      '<div style="' +
      lab +
      '">Customer</div>' +
      '<input id="fpCustomer" value="' +
      esc(f.customer || '') +
      '" placeholder="Customer name contains…" style="' +
      U.IN +
      '">' +
      (byKey('signedAt')
        ? '<div style="' +
          lab +
          '">Signed</div><div class="fpDateBox" data-fk="signedAt">' +
          dateControlHtml('signedAt', f.signedAt, 'fpDate', true) +
          '</div>'
        : '') +
      (byKey('createdAt')
        ? '<div style="' +
          lab +
          '">Created</div><div class="fpDateBox" data-fk="createdAt">' +
          dateControlHtml('createdAt', f.createdAt, 'fpDate', true) +
          '</div>'
        : '') +
      '<div style="' +
      lab +
      '">Customer portal</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;">' +
      portalCols
        .map(function (c) {
          return (
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12.5px;">' +
            esc(c.label) +
            '<select class="fpPortal" data-fk="' +
            esc(c.key) +
            '" style="' +
            FIELD +
            'font-size:13px;padding:7px 9px;">' +
            optionsHtml([{ value: '', label: 'All' }].concat(DISPLAY_OPTIONS), f[c.key] || '') +
            '</select></label>'
          );
        })
        .join('') +
      '</div>' +
      '<label style="display:flex;gap:8px;align-items:center;font-size:13.5px;margin-top:14px;cursor:pointer;"><input type="checkbox" id="fpUnreviewed"' +
      (state.unreviewed ? ' checked' : '') +
      '> Has anything unreviewed from the customer portal</label>' +
      '<div style="margin-top:12px;"><button type="button" class="link-btn" id="fpClear" style="width:auto;padding:7px 13px;">Clear all filters</button></div>';

    var form = null;
    openModal(
      'Filters',
      body,
      function (close) {
        var scope = form || document;
        f.status = [];
        scope.querySelectorAll('.fpStatus').forEach(function (c) {
          if (c.checked) f.status.push(c.value);
        });
        var cust = scope.querySelector('#fpCustomer');
        f.customer = cust ? cust.value.trim() : '';
        ['signedAt', 'createdAt'].forEach(function (k) {
          if (scope.querySelector('.fpDate[data-fk="' + k + '"]'))
            f[k] = readDate(scope, k, 'fpDate');
        });
        scope.querySelectorAll('.fpPortal').forEach(function (s) {
          f[s.getAttribute('data-fk')] = s.value;
        });
        var un = scope.querySelector('#fpUnreviewed');
        state.unreviewed = !!(un && un.checked);
        close();
        opts.onApply();
      },
      'Apply filters',
      { maxWidth: '560px' },
    );

    // The newest dialog's form: openModal always gives it id "mForm", and a dialog
    // opened over another would otherwise find the older one first.
    var forms = document.querySelectorAll('#mForm');
    form = forms[forms.length - 1] || null;
    if (!form) return;
    // "From / to…" shows its two boxes in the panel too.
    form.addEventListener('change', function (e) {
      var el = e.target;
      if (
        !el.classList ||
        !el.classList.contains('fpDate') ||
        el.getAttribute('data-part') !== 'preset'
      )
        return;
      var key = el.getAttribute('data-fk');
      var box = form.querySelector('.fpDateBox[data-fk="' + key + '"]');
      if (box) box.innerHTML = dateControlHtml(key, readDate(form, key, 'fpDate'), 'fpDate', true);
    });
    var clr = form.querySelector('#fpClear');
    if (clr)
      clr.addEventListener('click', function () {
        form.querySelectorAll('.fpStatus').forEach(function (c) {
          c.checked = false;
        });
        var cust = form.querySelector('#fpCustomer');
        if (cust) cust.value = '';
        form.querySelectorAll('.fpPortal').forEach(function (s) {
          s.value = '';
        });
        form.querySelectorAll('.fpDate[data-part="preset"]').forEach(function (s) {
          s.value = '';
          s.dispatchEvent(new Event('change', { bubbles: true }));
        });
        var un = form.querySelector('#fpUnreviewed');
        if (un) un.checked = false;
      });
  }

  /* ────────────────────────── the list's refresh ────────────────────────── */

  var tick = null;

  /**
   * Refresh every order's portal steps from monday, and say how fresh they are.
   *
   * Called on every open of the Orders page (the server throttles that to once a
   * minute across everyone) and by the Refresh button (`force`). `onChanged` runs
   * when the refresh actually changed something, so the rows can be reloaded; a
   * failure is shown beside the button and never blocks the page.
   */
  async function refreshList(opts) {
    var bar = opts.bar;
    var btn = bar && bar.querySelector('#ordPortalRefresh');
    var txt = bar && bar.querySelector('#ordPortalAt');
    var errEl = bar && bar.querySelector('#ordPortalErr');
    if (btn) {
      btn.disabled = true;
      btn.textContent = opts.force ? 'Refreshing…' : 'Checking…';
    }
    if (opts.force && txt) txt.textContent = 'Reading the customer portal from monday.com…';
    var res = null;
    try {
      var r = await opts.authed('/orders/portal/refresh', {
        method: 'POST',
        body: { force: !!opts.force },
        timeoutMs: 180000,
      });
      res = r.ok
        ? await r.json()
        : { error: await serverMessage(r, 'The portal refresh failed (' + r.status + ').') };
    } catch (e) {
      res = { error: (e && e.message) || 'Could not reach the server.' };
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
    if (!bar || !document.body.contains(bar)) return res;
    if (res.at) bar.setAttribute('data-at', res.at);
    paintAt(bar);
    if (errEl) {
      errEl.textContent = res.error ? 'Portal refresh: ' + res.error : '';
      errEl.style.display = res.error ? '' : 'none';
    }
    if (opts.force && !res.error && res.refreshed) {
      U.toast(
        'Portal refreshed' +
          (res.itemsChanged
            ? ' — ' + res.itemsChanged + ' step' + (res.itemsChanged === 1 ? '' : 's') + ' changed.'
            : ' — nothing new.'),
      );
    }
    if (res.refreshed && res.itemsChanged > 0 && opts.onChanged) opts.onChanged(res);
    // Keep "2 min ago" true while the page is open; stops itself once it is not.
    if (tick) clearInterval(tick);
    tick = setInterval(function () {
      if (!document.body.contains(bar)) {
        clearInterval(tick);
        tick = null;
        return;
      }
      paintAt(bar);
    }, 30000);
    return res;
  }
  function paintAt(bar) {
    var txt = bar.querySelector('#ordPortalAt');
    if (!txt) return;
    var at = bar.getAttribute('data-at');
    txt.textContent = at ? 'Portal data refreshed ' + relTime(at) : 'Portal data not refreshed yet';
    if (at) txt.title = U.fmtDateTime(at);
  }

  /* ────────────────────────── answers, readably ────────────────────────── */

  function isBlank(v) {
    return v == null || (typeof v === 'string' && v.trim() === '');
  }
  function yesNo(v) {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return String(v);
  }
  function isPhoneKey(k) {
    return /phone|mobile|textnumber|text_number|cell/i.test(k);
  }

  /** label → value rows. Values are already HTML; blank rows are dropped. */
  function kv(pairs) {
    var rows = pairs.filter(function (p) {
      return !isBlank(p[1]);
    });
    if (!rows.length) return '';
    return (
      '<div style="display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:4px 14px;font-size:13px;line-height:1.5;">' +
      rows
        .map(function (p) {
          return (
            '<div class="muted">' +
            esc(p[0]) +
            '</div><div style="white-space:pre-wrap;overflow-wrap:anywhere;">' +
            p[1] +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }
  function t(v) {
    return isBlank(v) ? '' : esc(yesNo(v));
  }
  function dateT(v) {
    return isBlank(v) ? '' : esc(toDate(v) ? fmtDate(v) : String(v));
  }
  function phoneT(v) {
    return isBlank(v) ? '' : esc(fmtPhone(v));
  }
  function lines(parts) {
    var l = parts
      .filter(function (p) {
        return !isBlank(p);
      })
      .map(function (p) {
        return esc(String(p));
      });
    return l.join('<br>');
  }
  function cityLine(city, region, postal) {
    var cr = [city, region]
      .filter(function (p) {
        return !isBlank(p);
      })
      .join(', ');
    return [cr, postal]
      .filter(function (p) {
        return !isBlank(p);
      })
      .join(' ');
  }
  function sub(title, html) {
    return html
      ? '<div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;margin:12px 0 5px;">' +
          esc(title) +
          '</div>' +
          html
      : '';
  }
  function contact(name, phone, email, comm, text) {
    return kv([
      ['Name', t(name)],
      ['Phone', phoneT(phone)],
      ['Email', isBlank(email) ? '' : '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>'],
      ['Preferred contact', t(comm)],
      ['Text / mobile', phoneT(text)],
    ]);
  }

  /** Anything we don't have a layout for: every key, in the order given. */
  function genericHtml(v, depth) {
    depth = depth || 0;
    if (isBlank(v)) return '';
    if (Array.isArray(v)) {
      if (
        v.every(function (x) {
          return x == null || typeof x !== 'object';
        })
      )
        return esc(
          v
            .filter(function (x) {
              return !isBlank(x);
            })
            .map(yesNo)
            .join(', '),
        );
      return v
        .map(function (x) {
          return genericHtml(x, depth + 1);
        })
        .join('<hr style="border:none;border-top:1px solid #eef0ea;margin:6px 0;">');
    }
    if (typeof v !== 'object') return esc(yesNo(v));
    if (depth > 4) return esc(JSON.stringify(v));
    return kv(
      Object.keys(v).map(function (k) {
        var x = v[k];
        if (x && typeof x === 'object') return [humanize(k), genericHtml(x, depth + 1)];
        if (typeof x === 'string' && isPhoneKey(k)) return [humanize(k), phoneT(x)];
        return [humanize(k), t(x)];
      }),
    );
  }

  function deliveryHtml(a) {
    var addr = lines([a.line1, a.line2, cityLine(a.city, a.region, a.postalCode), a.country]);
    var ack = [a.freightAckBy, a.freightAckDate ? 'on ' + fmtDate(a.freightAckDate) : '']
      .filter(function (p) {
        return !isBlank(p);
      })
      .join(' ');
    return (
      kv([
        ['Ship-to address', addr],
        ['Address confirmed', t(a.addressConfirmed)],
        ['Submitted', dateT(a.submittedDate)],
        ['Loading dock', t(a.loadingDock)],
        ['Delivery timing', t(a.deliveryTiming)],
        ['Preferred delivery date', dateT(a.preferredDeliveryDate)],
        ['Special instructions', t(a.specialInstructions)],
        ['Restricted changes', t(a.restrictedChanges)],
        ['Freight acknowledged', esc(ack)],
      ]) +
      sub(
        'Primary point of contact',
        contact(a.pocName, a.pocPhone, a.pocEmail, a.preferredComm, a.textNumber),
      ) +
      sub(
        'Secondary point of contact',
        contact(
          a.secondaryPocName,
          a.secondaryPocPhone,
          a.secondaryPocEmail,
          a.secondaryPreferredComm,
          a.secondaryMobile,
        ),
      )
    );
  }

  function billingHtml(a) {
    var addr = lines([
      a.billingAddress,
      a.billingAddressSuite,
      cityLine(a.billingCity, a.billingState, a.billingZip),
      a.billingCountry,
    ]);
    var same =
      a.billingContactSameAsPrimary === true ||
      /^(yes|true)$/i.test(String(a.billingContactSameAsPrimary || ''));
    return (
      kv([['Billing address', addr]]) +
      sub(
        'Billing contact',
        (same
          ? '<div style="font-size:13px;margin-bottom:4px;">Same as the primary point of contact</div>'
          : '') + contact(a.billingName, a.billingPhone, a.billingEmail),
      )
    );
  }

  function colorHtml(a) {
    var sel = a.selections && typeof a.selections === 'object' ? a.selections : {};
    var groups = Object.keys(sel)
      .map(function (g) {
        var areas = sel[g] && typeof sel[g] === 'object' ? sel[g] : {};
        var rows = Object.keys(areas).map(function (area) {
          var p = areas[area] || {};
          var pick =
            typeof p === 'object'
              ? [isBlank(p.brand) ? '' : titleCase(String(p.brand)), p.code]
                  .filter(function (x) {
                    return !isBlank(x);
                  })
                  .join(' ')
              : String(p);
          return [humanize(area), pick ? '<b style="font-weight:600;">' + esc(pick) + '</b>' : ''];
        });
        return sub(
          humanize(g),
          kv(rows) || '<div class="muted" style="font-size:13px;">No picks</div>',
        );
      })
      .join('');
    var up = a.totalUpcharge;
    var upT = isBlank(up)
      ? ''
      : typeof up === 'number' && isFinite(up)
        ? '$' + up.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : esc(String(up));
    var extra = kv([
      ['Total upcharge', upT],
      ['Confirmed', dateT(a.confirmedAt)],
    ]);
    return (
      (groups || '<div class="muted" style="font-size:13px;">No areas answered.</div>') +
      (extra ? '<div style="margin-top:10px;">' + extra + '</div>' : '')
    );
  }

  /**
   * The customer's answers for one step, readably. Delivery, billing and colour get
   * their own layout when the answers have the shape the server documents; anything
   * else (the Manufacturing board's own JSON, a shape the portal adds later) is
   * shown key by key rather than failing or being hidden.
   */
  function answersHtml(kind, a) {
    if (kind === 'CONTACT' || kind === 'REQUIRED') return '';
    if (isBlank(a)) return '';
    if (typeof a !== 'object' || Array.isArray(a)) return genericHtml(a);
    if (kind === 'DELIVERY' && ('line1' in a || 'pocName' in a || 'loadingDock' in a))
      return deliveryHtml(a);
    if (kind === 'BILLING' && ('billingAddress' in a || 'billingName' in a || 'billingCity' in a))
      return billingHtml(a);
    if (kind === 'COLOR' && a.selections && typeof a.selections === 'object') return colorHtml(a);
    return genericHtml(a);
  }

  /* ────────────────────────── the order page card ────────────────────────── */

  /** What a delivery change looks like — the ship-to on the BOM depends on it. */
  function deliverySignature(items) {
    var d = (items || []).filter(function (i) {
      return i.kind === 'DELIVERY';
    })[0];
    return d ? JSON.stringify([d.display, d.obtainedAt, d.answers]) : '';
  }

  function reviewNoteHtml(kind, res) {
    if (!res) return '';
    var parts = [];
    if (res.mondayNote)
      parts.push(
        '<div><b style="font-weight:600;">monday.com:</b> ' + esc(res.mondayNote) + '</div>',
      );
    var c = res.colors;
    if (c) {
      parts.push(
        '<div>' +
          (c.linesUpdated
            ? 'Applied to ' +
              c.linesUpdated +
              ' Bill of Materials line' +
              (c.linesUpdated === 1 ? '' : 's') +
              '.'
            : 'No Bill of Materials lines were changed.') +
          '</div>',
      );
      var list = function (title, xs, why) {
        return xs && xs.length
          ? '<div style="margin-top:4px;"><b style="font-weight:600;">' +
              esc(title) +
              '</b> ' +
              esc(why) +
              '<ul style="margin:3px 0 0 18px;padding:0;">' +
              xs
                .map(function (x) {
                  return '<li>' + esc(x) + '</li>';
                })
                .join('') +
              '</ul></div>'
          : '';
      };
      parts.push(
        list(
          'Areas with no parts mapped',
          c.unmappedAreas,
          '— map them in Administration, then set these lines by hand:',
        ),
      );
      parts.push(list('Areas whose parts are not on this order', c.noMatchingLines, ''));
      // Shown so a line left alone is never mistaken for one that was coloured.
      parts.push(
        list(
          'Parts left unchanged — two areas asked for different colours',
          (c.conflicts || []).map(function (x) {
            return x.sku + ': ' + (x.areas || []).join('; ');
          }),
          '— set these lines by hand:',
        ),
      );
      parts.push(
        list(
          "Pieces whose colour is not on the part's vendor chart",
          c.offChart || [],
          '— add the colour to the chart, or set the piece by hand:',
        ),
      );
      parts.push(
        list(
          'Vendors already submitted, left unchanged',
          c.skippedVendors,
          '— change their lines by hand if needed:',
        ),
      );
    }
    var html = parts.filter(Boolean).join('');
    if (!html) return '';
    var warn = !!(
      res.mondayNote ||
      (c &&
        (c.unmappedAreas.length ||
          c.noMatchingLines.length ||
          c.skippedVendors.length ||
          (c.conflicts || []).length ||
          (c.offChart || []).length))
    );
    return (
      '<div style="margin-top:10px;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.5;border:1px solid ' +
      (warn
        ? '#eadfbe;background:#fdf6e3;color:#8a6d1f;'
        : '#cfe3d7;background:#eaf3ee;color:#2f6b4c;') +
      '">' +
      html +
      '</div>'
    );
  }

  function itemHtml(it, st) {
    var entry = { display: it.display, obtainedAt: it.obtainedAt };
    var meta = [];
    if (it.obtainedAt) meta.push('Received ' + esc(fmtDate(it.obtainedAt)));
    if (it.display === 'REVIEWED' && it.reviewedAt) {
      meta.push(
        'Reviewed by ' + esc(it.reviewedBy || 'someone') + ' on ' + esc(fmtDate(it.reviewedAt)),
      );
    } else if (it.display === 'NEW' && it.reviewedAt) {
      // Reviewed once, then the customer changed it: the earlier review is not this one.
      meta.push(
        'Changed since ' +
          esc(it.reviewedBy || 'someone') +
          ' reviewed it on ' +
          esc(fmtDate(it.reviewedAt)),
      );
    }
    if (it.mondayStatus) meta.push('monday.com: ' + esc(it.mondayStatus));
    var canMark = st.canReview && it.display === 'NEW';
    var answers = answersHtml(it.kind, it.answers);
    var busy = st.busy === it.kind;
    return (
      '<div data-pkind="' +
      esc(it.kind) +
      '" style="padding:14px 16px;border-top:1px solid #f2f3ef;' +
      (it.display === 'NEW' ? 'box-shadow:inset 4px 0 0 ' + NEW_MARKER + ';' : '') +
      '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<b style="font-weight:600;font-size:14px;">' +
      esc(CARD_LABEL[it.kind] || humanize(it.kind)) +
      '</b>' +
      chipHtml(entry) +
      (meta.length
        ? '<span class="muted" style="font-size:12px;">' + meta.join(' · ') + '</span>'
        : '') +
      '</div>' +
      (canMark
        ? '<button class="link-btn portalReview" data-kind="' +
          esc(it.kind) +
          '"' +
          (busy ? ' disabled' : '') +
          ' title="' +
          (it.kind === 'COLOR'
            ? 'Marks this reviewed and applies these colors to the Bill of Materials'
            : it.kind === 'DELIVERY'
              ? 'Marks this reviewed here and ticks Staff Reviewed on monday.com'
              : 'Marks this version reviewed') +
          '" style="width:auto;padding:6px 12px;font-size:12.5px;">' +
          (busy ? 'Marking…' : 'Mark reviewed') +
          '</button>'
        : '') +
      '</div>' +
      (st.errors[it.kind]
        ? '<div class="err" style="margin-top:8px;">' + esc(st.errors[it.kind]) + '</div>'
        : '') +
      reviewNoteHtml(it.kind, st.notes[it.kind]) +
      (answers ? '<div style="margin-top:10px;">' + answers + '</div>' : '') +
      '</div>'
    );
  }

  function cardHtml(st) {
    var at = st.at ? 'Portal data refreshed ' + relTime(st.at) : '';
    return (
      '<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;">' +
      '<div class="muted" style="font-size:12.5px;line-height:1.5;max-width:620px;">What the customer has given us through the portal. New answers stay amber until someone marks them reviewed; a change after review makes them new again.</div>' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
      '<span class="muted" id="portalAt" style="font-size:12px;"' +
      (st.at ? ' title="' + esc(U.fmtDateTime(st.at)) + '"' : '') +
      '>' +
      esc(st.syncing ? (st.force ? 'Syncing from the portal…' : 'Checking the portal…') : at) +
      '</span>' +
      '<button class="link-btn" id="portalSync"' +
      (st.syncing ? ' disabled' : '') +
      ' style="width:auto;padding:7px 13px;white-space:nowrap;">' +
      (st.syncing && st.force ? 'Syncing…' : 'Sync from portal') +
      '</button>' +
      '</div>' +
      '</div>' +
      (st.syncError
        ? '<div style="margin:0 16px 10px;padding:8px 11px;border-radius:9px;font-size:12.5px;border:1px solid #eadfbe;background:#fdf6e3;color:#8a6d1f;">Portal sync: ' +
          esc(st.syncError) +
          '</div>'
        : '') +
      (st.loadError
        ? '<div class="err" style="margin:0 16px 12px;">' + esc(st.loadError) + '</div>'
        : '') +
      (st.items
        ? st.items
            .map(function (it) {
              return itemHtml(it, st);
            })
            .join('')
        : '<div class="muted" style="padding:14px 16px;border-top:1px solid #f2f3ef;">Loading…</div>') +
      '</div>'
    );
  }

  /**
   * The Customer Portal card on an order page.
   *
   *   opts.el                 the box to render into
   *   opts.orderId
   *   opts.canReview          whether "Mark reviewed" is offered (ORDERS_MANAGE_ROLES)
   *   opts.authed             the shell's fetch
   *   opts.onDeliveryChanged  called when a sync changed the delivery step, so the
   *                           Bill of Materials can reload and show the new ship-to
   *   opts.onBomChanged       called when a colour review changed BOM lines
   *
   * Renders what is stored straight away, then syncs (throttled server-side, so
   * opening orders back to back doesn't hammer monday) and re-renders.
   */
  function mountCard(opts) {
    var el = opts.el;
    var st = {
      items: null,
      at: null,
      syncing: false,
      force: false,
      syncError: '',
      loadError: '',
      busy: '',
      notes: {},
      errors: {},
      canReview: !!opts.canReview,
    };
    var alive = function () {
      return document.body.contains(el);
    };

    function paint() {
      if (!alive()) return;
      el.innerHTML = cardHtml(st);
      var sync = el.querySelector('#portalSync');
      if (sync)
        sync.addEventListener('click', function () {
          doSync(true);
        });
      el.querySelectorAll('.portalReview').forEach(function (b) {
        b.addEventListener('click', function () {
          review(b.getAttribute('data-kind'));
        });
      });
    }

    async function doSync(force) {
      var before = deliverySignature(st.items);
      st.syncing = true;
      st.force = force;
      st.syncError = '';
      paint();
      try {
        var r = await opts.authed('/orders/' + opts.orderId + '/portal/sync', {
          method: 'POST',
          body: { force: !!force },
          timeoutMs: 180000,
        });
        if (!r.ok) {
          st.syncError = await serverMessage(
            r,
            'Could not sync from the portal (' + r.status + ').',
          );
        } else {
          var d = await r.json();
          var ref = d.refresh || {};
          if (ref.at) st.at = ref.at;
          if (ref.error) st.syncError = ref.error;
          if (Array.isArray(d.items)) st.items = d.items;
        }
      } catch (e) {
        st.syncError = (e && e.message) || 'Could not reach the server.';
      }
      st.syncing = false;
      paint();
      // The sync changed the delivery step (or it arrived for the first time): the
      // Bill of Materials' ship-to reads it, so that has to reload to show it.
      if (alive() && before !== deliverySignature(st.items) && opts.onDeliveryChanged)
        opts.onDeliveryChanged();
    }

    async function review(kind) {
      st.busy = kind;
      delete st.errors[kind];
      delete st.notes[kind];
      paint();
      // The version on screen goes with the click, so the server marks THAT version
      // reviewed and refuses if the customer's answers changed since the page loaded.
      var shown = (st.items || []).filter(function (i) {
        return i.kind === kind;
      })[0];
      try {
        var r = await opts.authed(
          '/orders/' + opts.orderId + '/portal/' + kind.toLowerCase() + '/review',
          { method: 'POST', body: { contentHash: (shown && shown.contentHash) || '' } },
        );
        if (!r.ok) {
          st.errors[kind] = await serverMessage(
            r,
            'Could not mark it reviewed (' + r.status + ').',
          );
          // 409: the answers moved since the page loaded, or someone else already
          // reviewed them. Show the current version so the next click is on it.
          if (r.status === 409) {
            try {
              var fresh = await opts.authed('/orders/' + opts.orderId + '/portal');
              if (fresh.ok) st.items = await fresh.json();
            } catch (e) {
              /* the error above already says what to do */
            }
          }
        } else {
          var res = await r.json();
          st.items = (st.items || []).map(function (i) {
            return i.kind === kind && res.item ? res.item : i;
          });
          st.notes[kind] = res;
          if (res.colors && res.colors.linesUpdated > 0 && opts.onBomChanged) opts.onBomChanged();
        }
      } catch (e) {
        st.errors[kind] = (e && e.message) || 'Could not reach the server.';
      }
      st.busy = '';
      paint();
    }

    (async function () {
      paint();
      try {
        var r = await opts.authed('/orders/' + opts.orderId + '/portal');
        if (r.ok) st.items = await r.json();
        else
          st.loadError = await serverMessage(
            r,
            'Could not load the portal steps (' + r.status + ').',
          );
      } catch (e) {
        st.loadError = 'Could not reach the server.';
      }
      if (!st.items) st.items = [];
      await doSync(false);
    })();
  }

  window.SSGOrderPortal = {
    KINDS: KINDS,
    DISPLAY_OPTIONS: DISPLAY_OPTIONS,
    NEW_MARKER: NEW_MARKER,
    // list columns
    entryOf: entryOf,
    chipHtml: chipHtml,
    plainOf: plainOf,
    sortKeyOf: sortKeyOf,
    hasNew: hasNew,
    columns: columns,
    // formatters
    shortDate: shortDate,
    fmtPhone: fmtPhone,
    relTime: relTime,
    humanize: humanize,
    // list filters
    isActive: isActive,
    matchFilter: matchFilter,
    rowPasses: rowPasses,
    activeCount: activeCount,
    mountFilterRow: mountFilterRow,
    openFiltersPanel: openFiltersPanel,
    refreshList: refreshList,
    // the order page
    answersHtml: answersHtml,
    deliverySignature: deliverySignature,
    mountCard: mountCard,
  };
})();

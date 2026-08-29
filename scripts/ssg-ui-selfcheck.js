// window.SSGUI self-check — paste into the browser console on a signed-in page.
//
// NOT a Node script and not part of the build. It is a diagnostic for the browser pass
// after an extraction: paste, read the summary, then go and look at screens.
//
// What it proves: the primitives module loaded, exports what it should, and every pure
// primitive still returns what it returned before it moved out of app.js. That is the
// catastrophic class of regression — a missing member, a typo'd alias, a body that
// changed on the way across — and it takes five seconds rather than thirty minutes.
//
// What it does NOT prove: that any screen renders. A primitive can be perfect and a
// screen still be broken. This narrows the browser pass; it does not replace it.
//
// Line comments, not a block comment, and deliberately. The first version opened with
// /* and a paste that dropped the first line left an orphaned * at 1:1 — an
// "Unexpected token *" that reads as a broken script rather than a short copy. Every
// line here stands alone, so a partial paste loses documentation and still runs.
//
// Every assertion also evaluates inside a try/catch, for the same class of reason: the
// first draft called U.statusChip(...) directly, so deleting that member — exactly the
// regression it exists to catch — threw and printed no summary at all. A check that
// dies on the condition it is looking for is worse than no check.
//
// Run it again after every later extraction (Catalog, Configurators, Administration).
// The point of a shared foundation is that its contract stops changing, and this is how
// you find out that it did not.

(function () {
  'use strict';

  var U = window.SSGUI;
  var pass = 0;
  var fail = [];

  /** `thunk` is always a function; `want` is a value, or a predicate returning true. */
  function check(name, thunk, want) {
    var got;
    var expected = typeof want === 'function' ? '(predicate)' : want;
    try {
      got = thunk();
    } catch (e) {
      fail.push({ check: name, got: 'THREW: ' + ((e && e.message) || e), expected: expected });
      return;
    }
    var ok = false;
    try {
      ok = typeof want === 'function' ? want(got) === true : got === want;
    } catch (e2) {
      ok = false;
    }
    if (ok) pass++;
    else fail.push({ check: name, got: got, expected: expected });
  }

  /** `[fn, args, expected]` — calls U[fn](...args) and compares exactly. */
  function table(cases, compare) {
    cases.forEach(function (c) {
      var label = c[0] + '(' + c[1].map(shortly).join(', ') + ')';
      var want = compare ? compare(c[2]) : c[2];
      check(
        label,
        function () {
          return U[c[0]].apply(null, c[1]);
        },
        want,
      );
    });
  }
  function shortly(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof Date) return 'Date';
    return String(v);
  }
  /** For table rows whose expectation is "contains this". */
  function containing(sub) {
    return function (got) {
      return typeof got === 'string' && got.indexOf(sub) !== -1;
    };
  }

  if (!U) {
    console.error(
      'SSGUI SELF-CHECK: window.SSGUI is not defined. ssg-ui.js did not load — it must ' +
        'be the first script tag in index.html.',
    );
    return {
      passed: 0,
      failed: 1,
      failures: [{ check: 'window.SSGUI exists', got: undefined, expected: 'an object' }],
    };
  }

  /* ---- 1. the contract ---- */

  var EXPECTED = [
    'esc',
    'titleCase',
    'rt',
    'isoLocal',
    'todayISO',
    'fmtDate',
    'fmtDateTime',
    'fmtMoney',
    'fmt0',
    'money',
    'costMoney',
    'd2m',
    'streetLine',
    'hasRole',
    'roleLabel',
    'td',
    'tableShell',
    'statusChip',
    'kpi',
    'fieldRow',
    'formSection',
    'IN',
    'selectEl',
    'bomFieldStyle',
    'openModal',
    'toast',
    'downloadCsv',
    'downloadBlob',
    'serverMessage',
  ];
  EXPECTED.forEach(function (k) {
    var want = k === 'IN' ? 'string' : 'function';
    check(
      'typeof ' + k,
      function () {
        return typeof U[k];
      },
      want,
    );
  });
  check(
    'IN is a style string',
    function () {
      return U.IN.indexOf('border') !== -1;
    },
    true,
  );
  check(
    'no undocumented exports',
    function () {
      var extra = Object.keys(U).filter(function (k) {
        return EXPECTED.indexOf(k) === -1;
      });
      return extra.join(',') || '(none)';
    },
    '(none)',
  );

  /* ---- 2. exact returns ----
   *
   * Exact, not approximate. `esc` has 780 call sites and `td` has 301, so "looks about
   * right" is not a standard either of them can be held to.
   *
   * Two that read as near-duplicates and are not: `money` carries no symbol and no
   * separators because it fills form fields and CSV cells, while the freight-trueup
   * screen has a `money` of its own that DOES add a $. `fmtMoney` returns an em dash
   * for nothing at all; `money` returns a blank string.
   *
   * The apostrophe in `esc` is deliberate. app.js escaped four characters and the
   * extracted screens five; widened to five, because app.js builds single-quoted
   * attributes and four does not close them safely.
   */
  table([
    ['esc', ['O\'Brien <b>&"'], 'O&#39;Brien &lt;b&gt;&amp;&quot;'],
    ['esc', [null], ''],
    ['titleCase', ['SALES_MANAGER'], 'Sales Manager'],
    ['roleLabel', ['PROJECT_MANAGER'], 'Project Manager'],
    // Street and suite on one line. A suite that already names itself keeps its wording.
    ['streetLine', ['10488 Centennial Road', '100'], '10488 Centennial Road, Suite 100'],
    ['streetLine', ['1 Main St', 'Unit 4'], '1 Main St, Unit 4'],
    ['streetLine', ['1 Main St', ''], '1 Main St'],
    ['isoLocal', [new Date(2026, 7, 4)], '2026-08-04'],
    ['fmtDate', [null], '—'],
    ['fmtDateTime', [null], '—'],
    ['fmtMoney', [866250], '$8,662.50'],
    ['fmtMoney', [866250, 'CAD'], 'CAD 8,662.50'],
    ['fmtMoney', [null], '—'],
    ['fmt0', [866250], '$8,663'],
    ['money', [866250], '8662.50'],
    ['money', [null], ''],
    ['costMoney', [866250], '$8662.50'],
    ['d2m', ['$1,234.56'], 123456],
    ['d2m', ['abc'], 0],
    ['hasRole', [['A', 'B'], 'B'], true],
    ['hasRole', [['A'], 'B'], false],
    ['td', ['x'], '<td style="padding:12px 16px;border-bottom:1px solid #f2f3ef;">x</td>'],
  ]);

  /* ---- 3. returns that must merely contain something ----
   *
   * Markup, where the surrounding styling is allowed to change and the content is not.
   * RELEASED and EXPIRED are relabelled on purpose: to the business, RELEASED means the
   * customer has the proposal and EXPIRED means it lapsed.
   */
  table(
    [
      ['rt', ['**x**'], '<b '],
      // A stray < in a dimension ("<3/8 in") must not eat the rest of the paragraph.
      ['rt', ['<3/8 in'], '&lt;3/8'],
      ['rt', ['<ul><li>a</li></ul>'], '<ul>'],
      ['tableShell', [['A'], '<tr><td>r</td></tr>', 1], '<tr><td>r</td></tr>'],
      ['tableShell', [['A'], '', 1, 'Nothing here.'], 'Nothing here.'],
      ['statusChip', ['RELEASED'], 'Proposal Sent'],
      ['statusChip', ['EXPIRED'], 'No Longer Active'],
      ['kpi', ['Label', '5'], 'Label'],
      ['fieldRow', ['Name', '<input>'], '<label>Name</label>'],
      ['formSection', ['Group'], 'Group'],
      ['selectEl', ['id', ['A_B'], 'A_B'], 'selected'],
    ],
    containing,
  );

  /* ---- 4. the timezone, which is why this module exists ----
   *
   * A bare YYYY-MM-DD is a calendar date, not an instant. Read as UTC midnight it
   * renders as the day before anywhere west of Greenwich, which is how a proposal
   * created today came to print yesterday's date. The month name is locale-dependent;
   * the day number is not.
   */
  check(
    'todayISO shape',
    function () {
      return /^\d{4}-\d{2}-\d{2}$/.test(U.todayISO());
    },
    true,
  );
  check(
    'todayISO is today, locally',
    function () {
      return U.todayISO() === U.isoLocal(new Date());
    },
    true,
  );
  check(
    'fmtDate("2026-08-04") keeps the 4th',
    function () {
      return U.fmtDate('2026-08-04');
    },
    function (got) {
      return /\b4\b/.test(got) && /2026/.test(got) && !/\b3\b/.test(got);
    },
  );

  /* ---- 5. one behavioural pair ---- */

  check(
    'bomFieldStyle locked differs from unlocked',
    function () {
      return U.bomFieldStyle('80px', true) !== U.bomFieldStyle('80px', false);
    },
    true,
  );

  /* ---- 6. load order, read off the live document ---- */

  function jsTags() {
    var tags = document.querySelectorAll('script[src]');
    return Array.prototype.map
      .call(tags, function (s) {
        return s.getAttribute('src').replace(/^\//, '').replace(/\?.*$/, '');
      })
      .filter(function (s) {
        return /\.js$/.test(s);
      });
  }
  check(
    'ssg-ui.js is the first script',
    function () {
      return jsTags()[0];
    },
    'ssg-ui.js',
  );
  check(
    'proposal-document.js loads before app.js',
    function () {
      var t = jsTags();
      var doc = t.indexOf('proposal-document.js');
      return doc !== -1 && doc < t.indexOf('app.js');
    },
    true,
  );
  check(
    'SSGProposalDocument registered',
    function () {
      return typeof (window.SSGProposalDocument || {}).html;
    },
    'function',
  );
  // Shared by Catalog and Administration; if it is absent, the Proposal notes tab and
  // the Administration panel both render an empty box rather than failing loudly.
  check(
    'SSGStandardNotes registered',
    function () {
      return typeof (window.SSGStandardNotes || {}).renderTab;
    },
    'function',
  );
  // Opened from Catalog → Manufacturers and Administration → Orders & vendors. Absent,
  // both buttons do nothing at all rather than reporting why.
  check(
    'SSGVendorParts registered',
    function () {
      return typeof (window.SSGVendorParts || {}).open;
    },
    'function',
  );
  // app.js calls this straight from the nav. Absent, clicking Catalog throws.
  check(
    'SSGCatalog registered',
    function () {
      return typeof (window.SSGCatalog || {}).render;
    },
    'function',
  );

  /* ---- report ---- */

  if (fail.length) {
    console.error('SSGUI SELF-CHECK — ' + pass + ' passed, ' + fail.length + ' FAILED');
    if (console.table) {
      console.table(fail);
    } else {
      fail.forEach(function (f) {
        console.error(f.check + ': got ' + f.got + ', expected ' + f.expected);
      });
    }
    console.error(
      'A failure here is a regression in the primitives module. Do not go screen-hunting ' +
        'until it is green.',
    );
  } else {
    var style = 'color:#2f7d5d;font-weight:600;';
    console.log('%cSSGUI SELF-CHECK — all ' + pass + ' checks passed.', style);
    console.log(
      'The primitives are intact. Now look at the screens — this cannot tell you ' +
        'whether one renders.',
    );
  }
  return { passed: pass, failed: fail.length, failures: fail };
})();

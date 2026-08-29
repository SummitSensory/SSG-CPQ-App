/*
 * window.SSGUI self-check — paste into the browser console on a signed-in page.
 *
 * NOT a Node script and not part of the build. It is a diagnostic for the browser pass
 * after an extraction: paste, read the summary line, then go and look at screens.
 *
 * What it proves: the primitives module loaded, exports everything it should, and each
 * pure primitive still returns what it returned before it moved out of app.js. That is
 * the catastrophic class of regression — a missing member, a typo'd alias, a body that
 * changed on the way across — and it takes five seconds rather than thirty minutes.
 *
 * What it does NOT prove: that any screen renders. A primitive can be perfect and a
 * screen still be broken. This narrows the browser pass; it does not replace it.
 *
 * Every assertion evaluates inside a try/catch, and that is not decoration. The first
 * draft of this file called `U.statusChip(...)` directly, so deleting that member —
 * exactly the regression it was written to catch — threw an uncaught exception and
 * printed no summary at all. A check that dies on the condition it is looking for is
 * worse than no check, because the stack trace looks like a broken tool rather than a
 * broken build. A throw is now recorded as a failure like any other.
 *
 * Run it again after every later extraction (Catalog, Administration, Configurators).
 * The point of a shared foundation is that its contract stops changing, and this is how
 * you find out that it did not.
 */
(function () {
  'use strict';

  var pass = 0;
  var fail = [];
  var U = window.SSGUI;

  /** `thunk` is always a function; `want` is a value, or a predicate on the result. */
  function check(name, thunk, want) {
    var got;
    try {
      got = thunk();
    } catch (e) {
      fail.push({
        check: name,
        got: 'THREW: ' + ((e && e.message) || e),
        expected: describe(want),
      });
      return;
    }
    var ok;
    try {
      ok = typeof want === 'function' ? want(got) === true : got === want;
    } catch (e2) {
      ok = false;
    }
    if (ok) pass++;
    else fail.push({ check: name, got: got, expected: describe(want) });
  }
  function describe(want) {
    return typeof want === 'function' ? '(predicate)' : want;
  }
  /** Shorthand: the result must contain this substring. */
  function has(sub) {
    return function (got) {
      return typeof got === 'string' && got.indexOf(sub) !== -1;
    };
  }

  if (!U) {
    console.error(
      'SSGUI SELF-CHECK: window.SSGUI is not defined. ssg-ui.js did not load — it must be the first script tag in index.html.',
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
    check(
      'typeof ' + k,
      function () {
        return typeof U[k];
      },
      k === 'IN' ? 'string' : 'function',
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
      return (
        Object.keys(U)
          .filter(function (k) {
            return EXPECTED.indexOf(k) === -1;
          })
          .join(',') || '(none)'
      );
    },
    '(none)',
  );

  /* ---- 2. text ---- */

  // Five characters, not four. app.js used to escape four and the extracted screens
  // five; widened deliberately, because app.js builds single-quoted attributes.
  check(
    'esc escapes the five',
    function () {
      return U.esc('O\'Brien <b>&"');
    },
    'O&#39;Brien &lt;b&gt;&amp;&quot;',
  );
  check(
    'esc of null is empty',
    function () {
      return U.esc(null);
    },
    '',
  );
  check(
    'titleCase',
    function () {
      return U.titleCase('SALES_MANAGER');
    },
    'Sales Manager',
  );
  check(
    'rt bolds',
    function () {
      return U.rt('**x**');
    },
    has('<b '),
  );
  // A stray < in a dimension must not eat the rest of the paragraph.
  check(
    'rt escapes a bare <',
    function () {
      return U.rt('<3/8 in');
    },
    has('&lt;3/8'),
  );
  check(
    'rt keeps an allowed tag',
    function () {
      return U.rt('<ul><li>a</li></ul>');
    },
    has('<ul>'),
  );

  /* ---- 3. dates — the bug this module exists to have fixed once ---- */

  check(
    'isoLocal is the local calendar day',
    function () {
      return U.isoLocal(new Date(2026, 7, 4));
    },
    '2026-08-04',
  );
  check(
    'todayISO shape',
    function () {
      return /^\d{4}-\d{2}-\d{2}$/.test(U.todayISO());
    },
    true,
  );
  check(
    'todayISO is TODAY locally',
    function () {
      return U.todayISO();
    },
    function (got) {
      return got === U.isoLocal(new Date());
    },
  );
  // A bare YYYY-MM-DD is a calendar date, not UTC midnight. If the day reads 3 rather
  // than 4, the timezone fix is lost and proposals will print yesterday's date.
  check(
    'fmtDate keeps the 4th (text is locale-dependent; the day must be 4)',
    function () {
      return U.fmtDate('2026-08-04');
    },
    function (got) {
      return /\b4\b/.test(got) && /2026/.test(got) && !/\b3\b/.test(got);
    },
  );
  check(
    'fmtDate of nothing',
    function () {
      return U.fmtDate(null);
    },
    '—',
  );
  check(
    'fmtDateTime of nothing',
    function () {
      return U.fmtDateTime(null);
    },
    '—',
  );

  /* ---- 4. money — four functions, and not interchangeable ---- */

  check(
    'fmtMoney',
    function () {
      return U.fmtMoney(866250);
    },
    '$8,662.50',
  );
  check(
    'fmtMoney with a currency',
    function () {
      return U.fmtMoney(866250, 'CAD');
    },
    'CAD 8,662.50',
  );
  check(
    'fmtMoney of nothing',
    function () {
      return U.fmtMoney(null);
    },
    '—',
  );
  check(
    'fmt0 rounds to the dollar',
    function () {
      return U.fmt0(866250);
    },
    '$8,663',
  );
  // No symbol and no separators — this one fills form fields and CSV cells. The
  // freight-trueup screen has a `money` that DOES add a $; they are different jobs.
  check(
    'money has no symbol',
    function () {
      return U.money(866250);
    },
    '8662.50',
  );
  check(
    'money of nothing is blank',
    function () {
      return U.money(null);
    },
    '',
  );
  check(
    'costMoney',
    function () {
      return U.costMoney(866250);
    },
    '$8662.50',
  );
  check(
    'd2m strips the typing',
    function () {
      return U.d2m('$1,234.56');
    },
    123456,
  );
  check(
    'd2m of nonsense is zero',
    function () {
      return U.d2m('abc');
    },
    0,
  );

  /* ---- 5. roles ---- */

  check(
    'hasRole finds',
    function () {
      return U.hasRole(['A', 'B'], 'B');
    },
    true,
  );
  check(
    'hasRole misses',
    function () {
      return U.hasRole(['A'], 'B');
    },
    false,
  );
  check(
    'roleLabel',
    function () {
      return U.roleLabel('PROJECT_MANAGER');
    },
    'Project Manager',
  );

  /* ---- 6. markup builders — exact, because 301 table cells depend on td ---- */

  check(
    'td',
    function () {
      return U.td('x');
    },
    '<td style="padding:12px 16px;border-bottom:1px solid #f2f3ef;">x</td>',
  );
  check(
    'tableShell renders rows',
    function () {
      return U.tableShell(['A'], '<tr><td>r</td></tr>', 1);
    },
    has('<tr><td>r</td></tr>'),
  );
  check(
    'tableShell empty state',
    function () {
      return U.tableShell(['A'], '', 1, 'Nothing here.');
    },
    has('Nothing here.'),
  );
  // RELEASED reads to the business as "the customer has it"; EXPIRED as "it lapsed".
  check(
    'statusChip relabels RELEASED',
    function () {
      return U.statusChip('RELEASED');
    },
    has('Proposal Sent'),
  );
  check(
    'statusChip relabels EXPIRED',
    function () {
      return U.statusChip('EXPIRED');
    },
    has('No Longer Active'),
  );
  check(
    'kpi',
    function () {
      return U.kpi('Label', '5');
    },
    has('Label'),
  );
  check(
    'fieldRow',
    function () {
      return U.fieldRow('Name', '<input>');
    },
    has('<label>Name</label>'),
  );
  check(
    'formSection',
    function () {
      return U.formSection('Group');
    },
    has('Group'),
  );
  check(
    'selectEl selects',
    function () {
      return U.selectEl('id', ['A_B'], 'A_B');
    },
    has('selected'),
  );
  check(
    'bomFieldStyle locked differs',
    function () {
      return U.bomFieldStyle('80px', true) !== U.bomFieldStyle('80px', false);
    },
    true,
  );

  /* ---- 7. load order, read off the live document ---- */

  function jsTags() {
    return Array.prototype.map
      .call(document.querySelectorAll('script[src]'), function (s) {
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
      return (
        t.indexOf('proposal-document.js') !== -1 &&
        t.indexOf('proposal-document.js') < t.indexOf('app.js')
      );
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

  /* ---- report ---- */

  if (fail.length) {
    console.error('SSGUI SELF-CHECK — ' + pass + ' passed, ' + fail.length + ' FAILED');
    if (console.table) console.table(fail);
    else
      fail.forEach(function (f) {
        console.error(f.check + ': got ' + f.got + ', expected ' + f.expected);
      });
    console.error(
      'A failure here is a regression in the primitives module. Do not go screen-hunting until it is green.',
    );
  } else {
    console.log(
      '%cSSGUI SELF-CHECK — all ' + pass + ' checks passed.',
      'color:#2f7d5d;font-weight:600;',
    );
    console.log(
      'The primitives are intact. Now look at the screens — this cannot tell you whether one renders.',
    );
  }
  return { passed: pass, failed: fail.length, failures: fail };
})();

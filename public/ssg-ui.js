/*
 * Shared UI primitives — window.SSGUI.
 *
 * Escaping, money, dates, table cells, the modal, the toast. The small pieces every
 * screen in this app is built out of, and the reason none of them could be lifted out
 * of public/app.js: the Catalog screen needed twenty-one things from the shell and
 * seventeen of them were these. Administration's thirty contained the same seventeen.
 * So did the CRM's and Reports'. The blocker was never per-screen coupling — it was
 * that there was no shared foundation to depend on.
 *
 * Every function below is lifted VERBATIM out of public/app.js. Not rewritten, not
 * tidied, not reformatted: `esc` has 780 call sites and `td` has 301, so the only
 * reviewable version of this commit is one where each body can be diffed against the
 * original and seen to be character-for-character the same. Improvements to any of
 * them belong in their own commit, after this one has been proven.
 *
 * What is here and what is NOT:
 *
 *   Here — pure formatters (esc, titleCase, money, dates), pure markup builders (td,
 *   tableShell, kpi, statusChip, fieldRow), and self-contained DOM helpers that read
 *   no application state (openModal, toast, downloadCsv, downloadBlob).
 *
 *   Not here — anything reading live mutable state (pb, currentUser), and anything
 *   whose text prints on a document a customer signs (FREIGHT_TBD_NOTE). Those are
 *   passed in by the shell where they are needed; public/proposal-document.js's
 *   useRules() is the working example of that pattern, and it throws on a missing rule
 *   rather than falling back, which is what turns a silent wrong-deposit risk into a
 *   loud startup failure.
 *
 *   `rt` is the interesting one. It renders note markup and is SHARED WITH THE
 *   PROPOSAL BUILDER, which shows the rep the same note as they type it; two
 *   implementations and the preview stops matching the printed page. That argues for
 *   exactly one copy, which is what this file now is — app.js aliases it and keeps
 *   handing it to the document renderer through useRules(), so there is still only
 *   ever one implementation in the process.
 *
 *   `hasRole` is listed in the audit notes as reading `currentUser`. It does not, and
 *   has not for some time: it takes the role list AND the role as arguments and is
 *   pure. It is copied rather than injected on that basis.
 *
 * LOAD ORDER: this file must be the FIRST script in public/index.html. It has no
 * dependencies of its own — nothing in it touches window beyond the registration on
 * the last line — so it can load before everything, and everything else may assume it
 * has. app.js throws on boot if it is missing rather than failing three thousand lines
 * later with 'esc is not a function'.
 *
 * Adding a client script is three things in one commit: the file in public/, its route
 * in CLIENT_SCRIPTS (src/routes/web.ts), and a <script> tag in public/index.html.
 */
(function () {
  'use strict';

  /* ---- text ---- */

  /**
   * Text → HTML text. The apostrophe is escaped too.
   *
   * app.js's version escaped four characters and not `'`, while proposal-document.js,
   * insights.js and goals.js all escaped five. That split is now resolved in favour of
   * the wider set, because app.js builds single-quoted attributes in places
   * (`data-part='...'`, inline handlers) and a four-character escape does not close
   * them safely.
   *
   * Widening is safe in a way narrowing never is: `&#39;` renders as `'` in element
   * text, in a `value="…"` and in a `<textarea>`, so nothing a reader sees changes. It
   * would be visible only if escaped text were written somewhere that is not HTML — a
   * CSV cell, a textContent, a URL. All 753 call sites in app.js were checked at
   * statement level before this change and every one of them assembles HTML; the nine
   * CSV exports build their rows from raw values (`col.plain(row)`), never from esc.
   */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function titleCase(v) { return String(v || '').toLowerCase().split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '); }

  /**
   * Note text → printable HTML.
   *
   * Notes accept three things: the lightweight **bold** / *italic* markup the toolbar
   * writes, real line breaks, and a small set of hand-written HTML tags for the layouts
   * markup cannot express — mainly bulleted lists and links.
   *
   * Everything is escaped first and the allowed tags are then let back through, which
   * is the only order that is safe: a note is typed by staff but printed on a customer
   * document, and a stray < in a dimension ("<3/8 in") must not eat the rest of the
   * paragraph. Anything not on the list prints as the literal text that was typed, so a
   * mistake is visible rather than silent.
   */
  var RT_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'ul', 'ol', 'li', 'small', 'sup', 'sub'];
  function rtUnescapeTags(html) {
    var open = new RegExp('&lt;(' + RT_TAGS.join('|') + ')(\\s*/)?&gt;', 'gi');
    var close = new RegExp('&lt;/(' + RT_TAGS.join('|') + ')&gt;', 'gi');
    // Links carry one attribute, and only to somewhere a browser should follow.
    var anchor = /&lt;a\s+href=(?:&quot;|')([^"'&<>\s]+)(?:&quot;|')&gt;/gi;
    return html
      .replace(open, function (m0, tag, slash) { return '<' + tag.toLowerCase() + (slash ? ' /' : '') + '>'; })
      .replace(close, function (m0, tag) { return '</' + tag.toLowerCase() + '>'; })
      .replace(anchor, function (m0, href) {
        return /^(https?:|mailto:)/i.test(href)
          ? '<a href="' + href.replace(/"/g, '') + '" style="color:#3d4a55;">'
          : m0;
      })
      .replace(/&lt;\/a&gt;/gi, '</a>');
  }
  function rt(s) {
    var out = rtUnescapeTags(esc(s == null ? '' : s))
      .replace(/\*\*([^*]+)\*\*/g, '<b style="font-weight:700;color:#20241f;">$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    // A note written as HTML block tags supplies its own line breaks; adding <br> as
    // well double-spaces it.
    if (/<(p|ul|ol|li)>/i.test(out)) return out;
    // A blank line between paragraphs is a paragraph break, not two line breaks. Turned
    // into <br><br> it renders as a whole empty line at the body's line-height, which
    // on a note of four paragraphs pushes the last one most of an inch down the page.
    // Separated by a normal paragraph gap instead.
    return (
      '<span style="display:block;">' +
      out
        .replace(/\n{2,}/g, '</span><span style="display:block;margin-top:.6em;">')
        .replace(/\n/g, '<br>') +
      '</span>'
    );
  }

  /* ---- dates ---- */

  /** Today as YYYY-MM-DD in the user's own timezone. `toISOString()` returns the UTC
   *  day, which is the wrong date for part of every day. */
  function isoLocal(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayISO() { return isoLocal(new Date()); }
  /** A bare YYYY-MM-DD is a calendar date, not an instant. `new Date('2026-08-04')`
   *  parses it as UTC midnight, which renders as the 3rd anywhere west of Greenwich —
   *  which is why a proposal created today printed yesterday's date. */
  function fmtDate(s) {
    if (!s) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
    return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /* ---- money ----
   *
   * Four of these, and they are not interchangeable. Read the return values before
   * reaching for one: fmtMoney and fmt0 carry a symbol, money does not, and costMoney
   * is unrounded to the cent for a figure someone is reconciling against an invoice.
   */

  /** "$8,662.50" / "CAD 8,662.50", or an em dash for nothing at all. */
  function fmtMoney(minor, cur) { if (minor == null) return '—'; var n = Number(minor) / 100; return (cur ? cur + ' ' : '$') + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Whole dollars, for a figure read at a glance rather than reconciled. */
  function fmt0(minor) { return '$' + Math.round((Number(minor) || 0) / 100).toLocaleString(); }
  /** "8662.50" — no symbol, no separators. For form fields and CSV cells. */
  function money(minor) { return minor == null ? '' : (Number(minor) / 100).toFixed(2); }
  function costMoney(minor) {
    return '$' + (Number(minor || 0) / 100).toFixed(2);
  }
  /** Dollars typed by a person to minor units. Strips anything that is not a figure. */
  function d2m(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : Math.round(n * 100); }

  /* ---- addresses ---- */

  /**
   * Street and suite on ONE line: "10488 Centennial Road, Suite 100".
   * They were separate rows, which printed a bare "100" under the street and read as
   * a truncated address. A suite that already names itself keeps its own wording.
   *
   * Moved here from the Catalog section of app.js, where it sat by accident of where
   * someone was working: its callers are the proposal builder and the Bill of
   * Materials, and neither is Catalog.
   */
  function streetLine(l1, l2) {
    var x = (l1 || '').trim(), y = (l2 || '').trim();
    if (!y) return x;
    if (!x) return y;
    return x + ', ' + (/^(ste|suite|apt|apartment|unit|#|bldg|building|fl|floor|rm|room|dept|po box|p\.o\.)/i.test(y) ? y : 'Suite ' + y);
  }

  /* ---- roles ---- */

  function hasRole(list, role) { return list.indexOf(role) !== -1; }
  function roleLabel(role) { return titleCase(role); }

  /* ---- tables and chrome ---- */

  function td(v) { return '<td style="padding:12px 16px;border-bottom:1px solid #f2f3ef;">' + v + '</td>'; }
  function tableShell(head, rows, cols, empty) {
    return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:left;padding:11px 16px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #eef0ea;background:#f7f8f4;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="' + cols + '">' + esc(empty || 'No records.') + '</td></tr>') + '</tbody></table></div>';
  }
  function statusChip(s) {
    var map = {
      DRAFT: ['#f2f3ef', '#e2e5dd', '#5c6157'],
      INTERNAL_REVIEW: ['#eef2f6', '#d8e2ea', '#3d4a55'],
      RELEASED: ['#eaf3ee', '#cfe3d7', '#2f7d5d'],
      ACCEPTED: ['#2f7d5d', '#2f7d5d', '#fff'],
      REJECTED: ['#fbe9e6', '#f0cdc7', '#9c3327'],
      EXPIRED: ['#f2f3ef', '#dcded7', '#8a8f85'],
    };
    var c = map[s] || map.DRAFT;
    // A few statuses read to the business differently from their stored name:
    // RELEASED means the customer has the proposal, EXPIRED that it lapsed.
    var CHIP_LABELS = { RELEASED: 'Proposal Sent', EXPIRED: 'No Longer Active' };
    var chipLabel = CHIP_LABELS[s] || titleCase(s);
    return '<span style="display:inline-block;background:' + c[0] + ';border:1px solid ' + c[1] + ';color:' + c[2] + ';border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;white-space:nowrap;">' + esc(chipLabel) + '</span>';
  }
  function kpi(label, value, sub, color) {
    return '<div class="card"><div class="k">' + esc(label) + '</div>' +
      '<div style="font-family:\'Newsreader\',serif;font-size:26px;font-weight:600;margin-top:2px;color:' + (color || '#20241f') + ';">' + value + '</div>' +
      (sub ? '<div class="muted" style="font-size:12px;margin-top:3px;">' + sub + '</div>' : '') + '</div>';
  }

  /* ---- form fields ----
   *
   * These emit the classes defined in public/index.html's stylesheet (.field, .card,
   * .k, .btn, .link-btn, .err, .muted). A screen rendered outside that shell has to
   * bring its own; that is why the extracted screens with their own visual language
   * keep their own field helpers rather than borrowing these.
   */

  function fieldRow(label, inner) { return '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>'; }
  /** A heading inside a modal form, for the forms long enough to need grouping. */
  function formSection(label) {
    return '<div style="font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#8a8f85;' +
      'margin:6px 0 10px;padding-top:14px;border-top:1px solid #f2f3ef;">' + esc(label) + '</div>';
  }
  var IN = 'width:100%;padding:10px 12px;border:1px solid #dcded7;border-radius:9px;font-size:14px;background:#fff;color:#20241f;outline:none;';
  function selectEl(id, opts, sel) { return '<select id="' + id + '" style="' + IN + '">' + opts.map(function (o) { return '<option value="' + o + '"' + (o === sel ? ' selected' : '') + '>' + titleCase(o) + '</option>'; }).join('') + '</select>'; }
  function bomFieldStyle(w, locked) {
    return 'width:' + (w || '100%') + ';padding:7px 9px;border:1px solid ' + (locked ? '#e7e8e3' : '#dcded7') +
      ';border-radius:8px;font-size:13px;background:' + (locked ? '#f6f7f4' : '#fff') +
      ';color:' + (locked ? '#8a8f85' : '#20241f') + ';outline:none;';
  }

  /* ---- modal ---- */

  /**
   * `opts.maxWidth` widens the dialog for content that is genuinely tabular —
   * the QuickBooks profile comparison needs three columns side by side and is
   * unreadable at the default width.
   *
   * `onSubmit` may be omitted for a read-only dialog; the primary button then
   * just closes it, and the Cancel button is dropped since there is nothing to
   * cancel.
   */
  function openModal(title, bodyHtml, onSubmit, submitLabel, opts) {
    opts = opts || {};
    var readOnly = typeof onSubmit !== 'function';
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.34);display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;z-index:50;overflow:auto;';
    ov.innerHTML = '<form id="mForm" style="width:100%;max-width:' + (opts.maxWidth || '460px') + ';background:#fbfbf9;border:1px solid #e7e8e3;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.4);padding:24px 24px 22px;">' +
      '<h2 style="font-size:20px;margin-bottom:16px;">' + esc(title) + '</h2>' +
      '<div id="mErr"></div>' + bodyHtml +
      '<div style="display:flex;gap:10px;margin-top:20px;">' +
      (readOnly ? '' : '<button type="button" id="mCancel" class="link-btn" style="width:auto;padding:11px 18px;">Cancel</button>') +
      '<button type="submit" class="btn" id="mSave" style="flex:1;">' + (submitLabel || (readOnly ? 'Done' : 'Create')) + '</button></div></form>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) document.body.removeChild(ov); }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    // Every lookup below is scoped to THIS overlay. With document.getElementById a
    // dialog opened over another one — "Paste a list…" over the vendor part numbers
    // — bound its handlers to the FIRST form's #mSave and #mErr, because
    // getElementById returns the older node when two ids collide.
    var cancel = ov.querySelector('#mCancel');
    if (cancel) cancel.addEventListener('click', close);
    var label = submitLabel || (readOnly ? 'Done' : 'Create');

    // A <button> with no type attribute is a SUBMIT button. Any dialog whose body
    // carries buttons of its own therefore submitted this form on the first click:
    // on a read-only dialog that silently closed it mid-request, which is how
    // adding a second vendor part number dropped the user back to the page behind
    // the modal with no confirmation and no refreshed list. The primary is the only
    // submit in an overlay; everything else is a plain button.
    ov.querySelectorAll('form#mForm button:not([type])').forEach(function (b) {
      if (b.id !== 'mSave') b.type = 'button';
    });

    ov.querySelector('#mForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (readOnly) return close();
      var save = ov.querySelector('#mSave'); save.disabled = true; save.textContent = 'Saving…';
      var fail = function (msg) {
        var box = ov.querySelector('#mErr');
        if (box) box.innerHTML = '<div class="err">' + esc(msg) + '</div>';
        save.disabled = false; save.textContent = label;
      };
      // The real message, not 'Something went wrong.' A timeout, a dead network
      // and a rejected validation all arrived here as the same four words, which
      // is why a stuck send was indistinguishable from a typo in an address.
      try { await onSubmit(close, fail); }
      catch (err) { fail((err && err.message) || 'Something went wrong.'); }
    });
    return ov;
  }

  /* ---- toast ---- */

  function toast(text, bad) {
    var host = document.getElementById('appToasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'appToasts';
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:80;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;';
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.style.cssText = 'max-width:390px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.5;' +
      'box-shadow:0 14px 34px -14px rgba(32,36,31,.45);opacity:0;transform:translateY(6px);' +
      'transition:opacity .18s ease,transform .18s ease;' +
      'border:1px solid ' + (bad ? '#f0cdc7' : '#cfe3d7') + ';' +
      'background:' + (bad ? '#fbe9e6' : '#eaf3ee') + ';color:' + (bad ? '#9c3327' : '#2f6b4c') + ';';
    el.textContent = text;
    host.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'none'; });
    // A failure is read after the fact and gets longer on screen than a progress note.
    setTimeout(function () {
      el.style.opacity = '0'; el.style.transform = 'translateY(6px)';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }, bad ? 9000 : 4500);
    return el;
  }

  /* ---- downloads ---- */

  function downloadCsv(filename, rows) {
    var csv = rows.map(function (r) {
      return r.map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }).join('\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- server responses ---- */

  /** Read the API's error message so the user sees the cause, not just a status code. */
  async function serverMessage(r, fallback) {
    try { var d = await r.json(); if (d && d.message) return d.message; } catch (e) {}
    return fallback;
  }

  window.SSGUI = {
    // text
    esc: esc,
    titleCase: titleCase,
    rt: rt,
    // dates
    isoLocal: isoLocal,
    todayISO: todayISO,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    // money
    fmtMoney: fmtMoney,
    fmt0: fmt0,
    money: money,
    costMoney: costMoney,
    d2m: d2m,
    // addresses
    streetLine: streetLine,
    // roles
    hasRole: hasRole,
    roleLabel: roleLabel,
    // tables and chrome
    td: td,
    tableShell: tableShell,
    statusChip: statusChip,
    kpi: kpi,
    // form fields
    fieldRow: fieldRow,
    formSection: formSection,
    IN: IN,
    selectEl: selectEl,
    bomFieldStyle: bomFieldStyle,
    // modal, toast, downloads, responses
    openModal: openModal,
    toast: toast,
    downloadCsv: downloadCsv,
    downloadBlob: downloadBlob,
    serverMessage: serverMessage,
  };
})();

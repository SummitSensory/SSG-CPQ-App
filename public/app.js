/* Summit Sensory Gym Proposal Management Software — web client.
   Slice 1: login + shell + dashboard.  Slice 2: CRM (organizations + opportunities).
   Talks to the same-origin API. No build step. */
(function () {
  'use strict';

  var AT = 'ssg_at', RT = 'ssg_rt';
  var root = document.getElementById('root');
  var currentUser = null;

  function tokens() { return { at: localStorage.getItem(AT), rt: localStorage.getItem(RT) }; }
  function setTokens(at, rt) { if (at) localStorage.setItem(AT, at); if (rt) localStorage.setItem(RT, rt); }
  function clearTokens() { localStorage.removeItem(AT); localStorage.removeItem(RT); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function titleCase(v) { return String(v || '').toLowerCase().split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '); }
  // Title-case a product/section name word-by-word, preserving punctuation and existing caps mid-word.
  function tc(s) { return String(s || '').replace(/\b([a-z])/g, function (m0, c) { return c.toUpperCase(); }); }
  // Section headings carry the "(Optional)" tag from the optional flag, never from the name itself.
  function stripOptional(s) { return String(s || '').replace(/\s*[—-]?\s*\(\s*optional\s*\)\s*$/i, '').replace(/\s*[—-]\s*optional\s*(?=\))/i, '').trim(); }
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
    return out.replace(/\n/g, '<br>');
  }
  /* --- Rich-text notes ---------------------------------------------------
     Notes are stored as the same lightweight markup the printer already reads
     (**bold**, *italic*, line breaks) so nothing downstream changes; the editor
     just gives you a normal formatting surface over it. */
  function mdToEditHtml(s) {
    return esc(s == null ? '' : s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\n/g, '<br>');
  }
  /** Walk the editor DOM back into **bold** / *italic* markup. */
  function editHtmlToMd(root) {
    var out = '';
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var c = node.childNodes[i];
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        var tag = c.tagName.toLowerCase();
        if (tag === 'br') { out += '\n'; continue; }
        if ((tag === 'div' || tag === 'p') && out && !/\n$/.test(out)) out += '\n';
        var st = (c.getAttribute('style') || '') + ' ';
        var bold = tag === 'b' || tag === 'strong' || /font-weight:\s*(bold|[6-9]00)/i.test(st);
        var ital = tag === 'i' || tag === 'em' || /font-style:\s*italic/i.test(st);
        var inner = out.length;
        if (bold) out += '**';
        if (ital) out += '*';
        walk(c);
        // An empty wrapper would leave dangling markers behind.
        if (out.length === inner + (bold ? 2 : 0) + (ital ? 1 : 0)) { out = out.slice(0, inner); continue; }
        if (ital) out += '*';
        if (bold) out += '**';
      }
    })(root);
    return out.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  /** Contenteditable field + B/I toolbar. Returns the markup via editHtmlToMd(). */
  function richTextField(id, label, value, hint) {
    var btn = 'border:1px solid #dcded7;background:#fff;border-radius:6px;width:30px;height:28px;font-size:13px;cursor:pointer;color:#20241f;';
    return '<div class="field"><label>' + esc(label) + '</label>' +
      '<div style="border:1px solid #dcded7;border-radius:8px;overflow:hidden;background:#fff;">' +
        '<div style="display:flex;gap:5px;align-items:center;padding:6px 7px;border-bottom:1px solid #ece9db;background:#fafaf7;">' +
          '<button type="button" data-rtcmd="bold" data-rt="' + id + '" title="Bold (\u2318B)" style="' + btn + 'font-weight:700;">B</button>' +
          '<button type="button" data-rtcmd="italic" data-rt="' + id + '" title="Italic (\u2318I)" style="' + btn + 'font-style:italic;font-family:Georgia,serif;">I</button>' +
          '<button type="button" data-rtcmd="removeFormat" data-rt="' + id + '" title="Clear formatting" style="' + btn + 'width:auto;padding:0 9px;font-size:11.5px;">Clear</button>' +
          // The escape hatch for what the toolbar cannot do — lists, links, anything
          // needing real markup. Switching views hands the text over verbatim.
          '<button type="button" id="' + id + '__htmlBtn" style="' + btn + 'width:auto;padding:0 9px;font-size:11.5px;margin-left:auto;">HTML</button>' +
        '</div>' +
        '<div id="' + id + '" contenteditable="true" style="min-height:120px;padding:10px 12px;font-size:14px;line-height:1.55;outline:none;">' + mdToEditHtml(value) + '</div>' +
        '<textarea id="' + id + '__html" spellcheck="false" style="display:none;width:100%;box-sizing:border-box;min-height:150px;padding:10px 12px;border:none;outline:none;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6;">' + esc(value == null ? '' : value) + '</textarea>' +
      '</div>' +
      (hint ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' + hint + '</div>' : '') + '</div>';
  }
  /**
   * Which view a rich-text field is showing, by field id. The HTML view is
   * authoritative while it is open: readRichText reads the textarea verbatim rather
   * than walking the editor DOM, so hand-written tags are never flattened by a
   * round-trip through the toolbar.
   */
  var rtHtmlMode = {};
  function readRichText(id) {
    if (rtHtmlMode[id]) {
      var ta = document.getElementById(id + '__html');
      return ta ? ta.value.trim() : '';
    }
    var el = document.getElementById(id);
    return el ? editHtmlToMd(el) : '';
  }

  /** Wire the toolbar + keyboard shortcuts + plain-text paste for a rich-text field. */
  function wireRichText(id) {
    var el = document.getElementById(id); if (!el) return;
    rtHtmlMode[id] = false;
    var ta = document.getElementById(id + '__html');
    var hb = document.getElementById(id + '__htmlBtn');
    if (ta && hb) {
      hb.addEventListener('click', function () {
        var toHtml = !rtHtmlMode[id];
        if (toHtml) ta.value = editHtmlToMd(el);
        else el.innerHTML = mdToEditHtml(ta.value);
        rtHtmlMode[id] = toHtml;
        el.style.display = toHtml ? 'none' : 'block';
        ta.style.display = toHtml ? 'block' : 'none';
        hb.style.background = toHtml ? '#eef0ea' : '#fff';
        hb.textContent = toHtml ? 'Formatted' : 'HTML';
        (toHtml ? ta : el).focus();
      });
    }
    document.querySelectorAll('[data-rt="' + id + '"]').forEach(function (b) {
      // mousedown so the selection inside the editor survives the click.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); el.focus(); document.execCommand(b.getAttribute('data-rtcmd'), false, null); });
    });
    el.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var k = String(e.key).toLowerCase();
      if (k === 'b' || k === 'i') { e.preventDefault(); document.execCommand(k === 'b' ? 'bold' : 'italic', false, null); }
    });
    el.addEventListener('paste', function (e) {
      e.preventDefault();
      var t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
  }
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
  function fmtMoney(minor, cur) { if (minor == null) return '—'; var n = Number(minor) / 100; return (cur ? cur + ' ' : '$') + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  /** Money as it prints in the proposal totals block: "USD $8,662.50". */
  function fmtUsd(minor) { return 'USD ' + fmtMoney(minor, ''); }
  /**
   * The "prints instead of TBD" box takes wording, but people type the amount into it
   * — it sits beside the amount box and looks like one. A plain number in there is
   * money, so it counts toward the total instead of printing as loose text.
   */
  function overrideMinor(text) {
    if (text == null) return 0;
    var s = String(text).trim().replace(/^\$/, '').replace(/,/g, '');
    if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return 0;
    return Math.round(parseFloat(s) * 100);
  }
  /** The amount box if it carries a figure, otherwise a numeric TBD override. */
  function metaAmount(minor, override) { return (Number(minor) || 0) || overrideMinor(override); }
  /**
   * Standard Freight: a manually keyed amount for shipments the two quoted freight
   * lines do not describe. It counts — and prints — only while its box is ticked, so
   * an amount left behind from an earlier draft cannot leak into a proposal.
   */
  function stdFreightOf(meta) { return (meta && meta.stdFreightOn) ? (Number(meta.stdFreightMinor) || 0) : 0; }
  /**
   * The order discount, entered either as a percentage of the product subtotal or
   * as a flat amount.
   *
   * Percentage is the original and remains the default: a proposal saved before
   * this existed has no discountMode, reads as PCT, and computes exactly what it
   * always did. The basis is the product subtotal ONLY — freight and tax are not
   * discounted, which is what the desk has always meant by "10% off".
   *
   * A flat amount is stored in minor units and used verbatim. It is clamped to the
   * subtotal so a mistyped figure cannot produce a negative order, and rounding on
   * the percentage path is to the cent.
   */
  function discountOf(meta, subtotal) {
    var m = meta || {};
    var mode = m.discountMode === 'AMT' ? 'AMT' : 'PCT';
    var pct = Number(m.discountPct) || 0;
    var amount = mode === 'AMT'
      ? Math.round(Number(m.discountAmountMinor) || 0)
      : Math.round(subtotal * pct / 100);
    if (amount < 0) amount = 0;
    if (amount > subtotal) amount = subtotal;
    // The effective percentage is derived for display and reporting even on the
    // amount path, so margin reporting reads the same either way.
    var effPct = subtotal ? Math.round((amount / subtotal) * 1000) / 10 : 0;
    return { mode: mode, pct: mode === 'AMT' ? effPct : pct, amount: amount };
  }
  /** Totals-row label: the percentage prints only when one was entered as such. */
  function discountLabel(t) {
    return (t && t.discountMode === 'AMT') ? 'Discount' : 'Discount (' + (t ? t.discountPct : 0) + '%)';
  }

  /* --- API --- */
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    var at = tokens().at;
    if (at && !opts.noAuth) headers['Authorization'] = 'Bearer ' + at;
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  }
  async function refresh() {
    var rt = tokens().rt; if (!rt) return false;
    var r = await api('/auth/refresh', { method: 'POST', noAuth: true, body: { refreshToken: rt } });
    if (!r.ok) return false;
    var d = await r.json(); setTokens(d.accessToken, d.refreshToken); return true;
  }
  // Auth'd request with one transparent refresh-retry on 401. If the refresh itself
  // fails the session is genuinely dead — drop the tokens and show the login screen
  // rather than handing a 401 back to a caller that will render an empty page.
  async function authed(path, opts) {
    var r = await api(path, opts);
    if (r.status === 401) {
      if (await refresh()) r = await api(path, opts);
      else { clearTokens(); renderLogin('Your session expired. Please sign in again.'); return r; }
    }
    return r;
  }

  /* --- Login --- */
  function renderLogin(msg, isGood) {
    root.innerHTML =
      '<div class="login-wrap"><form class="login-card" id="loginForm">' +
        '<div style="text-align:center;margin-bottom:22px;"><div class="login-logo"></div><div class="login-brandname">Summit Sensory Gym</div><div class="login-brandsub">Proposal Management Software</div></div>' +
        '<h1>Welcome back</h1>' +
        '<div class="login-sub">Sign in to Summit Sensory Gym Proposal Management Software.</div>' +
        (msg ? (isGood
          ? '<div style="background:#eef6f0;border:1px solid #cfe4d6;color:#2f6b4c;border-radius:10px;padding:10px 13px;font-size:13px;margin-bottom:14px;">' + esc(msg) + '</div>'
          : '<div class="err">' + esc(msg) + '</div>') : '') +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>' +
        '<button class="btn" type="submit" id="submitBtn">Sign in</button>' +
        '<button type="button" class="link-btn" id="forgotBtn" style="margin-top:10px;text-align:center;padding:9px 16px;font-size:13px;">Forgot your password?</button>' +
        '<div id="ssoBlock" class="hidden">' +
          '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#a0a49a;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;">' +
            '<span style="flex:1;height:1px;background:#e7e8e3;"></span>or<span style="flex:1;height:1px;background:#e7e8e3;"></span>' +
          '</div>' +
          '<button type="button" class="link-btn" id="ssoBtn" style="text-align:center;padding:11px 16px;font-size:14px;">Sign in with Microsoft</button>' +
        '</div>' +
        '<div class="hint">Summit Sensory Gym · Proposal Management Software</div>' +
      '</form></div>';
    document.getElementById('loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = document.getElementById('submitBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        var r = await api('/auth/login', { method: 'POST', noAuth: true, body: { email: document.getElementById('email').value.trim(), password: document.getElementById('password').value } });
        if (!r.ok) { renderLogin(r.status === 401 ? 'Invalid email or password.' : 'Sign-in failed (' + r.status + ').'); return; }
        var d = await r.json(); setTokens(d.accessToken, d.refreshToken); boot();
      } catch (err) { renderLogin('Could not reach the server. Is it running?'); }
    });
    document.getElementById('forgotBtn').addEventListener('click', function () {
      renderForgotPassword(document.getElementById('email').value.trim());
    });
    // Reveal the Microsoft button only where SSO is actually configured.
    api('/auth/sso/status', { noAuth: true }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.enabled) return;
      var block = document.getElementById('ssoBlock');
      if (!block) return;
      block.classList.remove('hidden');
      document.getElementById('ssoBtn').addEventListener('click', function () {
        location.href = '/auth/sso/start';
      });
    }).catch(function () {});
  }

  /* --- Forgot / reset password ---------------------------------------------
   * Both screens live outside the shell: nobody is signed in yet. The request
   * endpoint always answers 204 so this page can never reveal whether an address
   * has an account — the confirmation copy is deliberately non-committal.
   */
  function loginShell(inner) {
    return '<div class="login-wrap"><form class="login-card" id="pwForm">' +
      '<div style="text-align:center;margin-bottom:22px;"><div class="login-logo"></div>' +
      '<div class="login-brandname">Summit Sensory Gym</div>' +
      '<div class="login-brandsub">Proposal Management Software</div></div>' +
      inner +
      '<div class="hint">Summit Sensory Gym · Proposal Management Software</div>' +
      '</form></div>';
  }

  function renderForgotPassword(prefill) {
    root.innerHTML = loginShell(
      '<h1>Reset your password</h1>' +
      '<div class="login-sub">Enter your work email and we will send you a link to choose a new password.</div>' +
      '<div class="field"><label for="fpEmail">Email</label><input id="fpEmail" type="email" autocomplete="username" value="' + esc(prefill || '') + '" required></div>' +
      '<button class="btn" type="submit" id="fpBtn">Send reset link</button>' +
      '<button type="button" class="link-btn" id="fpBack" style="margin-top:10px;text-align:center;padding:9px 16px;font-size:13px;">Back to sign in</button>',
    );
    document.getElementById('fpBack').addEventListener('click', function () { renderLogin(); });
    document.getElementById('pwForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = document.getElementById('fpEmail').value.trim();
      if (!/.+@.+\..+/.test(email)) return;
      var btn = document.getElementById('fpBtn'); btn.disabled = true; btn.textContent = 'Sending…';
      try { await api('/auth/forgot-password', { method: 'POST', noAuth: true, body: { email: email } }); } catch (err) {}
      root.innerHTML = loginShell(
        '<h1>Check your email</h1>' +
        '<div class="login-sub">If <b>' + esc(email) + '</b> has an account, a reset link is on its way. ' +
        'The link expires in 60 minutes and can only be used once.</div>' +
        '<button type="button" class="btn" id="fpDone">Back to sign in</button>',
      );
      document.getElementById('fpDone').addEventListener('click', function () { renderLogin(); });
    });
  }

  /** Landing screen for an emailed link: /?reset=<token> */
  async function renderResetPassword(token) {
    root.innerHTML = loginShell('<h1>Reset your password</h1><div class="login-sub">Checking your link…</div>');
    var state = 'UNKNOWN';
    try {
      var r = await api('/auth/reset-password?token=' + encodeURIComponent(token), { noAuth: true });
      if (r.ok) state = ((await r.json()) || {}).state || 'UNKNOWN';
    } catch (err) {}
    if (state !== 'VALID') {
      var why = state === 'EXPIRED' ? 'That link has expired.'
        : state === 'USED' ? 'That link has already been used.'
        : 'That link is not valid.';
      root.innerHTML = loginShell(
        '<h1>Link no longer works</h1>' +
        '<div class="login-sub">' + why + ' Reset links last 60 minutes and work once. Request a new one below.</div>' +
        '<button type="button" class="btn" id="rpAgain">Request a new link</button>' +
        '<button type="button" class="link-btn" id="rpBack" style="margin-top:10px;text-align:center;padding:9px 16px;font-size:13px;">Back to sign in</button>',
      );
      document.getElementById('rpAgain').addEventListener('click', function () { clearResetParam(); renderForgotPassword(''); });
      document.getElementById('rpBack').addEventListener('click', function () { clearResetParam(); renderLogin(); });
      return;
    }
    root.innerHTML = loginShell(
      '<h1>Choose a new password</h1>' +
      '<div class="login-sub">At least 12 characters. You will be signed out everywhere else.</div>' +
      '<div id="rpErr"></div>' +
      '<div class="field"><label for="rpPass">New password</label><input id="rpPass" type="password" autocomplete="new-password" required></div>' +
      '<div class="field"><label for="rpPass2">Confirm new password</label><input id="rpPass2" type="password" autocomplete="new-password" required></div>' +
      '<button class="btn" type="submit" id="rpBtn">Set new password</button>',
    );
    document.getElementById('pwForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var box = document.getElementById('rpErr');
      var p1 = document.getElementById('rpPass').value, p2 = document.getElementById('rpPass2').value;
      if (p1.length < 12) { box.innerHTML = '<div class="err">Password must be at least 12 characters.</div>'; return; }
      if (p1 !== p2) { box.innerHTML = '<div class="err">Those passwords do not match.</div>'; return; }
      var btn = document.getElementById('rpBtn'); btn.disabled = true; btn.textContent = 'Saving…';
      var msg = '';
      try {
        var r = await api('/auth/reset-password', { method: 'POST', noAuth: true, body: { token: token, newPassword: p1 } });
        if (r.ok) {
          clearResetParam();
          renderLogin('Password updated. Sign in with your new password.', true);
          return;
        }
        try { msg = ((await r.json()) || {}).message || ''; } catch (err2) {}
      } catch (err) {}
      btn.disabled = false; btn.textContent = 'Set new password';
      box.innerHTML = '<div class="err">' + esc(msg || 'Could not set the password. Request a new link.') + '</div>';
    });
  }

  /** Drop ?reset= from the address bar so the token is not left in history. */
  function clearResetParam() {
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }

  function brandHtml() {
    return '<div class="brand"><div class="brand-mark"></div><div class="brand-name"><b>Summit Sensory Gym</b><span>Proposal Management Software</span></div></div>';
  }

  /* --- Shell --- */
  var NAV = [
    { id: 'dashboard', label: 'Dashboard', ready: true, roles: '*' },
    { id: 'crm', label: 'CRM', ready: true, roles: '*' },
    { id: 'catalog', label: 'Catalog', ready: true, roles: '*' },
    { id: 'proposals', label: 'Proposals', ready: true, roles: '*' },
    // promoted: rendered as its own box at the foot of the nav, not as a list row.
    { id: 'mock', label: 'Mock Proposal', ready: true, promoted: true, roles: ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'SALES_REP', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'PROJECT_MANAGER'] },
    { id: 'reports', label: 'Reports', ready: true, roles: '*' },
    { id: 'orders', label: 'Orders & Bill of Materials', ready: true, roles: '*' },
    { id: 'admin', label: 'Administration', ready: true, roles: ['SYSTEM_ADMIN'] },
    { id: 'integrations', label: 'Integrations', ready: true, roles: ['SYSTEM_ADMIN', 'EXECUTIVE', 'ACCOUNTING'] },
  ];
  var CRM_WRITE_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'SALES_REP', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'PROJECT_MANAGER'];
  function canCrmWrite(role) { return CRM_WRITE_ROLES.indexOf(role) !== -1; }
  function canCatalogAdmin(role) { return role === 'SYSTEM_ADMIN'; }
  var ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_REP', 'SALES_MANAGER', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'ACCOUNTING', 'PROJECT_MANAGER', 'INSTALLER', 'READ_ONLY'];
  var PROP_WRITE = CRM_WRITE_ROLES;
  var PROP_REVIEW = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER'];
  var PROP_RELEASE = PROP_REVIEW;
  // proposal:archive. A rep is in the list but is limited to proposals they created —
  // the button checks ownership, and so does the route.
  var PROP_ARCHIVE = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'SALES_REP', 'ACCOUNTING'];
  var PROP_ARCHIVE_ANY = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'ACCOUNTING'];
  function canArchive(r, user) {
    if (!hasRole(PROP_ARCHIVE, user.role)) return false;
    return hasRole(PROP_ARCHIVE_ANY, user.role) || (r.createdById && r.createdById === user.id);
  }
  var ORDERS_MANAGE_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'OPERATIONS', 'PROJECT_MANAGER'];
  var HANDOFF_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'OPERATIONS', 'PROJECT_MANAGER'];
  // quickbooks:transact — who may authorize and create live financial documents.
  var QBO_TXN_ROLES = ['SYSTEM_ADMIN', 'ACCOUNTING'];
  var QBO_VIEW_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'ACCOUNTING'];
  function hasRole(list, role) { return list.indexOf(role) !== -1; }
  function navFor(role) {
    return NAV.filter(function (n) {
      if (n.roles === '*') return true;
      // Defensive: a nav entry whose role list is missing used to throw here and take
      // the entire shell down rather than just hiding one tab.
      return Array.isArray(n.roles) && n.roles.indexOf(role) !== -1;
    });
  }
  function roleLabel(role) { return titleCase(role); }

  // Business numbers (deposit %, proposal validity, leg spans) come from
  // Administration → Formulas → Business numbers; these are the fallbacks.
  var fxSettings = {
    depositPct: 50, proposalValidityDays: 7,
    legsSmallMaxFt: 10, legsSmallCount: 4, legsMediumMaxFt: 20, legsMediumCount: 6, legsLargeCount: 8,
    matCostPerSqFt325: 11.78, matCostPerSqFt2: 7.65, matMarkupMultiplier: 1.4, matOverageIn: 14,
  };
  function loadFxSettings() {
    return authed('/formulas/settings').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) Object.keys(d).forEach(function (k) { fxSettings[k] = Number(d[k]); }); })
      .catch(function () {});
  }
  function depositPct() { return Number(fxSettings.depositPct) || 50; }
  function depositOf(total) { return Math.round((Number(total) || 0) * depositPct() / 100); }
  /**
   * A totals row whose amount is optional. The first box is what prints on the
   * customer proposal when the amount is 0 — left blank, the standing "TBD" prints.
   */
  function optionalAmountRow(label, id, minor, tbdId, tbdVal) {
    var box = 'padding:5px 8px;border:1px solid #dcded7;border-radius:7px;';
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;font-size:14px;">' +
      '<span class="muted">' + label + '</span>' +
      '<span style="display:flex;align-items:center;gap:6px;">' +
        '<input id="' + tbdId + '" value="' + esc(tbdVal || '') + '" placeholder="TBD" title="Prints on the customer proposal in place of TBD when the amount is 0" style="width:104px;' + box + 'font-size:12.5px;color:#5c6157;">' +
        '<input id="' + id + '" value="' + m2d(minor) + '" style="width:100px;' + box + 'text-align:right;">' +
      '</span></div>';
  }

  /**
   * Standard Freight — manual entry only. It sits in the same column as the other
   * hand-keyed boxes and deliberately has nothing in the automated column: no desk
   * quote feeds it. Unticked, the amount is ignored and the line does not print.
   */
  function stdFreightRow() {
    var box = 'padding:5px 8px;border:1px solid #dcded7;border-radius:7px;';
    var on = !!pb.meta.stdFreightOn;
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;font-size:14px;">' +
      '<label style="display:flex;align-items:center;gap:7px;cursor:pointer;" title="Tick to put a manually entered freight amount on this proposal">' +
        '<input type="checkbox" id="mStdFreightOn"' + (on ? ' checked' : '') + ' style="width:15px;height:15px;accent-color:#3d4a55;cursor:pointer;flex:0 0 auto;">' +
        '<span class="muted">Standard Freight $</span>' +
      '</label>' +
      '<span style="display:flex;align-items:center;gap:6px;">' +
        '<input id="mStdFreight" value="' + (on ? m2d(pb.meta.stdFreightMinor || 0) : '') + '" placeholder="0.00"' + (on ? '' : ' disabled') +
          ' title="Enter the freight amount by hand" style="width:104px;' + box + 'text-align:right;' + (on ? '' : 'background:#f4f5f1;color:#a0a49a;') + '">' +
        '<span style="width:100px;flex:0 0 auto;" aria-hidden="true"></span>' +
      '</span></div>';
  }

  function renderShell(user) {
    currentUser = user;
    loadFxSettings();
    var items = navFor(user.role);
    var initials = (user.name || user.email || '?').slice(0, 1).toUpperCase();
    root.innerHTML =
      '<div class="shell">' +
        '<aside class="side">' + brandHtml() +
          '<nav class="nav" id="nav">' +
            items.filter(function (n) { return !n.promoted; }).map(function (n) {
              return '<button class="nav-item' + (n.id === 'dashboard' ? ' active' : '') + (n.ready ? '' : ' soon') + '" data-view="' + n.id + '">' +
                '<span>' + esc(n.label) + '</span>' + (n.ready ? '' : '<span class="nav-tag">soon</span>') + '</button>';
            }).join('') +
            // Promoted entries sit in a box in the space the list leaves at the bottom.
            // They stay inside <nav> so the existing click delegation still reaches them.
            items.filter(function (n) { return n.promoted; }).map(function (n) {
              return '<div class="nav-promo">' +
                '<span class="nav-promo-eyebrow">Quick pricing</span>' +
                '<button class="nav-item" data-view="' + n.id + '"><span>' + esc(n.label) + '</span></button>' +
                '<span class="nav-promo-hint">Price a build on the spot. Nothing is saved.</span>' +
              '</div>';
            }).join('') +
          '</nav>' +
          '<div class="side-foot"><div class="user-row"><div class="avatar">' + esc(initials) + '</div>' +
            '<div class="user-meta"><b>' + esc(user.name || user.email) + '</b><span>' + esc(roleLabel(user.role)) + '</span></div></div>' +
            '<button class="link-btn" id="profBtn" style="margin-bottom:6px;">My Profile</button>' +
            '<button class="link-btn" id="pwdBtn" style="margin-bottom:6px;">Change Password</button>' +
            '<button class="link-btn" id="logoutBtn">Sign Out</button>' +
            '<div style="text-align:center;font-size:10px;color:#b3b7ac;margin-top:8px;letter-spacing:.04em;">build 50 · freight alerts</div></div>' +
        '</aside>' +
        '<main class="main"><div class="topbar"><div class="eyebrow">Summit Sensory Gym Proposal Management Software</div><h2 id="viewTitle">Dashboard</h2></div>' +
          '<div class="content" id="view"></div></main>' +
      '</div>';
    document.getElementById('nav').addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-item'); if (!btn) return;
      var id = btn.getAttribute('data-view');
      Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var item = NAV.filter(function (n) { return n.id === id; })[0];
      document.getElementById('viewTitle').textContent = item.label;
      if (id === 'dashboard') renderDashboard(user);
      else if (id === 'crm') renderCrm(user);
      else if (id === 'catalog') renderCatalog(user);
      else if (id === 'proposals') renderProposals(user);
      else if (id === 'mock') renderMockProposal(user);
      else if (id === 'reports') renderReports(user);
      else if (id === 'orders') renderOrders(user);
      else if (id === 'admin') renderAdmin(user);
      else if (id === 'integrations') renderIntegrations(user);
      else renderSoon(item.label);
    });
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('pwdBtn').addEventListener('click', openPasswordForm);
    document.getElementById('profBtn').addEventListener('click', function () { openProfileForm(user); });
    renderDashboard(user);
  }

  /* ==================== Mock Proposal ====================
   * A proposal built for a phone call: pick a series, answer the configurator, read the
   * retail figures back. Nothing is stored and nothing is printed — it exists to answer
   * "what would that cost" without creating a customer record first.
   *
   * It is the SAME builder, not a copy. `pb.mock` switches off everything a customer
   * must not see (margin, cost, freight) and everything that would commit it (save,
   * templates, freight requests, print). Sharing the code is the point: a mock priced by
   * a parallel implementation would drift from the real one, and then it would be worse
   * than no answer at all.
   */
  function isMock() { return !!(pb && pb.mock); }

  function renderMockProposal(user) {
    pb = null;
    document.getElementById('view').innerHTML =
      '<div style="max-width:760px;">' +
        '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;padding:24px 26px;">' +
          '<div style="font-family:\'Newsreader\',serif;font-size:22px;font-weight:600;margin-bottom:6px;">Price something on the spot</div>' +
          '<div class="muted" style="font-size:13.5px;line-height:1.6;max-width:560px;">Answer a configurator and read the retail total back. Nothing is saved, nothing prints, and no internal figures appear — so the screen can be turned toward a customer. Turn it into a real proposal at any point and it asks who it is for.</div>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;">' +
            '<button class="btn" id="mkAdv" style="width:auto;padding:11px 20px;background:#3d4a55;">⚙ Adventure Series</button>' +
            '<button class="btn" id="mkSoar" style="width:auto;padding:11px 20px;background:#3d4a55;">⚙ Summit Soar</button>' +
            '<button class="btn" id="mkFlex" style="width:auto;padding:11px 20px;background:#3d4a55;">⚙ Summit Flex</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('mkAdv').addEventListener('click', function () { startMock(user, 'adv'); });
    document.getElementById('mkSoar').addEventListener('click', function () { startMock(user, 'soar'); });
    document.getElementById('mkFlex').addEventListener('click', function () { startMock(user, 'flex'); });
  }

  /**
   * Stand up a builder with no proposal behind it.
   *
   * proposalId and versionId are deliberately null: every path that would reach the
   * server for this document checks them, so a mock cannot save, cannot raise a freight
   * request and cannot be released by accident.
   */
  function startMock(user, series) {
    var today = todayISO();
    pb = {
      mock: true, mockSeries: series,
      proposalId: null, versionId: null, user: user, orgName: '', stdNotes: [],
      title: '', number: '', version: 1,
      meta: {
        contactName: '', shipTo: '', billTo: '', billSameAsShip: true, showTitle: true,
        projectId: '', showProjectId: false, showDeposit: true,
        tbdTax: '', tbdStructureFreight: '', tbdMatsFreight: '',
        proposalDate: today, taxAmountMinor: 0, discountPct: 0, discountMode: 'PCT', discountAmountMinor: 0,
        structureFreightMinor: 0, matsFreightMinor: 0,
        stdFreightOn: false, stdFreightMinor: 0,
        expiration: addDays(today, 7), footerNotes: [], advAnswers: null, advWarnings: [],
      },
      lines: [],
    };
    hwSig = JSON.stringify(hardwareQty());
    loadItemDefaults().then(function () {
      renderBuilder();
      if (series === 'adv') openAdventureConfigurator();
      else if (series === 'soar') openSoarConfigurator();
      // Flex has no configurator anywhere in the app — it is a catalogue pick, and the
      // builder's own "Start from Summit Flex" button does exactly this.
      else openLinePicker('Summit Flex');
    });
  }

  /**
   * Hand a mock over to a real customer.
   *
   * Creates the proposal, then writes the lines onto its first version — the same PATCH
   * the builder uses — so the document that appears is the one that was on screen.
   */
  async function convertMockToProposal(user) {
    var orgs = [];
    try { var r = await authed('/crm/organizations?pageSize=200'); if (r.ok) orgs = (await r.json()).items || []; } catch (e) {}
    if (!orgs.length) { alert('There are no customers to attach this to yet. Create one under CRM first.'); return; }
    var lines = pb.lines.slice(), meta = pb.meta, title = pb.title;
    openModal('Turn this into a real proposal',
      fieldRow('Customer', '<select id="mkOrg" style="' + IN + '">' + orgs.map(function (o) { return '<option value="' + o.id + '">' + esc(o.name) + '</option>'; }).join('') + '</select>') +
      fieldRow('Proposal title', '<input id="mkTitle" style="' + IN + '" value="' + esc(title || '') + '" placeholder="e.g. Adventure Series 10\' × 8\'">') +
      '<div class="muted" style="font-size:12.5px;line-height:1.55;">The lines on screen are copied across as a draft. Freight, tax and the internal figures are filled in on the real proposal, where they belong.</div>',
      async function (close, showErr) {
        var t = document.getElementById('mkTitle').value.trim();
        if (t.length < 2) return showErr('Give the proposal a title.');
        var cr = await authed('/proposals', { method: 'POST', body: { organizationId: document.getElementById('mkOrg').value, title: t } });
        if (!cr.ok) return showErr(await serverMessage(cr, 'Could not create the proposal (' + cr.status + ').'));
        var created = await cr.json();
        var vid = created && created.versions && created.versions.length ? created.versions[0].id : (created && created.versionId);
        if (!vid) return showErr('The proposal was created but its first version could not be found — open it from Proposals and re-run the configurator.');
        var payload = {
          title: t,
          sections: [{ id: 'meta', type: 'CUSTOMER_INFO', title: 'Proposal', order: 0, enabled: true, data: meta }],
          items: lines.map(function (l, i) {
            return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, internalNote: l.internalNote || '', components: l.components || null, source: l.source || '', freightTbd: !!l.freightTbd, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, costEach: Number(l.costEach) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i };
          }),
          expirationDate: meta.expiration || undefined,
        };
        var pr = await authed('/proposals/versions/' + vid, { method: 'PATCH', body: payload });
        if (!pr.ok) return showErr('The proposal was created but its lines could not be saved (' + pr.status + '). Open it from Proposals.');
        close();
        pb = null;
        activateNav('proposals');
        openProposalDetail(created.id || (created.proposal && created.proposal.id), user);
      }, 'Create proposal');
  }

  /** Jump to a view from anywhere (keeps the sidebar selection in sync). */
  function activateNav(id) {
    var item = NAV.filter(function (n) { return n.id === id; })[0]; if (!item) return;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === id);
    });
    var t = document.getElementById('viewTitle'); if (t) t.textContent = item.label;
  }

  async function renderDashboard(user) {
    var canWrite = hasRole(PROP_WRITE, user.role);
    document.getElementById('view').innerHTML =
      '<div id="dashKpis" class="grid"><div class="card"><div class="k">Loading…</div></div></div>' +
      '<div class="section-title">Needs your attention</div>' +
      '<div id="dashAttention"><div class="muted" style="padding:18px;">Loading…</div></div>' +
      '<div class="section-title">Recently updated proposals</div>' +
      '<div id="dashRecent"><div class="muted" style="padding:18px;">Loading…</div></div>' +
      '<div class="section-title">Quick actions</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px;">' +
        (canWrite ? '<button class="btn" id="dqNew" style="width:auto;padding:10px 16px;">New proposal</button>' : '') +
        (canCrmWrite(user.role) ? '<button class="link-btn" id="dqMonday" style="width:auto;padding:10px 15px;">Import a customer from monday</button>' : '') +
        '<button class="link-btn" id="dqReports" style="width:auto;padding:10px 15px;">Open reports</button>' +
        '<button class="link-btn" id="dqCatalog" style="width:auto;padding:10px 15px;">Catalog &amp; pricing</button>' +
      '</div>' +
      '<div class="grid">' +
        '<div class="card"><div class="k">Signed in as</div><div class="v small">' + esc(user.name || user.email) + '</div><div class="muted" style="font-size:12.5px;margin-top:4px;">' + esc(user.email) + ' · ' + esc(roleLabel(user.role)) + '</div></div>' +
        '<div class="card"><div class="k">API status</div><div class="v small" id="apiStatus"><span class="dot wait"></span>Checking…</div></div>' +
        '<div class="card"><div class="k">Workspace</div><div class="v small">Summit Sensory Gym</div><div class="muted" style="font-size:12.5px;margin-top:4px;" id="dashScale">Proposal Management Software</div></div>' +
      '</div>';
    var nb = document.getElementById('dqNew'); if (nb) nb.addEventListener('click', function () { openProposalForm(user); });
    var mb = document.getElementById('dqMonday'); if (mb) mb.addEventListener('click', function () { openMondayLookup(user); });
    document.getElementById('dqReports').addEventListener('click', function () { activateNav('reports'); renderReports(user); });
    document.getElementById('dqCatalog').addEventListener('click', function () { activateNav('catalog'); renderCatalog(user); });
    try { var r = await fetch('/health'); var el = document.getElementById('apiStatus'); if (el) el.innerHTML = r.ok ? '<span class="dot ok"></span>Online' : '<span class="dot bad"></span>Error ' + r.status; }
    catch (e) { var el2 = document.getElementById('apiStatus'); if (el2) el2.innerHTML = '<span class="dot bad"></span>Offline'; }
    loadDashboard(user);
  }

  async function loadDashboard(user) {
    var data = null, orgTotal = null;
    try {
      var rr = await authed('/reports/proposals');
      if (rr.ok) data = await rr.json();
    } catch (e) {}
    try { var ro = await authed('/crm/organizations?pageSize=1'); if (ro.ok) orgTotal = (await ro.json()).total; } catch (e2) {}
    // Released proposals whose freight nobody has asked a vendor about. Its own
    // endpoint rather than part of the reporting payload: it reads the freight
    // requests, which reporting has no business knowing about.
    var freightRows = [];
    try { var rfq = await authed('/proposals/freight-alerts'); if (rfq.ok) freightRows = (await rfq.json()).alerts || []; } catch (e3) {}
    // Customers whose follow-up date has arrived. The date is set on the proposal's
    // notes rail but lives on the customer, so this reads the customer list rather
    // than the proposals.
    var followRows = [];
    try { var rfu = await authed('/crm/follow-ups'); if (rfu.ok) followRows = (await rfu.json()).rows || []; } catch (e4) {}
    var kpis = document.getElementById('dashKpis'); if (!kpis) return;
    if (!data) { kpis.innerHTML = '<div class="card"><div class="k">Proposals</div><div class="v small">Unavailable</div><div class="muted" style="font-size:12.5px;margin-top:4px;">Could not load reporting data.</div></div>'; return; }
    var s = data.summary;
    var released = (data.pipeline.filter(function (p) { return p.status === 'RELEASED'; })[0] || { count: 0, value: 0 });
    var review = (data.pipeline.filter(function (p) { return p.status === 'INTERNAL_REVIEW'; })[0] || { count: 0, value: 0 });
    var stale = data.rows.filter(function (r) { return r.status === 'DRAFT' && r.daysOpen >= 14; });
    var attn = data.expiredOpen.length + data.expiringSoon.length + review.count + stale.length + freightRows.length + followRows.length;
    kpis.innerHTML =
      kpi('Open proposals', s.open.toLocaleString(), fmt0(s.openValue) + ' in flight · avg ' + s.avgDaysOpen + ' days old', '#3d4a55') +
      kpi('Out with customers', released.count.toLocaleString(), fmt0(released.value) + ' awaiting a decision') +
      kpi('Accepted to date', fmt0(s.wonValue), s.won + ' proposals · ' + s.conversionRate + '% conversion', '#2f7d5d') +
      kpi('Needs attention', attn.toLocaleString(), attn ? 'expiring, stalled or awaiting review' : 'nothing waiting on you', attn ? '#9c3327' : '#2f7d5d');
    var scale = document.getElementById('dashScale');
    if (scale) scale.textContent = s.total.toLocaleString() + ' proposals · ' + (orgTotal == null ? data.byCustomer.length : orgTotal) + ' customers · ' + data.products.length.toLocaleString() + ' products proposed';

    function attnGroup(label, rows, color, note) {
      if (!rows.length) return '';
      return '<div style="margin-bottom:10px;"><div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;">' +
          '<span style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' + color + ';">' + esc(label) + ' · ' + rows.length + '</span>' +
          (note ? '<span class="muted" style="font-size:11.5px;">' + esc(note) + '</span>' : '') + '</div>' +
        '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:12px;overflow:hidden;">' +
        rows.slice(0, 6).map(function (r, i) {
          return '<div class="dashRow" data-id="' + r.id + '" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' + (i ? 'border-top:1px solid #f2f3ef;' : '') + '">' +
            '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
              '<div class="muted" style="font-size:12px;">' + esc(r.title) + ' · ' + esc(r.number) + '</div></div>' +
            '<div style="text-align:right;white-space:nowrap;font-size:12.5px;">' + fmt0(r.total) +
              '<div class="muted" style="font-size:11.5px;">' + (r.expiration ? 'expires ' + fmtDate(r.expiration) : r.daysOpen + ' days old') + '</div></div></div>';
        }).join('') + '</div></div>';
    }
    /**
     * Follow-ups that have come due. Customers, not proposals — the date is a promise
     * to make contact, and it stands whether or not the quote behind it is still live.
     */
    function followUpGroup(rows) {
      if (!rows.length) return '';
      return '<div style="margin-bottom:10px;"><div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;">' +
          '<span style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a6d1f;">Follow-Up Due · ' + rows.length + '</span>' +
          '<span class="muted" style="font-size:11.5px;">make contact</span></div>' +
        '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:12px;overflow:hidden;">' +
        rows.slice(0, 6).map(function (r, i) {
          var win = r.decisionFrom || r.decisionTo
            ? 'decides ' + (r.decisionFrom ? fmtDate(r.decisionFrom) : '?') + ' – ' + (r.decisionTo ? fmtDate(r.decisionTo) : '?')
            : 'no decision window recorded';
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;' + (i ? 'border-top:1px solid #f2f3ef;' : '') + '">' +
            '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
              '<div class="muted" style="font-size:12px;">' + esc(win) + '</div></div>' +
            '<div style="text-align:right;white-space:nowrap;font-size:12.5px;">' + esc(fmtDate(r.followUpDate)) +
              '<div class="muted" style="font-size:11.5px;">follow-up date</div></div></div>';
        }).join('') + '</div></div>';
    }
    var box = document.getElementById('dashAttention');
    var html = freightAlertGroup(freightRows) +
      followUpGroup(followRows) +
      attnGroup('Past expiration', data.expiredOpen, '#9c3327', 're-date or mark inactive') +
      attnGroup('Expiring within 14 days', data.expiringSoon, '#8a6d1f', 'follow up') +
      attnGroup('Awaiting internal review', data.rows.filter(function (r) { return r.status === 'INTERNAL_REVIEW'; }), '#3d4a55', '') +
      attnGroup('Drafts untouched 14+ days', stale, '#5c6157', 'stalled');
    box.innerHTML = html || '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">Nothing needs attention — no expiring, stalled or unreviewed proposals.</p></div>';

    var recent = document.getElementById('dashRecent');
    recent.innerHTML = repTable([['Customer'], ['Proposal'], ['Status'], ['Value', 'right'], ['Last modified']],
      data.rows.slice(0, 6).map(function (r) {
        return '<tr class="dashRow" data-id="' + r.id + '" style="cursor:pointer;">' +
          rtd('<b style="font-weight:600;">' + esc(r.customer) + '</b>', 'left') +
          rtd(esc(r.title) + '<div class="muted" style="font-size:11.5px;">' + esc(r.number) + '</div>') +
          rtd(statusChip(r.status) + (r.expired ? ' <span style="color:#9c3327;">⚑</span>' : '')) +
          rtd(fmt0(r.total), 'right', 1) + rtd(fmtDate(r.updatedAt)) + '</tr>';
      }).join(''), 'No proposals yet.');
    document.querySelectorAll('.dashRow').forEach(function (el) {
      el.addEventListener('click', function () { activateNav('proposals'); openProposalDetail(el.getAttribute('data-id'), user); });
    });
    // Straight into the proposal itself, freight section first — not the version
    // list, and not the builder.
    document.querySelectorAll('.freightRow').forEach(function (el) {
      el.addEventListener('click', function () {
        activateNav('proposals');
        openFreightReview(el.getAttribute('data-pid'), user, el.getAttribute('data-vid'));
      });
    });
  }

  /**
   * Released proposals carrying parts whose freight has never been requested.
   * First in the attention list and coloured like the overdue group: a job that
   * ships without a freight quote is a margin hole nobody planned.
   */
  function freightAlertGroup(rows) {
    if (!rows || !rows.length) return '';
    return '<div style="margin-bottom:10px;"><div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;">' +
        '<span style="font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9c3327;">Freight not requested \u00b7 ' + rows.length + '</span>' +
        '<span class="muted" style="font-size:11.5px;">released proposals waiting on a vendor freight quote</span></div>' +
      '<div style="background:#fdf1ef;border:1px solid #f0ccc6;border-radius:12px;overflow:hidden;">' +
      rows.slice(0, 8).map(function (r, i) {
        var vend = (r.vendors || []).join(', ');
        return '<div class="freightRow" data-pid="' + r.proposalId + '" data-vid="' + r.versionId + '" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' + (i ? 'border-top:1px solid #f6dcd7;' : '') + '">' +
          '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
            '<div class="muted" style="font-size:12px;">' + esc(r.title) + ' \u00b7 ' + esc(r.number) + ' v' + r.version + '</div></div>' +
          '<div style="text-align:right;white-space:nowrap;font-size:12.5px;color:#9c3327;font-weight:600;">' + r.pendingCount + ' item' + (r.pendingCount === 1 ? '' : 's') +
            '<div class="muted" style="font-size:11.5px;font-weight:400;">' + esc(vend || 'freight outstanding') + (r.removedCount ? ' \u00b7 ' + r.removedCount + ' removed' : '') + '</div></div></div>';
      }).join('') + '</div></div>';
  }

  /**
   * The proposal opened straight from the dashboard alert: the freight request
   * section at the top, flagged, with the line items below it marked up. Read only
   * by design \u2014 a released version is frozen, and the only thing outstanding here
   * is the request to the vendor, which is not part of the proposal.
   */
  async function openFreightReview(proposalId, user, versionId) {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="muted" style="padding:24px;">Loading\u2026</div>';
    var r = await authed('/proposals/' + proposalId);
    if (!r.ok) { view.innerHTML = '<div class="err">Could not load proposal.</div>'; return; }
    var p = await r.json();
    var versions = p.versions || [];
    var v = (versionId ? versions.filter(function (x) { return x.id === versionId; })[0] : null) || versions[versions.length - 1];
    if (!v) { view.innerHTML = '<div class="err">This proposal has no versions.</div>'; return; }
    var orgName = '';
    try { var ro = await authed('/crm/organizations/' + p.organizationId); if (ro.ok) orgName = (await ro.json()).name || ''; } catch (e) {}

    // The RFQ rail reads the builder state, so the review screen fills it in the
    // same shape. readOnly is what keeps the save-before-request step out.
    pb = {
      proposalId: p.id, versionId: v.id, user: user, readOnly: true, orgName: orgName,
      title: p.title || '', number: p.number || '', version: v.version || 1,
      meta: {}, stdNotes: [], lines: (v.items || []).map(function (it) { return normalizeLine(it); }),
    };
    rfqData = null;
    var cov = null;
    try { cov = await rfqApi('/proposals/versions/' + v.id + '/freight-coverage'); } catch (e2) {}

    var needs = !cov || cov.needsRequest;
    var headline = !cov
      ? 'Freight coverage could not be read.'
      : cov.needsRequest
        ? (cov.pendingCount || cov.lines.filter(function (l) { return l.state === 'DRAFT'; }).length) + ' item' +
          ((cov.pendingCount === 1) ? '' : 's') + ' on this proposal have no freight quote requested.'
        : 'Every item that needs freight has been requested.';
    var covLines = cov ? cov.lines : [];
    var removed = cov ? (cov.removed || []) : [];

    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
        '<button class="link-btn" id="frBack" style="width:auto;padding:7px 13px;">\u2039 Back to proposals</button>' +
        '<button class="link-btn" id="frDoc" style="width:auto;padding:9px 14px;">View the proposal document</button>' +
      '</div>' +
      '<div class="card" style="margin-bottom:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">' +
          '<div><div class="k">' + esc(p.number || '') + ' \u00b7 v' + (v.version || 1) + '</div>' +
            '<h2 style="font-size:22px;margin-top:2px;">' + esc(p.title || '') + '</h2>' +
            '<div class="muted" style="font-size:13px;margin-top:2px;">' + esc(orgName) + '</div></div>' +
          '<span class="chip">' + titleCase(v.status || 'DRAFT') + '</span></div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.55;">Read only. Freight can be requested from here without editing the proposal \u2014 a released version is frozen.</div>' +
      '</div>' +
      '<div id="frFreight" style="' + (needs ? 'border:2px solid #c8483a;background:#fdf1ef;' : 'border:1px solid #cfe3d7;background:#f4faf6;') + 'border-radius:14px;padding:14px 15px;margin-bottom:18px;">' +
        '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:' + (needs ? '#9c3327' : '#2f7d5d') + ';">Request for Freight</div>' +
          '<div style="font-size:12.5px;color:' + (needs ? '#7d2a20' : '#2f7d5d') + ';line-height:1.5;">' + esc(headline) + '</div>' +
        '</div>' +
        '<div id="bRfqRail"></div>' +
      '</div>' +
      '<div class="section-title">Line items</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
        (covLines.length
          ? covLines.map(freightReviewRow).join('') + removed.map(freightRemovedRow).join('')
          : '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">No product lines on this version.</p></div>') +
      '</div>';

    document.getElementById('frBack').addEventListener('click', function () { renderProposals(user); });
    document.getElementById('frDoc').addEventListener('click', function () { previewProposal(p, v); });
    loadRfqPanel(true);
  }

  /** One product line on the freight review, with its request state. */
  function freightReviewRow(l) {
    return '<div style="display:flex;align-items:center;gap:11px;background:#fff;border:1px solid #e7e8e3;border-radius:10px;padding:9px 12px;">' +
      '<span class="bFreightMark" data-sku="' + esc(l.sku || '') + '" style="width:20px;display:flex;align-items:center;justify-content:center;">' + freightMarkHtml(l.sku) + '</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13.5px;font-weight:600;">' + esc(l.name || l.sku) + '</div>' +
        '<div class="muted" style="font-size:11.5px;">' + esc(l.sku) + (l.vendor ? ' \u00b7 ' + esc(l.vendor) : '') + (l.reference ? ' \u00b7 ' + esc(l.reference) : '') + '</div>' +
      '</div>' +
      '<div style="font-size:12.5px;color:#5c6157;white-space:nowrap;">' + (Number(l.quantity) || 0) + '\u00d7</div>' +
      freightStateChip(l.state) + '</div>';
  }

  /**
   * A line that has been taken off the proposal but is still on a request the
   * vendor holds. Kept in the list and struck through rather than dropped: the
   * vendor is quoting it until the request is revised.
   */
  function freightRemovedRow(r) {
    return '<div style="display:flex;align-items:center;gap:11px;background:#fdf7f6;border:1px dashed #f0ccc6;border-radius:10px;padding:9px 12px;">' +
      '<span style="width:20px;text-align:center;color:#c8483a;font-size:13px;">\u2715</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13.5px;font-weight:600;color:#9c3327;text-decoration:line-through;text-decoration-color:#c8483a;">' + esc(r.name || r.sku) + '</div>' +
        '<div style="font-size:11.5px;color:#9c3327;">Removed from the proposal \u00b7 still listed on ' + esc(r.reference) + ' \u00b7 ' + esc(r.vendor) + '</div>' +
      '</div>' +
      '<div style="font-size:12.5px;color:#9c3327;white-space:nowrap;text-decoration:line-through;">' + (Number(r.quantity) || 0) + '\u00d7</div>' +
      '<span style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9c3327;background:#fbecea;padding:3px 8px;border-radius:999px;white-space:nowrap;">Revise</span></div>';
  }

  function renderSoon(label) {
    document.getElementById('view').innerHTML =
      '<div class="placeholder"><h3>' + esc(label) + '</h3><p>This module is coming in a future slice. Its backend endpoints are already built and tested.</p></div>';
  }

  /* --- CRM --- */
  var crm = { tab: 'orgs', q: '', page: 1 };

  function renderCrm(user) {
    var writable = canCrmWrite(user.role);
    var newLabel = crm.tab === 'orgs' ? 'New organization' : 'New opportunity';
    function tab(id, label) {
      var on = crm.tab === id;
      return '<button data-tab="' + id + '" style="border:none;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:' + (on ? '600' : '500') + ';cursor:pointer;background:' + (on ? '#fff' : 'transparent') + ';color:' + (on ? '#1c4039' : '#6b7065') + ';box-shadow:' + (on ? '0 1px 2px rgba(0,0,0,.06)' : 'none') + ';">' + label + '</button>';
    }
    document.getElementById('view').innerHTML =
      '<div style="display:flex;gap:5px;background:#eef0ea;padding:4px;border-radius:10px;width:max-content;margin-bottom:18px;">' + tab('orgs', 'Organizations') + tab('opps', 'Opportunities') + '</div>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;">' +
        '<input id="crmSearch" placeholder="Search ' + (crm.tab === 'orgs' ? 'organizations' : 'opportunities') + '…" value="' + esc(crm.q) + '" style="flex:1;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (writable ? '<button class="link-btn" id="crmMonday" style="width:auto;padding:10px 16px;">Find in monday</button>' : '') +
        (writable ? '<button class="btn" id="crmNew" style="width:auto;padding:10px 17px;">' + newLabel + '</button>' : '') +
      '</div>' +
      '<div id="crmList"><div class="muted" style="padding:24px;">Loading…</div></div>';

    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { crm.tab = b.getAttribute('data-tab'); crm.q = ''; crm.page = 1; renderCrm(user); });
    });
    var search = document.getElementById('crmSearch');
    var t; search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { crm.q = search.value.trim(); crm.page = 1; loadCrm(); }, 300); });
    if (writable) document.getElementById('crmNew').addEventListener('click', function () { crm.tab === 'orgs' ? openOrgForm() : openOppForm(); });
    if (writable) document.getElementById('crmMonday').addEventListener('click', function () { openMondayLookup(user); });
    loadCrm();
  }

  /* --- monday customer lookup: pull one customer on demand --- */
  function openMondayLookup(user) {
    openModal('Find a customer in monday',
      '<div class="field"><label for="mSearch">Customer name</label>' +
        '<input id="mSearch" style="' + IN + '" placeholder="e.g. Soar Autism Center" value="' + esc(crm.q || '') + '" autocomplete="off"></div>' +
      '<div id="mResults" class="muted" style="font-size:13px;padding:6px 0;">Type a name and press Search.</div>',
      async function (close, showErr) { await run(); var s = document.getElementById('mSave'); if (s) { s.disabled = false; s.textContent = 'Search'; } },
      'Search');

    var input = document.getElementById('mSearch');
    var box = document.getElementById('mResults');
    input.focus();

    async function run() {
      var q = input.value.trim();
      if (q.length < 2) { box.innerHTML = '<span class="muted">Type at least 2 characters.</span>'; return; }
      box.innerHTML = '<span class="muted">Searching monday…</span>';
      try {
        var r = await authed('/integrations/monday/search?q=' + encodeURIComponent(q));
        if (!r.ok) { box.innerHTML = '<div class="err">Search failed (' + r.status + ').</div>'; return; }
        var rows = await r.json();
        if (!rows.length) { box.innerHTML = '<span class="muted">No matches in monday for “' + esc(q) + '”.</span>'; return; }
        box.innerHTML = rows.map(function (x) {
          var where = [x.city, x.state].filter(Boolean).join(', ');
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #f2f3ef;">' +
            '<div><div style="font-weight:600;font-size:13.5px;">' + esc(x.name) + '</div>' +
            '<div class="muted" style="font-size:12px;">' + [x.industry, where, x.contact, x.projectId ? 'Project ' + x.projectId : ''].filter(Boolean).map(esc).join(' · ') + '</div></div>' +
            '<button class="link-btn mImp" data-id="' + esc(x.itemId) + '" style="width:auto;padding:6px 12px;white-space:nowrap;">Import</button>' +
          '</div>';
        }).join('');
        box.querySelectorAll('.mImp').forEach(function (b) {
          b.addEventListener('click', async function () {
            b.disabled = true; b.textContent = 'Importing…';
            try {
              var ir = await authed('/integrations/monday/import/deal/' + b.getAttribute('data-id'), { method: 'POST' });
              var res = await ir.json();
              if (!ir.ok) { b.textContent = 'Failed'; return; }
              b.textContent = res.deals.created ? 'Imported' : 'Updated';
              crm.q = ''; crm.page = 1; loadCrm();
            } catch (e) { b.textContent = 'Failed'; }
          });
        });
      } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
    }

  }

  async function loadCrm() {
    var box = document.getElementById('crmList'); if (!box) return;
    var path = (crm.tab === 'orgs' ? '/crm/organizations' : '/crm/opportunities') + '?page=' + crm.page + '&pageSize=20' + (crm.q ? '&q=' + encodeURIComponent(crm.q) : '');
    try {
      var r = await authed(path);
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      box.innerHTML = crm.tab === 'orgs' ? orgTable(d) : oppTable(d);
      wirePager(d);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function shell(headCols, rows, d) {
    if (!rows) rows = '';
    var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 20)));
    return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;">' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' +
      headCols.map(function (h) { return '<th style="text-align:left;padding:11px 16px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #eef0ea;background:#f7f8f4;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="' + headCols.length + '">No records yet.</td></tr>') + '</tbody></table>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;">' +
        '<span>' + (d.total || 0) + ' total</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="prevPg" ' + (crm.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button>' +
        '<span>Page ' + (d.page || 1) + ' of ' + totalPages + '</span>' +
        '<button id="nextPg" ' + (crm.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span>' +
      '</div>';
  }
  function wirePager(d) {
    var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 20)));
    var prev = document.getElementById('prevPg'), next = document.getElementById('nextPg');
    if (prev) prev.addEventListener('click', function () { if (crm.page > 1) { crm.page--; loadCrm(); } });
    if (next) next.addEventListener('click', function () { if (crm.page < totalPages) { crm.page++; loadCrm(); } });
  }
  function td(v) { return '<td style="padding:12px 16px;border-bottom:1px solid #f2f3ef;">' + v + '</td>'; }

  function orgTable(d) {
    var rows = (d.items || []).map(function (o) {
      return '<tr>' + td('<b style="font-weight:600;">' + esc(o.name) + '</b>') + td(esc(titleCase(o.customerType))) +
        td(o.taxExempt ? '<span class="chip">Tax exempt</span>' : '<span class="muted">—</span>') + td(fmtDate(o.createdAt)) + '</tr>';
    }).join('');
    return shell(['Name', 'Type', 'Tax status', 'Added'], rows, d);
  }
  function oppTable(d) {
    var rows = (d.items || []).map(function (o) {
      return '<tr>' + td('<b style="font-weight:600;">' + esc(o.name) + '</b>') + td('<span class="chip">' + esc(titleCase(o.stage)) + '</span>') +
        td(esc(titleCase(o.fundingStatus))) + td(fmtMoney(o.budgetAmountMinor, o.budgetCurrency)) + td(esc(o.desiredTimeline || '—')) + '</tr>';
    }).join('');
    return shell(['Name', 'Stage', 'Funding', 'Budget', 'Timeline'], rows, d);
  }

  /* --- Modal + forms --- */
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
      try { await onSubmit(close, fail); }
      catch (err) { fail('Something went wrong.'); }
    });
    return ov;
  }
  /** Which way the user was tabbing, if the render was triggered by a Tab at all. */
  var tabDir = null;
  document.addEventListener('keydown', function (e) {
    tabDir = e.key === 'Tab' ? (e.shiftKey ? 'back' : 'fwd') : null;
  }, true);
  // A click or a programmatic change is not a Tab, and must not advance the caret.
  document.addEventListener('mousedown', function () { tabDir = null; }, true);

  function focusablesIn(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('input,select,textarea'),
      function (el) { return !el.disabled && el.type !== 'hidden' && el.offsetParent !== null; },
    );
  }

  /**
   * Re-render an overlay and leave the caret where the keystroke was heading.
   *
   * `render` rebuilds the DOM; `host` is (or returns) the container to search
   * afterwards; `sel` finds the field that changed in the NEW markup. When the change
   * came from a Tab we advance to the next field ourselves, because the browser's own
   * focus move is aimed at a node that no longer exists. Otherwise we restore the
   * field that was focused, caret position included.
   */
  function renderKeepingTab(render, host, sel) {
    var dir = tabDir;
    var was = document.activeElement, range = null;
    try { range = was && was.selectionStart != null ? [was.selectionStart, was.selectionEnd] : null; } catch (e) {}
    render();
    var root = typeof host === 'function' ? host() : host;
    if (!root) return;
    var same = null;
    try { same = sel ? root.querySelector(sel) : null; } catch (e2) { same = null; }
    if (!dir) {
      if (same) { same.focus(); try { if (range) same.setSelectionRange(range[0], range[1]); } catch (e3) {} }
      return;
    }
    var list = focusablesIn(root);
    var i = same ? list.indexOf(same) : -1;
    var next = i === -1 ? null : list[dir === 'fwd' ? i + 1 : i - 1];
    if (next) { next.focus(); try { next.select(); } catch (e4) {} }
    else if (same) same.focus();
  }

  function fieldRow(label, inner) { return '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>'; }
  var IN = 'width:100%;padding:10px 12px;border:1px solid #dcded7;border-radius:9px;font-size:14px;background:#fff;color:#20241f;outline:none;';
  function selectEl(id, opts, sel) { return '<select id="' + id + '" style="' + IN + '">' + opts.map(function (o) { return '<option value="' + o + '"' + (o === sel ? ' selected' : '') + '>' + titleCase(o) + '</option>'; }).join('') + '</select>'; }

  var CUSTOMER_TYPES = ['HEALTHCARE_SYSTEM', 'HOSPITAL', 'PRIVATE_PRACTICE', 'SCHOOL', 'UNIVERSITY', 'GOVERNMENT', 'NONPROFIT', 'OTHER'];
  var STAGES = ['PROSPECT', 'QUALIFICATION', 'NEEDS_ANALYSIS', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];
  var FUNDING = ['UNFUNDED', 'BUDGETED', 'GRANT_PENDING', 'GRANT_AWARDED', 'APPROVED', 'SELF_FUNDED'];

  function openOrgForm() {
    openModal('New organization',
      fieldRow('Name', '<input id="fName" style="' + IN + '" required>') +
      fieldRow('Customer type', selectEl('fType', CUSTOMER_TYPES, 'OTHER')) +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:2px 0 4px;cursor:pointer;"><input type="checkbox" id="fTax"> Tax exempt</label>' +
      fieldRow('Notes', '<textarea id="fNotes" rows="3" style="' + IN + 'resize:vertical;"></textarea>'),
      async function (close, showErr) {
        var name = document.getElementById('fName').value.trim();
        if (name.length < 2) return showErr('Name must be at least 2 characters.');
        var body = { name: name, customerType: document.getElementById('fType').value, taxExempt: document.getElementById('fTax').checked, notes: document.getElementById('fNotes').value.trim() || undefined };
        var r = await authed('/crm/organizations', { method: 'POST', body: body });
        if (r.status === 409) {
          var dj = await r.json();
          if (confirm('A similar organization may already exist (' + (dj.duplicates || []).map(function (x) { return x.name; }).join(', ') + '). Create anyway?')) {
            r = await authed('/crm/organizations?force=true', { method: 'POST', body: body });
          } else return showErr('Cancelled — possible duplicate.');
        }
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); crm.page = 1; loadCrm();
      });
  }

  async function openOppForm() {
    var orgs = [];
    try { var r = await authed('/crm/organizations?pageSize=100'); if (r.ok) orgs = (await r.json()).items || []; } catch (e) {}
    if (!orgs.length) { alert('Create an organization first — opportunities belong to one.'); return; }
    var orgOpts = orgs.map(function (o) { return '<option value="' + o.id + '">' + esc(o.name) + '</option>'; }).join('');
    openModal('New opportunity',
      fieldRow('Organization', '<select id="fOrg" style="' + IN + '">' + orgOpts + '</select>') +
      fieldRow('Name', '<input id="fName" style="' + IN + '" required>') +
      fieldRow('Stage', selectEl('fStage', STAGES, 'PROSPECT')) +
      fieldRow('Funding status', selectEl('fFund', FUNDING, 'UNFUNDED')) +
      '<div style="display:flex;gap:10px;"><div class="field" style="flex:1;"><label>Budget (optional)</label><input id="fBudget" placeholder="0.00" style="' + IN + '"></div>' +
      '<div class="field" style="width:110px;"><label>Currency</label><input id="fCur" value="USD" maxlength="3" style="' + IN + 'text-transform:uppercase;"></div></div>' +
      fieldRow('Desired timeline', '<input id="fTimeline" placeholder="e.g. Q3 2026" style="' + IN + '">'),
      async function (close, showErr) {
        var name = document.getElementById('fName').value.trim();
        if (name.length < 2) return showErr('Name must be at least 2 characters.');
        var budget = document.getElementById('fBudget').value.trim();
        if (budget && !/^\d+(\.\d{1,2})?$/.test(budget)) return showErr('Budget must be a number like 12500.00');
        var body = {
          organizationId: document.getElementById('fOrg').value, name: name,
          stage: document.getElementById('fStage').value, fundingStatus: document.getElementById('fFund').value,
          desiredTimeline: document.getElementById('fTimeline').value.trim() || undefined,
        };
        if (budget) { body.budgetAmount = budget; body.budgetCurrency = (document.getElementById('fCur').value.trim() || 'USD').toUpperCase(); }
        var r = await authed('/crm/opportunities', { method: 'POST', body: body });
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); crm.tab = 'opps'; crm.page = 1; loadCrm();
      });
  }

  /* --- Catalog --- */
  var cat = { q: '', status: '', page: 1, tab: 'items', rows: [], filters: {}, sort: { key: 'sku', dir: 'asc' } };
  var catCategories = [];
  var KINDS = ['PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE'];
  var STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
  function catById(id) { return catCategories.filter(function (x) { return x.id === id; })[0] || null; }
  function catName(id) { var c = catById(id); return c ? c.name : '—'; }
  /** Full tier path for a category, e.g. ["Adventure Series", "Zip Line", "Complete Zip Line Kit"]. */
  function catPath(id) {
    var out = [], seen = {}, c = catById(id);
    while (c && !seen[c.id]) { seen[c.id] = 1; out.unshift(c); c = c.parentId ? catById(c.parentId) : null; }
    return out;
  }
  function catPathLabel(id, sep) {
    var p = catPath(id);
    return p.length ? p.map(function (c) { return c.name; }).join(sep || ' › ') : '—';
  }
  /** Categories ordered by their path, for an indented picker. */
  function catOptionsTree(selectedId) {
    var rows = catCategories.map(function (c) {
      var p = catPath(c.id);
      return { id: c.id, depth: Math.max(0, p.length - 1), sortKey: p.map(function (x) { return x.name.toLowerCase(); }).join(' / '), name: c.name, tier: c.tierLevel || p.length };
    }).sort(function (a, b) { return a.sortKey.localeCompare(b.sortKey); });
    return rows.map(function (r) {
      var pad = '';
      for (var i = 0; i < r.depth; i++) pad += '\u00a0\u00a0\u00a0';
      return '<option value="' + r.id + '"' + (r.id === selectedId ? ' selected' : '') + '>' + pad + esc(r.name) + ' · tier ' + r.tier + '</option>';
    }).join('');
  }
  function slugify(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  function renderCatalog(user) {
    function ctab(id, label){var on=cat.tab===id;return '<button data-ctab="'+id+'" style="border:none;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:'+(on?'600':'500')+';cursor:pointer;background:'+(on?'#fff':'transparent')+';color:'+(on?'#1c4039':'#6b7065')+';box-shadow:'+(on?'0 1px 2px rgba(0,0,0,.06)':'none')+';">'+label+'</button>';}
    document.getElementById('view').innerHTML = '<div style="display:flex;gap:5px;background:#eef0ea;padding:4px;border-radius:10px;width:max-content;margin-bottom:18px;">'+ctab('items','Catalog')+ctab('products','Product tree')+ctab('bundles','Bundles')+ctab('manufacturers','Manufacturers')+ctab('notes','Proposal notes')+'</div><div id="catBody"></div>';
    document.querySelectorAll('[data-ctab]').forEach(function(b){b.addEventListener('click',function(){cat.tab=b.getAttribute('data-ctab');renderCatalog(user);});});
    if(cat.tab==='products') renderCatalogProducts(user);
    else if(cat.tab==='bundles') renderBundles(user);
    else if(cat.tab==='manufacturers') renderManufacturers(user);
    else if(cat.tab==='notes') renderNotesTab(user);
    else renderItems(user);
  }

  /** Catalog → Proposal notes: the reusable note blocks the builder can drop onto a proposal. */
  function renderNotesTab() {
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px;">' +
        '<div class="muted" style="font-size:12.5px;max-width:640px;line-height:1.5;">Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically, and a note can name the parts that pull it in; the rest are picked from <b style="font-weight:600;">+ Standard note…</b> in the builder. Table notes print inside the line items; footer notes print below the signature lines.</div>' +
        '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;white-space:nowrap;">+ New note</button></div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>';
    document.getElementById('snNew').addEventListener('click', function () { openStandardNoteForm(null); });
    // No question-template button on this tab — it belongs to Administration. Wiring it
    // here threw on a null element and killed loadStandardNotes() below it, which is why
    // the list sat on "Loading…" forever.
    loadStandardNotes();
  }

  /* --- The one catalog list: Product + SKU merged, one row per part number --- */
  var itemState = { q: '', page: 1, categories: [], manufacturers: [], rows: [], filters: {}, sort: { key: 'part', dir: 'asc' } };
  function renderItems(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="itSearch" placeholder="Search part #, name, category or manufacturer…" value="' + esc(itemState.q) + '" style="flex:1;min-width:240px;max-width:420px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="itImport" style="width:auto;padding:10px 15px;">Import Excel / CSV</button><button class="btn" id="itNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">Every product on one line — name, category, manufacturer, cost, price and weight. Edit any cell and it saves as you leave the field. These prices and weights are what the Adventure Series engine and the proposal builder multiply against. <b>Override OK</b> lets a rep substitute that part number in the Adventure Series builder — leave it off and the part is fixed.</div>' +
      '<div id="itList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('itSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { itemState.q = s.value.trim(); itemState.page = 1; loadItems(user); }, 300); });
    if (admin) {
      document.getElementById('itNew').addEventListener('click', function () { openSkuForm(user); });
      document.getElementById('itImport').addEventListener('click', function () { openSkuImport(user); });
    }
    loadItems(user);
  }

  /* --- column filters (shared by the catalog list and the product tree) --- */
  var FCELL = 'width:100%;padding:5px 7px;border:1px solid #e2e5dd;border-radius:6px;font-size:12px;background:#fff;color:#3d4a55;outline:none;';
  /** Numeric column filter: 250, >250, <=0, >=1.5 … */
  function numFilter(expr) {
    var m = /^\s*(>=|<=|>|<|=)?\s*(-?[\d.]+)\s*$/.exec(expr || '');
    if (!m) return null;
    var op = m[1] || '=', v = parseFloat(m[2]);
    return function (x) {
      if (op === '>') return x > v; if (op === '<') return x < v;
      if (op === '>=') return x >= v; if (op === '<=') return x <= v;
      return Math.abs(x - v) < 1e-9;
    };
  }
  function enumOptions(c, rows) {
    if (c.options) return c.options;
    var seen = {}, out = [];
    rows.forEach(function (r) { var v = r[c.key]; if (v != null && v !== '' && !seen[v]) { seen[v] = 1; out.push([String(v), String(v)]); } });
    return out.sort(function (a, b) { return a[1].localeCompare(b[1]); });
  }
  function filterCell(cls, c, rows, filters) {
    if (!c.key) return '<td style="padding:5px 8px 9px;border-bottom:1px solid #e7e8e3;"></td>';
    var val = filters[c.key] || '';
    var inner;
    if (c.type === 'enum') {
      inner = '<select class="' + cls + '" data-k="' + c.key + '" style="' + FCELL + '"><option value="">All</option>' +
        enumOptions(c, rows).map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    } else {
      inner = '<input class="' + cls + '" data-k="' + c.key + '" value="' + esc(val) + '" placeholder="' + (c.type === 'num' ? '>0' : 'contains') + '" title="' + (c.type === 'num' ? 'Number, or an expression: >100, <=0, >=1.5' : 'Matches any part of the text') + '" style="' + FCELL + (c.align === 'right' ? 'text-align:right;' : '') + '">';
    }
    return '<td style="padding:5px 8px 9px;border-bottom:1px solid #e7e8e3;">' + inner + '</td>';
  }
  function passFilters(row, cols, filters) {
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i]; if (!c.key) continue;
      var f = String(filters[c.key] == null ? '' : filters[c.key]).trim();
      if (!f) continue;
      var v = row[c.key];
      if (c.type === 'num') {
        var fn = numFilter(f); if (!fn) continue;
        if (!fn((Number(v) || 0) / (c.scale || 1))) return false;
      } else if (c.type === 'enum') {
        if (String(v == null ? '' : v) !== f) return false;
      } else if (String(v == null ? '' : v).toLowerCase().indexOf(f.toLowerCase()) === -1) return false;
    }
    return true;
  }
  function sortByCol(rows, key, dir) {
    var d = dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === 'number' || typeof y === 'number') { x = Number(x) || 0; y = Number(y) || 0; }
      else { x = String(x == null ? '' : x).toLowerCase(); y = String(y == null ? '' : y).toLowerCase(); }
      return x < y ? -d : x > y ? d : 0;
    });
  }
  function colHead(cols, state, extraStyle) {
    return cols.map(function (c) {
      var on = c.key && state.sort && state.sort.key === c.key;
      var arrow = !c.key ? '' : on ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span style="opacity:.3;">↕</span>';
      return '<th' + (c.key ? ' data-sk="' + c.key + '" style="cursor:pointer;' : ' style="') +
        'text-align:' + (c.align || 'left') + ';padding:10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:' + (on ? '#3d4a55' : '#8a8f85') + ';font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;' + (extraStyle || '') + '">' + esc(c.label) + arrow + '</th>';
    }).join('');
  }
  /** Wire the header sort + filter row of a filterable table. */
  function wireColTable(box, cols, state, redraw) {
    box.querySelectorAll('th[data-sk]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sk');
        if (state.sort && state.sort.key === k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else state.sort = { key: k, dir: 'asc' };
        redraw();
      });
    });
    box.querySelectorAll('.colFilter').forEach(function (el) {
      var apply = function () { state.filters[el.getAttribute('data-k')] = el.value; state.page = 1; redraw(el.getAttribute('data-k')); };
      if (el.tagName === 'SELECT') el.addEventListener('change', apply);
      else {
        var t;
        el.addEventListener('input', function () { clearTimeout(t); t = setTimeout(apply, 250); });
      }
    });
  }

  var IT_COLS = [
    { key: 'part', label: 'Part #', w: 128, type: 'text' },
    { key: 'name', label: 'Product name', w: 0, type: 'text' },
    { key: 'category', label: 'Category', w: 210, type: 'enum' },
    { key: 'manufacturer', label: 'Manufacturer', w: 200, type: 'enum' },
    { key: 'unitCostMinor', label: 'Unit cost', w: 108, type: 'num', scale: 100, align: 'right' },
    { key: 'unitPriceMinor', label: 'Unit price', w: 108, type: 'num', scale: 100, align: 'right' },
    { key: 'margin', label: 'Margin', w: 78, type: 'num', align: 'right' },
    { key: 'weightLbs', label: 'Weight (lb)', w: 96, type: 'num', align: 'right' },
    { key: 'record', label: 'Record', w: 132, type: 'enum', options: [['Product + priced', 'Product + priced'], ['Product only', 'Product only'], ['Priced only', 'Priced only']] },
    { key: 'statusLabel', label: 'Status', w: 118, type: 'enum' },
    { key: 'defaultQty', label: 'Default qty', w: 104, type: 'num', align: 'center' },
    { key: 'freightDisplay', label: 'Auto freight', w: 116, type: 'num', align: 'right' },
    { key: 'ovrLabel', label: 'Override OK', w: 104, type: 'enum', options: [['Yes', 'Yes'], ['No', 'No']], align: 'center' },
    { key: 'productUrl', label: 'Buy link', w: 150, type: 'text' },
    { key: 'packagingBag', label: 'Bag #', w: 96, type: 'text' },
    { key: 'colorLabel', label: 'Needs colour', w: 110, type: 'enum', options: [['Yes', 'Yes'], ['No', 'No']], align: 'center' },
    { key: '', label: '', w: 96 },
  ];

  async function loadItems(user) {
    var box = document.getElementById('itList'); if (!box) return;
    try {
      if (!itemState.manufacturers.length) {
        try { var rm = await authed('/catalog/manufacturers'); if (rm.ok) itemState.manufacturers = ((await rm.json()) || []).map(function (m) { return m.name; }); } catch (e0) {}
      }
      // The whole catalog is loaded once so the column filters and sorting apply
      // across every part, not just the page you happen to be looking at.
      var qs = itemState.q ? '&q=' + encodeURIComponent(itemState.q) : '';
      var r = await authed('/catalog/items?page=1&pageSize=500' + qs);
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      itemState.categories = (d.categories || []).map(function (c) { return c.name; });
      var all = (d.items || []).slice(), total = d.total || all.length, page = 1;
      while (all.length < total && page < 8) {
        page++;
        var rn = await authed('/catalog/items?page=' + page + '&pageSize=500' + qs);
        if (!rn.ok) break;
        all = all.concat(((await rn.json()) || {}).items || []);
      }
      itemState.rows = all.map(function (k) {
        var margin = k.unitPriceMinor ? Math.round(((k.unitPriceMinor - k.unitCostMinor) / k.unitPriceMinor) * 1000) / 10 : 0;
        var rec = k.productId ? (k.skuId ? 'Product + priced' : 'Product only') : 'Priced only';
        var row = {}; for (var kk in k) row[kk] = k[kk];
        row.margin = margin; row.record = rec;
        // One readable status across both records: the product workflow when there
        // is a Product, otherwise the flat SKU's active flag.
        row.statusLabel = k.productStatus ? titleCase(k.productStatus) : (k.active === false ? 'Inactive' : 'Active');
        row.ovrLabel = k.overrideAllowed ? 'Yes' : 'No';
        row.defaultQty = k.defaultQty == null ? '' : Number(k.defaultQty);
        row.freightMinor = k.freightMinor == null ? '' : Number(k.freightMinor);
        row.freightLabel = k.freightLabel || '';
        row.freightDisplay = k.freightMinor == null ? '' : Number(k.freightMinor) / 100;
        row.productUrl = k.productUrl || '';
        row.packagingBag = k.packagingBag || '';
        row.colorLabel = k.requiresPowderColor ? 'Yes' : 'No';
        row.isActive = k.productStatus ? k.productStatus === 'ACTIVE' : k.active !== false;
        return row;
      });
      itemState.page = 1;
      drawItems(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawItems(user, focusKey) {
    var box = document.getElementById('itList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var all = itemState.rows || [];
    var rowsData = all.filter(function (r) { return passFilters(r, IT_COLS, itemState.filters); });
    if (itemState.sort) rowsData = sortByCol(rowsData, itemState.sort.key, itemState.sort.dir);
    var size = 100;
    var totalPages = Math.max(1, Math.ceil(rowsData.length / size));
    if (itemState.page > totalPages) itemState.page = totalPages;
    var pageRows = rowsData.slice((itemState.page - 1) * size, itemState.page * size);
    var activeFilters = IT_COLS.filter(function (c) { return c.key && String(itemState.filters[c.key] || '').trim(); }).length;

    var CELL = 'width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:13px;background:#fff;';
    var NUM = CELL + 'text-align:right;';
    function txt(part, field, value, style) {
      var v = value == null ? '' : String(value);
      return '<input class="itEdit" data-part="' + esc(part) + '" data-f="' + field + '" value="' + esc(v) + '" title="' + esc(v) + '" style="' + (style || CELL) + '">';
    }
    function sel(part, field, value, options) {
      return '<select class="itEdit" data-part="' + esc(part) + '" data-f="' + field + '" style="' + CELL + '">' +
        ['<option value="">—</option>'].concat(options.map(function (o) {
          return '<option value="' + esc(o) + '"' + (String(value) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
        })).join('') + '</select>';
    }
    var rows = pageRows.map(function (k) {
      var where = (k.productId ? '<span class="chip" style="font-size:10px;">Product</span>' : '') + (k.skuId ? ' <span class="chip" style="font-size:10px;background:#fdfcf7;">Priced</span>' : '');
      function cell(v, extra) { return '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;vertical-align:middle;' + (extra || '') + '">' + v + '</td>'; }
      return '<tr>' +
        cell('<code style="font-size:12.5px;color:#4a4f47;white-space:nowrap;">' + esc(k.part) + '</code>') +
        cell(admin ? txt(k.part, 'name', k.name) : '<span style="font-size:13px;" title="' + esc(k.name) + '">' + esc(k.name) + '</span>') +
        cell(admin ? (k.categoryOptions && itemState.categories.length ? sel(k.part, 'category', k.category, itemState.categories) : txt(k.part, 'category', k.category)) : '<span title="' + esc(k.category) + '">' + esc(k.category) + '</span>') +
        cell(admin ? txt(k.part, 'manufacturer', k.manufacturer) : '<span title="' + esc(k.manufacturer) + '">' + esc(k.manufacturer) + '</span>') +
        cell(admin ? txt(k.part, 'unitCostMinor', (Number(k.unitCostMinor) / 100).toFixed(2), NUM + 'background:#fdfcf7;border-color:#e4dfd0;') : '$' + (Number(k.unitCostMinor) / 100).toFixed(2), 'text-align:right;') +
        cell(admin ? txt(k.part, 'unitPriceMinor', (Number(k.unitPriceMinor) / 100).toFixed(2), NUM) : '$' + (Number(k.unitPriceMinor) / 100).toFixed(2), 'text-align:right;') +
        cell('<span style="font-size:13px;font-weight:600;color:' + (k.margin >= 0 ? '#2f7d5d' : '#9c3327') + ';">' + k.margin + '%</span>', 'text-align:right;') +
        cell(admin ? txt(k.part, 'weightLbs', k.weightLbs, NUM) : String(k.weightLbs), 'text-align:right;') +
        cell(where, 'white-space:nowrap;') +
        cell('<span style="display:inline-block;background:' + (k.isActive ? '#eaf3ee' : '#f2f3ef') + ';border:1px solid ' + (k.isActive ? '#cfe3d7' : '#dcded7') + ';color:' + (k.isActive ? '#2f7d5d' : '#8a8f85') + ';border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:600;white-space:nowrap;">' + esc(k.statusLabel) + '</span>', 'white-space:nowrap;') +
        // The quantity the proposal builder starts this part at. Blank = no default,
        // so the field opens at 0 and nothing reaches a proposal unasked.
        cell(admin
          ? '<input type="number" min="0" class="itDefQty" data-part="' + esc(k.part) + '" value="' + (k.defaultQty === '' || k.defaultQty == null ? '' : k.defaultQty) + '" placeholder="—" title="Quantity the Adventure Series builder starts this part at. Blank for none." style="' + NUM + 'text-align:center;">'
          : (k.defaultQty === '' || k.defaultQty == null ? '<span style="color:#b6bab1;">—</span>' : '<span style="font-size:13px;font-weight:600;">' + k.defaultQty + '</span>'), 'text-align:center;') +
        // A fixed freight charge added to this part's proposal line automatically.
        // Blank = none. Prints as the line's 3rd-party freight row.
        cell(admin
          ? '<input class="itFreight" data-part="' + esc(k.part) + '" value="' + (k.freightMinor === '' || k.freightMinor == null ? '' : (Number(k.freightMinor) / 100).toFixed(2)) + '" placeholder="—" title="Freight added automatically when this part is put on a proposal. Blank for none." style="' + NUM + 'text-align:right;">'
          : (k.freightMinor === '' || k.freightMinor == null ? '<span style="color:#b6bab1;">—</span>' : '<span style="font-size:13px;font-weight:600;">' + fmtMoney(Number(k.freightMinor), 'USD') + '</span>'), 'text-align:right;') +
        // Pre-approval to substitute this part number in the Adventure Series
        // builder. Off unless an admin says otherwise.
        cell(admin
          ? '<input type="checkbox" class="itFlag" data-part="' + esc(k.part) + '"' + (k.overrideAllowed ? ' checked' : '') + ' title="Allow reps to substitute this part number in the Adventure Series builder" style="width:16px;height:16px;cursor:pointer;">'
          : (k.overrideAllowed ? '<span style="font-size:12px;color:#2f7d5d;font-weight:600;">Yes</span>' : '<span style="color:#b6bab1;">—</span>'), 'text-align:center;') +
        // Where this part is bought. Becomes a "Buy" link on the Bill of Materials
        // so a purchaser goes straight to the vendor's order page.
        cell(admin
          ? '<input class="itUrl" data-part="' + esc(k.part) + '" value="' + esc(k.productUrl || '') + '" placeholder="—" title="Vendor order page. Shown as a Buy link on the Bill of Materials." style="width:100%;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12px;">'
          : (k.productUrl ? '<a href="' + esc(k.productUrl) + '" target="_blank" rel="noopener" style="font-size:12px;">Buy ↗</a>' : '<span style="color:#b6bab1;">—</span>')) +
        // Which packaging bag the part ships in. Only about thirty hardware items
        // carry one; blank everywhere else and never printed unless asked for.
        cell(admin
          ? '<input class="itBag" data-part="' + esc(k.part) + '" value="' + esc(k.packagingBag || '') + '" placeholder="—" title="Packaging bag this part ships in, e.g. Bag 7. Shown on the Bill of Materials when the bag column is turned on." style="width:100%;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12px;">'
          : (k.packagingBag ? '<span style="font-size:12.5px;font-weight:600;">' + esc(k.packagingBag) + '</span>' : '<span style="color:#b6bab1;">—</span>')) +
        // Whether this part must carry a powder colour before its BOM section can be
        // submitted. Off by default — most parts are not powder coated at all.
        cell(admin
          ? '<input type="checkbox" class="itColor" data-part="' + esc(k.part) + '"' + (k.requiresPowderColor ? ' checked' : '') + ' title="Block BOM submission until this part has a powder colour" style="width:16px;height:16px;cursor:pointer;">'
          : (k.requiresPowderColor ? '<span style="font-size:12px;color:#2f7d5d;font-weight:600;">Yes</span>' : '<span style="color:#b6bab1;">—</span>'), 'text-align:center;') +
        cell(admin ? '<div style="display:flex;gap:5px;justify-content:flex-end;">' +
          '<button class="itToggle" data-part="' + esc(k.part) + '" data-to="' + (k.isActive ? 'false' : 'true') + '" title="' + (k.isActive ? 'Stop offering this part on new proposals' : 'Offer this part again') + '" style="border:1px solid #dcded7;background:#fff;border-radius:7px;padding:5px 9px;font-size:11.5px;color:#3d4a55;cursor:pointer;white-space:nowrap;">' + (k.isActive ? 'Deactivate' : 'Activate') + '</button>' +
          '<button class="itDel" data-part="' + esc(k.part) + '" title="Delete this part" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;padding:5px 8px;font-size:11.5px;color:#9c3327;cursor:pointer;">✕</button></div>' : '', 'text-align:right;') + '</tr>';
    }).join('');

    box.innerHTML =
      '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
        '<table style="width:100%;min-width:1500px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
        '<colgroup>' + IT_COLS.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
        '<thead><tr>' + colHead(IT_COLS, itemState) + '</tr>' +
        '<tr>' + IT_COLS.map(function (c) { return filterCell('colFilter', c, all, itemState.filters); }).join('') + '</tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="13" style="padding:28px;text-align:center;color:#8a8f85;">' + (all.length ? 'No parts match these filters.' : 'Nothing in the catalog yet. Import a sheet or add a product.') + '</td></tr>') + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;flex-wrap:wrap;gap:8px;">' +
        '<span>' + rowsData.length.toLocaleString() + (activeFilters ? ' of ' + all.length.toLocaleString() : '') + ' items' +
          (activeFilters ? ' · <button id="itClearF" class="link-btn" style="width:auto;padding:4px 10px;display:inline-block;">Clear filters</button>' : '') + '</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="itPrev" ' + (itemState.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + itemState.page + ' of ' + totalPages + '</span><button id="itNext" ' + (itemState.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';

    var pv = document.getElementById('itPrev'), nx = document.getElementById('itNext');
    if (pv) pv.addEventListener('click', function () { if (itemState.page > 1) { itemState.page--; drawItems(user); } });
    if (nx) nx.addEventListener('click', function () { if (itemState.page < totalPages) { itemState.page++; drawItems(user); } });
    var cf = document.getElementById('itClearF');
    if (cf) cf.addEventListener('click', function () { itemState.filters = {}; itemState.page = 1; drawItems(user); });
    wireColTable(box, IT_COLS, itemState, function (key) { drawItems(user, key); });
    if (focusKey) {
      var back = box.querySelector('.colFilter[data-k="' + focusKey + '"]');
      if (back && back.tagName === 'INPUT') { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
    box.querySelectorAll('.itEdit').forEach(function (el) {
      el.addEventListener('change', async function () {
        var f = el.getAttribute('data-f'), part = el.getAttribute('data-part'), body = {};
        if (f === 'unitPriceMinor' || f === 'unitCostMinor') body[f] = d2m(el.value);
        else if (f === 'weightLbs') body[f] = parseFloat(el.value) || 0;
        else body[f] = el.value.trim();
        el.style.borderColor = '#c9a227';
        var r2 = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: body });
        el.style.borderColor = r2.ok ? '#3f9d78' : '#c2452f';
        if (!r2.ok) { var msg = ''; try { msg = (await r2.json()).message || ''; } catch (e3) {} alert('Could not save' + (msg ? ': ' + msg : ' (' + r2.status + ').')); return; }
        // Keep the in-memory row in step so filters and margin stay correct.
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) {
          row[f] = body[f];
          row.margin = row.unitPriceMinor ? Math.round(((row.unitPriceMinor - row.unitCostMinor) / row.unitPriceMinor) * 1000) / 10 : 0;
        }
        if (f === 'unitCostMinor' || f === 'unitPriceMinor') drawItems(user);
        setTimeout(function () { el.style.borderColor = f === 'unitCostMinor' ? '#e4dfd0' : '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itFreight').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), raw = el.value.trim();
        var to = raw === '' ? null : d2m(raw);
        el.style.borderColor = '#c9a227';
        var rf = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { freightMinor: to } });
        el.style.borderColor = rf.ok ? '#3f9d78' : '#c2452f';
        if (!rf.ok) {
          var mf = ''; try { mf = ((await rf.json()) || {}).message || ''; } catch (ef) {}
          alert(mf || 'Could not save that freight amount (' + rf.status + '). If this says the column is missing, migration 0027 has not been deployed.');
          return;
        }
        el.value = to == null ? '' : (to / 100).toFixed(2);
        var rowf = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowf) { rowf.freightMinor = to == null ? '' : to; rowf.freightDisplay = to == null ? '' : to / 100; }
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itDefQty').forEach(function (el) {      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), raw = el.value.trim();
        var to = raw === '' ? null : Math.max(0, Math.round(parseFloat(raw) || 0));
        el.style.borderColor = '#c9a227';
        var rq = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { defaultQty: to } });
        el.style.borderColor = rq.ok ? '#3f9d78' : '#c2452f';
        if (!rq.ok) {
          var mq = ''; try { mq = ((await rq.json()) || {}).message || ''; } catch (eq) {}
          alert(mq || 'Could not save that default (' + rq.status + '). If this says the column is missing, migration 0025 has not been deployed.');
          return;
        }
        el.value = to == null ? '' : String(to);
        var rowq = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowq) { rowq.defaultQty = to == null ? '' : to; }
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itBag').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), v = el.value.trim();
        el.style.borderColor = '#c9a227';
        var rb = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { packagingBag: v || null } });
        el.style.borderColor = rb.ok ? '#3f9d78' : '#c2452f';
        if (!rb.ok) {
          var mb = ''; try { mb = ((await rb.json()) || {}).message || ''; } catch (eb) {}
          alert(mb || 'Could not save that bag number (' + rb.status + '). If this says the column is missing, migration 0033 has not been deployed.');
          return;
        }
        var rowb = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (rowb) rowb.packagingBag = v;
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itUrl').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), v = el.value.trim();
        // Validated before it is saved: a mistyped link becomes an unclickable
        // "Buy" button on a purchasing document, which is worse than no link.
        if (v && !/^https?:\/\//i.test(v)) { alert('A buy link must start with http:// or https://'); el.focus(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { productUrl: v || null } });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save the link (' + r.status + ').'); return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) row.productUrl = v;
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    box.querySelectorAll('.itColor').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), to = el.checked;
        el.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { requiresPowderColor: to } });
        el.disabled = false;
        if (!r.ok) { el.checked = !to; var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save (' + r.status + ').'); return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) { row.requiresPowderColor = to; row.colorLabel = to ? 'Yes' : 'No'; }
      });
    });
    box.querySelectorAll('.itFlag').forEach(function (el) {
      el.addEventListener('change', async function () {
        var part = el.getAttribute('data-part'), to = el.checked;
        el.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: { overrideAllowed: to } });
        el.disabled = false;
        if (!r.ok) {
          el.checked = !to;
          var m0 = ''; try { m0 = ((await r.json()) || {}).message || ''; } catch (e2) {}
          alert(m0 || 'Could not save that change (' + r.status + '). If this says the column is missing, migration 0024 has not been deployed.');
          return;
        }
        var row0 = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row0) { row0.overrideAllowed = to; row0.ovrLabel = to ? 'Yes' : 'No'; }
      });
    });
    box.querySelectorAll('.itToggle').forEach(function (b) {
      b.addEventListener('click', async function () {
        var part = b.getAttribute('data-part'), to = b.getAttribute('data-to') === 'true';
        b.disabled = true;
        var r = await authed('/catalog/items/' + encodeURIComponent(part) + '/active', { method: 'POST', body: { active: to } });
        if (!r.ok) { var m1 = ''; try { m1 = ((await r.json()) || {}).message || ''; } catch (e1) {} alert(m1 || 'Could not change status (' + r.status + ').'); b.disabled = false; return; }
        var row = (itemState.rows || []).filter(function (x) { return x.part === part; })[0];
        if (row) {
          row.isActive = to;
          if (row.productStatus) { row.productStatus = to ? 'ACTIVE' : 'INACTIVE'; row.statusLabel = to ? 'Active' : 'Inactive'; }
          else { row.active = to; row.statusLabel = to ? 'Active' : 'Inactive'; }
        }
        drawItems(user);
      });
    });
    box.querySelectorAll('.itDel').forEach(function (b) {
      b.addEventListener('click', function () { openItemDeleteForm(b.getAttribute('data-part'), user); });
    });
  }

  /**
   * Deleting a catalog part is only safe when no proposal references it — otherwise
   * a historical document would silently change. The dialog says which it is and
   * offers deactivation as the alternative.
   */
  async function openItemDeleteForm(part, user) {
    var u = null;
    try { var r = await authed('/catalog/items/' + encodeURIComponent(part) + '/usage'); if (r.ok) u = await r.json(); } catch (e) {}
    if (!u) { alert('Could not check where this part is used.'); return; }
    var safe = u.deletable;
    openModal('Remove ' + part,
      (safe
        ? '<div style="font-size:13.5px;line-height:1.6;">Nothing references this part, so it can be deleted outright. This removes the catalog record, its price/cost and its sourcing — permanently.</div>'
        : '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;line-height:1.55;">' + esc(u.reason || 'This part cannot be deleted.') + '</div>') +
      '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.55;">' +
        (u.active === false ? 'This part is already inactive.' : 'Deactivating keeps every existing proposal exactly as priced and simply stops the part being offered on new ones.') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;">' +
        (u.active !== false ? '<button type="button" class="link-btn" id="idDeact" style="width:auto;padding:9px 15px;">Deactivate instead</button>' : '') +
      '</div>',
      safe
        ? async function (close, showErr) {
          var rr = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'DELETE' });
          if (!rr.ok && rr.status !== 204) { var m = ''; try { m = ((await rr.json()) || {}).message || ''; } catch (e2) {} return showErr(m || 'Could not delete (' + rr.status + ').'); }
          close(); loadItems(user);
        }
        : async function (close) { close(); },
      safe ? 'Delete permanently' : 'Close');
    var da = document.getElementById('idDeact');
    if (da) da.addEventListener('click', async function () {
      var rr = await authed('/catalog/items/' + encodeURIComponent(part) + '/active', { method: 'POST', body: { active: false } });
      if (!rr.ok) { alert('Could not deactivate (' + rr.status + ').'); return; }
      var form = document.getElementById('mForm');
      if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
      loadItems(user);
    });
  }
  async function renderCatalogProducts(user) {
    var admin = canCatalogAdmin(user.role);
    try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : []; } catch (e) { catCategories = []; }
    var statusOpts = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (cat.status === s ? ' selected' : '') + '>' + titleCase(s) + '</option>'; }).join('');
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
        '<input id="catSearch" placeholder="Search SKU or name…" value="' + esc(cat.q) + '" style="flex:1;min-width:220px;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<select id="catStatus" style="padding:10px 12px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;">' + statusOpts + '</select>' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;"><button class="link-btn" id="catCats" style="width:auto;padding:10px 14px;">Categories &amp; tiers</button><button class="link-btn" id="catOrder" style="width:auto;padding:10px 14px;">Sort order by tier</button><button class="link-btn" id="catSortAudit" style="width:auto;padding:10px 14px;">Sort order</button><button class="link-btn" id="catExport" style="width:auto;padding:10px 14px;">Export tree</button><button class="link-btn" id="catListCsv" style="width:auto;padding:10px 14px;">Export product list</button><button class="link-btn" id="catImport" style="width:auto;padding:10px 14px;">Import tree</button><button class="btn" id="catNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div id="catList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var search = document.getElementById('catSearch'), t;
    search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { cat.q = search.value.trim(); cat.page = 1; loadProducts(user); }, 300); });
    document.getElementById('catStatus').addEventListener('change', function (e) {
      // The toolbar dropdown is the Status column filter — no refetch needed.
      cat.status = e.target.value; cat.filters.status = cat.status; cat.page = 1;
      if ((cat.rows || []).length) drawProductTree(user); else loadProducts(user);
    });
    if (admin) {
      document.getElementById('catNew').addEventListener('click', function () { openProductForm(user); });
      document.getElementById('catCats').addEventListener('click', function () { openCategoryManager(user); });
      document.getElementById('catOrder').addEventListener('click', function () { openProductReorder(user); });
      document.getElementById('catExport').addEventListener('click', exportProductTree);
      document.getElementById('catListCsv').addEventListener('click', exportCategoryProductList);
      document.getElementById('catSortAudit').addEventListener('click', function () { openSortAudit(user); });
      document.getElementById('catImport').addEventListener('click', function () { openTreeImport(user); });
    }
    loadProducts(user);
  }

  /* --- SKU / Pricing manager (in-app editor + Excel/CSV import) --- */
  var skuState = { q: '', page: 1 };
  function renderSkus(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="skuSearch" placeholder="Search part # or description…" value="' + esc(skuState.q) + '" style="flex:1;min-width:220px;max-width:360px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="skuExport" style="width:auto;padding:10px 15px;">Export Excel / CSV</button><button class="link-btn" id="skuImport" style="width:auto;padding:10px 15px;">Import Excel / CSV</button><button class="btn" id="skuNew" style="width:auto;padding:10px 17px;">New SKU</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">These prices &amp; weights feed the Adventure Series engine and the proposal builder. Edit a price or weight inline and it saves automatically. <b>Override OK</b> lets a rep substitute that part number in the Adventure Series builder — leave it off and the part is fixed.</div>' +
      '<div id="skuList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('skuSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { skuState.q = s.value.trim(); skuState.page = 1; loadSkus(user); }, 300); });
    if (admin) {
      document.getElementById('skuNew').addEventListener('click', function () { openSkuForm(user); });
      document.getElementById('skuExport').addEventListener('click', exportSkuMaster);
      document.getElementById('skuImport').addEventListener('click', function () { openSkuImport(user); });
    }
    loadSkus(user);
  }
  /** Reload whichever catalog list is showing. */
  function refreshCatalogList(user) { if (cat.tab === 'products') loadProducts(user); else { itemState.page = 1; loadItems(user); } }

  async function loadSkus(user) {
    var box = document.getElementById('skuList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    try {
      var r = await authed('/skus?page=' + skuState.page + '&pageSize=50' + (skuState.q ? '&q=' + encodeURIComponent(skuState.q) : ''));
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      var rows = (d.items || []).map(function (k) {
        var priceCell = admin
          ? '<input class="skuEdit" data-id="' + k.id + '" data-f="unitPriceMinor" value="' + (Number(k.unitPriceMinor) / 100).toFixed(2) + '" style="width:90px;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;text-align:right;font-size:13px;">'
          : '$' + (Number(k.unitPriceMinor) / 100).toFixed(2);
        var costCell = admin
          ? '<input class="skuEdit" data-id="' + k.id + '" data-f="unitCostMinor" value="' + (Number(k.unitCostMinor || 0) / 100).toFixed(2) + '" style="width:90px;padding:5px 7px;border:1px solid #e4dfd0;background:#fdfcf7;border-radius:6px;text-align:right;font-size:13px;">'
          : '$' + (Number(k.unitCostMinor || 0) / 100).toFixed(2);
        var marginPct = Number(k.unitPriceMinor) ? Math.round(((Number(k.unitPriceMinor) - Number(k.unitCostMinor || 0)) / Number(k.unitPriceMinor)) * 1000) / 10 : 0;
        var wtCell = admin
          ? '<input class="skuEdit" data-id="' + k.id + '" data-f="weightLbs" value="' + k.weightLbs + '" style="width:70px;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;text-align:right;font-size:13px;">'
          : k.weightLbs;
        // Pre-approval to substitute this part in the Adventure Series builder.
        // Off by default: a rep can only swap what the catalog says is swappable.
        var ovrCell = admin
          ? '<input type="checkbox" class="skuFlag" data-id="' + k.id + '" data-f="overrideAllowed"' + (k.overrideAllowed ? ' checked' : '') + ' title="Allow reps to substitute this part number" style="width:15px;height:15px;cursor:pointer;">'
          : (k.overrideAllowed ? '<span style="font-size:12px;color:#3f9d78;">Yes</span>' : '<span style="color:#b6bab1;">—</span>');
        return '<tr>' + td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(k.part) + '</code>') + td('<span style="font-size:13px;">' + esc(k.description) + '</span>') +
          td(esc(k.category)) + td(priceCell) + td(costCell) + td('<span style="font-size:13px;color:' + (marginPct >= 0 ? '#2f7d5d' : '#9c3327') + ';font-weight:600;">' + marginPct + '%</span>') + td(wtCell) + td(ovrCell) +
          td(admin ? '<button class="skuDel" data-id="' + k.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 9px;font-size:12px;">Delete</button>' : '') + '</tr>';
      }).join('');
      var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 50)));
      box.innerHTML = tableShell(['Part #', 'Description', 'Category', 'Unit price', 'Unit cost', 'Margin', 'Weight (lb)', 'Override OK', ''], rows, 9, 'No SKUs yet. Import a sheet or add one.') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;"><span>' + (d.total || 0) + ' SKUs</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="skuPrev" ' + (skuState.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + (d.page || 1) + ' of ' + totalPages + '</span><button id="skuNext" ' + (skuState.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';
      var pv = document.getElementById('skuPrev'), nx = document.getElementById('skuNext');
      if (pv) pv.addEventListener('click', function () { if (skuState.page > 1) { skuState.page--; loadSkus(user); } });
      if (nx) nx.addEventListener('click', function () { if (skuState.page < totalPages) { skuState.page++; loadSkus(user); } });
      document.querySelectorAll('.skuEdit').forEach(function (el) {
        el.addEventListener('change', async function () {
          var f = el.getAttribute('data-f'); var body = {};
          body[f] = (f === 'unitPriceMinor' || f === 'unitCostMinor') ? d2m(el.value) : (parseFloat(el.value) || 0);
          el.style.borderColor = '#c9a227';
          var r2 = await authed('/skus/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
          el.style.borderColor = r2.ok ? '#3f9d78' : '#c2452f';
          setTimeout(function () { el.style.borderColor = '#dcded7'; }, 800);
        });
      });
      document.querySelectorAll('.skuFlag').forEach(function (el) {
        el.addEventListener('change', async function () {
          var body = {}; body[el.getAttribute('data-f')] = el.checked;
          var r2 = await authed('/skus/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
          if (!r2.ok) { el.checked = !el.checked; alert('Could not save that change.'); }
        });
      });
      document.querySelectorAll('.skuDel').forEach(function (b) { b.addEventListener('click', async function () { if (!confirm('Delete this SKU?')) return; await authed('/skus/' + b.getAttribute('data-id'), { method: 'DELETE' }); loadSkus(user); }); });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  function openSkuForm(user) {
    openModal('New catalog item',
      fieldRow('Part #', '<input id="kPart" style="' + IN + '" required>') +
      fieldRow('Description', '<input id="kDesc" style="' + IN + '" required>') +
      '<div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Unit price ($)</label><input id="kPrice" value="0.00" style="' + IN + '"></div><div class="field" style="flex:1;"><label>Unit cost ($)</label><input id="kCost" value="0.00" style="' + IN + '"></div><div class="field" style="flex:1;"><label>Weight (lb)</label><input id="kWt" value="0" style="' + IN + '"></div></div>' +
      fieldRow('Category', '<input id="kCat" value="OTHER" style="' + IN + '">') +
      fieldRow('Manufacturer', '<input id="kMfr" placeholder="e.g. Summit Sensory Gym" style="' + IN + '">') +
      fieldRow('Proposal group (optional)', '<input id="kGroup" style="' + IN + '">'),
      async function (close, showErr) {
        var part = document.getElementById('kPart').value.trim(); if (!part) return showErr('Part # is required.');
        var desc = document.getElementById('kDesc').value.trim(); if (!desc) return showErr('Description is required.');
        var body = { part: part, description: desc, unitPriceMinor: d2m(document.getElementById('kPrice').value), unitCostMinor: d2m(document.getElementById('kCost').value), weightLbs: parseFloat(document.getElementById('kWt').value) || 0, category: document.getElementById('kCat').value.trim() || 'OTHER', manufacturer: document.getElementById('kMfr').value.trim() || undefined, proposalGroup: document.getElementById('kGroup').value.trim() || undefined };
        var r = await authed('/skus', { method: 'POST', body: body });
        if (!r.ok) return showErr(r.status === 400 ? 'That part # may already exist.' : 'Could not create (' + r.status + ').');
        close(); refreshCatalogList(user);
      });
  }
  /**
   * Import prices and catalog columns from a sheet. Two passes: the first is a
   * preview (which columns the file carries, what will be created and changed, and
   * which catalog parts the file leaves out), the second commits. Only the columns
   * present in the file are written — leaving `unitCost` out of the sheet leaves
   * every cost alone.
   */
  /**
   * The SKU master as a CSV the importer on this same screen reads back without
   * edits — same column names, same order, prices as dollars. That round trip is
   * the point: export, reprice a column in Excel, import. `active` is included so
   * a retired part is visible in the sheet, but the importer ignores it (status is
   * changed in the app, or by the missing-parts review on import).
   *
   * Exports what the search box is currently filtering to, not always the whole
   * table — repricing one manufacturer's parts should not require a 3,000-row file.
   */
  async function exportSkuMaster() {
    var qs = skuState.q ? '?q=' + encodeURIComponent(skuState.q) : '';
    var r = await authed('/skus/export' + qs);
    if (!r.ok) { alert('Could not export the catalog (' + r.status + ').'); return; }
    var d = await r.json();
    var cols = d.columns || [];
    var rows = [cols].concat((d.items || []).map(function (it) {
      return cols.map(function (c) { return it[c]; });
    }));
    downloadCsv('catalog-skus-' + todayISO() + (skuState.q ? '-filtered' : '') + '.csv', rows);
  }

  var skuImportConfirmed = false;
  function openSkuImport(user) {
    skuImportConfirmed = false;
    openModal('Import products from Excel / CSV',
      '<div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.55;">Save your sheet as <b>CSV</b> with a header row. Recognised columns: <code>part, description, unitPrice, unitCost, weightLbs, category, manufacturer, proposalGroup</code>. <b>part</b> is the match key and is required; every other column is optional — only the columns you include are overwritten.</div>' +
      '<input type="file" id="skuFile" accept=".csv,text/csv" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">' +
      '<div id="siReview" style="margin-top:12px;"></div>',
      async function (close, showErr) {
        var fi = document.getElementById('skuFile').files[0]; if (!fi) return showErr('Choose a CSV file first.');
        var text = await fi.text();
        var rows = parseCsv(text);
        if (!rows.length) return showErr('No data rows found in that file.');
        if (!Object.prototype.hasOwnProperty.call(rows[0], 'part')) return showErr('The sheet needs a “part” column — it is how rows are matched.');
        var missingSel = document.getElementById('siMissing');
        var r = await authed('/skus/import', { method: 'POST', body: {
          rows: rows, dryRun: !skuImportConfirmed, missingAction: missingSel ? missingSel.value : 'leave'
        } });
        var d = null; try { d = await r.json(); } catch (e) {}
        if (!d) return showErr('Import failed (' + r.status + ').');
        if (d.issues && d.issues.length) {
          document.getElementById('siReview').innerHTML =
            '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;max-height:180px;overflow:auto;">' +
            '<b>' + d.issues.length + ' row(s) could not be read:</b><ul style="margin:6px 0 0;padding-left:18px;line-height:1.5;">' +
            d.issues.slice(0, 30).map(function (i) { return '<li>Row ' + i.row + ': ' + esc(i.message) + '</li>'; }).join('') + '</ul></div>';
          skuImportConfirmed = false;
          return showErr('Fix those rows and try again.');
        }
        if (!skuImportConfirmed) {
          var p = d.plan || {};
          document.getElementById('siReview').innerHTML =
            '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;">' +
              '<b>Ready to import ' + (d.willUpsert || 0) + ' row(s)</b><br>' +
              (p.create || 0) + ' new part(s), ' + (p.update || 0) + ' updated<br>' +
              'Columns this file will overwrite: <b>' + ((p.columns || []).join(', ') || 'none — part numbers only') + '</b>' +
            '</div>' +
            ((p.missing && p.missing.length)
              ? '<div style="margin-top:10px;background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7a6320;line-height:1.55;">' +
                  '<b>' + p.missing.length + ' active catalog part(s) are not in this file.</b>' +
                  '<div style="max-height:120px;overflow:auto;margin:6px 0;">' + p.missing.slice(0, 60).map(function (mm) { return esc(mm.part + ' — ' + mm.name); }).join('<br>') + '</div>' +
                  '<label style="display:block;margin-top:6px;">What should happen to them? ' +
                    '<select id="siMissing" style="padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
                      '<option value="leave">Leave them exactly as they are</option>' +
                      '<option value="deactivate">Deactivate them</option>' +
                    '</select></label></div>'
              : '') +
            '<div class="muted" style="font-size:12px;margin-top:8px;">Press Import again to commit.</div>';
          skuImportConfirmed = true;
          return showErr('Review the summary above, then press Import to commit.');
        }
        skuImportConfirmed = false;
        close();
        alert('Import complete: ' + (d.created || 0) + ' added, ' + (d.updated || 0) + ' updated' +
          (d.deactivated ? ', ' + d.deactivated + ' deactivated' : '') + '.');
        refreshCatalogList(user);
      }, 'Import');
  }
  function parseCsv(text) {
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return [];
    function splitLine(line) { var out = [], cur = '', q = false; for (var i = 0; i < line.length; i++) { var c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } } out.push(cur); return out; }
    var headers = splitLine(lines[0]).map(function (h) { return h.trim(); });
    return lines.slice(1).map(function (ln) { var cells = splitLine(ln); var o = {}; headers.forEach(function (h, i) { o[h] = (cells[i] || '').trim(); }); return o; });
  }

  var PT_COLS = [
    { key: 'sku', label: 'SKU', w: 160, type: 'text' },
    { key: 'name', label: 'Name', w: 0, type: 'text' },
    { key: 'kind', label: 'Kind', w: 140, type: 'enum' },
    { key: 'categoryName', label: 'Category', w: 210, type: 'enum' },
    { key: 'sortOrder', label: 'Order', w: 90, type: 'num' },
    { key: 'status', label: 'Status', w: 170, type: 'enum' },
    { key: '', label: 'QuickBooks', w: 150 },
    { key: '', label: '', w: 96 },
  ];

  /**
   * productId → QuickBooks item id, for the catalog's QuickBooks column. Null until
   * loaded; an empty object means loaded and nothing is linked. Loaded once per
   * visit to the Catalog, and refreshed in place after a sync rather than re-fetched.
   */
  var qboItemLinks = null;
  /** The income account the last sync used, so the dialog remembers the answer. */
  var qboIncomeAccount = null;
  try { qboIncomeAccount = JSON.parse(localStorage.getItem('ssg.qboIncomeAccount') || 'null'); } catch (e) {}

  async function loadQboItemLinks() {
    try {
      var r = await authed('/integrations/quickbooks/items/links');
      if (!r.ok) { qboItemLinks = {}; return; }
      var d = await r.json();
      var map = {};
      (d.links || []).forEach(function (l) { map[l.productId] = l; });
      qboItemLinks = map;
    } catch (e) { qboItemLinks = {}; }
  }

  async function loadProducts(user) {
    var box = document.getElementById('catList'); if (!box) return;
    try {
      // Load the whole tree (100 per request) so column filters and sorting cover
      // every product rather than the current page.
      var qs = (cat.q ? '&q=' + encodeURIComponent(cat.q) : '');
      var all = [], page = 0, total = 1;
      while (all.length < total && page < 20) {
        page++;
        var r = await authed('/catalog/products?page=' + page + '&pageSize=100' + qs);
        if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
        var d = await r.json();
        total = d.total || 0;
        var got = d.items || [];
        all = all.concat(got);
        if (!got.length) break;
      }
      cat.rows = all.map(function (p) {
        var row = {}; for (var k in p) row[k] = p[k];
        row.categoryName = catName(p.categoryId) || '';
        row.categoryPath = catPathLabel(p.categoryId);
        row.kindLabel = titleCase(p.kind);
        return row;
      });
      cat.page = 1;
      drawProductTree(user);
      // Not awaited above: the tree is useful before the link state arrives, and the
      // column redraws itself when it does.
      if (qboItemLinks === null) { await loadQboItemLinks(); drawProductTree(user); }
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawProductTree(user, focusKey) {
    var box = document.getElementById('catList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var all = cat.rows || [];
    var rowsData = all.filter(function (r) { return passFilters(r, PT_COLS, cat.filters); });
    if (cat.sort) rowsData = sortByCol(rowsData, cat.sort.key, cat.sort.dir);
    var size = 25;
    var totalPages = Math.max(1, Math.ceil(rowsData.length / size));
    if (cat.page > totalPages) cat.page = totalPages;
    var pageRows = rowsData.slice((cat.page - 1) * size, cat.page * size);
    var activeFilters = PT_COLS.filter(function (c) { return c.key && String(cat.filters[c.key] || '').trim(); }).length;

    var kindOpts = PT_COLS[2]; kindOpts.options = KINDS.map(function (k) { return [k, titleCase(k)]; });
    var statusCol = PT_COLS[4]; statusCol.options = STATUSES.map(function (st) { return [st, titleCase(st)]; });

    var rows = pageRows.map(function (p) {
      var statusCell = admin
        ? '<select data-pid="' + p.id + '" class="rowStatus" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;width:100%;">' + STATUSES.map(function (st) { return '<option value="' + st + '"' + (p.status === st ? ' selected' : '') + '>' + titleCase(st) + '</option>'; }).join('') + '</select>'
        : '<span class="chip">' + titleCase(p.status) + '</span>';
      return '<tr>' + td('<code style="font-size:13px;color:#4a4f47;">' + esc(p.sku) + '</code>') +
        td('<b style="font-weight:600;">' + esc(p.name) + '</b>' + (p.proposalDescription ? '<div class="muted" style="font-size:12px;max-width:420px;line-height:1.45;">' + esc(String(p.proposalDescription).slice(0, 120)) + (String(p.proposalDescription).length > 120 ? '…' : '') + '</div>' : '')) +
        td(esc(titleCase(p.kind))) + td('<span style="font-size:13px;">' + esc(p.categoryName || '—') + '</span>' + (p.categoryPath && p.categoryPath !== p.categoryName ? '<div class="muted" style="font-size:11.5px;line-height:1.4;">' + esc(p.categoryPath) + '</div>' : '')) +
        // The number that decides where this part lands on a proposal. Sort by this
        // column and filter Category to read a tier in its proposal order.
        td('<span style="font-variant-numeric:tabular-nums;font-size:13px;color:#5c6157;">' + (Number(p.sortOrder) || 0) + '</span>') + td(statusCell) +
        td(qboCell(p, admin)) +
        td(admin ? '<button class="prodEdit" data-pid="' + p.id + '" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;color:#3d4a55;cursor:pointer;">Edit</button>' : '') + '</tr>';
    }).join('');

    box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
      '<table style="width:100%;min-width:1280px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
      '<colgroup>' + PT_COLS.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
      '<thead><tr>' + colHead(PT_COLS, cat, 'background:#f7f8f4;') + '</tr>' +
      '<tr>' + PT_COLS.map(function (c) { return filterCell('colFilter', c, all, cat.filters); }).join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="8">' + (all.length ? 'No products match these filters.' : 'No products yet.') + '</td></tr>') + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;flex-wrap:wrap;gap:8px;">' +
        '<span>' + rowsData.length.toLocaleString() + (activeFilters ? ' of ' + all.length.toLocaleString() : '') + ' products' +
          (activeFilters ? ' · <button id="ptClearF" class="link-btn" style="width:auto;padding:4px 10px;display:inline-block;">Clear filters</button>' : '') + '</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="cPrev" ' + (cat.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + cat.page + ' of ' + totalPages + '</span><button id="cNext" ' + (cat.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';

    var pv = document.getElementById('cPrev'), nx = document.getElementById('cNext');
    if (pv) pv.addEventListener('click', function () { if (cat.page > 1) { cat.page--; drawProductTree(user); } });
    if (nx) nx.addEventListener('click', function () { if (cat.page < totalPages) { cat.page++; drawProductTree(user); } });
    var cf = document.getElementById('ptClearF');
    if (cf) cf.addEventListener('click', function () {
      cat.filters = {}; cat.status = ''; cat.page = 1;
      var sSel = document.getElementById('catStatus'); if (sSel) sSel.value = '';
      drawProductTree(user);
    });
    wireColTable(box, PT_COLS, cat, function (key) {
      // Keep the toolbar dropdown in step when Status is filtered from the header.
      if (key === 'status') { cat.status = cat.filters.status || ''; var sSel2 = document.getElementById('catStatus'); if (sSel2) sSel2.value = cat.status; }
      drawProductTree(user, key);
    });
    if (focusKey) {
      var back = box.querySelector('.colFilter[data-k="' + focusKey + '"]');
      if (back && back.tagName === 'INPUT') { back.focus(); back.setSelectionRange(back.value.length, back.value.length); }
    }
    Array.prototype.forEach.call(box.querySelectorAll('.rowStatus'), function (sel) {
      sel.addEventListener('change', async function () {
        var r2 = await authed('/catalog/products/' + sel.getAttribute('data-pid') + '/status', { method: 'PATCH', body: { status: sel.value, reason: 'changed from workspace' } });
        if (!r2.ok) { alert('Could not change status (' + r2.status + ').'); loadProducts(user); return; }
        var row = (cat.rows || []).filter(function (x) { return x.id === sel.getAttribute('data-pid'); })[0];
        if (row) row.status = sel.value;
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.qboSync'), function (b) {
      b.addEventListener('click', function () {
        var p = (cat.rows || []).filter(function (x) { return x.id === b.getAttribute('data-pid'); })[0];
        if (p) openQboSyncForm(p, user);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.prodEdit'), function (b) {
      b.addEventListener('click', function () {
        var p = (cat.rows || []).filter(function (x) { return x.id === b.getAttribute('data-pid'); })[0];
        if (p) openProductEditForm(p, user);
      });
    });
  }

  /**
   * The QuickBooks column for one product.
   *
   * Three states worth distinguishing: not yet known (the link fetch is still in
   * flight), linked, and not linked. A product that is not ACTIVE cannot be synced —
   * syncItem refuses it — so the cell says so rather than offering a button that
   * will fail.
   */
  function qboCell(p, admin) {
    var chip = function (bg, bd, fg, text, title) {
      return '<span' + (title ? ' title="' + esc(title) + '"' : '') + ' style="display:inline-block;background:' + bg + ';border:1px solid ' + bd + ';color:' + fg + ';border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;">' + esc(text) + '</span>';
    };
    if (qboItemLinks === null) return '<span class="muted" style="font-size:12px;">…</span>';
    var link = qboItemLinks[p.id];
    if (link && link.state === 'ERROR') return chip('#fbe9e6', '#f0cdc7', '#9c3327', 'Sync error', 'The last sync failed. Try again.');
    if (link) return chip('#eef5f0', '#cfe3d6', '#2f7d5d', 'Linked', 'QuickBooks item ' + link.qboId);
    if (p.status !== 'ACTIVE') return chip('#f2f3ef', '#e2e4dd', '#8a8f85', 'Not active', 'Only an active product can be synced to QuickBooks.');
    if (!admin) return chip('#fdf6e3', '#eadfbe', '#8a6d1f', 'Not linked');
    return '<button class="qboSync" data-pid="' + p.id + '" style="border:1px solid #3d4a55;background:#fff;border-radius:8px;padding:6px 11px;font-size:12.5px;color:#3d4a55;cursor:pointer;white-space:nowrap;">Sync to QBO</button>';
  }

  /**
   * Create (or adopt) the QuickBooks item for one product and record the link.
   *
   * QuickBooks needs an income account on a new item, so the first sync of a session
   * asks which one and remembers the answer. The account list comes from the
   * connected company — no typing account names, no guessing ids.
   */
  async function openQboSyncForm(p, user) {
    var accounts = null, err = '';
    try {
      var ra = await authed('/integrations/quickbooks/accounts');
      if (ra.status === 409) err = 'QuickBooks is not connected. Connect it under Administration → Integrations first.';
      else if (!ra.ok) err = 'Could not read the account list from QuickBooks (' + ra.status + ').';
      else accounts = ((await ra.json()) || {}).accounts || [];
    } catch (e) { err = 'Could not reach QuickBooks.'; }

    if (err) { openModal('Sync ' + p.sku, '<div class="err" style="font-size:13px;line-height:1.6;">' + esc(err) + '</div>', async function (close) { close(); }, 'Close'); return; }
    if (!accounts.length) { openModal('Sync ' + p.sku, '<div class="err" style="font-size:13px;line-height:1.6;">This QuickBooks company has no active income accounts, so an item cannot be created.</div>', async function (close) { close(); }, 'Close'); return; }

    var remembered = qboIncomeAccount && accounts.filter(function (x) { return x.id === qboIncomeAccount.id; })[0] ? qboIncomeAccount.id : accounts[0].id;
    openModal('Sync ' + p.sku + ' to QuickBooks',
      '<div style="font-size:13.5px;line-height:1.6;">Creates a QuickBooks item for <b>' + esc(p.name) + '</b> and links it to this catalog record, so proposal lines carrying this part can reach an estimate or invoice.</div>' +
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-top:8px;">If an item with SKU <code>' + esc(p.sku) + '</code> already exists in QuickBooks, it is adopted rather than duplicated. ' +
        (p.kind === 'SERVICE' ? 'It will be created as a Service item.' : 'It will be created as a Non-inventory item — Summit does not track QuickBooks stock quantities.') + '</div>' +
      '<div style="margin-top:14px;"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">Income account</label>' +
        '<select id="qboAcct" style="width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:14px;background:#fff;">' +
        accounts.map(function (ac) { return '<option value="' + esc(ac.id) + '"' + (ac.id === remembered ? ' selected' : '') + '>' + esc(ac.name) + (ac.subType ? ' — ' + esc(titleCase(String(ac.subType).replace(/([A-Z])/g, ' $1').trim())) : '') + '</option>'; }).join('') +
        '</select>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Where sales of this item post. Use the same account as the rest of your product lines unless you report on this one separately.</div></div>',
      async function (close, showErr) {
        var sel = document.getElementById('qboAcct');
        var acctId = sel ? sel.value : '';
        if (!acctId) return showErr('Choose an income account.');
        var r = await authed('/integrations/quickbooks/items/' + encodeURIComponent(p.id) + '/sync', { method: 'POST', body: { incomeAccountRef: acctId } });
        if (r.status === 409) return showErr('QuickBooks is not connected.');
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'The sync failed (' + r.status + ').'); }
        var out = (await r.json()) || {};
        var chosen = accounts.filter(function (x) { return x.id === acctId; })[0];
        qboIncomeAccount = { id: acctId, name: chosen ? chosen.name : '' };
        try { localStorage.setItem('ssg.qboIncomeAccount', JSON.stringify(qboIncomeAccount)); } catch (e) {}
        if (qboItemLinks) qboItemLinks[p.id] = { productId: p.id, qboId: out.qboId, state: 'OK' };
        close();
        drawProductTree(user);
      },
      'Sync to QuickBooks');
  }

  /** Edit a product-tree record in place: name, kind, category, descriptions, dimensions. */
  function openProductEditForm(p, user) {
    var catOpts = catOptionsTree(p.categoryId);
    var num = function (v) { return v == null || v === '' ? '' : String(v); };
    /** Where this product sits, and what else is filed in the same category. */
    function tierPanel(categoryId) {
      var c = catById(categoryId);
      var path = catPath(categoryId);
      var siblings = (cat.rows || []).filter(function (x) { return x.categoryId === categoryId && x.id !== p.id; })
        .sort(function (a, b) { return ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name); });
      var crumbs = path.length
        ? path.map(function (node, i) {
          return '<span style="' + (i === path.length - 1 ? 'font-weight:600;color:#20241f;' : 'color:#5c6157;') + '">' + esc(node.name) + '</span>';
        }).join('<span style="color:#b3b7ac;"> › </span>')
        : '<span class="muted">No category</span>';
      return '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:10px 12px;margin-bottom:12px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:3px;">Where this sits</div>' +
        '<div style="font-size:12.5px;line-height:1.55;">' + crumbs + '</div>' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">Tier ' + ((c && c.tierLevel) || path.length || '—') +
          (path.length > 1 ? ' · parent: ' + esc(path[path.length - 2].name) : ' · top level') + '</div>' +
        '<div style="margin-top:8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Also in this category, in order (' + siblings.length + ')</div>' +
        (siblings.length
          ? '<div style="max-height:132px;overflow:auto;margin-top:4px;">' + siblings.slice(0, 40).map(function (x) {
            return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0;">' +
              '<span style="color:#20241f;"><code style="color:#8a8f85;font-size:11px;font-variant-numeric:tabular-nums;">' + (Number(x.sortOrder) || 0) + '</code> ' + esc(x.name) + '</span>' +
              '<code style="color:#7a7f75;font-size:11px;white-space:nowrap;">' + esc(x.sku) + '</code></div>';
          }).join('') + (siblings.length > 40 ? '<div class="muted" style="font-size:11.5px;">…and ' + (siblings.length - 40) + ' more</div>' : '') + '</div>'
          : '<div class="muted" style="font-size:12px;margin-top:2px;">Nothing else — this is the only part filed here.</div>') +
        '</div>';
    }
    openModal('Edit ' + p.sku,
      '<div id="ePTier">' + tierPanel(p.categoryId) + '</div>' +
      fieldRow('SKU', '<input style="' + IN + 'background:#f2f3ef;" value="' + esc(p.sku) + '" disabled>') +
      fieldRow('Name', '<input id="ePName" style="' + IN + '" value="' + esc(p.name) + '">') +
      fieldRow('Kind', '<select id="ePKind" style="' + IN + '">' + KINDS.map(function (k) { return '<option value="' + k + '"' + (k === p.kind ? ' selected' : '') + '>' + titleCase(k) + '</option>'; }).join('') + '</select>') +
      fieldRow('Category / tier position', '<select id="ePCat" style="' + IN + '">' + catOpts + '</select>') +
      '<div class="field"><label>Sort order</label><input id="ePSort" type="number" min="0" step="1" style="' + IN + '" value="' + (Number(p.sortOrder) || 0) + '">' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">Position among the parts above. Lower comes first, and this is where the proposal builder files the part when a rep adds it. Ties break alphabetically — leaving gaps of 10 makes room to slot one in later. Catalog → Sort order by tier does the same thing with arrows.</div></div>' +
      '<div class="field"><label>Proposal description</label><textarea id="ePDesc" rows="3" style="' + IN + 'resize:vertical;">' + esc(p.proposalDescription || '') + '</textarea>' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">This is the text that prints under the line item on a proposal.</div></div>' +
      '<div class="field"><label>Internal description</label><textarea id="ePInt" rows="2" style="' + IN + 'resize:vertical;">' + esc(p.internalDescription || '') + '</textarea></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div class="field" style="flex:1;"><label>Length (in)</label><input id="ePL" type="number" min="0" style="' + IN + '" value="' + num(p.lengthIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Width (in)</label><input id="ePW" type="number" min="0" style="' + IN + '" value="' + num(p.widthIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Height (in)</label><input id="ePH" type="number" min="0" style="' + IN + '" value="' + num(p.heightIn) + '"></div>' +
        '<div class="field" style="flex:1;"><label>Weight (oz)</label><input id="ePWt" type="number" min="0" style="' + IN + '" value="' + num(p.weightOz) + '"></div>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="ePShowDims"' + (p.showDimensions ? ' checked' : '') + '> Print dimensions on the proposal</label>' +
      '<div class="muted" style="font-size:12px;margin-top:8px;">Price, cost and weight in pounds live on the SKU — edit those in Catalog → Catalog or Pricing &amp; SKUs. Status has its own dropdown in the list.</div>',
      async function (close, showErr) {
        var body = {
          name: document.getElementById('ePName').value.trim(),
          kind: document.getElementById('ePKind').value,
          categoryId: document.getElementById('ePCat').value,
          proposalDescription: document.getElementById('ePDesc').value.trim(),
          internalDescription: document.getElementById('ePInt').value.trim(),
          showDimensions: document.getElementById('ePShowDims').checked,
        };
        if (body.name.length < 2) return showErr('Name must be at least 2 characters.');
        var sortRaw = document.getElementById('ePSort').value;
        if (sortRaw !== '') {
          var sortNum = Number(sortRaw);
          if (!isFinite(sortNum) || sortNum < 0 || Math.floor(sortNum) !== sortNum) return showErr('Sort order must be a whole number, 0 or more.');
          body.sortOrder = sortNum;
        }
        [['ePL', 'lengthIn'], ['ePW', 'widthIn'], ['ePH', 'heightIn'], ['ePWt', 'weightOz']].forEach(function (f) {
          var v = document.getElementById(f[0]).value;
          if (v !== '') body[f[1]] = Number(v);
        });
        var r = await authed('/catalog/products/' + p.id, { method: 'PATCH', body: body });
        if (!r.ok) return showErr('Could not save (' + r.status + ').');
        close(); loadProducts(user);
      }, 'Save changes');
    var catSel = document.getElementById('ePCat');
    if (catSel) catSel.addEventListener('change', function () {
      var host = document.getElementById('ePTier');
      if (host) host.innerHTML = tierPanel(catSel.value);
    });
  }

  function openProductForm(user) {
    if (!catCategories.length) { alert('Create a category first — products must belong to one.'); return; }
    var catOpts = catCategories.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
    openModal('New product',
      fieldRow('SKU', '<input id="pSku" placeholder="ABC-001" style="' + IN + 'text-transform:uppercase;" required>') +
      fieldRow('Name', '<input id="pName" style="' + IN + '" required>') +
      fieldRow('Kind', selectEl('pKind', KINDS, 'PRODUCT')) +
      fieldRow('Category', '<select id="pCat" style="' + IN + '">' + catOpts + '</select>') +
      fieldRow('Proposal description', '<textarea id="pDesc" rows="3" style="' + IN + 'resize:vertical;"></textarea>') +
      '<div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Length (in)</label><input id="pL" type="number" min="0" style="' + IN + '"></div>' +
      '<div class="field" style="flex:1;"><label>Width (in)</label><input id="pW" type="number" min="0" style="' + IN + '"></div>' +
      '<div class="field" style="flex:1;"><label>Height (in)</label><input id="pH" type="number" min="0" style="' + IN + '"></div></div>',
      async function (close, showErr) {
        var sku = document.getElementById('pSku').value.trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(sku)) return showErr('SKU must be 3–40 chars: letters, numbers, hyphens.');
        var name = document.getElementById('pName').value.trim();
        if (name.length < 2) return showErr('Name must be at least 2 characters.');
        var body = { sku: sku, name: name, kind: document.getElementById('pKind').value, categoryId: document.getElementById('pCat').value };
        var desc = document.getElementById('pDesc').value.trim(); if (desc) body.proposalDescription = desc;
        ['L', 'W', 'H'].forEach(function (k) { var v = document.getElementById('p' + k).value; if (v !== '') body[{ L: 'lengthIn', W: 'widthIn', H: 'heightIn' }[k]] = parseInt(v, 10); });
        var r = await authed('/catalog/products', { method: 'POST', body: body });
        if (r.status === 409) return showErr('That SKU already exists.');
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); cat.page = 1; loadProducts(user);
      });
  }

  /* ==================== Manufacturers ====================
   * The vendor of record: where a purchase order goes, who is called about it,
   * and whether their parts count toward the BOM's steel weight. */
  var mfrState = { rows: [], q: '', showInactive: false };

  async function renderManufacturers(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="mfSearch" placeholder="Search name, city or contact…" value="' + esc(mfrState.q) + '" style="flex:1;min-width:240px;max-width:380px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<label style="display:flex;gap:7px;align-items:center;font-size:13px;color:#5c6157;cursor:pointer;"><input type="checkbox" id="mfInactive"' + (mfrState.showInactive ? ' checked' : '') + '> Show inactive</label>' +
        (admin ? '<div style="margin-left:auto;"><button class="btn" id="mfNew" style="width:auto;padding:10px 17px;">New manufacturer</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">Each manufacturer is the vendor of record for the parts sourced from it. The address and point of contact print as the <b>Ship from</b> block on a Bill of Materials, and vendors marked as steel fabricators are the ones whose weight rolls into a BOM’s total steel weight.</div>' +
      '<div id="mfList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('mfSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { mfrState.q = s.value.trim(); drawManufacturers(user); }, 250); });
    document.getElementById('mfInactive').addEventListener('change', function (e) { mfrState.showInactive = e.target.checked; loadManufacturers(user); });
    if (admin) document.getElementById('mfNew').addEventListener('click', function () { openManufacturerForm(null, user); });
    loadManufacturers(user);
  }

  async function loadManufacturers(user) {
    var box = document.getElementById('mfList'); if (!box) return;
    try {
      var r = await authed('/manufacturers' + (mfrState.showInactive ? '?includeInactive=true' : ''));
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load manufacturers (' + r.status + '). Run the 0022 migration if this persists.</div>'; return; }
      mfrState.rows = (await r.json()) || [];
      drawManufacturers(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function mfrCityLine(m) {
    var right = [m.region, m.postalCode].filter(Boolean).join(' ');
    return [m.city, right].filter(Boolean).join(', ');
  }

  function drawManufacturers(user) {
    var box = document.getElementById('mfList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var q = mfrState.q.toLowerCase();
    var rows = (mfrState.rows || []).filter(function (m) {
      return !q || (m.name + ' ' + (m.city || '') + ' ' + (m.contactName || '') + ' ' + (m.contactEmail || '')).toLowerCase().indexOf(q) !== -1;
    });
    var body = rows.map(function (m) {
      var parts = (m.productCount || 0) + (m.skuCount || 0);
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(m.name) + '</b>' +
          (m.isSteelFabricator ? ' <span class="chip" style="font-size:10.5px;background:#eef0ea;">Steel</span>' : '') +
          (m.isActive === false ? ' <span class="chip" style="font-size:10.5px;background:#f2f3ef;color:#8a8f85;">Inactive</span>' : '') +
          (m.accountNumber ? '<div class="muted" style="font-size:11.5px;">Acct ' + esc(m.accountNumber) + '</div>' : '')) +
        td(m.contactName
          ? '<span style="font-size:13px;">' + esc(m.contactName) + '</span>' +
            (m.contactEmail ? '<div class="muted" style="font-size:11.5px;">' + esc(m.contactEmail) + '</div>' : '') +
            (m.contactPhone ? '<div class="muted" style="font-size:11.5px;">' + esc(m.contactPhone) + '</div>' : '')
          : '<span class="muted">—</span>') +
        td(m.addressLine1
          ? '<span style="font-size:13px;">' + esc(m.addressLine1) + '</span><div class="muted" style="font-size:11.5px;">' + esc(mfrCityLine(m)) + '</div>'
          : '<span class="muted">—</span>') +
        td(esc(m.paymentTerms || '—')) +
        td(m.defaultLeadTimeDays == null ? '—' : m.defaultLeadTimeDays + ' days') +
        td(String(parts)) +
        td(admin ? '<div style="display:flex;gap:6px;justify-content:flex-end;">' +
          '<button class="mfParts link-btn" data-id="' + m.id + '" title="What this vendor calls parts we number ourselves" style="width:auto;padding:6px 12px;">Part numbers</button>' +
          '<button class="mfEdit link-btn" data-id="' + m.id + '" style="width:auto;padding:6px 12px;">Edit</button>' +
          '<button class="mfDel link-btn" data-id="' + m.id + '" style="width:auto;padding:6px 10px;color:#9c3327;">Remove</button></div>' : '') +
        '</tr>';
    }).join('');
    box.innerHTML = tableShell(['Manufacturer', 'Primary contact', 'Address', 'Terms', 'Lead time', 'Parts', ''], body, 7,
      mfrState.rows.length ? 'No manufacturers match that search.' : 'No manufacturers yet. Add the vendors you buy from.');
    box.querySelectorAll('.mfEdit').forEach(function (b) {
      b.addEventListener('click', function () {
        openManufacturerForm((mfrState.rows || []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0], user);
      });
    });
    box.querySelectorAll('.mfDel').forEach(function (b) {
      b.addEventListener('click', function () { openManufacturerDelete(b.getAttribute('data-id'), user); });
    });
    box.querySelectorAll('.mfParts').forEach(function (b) {
      b.addEventListener('click', function () {
        openVendorParts((mfrState.rows || []).filter(function (x) { return x.id === b.getAttribute('data-id'); })[0], user);
      });
    });
  }

  /**
   * What a vendor calls a part we sell under our own number.
   *
   * The Adventure mats are the case this was built for: the configurator generates
   * R-SSG-1010CLM when a size is chosen, that number goes on the proposal and the
   * customer knows the pad by it, and Resilite sell the same pad as A-3204. Both are
   * kept — the proposal prints ours, the Bill of Materials prints both — so nothing
   * here is ever seen by a customer.
   *
   * Mat numbers are generated at price time and have no catalog row, so a mapping
   * can be typed for any part number, catalog or not.
   */
  async function openVendorParts(m, user) {
    if (!m) return;
    var rows = [];
    var busy = false;
    var loadError = '';
    // Held across a redraw, so the confirmation for a row that was just added is
    // still on screen beside it rather than wiped by the render that shows it.
    var pendingMsg = '';
    var ov = null;
    // Scoped to this overlay: a stacked dialog must not be reachable by id.
    var $ = function (sel) { return ov ? ov.querySelector(sel) : null; };

    var load = async function () {
      var r = await authed('/manufacturers/' + m.id + '/vendor-parts');
      if (!r.ok) {
        // Saying so matters more than it looks. A failed reload used to leave an
        // empty table, which reads as "nothing saved" when the rows are sitting in
        // the database.
        loadError = 'Could not load the list (' + r.status + '). Numbers already on record are unaffected.';
        rows = [];
      } else {
        loadError = '';
        rows = await r.json();
      }
      draw();
    };

    ov = openModal('Vendor part numbers — ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' +
        'Our part number on the left, ' + esc(m.name) + '&rsquo;s on the right. The vendor&rsquo;s number prints on the Bill of Materials beside ours and appears nowhere a customer can see. ' +
        'A part with no entry here keeps our number on the sheet.</div>' +
      '<div id="vpBody"><div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div></div>',
      null, null);

    function row(x) {
      return '<tr>' +
        td('<input class="vpOur" data-id="' + x.id + '" value="' + esc(x.ourPart) + '" style="' + bomFieldStyle('150px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;">') +
        td('<input class="vpTheirs" data-id="' + x.id + '" value="' + esc(x.vendorPart) + '" style="' + bomFieldStyle('150px') + 'font-family:ui-monospace,monospace;">') +
        td('<input class="vpDesc" data-id="' + x.id + '" value="' + esc(x.description || '') + '" placeholder="Optional note" style="' + bomFieldStyle('200px') + '">') +
        td('<button type="button" class="vpDel link-btn" data-id="' + x.id + '" style="width:auto;padding:5px 10px;font-size:12px;color:#a2402f;">Remove</button>') +
        '</tr>';
    }

    function draw() {
      var box = $('#vpBody');
      if (!box) return;
      box.innerHTML =
        (loadError ? '<div class="err">' + esc(loadError) + '</div>' : '') +
        '<div style="max-height:46vh;overflow:auto;">' +
          tableShell(['Our part #', esc(m.name) + ' part #', 'Note', ''], rows.map(row).join(''), 4,
            'No vendor numbers yet. Add one below, or paste a list.') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid #eceee8;">' +
          '<div><div class="k">Our part #</div><input id="vpNewOur" placeholder="R-SSG-1010CLM" style="' + bomFieldStyle('160px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;"></div>' +
          '<div><div class="k">Their part #</div><input id="vpNewTheirs" placeholder="A-3204" style="' + bomFieldStyle('150px') + 'font-family:ui-monospace,monospace;"></div>' +
          '<div style="flex:1;min-width:160px;"><div class="k">Note</div><input id="vpNewDesc" placeholder="Optional" style="' + bomFieldStyle() + '"></div>' +
          '<button type="button" class="btn" id="vpAdd" style="width:auto;padding:9px 15px;">Add</button>' +
          '<button type="button" class="link-btn" id="vpPaste" style="width:auto;padding:9px 15px;">Paste a list…</button>' +
        '</div>' +
        '<div id="vpMsg" class="muted" style="font-size:12px;margin-top:8px;"></div>';

      var msg = function (t, bad) {
        var el = $('#vpMsg');
        if (el) { el.style.color = bad ? '#9c3327' : '#5c6157'; el.textContent = t; }
      };

      var patch = async function (el, field) {
        if (busy) return;
        var body = {};
        body[field] = el.value.trim();
        if (field !== 'description' && !body[field]) { msg('A part number cannot be blank.', 1); load(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/vendor-parts/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { msg(await serverMessage(r, 'Could not save that (' + r.status + ').'), 1); return; }
        msg('Saved.');
      };
      box.querySelectorAll('.vpOur').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'ourPart'); }); });
      box.querySelectorAll('.vpTheirs').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'vendorPart'); }); });
      box.querySelectorAll('.vpDesc').forEach(function (el) { el.addEventListener('change', function () { patch(el, 'description'); }); });

      box.querySelectorAll('.vpDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Remove this vendor number?\n\nThe part keeps our number on the Bill of Materials.')) return;
          var r = await authed('/vendor-parts/' + b.getAttribute('data-id'), { method: 'DELETE' });
          if (!r.ok && r.status !== 204) { msg('Could not remove that (' + r.status + ').', 1); return; }
          load();
        });
      });

      var addBtn = $('#vpAdd');
      var add = async function () {
        if (busy) return;
        var ourEl = $('#vpNewOur'), theirsEl = $('#vpNewTheirs'), descEl = $('#vpNewDesc');
        var ourPart = ourEl.value.trim().toUpperCase();
        var vendorPart = theirsEl.value.trim();
        if (!ourPart || !vendorPart) {
          msg('Both part numbers are needed.', 1);
          (ourPart ? theirsEl : ourEl).focus();
          return;
        }
        busy = true;
        addBtn.disabled = true; addBtn.textContent = 'Adding…';
        var r = await authed('/manufacturers/' + m.id + '/vendor-parts', {
          method: 'POST',
          body: { ourPart: ourPart, vendorPart: vendorPart, description: descEl.value.trim() },
        });
        busy = false;
        addBtn.disabled = false; addBtn.textContent = 'Add';
        if (!r.ok) {
          // 409 is the useful one: this vendor already has a number for that part and
          // the server names it. What was typed is left alone so it can be corrected.
          msg(await serverMessage(r, 'Could not add that (' + r.status + ').'), 1);
          return;
        }
        ourEl.value = ''; theirsEl.value = ''; descEl.value = '';
        pendingMsg = 'Added ' + ourPart + ' → ' + vendorPart + '.';
        await load();
        // Straight back to the first field: these are entered a dozen at a time.
        var next = $('#vpNewOur');
        if (next) next.focus();
      };
      addBtn.addEventListener('click', add);

      // Enter in any of the three fields adds the row. This dialog has no submit of
      // its own, so Enter previously did nothing.
      [$('#vpNewOur'), $('#vpNewTheirs'), $('#vpNewDesc')].forEach(function (el) {
        if (!el) return;
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); add(); }
        });
      });

      $('#vpPaste').addEventListener('click', function () { openVendorPartPaste(m, load); });

      if (pendingMsg) { msg(pendingMsg); pendingMsg = ''; }
    }

    load();
  }

  /**
   * Bulk load. A vendor with a number for every mat size has dozens of rows, and a
   * mapping typed one row at a time is a mapping that ends up half-loaded. The
   * paste is checked before anything is written, so the count and any clash are
   * seen first.
   */
  function openVendorPartPaste(m, done) {
    var pv = openModal('Paste part numbers — ' + m.name,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:10px;">' +
        'One row per part: our number, then theirs, separated by a tab or a comma. A third column is kept as a note. ' +
        'Paste straight out of a spreadsheet.</div>' +
      '<textarea id="vpText" rows="10" placeholder="R-SSG-1010CLM&#9;A-3204&#10;R-SSG-1012CLM&#9;A-3205" style="' + IN + 'resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px;"></textarea>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;cursor:pointer;">' +
        '<input type="checkbox" id="vpOverwrite"> Replace numbers already on record</label>' +
      '<div id="vpPreview" class="muted" style="font-size:12.5px;line-height:1.6;margin-top:10px;"></div>',
      async function (close, showErr) {
        var text = pv.querySelector('#vpText').value;
        if (!text.trim()) return showErr('Nothing pasted.');
        var overwrite = pv.querySelector('#vpOverwrite').checked;
        var pre = pv.querySelector('#vpPreview');

        // First press checks, second press writes — the same two-step the catalog
        // import uses, so the count is seen before anything lands.
        if (!pre.getAttribute('data-checked')) {
          var rc = await authed('/manufacturers/' + m.id + '/vendor-parts/import', {
            method: 'POST', body: { text: text, dryRun: true, overwrite: overwrite },
          });
          if (!rc.ok) return showErr(await serverMessage(rc, 'Could not read that list (' + rc.status + ').'));
          var d = await rc.json();
          pre.innerHTML =
            '<b style="color:#3d4a55;">' + d.parsed + ' row' + (d.parsed === 1 ? '' : 's') + ' read.</b> ' +
            d.created + ' to add, ' + d.updated + ' to update, ' + d.skipped + ' unchanged or skipped.' +
            ((d.conflicts || []).length
              ? '<div style="margin-top:6px;color:#8a6d1f;">Already on record and left alone: ' +
                d.conflicts.slice(0, 6).map(function (c) { return esc(c.ourPart) + ' (' + esc(c.current) + ' → ' + esc(c.incoming) + ')'; }).join(', ') +
                ((d.conflicts || []).length > 6 ? ' and ' + (d.conflicts.length - 6) + ' more' : '') +
                '. Tick the box above to replace them.</div>'
              : '') +
            ((d.errors || []).length ? '<div style="margin-top:6px;color:#9c3327;">' + d.errors.map(esc).join('<br>') + '</div>' : '') +
            '<div style="margin-top:6px;">Press Import again to write these.</div>';
          pre.setAttribute('data-checked', '1');
          return;
        }

        var r = await authed('/manufacturers/' + m.id + '/vendor-parts/import', {
          method: 'POST', body: { text: text, overwrite: overwrite },
        });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not import (' + r.status + ').'));
        close();
        if (done) done();
      }, 'Import');

    // Any edit invalidates the check, so the two presses always describe the same
    // text.
    var t = pv.querySelector('#vpText'), o = pv.querySelector('#vpOverwrite');
    var reset = function () { var p = pv.querySelector('#vpPreview'); if (p) { p.removeAttribute('data-checked'); p.innerHTML = ''; } };
    if (t) t.addEventListener('input', reset);
    if (o) o.addEventListener('change', reset);
  }

  function openManufacturerForm(m, user) {
    m = m || {};
    var v = function (k) { return esc(m[k] == null ? '' : m[k]); };
    var two = function (a, b) { return '<div style="display:flex;gap:8px;"><div style="flex:1;">' + a + '</div><div style="flex:1;">' + b + '</div></div>'; };
    // Mirrors vendorAbbrev() in src/handoff/freightRfq.ts — shown as the placeholder
    // so the field says what it will do when left blank.
    function derivedAbbrev(name) {
      var words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/)
        .filter(function (w) { return w && !/^(the|and|of|inc|llc|co|company|corp|ltd)$/i.test(w); });
      if (!words.length) return '';
      if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
      return words.map(function (w) { return w[0]; }).join('').slice(0, 4).toUpperCase();
    }
    openModal(m.id ? 'Edit ' + m.name : 'New manufacturer',
      fieldRow('Manufacturer name', '<input id="mfName" style="' + IN + '" value="' + v('name') + '" required>') +
      fieldRow('Freight RFQ code',
        '<input id="mfRfqAbbrev" maxlength="8" style="' + IN + 'text-transform:uppercase;" value="' + v('rfqAbbrev') + '" placeholder="' + esc(derivedAbbrev(m.name) || 'SE') + '">' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Appended to this vendor\'s freight requests so several on one project are told apart — <b>RFQ-12414494509-' + esc(derivedAbbrev(m.name) || 'SE') + '</b>, where the middle number is the monday Project ID. Leave it blank to use the initials shown.</div>') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Primary point of contact</div>' +
      two(fieldRow('Name', '<input id="mfCName" style="' + IN + '" value="' + v('contactName') + '">'),
          fieldRow('Title', '<input id="mfCTitle" style="' + IN + '" value="' + v('contactTitle') + '">')) +
      two(fieldRow('Email', '<input id="mfCEmail" type="email" style="' + IN + '" value="' + v('contactEmail') + '">'),
          fieldRow('Phone', '<input id="mfCPhone" style="' + IN + '" value="' + v('contactPhone') + '">')) +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Secondary contact</div>' +
      two(fieldRow('Name', '<input id="mfAName" style="' + IN + '" value="' + v('altContactName') + '">'),
          fieldRow('Phone', '<input id="mfAPhone" style="' + IN + '" value="' + v('altContactPhone') + '">')) +
      fieldRow('Email', '<input id="mfAEmail" type="email" style="' + IN + '" value="' + v('altContactEmail') + '">') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Address</div>' +
      fieldRow('Street', '<input id="mfAddr1" style="' + IN + '" value="' + v('addressLine1') + '">') +
      fieldRow('Suite / unit', '<input id="mfAddr2" placeholder="Suite 100" style="' + IN + '" value="' + v('addressLine2') + '">') +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:2;">' + fieldRow('City', '<input id="mfCity" style="' + IN + '" value="' + v('city') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('State', '<input id="mfRegion" style="' + IN + '" value="' + v('region') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('ZIP', '<input id="mfZip" style="' + IN + '" value="' + v('postalCode') + '">') + '</div>' +
      '</div>' +
      two(fieldRow('Country', '<input id="mfCountry" style="' + IN + '" value="' + esc(m.country == null ? 'USA' : m.country) + '">'),
          fieldRow('Website', '<input id="mfWeb" placeholder="https://" style="' + IN + '" value="' + v('website') + '">')) +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Purchasing</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;">' + fieldRow('Our account #', '<input id="mfAcct" style="' + IN + '" value="' + v('accountNumber') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Payment terms', '<input id="mfTerms" placeholder="e.g. Net 30" style="' + IN + '" value="' + v('paymentTerms') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Lead time (days)', '<input id="mfLead" type="number" min="0" style="' + IN + '" value="' + (m.defaultLeadTimeDays == null ? '' : m.defaultLeadTimeDays) + '">') + '</div>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:4px;"><input type="checkbox" id="mfSteel"' + (m.isSteelFabricator ? ' checked' : '') + '> Steel fabricator — their lines count toward total steel weight on a BOM</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfThird"' + (m.id ? (m.isThirdParty ? ' checked' : '') : ' checked') + '> Third-party vendor (unchecked = made in-house)</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfActive"' + (m.id ? (m.isActive !== false ? ' checked' : '') : ' checked') + '> Active — offered when assigning a vendor</label>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="mfFreightTbd" style="margin-top:3px;"' + (m.freightTbd ? ' checked' : '') + '><span>Freight quoted after approval<span class="muted" style="display:block;font-size:11.5px;line-height:1.5;">Every part from this vendor carries the standing “freight not yet determined” note on its proposal line, until a freight amount is entered on that line.</span></span></label>' +
      '<div class="field" style="margin-top:10px;"><label>Notes</label><textarea id="mfNotes" rows="2" style="' + IN + 'resize:vertical;">' + esc(m.notes || '') + '</textarea></div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:16px 0 6px;">Request for Freight (RFQ)</div>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="mfRfq" style="margin-top:3px;"' + (m.rfqEnabled ? ' checked' : '') + '><span>Can receive freight quote requests<span class="muted" style="display:block;font-size:11.5px;line-height:1.5;">Offered as an RFQ recipient on any proposal carrying their parts. Vendors who do not quote freight stay off the list.</span></span></label>' +
      '<div class="muted" style="font-size:12px;margin:10px 0 8px;line-height:1.5;">The freight desk is rarely the purchasing contact the BOM goes to. Left blank, these fall back to the primary contact above. Tokens for the message: <code>{{customer}}</code> <code>{{vendor}}</code> <code>{{reference}}</code> <code>{{projectId}}</code> <code>{{total}}</code>.</div>' +
      two(fieldRow('Freight contact', '<input id="mfRfqName" style="' + IN + '" value="' + v('rfqContactName') + '">'),
          fieldRow('Phone', '<input id="mfRfqPhone" style="' + IN + '" value="' + v('rfqContactPhone') + '">')) +
      two(fieldRow('Send RFQs to', '<input id="mfRfqTo" type="email" placeholder="Falls back to the contact email" style="' + IN + '" value="' + v('rfqEmailTo') + '">'),
          fieldRow('Cc', '<input id="mfRfqCc" placeholder="Optional" style="' + IN + '" value="' + v('rfqEmailCc') + '">')) +
      fieldRow('Freight contact email', '<input id="mfRfqEmail" type="email" placeholder="Named contact, if different from the send-to address" style="' + IN + '" value="' + v('rfqContactEmail') + '">') +
      fieldRow('Subject', '<input id="mfRfqSubject" placeholder="Freight quote request {{reference}} — {{customer}}" style="' + IN + '" value="' + v('rfqEmailSubject') + '">') +
      '<div class="field"><label>Default message</label><textarea id="mfRfqBody" rows="4" placeholder="Left blank, a standard covering note is used." style="' + IN + 'resize:vertical;">' + esc(m.rfqEmailBody || '') + '</textarea></div>' +
      fieldRow('Freight figure on the deal',
        '<select id="mfFreightSrc" style="' + IN + '">' +
          '<option value="STRUCTURE"' + (m.bomFreightSource === 'MATS' || m.bomFreightSource === 'NONE' ? '' : ' selected') + '>Structure freight</option>' +
          '<option value="MATS"' + (m.bomFreightSource === 'MATS' ? ' selected' : '') + '>Mats freight</option>' +
          '<option value="NONE"' + (m.bomFreightSource === 'NONE' ? ' selected' : '') + '>None — this vendor quotes no freight</option>' +
        '</select>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">The structure and the mats ship as two loads and are quoted separately on the deal. This says which figure lands on this vendor&rsquo;s sheet.</div>') +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:16px 0 6px;">Bill of Materials email</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:8px;line-height:1.5;">Pre-fills the send dialog for this vendor — a fabricator and a distributor rarely want the same note or the same format. Tokens: <code>{{customer}}</code> <code>{{vendor}}</code> <code>{{order}}</code> <code>{{job}}</code> <code>{{submittedOn}}</code>. Left blank, the subject matches the attachment name: <code>{{customer}}-{{order}}-{{vendor}}</code>.</div>' +
      two(fieldRow('Send BOMs to', '<input id="mfBomTo" type="email" placeholder="Falls back to the contact email" style="' + IN + '" value="' + v('bomEmailTo') + '">'),
          fieldRow('Cc', '<input id="mfBomCc" placeholder="Optional" style="' + IN + '" value="' + v('bomEmailCc') + '">')) +
      fieldRow('Subject', '<input id="mfBomSubject" placeholder="{{customer}}-{{order}}-{{vendor}}" style="' + IN + '" value="' + v('bomEmailSubject') + '">') +
      fieldRow('Attach as', '<select id="mfBomFormat" style="' + IN + '">' +
        ['PDF', 'EXCEL', 'BOTH'].map(function (f) { return '<option value="' + f + '"' + ((m.bomEmailFormat || 'PDF') === f ? ' selected' : '') + '>' + (f === 'BOTH' ? 'Both' : f === 'EXCEL' ? 'Excel' : 'PDF') + '</option>'; }).join('') +
        '</select>') +
      '<div class="field"><label>Default message</label><textarea id="mfBomBody" rows="5" placeholder="Left blank, a standard covering note is used." style="' + IN + 'resize:vertical;">' + esc(m.bomEmailBody || '') + '</textarea></div>',
      async function (close, showErr) {
        var name = document.getElementById('mfName').value.trim();
        if (name.length < 2) return showErr('Manufacturer name is required.');
        var lead = document.getElementById('mfLead').value;
        var body = {
          name: name,
          contactName: document.getElementById('mfCName').value.trim(),
          contactTitle: document.getElementById('mfCTitle').value.trim(),
          contactEmail: document.getElementById('mfCEmail').value.trim(),
          contactPhone: document.getElementById('mfCPhone').value.trim(),
          altContactName: document.getElementById('mfAName').value.trim(),
          altContactEmail: document.getElementById('mfAEmail').value.trim(),
          altContactPhone: document.getElementById('mfAPhone').value.trim(),
          bomEmailTo: document.getElementById('mfBomTo').value.trim(),
          bomEmailCc: document.getElementById('mfBomCc').value.trim(),
          bomEmailSubject: document.getElementById('mfBomSubject').value.trim(),
          bomEmailBody: document.getElementById('mfBomBody').value,
          bomEmailFormat: document.getElementById('mfBomFormat').value,
          bomFreightSource: document.getElementById('mfFreightSrc').value,
          rfqEnabled: document.getElementById('mfRfq').checked,
          rfqContactName: document.getElementById('mfRfqName').value.trim(),
          rfqContactEmail: document.getElementById('mfRfqEmail').value.trim(),
          rfqContactPhone: document.getElementById('mfRfqPhone').value.trim(),
          rfqEmailTo: document.getElementById('mfRfqTo').value.trim(),
          rfqEmailCc: document.getElementById('mfRfqCc').value.trim(),
          rfqEmailSubject: document.getElementById('mfRfqSubject').value.trim(),
          rfqEmailBody: document.getElementById('mfRfqBody').value,
          addressLine1: document.getElementById('mfAddr1').value.trim(),
          addressLine2: document.getElementById('mfAddr2').value.trim(),
          city: document.getElementById('mfCity').value.trim(),
          region: document.getElementById('mfRegion').value.trim(),
          postalCode: document.getElementById('mfZip').value.trim(),
          country: document.getElementById('mfCountry').value.trim(),
          website: document.getElementById('mfWeb').value.trim(),
          accountNumber: document.getElementById('mfAcct').value.trim(),
          paymentTerms: document.getElementById('mfTerms').value.trim(),
          defaultLeadTimeDays: lead === '' ? null : parseInt(lead, 10) || 0,
          isSteelFabricator: document.getElementById('mfSteel').checked,
          isThirdParty: document.getElementById('mfThird').checked,
          freightTbd: document.getElementById('mfFreightTbd').checked,
          rfqAbbrev: document.getElementById('mfRfqAbbrev').value.trim().toUpperCase(),
          isActive: document.getElementById('mfActive').checked,
          notes: document.getElementById('mfNotes').value.trim()
        };
        var r = m.id
          ? await authed('/manufacturers/' + m.id, { method: 'PATCH', body: body })
          : await authed('/manufacturers', { method: 'POST', body: body });
        if (!r.ok) { var msg = ''; try { msg = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(msg || 'Could not save (' + r.status + ').'); }
        close(); loadManufacturers(user);
      }, m.id ? 'Save manufacturer' : 'Create manufacturer');
  }

  /** Removing a vendor is only safe when nothing points at it. */
  async function openManufacturerDelete(id, user) {
    var u = null;
    try { var r = await authed('/manufacturers/' + id + '/usage'); if (r.ok) u = await r.json(); } catch (e) {}
    if (!u) { alert('Could not check where this vendor is used.'); return; }
    openModal('Remove ' + u.name,
      (u.deletable
        ? '<div style="font-size:13.5px;line-height:1.6;">Nothing references this vendor, so it can be deleted outright.</div>'
        : '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;line-height:1.55;">' + esc(u.reason) + '</div>') +
      '<div class="muted" style="font-size:12.5px;margin-top:10px;line-height:1.55;">Deactivating keeps every part, order and past BOM exactly as it is, and simply stops the vendor being offered.</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;"><button type="button" class="link-btn" id="mfDeact" style="width:auto;padding:9px 15px;">Deactivate instead</button></div>',
      u.deletable
        ? async function (close, showErr) {
          var rr = await authed('/manufacturers/' + id, { method: 'DELETE' });
          if (!rr.ok && rr.status !== 204) { var msg = ''; try { msg = ((await rr.json()) || {}).message || ''; } catch (e) {} return showErr(msg || 'Could not delete (' + rr.status + ').'); }
          close(); loadManufacturers(user);
        }
        : async function (close) { close(); },
      u.deletable ? 'Delete permanently' : 'Close');
    var da = document.getElementById('mfDeact');
    if (da) da.addEventListener('click', async function () {
      var rr = await authed('/manufacturers/' + id, { method: 'PATCH', body: { isActive: false } });
      if (!rr.ok) { alert('Could not deactivate (' + rr.status + ').'); return; }
      var form = document.getElementById('mForm');
      if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
      loadManufacturers(user);
    });
  }

  /* ==================== Bundles ====================
   * A bundle is one catalog part whose contents are other catalog parts. It has no
   * price of its own — price, cost and weight are always the sum of its
   * components, so repricing a component can never leave a stale bundle behind. */
  var bundleState = { rows: [], q: '' };

  async function renderBundles(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="bnSearch" placeholder="Search bundles…" value="' + esc(bundleState.q) + '" style="flex:1;min-width:220px;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (admin ? '<div style="margin-left:auto;"><button class="btn" id="bnNew" style="width:auto;padding:10px 17px;">New bundle</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">A bundle is a single proposal line priced as the sum of its parts, with the parts listed beneath it. Because those sub-lines carry the real part numbers, the Bill of Materials, the cost of goods and the freight weight all see the actual components.</div>' +
      '<div id="bnList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('bnSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { bundleState.q = s.value.trim(); drawBundles(user); }, 250); });
    if (admin) document.getElementById('bnNew').addEventListener('click', function () { openBundleForm(user); });
    loadBundles(user);
  }

  async function loadBundles(user) {
    var box = document.getElementById('bnList'); if (!box) return;
    try {
      var r = await authed('/catalog/bundles');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load bundles (' + r.status + ').</div>'; return; }
      bundleState.rows = (await r.json()) || [];
      drawBundles(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function drawBundles(user) {
    var box = document.getElementById('bnList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var q = bundleState.q.toLowerCase();
    var rows = (bundleState.rows || []).filter(function (b) { return !q || (b.name + ' ' + b.sku).toLowerCase().indexOf(q) !== -1; });
    if (!rows.length) {
      box.innerHTML = '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">' +
        (bundleState.rows.length ? 'No bundles match that search.' : 'No bundles yet. Create one, then add the parts it contains.') + '</p></div>';
      return;
    }
    box.innerHTML = rows.map(function (b) {
      var comp = b.components || [];
      var inner = comp.length
        ? '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
            '<thead><tr>' + ['Part #', 'Component', 'Qty', 'Unit price', 'Extended'].map(function (h, i) {
              return '<th style="text-align:' + (i > 1 ? 'right' : 'left') + ';padding:7px 10px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;border-bottom:1px solid #eef0ea;">' + h + '</th>';
            }).join('') + '</tr></thead><tbody>' +
            comp.map(function (c) {
              return '<tr>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;"><code style="font-size:12px;color:#4a4f47;">' + esc(c.sku) + '</code></td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;">' + esc(c.name) + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">' + c.quantity + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">$' + (Number(c.unitPriceMinor) / 100).toFixed(2) + '</td>' +
                '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;text-align:right;">$' + (Number(c.extendedPriceMinor) / 100).toFixed(2) + '</td></tr>';
            }).join('') +
          '</tbody></table>'
        : '<div class="muted" style="padding:12px 10px;font-size:13px;">Nothing in this bundle yet.</div>';
      return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;padding:14px 16px;margin-bottom:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">' +
          '<div><div style="font-weight:600;font-size:15px;">' + esc(b.name) + ' <code style="font-size:12px;color:#7a7f75;font-weight:400;">' + esc(b.sku) + '</code></div>' +
            '<div class="muted" style="font-size:12px;margin-top:2px;">' + comp.length + ' component' + (comp.length === 1 ? '' : 's') +
              ' · rolls up to <b style="color:#20241f;">$' + (Number(b.unitPriceMinor) / 100).toFixed(2) + '</b>' +
              ' · cost $' + (Number(b.unitCostMinor) / 100).toFixed(2) + ' · ' + b.weightLbs + ' lb' +
              (b.missingPrice && b.missingPrice.length ? ' · <span style="color:#9c3327;">' + b.missingPrice.length + ' component(s) have no price</span>' : '') + '</div></div>' +
          (admin ? '<div style="display:flex;gap:6px;">' +
            '<button class="bnEdit link-btn" data-id="' + b.id + '" style="width:auto;padding:7px 13px;">Edit contents</button>' +
            '<button class="bnDel link-btn" data-id="' + b.id + '" style="width:auto;padding:7px 11px;color:#9c3327;">Delete</button></div>' : '') +
        '</div>' +
        '<div style="margin-top:10px;">' + inner + '</div>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.bnEdit').forEach(function (bt) {
      bt.addEventListener('click', function () {
        openBundleComponents((bundleState.rows || []).filter(function (x) { return x.id === bt.getAttribute('data-id'); })[0], user);
      });
    });
    box.querySelectorAll('.bnDel').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        if (!confirm('Delete this bundle? Its component parts are not touched.')) return;
        var r = await authed('/catalog/bundles/' + bt.getAttribute('data-id'), { method: 'DELETE' });
        if (!r.ok && r.status !== 204) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not delete (' + r.status + ').'); return; }
        loadBundles(user);
      });
    });
  }

  async function openBundleForm(user) {
    if (!catCategories.length) {
      try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : []; } catch (e) {}
    }
    if (!catCategories.length) { alert('Create a category first — a bundle is filed like any other product.'); return; }
    openModal('New bundle',
      fieldRow('Part #', '<input id="bnSku" placeholder="e.g. SSG-STARTER-BUNDLE" style="' + IN + 'text-transform:uppercase;" required>') +
      fieldRow('Bundle name', '<input id="bnName" style="' + IN + '" required>') +
      fieldRow('Category', '<select id="bnCat" style="' + IN + '">' + catOptionsTree('') + '</select>') +
      fieldRow('Proposal description', '<textarea id="bnDesc" rows="3" style="' + IN + 'resize:vertical;"></textarea>') +
      '<div class="muted" style="font-size:12px;">You add the parts it contains next. The price is always the sum of those parts.</div>',
      async function (close, showErr) {
        var sku = document.getElementById('bnSku').value.trim().toUpperCase();
        if (sku.length < 2) return showErr('A part # is required.');
        var name = document.getElementById('bnName').value.trim();
        if (name.length < 2) return showErr('Give the bundle a name.');
        var r = await authed('/catalog/bundles', { method: 'POST', body: {
          sku: sku, name: name, categoryId: document.getElementById('bnCat').value,
          proposalDescription: document.getElementById('bnDesc').value.trim() || undefined
        } });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not create (' + r.status + ').'); }
        var created = await r.json();
        close();
        await loadBundles(user);
        openBundleComponents({ id: created.id, sku: created.sku, name: created.name, components: [] }, user);
      }, 'Create bundle');
  }

  /** Search-and-add panel for a bundle's contents. Sends the whole list at once. */
  async function openBundleComponents(bundle, user) {
    if (!bundle) return;
    var picked = (bundle.components || []).map(function (c) { return { productId: c.productId, sku: c.sku, name: c.name, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor }; });
    var products = [];
    try {
      var r = await authed('/catalog/products?pageSize=500');
      if (r.ok) products = ((await r.json()) || {}).items || [];
    } catch (e) {}
    products = products.filter(function (p) { return p.kind !== 'BUNDLE'; });

    function pickedHtml() {
      if (!picked.length) return '<div class="muted" style="padding:12px;font-size:13px;">Nothing added yet — search below.</div>';
      var total = picked.reduce(function (a, c) { return a + (Number(c.unitPriceMinor) || 0) * (Number(c.quantity) || 0); }, 0);
      return picked.map(function (c, i) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #f2f3ef;">' +
          '<div style="flex:1;font-size:13px;">' + esc(c.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(c.sku) + '</code></div>' +
          '<input class="bcQty" data-i="' + i + '" type="number" min="1" value="' + (c.quantity || 1) + '" style="width:64px;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;text-align:right;font-size:13px;">' +
          '<div style="width:88px;text-align:right;font-size:12.5px;color:#5c6157;">$' + ((Number(c.unitPriceMinor) || 0) * (Number(c.quantity) || 0) / 100).toFixed(2) + '</div>' +
          '<button type="button" class="bcRm" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 9px;font-size:12px;">✕</button>' +
        '</div>';
      }).join('') +
      '<div style="display:flex;justify-content:flex-end;gap:10px;padding:9px 10px;font-size:13px;font-weight:600;">Bundle price $' + (total / 100).toFixed(2) + '</div>';
    }
    function searchHtml(list) {
      return (list.slice(0, 60).map(function (p) {
        return '<button type="button" class="bcAdd" data-id="' + p.id + '" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid #f2f3ef;background:#fff;padding:8px 11px;cursor:pointer;font-size:13px;">' +
          esc(p.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(p.sku) + '</code></button>';
      }).join('')) || '<div class="muted" style="padding:12px;font-size:13px;">No parts match.</div>';
    }

    openModal('Contents of ' + bundle.name,
      '<div style="border:1px solid #e7e8e3;border-radius:10px;overflow:hidden;margin-bottom:12px;"><div id="bcPicked">' + pickedHtml() + '</div></div>' +
      '<input id="bcSearch" placeholder="Search a part to add…" style="' + IN + 'margin-bottom:8px;">' +
      '<div id="bcResults" style="max-height:220px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' + searchHtml(products) + '</div>',
      async function (close, showErr) {
        var r2 = await authed('/catalog/bundles/' + bundle.id + '/components', { method: 'PUT', body: {
          components: picked.map(function (c) { return { productId: c.productId, quantity: Number(c.quantity) || 1 }; })
        } });
        if (!r2.ok) { var m = ''; try { m = ((await r2.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not save (' + r2.status + ').'); }
        close(); loadBundles(user);
      }, 'Save contents');

    function repaint() {
      var host = document.getElementById('bcPicked'); if (!host) return;
      host.innerHTML = pickedHtml();
      host.querySelectorAll('.bcQty').forEach(function (el) {
        el.addEventListener('change', function () { picked[Number(el.getAttribute('data-i'))].quantity = Math.max(1, parseInt(el.value, 10) || 1); repaint(); });
      });
      host.querySelectorAll('.bcRm').forEach(function (el) {
        el.addEventListener('click', function () { picked.splice(Number(el.getAttribute('data-i')), 1); repaint(); });
      });
    }
    function wireResults(list) {
      var box = document.getElementById('bcResults'); if (!box) return;
      box.querySelectorAll('.bcAdd').forEach(function (b) {
        b.addEventListener('click', async function () {
          var p = list.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
          if (!p || picked.some(function (c) { return c.productId === p.id; })) return;
          var price = 0;
          try {
            var rp = await authed('/catalog/items?q=' + encodeURIComponent(p.sku) + '&pageSize=5');
            if (rp.ok) {
              var hit = (((await rp.json()) || {}).items || []).filter(function (x) { return x.part === p.sku; })[0];
              if (hit) price = hit.unitPriceMinor || 0;
            }
          } catch (e) {}
          picked.push({ productId: p.id, sku: p.sku, name: p.name, quantity: 1, unitPriceMinor: price });
          repaint();
        });
      });
    }
    setTimeout(function () {
      repaint(); wireResults(products);
      var s = document.getElementById('bcSearch');
      if (s) s.addEventListener('input', function () {
        var q = s.value.toLowerCase();
        var list = products.filter(function (p) { return (p.name + ' ' + p.sku).toLowerCase().indexOf(q) !== -1; });
        document.getElementById('bcResults').innerHTML = searchHtml(list);
        wireResults(list);
      });
    }, 50);
  }

  /* ==================== Product tree: categories, order, workbook ==================== */

  /** Rename, reorder, hide and delete the tier categories. */
  async function openCategoryManager(user) {
    try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : catCategories; } catch (e) {}
    var list = (catCategories || []).slice().sort(function (a, b) {
      return ((a.tierLevel || 1) - (b.tierLevel || 1)) || ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
    });
    var counts = {};
    (cat.rows || []).forEach(function (p) { counts[p.categoryId] = (counts[p.categoryId] || 0) + 1; });

    function rowHtml(c, i) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #f2f3ef;">' +
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<button type="button" class="cmUp" data-i="' + i + '" title="Move up" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;line-height:1;padding:2px 5px;">▲</button>' +
          '<button type="button" class="cmDown" data-i="' + i + '" title="Move down" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;line-height:1;padding:2px 5px;">▼</button>' +
        '</div>' +
        '<input class="cmName" data-id="' + c.id + '" value="' + esc(c.name) + '" style="flex:1;padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:13px;">' +
        '<select class="cmTier" data-id="' + c.id + '" style="padding:6px 7px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
          [1, 2, 3, 4].map(function (t) { return '<option value="' + t + '"' + ((c.tierLevel || 1) === t ? ' selected' : '') + '>Tier ' + t + '</option>'; }).join('') +
        '</select>' +
        '<span class="muted" style="font-size:11.5px;width:74px;text-align:right;">' + (counts[c.id] || 0) + ' part' + ((counts[c.id] || 0) === 1 ? '' : 's') + '</span>' +
        '<label style="display:flex;gap:5px;align-items:center;font-size:11.5px;color:#5c6157;"><input type="checkbox" class="cmActive" data-id="' + c.id + '"' + (c.isActive === false ? '' : ' checked') + '> shown</label>' +
        '<button type="button" class="cmDel" data-id="' + c.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 8px;font-size:12px;">✕</button>' +
      '</div>';
    }
    openModal('Categories & tiers',
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">Renaming a category never moves a product — the name is only a label. The arrows set the order categories appear in; the tier is the level it sits at in the tree.</div>' +
      '<div id="cmList" style="border:1px solid #e7e8e3;border-radius:10px;max-height:380px;overflow:auto;">' + list.map(rowHtml).join('') + '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:10px;"><button type="button" class="link-btn" id="cmAdd" style="width:auto;padding:8px 14px;">+ New category</button></div>',
      async function (close, showErr) {
        // Names, tiers and visibility first, then one reorder call for the lot.
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          var nameEl = document.querySelector('.cmName[data-id="' + c.id + '"]');
          var tierEl = document.querySelector('.cmTier[data-id="' + c.id + '"]');
          var actEl = document.querySelector('.cmActive[data-id="' + c.id + '"]');
          if (!nameEl) continue;
          var body = {};
          if (nameEl.value.trim() && nameEl.value.trim() !== c.name) body.name = nameEl.value.trim();
          if (tierEl && Number(tierEl.value) !== (c.tierLevel || 1)) body.tierLevel = Number(tierEl.value);
          if (actEl && actEl.checked !== (c.isActive !== false)) body.isActive = actEl.checked;
          if (!Object.keys(body).length) continue;
          var r = await authed('/catalog/categories/' + c.id, { method: 'PATCH', body: body });
          if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e2) {} return showErr(m || 'Could not save “' + c.name + '” (' + r.status + ').'); }
        }
        var rr = await authed('/catalog/categories/reorder', { method: 'POST', body: { ids: list.map(function (c2) { return c2.id; }) } });
        if (!rr.ok) return showErr('Saved the names, but could not save the order (' + rr.status + ').');
        close();
        try { var rc2 = await authed('/catalog/categories'); catCategories = rc2.ok ? await rc2.json() : catCategories; } catch (e3) {}
        loadProducts(user);
      }, 'Save categories');

    function repaint() {
      var host = document.getElementById('cmList'); if (!host) return;
      host.innerHTML = list.map(rowHtml).join('');
      wire();
    }
    function wire() {
      var host = document.getElementById('cmList'); if (!host) return;
      host.querySelectorAll('.cmUp').forEach(function (b) {
        b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i > 0) { var t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; repaint(); } });
      });
      host.querySelectorAll('.cmDown').forEach(function (b) {
        b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i < list.length - 1) { var t = list[i + 1]; list[i + 1] = list[i]; list[i] = t; repaint(); } });
      });
      host.querySelectorAll('.cmDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          var id = b.getAttribute('data-id');
          if (!confirm('Delete this category? It must be empty.')) return;
          var r = await authed('/catalog/categories/' + id, { method: 'DELETE' });
          if (!r.ok && r.status !== 204) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not delete (' + r.status + ').'); return; }
          list = list.filter(function (c) { return c.id !== id; });
          catCategories = (catCategories || []).filter(function (c) { return c.id !== id; });
          repaint();
        });
      });
    }
    setTimeout(function () {
      wire();
      var add = document.getElementById('cmAdd');
      if (add) add.addEventListener('click', async function () {
        var name = prompt('New category name');
        if (!name || name.trim().length < 2) return;
        var r = await authed('/catalog/categories', { method: 'POST', body: { name: name.trim(), slug: slugify(name), sortOrder: list.length, isActive: true } });
        if (!r.ok) { alert('Could not create (' + r.status + ').'); return; }
        var created = await r.json();
        list.push(created); catCategories.push(created); repaint();
      });
    }, 50);
  }

  /**
   * The default product list order. The arrows move a part within the whole list;
   * saving writes the order the proposal picker and the tier listings read.
   */
  function openProductReorder(user) {
    // The whole catalogue, in its current order, is always what gets saved. The
    // tier filter narrows what is SHOWN; moving a row swaps it with its neighbour in
    // the same tier, and every other product keeps the number it has. Saving a
    // filtered view used to renumber the catalogue from the filtered rows alone.
    var list = (cat.rows || []).slice().sort(function (a, b) {
      return ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
    });
    var pick = '';

    /** Indices into `list`, in display order, for the tier on screen. */
    function view() {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (!pick || list[i].categoryId === pick) out.push(i);
      }
      return out;
    }

    var tierOpts = '<option value="">Every tier · ' + list.length + ' products</option>' +
      (catCategories || []).slice().map(function (c) {
        return { id: c.id, label: catPathLabel(c.id), n: list.filter(function (p) { return p.categoryId === c.id; }).length };
      }).filter(function (o) { return o.n > 0; })
        .sort(function (a, b) { return a.label.localeCompare(b.label); })
        .map(function (o) { return '<option value="' + o.id + '">' + esc(o.label) + ' · ' + o.n + '</option>'; }).join('');

    function rowsHtml() {
      var v = view();
      if (!v.length) return '<div class="muted" style="padding:16px;font-size:13px;">No products in this tier.</div>';
      return v.map(function (idx, n) {
        var p = list[idx];
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #f2f3ef;">' +
          '<span class="muted" style="width:26px;font-size:11.5px;text-align:right;">' + (n + 1) + '</span>' +
          '<code style="width:52px;font-size:11px;color:#8a8f85;text-align:right;font-variant-numeric:tabular-nums;">' + (Number(p.sortOrder) || 0) + '</code>' +
          '<div style="flex:1;font-size:13px;">' + esc(p.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(p.sku) + '</code>' +
            (pick ? '' : '<div class="muted" style="font-size:11px;line-height:1.4;">' + esc(p.categoryName || '') + '</div>') + '</div>' +
          '<button type="button" class="prUp" data-n="' + n + '"' + (n === 0 ? ' disabled' : '') + ' style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▲</button>' +
          '<button type="button" class="prDown" data-n="' + n + '"' + (n === v.length - 1 ? ' disabled' : '') + ' style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▼</button>' +
        '</div>';
      }).join('');
    }

    openModal('Sort order within a tier',
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">This is the order parts are offered and printed in. A part picked in the proposal builder is filed into its tier at this position, so the order here is the order a proposal comes out in. Pick a tier to see just that group.</div>' +
      '<select id="prTier" style="' + IN + 'margin-bottom:10px;">' + tierOpts + '</select>' +
      '<div id="prList" style="border:1px solid #e7e8e3;border-radius:10px;max-height:380px;overflow:auto;"></div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:8px;">The middle column is the stored order number. Saving writes the whole list back in the order shown, so parts outside the tier on screen keep their place.</div>',
      async function (close, showErr) {
        var r = await authed('/catalog/products/reorder', { method: 'POST', body: { ids: list.map(function (p) { return p.id; }) } });
        if (!r.ok) return showErr('Could not save the order (' + r.status + ').');
        close(); loadProducts(user);
      }, 'Save order');

    function swap(a, b) { var t = list[a]; list[a] = list[b]; list[b] = t; }

    function repaint() {
      var host = document.getElementById('prList'); if (!host) return;
      host.innerHTML = rowsHtml();
      host.querySelectorAll('.prUp').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = view(), n = Number(b.getAttribute('data-n'));
          if (n > 0) { swap(v[n - 1], v[n]); repaint(); }
        });
      });
      host.querySelectorAll('.prDown').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = view(), n = Number(b.getAttribute('data-n'));
          if (n < v.length - 1) { swap(v[n], v[n + 1]); repaint(); }
        });
      });
    }

    setTimeout(function () {
      var sel = document.getElementById('prTier');
      if (sel) sel.addEventListener('change', function () { pick = sel.value; repaint(); });
      repaint();
    }, 50);
  }

  /* --- Product-tree workbook: export and import, the same shape both ways ---
   * SpreadsheetML (.xls) so one file can carry a sheet per level and Excel opens
   * it natively; the importer reads exactly what the exporter writes. */
  var TREE_SHEETS = [
    { name: 'Categories', key: 'categories', cols: ['slug', 'name', 'parentSlug', 'tierLevel', 'sortOrder', 'isActive'] },
    { name: 'Products', key: 'products', cols: ['sku', 'name', 'categorySlug', 'kind', 'status', 'sortOrder', 'proposalDescription'] },
    { name: 'Bundles', key: 'bundles', cols: ['bundleSku', 'bundleName', 'componentSku', 'componentName', 'quantity'] }
  ];
  function xmlEsc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function treeWorkbookXml(data) {
    var sheets = TREE_SHEETS.map(function (sh) {
      var rows = (data[sh.key] || []).map(function (r) {
        return '<Row>' + sh.cols.map(function (c) {
          var v = r[c];
          var num = typeof v === 'number';
          return '<Cell><Data ss:Type="' + (num ? 'Number' : 'String') + '">' + xmlEsc(num ? v : (v === true ? 'true' : v === false ? 'false' : v)) + '</Data></Cell>';
        }).join('') + '</Row>';
      }).join('');
      return '<Worksheet ss:Name="' + xmlEsc(sh.name) + '"><Table>' +
        '<Row>' + sh.cols.map(function (c) { return '<Cell><Data ss:Type="String">' + c + '</Data></Cell>'; }).join('') + '</Row>' +
        rows + '</Table></Worksheet>';
    }).join('');
    return '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' + sheets + '</Workbook>';
  }
  function downloadText(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  /** Read a workbook this app wrote back into the same row shape. */
  function parseWorkbookXml(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    var out = {};
    var sheets = doc.getElementsByTagName('Worksheet');
    for (var i = 0; i < sheets.length; i++) {
      var name = sheets[i].getAttribute('ss:Name') || sheets[i].getAttribute('Name') || '';
      var def = TREE_SHEETS.filter(function (s) { return s.name.toLowerCase() === String(name).toLowerCase(); })[0];
      if (!def) continue;
      var rows = sheets[i].getElementsByTagName('Row'), headers = [], data = [];
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].getElementsByTagName('Cell'), vals = [];
        for (var c = 0; c < cells.length; c++) {
          var dd = cells[c].getElementsByTagName('Data')[0];
          vals.push(dd ? dd.textContent : '');
        }
        if (r === 0) { headers = vals.map(function (h) { return String(h).trim(); }); continue; }
        if (!vals.join('').trim()) continue;
        var o = {};
        headers.forEach(function (h, idx) { if (h) o[h] = (vals[idx] == null ? '' : String(vals[idx]).trim()); });
        data.push(o);
      }
      out[def.key] = data;
    }
    return out;
  }
  /** A blank cell means "no value given" on import, so drop it from the row. */
  /**
   * Street and suite on ONE line: "10488 Centennial Road, Suite 100".
   * They were separate rows, which printed a bare "100" under the street and read as
   * a truncated address. A suite that already names itself keeps its own wording.
   */
  function streetLine(l1, l2) {
    var x = (l1 || '').trim(), y = (l2 || '').trim();
    if (!y) return x;
    if (!x) return y;
    return x + ', ' + (/^(ste|suite|apt|apartment|unit|#|bldg|building|fl|floor|rm|room|dept|po box|p\.o\.)/i.test(y) ? y : 'Suite ' + y);
  }

  function pruneBlanks(rows, keep) {
    return (rows || []).map(function (r) {
      var o = {};
      Object.keys(r).forEach(function (k) {
        if (r[k] === '' && keep.indexOf(k) === -1) return;
        if (k === 'isActive') o[k] = String(r[k]).toLowerCase() === 'true';
        else o[k] = r[k];
      });
      return o;
    });
  }

  /** Duplicate sort orders in the live tree, with a one-click renumber. */
  async function openSortAudit(user) {
    var r = await authed('/catalog/tree/sort-audit');
    if (!r.ok) { alert('Could not audit sort order (' + r.status + ').'); return; }
    var d = await r.json();
    function block(title, list) {
      if (!list.length) return '';
      return '<div style="margin-bottom:14px;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:6px;">' + title + '</div>' +
        list.map(function (c) {
          return '<div style="border:1px solid #e7e8e3;border-radius:9px;padding:9px 11px;margin-bottom:6px;">' +
            '<div style="font-size:12.5px;color:#5c6157;">' + esc(c.scope) + ' · order <b>' + c.sortOrder + '</b></div>' +
            c.members.map(function (m) { return '<div style="font-size:13px;">' + esc(m.label) + '</div>'; }).join('') +
          '</div>';
        }).join('') + '</div>';
    }
    var body = d.clashCount === 0
      ? '<div class="muted" style="font-size:13.5px;">No duplicates — every sibling has a distinct sort order.</div>'
      : '<div style="font-size:13.5px;margin-bottom:12px;"><b>' + d.clashCount + '</b> collision' + (d.clashCount === 1 ? '' : 's') +
        ' across <b>' + d.affected + '</b> rows. Ties break alphabetically, so these print in an arbitrary order.</div>' +
        block('Categories', d.categoryClashes) + block('Products', d.productClashes) +
        '<div class="muted" style="font-size:12px;">Renumber rewrites every sibling group to 10, 20, 30… keeping the order things are in now. Gaps of 10 leave room to slot one item in later by hand.</div>';
    openModal('Sort order', body, d.clashCount === 0 ? null : async function (close, showErr) {
      var r2 = await authed('/catalog/tree/renumber', { method: 'POST', body: {} });
      if (!r2.ok) return showErr('Could not renumber (' + r2.status + ').');
      var out = await r2.json();
      close();
      alert('Renumbered ' + out.categories + ' categor' + (out.categories === 1 ? 'y' : 'ies') + ' and ' + out.products + ' product' + (out.products === 1 ? '' : 's') + '.');
      refreshCatalogList(user);
    }, 'Renumber all');
  }

  /**
   * The category → product list as a flat CSV: one row per part, its full category
   * path spelled out, and the price and weight from the SKU master joined on part
   * number. This is the file to hand someone who wants to read or filter the
   * catalog — the workbook above is for round-tripping edits back in, and its
   * sheet-per-level shape makes it useless for a sort or a pivot.
   *
   * Category path is built from parentSlug, so a part four tiers down reads
   * "Adventure Series › Frames › Uprights › 3in" rather than a bare slug.
   *
   * Parts with no SKU-master row export with blank price and weight rather than a
   * zero — the tree and the pricing master are separate records and a real 0.00
   * must not be indistinguishable from "not priced yet".
   */
  async function exportCategoryProductList() {
    var r = await authed('/catalog/tree/export');
    if (!r.ok) { alert('Could not export the product list (' + r.status + ').'); return; }
    var d = await r.json();

    var bySlug = {};
    (d.categories || []).forEach(function (c) { bySlug[c.slug] = c; });
    function pathOf(slug) {
      var parts = [], seen = {}, cur = bySlug[slug];
      while (cur && !seen[cur.slug]) { seen[cur.slug] = 1; parts.unshift(cur.name || cur.slug); cur = cur.parentSlug ? bySlug[cur.parentSlug] : null; }
      return parts.join(' \u203a ');
    }

    // Price and weight live on the SKU master, not the tree. Joined here so one
    // file answers "what do we sell and what does it cost".
    var priced = {};
    var rs = await authed('/skus/export');
    if (rs.ok) {
      var sd = await rs.json();
      (sd.items || []).forEach(function (s) { priced[String(s.part).trim().toUpperCase()] = s; });
    }

    var cols = ['sku', 'name', 'categoryPath', 'categorySlug', 'kind', 'status', 'sortOrder', 'unitPrice', 'unitCost', 'weightLbs', 'proposalDescription'];
    var rows = [cols];
    (d.products || []).forEach(function (p) {
      var m = priced[String(p.sku || '').trim().toUpperCase()];
      rows.push([
        p.sku, p.name, pathOf(p.categorySlug), p.categorySlug, p.kind, p.status, p.sortOrder,
        m ? m.unitPrice : '', m ? m.unitCost : '', m ? m.weightLbs : '',
        p.proposalDescription
      ]);
    });
    downloadCsv('catalog-product-list-' + todayISO() + '.csv', rows);
  }

  async function exportProductTree() {
    var r = await authed('/catalog/tree/export');
    if (!r.ok) { alert('Could not export the tree (' + r.status + ').'); return; }
    var data = await r.json();
    downloadText('product-tree-' + todayISO() + '.xls', treeWorkbookXml(data), 'application/vnd.ms-excel');
  }

  /**
   * Import a product-tree workbook. Always previewed first: the review step says
   * what will be created and changed, and lists the parts the file leaves out so
   * the operator decides whether to leave or deactivate them.
   */
  var treeImportConfirmed = false;
  function openTreeImport(user) {
    treeImportConfirmed = false;
    openModal('Import product tree',
      '<div class="muted" style="font-size:13px;line-height:1.55;margin-bottom:10px;">Use a workbook exported from this screen — sheets <b>Categories</b>, <b>Products</b> and <b>Bundles</b>. Only the columns present in the file are written; anything you leave out stays exactly as it is. Nothing is ever deleted.</div>' +
      '<input type="file" id="tiFile" accept=".xls,.xml" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">' +
      '<div id="tiReview" style="margin-top:12px;"></div>',
      async function (close, showErr) {
        var fi = document.getElementById('tiFile').files[0];
        if (!fi) return showErr('Choose a workbook first.');
        var text = await fi.text();
        var parsed = /<Workbook/i.test(text) ? parseWorkbookXml(text) : null;
        if (!parsed) return showErr('That file is not a workbook exported from this screen.');
        var missingSel = document.getElementById('tiMissing');
        var payload = {
          dryRun: !treeImportConfirmed,
          missingAction: missingSel ? missingSel.value : 'leave',
          categories: pruneBlanks(parsed.categories, ['name']),
          products: pruneBlanks(parsed.products, ['name']),
          bundles: (parsed.bundles || []).map(function (b) { return { bundleSku: b.bundleSku, componentSku: b.componentSku, quantity: Number(b.quantity) || 1 }; })
            .filter(function (b) { return b.bundleSku && b.componentSku; })
        };
        var r = await authed('/catalog/tree/import', { method: 'POST', body: payload });
        var d = null; try { d = await r.json(); } catch (e) {}
        if (!d) return showErr('Import failed (' + r.status + ').');
        if (d.issues && d.issues.length) {
          document.getElementById('tiReview').innerHTML =
            '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;max-height:200px;overflow:auto;">' +
            '<b>' + d.issues.length + ' problem(s) — nothing was written:</b><ul style="margin:6px 0 0;padding-left:18px;line-height:1.5;">' +
            d.issues.slice(0, 40).map(function (i) { return '<li>' + esc(i.sheet + ' · ' + i.key + ': ' + i.message) + '</li>'; }).join('') + '</ul></div>';
          treeImportConfirmed = false;
          return showErr('Fix the problems listed and try again.');
        }
        if (!treeImportConfirmed) {
          var p = d.plan || {};
          document.getElementById('tiReview').innerHTML =
            '<div style="background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;">' +
              '<b>Ready to import</b><br>Categories: ' + (p.categories ? p.categories.create + ' new, ' + p.categories.update + ' updated' : '—') +
              '<br>Products: ' + (p.products ? p.products.create + ' new, ' + p.products.update + ' updated' : '—') +
              '<br>Bundle links: ' + ((p.bundles && p.bundles.links) || 0) +
            '</div>' +
            ((p.missing && p.missing.length)
              ? '<div style="margin-top:10px;background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#7a6320;line-height:1.55;">' +
                  '<b>' + p.missing.length + ' catalog part(s) are not in this file.</b>' +
                  '<div style="max-height:120px;overflow:auto;margin:6px 0;">' + p.missing.slice(0, 60).map(function (mm) { return esc(mm.sku + ' — ' + mm.name); }).join('<br>') + '</div>' +
                  '<label style="display:block;margin-top:6px;">What should happen to them? ' +
                    '<select id="tiMissing" style="padding:6px 8px;border:1px solid #dcded7;border-radius:6px;font-size:12.5px;background:#fff;">' +
                      '<option value="leave">Leave them exactly as they are</option>' +
                      '<option value="deactivate">Deactivate them</option>' +
                    '</select></label></div>'
              : '') +
            '<div class="muted" style="font-size:12px;margin-top:8px;">Press Import again to commit.</div>';
          treeImportConfirmed = true;
          return showErr('Review the summary above, then press Import to commit.');
        }
        treeImportConfirmed = false;
        close();
        var res = d.result || {};
        alert('Import complete: ' + (res.created || 0) + ' created, ' + (res.updated || 0) + ' updated, ' + (res.links || 0) + ' bundle link(s)' +
          (res.deactivated ? ', ' + res.deactivated + ' deactivated' : '') + '.');
        loadProducts(user);
      }, 'Import');
  }

  /* --- shared table helpers --- */
  function tableShell(head, rows, cols, empty) {
    return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:left;padding:11px 16px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #eef0ea;background:#f7f8f4;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="' + cols + '">' + esc(empty || 'No records.') + '</td></tr>') + '</tbody></table></div>';
  }
  function sectionBlock(title, inner) { return '<div class="section-title">' + esc(title) + '</div>' + inner; }

  /* --- Proposals --- */
  var OPEN_STATUSES = ['DRAFT', 'INTERNAL_REVIEW', 'RELEASED'];
  var props = {
    rows: [], sort: { key: 'modified', dir: 'desc' },
    // Grouped and filtered to Active out of the box: the open work is what someone
    // opens this page to see, and the twenty-row flat list buries it. Both are
    // remembered per browser once changed, so a preference sticks.
    filter: localStorage.getItem('ssg.props.filter') || 'active',
    q: '',
    grouped: localStorage.getItem('ssg.props.grouped') !== '0',
    collapsed: (function () {
      try { return JSON.parse(localStorage.getItem('ssg.props.collapsed') || '[]'); } catch (e) { return []; }
    })(),
  };
  function propsPersist() {
    localStorage.setItem('ssg.props.grouped', props.grouped ? '1' : '0');
    localStorage.setItem('ssg.props.filter', props.filter);
    localStorage.setItem('ssg.props.collapsed', JSON.stringify(props.collapsed));
  }
  var PROP_FILTERS = [
    { id: 'all', label: 'All' },
    // One page carrying the whole live pipeline: proposals still inside their
    // expiration window on top, the ones that have run past it underneath. Both bands
    // are open proposals — the lower one is the work, not an archive.
    { id: 'both', label: 'Active & past expiration' },
    { id: 'active', label: 'Active' },
    { id: 'expired', label: 'Past expiration' },
    { id: 'inactive', label: 'Inactive' },
    // Accepted and Deal Closed partition the won work rather than overlapping: a deal
    // leaves Accepted the moment its invoice exists in QuickBooks, so Accepted reads as
    // "won, still to bill" — which is the list somebody actually acts on.
    { id: 'won', label: 'Accepted' },
    { id: 'closed', label: 'Deal Closed' },
    { id: 'lost', label: 'Rejected' },
    // Withdrawn proposals. Out of every other tab and out of the win rate, kept in full.
    { id: 'archived', label: 'Archived' },
  ];
  function today0() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dayDiff(v) { if (!v) return null; var d = new Date(v); if (isNaN(d)) return null; d.setHours(0, 0, 0, 0); return Math.round((d.getTime() - today0()) / 86400000); }
  function metaOfVersion(v) { var secs = (v && v.sections) || []; var m = (Array.isArray(secs) ? secs : []).filter(function (s) { return s && s.id === 'meta'; })[0]; return (m && m.data) || {}; }

  async function renderProposals(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
        '<div id="propFilters" style="display:flex;gap:6px;flex-wrap:wrap;"></div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;color:#5c6157;cursor:pointer;white-space:nowrap;" title="One collapsible block per customer, with its open value">' +
            '<input type="checkbox" id="propGroup"' + (props.grouped ? ' checked' : '') + '> Group by customer</label>' +
          '<input id="propSearch" placeholder="Search customer, title, number…" value="' + esc(props.q) + '" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13.5px;background:#fff;width:240px;">' +
          (hasRole(PROP_WRITE, user.role) ? '<button class="btn" id="propNew" style="width:auto;padding:10px 17px;white-space:nowrap;">New proposal</button>' : '') +
        '</div></div>' +
      '<div id="propList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    drawPropFilters(user);
    if (hasRole(PROP_WRITE, user.role)) document.getElementById('propNew').addEventListener('click', function () { openProposalForm(user); });
    var s = document.getElementById('propSearch');
    s.addEventListener('input', function () { props.q = s.value; drawProposals(user); });
    document.getElementById('propGroup').addEventListener('change', function () {
      props.grouped = this.checked; propsPersist(); drawProposals(user);
    });
    loadProposals(user);
  }
  function drawPropFilters(user) {
    var box = document.getElementById('propFilters'); if (!box) return;
    box.innerHTML = PROP_FILTERS.map(function (f) {
      var on = props.filter === f.id;
      var count = props.rows.filter(function (r) { return matchFilter(r, f.id); }).length;
      return '<button data-f="' + f.id + '" style="border:1px solid ' + (on ? '#3d4a55' : '#dcded7') + ';background:' + (on ? '#3d4a55' : '#fff') + ';color:' + (on ? '#fff' : '#3d4a55') + ';border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;">' + esc(f.label) +
        (props.rows.length ? ' <span style="opacity:.65;">' + count + '</span>' : '') + '</button>';
    }).join('');
    box.querySelectorAll('[data-f]').forEach(function (b) {
      b.addEventListener('click', function () { props.filter = b.getAttribute('data-f'); propsPersist(); drawPropFilters(user); drawProposals(user); });
    });
  }
  function matchFilter(r, f) {
    // Archived is a separate world: its own tab, and absent from every other one,
    // including All. Nothing is deleted — this is the only view that shows them.
    if (f === 'archived') return !!r.archivedAt;
    if (r.archivedAt) return false;
    if (f === 'all') return true;
    // Every open proposal, in or out of date. `expired` is only ever set on an open
    // status, so this one test covers both bands the view then splits them into.
    if (f === 'both') return OPEN_STATUSES.indexOf(r.status) !== -1;
    if (f === 'active') return OPEN_STATUSES.indexOf(r.status) !== -1 && !r.expired;
    if (f === 'expired') return r.expired;
    if (f === 'inactive') return r.status === 'EXPIRED';
    if (f === 'won') return r.status === 'ACCEPTED' && !r.invoiced;
    if (f === 'closed') return r.status === 'ACCEPTED' && !!r.invoiced;
    if (f === 'lost') return r.status === 'REJECTED';
    return true;
  }
  async function loadProposals(user) {
    var box = document.getElementById('propList'); if (!box) return;
    try {
      var r = await authed('/proposals'); if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var list = await r.json();
      props.rows = (list || []).map(function (p) {
        var v = (p.versions && p.versions[0]) || {};
        var meta = metaOfVersion(v);
        var exp = p.expirationDate || meta.expiration || '';
        var st = v.status || 'DRAFT';
        var dd = dayDiff(exp);
        return {
          id: p.id, vid: v.id, customer: p.organizationName || '—', contact: meta.contactName || '',
          title: p.title || '', number: p.number || '', version: v.version || p.currentVersion || 1,
          versionCount: p.versionCount || 1, status: st, preparedBy: p.preparedBy || '',
          created: p.createdAt, modified: p.lastModifiedAt || p.updatedAt, expires: exp, expDays: dd,
          expired: dd != null && dd < 0 && OPEN_STATUSES.indexOf(st) !== -1,
          organizationId: p.organizationId || '',
          releasedAt: v.releasedAt || null,
          // The same figure the Versions table and the customer document show. The
          // latest version is already on the wire with its sections and items, so this
          // costs no extra request per row.
          totalMinor: versionTotalMinor(v),
          createdById: p.createdById || '',
          archivedAt: p.archivedAt || null, archiveReason: p.archiveReason || '',
          archivedBy: p.archivedBy || '',
          // Deal Closed comes off the invoice existing in QuickBooks, not off a status
          // anyone sets by hand — the two can never disagree.
          invoiced: !!p.invoiced, invoiceDocNumber: p.invoiceDocNumber || '', invoicedAt: p.invoicedAt || null,
        };
      });
      drawPropFilters(user);
      drawProposals(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  /**
   * Seven narrow columns that add up to less than the content width, so the list no
   * longer scrolls sideways.
   *
   * Two columns were folded away to pay for the one that was missing. Created rides
   * under Last modified — the date people actually sort on — and the version rides
   * under the proposal number, where it reads as "v2 of 2" without needing a heading
   * of its own. The space both freed went to Total. Sorting by version went with the
   * column; nobody sorts a pipeline by version number.
   */
  var PROP_COLS = [
    { key: 'customer', label: 'Customer' },
    { key: 'title', label: 'Proposal' },
    { key: 'status', label: 'Status' },
    { key: 'totalMinor', label: 'Total', align: 'right' },
    { key: 'modified', label: 'Modified' },
    { key: 'expires', label: 'Expires' },
    { key: '', label: '' },
  ];
  function ptd(v, align, extra) { return '<td style="padding:10px 11px;border-bottom:1px solid #f2f3ef;white-space:nowrap;text-align:' + (align || 'left') + ';' + (extra || '') + '">' + v + '</td>'; }
  /** Customer and proposal names wrap rather than forcing the table wider. */
  function ptdWrap(v, extra) { return '<td style="padding:10px 11px;border-bottom:1px solid #f2f3ef;white-space:normal;overflow-wrap:anywhere;' + (extra || '') + '">' + v + '</td>'; }
  function drawProposals(user) {
    var box = document.getElementById('propList'); if (!box) return;
    var q = props.q.trim().toLowerCase();
    var rows = props.rows.filter(function (r) { return matchFilter(r, props.filter); })
      .filter(function (r) { return !q || (r.customer + ' ' + r.contact + ' ' + r.title + ' ' + r.number + ' ' + r.preparedBy).toLowerCase().indexOf(q) !== -1; });
    var sk = props.sort.key, dir = props.sort.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var x = a[sk], y = b[sk];
      if (sk === 'created' || sk === 'modified' || sk === 'expires') { x = x ? new Date(x).getTime() : 0; y = y ? new Date(y).getTime() : 0; }
      if (typeof x === 'string' || typeof y === 'string') { x = String(x || '').toLowerCase(); y = String(y || '').toLowerCase(); }
      return x < y ? -dir : x > y ? dir : 0;
    });
    var head = PROP_COLS.map(function (c) {
      var on = c.key && props.sort.key === c.key;
      var arrow = on ? (props.sort.dir === 'asc' ? ' ▲' : ' ▼') : (c.key ? ' <span style="opacity:.3;">↕</span>' : '');
      return '<th' + (c.key ? ' data-sk="' + c.key + '" style="cursor:pointer;' : ' style="') +
        'text-align:' + (c.align || 'left') + ';padding:11px 14px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:' + (on ? '#3d4a55' : '#8a8f85') + ';font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;">' + esc(c.label) + arrow + '</th>';
    }).join('');
    function rowHtml(r) {
      var expCell = r.expires
        ? (r.expired
          ? '<span style="display:inline-flex;align-items:center;gap:5px;background:#fbe9e6;border:1px solid #f0cdc7;color:#9c3327;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:600;" title="Expired ' + Math.abs(r.expDays) + ' day(s) ago">⚑ ' + fmtDate(r.expires) + '</span>'
          : (r.expDays != null && r.expDays <= 7 && OPEN_STATUSES.indexOf(r.status) !== -1
            ? '<span style="display:inline-flex;align-items:center;gap:5px;background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:600;" title="Expires in ' + r.expDays + ' day(s)">' + fmtDate(r.expires) + '</span>'
            : fmtDate(r.expires)))
        : '<span class="muted">—</span>';
      var acts = r.archivedAt ? [] : quickActions(r, user);
      var quick = acts.length
        ? '<select class="pQuick" data-id="' + r.id + '" data-vid="' + r.vid + '" style="padding:6px 8px;border:1px solid #dcded7;border-radius:8px;font-size:12px;background:#fff;color:#3d4a55;max-width:170px;">' +
          '<option value="">Quick status…</option>' + acts.map(function (a) { return '<option value="' + a[0] + '">' + esc(a[1]) + '</option>'; }).join('') + '</select>'
        : '';
      // A shelved proposal gets one extra action: ask whether it is still live. It
      // sits beside the status picker rather than inside it because it sends nothing
      // on its own — it opens a draft for the rep to read and send.
      var reengage = r.status === 'EXPIRED' && !r.archivedAt
        ? '<button class="pReengage" data-id="' + r.id + '" title="Draft an email asking whether they are still interested" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 9px;font-size:12px;color:#3d4a55;cursor:pointer;white-space:nowrap;">Still interested?</button>'
        : '';
      // Archive is deliberately quiet — a small text button, not a red one. It withdraws
      // a proposal from the pipeline and can be undone from the Archived tab.
      var arch = canArchive(r, user)
        ? (r.archivedAt
          ? '<button class="pRestore" data-id="' + r.id + '" title="Put this proposal back in the pipeline" style="border:1px solid #cfe3d7;background:#eaf3ee;border-radius:8px;padding:6px 9px;font-size:12px;color:#2f7d5d;cursor:pointer;white-space:nowrap;">Restore</button>'
          : '<button class="pArchive" data-id="' + r.id + '" title="Withdraw from the pipeline. Nothing is deleted and it can be restored." style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 9px;font-size:12px;color:#8a8f85;cursor:pointer;white-space:nowrap;">Archive</button>')
        : '';
      return '<tr style="cursor:pointer;" data-id="' + r.id + '">' +
        ptdWrap('<b style="font-weight:600;">' + esc(r.customer) + '</b>' + (r.contact ? '<div class="muted" style="font-size:12px;">' + esc(r.contact) + '</div>' : '')) +
        ptdWrap('<b style="font-weight:600;">' + esc(r.title) + '</b><div class="muted" style="font-size:12px;">' + esc(r.number) +
          ' · v' + r.version + (r.versionCount > 1 ? ' of ' + r.versionCount : '') +
          (r.preparedBy ? ' · ' + esc(r.preparedBy) : '') + '</div>' +
          (r.archivedAt
            ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">Archived ' + esc(fmtDate(r.archivedAt)) +
              (r.archivedBy ? ' by ' + esc(r.archivedBy) : '') +
              (r.archiveReason ? ' — ' + esc(r.archiveReason) : '') + '</div>'
            : '')) +
        ptd(statusChip(r.status) +
          (r.invoiced && r.status === 'ACCEPTED'
            ? '<div style="margin-top:4px;font-size:11.5px;color:#2f7d5d;">Invoiced' + (r.invoiceDocNumber ? ' · ' + esc(r.invoiceDocNumber) : '') + '</div>'
            : '') +
          (r.archivedAt
            ? '<div style="margin-top:4px;"><span style="display:inline-block;background:#f2f3ef;border:1px dashed #cbcec5;color:#8a8f85;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:600;">Archived</span></div>'
            : '')) +
        ptd('<b style="font-weight:600;">' + fmtMoney(r.totalMinor, 'USD') + '</b>', 'right') +
        ptd(fmtDate(r.modified) + '<div class="muted" style="font-size:11px;">made ' + esc(fmtDate(r.created)) + '</div>') +
        ptd(expCell) +
        ptd('<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">' + reengage + quick + arch + '</div>', 'right', 'padding:8px 11px;') + '</tr>';
    }
    var body = rows.map(rowHtml).join('');

    /** A full-width banner row introducing a block of rows, with that block's total. */
    function bandRow(label, list, tone) {
      var sum = list.reduce(function (n, r) { return n + (Number(r.totalMinor) || 0); }, 0);
      return '<tr><td colspan="7" style="padding:12px 11px 9px;border-bottom:1px solid #e7e8e3;background:' + tone + ';">' +
        '<b style="font-weight:650;font-size:13px;letter-spacing:.02em;">' + esc(label) + '</b>' +
        '<span class="muted" style="font-size:12.5px;margin-left:9px;">' + list.length + ' proposal' + (list.length === 1 ? '' : 's') +
        (sum ? ' · ' + fmtMoney(sum, 'USD') : '') + '</span></td></tr>';
    }

    // The combined view is one page in two bands: still inside the expiration window,
    // then past it. Grouping by customer is suppressed here — two nestings deep (band,
    // then customer) stops being a list anyone can scan.
    var banded = props.filter === 'both' && rows.length;
    if (banded) {
      var liveRows = rows.filter(function (r) { return !r.expired; });
      var lateRows = rows.filter(function (r) { return r.expired; });
      body =
        (liveRows.length ? bandRow('Active', liveRows, '#f1f6f2') + liveRows.map(rowHtml).join('') : '') +
        (lateRows.length ? bandRow('Past expiration', lateRows, '#fdf1ef') + lateRows.map(rowHtml).join('') : '');
    }
    // Grouped view: one collapsible header per customer, carrying the count and the
    // open value — the two numbers you actually want when scanning an account.
    if (!banded && props.grouped && rows.length) {
      var order = [], byCust = {};
      rows.forEach(function (r) {
        if (!byCust[r.customer]) { byCust[r.customer] = []; order.push(r.customer); }
        byCust[r.customer].push(r);
      });
      order.sort(function (x, y) { return x.toLowerCase() < y.toLowerCase() ? -1 : 1; });
      body = order.map(function (cust) {
        var mine = byCust[cust];
        var open = mine.filter(function (r) { return OPEN_STATUSES.indexOf(r.status) !== -1 && !r.expired; }).length;
        var flagged = mine.filter(function (r) { return r.expired; }).length;
        var isOpen = props.collapsed.indexOf(cust) === -1;
        return '<tr class="pGroup" data-cust="' + esc(cust) + '" style="cursor:pointer;background:#f4f5f1;">' +
            '<td colspan="7" style="padding:11px 14px;border-bottom:1px solid #e7e8e3;">' +
              '<span style="display:inline-block;width:14px;color:#8a8f85;">' + (isOpen ? '▾' : '▸') + '</span>' +
              '<b style="font-weight:650;font-size:13.5px;">' + esc(cust) + '</b>' +
              '<span class="muted" style="font-size:12.5px;margin-left:10px;">' + mine.length + ' proposal' + (mine.length === 1 ? '' : 's') +
                (open ? ' · ' + open + ' open' : '') + '</span>' +
              (flagged ? '<span style="margin-left:10px;font-size:12px;color:#9c3327;">⚑ ' + flagged + ' expired</span>' : '') +
            '</td></tr>' +
          (isOpen ? mine.map(rowHtml).join('') : '');
      }).join('');
    }

    // No min-width, and the two name columns wrap: the table sizes itself to the
    // window instead of demanding 1160px and scrolling sideways.
    var lead = props.filter === 'archived'
      ? '<div style="margin-bottom:10px;font-size:12.5px;color:#5c6157;background:#f4f5f1;border:1px solid #e7e8e3;border-radius:10px;padding:10px 13px;">Withdrawn proposals. They are kept in full and left out of every other tab and of the win rate. Restore puts one back exactly as it was — any QuickBooks documents were never touched.</div>'
      : props.filter === 'closed'
        ? '<div style="margin-bottom:10px;font-size:12.5px;color:#5c6157;background:#f1f6f2;border:1px solid #cfe3d7;border-radius:10px;padding:10px 13px;">Accepted and invoiced in QuickBooks. A deal lands here on its own the moment its invoice is created, and leaves the Accepted tab.</div>'
        : '';
    box.innerHTML = lead + '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:13.5px;table-layout:auto;"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td style="padding:22px 16px;color:#909689;" colspan="7">' + (props.rows.length ? (props.filter === 'archived' ? 'Nothing archived.' : props.filter === 'closed' ? 'No invoiced deals yet.' : 'No proposals match this view.') : 'No proposals yet.') + '</td></tr>') + '</tbody></table></div>' +
      (props.rows.filter(function (r) { return r.expired && !r.archivedAt; }).length ? '<div style="margin-top:10px;font-size:12.5px;color:#9c3327;">⚑ Flagged rows are past their expiration date and still open — re-date them or mark them no longer active.</div>' : '');
    box.querySelectorAll('th[data-sk]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sk');
        if (props.sort.key === k) props.sort.dir = props.sort.dir === 'asc' ? 'desc' : 'asc';
        else { props.sort.key = k; props.sort.dir = (k === 'created' || k === 'modified' || k === 'expires') ? 'desc' : 'asc'; }
        drawProposals(user);
      });
    });
    box.querySelectorAll('tr.pGroup').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var c = tr.getAttribute('data-cust'), i = props.collapsed.indexOf(c);
        if (i === -1) props.collapsed.push(c); else props.collapsed.splice(i, 1);
        propsPersist(); drawProposals(user);
      });
    });
    // Bound before the row handler and stopping propagation, so drafting an email
    // does not also navigate into the proposal.
    box.querySelectorAll('button.pReengage').forEach(function (bt) {
      bt.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = props.rows.filter(function (r) { return r.id === bt.getAttribute('data-id'); })[0];
        if (row) openCustomerEmail(row, user, 'reengage');
      });
    });
    box.querySelectorAll('button.pArchive').forEach(function (bt) {
      bt.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = props.rows.filter(function (r) { return r.id === bt.getAttribute('data-id'); })[0];
        if (row) archiveProposal(row, user);
      });
    });
    box.querySelectorAll('button.pRestore').forEach(function (bt) {
      bt.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = props.rows.filter(function (r) { return r.id === bt.getAttribute('data-id'); })[0];
        if (row) restoreProposal(row, user);
      });
    });
    box.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { openProposalDetail(tr.getAttribute('data-id'), user); }); });
    box.querySelectorAll('.pQuick').forEach(function (sel) {
      sel.addEventListener('click', function (e) { e.stopPropagation(); });
      sel.addEventListener('change', async function (e) {
        e.stopPropagation();
        var act = sel.value; if (!act) return;
        if (act === 'expire' && !confirm('Mark this proposal no longer active? It stays on record and can be revived as a new version.')) { sel.value = ''; return; }
        var id = sel.getAttribute('data-id'), vid = sel.getAttribute('data-vid');
        sel.disabled = true;
        var path = act === 'new-version' ? '/proposals/' + id + '/versions' : '/proposals/versions/' + vid + '/' + act;
        var rr = await authed(path, { method: 'POST', body: await actionBody(act, id, vid) });
        if (!rr.ok) { alert('Could not update (' + rr.status + ').'); sel.disabled = false; sel.value = ''; return; }
        await reportRelease(act, rr);
        loadProposals(user);
      });
    });
  }
  /**
   * Releasing also hands the deal board its copy of the proposal, and the proposal
   * layout only exists in the browser — so the rendered document travels with the
   * release call and the server turns it into the PDF monday receives.
   *
   * The document is kept aside as well: the upload runs as a second call against
   * the renderer function, which is the only one with the memory and the time for
   * a headless browser.
   */
  var lastReleaseDoc = null;
  async function actionBody(act, proposalId, versionId) {
    lastReleaseDoc = null;
    if (act !== 'release') return {};
    try {
      var doc = await buildProposalDocForSend({ id: proposalId }, versionId);
      if (doc) {
        lastReleaseDoc = { versionId: versionId, html: doc.html, filename: doc.filename };
        return { proposalHtml: doc.html, proposalFilename: doc.filename };
      }
    } catch (e) {}
    return {};
  }

  /** Say so when a release went through but the monday push did not. */
  async function reportRelease(act, rr) {
    if (act !== 'release') return;
    var d = null;
    try { d = await rr.json(); } catch (e) { return; }
    var m = d && d.monday;
    // Upload the document itself on the renderer function. Failing here costs the
    // attachment, not the release, so it is reported and never thrown.
    var fileNote = '';
    // The render can take the better part of a minute, so this notice often arrives
    // after the rep has moved on to another screen. It names the proposal and the
    // reason — an unattributed failure on an unrelated page reads as that page's bug.
    var who = (lastReleaseDoc && lastReleaseDoc.filename) || 'the proposal';
    if (lastReleaseDoc && m && m.pushed) {
      try {
        var fr = await authed('/render/proposals/versions/' + lastReleaseDoc.versionId + '/monday-file', {
          method: 'POST',
          body: { proposalHtml: lastReleaseDoc.html, filename: lastReleaseDoc.filename },
        });
        var fd = fr.ok ? await fr.json() : null;
        if (!fr.ok) fileNote = await serverMessage(fr, 'the renderer did not respond (' + fr.status + ')');
        else if (!fd || !fd.uploaded) fileNote = (fd && (fd.skipped || fd.error)) || 'monday did not accept the file';
      } catch (e) { fileNote = 'the renderer could not be reached'; }
    }
    lastReleaseDoc = null;
    if (m && m.pushed) {
      if (fileNote) alert('Released. The deal row was updated, but ' + who + ' did not attach: ' + fileNote + '.');
      return;
    }
    if (!m) return;
    alert('The proposal was released, but monday.com was not updated: ' +
      (m.skipped || m.error || 'the deal board did not respond') + '.');
  }

  /**
   * The proposal total for a stored version. Same order of operations as the customer
   * document (subtotal − discount + 3rd-party freight + tax + structure freight + mats
   * freight), so the figure in the Versions table is the figure on the proposal.
   */
  function versionTotalMinor(version) {
    var secs = (version && version.sections) || [];
    var metaSec = Array.isArray(secs) ? secs.filter(function (s) { return s && s.id === 'meta'; })[0] : null;
    var meta = (metaSec && metaSec.data) || {};
    var subtotal = 0, tpFreight = 0;
    ((version && version.items) || []).forEach(function (l) {
      if ((l.lineType || 'PRODUCT') !== 'PRODUCT') return;
      subtotal += (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
      tpFreight += Number(l.tpFreightMinor) || 0;
    });
    var discount = discountOf(meta, subtotal).amount;
    var structureFreight = metaAmount(meta.structureFreightMinor != null ? meta.structureFreightMinor : meta.freightMinor, meta.tbdStructureFreight);
    return subtotal - discount + tpFreight + metaAmount(meta.taxAmountMinor, meta.tbdTax) + structureFreight + metaAmount(meta.matsFreightMinor, meta.tbdMatsFreight) + stdFreightOf(meta);
  }

  /**
   * Withdraw a proposal from the pipeline.
   *
   * The reason is optional and goes on the record, so the Archived tab reads as a list of
   * decisions rather than a pile of numbers. Live QuickBooks documents get a second pass:
   * the server comes back needsConfirm with the documents it found, because archiving
   * here does not void anything over there.
   */
  async function archiveProposal(r, user, confirmWord) {
    var reason = confirmWord ? (r._pendingReason || '') : prompt(
      'Archive ' + (r.number || 'this proposal') + ' — ' + (r.customer || '') + '.' + '\n\n' +
      'It leaves every pipeline view and the win-rate figures, and stays on record under the' + '\n' +
      'Archived tab where it can be restored. Nothing is deleted.' + '\n\n' +
      'Reason (optional):', '');
    if (reason === null) return;
    r._pendingReason = reason;
    var rr = await authed('/proposals/' + r.id + '/archive', {
      method: 'POST',
      body: { reason: reason, confirm: confirmWord || '' },
    });
    if (!rr.ok) { alert('Could not archive (' + rr.status + ').'); return; }
    var d = null; try { d = await rr.json(); } catch (e) {}
    if (d && d.needsConfirm) {
      var list = (d.qboDocuments || []).map(function (t) {
        return '  • ' + t.type.replace(/_/g, ' ').toLowerCase() + ' ' + t.docNumber + ' — ' + fmtMoney(t.amountMinor, 'USD');
      }).join('\n');
      var typed = prompt(
        'This proposal has live QuickBooks documents:' + '\n\n' + list + '\n\n' +
        'Archiving here does NOT void them — they stay standing in QuickBooks and must be' + '\n' +
        'voided there separately. Type CONFIRM to archive anyway.', '');
      if (!typed) { r._pendingReason = null; return; }
      if (typed.trim().toUpperCase() !== 'CONFIRM') { alert('Not archived — CONFIRM was not typed.'); r._pendingReason = null; return; }
      return archiveProposal(r, user, 'CONFIRM');
    }
    r._pendingReason = null;
    loadProposals(user);
  }
  /** Restore. `after` lets the proposal page refresh itself instead of the list. */
  async function restoreProposal(r, user, after) {
    if (!confirm('Put ' + (r.number || 'this proposal') + ' back in the pipeline?')) return;
    var rr = await authed('/proposals/' + r.id + '/unarchive', { method: 'POST', body: {} });
    if (!rr.ok) { alert('Could not restore (' + rr.status + ').'); return; }
    if (after) after(); else loadProposals(user);
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
  /** Status changes reachable straight from the list, permission-gated. */
  function quickActions(r, user) {
    var a = [], w = hasRole(PROP_WRITE, user.role), rev = hasRole(PROP_REVIEW, user.role), rel = hasRole(PROP_RELEASE, user.role);
    if (r.status === 'DRAFT') {
      if (w) a.push(['submit-review', 'Submit for review']);
      if (rel) a.push(['release', 'Ready to Send to Customer']);
      if (w) a.push(['expire', 'Mark no longer active']);
    } else if (r.status === 'INTERNAL_REVIEW') {
      if (rev) a.push(['return-draft', 'Return to draft']);
      if (rel) a.push(['release', 'Ready to Send to Customer']);
      if (w) a.push(['expire', 'Mark no longer active']);
    } else if (r.status === 'RELEASED') {
      if (rev) { a.push(['accept', 'Proposal Signed']); a.push(['reject', 'Mark rejected']); a.push(['expire', 'Mark no longer active']); }
    } else if (w) {
      a.push(['new-version', 'Create new version']);
    }
    return a;
  }
  /**
   * Draft a customer email and hand it to the desktop mail client.
   *
   * Nothing is sent from the server: the composer builds a mailto: URL, so the
   * message opens in Outlook as a normal draft the rep reads, edits and sends from
   * their own mailbox. That keeps it out of Resend's transactional stream (which the
   * customer sees as machine mail) and means a reply lands in the rep's inbox.
   *
   * Because the send happens outside the app, the app cannot observe it. The log-it
   * checkbox writes a line to the customer's note log so the account history still
   * shows the outreach — that record is the rep's assertion, not a delivery receipt,
   * and the wording says so.
   *
   * `row` needs: id, organizationId, number, title, customer, totalMinor,
   * releasedAt, expires.
   */
  async function openCustomerEmail(row, user, kind) {
    var ctx = { contacts: [] };
    try {
      var rc = await authed('/proposals/' + row.id + '/send-context');
      if (rc.ok) ctx = await rc.json();
    } catch (e) {}
    var contacts = (ctx.contacts || []).filter(function (c) { return c.email; });
    var me = (user && (user.name || user.email)) || '';
    var money = fmtMoney(row.totalMinor, 'USD');
    var first = function (n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; };

    function defaults(toName) {
      if (kind === 'reengage') {
        return {
          subject: 'Still interested? ' + (row.title || row.number),
          body: 'Hi ' + first(toName) + ',\n\n' +
            'I am checking in on ' + (row.title || 'the proposal') + ' (' + row.number + '), ' + money + '.' +
            (row.releasedAt ? ' We sent it on ' + fmtDate(row.releasedAt) + '.' : '') + '\n\n' +
            'It is marked no longer active on our side' +
            (row.expires ? ', as it passed its ' + fmtDate(row.expires) + ' expiration date' : '') + '. ' +
            'If you are still considering it, reply and I will re-date it and confirm current pricing.\n\n' +
            'If the timing has changed or the project is on hold, let me know and I will close it out.\n\n' +
            'Thanks,\n' + me + '\nSummit Sensory Gym',
        };
      }
      return {
        subject: (row.title || row.number) + ' — Summit Sensory Gym',
        body: 'Hi ' + first(toName) + ',\n\n' +
          'Following up on ' + (row.title || 'your proposal') + ' (' + row.number + '), ' + money + '.\n\n' +
          '\n\nThanks,\n' + me + '\nSummit Sensory Gym',
      };
    }

    if (!contacts.length) {
      return openModal('Email ' + (row.customer || 'the customer'),
        '<div class="muted" style="font-size:13px;line-height:1.6;">No contact on this customer has an email address, so there is nobody to address this to. Add one under CRM → ' +
        esc(row.customer || 'the customer') + ' → Contacts, then come back.</div>', null, '', {});
    }

    var d0 = defaults(contacts[0].name);
    openModal(kind === 'reengage' ? 'Ask whether they are still interested' : 'Email ' + (row.customer || 'the customer'),
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">This opens a draft in your own mail client. Nothing is sent from this app — you read it, edit it and send it from your mailbox, so their reply comes back to you.</div>' +
      fieldRow('To', '<select id="ceTo" style="' + IN + '">' + contacts.map(function (c, i) {
        return '<option value="' + i + '">' + esc(c.name + ' <' + c.email + '>') + (c.isDecisionMaker ? ' — decision maker' : '') + '</option>';
      }).join('') + '</select>') +
      fieldRow('Subject', '<input id="ceSubj" style="' + IN + '" value="' + esc(d0.subject) + '">') +
      '<div class="field"><label>Message</label><textarea id="ceBody" rows="12" style="' + IN + 'resize:vertical;font-size:13.5px;line-height:1.55;">' + esc(d0.body) + '</textarea></div>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;line-height:1.5;">' +
        '<input type="checkbox" id="ceLog" checked style="margin-top:3px;">' +
        '<span>Add a line to this customer\u2019s note log recording that I sent this. <span class="muted">A note that you drafted and opened it — not proof of delivery.</span></span></label>',
      async function (close, showErr) {
        var i = Number(document.getElementById('ceTo').value) || 0;
        var to = contacts[i];
        if (!to) return showErr('Pick a recipient.');
        var subj = document.getElementById('ceSubj').value;
        var bodyTxt = document.getElementById('ceBody').value;
        if (!subj.trim()) return showErr('The subject is empty.');
        if (document.getElementById('ceLog').checked && row.organizationId) {
          try {
            await authed('/crm/organizations/' + row.organizationId + '/notes', {
              method: 'POST',
              body: {
                proposalId: row.id,
                body: 'Emailed ' + to.name + ' (' + to.email + ') from Outlook — subject: ' + subj.trim(),
              },
            });
          } catch (e) {}
        }
        // A real anchor click, not location.href: it survives being inside an iframe
        // and does not leave the app on a mailto: navigation if no handler is set.
        var a = document.createElement('a');
        a.href = 'mailto:' + encodeURIComponent(to.email) +
          '?subject=' + encodeURIComponent(subj) + '&body=' + encodeURIComponent(bodyTxt);
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); }, 0);
        close();
      }, 'Open in Outlook');

    // Re-greet the newly chosen recipient, but only where the rep has not typed over
    // the draft. Comparing against what was last generated is what makes that safe.
    var prevIdx = 0;
    var sel = document.getElementById('ceTo');
    if (sel) sel.addEventListener('change', function () {
      var i = Number(sel.value) || 0;
      if (i === prevIdx) return;
      var was = defaults(contacts[prevIdx].name), now = defaults(contacts[i].name);
      var ta = document.getElementById('ceBody'), su = document.getElementById('ceSubj');
      if (ta && ta.value === was.body) ta.value = now.body;
      if (su && su.value === was.subject) su.value = now.subject;
      prevIdx = i;
    });
  }

  /**
   * The ideal decision timeline and the follow-up date, editable from the proposal.
   *
   * All three live on the CUSTOMER record, not the proposal — one account has one
   * decision window, and a per-proposal copy would immediately disagree with itself
   * across versions. The panel says so, because editing something here that also
   * changes elsewhere should never be a surprise.
   *
   * The follow-up date defaults to seven days after the version was released. That
   * default is applied server-side at release time; this panel additionally SUGGESTS
   * it (marked as such, not saved) when a released proposal has no follow-up date
   * yet — an older one released before the rule existed, say.
   */
  function proposalTimelinePanel(p, latest) {
    var dates = p.customerDates || {};
    var suggested = '';
    if (!dates.followUpDate && latest && latest.releasedAt) {
      var d = new Date(latest.releasedAt);
      if (!isNaN(d)) { d.setDate(d.getDate() + 7); suggested = d.toISOString().slice(0, 10); }
    }
    var lbl = 'font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;margin-bottom:5px;';
    return '<div class="card">' +
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:14px;">Kept on <b style="color:#20241f;font-weight:600;">' + esc(p.organizationName || 'the customer') + '</b>, so every proposal for this account reads the same window. Changing it here changes it in CRM.</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;">' +
        '<div style="flex:1 1 150px;"><div style="' + lbl + '">Decision from</div><input type="date" id="ptFrom" value="' + esc(dates.decisionFrom || '') + '" style="' + IN + '"></div>' +
        '<div style="flex:1 1 150px;"><div style="' + lbl + '">Decision to</div><input type="date" id="ptTo" value="' + esc(dates.decisionTo || '') + '" style="' + IN + '"></div>' +
        '<div style="flex:1 1 150px;"><div style="' + lbl + '">Follow-up date</div><input type="date" id="ptFollow" value="' + esc(dates.followUpDate || suggested) + '" style="' + IN + (suggested ? 'border-color:#eadfbe;background:#fdfaf1;' : '') + '"></div>' +
        '<button class="btn" id="ptSave" style="width:auto;padding:10px 17px;">Save dates</button>' +
      '</div>' +
      '<div id="ptMsg" style="font-size:12.5px;margin-top:10px;line-height:1.55;" class="muted">' +
        (suggested
          ? 'Suggested: seven days after this version was released on ' + esc(fmtDate(latest.releasedAt)) + '. Not saved until you press Save dates.'
          : (latest && latest.releasedAt
              ? 'Released ' + esc(fmtDate(latest.releasedAt)) + '. New releases set this to seven days later automatically unless a later date is already booked.'
              : 'Once this version is released the follow-up date is set to seven days later automatically. Override it here at any time.')) +
      '</div></div>';
  }

  async function openProposalDetail(id, user) {
    var view = document.getElementById('view'); view.innerHTML = '<div class="muted" style="padding:24px;">Loading…</div>';
    var r = await authed('/proposals/' + id); if (!r.ok) { view.innerHTML = '<div class="err">Could not load proposal.</div>'; return; }
    var p = await r.json(); var versions = p.versions || []; var latest = versions[versions.length - 1] || {};
    // If this version is already locked into an operational order, offer the unlock
    // path instead of a second lock.
    var lockedOrder = null;
    if (latest.id && latest.status === 'ACCEPTED') {
      try { var ro = await authed('/orders/by-version/' + latest.id); if (ro.ok) lockedOrder = await ro.json(); } catch (e) {}
    }
    // The accepted version is what QuickBooks can be pointed at; there is at most one.
    var acceptedVersion = versions.filter(function (v) { return v.status === 'ACCEPTED'; })[0] || null;
    var actions = proposalActions(latest, user, lockedOrder);
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;"><button class="link-btn" id="propBack" style="width:auto;padding:7px 13px;">‹ Back to proposals</button>' +
        // Archived is a property of the proposal, not a status, so it is said here rather
        // than swapped into the status chip — the version statuses below are still true.
        (p.archivedAt && canArchive({ createdById: p.createdById }, user)
          ? '<button class="link-btn" id="propRestore" style="width:auto;padding:7px 13px;">Restore to pipeline</button>'
          : '') +
      '</div>' +
      (p.archivedAt
        ? '<div style="margin-bottom:16px;background:#f4f5f1;border:1px solid #cbcec5;border-radius:12px;padding:13px 15px;font-size:13px;color:#5c6157;">' +
          '<b style="font-weight:650;">Archived</b> ' + esc(fmtDate(p.archivedAt)) +
          (p.archiveReason ? ' · ' + esc(p.archiveReason) : '') +
          '<div class="muted" style="font-size:12px;margin-top:4px;">Out of the pipeline and out of the win-rate figures. Everything on this page is intact, including any QuickBooks documents.</div></div>'
        : '') +
      // The customer leads the card. Opening a proposal and having to infer whose it
      // was from the title was the single most common complaint about this page.
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;"><div>' +
        '<h2 style="font-size:23px;">' + esc(p.organizationName || 'Customer not found') + '</h2>' +
        '<div style="font-size:15px;font-weight:600;margin-top:4px;">' + esc(p.title || '') + '</div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:3px;">' + esc(p.number || '') +
          (latest.releasedAt ? ' · released ' + esc(fmtDate(latest.releasedAt)) : '') + '</div>' +
      '</div><div style="text-align:right;"><span class="chip">' + titleCase(latest.status || 'DRAFT') + '</span>' +
        '<div style="font-size:19px;font-weight:600;margin-top:8px;">' + fmtMoney(versionTotalMinor(latest), 'USD') + '</div>' +
      '</div></div></div>' +
      sectionBlock('Versions', tableShell(['Version', 'Status', 'Created', 'Frozen', 'Total', ''], versions.map(function (v) {
        // A frozen version is the record of what went out — it opens read-only.
        var editable = !v.frozen && v.status === 'DRAFT' && hasRole(PROP_WRITE, user.role);
        var action = editable
          ? '<button class="btn" data-open="edit" data-vid="' + v.id + '" style="width:auto;padding:8px 15px;">Build / edit proposal</button>'
          : '<button class="link-btn" data-open="view" data-vid="' + v.id + '" style="width:auto;padding:8px 15px;">View (read only)</button>';
        var freightBtn = '<button class="link-btn" data-open="freight" data-vid="' + v.id + '" style="width:auto;padding:8px 13px;">Freight</button>';
        // A draft raised and then thought better of can be thrown away, provided it
        // is not the only version. Released versions never can be — they are the
        // record of what the customer was sent.
        var discardBtn = (editable && versions.length > 1)
          ? '<button class="link-btn" data-discard="' + v.id + '" data-v="' + v.version + '" style="width:auto;padding:8px 13px;color:#9c3327;">Discard draft</button>'
          : '';
        return '<tr>' + td('v' + v.version) + td('<span class="chip">' + titleCase(v.status) + '</span>') + td(fmtDate(v.createdAt)) + td(v.frozen ? 'Yes' : 'No') + td('<b style="font-weight:600;">' + fmtMoney(versionTotalMinor(v), 'USD') + '</b>') + td('<div style="display:flex;justify-content:flex-end;gap:8px;">' + freightBtn + discardBtn + action + '</div>') + '</tr>';
      }).join(''), 6, '')) +
      (hasRole(PROP_WRITE, user.role)
        ? sectionBlock('Send to the customer',
          '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
            '<button class="btn" id="propSendDocs" style="width:auto;padding:10px 17px;">Send documents…</button>' +
            '<button class="link-btn" id="propEmail" style="width:auto;padding:10px 17px;">Write an email…</button>' +
            '<div class="muted" style="font-size:12.5px;max-width:520px;line-height:1.55;">Send documents attaches the proposal or the financing sheet and records the send. Write an email opens a plain draft in Outlook for anything else.</div>' +
          '</div>')
        : '') +
      sectionBlock('Ideal decision timeline', proposalTimelinePanel(p, latest)) +
      // QuickBooks, on the proposal, once a version has been accepted. Same three-step
      // panel the order page shows and the same endpoints behind it — the order still
      // owns the record, this is only a second door to it, so accounting does not have
      // to leave the proposal they are looking at.
      (acceptedVersion && hasRole(QBO_VIEW_ROLES, user.role)
        ? sectionBlock('QuickBooks', '<div id="qboBox"><div class="muted" style="padding:16px;">Loading…</div></div>')
        : '') +
      sectionBlock('Financing options', '<div id="finBox"><div class="muted" style="padding:16px;">Loading…</div></div>') +
      (actions ? sectionBlock('Next Steps', '<div style="display:flex;gap:8px;flex-wrap:wrap;" id="propActions">' + actions + '</div>') : '');
    document.getElementById('propBack').addEventListener('click', function () { renderProposals(user); });
    var prst = document.getElementById('propRestore');
    if (prst) prst.addEventListener('click', async function () {
      await restoreProposal({ id: p.id, number: p.number || '' }, user, function () {
        openProposalDetail(p.id, user);
      });
    });
    var psd = document.getElementById('propSendDocs');
    if (psd) psd.addEventListener('click', function () { openSendDocuments(p, finCache, 'customer'); });
    var pem = document.getElementById('propEmail');
    if (pem) pem.addEventListener('click', function () {
      openCustomerEmail({
        id: p.id, organizationId: p.organizationId, number: p.number || '', title: p.title || '',
        customer: p.organizationName || '', totalMinor: versionTotalMinor(latest),
        releasedAt: latest.releasedAt || null, expires: latest.expirationDate || null,
      }, user, 'general');
    });

    var ptSave = document.getElementById('ptSave');
    if (ptSave) ptSave.addEventListener('click', async function () {
      var msg = document.getElementById('ptMsg');
      ptSave.disabled = true;
      var r = await authed('/crm/organizations/' + p.organizationId + '/dates', {
        method: 'PATCH',
        body: {
          decisionFrom: document.getElementById('ptFrom').value,
          decisionTo: document.getElementById('ptTo').value,
          followUpDate: document.getElementById('ptFollow').value,
        },
      });
      ptSave.disabled = false;
      if (!r.ok) {
        var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {}
        if (msg) { msg.style.color = '#9c3327'; msg.textContent = m || ('Could not save (' + r.status + ').'); }
        return;
      }
      p.customerDates = await r.json();
      if (msg) { msg.style.color = '#2f7d5d'; msg.textContent = 'Saved to ' + (p.organizationName || 'the customer') + '.'; }
    });

    // loadQbo was written against an operational order. Everything it reads is on the
    // proposal too, so it is handed the same five fields rather than duplicated.
    if (acceptedVersion && hasRole(QBO_VIEW_ROLES, user.role)) {
      loadQbo({
        proposalId: p.id,
        proposalVersionId: acceptedVersion.id,
        organizationId: p.organizationId,
        number: p.number || '',
        status: 'ACCEPTED',
      }, user);
    }
    loadFinancing(p, user);
    document.querySelectorAll('[data-open]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        var v = versions.filter(function (x) { return x.id === bt.getAttribute('data-vid'); })[0];
        if (!v) return;
        var how = bt.getAttribute('data-open');
        if (how === 'edit') openBuilder(p, v, user);
        else if (how === 'freight') openFreightReview(p.id, user, v.id);
        else previewProposal(p, v);
      });
    });
    document.querySelectorAll('[data-discard]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var vid = bt.getAttribute('data-discard'), vn = bt.getAttribute('data-v');
        // Names the version and says plainly that it does not come back. There is no
        // undo behind this and a proposal list is not the place to discover that.
        if (!confirm('Discard draft v' + vn + '?\n\nIts lines and pricing are deleted and cannot be recovered. The earlier versions are untouched.')) return;
        bt.disabled = true;
        var r = await authed('/proposals/versions/' + vid, { method: 'DELETE' });
        if (!r.ok) { bt.disabled = false; alert(await serverMessage(r, 'Could not discard this version (' + r.status + ').')); return; }
        openProposalDetail(id, user);
      });
    });
    var puBtn = document.getElementById('propUnlock');
    if (puBtn) puBtn.addEventListener('click', function () { openUnlockForm({ id: lockedOrder.id, number: lockedOrder.number }, user); });
    document.querySelectorAll('#propActions [data-act]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var act = bt.getAttribute('data-act'), vid = bt.getAttribute('data-vid');
        if (act === 'lock') { openLockForm(vid, user); return; }
        var path = act === 'new-version' ? '/proposals/' + id + '/versions' : '/proposals/versions/' + vid + '/' + act;
        bt.disabled = true;
        var rr = await authed(path, { method: 'POST', body: await actionBody(act, id, vid) });
        if (!rr.ok) { alert('Action failed (' + rr.status + ').'); bt.disabled = false; return; }
        await reportRelease(act, rr);
        openProposalDetail(id, user);
      });
    });
  }
  function proposalActions(v, user, lockedOrder) {
    var s = v.status || 'DRAFT', b = [];
    function btn(act, label, primary) { return '<button class="' + (primary ? 'btn' : 'link-btn') + '" data-act="' + act + '" data-vid="' + v.id + '" style="width:auto;padding:9px 15px;">' + label + '</button>'; }
    if (s === 'DRAFT') { if (hasRole(PROP_WRITE, user.role)) b.push(btn('submit-review', 'Submit for review')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Ready to Send to Customer', 1)); }
    else if (s === 'INTERNAL_REVIEW') { if (hasRole(PROP_REVIEW, user.role)) b.push(btn('return-draft', 'Return to draft')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Ready to Send to Customer', 1)); }
    else if (s === 'RELEASED') { if (hasRole(PROP_REVIEW, user.role)) { b.push(btn('accept', 'Proposal Signed', 1)); b.push(btn('reject', 'Reject')); b.push(btn('expire', 'Expire')); } }
    else if (s === 'ACCEPTED') {
      if (lockedOrder && lockedOrder.id && lockedOrder.status !== 'CANCELLED') {
        b.push('<span class="chip" style="align-self:center;">Locked to ' + esc(lockedOrder.number || 'order') + '</span>');
        if (hasRole(ORDERS_MANAGE_ROLES, user.role) && lockedOrder.status !== 'COMPLETE') {
          b.push('<button class="link-btn" id="propUnlock" style="width:auto;padding:9px 15px;color:#9c3327;">Unlock for changes</button>');
        }
      } else if (hasRole(ORDERS_MANAGE_ROLES, user.role)) {
        b.push('<button class="btn" data-act="lock" data-vid="' + v.id + '" style="width:auto;padding:9px 15px;">Lock to operational order</button>');
      }
    }
    if (hasRole(PROP_WRITE, user.role) && (s === 'RELEASED' || s === 'REJECTED' || s === 'EXPIRED')) b.push(btn('new-version', 'Create new version'));
    return b.join('');
  }
  async function openProposalForm(user) {
    var orgs = [];
    try { var r = await authed('/crm/organizations?pageSize=100'); if (r.ok) orgs = (await r.json()).items || []; } catch (e) {}
    if (!orgs.length) { alert('Create an organization first.'); return; }
    openModal('New proposal',
      fieldRow('Organization', '<select id="fOrg" style="' + IN + '">' + orgs.map(function (o) { return '<option value="' + o.id + '">' + esc(o.name) + '</option>'; }).join('') + '</select>') +
      fieldRow('Title', '<input id="fTitle" style="' + IN + '" required>'),
      async function (close, showErr) {
        var title = document.getElementById('fTitle').value.trim(); if (title.length < 2) return showErr('Title must be at least 2 characters.');
        var r = await authed('/proposals', { method: 'POST', body: { organizationId: document.getElementById('fOrg').value, title: title, sections: [], items: [] } });
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); renderProposals(user);
      });
  }
  /* --- Reports: company-wide proposal analytics --- */
  var rep = { data: null, tab: 'overview', range: '365', from: '', to: '', pq: '', psort: 'proposedValue' };
  var REP_TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'conversion', label: 'Conversion' },
    { id: 'aging', label: 'Aging' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'winloss', label: 'Win / loss' },
    { id: 'products', label: 'Product demand' },
    { id: 'team', label: 'Team' },
    { id: 'detail', label: 'All proposals' },
  ];
  var REP_RANGES = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months'], ['ytd', 'Year to date'], ['all', 'All time'], ['custom', 'Custom…']];
  function fmt0(minor) { return '$' + Math.round((Number(minor) || 0) / 100).toLocaleString(); }
  function repRangeParams() {
    var t = new Date(), from = null;
    if (rep.range === 'custom') return { from: rep.from || '', to: rep.to || '' };
    if (rep.range === 'all') return { from: '', to: '' };
    if (rep.range === 'ytd') from = new Date(t.getFullYear(), 0, 1);
    else { from = new Date(t.getTime() - Number(rep.range) * 86400000); }
    return { from: isoLocal(from), to: '' };
  }
  async function renderReports(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
        '<div id="repTabs" style="display:flex;gap:6px;flex-wrap:wrap;"></div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<select id="repRange" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13px;background:#fff;">' +
            REP_RANGES.map(function (r) { return '<option value="' + r[0] + '"' + (rep.range === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select>' +
          '<span id="repCustom" style="display:' + (rep.range === 'custom' ? 'flex' : 'none') + ';gap:6px;align-items:center;">' +
            '<input id="repFrom" type="date" value="' + esc(rep.from) + '" style="padding:8px 10px;border:1px solid #dcded7;border-radius:9px;font-size:13px;">' +
            '<span class="muted" style="font-size:12px;">to</span>' +
            '<input id="repTo" type="date" value="' + esc(rep.to) + '" style="padding:8px 10px;border:1px solid #dcded7;border-radius:9px;font-size:13px;"></span>' +
          '<button class="link-btn" id="repCsv" style="width:auto;padding:9px 14px;white-space:nowrap;">Export CSV</button>' +
        '</div></div>' +
      '<div id="repBody"><div class="muted" style="padding:24px;">Loading reports…</div></div>';
    drawRepTabs(user);
    var sel = document.getElementById('repRange');
    sel.addEventListener('change', function () {
      rep.range = sel.value;
      document.getElementById('repCustom').style.display = rep.range === 'custom' ? 'flex' : 'none';
      if (rep.range !== 'custom') loadReports();
    });
    ['repFrom', 'repTo'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () {
        rep.from = document.getElementById('repFrom').value; rep.to = document.getElementById('repTo').value; loadReports();
      });
    });
    document.getElementById('repCsv').addEventListener('click', exportReportCsv);
    loadReports();
  }
  function drawRepTabs(user) {
    var box = document.getElementById('repTabs'); if (!box) return;
    box.innerHTML = REP_TABS.map(function (t) {
      var on = rep.tab === t.id;
      return '<button data-t="' + t.id + '" style="border:1px solid ' + (on ? '#3d4a55' : '#dcded7') + ';background:' + (on ? '#3d4a55' : '#fff') + ';color:' + (on ? '#fff' : '#3d4a55') + ';border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;">' + esc(t.label) + '</button>';
    }).join('');
    box.querySelectorAll('[data-t]').forEach(function (b) {
      b.addEventListener('click', function () { rep.tab = b.getAttribute('data-t'); drawRepTabs(user); drawReports(); });
    });
  }
  async function loadReports() {
    var box = document.getElementById('repBody'); if (!box) return;
    box.innerHTML = '<div class="muted" style="padding:24px;">Loading reports…</div>';
    var p = repRangeParams();
    var qs = [];
    if (p.from) qs.push('from=' + encodeURIComponent(p.from));
    if (p.to) qs.push('to=' + encodeURIComponent(p.to));
    try {
      var r = await authed('/reports/proposals' + (qs.length ? '?' + qs.join('&') : ''));
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load reports (' + r.status + ').</div>'; return; }
      rep.data = await r.json();
      drawReports();
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  function kpi(label, value, sub, color) {
    return '<div class="card"><div class="k">' + esc(label) + '</div>' +
      '<div style="font-family:\'Newsreader\',serif;font-size:26px;font-weight:600;margin-top:2px;color:' + (color || '#20241f') + ';">' + value + '</div>' +
      (sub ? '<div class="muted" style="font-size:12px;margin-top:3px;">' + sub + '</div>' : '') + '</div>';
  }
  function bar(fraction, color, height) {
    var w = Math.max(0, Math.min(1, fraction || 0)) * 100;
    return '<div style="background:#eef0ea;border-radius:999px;height:' + (height || 8) + 'px;overflow:hidden;"><div style="width:' + w.toFixed(1) + '%;height:100%;background:' + (color || '#3d4a55') + ';border-radius:999px;"></div></div>';
  }
  function repTable(head, rows, empty) {
    return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:13.5px;"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:' + (h[1] || 'left') + ';padding:10px 14px;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;">' + esc(h[0]) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + head.length + '" style="padding:20px 14px;color:#909689;">' + esc(empty || 'No data in this period.') + '</td></tr>') + '</tbody></table></div>';
  }
  function rtd(v, align, weight) { return '<td style="padding:10px 14px;border-bottom:1px solid #f2f3ef;text-align:' + (align || 'left') + ';' + (weight ? 'font-weight:600;' : '') + 'white-space:nowrap;">' + v + '</td>'; }
  function drawReports() {
    var box = document.getElementById('repBody'); if (!box || !rep.data) return;
    var d = rep.data, s = d.summary;
    if (!s.total) { box.innerHTML = '<div class="placeholder"><h3>No proposals in this period</h3><p>Widen the date range to see reporting across the company.</p></div>'; return; }
    if (rep.tab === 'overview') {
      var pipeMax = Math.max.apply(null, d.pipeline.map(function (p) { return p.value; }).concat([1]));
      box.innerHTML =
        '<div class="grid">' +
          kpi('Proposals', s.total.toLocaleString(), fmt0(s.totalValue) + ' total value') +
          kpi('Conversion rate', s.conversionRate + '%', s.won + ' of ' + s.sent + ' sent accepted', '#2f7d5d') +
          kpi('Win rate', s.winRate + '%', 'vs ' + s.lost + ' rejected', s.winRate >= 50 ? '#2f7d5d' : '#9c3327') +
          kpi('Open pipeline', fmt0(s.openValue), s.open + ' open · avg ' + s.avgDaysOpen + ' days old', '#3d4a55') +
        '</div>' +
        '<div class="grid" style="margin-top:12px;">' +
          kpi('Accepted value', fmt0(s.wonValue), s.won + ' proposals', '#2f7d5d') +
          kpi('Avg proposal', fmt0(s.avgValue), 'across all proposals') +
          kpi('Avg days to decision', s.avgDaysToDecision, 'release → accepted / rejected') +
          kpi('Avg margin', s.avgMarginPct + '%', 'accepted: ' + s.wonMarginPct + '%') +
        '</div>' +
        (s.archivedCount ? '<div style="margin-top:14px;background:#f4f5f1;border:1px solid #cbcec5;color:#5c6157;border-radius:12px;padding:12px 14px;font-size:13px;">' + s.archivedCount + ' archived proposal(s) worth ' + fmt0(s.archivedValue) + ' are excluded from every figure above. See the Archived tab on the proposals list.</div>' : '') +
        (s.expiredFlagged ? '<div style="margin-top:14px;background:#fbe9e6;border:1px solid #f0cdc7;color:#9c3327;border-radius:12px;padding:12px 14px;font-size:13px;">⚑ ' + s.expiredFlagged + ' open proposal(s) are past their expiration date. See the Aging tab.</div>' : '') +
        '<div class="section-title">Pipeline by stage</div>' +
        d.pipeline.map(function (p) {
          return '<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>' + esc(p.label) + ' <span class="muted">· ' + p.count + '</span></span><span style="font-weight:600;">' + fmt0(p.value) + '</span></div>' +
            bar(p.value / pipeMax, p.status === 'ACCEPTED' ? '#2f7d5d' : p.status === 'REJECTED' ? '#9c3327' : p.status === 'EXPIRED' ? '#b3b7ac' : '#3d4a55') + '</div>';
        }).join('') +
        '<div class="section-title">Most-proposed products</div>' +
        repTable([['Product'], ['SKU'], ['Proposals', 'center'], ['Qty', 'center'], ['Proposed value', 'right'], ['Won value', 'right']],
          d.products.slice(0, 10).map(function (p) {
            return '<tr>' + rtd(esc(p.name), 'left', 1) + rtd('<span style="font-family:ui-monospace,monospace;font-size:11.5px;color:#5c6157;">' + esc(p.sku) + '</span>') +
              rtd(p.proposals, 'center') + rtd(p.qty, 'center') + rtd(fmt0(p.proposedValue), 'right') + rtd(fmt0(p.wonValue), 'right') + '</tr>';
          }).join(''));
      return;
    }
    if (rep.tab === 'conversion') {
      var stages = [
        ['All proposals created', s.total, s.totalValue, '#3d4a55'],
        ['Sent to customer', s.sent, s.sentValue, '#3d4a55'],
        ['Accepted', s.won, s.wonValue, '#2f7d5d'],
      ];
      box.innerHTML =
        '<div class="grid">' +
          kpi('Conversion rate', s.conversionRate + '%', 'accepted ÷ sent', '#2f7d5d') +
          kpi('Conversion by value', s.conversionRateByValue + '%', fmt0(s.wonValue) + ' of ' + fmt0(s.sentValue)) +
          kpi('Win rate', s.winRate + '%', 'accepted ÷ decided', s.winRate >= 50 ? '#2f7d5d' : '#9c3327') +
          kpi('Expiry rate', s.expiryRate + '%', s.expired + ' went inactive', '#8a6d1f') +
        '</div>' +
        '<div class="section-title">Funnel</div>' +
        stages.map(function (st) {
          return '<div style="margin-bottom:12px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>' + st[0] + ' <span class="muted">· ' + st[1] + '</span></span><span style="font-weight:600;">' + fmt0(st[2]) + '</span></div>' +
            bar(s.total ? st[1] / s.total : 0, st[3], 12) + '</div>';
        }).join('') +
        '<div class="section-title">Conversion by customer type</div>' +
        repTable([['Customer type'], ['Proposals', 'center'], ['Value', 'right'], ['Accepted', 'center'], ['Accepted value', 'right'], ['Rate', 'right']],
          d.byCustomerType.map(function (g) {
            return '<tr>' + rtd(esc(titleCase(g.customerType)), 'left', 1) + rtd(g.count, 'center') + rtd(fmt0(g.value), 'right') +
              rtd(g.won, 'center') + rtd(fmt0(g.wonValue), 'right') + rtd((g.count ? Math.round((g.won / g.count) * 1000) / 10 : 0) + '%', 'right', 1) + '</tr>';
          }).join('')) +
        '<div class="section-title">Conversion by customer</div>' +
        repTable([['Customer'], ['Proposals', 'center'], ['Value', 'right'], ['Won', 'center'], ['Lost', 'center'], ['Win rate', 'right']],
          d.byCustomer.map(function (g) {
            return '<tr>' + rtd(esc(g.customer), 'left', 1) + rtd(g.count, 'center') + rtd(fmt0(g.value), 'right') + rtd(g.won, 'center') + rtd(g.lost, 'center') + rtd(g.winRate + '%', 'right', 1) + '</tr>';
          }).join(''));
      return;
    }
    if (rep.tab === 'aging') {
      var amax = Math.max.apply(null, d.aging.map(function (a) { return a.count; }).concat([1]));
      var rowsOf = function (list) {
        return list.map(function (r) {
          return '<tr>' + rtd('<b style="font-weight:600;">' + esc(r.customer) + '</b><div class="muted" style="font-size:11.5px;">' + esc(r.title) + ' · ' + esc(r.number) + '</div>') +
            rtd(statusChip(r.status)) + rtd(fmtDate(r.createdAt)) + rtd(r.daysOpen + ' d', 'center') +
            rtd(r.expiration ? fmtDate(r.expiration) : '<span class="muted">—</span>') + rtd(fmt0(r.total), 'right', 1) + '</tr>';
        }).join('');
      };
      var ageHead = [['Proposal'], ['Status'], ['Created'], ['Age', 'center'], ['Expires'], ['Value', 'right']];
      box.innerHTML =
        '<div class="grid">' +
          kpi('Open proposals', s.open, fmt0(s.openValue) + ' in flight') +
          kpi('Avg age', s.avgDaysOpen + ' d', 'open proposals') +
          kpi('Past expiration', d.expiredOpen.length, 'still open — needs action', d.expiredOpen.length ? '#9c3327' : '#2f7d5d') +
          kpi('Expiring ≤ 14 days', d.expiringSoon.length, 'follow up now', '#8a6d1f') +
        '</div>' +
        '<div class="section-title">Aging buckets (open proposals)</div>' +
        d.aging.map(function (a) {
          return '<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;"><span>' + esc(a.bucket) + ' <span class="muted">· ' + a.count + '</span></span><span style="font-weight:600;">' + fmt0(a.value) + '</span></div>' + bar(a.count / amax, '#3d4a55') + '</div>';
        }).join('') +
        '<div class="section-title">Past expiration — open</div>' + repTable(ageHead, rowsOf(d.expiredOpen), 'Nothing past expiration. ') +
        '<div class="section-title">Expiring within 14 days</div>' + repTable(ageHead, rowsOf(d.expiringSoon), 'Nothing expiring soon.') +
        '<div class="section-title">Oldest open proposals</div>' + repTable(ageHead, rowsOf(d.oldestOpen), 'No open proposals.');
      return;
    }
    if (rep.tab === 'pipeline') {
      var vmax = Math.max.apply(null, d.pipeline.map(function (p) { return p.value; }).concat([1]));
      box.innerHTML =
        '<div class="grid">' +
          kpi('Total pipeline', fmt0(s.totalValue), s.total + ' proposals') +
          kpi('Open', fmt0(s.openValue), s.open + ' proposals', '#3d4a55') +
          kpi('Released & awaiting', fmt0(d.pipeline.filter(function (p) { return p.status === 'RELEASED'; })[0].value), s.released + ' out with customers') +
          kpi('Closed won', fmt0(s.wonValue), s.won + ' proposals', '#2f7d5d') +
        '</div>' +
        '<div class="section-title">By stage</div>' +
        repTable([['Stage'], ['Proposals', 'center'], ['Value', 'right'], ['Share of value', 'left']],
          d.pipeline.map(function (p) {
            return '<tr>' + rtd(esc(p.label), 'left', 1) + rtd(p.count, 'center') + rtd(fmt0(p.value), 'right', 1) +
              '<td style="padding:10px 14px;border-bottom:1px solid #f2f3ef;min-width:180px;">' + bar(p.value / vmax, p.status === 'ACCEPTED' ? '#2f7d5d' : p.status === 'REJECTED' ? '#9c3327' : '#3d4a55') + '</td></tr>';
          }).join('')) +
        '<div class="section-title">Pipeline by customer</div>' +
        repTable([['Customer'], ['Proposals', 'center'], ['Total value', 'right'], ['Accepted value', 'right']],
          d.byCustomer.map(function (g) { return '<tr>' + rtd(esc(g.customer), 'left', 1) + rtd(g.count, 'center') + rtd(fmt0(g.value), 'right') + rtd(fmt0(g.wonValue), 'right') + '</tr>'; }).join(''));
      return;
    }
    if (rep.tab === 'winloss') {
      var mmax = Math.max.apply(null, d.winLossByMonth.map(function (m) { return Math.max(m.won, m.lost); }).concat([1]));
      box.innerHTML =
        '<div class="grid">' +
          kpi('Accepted', s.won, fmt0(s.wonValue), '#2f7d5d') +
          kpi('Rejected', s.lost, fmt0(s.lostValue), '#9c3327') +
          kpi('Expired / inactive', s.expired, fmt0(s.expiredValue), '#8a8f85') +
          kpi('Avg days to decision', s.avgDaysToDecision, 'from release to outcome') +
        '</div>' +
        '<div class="section-title">Outcomes by month</div>' +
        repTable([['Month'], ['Accepted', 'center'], ['Rejected', 'center'], ['Inactive', 'center'], ['Accepted value', 'right'], ['Lost value', 'right'], ['Mix', 'left']],
          d.winLossByMonth.map(function (m) {
            var tot = m.won + m.lost || 1;
            return '<tr>' + rtd(esc(m.month), 'left', 1) + rtd(m.won, 'center') + rtd(m.lost, 'center') + rtd(m.expired, 'center') +
              rtd(fmt0(m.wonValue), 'right') + rtd(fmt0(m.lostValue), 'right') +
              '<td style="padding:10px 14px;border-bottom:1px solid #f2f3ef;min-width:160px;"><div style="display:flex;height:8px;border-radius:999px;overflow:hidden;background:#eef0ea;"><div style="width:' + ((m.won / tot) * 100).toFixed(1) + '%;background:#2f7d5d;"></div><div style="width:' + ((m.lost / tot) * 100).toFixed(1) + '%;background:#9c3327;"></div></div></td></tr>';
          }).join('')) +
        '<div class="section-title">Win / loss by customer</div>' +
        repTable([['Customer'], ['Won', 'center'], ['Lost', 'center'], ['Win rate', 'right'], ['Won value', 'right']],
          d.byCustomer.filter(function (g) { return g.won || g.lost; }).map(function (g) {
            return '<tr>' + rtd(esc(g.customer), 'left', 1) + rtd(g.won, 'center') + rtd(g.lost, 'center') + rtd(g.winRate + '%', 'right', 1) + rtd(fmt0(g.wonValue), 'right') + '</tr>';
          }).join(''), 'No decided proposals yet.');
      return;
    }
    if (rep.tab === 'products') {
      var q = rep.pq.trim().toLowerCase();
      var list = d.products.filter(function (p) { return !q || (p.name + ' ' + p.sku).toLowerCase().indexOf(q) !== -1; });
      list = list.slice().sort(function (a, b) { return (b[rep.psort] || 0) - (a[rep.psort] || 0); });
      var top = list.slice(0, 12);
      var pmax = Math.max.apply(null, top.map(function (p) { return p.proposedValue; }).concat([1]));
      box.innerHTML =
        '<div class="grid">' +
          kpi('Distinct products proposed', d.products.length, 'in this period') +
          kpi('Units proposed', d.products.reduce(function (a, p) { return a + p.qty; }, 0).toLocaleString(), 'all line items') +
          kpi('Proposed value', fmt0(d.products.reduce(function (a, p) { return a + p.proposedValue; }, 0)), 'product lines only') +
          kpi('Accepted value', fmt0(d.products.reduce(function (a, p) { return a + p.wonValue; }, 0)), 'from accepted proposals', '#2f7d5d') +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0 10px;">' +
          '<input id="repPq" placeholder="Filter products or SKUs…" value="' + esc(rep.pq) + '" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13px;background:#fff;width:240px;">' +
          '<select id="repPsort" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13px;background:#fff;">' +
            [['proposedValue', 'Sort: proposed value'], ['qty', 'Sort: units proposed'], ['proposals', 'Sort: times proposed'], ['wonValue', 'Sort: accepted value'], ['attachRate', 'Sort: attach rate']]
              .map(function (o) { return '<option value="' + o[0] + '"' + (rep.psort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '</div>' +
        '<div class="section-title">Top products by proposed value</div>' +
        top.map(function (p) {
          return '<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:4px;"><span>' + esc(p.name) + ' <span class="muted" style="font-family:ui-monospace,monospace;font-size:11px;">' + esc(p.sku) + '</span></span><span style="font-weight:600;">' + fmt0(p.proposedValue) + '</span></div>' + bar(p.proposedValue / pmax, '#3d4a55') + '</div>';
        }).join('') +
        '<div class="section-title">Product demand detail</div>' +
        repTable([['Product'], ['SKU'], ['Proposals', 'center'], ['Attach rate', 'right'], ['Units', 'center'], ['Avg rate', 'right'], ['Proposed value', 'right'], ['Accepted', 'center'], ['Accepted value', 'right']],
          list.map(function (p) {
            return '<tr>' + rtd(esc(p.name), 'left', 1) + rtd('<span style="font-family:ui-monospace,monospace;font-size:11.5px;color:#5c6157;">' + esc(p.sku) + '</span>') +
              rtd(p.proposals, 'center') + rtd(p.attachRate + '%', 'right') + rtd(p.qty, 'center') + rtd(fmt0(p.avgRate), 'right') +
              rtd(fmt0(p.proposedValue), 'right', 1) + rtd(p.wonProposals, 'center') + rtd(fmt0(p.wonValue), 'right') + '</tr>';
          }).join(''), 'No product lines in this period.');
      var pq = document.getElementById('repPq');
      pq.addEventListener('input', function () { rep.pq = pq.value; drawReports(); document.getElementById('repPq').focus(); });
      document.getElementById('repPsort').addEventListener('change', function () { rep.psort = this.value; drawReports(); });
      return;
    }
    if (rep.tab === 'team') {
      box.innerHTML =
        '<div class="section-title">By preparer</div>' +
        repTable([['Prepared by'], ['Proposals', 'center'], ['Total value', 'right'], ['Accepted', 'center'], ['Accepted value', 'right'], ['Win rate', 'right'], ['Avg margin', 'right']],
          d.byPreparer.map(function (g) {
            return '<tr>' + rtd(esc(g.preparedBy), 'left', 1) + rtd(g.count, 'center') + rtd(fmt0(g.value), 'right') + rtd(g.won, 'center') +
              rtd(fmt0(g.wonValue), 'right') + rtd(g.winRate + '%', 'right', 1) + rtd(g.avgMarginPct + '%', 'right') + '</tr>';
          }).join(''));
      return;
    }
    // detail
    box.innerHTML =
      '<div class="section-title">All proposals in range <span class="muted" style="font-weight:400;font-size:12px;">— ' + d.rows.length + ' records</span></div>' +
      repTable([['Customer'], ['Proposal'], ['Prepared by'], ['Status'], ['Created'], ['Modified'], ['Expires'], ['Age', 'center'], ['Value', 'right'], ['Margin', 'right']],
        d.rows.map(function (r) {
          return '<tr>' + rtd('<b style="font-weight:600;">' + esc(r.customer) + '</b>') +
            rtd(esc(r.title) + '<div class="muted" style="font-size:11.5px;">' + esc(r.number) + '</div>') +
            rtd(esc(r.preparedBy || '—')) + rtd(statusChip(r.status) + (r.expired ? ' <span style="color:#9c3327;">⚑</span>' : '')) +
            rtd(fmtDate(r.createdAt)) + rtd(fmtDate(r.updatedAt)) + rtd(r.expiration ? fmtDate(r.expiration) : '—') +
            rtd(r.daysOpen + ' d', 'center') + rtd(fmt0(r.total), 'right', 1) + rtd(r.marginPct + '%', 'right') + '</tr>';
        }).join(''));
  }
  function exportReportCsv() {
    if (!rep.data) return;
    var cols = ['number', 'customer', 'customerType', 'title', 'preparedBy', 'status', 'createdAt', 'updatedAt', 'releasedAt', 'decidedAt', 'expiration', 'expired', 'daysOpen', 'daysToDecision', 'version', 'lineCount', 'total', 'revenue', 'cogs', 'margin', 'marginPct'];
    var csv = [cols.join(',')].concat(rep.data.rows.map(function (r) {
      return cols.map(function (c) {
        var v = r[c];
        if (c === 'total' || c === 'revenue' || c === 'cogs' || c === 'margin') v = (Number(v) || 0) / 100;
        if (v == null) v = '';
        var s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    })).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'proposal-report-' + todayISO() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* --- Proposal Builder --- */
  var STD_GROUPS = ['Dual Trolley System', 'Therapeutic Activity & Adventure Components', 'Adventure Mat System', 'Summit Foundation System', 'Hardware'];
  var STD_NOTES = {
    'Important Proposal Details': 'This proposal serves as a detailed estimate of the total cost for the products and services outlined and does not constitute an invoice. Once signed and returned, it becomes a binding agreement, confirming acceptance of the order and associated payment terms. A 50% deposit is required to initiate production, with the remaining balance due prior to shipment. The signed proposal may be returned by mail or fax using the contact information provided above. For payments made by credit card, a 3.5% processing fee will be added to the total amount.',
    'Crating & Freight': 'Final crating and freight charges will be calculated and invoiced at the time of shipment based on the actual costs incurred and the rates in effect at that time. Summit makes no representations or warranties regarding the availability or stability of crating costs or freight rates prior to shipment.',
    'Freight & Taxes': 'Freight charges and all applicable taxes included in this proposal are strictly our best estimates of total freight and anticipated tax expense. Final freight and tax amounts will be based on the shipment destination, carrier rates in effect at the time of shipment, and applicable tax requirements.',
  };
  function d2m(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : Math.round(n * 100); }
  function m2d(m) { return (Number(m || 0) / 100).toFixed(2); }
  /** Pounds, with one decimal only when it matters. */
  function fmtWeight(lbs) {
    var n = Number(lbs) || 0;
    var s = n >= 100 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toLocaleString();
    return s + ' lbs';
  }
  function uid() { return 'l' + Math.random().toString(36).slice(2, 9); }

  /**
   * Warnings that were written into `description` before they had a field of their
   * own. Left alone they would print on a customer's proposal, so they are lifted
   * out on load — the line keeps the flag, the customer never sees it.
   */
  var LEAKED_INTERNAL = [/^Quantity assumed 1 per zip line/];

  /** The rolled-up hardware kit line on this draft, if it has one. */
  function hardwareKitLine() {
    return (pb && pb.lines ? pb.lines : []).filter(function (l) {
      return String(l.sku || '').toUpperCase() === 'H-1000';
    })[0] || null;
  }

  /** The Hardware Kit always sits at the top of its section. Applied when lines are
   *  loaded or generated — not on every render, so dragging still works mid-session. */
  function hoistHardwareKit(lines) {
    if (!Array.isArray(lines)) return lines;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].lineType !== 'GROUP') continue;
      var end = i + 1;
      while (end < lines.length && lines[end].lineType !== 'GROUP') end++;
      for (var j = i + 1; j < end; j++) {
        if (String(lines[j].sku || '').toUpperCase() !== 'H-1000') continue;
        var kit = lines.splice(j, 1)[0];
        lines.splice(i + 1, 0, kit);
        break;
      }
      i = end - 1;
    }
    return lines;
  }

  /**
   * Keep the H-1000 fastener kit in step with the proposal, with nobody asked to
   * re-run anything.
   *
   * Add an eye bolt (6820H-LP) and the nuts and washers that hang off it move with
   * it — 6820H-LC and 6820H-LB both read `hw:6820H-LP`. The server re-evaluates the
   * rules with the proposal's own fastener quantities layered over the
   * configurator's, and returns just the kit; regenerating every line instead would
   * throw away whatever the rep has edited by hand.
   *
   * Only the kit's own figures are written back. Nothing else on the proposal moves.
   */
  var hwTimer = null, hwSig = null, hwBusy = false;

  /** Fastener quantities on the proposal, keyed by part. */
  function hardwareQty() {
    var kit = hardwareKitLine();
    var known = {};
    ((kit && kit.components) || []).forEach(function (c) { known[String(c.part || '').toUpperCase()] = true; });
    var out = {};
    (pb && pb.lines ? pb.lines : []).forEach(function (l) {
      if (!l || l.lineType !== 'PRODUCT' || l.optional) return;
      var sku = String(l.sku || '').toUpperCase();
      // Rule parts are the ones already in the kit, plus the 6820H-* accessories that
      // print as their own lines and so are never in it.
      if (!sku || (!known[sku] && sku.indexOf('6820') !== 0)) return;
      if (sku === 'H-1000') return;
      out[sku] = (out[sku] || 0) + (Number(l.quantity) || 0);
    });
    return out;
  }

  function scheduleHardwareRefresh() {
    if (!pb || !pb.meta || !pb.meta.advAnswers || !hardwareKitLine()) return;
    var sig = JSON.stringify(hardwareQty());
    if (sig === hwSig) return;
    hwSig = sig;
    if (hwTimer) clearTimeout(hwTimer);
    hwTimer = setTimeout(refreshHardwareKit, 700);
  }

  async function refreshHardwareKit() {
    hwTimer = null;
    if (hwBusy) { hwTimer = setTimeout(refreshHardwareKit, 400); return; }
    var kit = hardwareKitLine();
    if (!kit || !pb.meta || !pb.meta.advAnswers) return;
    hwBusy = true;
    try {
      var r = await authed('/proposals/adventure-series/hardware', {
        method: 'POST', body: { answers: pb.meta.advAnswers, hwQty: hardwareQty() },
      });
      if (!r.ok) return;
      var d = await r.json();
      if (!d || !d.components) return;
      // The line may have been deleted while the request was in flight.
      kit = hardwareKitLine();
      if (!kit) return;
      var was = Number(kit.rateMinor) || 0;
      kit.components = d.components;
      kit.rateMinor = d.priceMinor;
      kit.costEach = d.costMinor;
      kit.weightEach = d.weightLbs;
      // Only the summary form is rewritten; an itemised description was chosen
      // deliberately and is left for the configurator to regenerate.
      if (kit.description && /^All mounting hardware/.test(kit.description)) {
        kit.description = 'All mounting hardware for this structure — ' + d.pieces +
          ' pieces across ' + d.components.length + ' part numbers.';
      }
      if (was !== d.priceMinor) markBuilderDirty();
      renderBuilderKeepingFocus();
    } catch (e) {
      // Offline or a server error: leave the kit as it stands rather than zeroing it.
    } finally { hwBusy = false; }
  }

  /**
   * The standing freight note for vendors who quote delivery after the fact (set per
   * vendor in Administration → Manufacturers). It is derived, never typed: it appears
   * on a line whose part comes from such a vendor and disappears the moment that line
   * carries a freight figure — so it can never contradict a charge on the same line.
   */
  var FREIGHT_TBD_NOTE = 'Shipping and freight charges for this item have not yet been determined. Upon approval of this proposal, current freight pricing will be obtained and added to the final invoice.';
  function showsFreightTbd(l) {
    if (!l || !l.freightTbd) return false;
    if ((Number(l.tpFreightMinor) || 0) > 0) return false;
    return l.freightCalc !== 'YES';
  }

  function normalizeLine(it) {
    var desc = it.description || '';
    var note = it.internalNote || '';
    if (!note && LEAKED_INTERNAL.some(function (re) { return re.test(desc); })) { note = desc; desc = ''; }
    return {
      ref: it.ref || uid(), lineType: it.lineType || (it.isNote ? 'NOTE' : 'PRODUCT'), kind: it.kind || 'INCLUDED',
      productId: it.productId || null, sku: it.sku || '', name: it.name || '', description: desc,
      quantity: it.quantity == null ? 1 : it.quantity, rateMinor: it.rateMinor || 0, costEach: it.costEach || 0, weightEach: it.weightEach || 0, group: it.group || '',
      optional: !!it.optional,
      delivery: it.delivery || '', returnable: it.returnable || '', addlFreight: it.addlFreight || '', freightCalc: it.freightCalc || '',
      tpFreightMinor: it.tpFreightMinor || 0, tpFreightLabel: it.tpFreightLabel || '',
      // Vendor-driven: this part is sourced from a vendor who quotes freight later.
      // Set from the catalog, so it survives a save and travels to the PDF.
      freightTbd: !!it.freightTbd,
      // Engineering warning for the person building the proposal. Kept separate
      // from `description` precisely so it can never be printed.
      internalNote: note,
      // Kit breakdown (H-1000 → its fasteners). Opaque to the builder; it exists so
      // the BOM can list the hardware out without re-running the configurator.
      components: it.components || null,
      // Which builder produced this line, if any. 'ADV' / 'SOAR' means the
      // configurator owns it and a revise may replace it; blank means a person put it
      // there and nothing may touch it. Without this, revising could only ever append.
      source: it.source || '',
      showNotes: false,
    };
  }

  var pb = null; // active builder document

  function addDays(iso, n) { if (!iso) return ''; var d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return ''; d.setDate(d.getDate() + n); return isoLocal(d); }
  function formatOrgShipTo(org) {
    if (!org || !org.addresses || !org.addresses.length) return '';
    var a = org.addresses.filter(function (x) { return x.type === 'SHIPPING'; })[0] || org.addresses.filter(function (x) { return x.type === 'BILLING'; })[0] || org.addresses[0];
    if (!a) return '';
    return streetLine(a.line1, a.line2) + '\n' + a.city + ', ' + a.region + ' ' + a.postalCode;
  }
  function primaryContactName(org) {
    var cs = (org && org.contacts) || [];
    var c = cs.filter(function (x) { return x.isDecisionMaker; })[0] || cs[0];
    if (!c) return '';
    return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  }
  async function openBuilder(proposal, version, user) {
    var orgName = '', orgShipTo = '', orgContact = '';
    try { var rd = await authed('/crm/organizations/' + proposal.organizationId); if (rd.ok) { var org = await rd.json(); orgName = org.name || ''; orgShipTo = formatOrgShipTo(org); orgContact = primaryContactName(org); } } catch (e) {}
    if (!orgName) { try { var ro = await authed('/crm/organizations?pageSize=100'); if (ro.ok) { var found = ((await ro.json()).items || []).filter(function (o) { return o.id === proposal.organizationId; })[0]; orgName = found ? found.name : ''; } } catch (e2) {} }
    // Project ID rides along on the imported opportunity's notes.
    var importedProjectId = '';
    try {
      var rp = await authed('/crm/opportunities?pageSize=100' + (orgName ? '&q=' + encodeURIComponent(orgName) : ''));
      if (rp.ok) {
        var opps = ((await rp.json()).items || []).filter(function (o) { return o.organizationId === proposal.organizationId; });
        for (var oi = 0; oi < opps.length && !importedProjectId; oi++) {
          var mm = /Project ID:\s*(\S+)/.exec(opps[oi].notes || '');
          if (mm) importedProjectId = mm[1];
        }
      }
    } catch (e) {}

    var meta = {};
    var secs = version.sections || [];
    var metaSec = Array.isArray(secs) ? secs.filter(function (s) { return s && s.id === 'meta'; })[0] : null;
    if (metaSec && metaSec.data) meta = metaSec.data;
    var lines = hoistHardwareKit((version.items || []).map(function (it) {
      return normalizeLine(it);
    }));
    var propDate = meta.proposalDate || todayISO();
    // Standard notes come from Administration → Standard proposal notes; the
    // hard-coded set is only a fallback for an un-migrated database.
    var stdNotes = [];
    try { var rn = await authed('/standard-notes'); if (rn.ok) stdNotes = (await rn.json()) || []; } catch (e) {}
    if (!stdNotes.length) {
      stdNotes = Object.keys(STD_NOTES).map(function (k, i) {
        return { id: 'local-' + i, title: k, body: STD_NOTES[k], placement: 'TABLE', autoInclude: i === 0, active: true, sortOrder: i };
      });
    }
    stdNotes = stdNotes.filter(function (nn) { return nn.active !== false; });
    // Notes flagged "always include" are dropped onto a proposal the first time it
    // is built, so nobody has to remember to add them.
    if (!(version.items || []).length) {
      // Only the version of a paired note that matches this proposal. showDeposit is
      // read straight off the stored meta because pb is not assembled yet.
      var depositShown = meta.showDeposit !== false;
      var condOk = function (nn) {
        if (!nn.condition) return true;
        if (nn.condition === 'DEPOSIT_SHOWN') return depositShown;
        if (nn.condition === 'DEPOSIT_HIDDEN') return !depositShown;
        return true;
      };
      stdNotes.filter(function (nn) { return nn.autoInclude && nn.placement !== 'FOOTER' && condOk(nn); }).forEach(function (nn) {
        lines.push(normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0 }));
      });
    }
    var footerNotes = Array.isArray(meta.footerNotes) ? meta.footerNotes : null;
    if (!footerNotes) {
      var depositShownF = meta.showDeposit !== false;
      footerNotes = stdNotes.filter(function (nn) {
        if (!nn.autoInclude || nn.placement !== 'FOOTER') return false;
        if (!nn.condition) return true;
        if (nn.condition === 'DEPOSIT_SHOWN') return depositShownF;
        if (nn.condition === 'DEPOSIT_HIDDEN') return !depositShownF;
        return true;
      }).map(function (nn) { return { title: nn.title, body: nn.body }; });
    }
    pb = {
      proposalId: proposal.id, versionId: version.id, user: user, orgId: proposal.organizationId, orgName: orgName, stdNotes: stdNotes,
      title: proposal.title || '', number: proposal.number || '', version: version.version || 1,
      meta: { contactName: meta.contactName || orgContact || '', shipTo: meta.shipTo || orgShipTo || '', billTo: meta.billTo || '', billSameAsShip: !meta.billTo || meta.billTo === (meta.shipTo || orgShipTo || ''), showTitle: meta.showTitle !== false, projectId: meta.projectId || importedProjectId || '', showProjectId: meta.showProjectId !== false, showDeposit: meta.showDeposit !== false, tbdTax: meta.tbdTax || '', tbdStructureFreight: meta.tbdStructureFreight || '', tbdMatsFreight: meta.tbdMatsFreight || '', proposalDate: propDate, taxAmountMinor: meta.taxAmountMinor || 0, discountPct: meta.discountPct || 0, discountMode: meta.discountMode === 'AMT' ? 'AMT' : 'PCT', discountAmountMinor: meta.discountAmountMinor || 0, structureFreightMinor: meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0), matsFreightMinor: meta.matsFreightMinor || 0, stdFreightOn: !!meta.stdFreightOn, stdFreightMinor: meta.stdFreightMinor || 0, expiration: meta.expiration || addDays(propDate, 7), footerNotes: footerNotes, advAnswers: meta.advAnswers || null, advWarnings: meta.advWarnings || [] },
      lines: lines,
    };
    // A new proposal starts with the billing address the same as the shipping one.
    if (pb.meta.billSameAsShip && !pb.meta.billTo) pb.meta.billTo = pb.meta.shipTo || '';
    // Record the fastener quantities as loaded, so the automatic hardware refresh
    // fires on the first real change rather than on opening the proposal.
    hwSig = JSON.stringify(hardwareQty());
    // Awaited: the zero-price warning is computed from these, and rendering first
    // would show a clean builder for a moment on a proposal that has stale figures.
    loadItemDefaults().then(renderBuilder);
    renderBuilder();
    autoSyncFreightOnOpen();
  }

  /**
   * Per-part builder defaults (quantity, automatic freight) from Catalog → Pricing &
   * SKUs. Fetched once per builder session and applied when a line is inserted, never
   * on load — reopening a saved proposal must not silently re-price it.
   */
  var itemDefaults = {};
  async function loadItemDefaults() {
    try {
      var r = await authed('/catalog/items/defaults');
      if (r.ok) itemDefaults = (await r.json()) || {};
    } catch (e) { itemDefaults = {}; }
  }
  /**
   * Stamp a freshly inserted line with its part's automatic freight. Leaves a line
   * alone if it already carries a freight amount, so a builder-generated or
   * hand-entered figure always wins.
   */
  function applyItemDefaults(line) {
    if (!line || !line.sku) return line;
    var d = itemDefaults[line.sku];
    if (!d) return line;
    if (d.freightMinor != null && !(Number(line.tpFreightMinor) || 0)) {
      line.tpFreightMinor = d.freightMinor;
      line.tpFreightLabel = line.tpFreightLabel || d.freightLabel || 'Freight';
      // Open the notes panel so the charge is visible rather than buried.
      line.showNotes = true;
    }
    // Fill a BLANK figure from the catalog. Only blanks: a rate the engine or a rep
    // put on the line is deliberate and is never overwritten here.
    if (!(Number(line.rateMinor) || 0) && d.priceMinor) line.rateMinor = d.priceMinor;
    if (!(Number(line.costEach) || 0) && d.costMinor) line.costEach = d.costMinor;
    if (!(Number(line.weightEach) || 0) && d.weightLbs) line.weightEach = d.weightLbs;
    if (d.freightTbd) line.freightTbd = true;
    return line;
  }

  /**
   * Notes a part brings with it.
   *
   * Some wording has to travel with a product rather than with a proposal — the
   * mat system's 8–10 week lead time, for instance, is true whenever a mat is on
   * the job and misleading when one is not. Before this it was hardcoded in the
   * Adventure Series engine, so adding the same mat by hand from the product
   * picker produced a proposal with no note on it at all.
   *
   * A note is added ONCE, at the end of the section its triggering part sits in,
   * and only if it is not already on the proposal. Deleting it is respected until
   * another triggering part is added — the alternative, re-inserting on every
   * render, fights the rep and is worse.
   */
  function notesTriggeredBy(sku) {
    var part = String(sku || '').trim().toUpperCase();
    if (!part) return [];
    return ((pb && pb.stdNotes) || []).filter(function (nn) {
      if (nn.active === false || !nn.triggerParts) return false;
      if (!noteConditionHolds(nn)) return false;
      return String(nn.triggerParts).split(',').some(function (p) { return p.trim().toUpperCase() === part; });
    });
  }

  /** True when this note's text is already somewhere on the proposal. */
  function noteAlreadyPresent(nn) {
    return (pb.lines || []).some(function (l) {
      return l.lineType === 'NOTE' && String(l.name || '').trim() === String(nn.title || '').trim();
    }) || (pb.meta.footerNotes || []).some(function (f) {
      return String(f.title || '').trim() === String(nn.title || '').trim();
    });
  }

  /**
   * Add whatever notes this part pulls in. FOOTER notes join the footer block;
   * TABLE notes are inserted after the last line of the part's own section, so
   * the note reads as part of that section rather than drifting to the bottom.
   */
  function applyTriggeredNotes(sku, atIndex) {
    var added = 0;
    notesTriggeredBy(sku).forEach(function (nn) {
      if (noteAlreadyPresent(nn)) return;
      if (nn.placement === 'FOOTER') {
        pb.meta.footerNotes = (pb.meta.footerNotes || []).concat([{ title: nn.title, body: nn.body }]);
        added++;
        return;
      }
      var at = pb.lines.length;
      if (typeof atIndex === 'number' && atIndex >= 0) {
        at = atIndex + 1;
        while (at < pb.lines.length && !isSectionHeader(pb.lines[at])) at++;
      }
      pb.lines.splice(at, 0, normalizeLine({
        lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0,
      }));
      added++;
    });
    return added;
  }

  /**
   * Does a note's condition hold for this proposal?
   *
   * Null means always, which is every note that existed before conditions did.
   */
  function noteConditionHolds(nn) {
    var c = nn && nn.condition;
    if (!c) return true;
    var deposit = !pb || !pb.meta || pb.meta.showDeposit !== false;
    if (c === 'DEPOSIT_SHOWN') return deposit;
    if (c === 'DEPOSIT_HIDDEN') return !deposit;
    // An unknown condition is not a reason to drop a note off a customer document.
    return true;
  }

  /** A note already on the proposal, matched to the standard note it came from. */
  function stdNoteFor(line) {
    var t = String((line && line.name) || '').trim().toLowerCase();
    if (!t) return null;
    return ((pb && pb.stdNotes) || []).filter(function (nn) {
      return String(nn.title || '').trim().toLowerCase() === t;
    })[0] || null;
  }

  /**
   * Keep the conditional notes in step with the proposal.
   *
   * Called when something a condition depends on changes — today that is the deposit
   * checkbox. Any note whose condition no longer holds comes off, and its counterpart
   * goes on in the same place, so the deposit paragraph is replaced by the
   * payment-in-full paragraph rather than both being present or neither.
   *
   * Only notes flagged "always include" are added this way. A note a rep picked by
   * hand is their decision, and one that has been deleted stays deleted — the swap
   * puts the alternative where the outgoing note was, and adds nothing otherwise.
   */
  function applyConditionalNotes() {
    if (!pb || !pb.stdNotes) return 0;
    var changed = 0;

    // Table notes: swap in place.
    for (var i = pb.lines.length - 1; i >= 0; i--) {
      var l = pb.lines[i];
      if (!l || l.lineType !== 'NOTE') continue;
      var src = stdNoteFor(l);
      if (!src || !src.condition || noteConditionHolds(src)) continue;
      var alt = pb.stdNotes.filter(function (nn) {
        return nn.placement !== 'FOOTER' && nn.condition && nn.condition !== src.condition && noteConditionHolds(nn);
      })[0];
      if (alt && !noteAlreadyPresent(alt)) {
        pb.lines[i] = normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: alt.title, description: alt.body, quantity: 0, rateMinor: 0 });
      } else {
        pb.lines.splice(i, 1);
      }
      changed++;
    }

    // Footer notes: the same swap over pb.meta.footerNotes.
    var footer = pb.meta.footerNotes || [];
    for (var j = footer.length - 1; j >= 0; j--) {
      var fsrc = ((pb.stdNotes) || []).filter(function (nn) {
        return String(nn.title || '').trim().toLowerCase() === String(footer[j].title || '').trim().toLowerCase();
      })[0];
      if (!fsrc || !fsrc.condition || noteConditionHolds(fsrc)) continue;
      var falt = pb.stdNotes.filter(function (nn) {
        return nn.placement === 'FOOTER' && nn.condition && nn.condition !== fsrc.condition && noteConditionHolds(nn);
      })[0];
      if (falt && !noteAlreadyPresent(falt)) footer[j] = { title: falt.title, body: falt.body };
      else footer.splice(j, 1);
      changed++;
    }
    pb.meta.footerNotes = footer;
    return changed;
  }

  /** Every part on the proposal gets a chance to pull its notes in. */
  function applyAllTriggeredNotes() {
    var added = 0;
    (pb.lines || []).slice().forEach(function (l) {
      if (!l || l.lineType !== 'PRODUCT' || !l.sku) return;
      added += applyTriggeredNotes(l.sku, pb.lines.indexOf(l));
    });
    return added;
  }

  /**
   * Where a freshly picked part belongs in the line list.
   *
   * Appending was leaving reps to drag every new part up into place. The catalog
   * already knows the answer: /catalog/items/defaults carries a sortKey built from
   * the category tree and the product's own sort order, so a part can be dropped
   * straight into position.
   *
   * The catalogue also names the tiers a part belongs to, so a proposal that does
   * not yet have that group or sub-heading gets it: adding SKU 1001 to a bare
   * proposal creates "THERAPEUTIC ACTIVITY & ADVENTURE COMPONENTS", then
   * "Therapeutic Swing & Sensory Equipment Package" under it, then the line.
   *
   * Two rules keep this predictable rather than clever:
   *
   *   - Nothing already on the proposal moves. Only the new line is placed, and a
   *     heading is only ever added, never renamed or reordered. A rep who has
   *     hand-ordered a section keeps that order.
   *   - The line lands in the section its category is already in, if there is one;
   *     otherwise in the section currently being built, which is where it landed
   *     before. It never jumps across a group header on a guess.
   *
   * A part with no sortKey — anything the catalog does not place — appends, exactly
   * as it used to.
   */
  function isSectionHeader(l) { return l && (l.lineType === 'GROUP' || l.lineType === 'SUBGROUP'); }
  /** Bundle components are the '— ' rows that must stay under their parent line. */
  function isBundleChild(l) { return !!l && l.lineType === 'PRODUCT' && /^—\s/.test(String(l.name || '')); }

  function isGroupHeader(l) { return !!l && l.lineType === 'GROUP'; }
  function isSubHeader(l) { return !!l && l.lineType === 'SUBGROUP'; }
  /**
   * A heading reduced to something comparable.
   *
   * The engine decorates the headings it writes — "Adventure Mat System (Highly
   * Recommended)", "… (Optional)" — while the catalogue category behind the same
   * section is the plain name. Comparing the two literally never matched, so a part
   * picked into an existing section either grew a second heading or fell to the bottom
   * of the proposal. The trailing parenthetical and any surrounding punctuation come off
   * before comparing; a rep who retitled a heading in their own words still keeps it,
   * they just do not get automatic filing into it.
   */
  function headingKey(s) {
    return String(s || '')
      .replace(/\s*\([^()]*\)\s*$/g, '')
      .replace(/[\s\u2013\u2014\-—:]+$/, '')
      .trim()
      .toLowerCase();
  }
  function sameHeading(a, b) {
    var x = headingKey(a), y = headingKey(b);
    return !!x && x === y;
  }

  /** The group heading that owns index i, or -1 when i sits above the first one. */
  function groupIndexBefore(i) {
    for (var j = i - 1; j >= 0; j--) if (isGroupHeader(pb.lines[j])) return j;
    return -1;
  }

  /**
   * The heading on this proposal that a part belongs under, matched on any name in its
   * catalogue ancestry. Sub-headings are checked first so the deepest match wins — a
   * part filed under "Adventure Mat System" lands in that sub-heading rather than at
   * the top of the group of the same name.
   */
  function findHeadingFor(labels) {
    var i, k;
    for (i = 0; i < pb.lines.length; i++) {
      if (!isSubHeader(pb.lines[i])) continue;
      for (k = labels.length - 1; k >= 0; k--) {
        if (sameHeading(pb.lines[i].name, labels[k])) return { index: i, isSub: true };
      }
    }
    for (i = 0; i < pb.lines.length; i++) {
      if (!isGroupHeader(pb.lines[i])) continue;
      for (k = 0; k < labels.length; k++) {
        if (sameHeading(pb.lines[i].name, labels[k])) return { index: i, isSub: false };
      }
    }
    return null;
  }

  /**
   * A part's catalogue tree position as one padded segment per tier, e.g.
   * ['00002', '00001']. Null for a part the catalogue does not place — those carry a
   * sortKey beginning "z|" and are appended rather than filed.
   */
  function tierKeys(d) {
    var tree = String((d && d.sortKey) || '').split('|')[0];
    if (!tree || tree.charAt(0) === 'z') return null;
    return tree.split('.');
  }

  /**
   * Where an existing heading sits in the catalogue, read off the parts filed under
   * it — the lowest tree key among them. A heading with no placed parts under it
   * returns null and simply keeps its position.
   */
  function spanTierKey(from, to, depth) {
    var best = null;
    for (var i = from; i < to; i++) {
      var l = pb.lines[i];
      if (!l || l.lineType !== 'PRODUCT' || !l.sku) continue;
      var k = tierKeys(itemDefaults[l.sku]);
      if (!k) continue;
      var v = (depth ? k.slice(0, depth) : k).join('.');
      if (best === null || v < best) best = v;
    }
    return best;
  }

  /** End of the group heading at gi: the next group heading, or the end of the list. */
  function groupSpanEnd(gi) {
    for (var i = gi + 1; i < pb.lines.length; i++) if (isGroupHeader(pb.lines[i])) return i;
    return pb.lines.length;
  }

  function insertLineInOrder(line) {
    var d = line && line.sku ? itemDefaults[line.sku] : null;
    if (!d) { pb.lines.push(line); return; }
    var key = d.sortKey || '';
    var path = Array.isArray(d.path) ? d.path.filter(Boolean) : [];
    var keys = tierKeys(d);
    // Names this part could be filed under. A part carried only as a Sku row has no
    // category tree, but it does have a category name — and that name is usually the
    // section it belongs in, which is enough to file it. Without this fallback those
    // parts appended, which is what happened to the floor padding.
    var labels = path.length ? path : (d.category ? [String(d.category)] : []);
    if (!labels.length) { pb.lines.push(line); return; }

    var groupLabel = path.length ? path[0] : labels[0];
    var subLabel = path.length > 1 ? path[path.length - 1] : '';
    var groupKey = keys ? keys[0] : '';
    var subKey = keys ? keys.join('.') : '';
    var i, j;

    // ---- an existing heading first, and only then a new one ----
    // Matching what is already on the proposal is what keeps a picked part out of the
    // bottom of the document. Building headings needs a tree position to place them by,
    // so a part without one is filed if a heading matches and appended if none does.
    var found = findHeadingFor(labels);
    var gi = -1, si = -1;
    if (found && found.isSub) { si = found.index; gi = groupIndexBefore(si); }
    else if (found) gi = found.index;

    if (gi === -1 && si === -1) {
      if (!keys) { pb.lines.push(line); return; }
      var gAt = pb.lines.length;
      for (i = 0; i < pb.lines.length; i++) {
        if (!isGroupHeader(pb.lines[i])) continue;
        var gk = spanTierKey(i + 1, groupSpanEnd(i), 1);
        if (gk !== null && gk > groupKey) { gAt = i; break; }
      }
      pb.lines.splice(gAt, 0, { ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: groupLabel, description: '', quantity: 0, rateMinor: 0, group: '', optional: false });
      gi = gAt;
    }
    // A sub-heading matched with no group above it: treat the whole run as the span.
    var gEnd = gi === -1 ? pb.lines.length : groupSpanEnd(gi);

    // ---- the sub-heading ----
    var from = gi + 1, to = gEnd;
    if (si !== -1) {
      from = si + 1;
      to = gEnd;
      for (i = from; i < gEnd; i++) if (isSubHeader(pb.lines[i]) || isGroupHeader(pb.lines[i])) { to = i; break; }
    } else if (subLabel && keys) {
      for (i = from; i < gEnd; i++) {
        if (isSubHeader(pb.lines[i]) && sameHeading(pb.lines[i].name, subLabel)) { si = i; break; }
      }
      if (si === -1) {
        var sAt = gEnd;
        for (i = from; i < gEnd; i++) {
          if (!isSubHeader(pb.lines[i])) continue;
          var sEnd = gEnd;
          for (j = i + 1; j < gEnd; j++) if (isSubHeader(pb.lines[j])) { sEnd = j; break; }
          var sk = spanTierKey(i + 1, sEnd, 0);
          if (sk !== null && sk > subKey) { sAt = i; break; }
        }
        pb.lines.splice(sAt, 0, { ref: uid(), lineType: 'SUBGROUP', kind: 'SUBGROUP', name: subLabel, description: '', quantity: 0, rateMinor: 0, group: '' });
        si = sAt;
        gEnd++;
      }
      from = si + 1;
      to = gEnd;
      for (i = from; i < gEnd; i++) if (isSubHeader(pb.lines[i]) || isGroupHeader(pb.lines[i])) { to = i; break; }
    } else {
      // Filed at the top of the tree, so above this group's first sub-heading.
      for (i = from; i < gEnd; i++) if (isSubHeader(pb.lines[i])) { to = i; break; }
    }
    if (from < 0) from = 0;

    // ---- position among its siblings ----
    // First placed sibling that sorts after the new part. Bundle children are
    // skipped so a line can never be dropped between a bundle and its components.
    var at = to;
    if (key) {
      for (i = from; i < to; i++) {
        var l = pb.lines[i];
        if (!l || l.lineType !== 'PRODUCT' || !l.sku || isBundleChild(l)) continue;
        var ld = itemDefaults[l.sku];
        if (ld && ld.sortKey && String(ld.sortKey) > String(key)) { at = i; break; }
      }
    }
    // A section's triggered notes sit at its end; products belong above them.
    if (at === to) while (at > from && pb.lines[at - 1] && pb.lines[at - 1].lineType === 'NOTE') at--;
    // Never land between a parent bundle line and its components.
    while (at < pb.lines.length && isBundleChild(pb.lines[at])) at++;
    pb.lines.splice(at, 0, line);
  }

  /**
   * Included product lines priced at $0.00 that the catalog has a price for.
   *
   * A line's price is snapshotted when the line is inserted — deliberately, so that
   * reopening a saved proposal cannot silently re-price it. The failure was that
   * nothing said so: a part priced in the catalog after a proposal was built sat at
   * $0.00 and looked intentional. This is what drives the warning and the re-pull.
   */
  function stalePricedLines() {
    return pb.lines.filter(function (l) {
      if (l.lineType !== 'PRODUCT' || l.kind !== 'INCLUDED' || !l.sku) return false;
      var d = itemDefaults[l.sku];
      if (!d) return false;
      return (!(Number(l.rateMinor) || 0) && d.priceMinor > 0)
        || (!(Number(l.costEach) || 0) && d.costMinor > 0)
        || (!(Number(l.weightEach) || 0) && d.weightLbs > 0);
    });
  }

  /** Included product lines the catalog has no price for at all. */
  function unpricedLines() {
    return pb.lines.filter(function (l) {
      if (l.lineType !== 'PRODUCT' || l.kind !== 'INCLUDED' || !l.sku) return false;
      if (Number(l.rateMinor) || 0) return false;
      var d = itemDefaults[l.sku];
      return !d || !d.priceMinor;
    });
  }

  /* --- Freight: weight out to monday.com, amount back --- */

  /**
   * Request Freight and the amount beside it. Red until the request has actually
   * reached the board, green afterwards — the colour reports what monday.com holds,
   * not that the button was clicked, so a failed push stays red.
   *
   * The amount is pulled on demand rather than polled: it is entered by the freight
   * desk hours or days later, and a stale cached number on a customer proposal is
   * worse than an empty one.
   */
  /**
   * Has the board actually got an outstanding request on it?
   *
   * monday.com's own flag decides, not our local one. A proposal copied from a
   * template, or a new version of an old proposal, carries a local
   * freightRequestedAt that says "requested" while the board has nothing — which is
   * how a proposal goes out with freight nobody was ever asked for. `null` means we
   * have not read the board yet, and then the local flag stands in.
   */
  function freightRequestedOnBoard() {
    var flag = pb.meta.freightBoardFlag;
    if (flag == null || flag === '') return !!pb.meta.freightRequestedAt;
    return String(flag).trim().toLowerCase() === 'yes';
  }

  function freightControlsHtml() {
    // Freight is an internal conversation with the desk. Nothing about it belongs on a
    // screen a customer is looking at, and a mock has no board item to request against.
    if (isMock()) return '';
    var sent = freightRequestedOnBoard();
    var busy = pb.meta.freightBusy || '';
    var quote = pb.meta.freightQuoteMinor;
    // Three different states, and the wording has to separate them: nobody has asked
    // the desk yet, the desk has been asked and not answered, and the desk answered.
    var amtLabel = quote != null
      ? fmtMoney(quote, 'USD')
      : (sent ? (pb.meta.freightPending ? 'Awaiting the desk' : 'Not pulled yet') : 'Freight Needs to be Requested');
    var matsFreight = pb.meta.mondayMatsFreightMinor;
    var matsTax = pb.meta.mondayMatsTaxMinor;
    var matsFreightLabel = matsFreight != null ? fmtMoney(matsFreight, 'USD') : 'Not pulled yet';
    var matsTaxLabel = matsTax != null ? fmtMoney(matsTax, 'USD') : 'Not pulled yet';
    return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:nowrap;">' +
      '<button class="btn" id="bFreightReq" style="width:auto;padding:9px 16px;background:' + (sent ? '#2f6b4f' : '#9c3327') + ';border-color:transparent;">' +
        (busy === 'req' ? 'Sending\u2026' : (sent ? '\u2713 Freight Requested' : 'Request Freight')) +
      '</button>' +
      '<button class="btn" id="bFreightSync" style="width:auto;padding:9px 16px;background:#dbeafe;border:1px solid #93c5fd;color:#1e40af;">' +
        (busy === 'amt' ? 'Syncing\u2026' : 'Sync Request') +
      '</button>' +
      '<div style="padding:6px 14px;text-align:left;line-height:1.25;">' +
        '<span style="display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Structure Crating &amp; Freight $</span>' +
        '<span style="display:block;font-size:' + (quote == null && !sent ? '12px' : '14px') + ';font-weight:600;color:' + (quote != null ? '#20241f' : (sent ? '#8a8f85' : '#9c3327')) + ';">' +
          (busy === 'amt' ? 'Checking\u2026' : esc(amtLabel)) +
        '</span>' +
      '</div>' +
      '<div style="padding:6px 14px;text-align:left;line-height:1.25;">' +
        '<span style="display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Mats &amp; Padding Freight $</span>' +
        '<span style="display:block;font-size:14px;font-weight:600;color:' + (matsFreight != null ? '#20241f' : '#8a8f85') + ';">' +
          (busy === 'amt' ? 'Checking…' : esc(matsFreightLabel)) +
        '</span>' +
      '</div>' +
      '<div style="padding:6px 14px;text-align:left;line-height:1.25;">' +
        '<span style="display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Mats &amp; Padding Tax $</span>' +
        '<span style="display:block;font-size:14px;font-weight:600;color:' + (matsTax != null ? '#20241f' : '#8a8f85') + ';">' +
          (busy === 'amt' ? 'Checking…' : esc(matsTaxLabel)) +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function freightItemId() {
    var id = String(pb.meta.projectId || '').trim();
    return /^\d{4,}$/.test(id) ? id : '';
  }

  async function requestFreight() {
    var item = freightItemId();
    if (!item) return alert('This proposal needs its Project ID — that is the monday.com deal item the weight is written to.');
    var t = builderTotals();
    pb.meta.freightBusy = 'req'; renderBuilderKeepingFocus();
    var r = await authed('/proposals/' + pb.proposalId + '/freight-request', {
      method: 'POST',
      body: { itemId: item, weightLb: Math.round((Number(t.weight) || 0) * 100) / 100 },
    });
    pb.meta.freightBusy = '';
    if (!r.ok) { renderBuilderKeepingFocus(); return alert('monday.com did not accept the request (' + r.status + '). The button stays red — nothing was written.'); }
    var d = await r.json();
    pb.meta.freightRequestedAt = d.requestedAt;
    pb.meta.freightRequestedWeight = d.weightLb;
    renderBuilderKeepingFocus();
  }

  async function pullFreightAmount() {
    var item = freightItemId();
    if (!item) return alert('This proposal needs its Project ID — that is the monday.com deal item the amount is read from.');
    pb.meta.freightBusy = 'amt'; renderBuilderKeepingFocus();
    var r = await authed('/proposals/' + pb.proposalId + '/freight-amount?itemId=' + encodeURIComponent(item));
    pb.meta.freightBusy = '';
    if (!r.ok) { renderBuilderKeepingFocus(); return alert('Could not read the freight amount from monday.com (' + r.status + ').'); }
    var d = await r.json();
    pb.meta.freightBoardFlag = d.requestFlag || 'No';
    pb.meta.freightPending = !!d.pending;
    if (d.amountMinor != null) {
      pb.meta.freightQuoteMinor = d.amountMinor;
      // The amount the desk quoted IS the structure crating and freight line — the
      // proposal total should not need it typed a second time.
      pb.meta.structureFreightMinor = d.amountMinor;
    }
    pb.meta.mondayMatsFreightMinor = d.matsFreightMinor;
    pb.meta.mondayMatsTaxMinor = d.matsTaxMinor;
    // Same logic as the structure freight line above, but skipped once the user has
    // typed their own number — a pull should never clobber a manual correction.
    if (!pb.meta.matsFreightTouched) pb.meta.matsFreightMinor = pb.meta.mondayMatsFreightMinor;
    if (!pb.meta.taxTouched) pb.meta.taxAmountMinor = pb.meta.mondayMatsTaxMinor;
    renderBuilderKeepingFocus();
  }

  /**
   * The sync the rep would otherwise have to remember.
   *
   * Runs once when a proposal opens in the builder, never on save: the desk's number
   * arrives on monday.com's clock, and the figure on screen should be theirs rather
   * than whatever was cached the last time somebody pressed a button. Silent by
   * design — a proposal with no Project ID, or a board that cannot be reached, is
   * not something to interrupt the rep with on open. The manual "Sync Request"
   * button still reports failures out loud.
   */
  async function autoSyncFreightOnOpen() {
    if (!pb || pb.readOnly) return;
    var item = freightItemId();
    if (!item) return;
    try {
      var r = await authed('/proposals/' + pb.proposalId + '/freight-amount?itemId=' + encodeURIComponent(item));
      if (!r.ok) return;
      var d = await r.json();
      // Guard against a stale response: the rep may have left the builder, or opened
      // a different proposal, while this was in flight.
      if (!pb || pb.meta.projectId !== String(d.itemId)) return;
      pb.meta.freightBoardFlag = d.requestFlag || 'No';
      pb.meta.freightPending = !!d.pending;
      if (d.amountMinor != null) {
        pb.meta.freightQuoteMinor = d.amountMinor;
        pb.meta.structureFreightMinor = d.amountMinor;
      }
      pb.meta.mondayMatsFreightMinor = d.matsFreightMinor;
      pb.meta.mondayMatsTaxMinor = d.matsTaxMinor;
      if (!pb.meta.matsFreightTouched && d.matsFreightMinor != null) pb.meta.matsFreightMinor = d.matsFreightMinor;
      if (!pb.meta.taxTouched && d.matsTaxMinor != null) pb.meta.taxAmountMinor = d.matsTaxMinor;
      renderBuilderKeepingFocus();
    } catch (e) { /* silent on open — see above */ }
  }

  /** Pull catalog price, cost and weight onto the lines that are missing them. */
  function repullCatalogFigures() {
    var stale = stalePricedLines();
    if (!stale.length) return;
    var changed = [];
    stale.forEach(function (l) {
      var d = itemDefaults[l.sku], bits = [];
      if (!(Number(l.rateMinor) || 0) && d.priceMinor) { l.rateMinor = d.priceMinor; bits.push('rate'); }
      if (!(Number(l.costEach) || 0) && d.costMinor) { l.costEach = d.costMinor; bits.push('cost'); }
      if (!(Number(l.weightEach) || 0) && d.weightLbs) { l.weightEach = d.weightLbs; bits.push('weight'); }
      if (bits.length) changed.push(l.sku + ' (' + bits.join(', ') + ')');
    });
    markBuilderDirty();
    renderBuilder();
    alert('Updated ' + changed.length + ' line' + (changed.length === 1 ? '' : 's') + ' from the catalog:\n\n' + changed.join('\n') + '\n\nSave the proposal to keep this.');
  }

  /**
   * Two different problems, said plainly, because the fix differs:
   *   - the catalog HAS a price and this line does not (fixable in one click)
   *   - the catalog has no price either (someone has to go price the part)
   */
  function priceWarningHtml() {
    var stale = stalePricedLines(), unpriced = unpricedLines();
    if (!stale.length && !unpriced.length) return '';
    var out = '';
    if (stale.length) {
      out += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:10px 12px;background:#fdf6e6;border:1px solid #ecd9a6;border-radius:9px;font-size:12.5px;color:#6b5a24;">' +
        '<div style="flex:1;min-width:240px;"><b>' + stale.length + ' line' + (stale.length === 1 ? ' is' : 's are') + ' missing a figure the catalog has.</b> ' +
          'A line keeps the price it had when it was added, so a part priced later stays at $0.00 until you pull it in.</div>' +
        '<button class="btn" id="bRepull" style="width:auto;padding:7px 13px;white-space:nowrap;">Pull from catalog</button></div>';
    }
    if (unpriced.length) {
      out += '<div style="margin-top:10px;padding:10px 12px;background:#fbecea;border:1px solid #e8c4bd;border-radius:9px;font-size:12.5px;color:#7d2f24;">' +
        '<b>' + unpriced.length + ' line' + (unpriced.length === 1 ? ' has' : 's have') + ' no price in the catalog either:</b> ' +
        '<code>' + unpriced.slice(0, 8).map(function (l) { return esc(l.sku); }).join('</code>, <code>') + '</code>' +
        (unpriced.length > 8 ? ' and ' + (unpriced.length - 8) + ' more' : '') +
        '. Price them under Catalog → Pricing &amp; SKUs, then use “Pull from catalog”.</div>';
    }
    return out;
  }

  function builderTotals() {
    var subtotal = 0, tpFreight = 0, weight = 0, cogs = 0;
    var groups = []; var cur = null;
    pb.lines.forEach(function (l) {
      if (l.lineType === 'GROUP') { cur = { name: l.name, optional: l.optional, subtotal: 0, cogs: 0 }; groups.push(cur); return; }
      if (l.lineType === 'PRODUCT') {
        var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
        var cst = (Number(l.quantity) || 0) * (Number(l.costEach) || 0);
        var tp = Number(l.tpFreightMinor) || 0;
        subtotal += amt; tpFreight += tp; cogs += cst;
        // A line with no weight on record counts as 0 lb — blanks in the catalog
        // are treated as zero weight, not as an unknown to be flagged.
        weight += (Number(l.quantity) || 0) * (Number(l.weightEach) || 0);
        if (cur) { cur.subtotal += amt + tp; cur.cogs += cst; }
      }
    });
    var disc = discountOf(pb.meta, subtotal);
    var discountPct = disc.pct, discountMode = disc.mode;
    var discount = disc.amount;
    var tax = metaAmount(pb.meta.taxAmountMinor, pb.meta.tbdTax);
    var structureFreight = metaAmount(pb.meta.structureFreightMinor, pb.meta.tbdStructureFreight);
    var matsFreight = metaAmount(pb.meta.matsFreightMinor, pb.meta.tbdMatsFreight);
    var stdFreight = stdFreightOf(pb.meta);
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight + stdFreight;
    var deposit = depositOf(total);
    var revenue = subtotal - discount + tpFreight;
    groups.forEach(function (g) { g.margin = g.subtotal - g.cogs; g.marginPct = g.subtotal ? Math.round((g.margin / g.subtotal) * 1000) / 10 : 0; });
    return { subtotal: subtotal, discountPct: discountPct, discountMode: discountMode, discount: discount, tpFreight: tpFreight, tax: tax, structureFreight: structureFreight, matsFreight: matsFreight, stdFreight: stdFreight, total: total, deposit: deposit, groups: groups, weight: weight,
      revenue: revenue, cogs: cogs, margin: revenue - cogs, marginPct: revenue ? Math.round(((revenue - cogs) / revenue) * 1000) / 10 : 0 };
  }
  // subtotal + cost per GROUP line index, for inline display in the builder
  function groupSubtotalMap() {
    var map = {}, curIdx = null;
    pb.lines.forEach(function (l, i) {
      if (l.lineType === 'GROUP') { curIdx = i; map[i] = { rev: 0, cogs: 0 }; return; }
      if (l.lineType === 'PRODUCT' && curIdx != null) {
        map[curIdx].rev += (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0) + (Number(l.tpFreightMinor) || 0);
        map[curIdx].cogs += (Number(l.quantity) || 0) * (Number(l.costEach) || 0);
      }
    });
    return map;
  }

  /**
   * Re-render the builder, keeping the keyboard where it was.
   *
   * Tab out of Qty, Rate or Cost and the field's `change` event fires — which
   * re-renders to update the totals, replaces the DOM, and destroys focus. Tab then
   * had nothing to move from and the caret vanished, which is why the keyboard could
   * not be used to walk the builder. The focused field is identified by its line and
   * key (not by node), so it survives being rebuilt; selection and caret position
   * come with it.
   */
  /**
   * Warn before closing while a proposal has unsaved edits.
   *
   * The builder holds everything in memory until Save, so a stray Cmd/Ctrl-W loses
   * the work with no way back. The browser only honours this if the user has
   * interacted with the page, and it deliberately cannot be triggered on a clean
   * document — a prompt that fires every time gets dismissed reflexively and then
   * protects nothing.
   */
  var pbDirty = false;
  function markBuilderDirty() {
    pbDirty = true;
    // Cheap: scheduleHardwareRefresh compares a signature of the fastener quantities
    // and does nothing at all unless one of them actually moved.
    scheduleHardwareRefresh();
  }
  function clearBuilderDirty() { pbDirty = false; }
  window.addEventListener('beforeunload', function (e) {
    if (!pbDirty) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  function renderBuilderKeepingFocus() {
    var el = document.activeElement;
    var sel = el && el.classList && el.classList.contains('bF')
      ? '.bF[data-i="' + el.getAttribute('data-i') + '"][data-k="' + el.getAttribute('data-k') + '"]'
      // The totals boxes are addressed by id, not by line/key. Without this branch a
      // re-render triggered from one of them threw the caret out of the field.
      : (el && el.id && /^m[A-Z]/.test(el.id) ? '#' + el.id : null);
    renderKeepingTab(renderBuilder, function () { return document.getElementById('view'); }, sel);
  }

  function renderBuilder() {
    var t = builderTotals();
    var gsub = groupSubtotalMap();
    var view = document.getElementById('view');
    var lineRows = pb.lines.map(function (l, i) { return builderLineRow(l, i, gsub); }).join('');
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
        '<button class="link-btn" id="bBack" style="width:auto;padding:7px 13px;">‹ Cancel</button>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          // A mock is priced on screen and nowhere else: no preview and no PDF, because
          // both lead to a printable customer document, and no save because there is no
          // proposal behind it. "Create Real Proposal" is the way out of read-only.
          (isMock()
            ? '<button class="btn" id="bMkReal" style="width:auto;padding:9px 18px;">Create Real Proposal…</button>' +
              '<button class="link-btn" id="bClose" style="width:auto;padding:9px 16px;">Close</button>'
            : '<button class="link-btn" id="bLoadTpl" style="width:auto;padding:9px 14px;">Load Template</button>' +
              '<button class="link-btn" id="bSaveTpl" style="width:auto;padding:9px 14px;">Save as Template</button>' +
              '<button class="link-btn" id="bPreview" style="width:auto;padding:9px 14px;">Preview</button>' +
              '<button class="link-btn" id="bPdf" style="width:auto;padding:9px 14px;">Save as PDF</button>' +
              '<button class="btn" id="bSave" style="width:auto;padding:9px 18px;">Save</button>' +
              '<button class="link-btn" id="bClose" style="width:auto;padding:9px 16px;">Close</button>') +
        '</div></div>' +
      // Who this proposal is for, and which version is open — the builder is
      // otherwise identical for every customer, and a rep with two tabs open has
      // no way to tell them apart.
      '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 16px;padding:12px 16px;background:#f7f8f4;border:1px solid #eef0ea;border-radius:10px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">' + (isMock() ? 'Mock proposal' : 'Prepared for') + '</div>' +
        '<div style="font-size:17px;font-weight:600;color:#26303a;">' + esc(isMock() ? 'No customer — nothing is saved' : (pb.orgName || '—')) + '</div>' +
        (pb.number ? '<div class="muted" style="font-size:12.5px;">' + esc(pb.number) + '</div>' : '') +
        '<div style="margin-left:auto;display:flex;align-items:baseline;gap:8px;">' +
          (isMock() ? '' :
            '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Version</span>' +
            '<span style="font-size:13px;font-weight:600;color:#3d4a55;">v' + (pb.version || 1) + '</span>') +
          (pb.readOnly ? '<span class="muted" style="font-size:12px;">read only</span>' : '') +
        '</div>' +
      '</div>' +
      // header card
      '<div class="card" style="margin-bottom:16px;"><div class="section-title" style="margin:0 0 12px;">Proposal header</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
          fieldRow('Title', '<input id="mTitle" style="' + IN + '" value="' + esc(pb.title) + '">') +
          fieldRow('Prepared for', '<input style="' + IN + 'background:#f2f3ef;" value="' + esc(pb.orgName) + '" disabled>') +
          fieldRow('Contact name', '<input id="mContact" style="' + IN + '" placeholder="Full name of the customer contact" value="' + esc(pb.meta.contactName || '') + '">') +
          fieldRow('Proposal date', '<input id="mPropDate" type="date" style="' + IN + '" value="' + esc(pb.meta.proposalDate) + '">') +
          fieldRow('Project ID', '<input id="mProj" style="' + IN + '" value="' + esc(pb.meta.projectId) + '">') +
          fieldRow('Expiration date', '<input id="mExp" type="date" style="' + IN + '" value="' + esc(pb.meta.expiration) + '">') +
        '</div>' +
        '<div class="field" style="margin-top:4px;">' +
          '<label style="display:flex;align-items:baseline;gap:10px;">Bill to' +
            '<span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:12px;color:#8a8f85;display:flex;align-items:center;gap:5px;cursor:pointer;">' +
              '<input type="checkbox" id="mBillSame"' + (pb.meta.billSameAsShip ? ' checked' : '') + '> same as ship to' +
            '</span>' +
          '</label>' +
          '<textarea id="mBill" rows="2" placeholder="Billing address" style="' + IN + 'resize:vertical;">' + esc(pb.meta.billTo || '') + '</textarea></div>' +
        '<div class="field" style="margin-top:4px;"><label>Ship to</label><textarea id="mShip" rows="2" style="' + IN + 'resize:vertical;">' + esc(pb.meta.shipTo) + '</textarea></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowTitle"' + (pb.meta.showTitle !== false ? ' checked' : '') + '> Show the proposal title on the customer proposal</label>' +
        priceWarningHtml() +
        // Running shipment weight, recalculated on every edit. Read-only: it is the
        // sum of the lines, and a typed override would quietly disagree with them.
        // Lines with no weight on record contribute 0 lb.
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:14px;padding:10px 12px;background:#f7f8f4;border:1px solid #eef0ea;border-radius:9px;">' +
          '<div style="display:flex;align-items:baseline;gap:10px;flex:1;min-width:260px;">' +
            '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Estimated shipment weight</div>' +
            '<div style="font-size:16px;font-weight:600;">' + (Number(t.weight) || 0).toFixed(2) + ' lb</div>' +
            '<div class="muted" style="font-size:11.5px;">Sum of all included lines</div>' +
          '</div>' +
          freightControlsHtml() +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowProj"' + (pb.meta.showProjectId ? ' checked' : '') + '> Show Project ID on the customer proposal</label>' +
        // Not every job takes a deposit. Unchecked, the deposit line is left off the
        // customer proposal entirely rather than printed as $0.
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:6px;cursor:pointer;"><input type="checkbox" id="mShowDeposit"' + (pb.meta.showDeposit !== false ? ' checked' : '') + '> Show the ' + depositPct() + '% deposit on the customer proposal</label>' +
      '</div>' +
      // quick add
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px;"><div class="section-title" style="margin:0;">Add to proposal</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;">' +
            '<button class="btn" id="bAdvSeries" style="width:auto;padding:9px 16px;background:#3d4a55;">⚙ Start from Adventure Series</button>' +
            '<button class="btn" id="bSoarSeries" style="width:auto;padding:9px 16px;background:#3d4a55;">⚙ Start from Summit Soar</button>' +
            '<button class="btn" id="bFlexSeries" style="width:auto;padding:9px 16px;background:#3d4a55;">⚙ Start from Summit Flex</button>' +
          '</div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
          '<button class="btn" id="bAddProd" style="width:auto;padding:9px 15px;">+ Product Line</button>' +
          '<button class="link-btn" id="bAddGroup" style="width:auto;padding:9px 15px;">+ Group Section</button>' +
          '<button class="link-btn" id="bAddSub" style="width:auto;padding:9px 15px;">+ Sub-Heading</button>' +
          // The hardware audit, reachable from the proposal itself rather than only
          // from the kit line — enabled whenever this draft has a kit line on it.
          (hardwareKitLine()
            ? '<button class="link-btn" id="bHwTest" style="width:auto;padding:9px 15px;">Test The Hardware Logic →</button>'
            : '') +
          '<select id="bAddNote" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13.5px;background:#fff;"><option value="">+ Standard Note…</option>' + (pb.stdNotes || []).map(function (nn, ni) { return '<option value="' + ni + '">' + esc(nn.title) + (nn.placement === 'FOOTER' ? ' — footer' : '') + '</option>'; }).join('') + '<option value="__custom">Custom Note…</option></select>' +
        '</div>' +
        '<div style="font-size:12px;color:#8a8f85;margin-bottom:6px;">Optional product groups (click to add a section heading):</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + STD_GROUPS.map(function (g) { return '<button class="grpChip" data-g="' + esc(g) + '" style="border:1px solid #dcded7;background:#fff;border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer;color:#3d4a55;">' + esc(g) + '</button>'; }).join('') + '</div>' +
      '</div>' +
      // lines
      // Engineering warnings from the pricing engine — internal, never printed.
      ((pb.meta.advWarnings || []).length
        ? '<div class="card" style="margin-bottom:12px;background:#fbecea;border:1px solid #f0d5d0;">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9c3327;font-weight:600;margin-bottom:6px;">Check before sending — internal only</div>' +
            (pb.meta.advWarnings || []).map(function (w) { return '<div style="font-size:12.5px;color:#7d2a20;line-height:1.6;">' + esc(w) + '</div>'; }).join('') +
          '</div>'
        : '') +
      '<div class="section-title">Line items <span class="muted" style="font-weight:400;font-size:12px;">— drag rows to reorder</span></div>' +
      '<div id="bLines" style="display:flex;flex-direction:column;gap:8px;">' + (lineRows || '<div class="placeholder" style="padding:26px;"><p class="muted" style="margin:0;">No lines yet. Add a product line or load a template.</p></div>') + '</div>' +
      // totals
      '<div class="card" style="margin-top:16px;max-width:390px;margin-left:auto;">' +
        '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;"><span class="muted">Subtotal</span><span>' + fmtUsd(t.subtotal) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;font-size:14px;"><span class="muted">Discount</span>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<select id="mDiscMode" style="padding:5px 6px;border:1px solid #dcded7;border-radius:7px;font-size:13px;">' +
              '<option value="PCT"' + (pb.meta.discountMode === 'AMT' ? '' : ' selected') + '>%</option>' +
              '<option value="AMT"' + (pb.meta.discountMode === 'AMT' ? ' selected' : '') + '>$</option>' +
            '</select>' +
            '<input id="mDisc" style="width:80px;padding:5px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;" value="' + esc(pb.meta.discountMode === 'AMT' ? ((Number(pb.meta.discountAmountMinor) || 0) / 100).toFixed(2) : pb.meta.discountPct) + '">' +
          '</div></div>' +
        (t.discount ? '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:14px;color:#9c3327;"><span>' + discountLabel(t) + '</span><span>− ' + fmtMoney(t.discount, 'USD') + '</span></div>' +
          '<div style="font-size:11px;color:#8a8f85;text-align:right;margin-bottom:2px;">Discount expires ' + (pb.meta.expiration ? fmtDate(pb.meta.expiration) : 'with the proposal') + '</div>' : '') +
        optionalAmountRow('Mat Freight Tax Pass-Through', 'mTax', pb.meta.taxAmountMinor, 'mTaxTbd', pb.meta.tbdTax) +
        // Crating and freight are quoted by the desk against a real shipment. A mock has
        // no shipment, so it quotes product retail and says so rather than showing $0.
        (isMock() ? '' :
          optionalAmountRow('Structure Crating &amp; Freight $', 'mStructFreight', pb.meta.structureFreightMinor, 'mStructFreightTbd', pb.meta.tbdStructureFreight) +
          optionalAmountRow('Mats &amp; Padding Freight $', 'mMatsFreight', pb.meta.matsFreightMinor, 'mMatsFreightTbd', pb.meta.tbdMatsFreight) +
          '<div style="font-size:11px;color:#8a8f85;text-align:right;margin:-2px 0 2px;">Left box prints in place of TBD when the amount is 0</div>' +
          stdFreightRow()) +
        '<div style="display:flex;justify-content:space-between;padding:8px 0 0;margin-top:6px;border-top:1px solid #e7e8e3;font-size:16px;font-weight:600;font-family:\'Newsreader\',serif;"><span>Total</span><span>' + fmtUsd(t.total) + '</span></div>' +
        (isMock() ? '<div class="muted" style="font-size:11.5px;text-align:right;margin-top:4px;line-height:1.5;">Product retail only. Crating, freight and tax are quoted on a real proposal.</div>' : '') +
        (pb.meta.showDeposit !== false ? '<div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:14px;color:#3d4a55;font-weight:600;"><span>Deposit due (' + depositPct() + '%)</span><span>' + fmtUsd(t.deposit) + '</span></div>' : '<div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:12.5px;color:#8a8f85;"><span>Deposit</span><span>Not shown on the proposal</span></div>') +
        // Read-only: the sum of quantity × per-unit weight across product lines. Drives
        // crating and freight, so it is worth seeing before those numbers are entered.
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 0;margin-top:6px;border-top:1px solid #e7e8e3;font-size:14px;">' +
          '<span class="muted">Total weight</span>' +
          '<span style="font-variant-numeric:tabular-nums;">' + fmtWeight(t.weight) + '</span>' +
        '</div>' +
      '</div>' +
      footerNotesCard() +
      (isMock() ? '' : '<div id="bMarginRail" style="' + marginRailStyle() + '">' + marginCard(t) + '<div id="bRfqRail"></div><div id="bDatesRail"></div><div id="bNotesRail"></div></div>');
    wireBuilder();
  }

  /** Notes that print below the signature lines on the customer proposal. */
  function footerNotesCard() {
    var fn = pb.meta.footerNotes || [];
    var rows = fn.map(function (n, i) {
      return '<div style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid #ece9db;border-radius:10px;padding:10px;margin-bottom:8px;">' +
        '<div style="flex:1;"><input class="bFN" data-i="' + i + '" data-k="title" value="' + esc(n.title || '') + '" placeholder="Note title (optional)" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        '<textarea class="bFN" data-i="' + i + '" data-k="body" rows="3" placeholder="Note text — **bold** supported" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(n.body || '') + '</textarea></div>' +
        '<button class="bFNDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:30px;height:30px;color:#9c3327;cursor:pointer;flex:0 0 auto;">✕</button></div>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;"><div class="section-title" style="margin:0;">Notes below the signature lines</div>' +
        '<button class="link-btn" id="bAddFooter" style="width:auto;padding:7px 12px;">+ Add note</button></div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:10px;">Printed at the foot of the proposal, under the signature block. Standard footer notes flagged “always include” in Administration appear here automatically.</div>' +
      (rows || '<div class="muted" style="font-size:12.5px;">None yet.</div>') + '</div>';
  }

  /** The profitability rail floats beside the builder when there is room; otherwise it stacks. */
  /** Internal figures, so a mock never renders the rail at all — see isMock(). */
  function marginRailStyle() {
    return window.innerWidth >= 1680
      ? 'position:fixed;top:92px;right:22px;width:342px;max-height:calc(100vh - 116px);overflow:auto;z-index:20;'
      : 'margin-top:16px;';
  }

  /** Internal-only profitability panel: never rendered on the customer proposal. */
  function marginCard(t) {
    function stat(label, value, color, big) {
      return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:5px 0;">' +
        '<span style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">' + label + '</span>' +
        '<span style="font-size:' + (big ? '19px' : '15px') + ';font-weight:600;font-family:\'Newsreader\',serif;color:' + (color || '#20241f') + ';">' + value + '</span></div>';
    }
    var mColor = t.margin >= 0 ? '#2f7d5d' : '#9c3327';
    var rows = t.groups.map(function (g) {
      var c = g.margin >= 0 ? '#2f7d5d' : '#9c3327';
      return '<div style="padding:8px 0;border-bottom:1px solid #ece7d8;">' +
        '<div style="font-size:12px;font-weight:600;line-height:1.35;">' + esc(tc(stripOptional(g.name || 'Untitled section'))) + (g.optional ? ' <span style="font-weight:400;color:#8a8f85;">(Optional)</span>' : '') + '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:#5c6157;margin-top:3px;">' +
          '<span>Rev ' + fmtMoney(g.subtotal, '') + '</span>' +
          '<span>COGS ' + fmtMoney(g.cogs, '') + '</span>' +
          '<span style="color:' + c + ';font-weight:600;">' + fmtMoney(g.margin, '') + ' · ' + g.marginPct + '%</span>' +
        '</div></div>';
    }).join('');
    // Says "internal only" on its own face, so it has no business on a screen turned
    // toward a customer.
    if (isMock()) return '';
    return '<div class="card" style="border:1px solid #e4dfd0;background:#fdfcf7;">' +
      '<div class="section-title" style="margin:0 0 2px;">Profitability</div>' +
      '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">Internal only — not printed</div>' +
      stat('Revenue', fmtMoney(t.revenue, 'USD'), null, 1) +
      stat('COGS', fmtMoney(t.cogs, 'USD')) +
      stat('Margin', fmtMoney(t.margin, 'USD'), mColor, 1) +
      stat('Margin %', t.marginPct + '%', mColor) +
      (rows ? '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #ece7d8;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:2px;">By section</div>' + rows + '</div>'
        : '<div class="muted" style="font-size:12px;margin-top:10px;">Add a section heading to see per-section margin.</div>') +
      (t.cogs === 0 ? '<div style="margin-top:10px;font-size:11.5px;color:#8a6d1f;line-height:1.5;">No costs recorded yet — add unit costs in Catalog → Pricing &amp; SKUs, or type a cost on any line.</div>' : '') +
    '</div>';
  }

  /* --- Request for Freight -------------------------------------------------
     Third-party freight is quoted by the vendor who ships the goods, so the rail
     asks for one request per vendor and the document carries only the lines that
     are actually travelling. Everything here is available after release too:
     freight is usually the last unknown on a job, and the proposal has often gone
     to the customer before a carrier has quoted it. */
  var rfqData = null;

  function rfqDate(iso) {
    if (!iso) return '\u2014';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function rfqStatusChip(status) {
    var map = { DRAFT: ['#8a6d1f', '#fdf6e6', 'Draft'], SENT: ['#2f7d5d', '#eaf4ef', 'Sent'], SUPERSEDED: ['#8a8f85', '#f2f3ef', 'Superseded'] };
    var m = map[status] || map.DRAFT;
    return '<span style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' + m[0] + ';background:' + m[1] + ';padding:2px 7px;border-radius:999px;">' + m[2] + '</span>';
  }

  /** Wider than openModal: an item list at 460px is unreadable. */
  function rfqOverlay(title, bodyHtml, footHtml) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.34);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:60;overflow:auto;';
    ov.innerHTML = '<div style="width:100%;max-width:720px;background:#fbfbf9;border:1px solid #e7e8e3;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.4);padding:22px 24px 20px;">' +
      '<h2 style="font-size:20px;margin-bottom:4px;">' + esc(title) + '</h2>' +
      '<div id="rfqErr"></div>' +
      '<div id="rfqBody">' + bodyHtml + '</div>' +
      '<div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end;">' + footHtml + '</div></div>';
    document.body.appendChild(ov);
    ov.close = function () { if (ov.parentNode) document.body.removeChild(ov); };
    ov.err = function (msg) { ov.querySelector('#rfqErr').innerHTML = '<div class="err">' + esc(msg) + '</div>'; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.close(); });
    return ov;
  }

  async function rfqApi(path, opts) {
    var r = await authed(path, opts);
    if (!r.ok) {
      var msg = 'Request failed (' + r.status + ').';
      try { var j = await r.json(); if (j && j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }

  function rfqCardHtml() {
    if (!rfqData) {
      return '<div class="card" style="margin-top:14px;"><div class="section-title" style="margin:0;">Freight requests</div>' +
        '<div class="muted" style="font-size:12px;margin-top:6px;">Loading\u2026</div></div>';
    }
    var waiting = rfqData.vendors.filter(function (v) { return v.rfqEnabled && !v.existingRfqId; });
    var prompt = freightActionHtml();
    if (!prompt && waiting.length) {
      var names = waiting.map(function (v) { return v.vendor; });
      var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
      prompt = '<div style="background:#fdf6e6;border:1px solid #ecd9a6;border-radius:10px;padding:10px 11px;margin-bottom:10px;">' +
        '<div style="font-size:12.5px;line-height:1.5;color:#6b5a24;">' + esc(list) + ' ' + (names.length > 1 ? 'supply' : 'supplies') + ' parts on this proposal and quote their own freight.</div>' +
        '<button class="btn" id="rfqAsk" style="width:auto;padding:8px 14px;margin-top:9px;font-size:13px;">Request freight quote</button></div>';
    }

    var rows = rfqData.rfqs.map(function (r) {
      var items = r.items.slice(0, 4).map(function (i) { return i.quantity + '\u00d7 ' + i.sku; }).join(' \u00b7 ');
      if (r.items.length > 4) items += ' \u00b7 +' + (r.items.length - 4) + ' more';
      return '<div style="padding:9px 0;border-bottom:1px solid #ece7d8;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">' +
          '<span style="font-size:12.5px;font-weight:600;">' + esc(r.vendor) + '</span>' + rfqStatusChip(r.status) + '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:#5c6157;margin-top:2px;">' +
          '<span>' + esc(r.reference) + '</span><span>' + rfqDate(r.requestedAt) + '</span></div>' +
        '<div style="font-size:11px;color:#8a8f85;margin-top:3px;line-height:1.45;">' + r.itemCount + ' item' + (r.itemCount === 1 ? '' : 's') + (items ? ' \u2014 ' + esc(items) : '') + '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button class="link-btn rfqOpen" data-id="' + r.id + '" style="width:auto;padding:5px 10px;font-size:12px;">' + (r.status === 'DRAFT' ? 'Edit &amp; send' : 'View') + '</button>' +
          (r.status === 'SENT' ? '<button class="link-btn rfqResend" data-id="' + r.id + '" style="width:auto;padding:5px 10px;font-size:12px;">Send again</button>' : '') +
          (r.status === 'SENT' ? '<button class="link-btn rfqRev" data-id="' + r.id + '" style="width:auto;padding:5px 10px;font-size:12px;">Revise</button>' : '') +
        '</div></div>';
    }).join('');

    return '<div class="card" style="margin-top:14px;border:1px solid #e4dfd0;background:#fdfcf7;">' +
      '<div class="section-title" style="margin:0 0 2px;">Freight requests</div>' +
      '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">Internal only \u2014 not printed</div>' +
      (rfqData.error ? '<div style="background:#fbecea;border:1px solid #f0ccc6;color:#9c3327;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:9px;margin-bottom:10px;">' + esc(rfqData.error) + '</div>' : '') +
      prompt +
      freightRemovedHtml() +
      (rows || '<div class="muted" style="font-size:12px;">None raised yet.</div>') +
    '</div>';
  }

  function wireRfqCard() {
    var ask = document.getElementById('rfqAsk');
    if (ask) ask.addEventListener('click', openRfqVendorPicker);
    var rail = document.getElementById('bRfqRail');
    if (!rail) return;
    rail.querySelectorAll('.rfqAskBtn').forEach(function (b) {
      b.addEventListener('click', openRfqVendorPicker);
    });
    rail.querySelectorAll('.rfqOpen').forEach(function (b) {
      b.addEventListener('click', function () { openRfqEditor(b.getAttribute('data-id')); });
    });
    // Sending again reuses the send dialog. The server assigns the "S2" suffix, so
    // nothing here needs to know how the reference is built.
    rail.querySelectorAll('.rfqResend').forEach(function (b) {
      b.addEventListener('click', function () { openRfqSend(b.getAttribute('data-id')); });
    });
    rail.querySelectorAll('.rfqRev').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        try {
          var next = await rfqApi('/rfqs/' + b.getAttribute('data-id') + '/revision', { method: 'POST', body: {} });
          await loadRfqPanel(true);
          openRfqEditor(next.id);
        } catch (e) { alert(e.message); b.disabled = false; }
      });
    });
  }

  function renderRfqRail() {
    paintFreightMarks();
    var el = document.getElementById('bRfqRail');
    if (!el) return;
    el.innerHTML = rfqCardHtml();
    wireRfqCard();
  }

  /* --- Customer dates and internal notes ----------------------------------
     Both belong to the CUSTOMER, not to this proposal. A rejected, expired or
     replaced proposal leaves the notes and the dates exactly where they were, which
     is the point: the account history has to outlive the quote it was written on.
     They save on their own, immediately, rather than waiting for Save — nothing here
     prints, so there is no draft state to keep them in. */
  var cnData = null;

  function cnStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function loadCustomerNotes(force) {
    if (!pb || isMock() || !pb.orgId) return;
    if (!force && cnData && cnData.organizationId === pb.orgId) { renderCustomerRail(); return; }
    if (force) cnData = null;
    renderCustomerRail();
    try {
      var r = await authed('/crm/organizations/' + pb.orgId + '/notes?proposalId=' + encodeURIComponent(pb.proposalId || ''));
      cnData = r.ok ? await r.json() : { error: 'Could not load internal notes.' };
    } catch (e) { cnData = { error: 'Could not load internal notes.' }; }
    renderCustomerRail();
  }

  /**
   * The two customer dates. The decision window is a range because a customer who
   * says "sometime after the board meets in March" has not given anyone a single day,
   * and a single-date field only invited a made-up one.
   */
  function cnDatesCardHtml() {
    var d = (cnData && cnData.dates) || {};
    var box = 'width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;font-size:13px;background:#fff;';
    var lbl = 'font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;';
    return '<div class="card" style="margin-top:14px;border:1px solid #e4dfd0;background:#fdfcf7;">' +
      '<div class="section-title" style="margin:0 0 2px;">Ideal Decision Timeline</div>' +
      '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:9px;">Kept On The Customer</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;"><label style="' + lbl + '">From</label>' +
          '<input type="date" id="cnFrom" value="' + esc(d.decisionFrom || '') + '" style="' + box + '"></div>' +
        '<div style="flex:1;"><label style="' + lbl + '">To</label>' +
          '<input type="date" id="cnTo" value="' + esc(d.decisionTo || '') + '" style="' + box + '"></div>' +
      '</div>' +
      '<div style="margin-top:12px;padding-top:11px;border-top:1px solid #ece7d8;">' +
        '<div class="section-title" style="margin:0 0 7px;">Follow-Up Date</div>' +
        '<input type="date" id="cnFollow" value="' + esc(d.followUpDate || '') + '" style="' + box + '">' +
        '<div class="muted" style="font-size:11px;line-height:1.5;margin-top:6px;">Counts toward the follow-ups due on the dashboard once the date arrives.</div>' +
      '</div>' +
      '<div id="cnDatesMsg" style="font-size:11.5px;line-height:1.5;margin-top:8px;"></div>' +
    '</div>';
  }

  function cnNoteHtml(n, me, admin) {
    var mine = n.authorId && n.authorId === me;
    return '<div style="padding:9px 0;border-bottom:1px solid #ece7d8;">' +
      '<div style="font-size:12.5px;line-height:1.55;white-space:pre-wrap;color:#20241f;">' + esc(n.body) + '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:4px;">' +
        '<span style="font-size:11px;color:#8a8f85;">' + esc(n.authorName || 'Unknown') + ' · ' + esc(cnStamp(n.createdAt)) +
          (n.proposalNumber ? ' · ' + esc(n.proposalNumber) : '') + '</span>' +
        (mine || admin ? '<button class="cnDel" data-id="' + n.id + '" title="Remove this note" style="border:none;background:transparent;color:#9c3327;font-size:11px;cursor:pointer;padding:0;">Remove</button>' : '') +
      '</div></div>';
  }

  function cnNotesCardHtml() {
    var head = '<div class="card" style="margin-top:14px;border:1px solid #e4dfd0;background:#fdfcf7;">' +
      '<div class="section-title" style="margin:0 0 2px;">Internal Notes</div>' +
      '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:9px;">Internal Only — Not Printed</div>';
    if (!cnData) return head + '<div class="muted" style="font-size:12px;">Loading…</div></div>';
    if (cnData.error) return head + '<div style="font-size:12px;color:#9c3327;line-height:1.5;">' + esc(cnData.error) + '</div></div>';

    var me = (pb.user && pb.user.id) || '';
    var admin = pb.user && pb.user.role === 'SYSTEM_ADMIN';
    var sub = 'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;margin:12px 0 2px;';

    return head +
      '<textarea id="cnBody" rows="3" placeholder="What should the next person to open this know?" style="width:100%;border:1px solid #dcded7;border-radius:9px;padding:8px 9px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;"></textarea>' +
      '<label style="display:flex;align-items:center;gap:7px;margin-top:7px;font-size:12px;color:#5c6157;cursor:pointer;" title="Filed against the customer instead of this proposal">' +
        '<input type="checkbox" id="cnAboutCustomer" style="width:14px;height:14px;accent-color:#3d4a55;cursor:pointer;">' +
        '<span>About the customer, not this proposal</span></label>' +
      '<button class="btn" id="cnAdd" style="width:auto;padding:7px 14px;margin-top:8px;font-size:13px;">Add Note</button>' +
      '<div id="cnMsg" style="font-size:11.5px;line-height:1.5;margin-top:6px;"></div>' +
      '<div style="' + sub + '">This Proposal</div>' +
      (cnData.proposal.length
        ? cnData.proposal.map(function (n) { return cnNoteHtml(n, me, admin); }).join('')
        : '<div class="muted" style="font-size:12px;">Nothing recorded against this proposal yet.</div>') +
      '<div style="' + sub + '">Customer</div>' +
      (cnData.customer.length
        ? cnData.customer.map(function (n) { return cnNoteHtml(n, me, admin); }).join('')
        : '<div class="muted" style="font-size:12px;">Nothing recorded about this customer yet.</div>') +
    '</div>';
  }

  function renderCustomerRail() {
    var dates = document.getElementById('bDatesRail');
    var notes = document.getElementById('bNotesRail');
    if (!dates || !notes) return;
    dates.innerHTML = cnDatesCardHtml();
    notes.innerHTML = cnNotesCardHtml();
    wireCustomerRail();
  }

  /** PATCHes one date. Saves as soon as the field is left — see the block comment. */
  async function cnSaveDates(patch) {
    var msg = document.getElementById('cnDatesMsg');
    try {
      var r = await authed('/crm/organizations/' + pb.orgId + '/dates', { method: 'PATCH', body: patch });
      if (!r.ok) {
        var m = 'Could not save.';
        try { var j = await r.json(); if (j && j.message) m = j.message; } catch (e) {}
        if (msg) msg.innerHTML = '<span style="color:#9c3327;">' + esc(m) + '</span>';
        return;
      }
      var d = await r.json();
      if (cnData) cnData.dates = d;
      if (msg) msg.innerHTML = '<span style="color:#2f7d5d;">Saved.</span>';
    } catch (e) {
      if (msg) msg.innerHTML = '<span style="color:#9c3327;">Could not save.</span>';
    }
  }

  function wireCustomerRail() {
    [['cnFrom', 'decisionFrom'], ['cnTo', 'decisionTo'], ['cnFollow', 'followUpDate']].forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (!el) return;
      el.addEventListener('change', function () {
        var patch = {}; patch[p[1]] = el.value || '';
        cnSaveDates(patch);
      });
    });
    var add = document.getElementById('cnAdd');
    if (add) add.addEventListener('click', async function () {
      var ta = document.getElementById('cnBody');
      var msg = document.getElementById('cnMsg');
      var body = (ta.value || '').trim();
      if (!body) { ta.focus(); return; }
      var aboutCustomer = document.getElementById('cnAboutCustomer').checked;
      add.disabled = true;
      try {
        var r = await authed('/crm/organizations/' + pb.orgId + '/notes', {
          method: 'POST',
          body: { body: body, proposalId: aboutCustomer ? null : pb.proposalId },
        });
        if (!r.ok) throw new Error('Could not save the note.');
        await loadCustomerNotes(true);
      } catch (e) {
        add.disabled = false;
        if (msg) msg.innerHTML = '<span style="color:#9c3327;">' + esc(e.message) + '</span>';
      }
    });
    document.querySelectorAll('.cnDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Remove this note? The log cannot be edited, so this cannot be undone.')) return;
        b.disabled = true;
        try {
          var r = await authed('/customer-notes/' + b.getAttribute('data-id'), { method: 'DELETE' });
          if (!r.ok) throw new Error('Could not remove the note.');
          await loadCustomerNotes(true);
        } catch (e) { b.disabled = false; alert(e.message); }
      });
    });
  }

  /** The freight state of one SKU, from the coverage that came back with the rail. */
  function freightStateOf(sku) {
    var cov = rfqData && rfqData.cov;
    var k = String(sku || '').trim().toLowerCase();
    if (!cov || !k) return '';
    var hit = (cov.lines || []).filter(function (l) { return String(l.sku || '').trim().toLowerCase() === k; })[0];
    return hit ? hit.state : '';
  }

  /**
   * Beside a product line: a green thumbs up once a vendor has been asked to quote
   * its freight, a red dot while nobody has. Silent for parts whose vendor does not
   * quote freight for us \u2014 there is nothing to chase.
   */
  function freightMarkHtml(sku) {
    var st = freightStateOf(sku);
    if (st === 'REQUESTED') return '<span title="Freight requested" style="font-size:12px;line-height:1;">\uD83D\uDC4D</span>';
    if (st === 'DRAFT') return '<span title="On a freight request that has not been sent" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#d9a520;"></span>';
    if (st === 'PENDING') return '<span title="No freight quote requested" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#c8483a;"></span>';
    return '';
  }

  function freightStateChip(state) {
    var map = {
      REQUESTED: ['#2f7d5d', '#eaf4ef', 'Freight requested'],
      DRAFT: ['#8a6d1f', '#fdf6e6', 'Request not sent'],
      PENDING: ['#9c3327', '#fbecea', 'Not requested'],
      NA: ['#8a8f85', '#f2f3ef', 'No freight quote'],
    };
    var m = map[state] || map.NA;
    return '<span style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:' + m[0] + ';background:' + m[1] + ';padding:3px 8px;border-radius:999px;white-space:nowrap;">' + m[2] + '</span>';
  }

  /** Marks are painted after the rail loads, so a builder render never waits on it. */
  function paintFreightMarks() {
    document.querySelectorAll('.bFreightMark').forEach(function (el) {
      el.innerHTML = freightMarkHtml(el.getAttribute('data-sku'));
    });
  }

  /**
   * What still has to be sent, per vendor. This is the prompt that has to reappear
   * when a line is added to a proposal whose freight was already requested: the
   * vendor quoted a shipment that no longer matches, so the answer is a revision
   * rather than a second request.
   */
  function freightActionHtml() {
    var cov = rfqData && rfqData.cov;
    if (!cov) return '';
    var out = '', seen = {};
    (cov.pendingVendors || []).forEach(function (v) {
      seen[String(v.vendor).toLowerCase()] = true;
      var many = v.lineCount === 1 ? '' : 's';
      var btn = v.existingStatus === 'SENT'
        ? '<button class="btn rfqRev" data-id="' + v.existingRfqId + '" style="width:auto;padding:8px 14px;margin-top:9px;font-size:13px;background:#9c3327;">Revise ' + esc(v.existingReference || 'the request') + '</button>'
        : v.existingStatus === 'DRAFT'
          ? '<button class="btn rfqOpen" data-id="' + v.existingRfqId + '" style="width:auto;padding:8px 14px;margin-top:9px;font-size:13px;background:#9c3327;">Finish and send the request</button>'
          : '<button class="btn rfqAskBtn" style="width:auto;padding:8px 14px;margin-top:9px;font-size:13px;background:#9c3327;">Request freight quote</button>';
      out += '<div style="background:#fbecea;border:1px solid #f0ccc6;border-radius:10px;padding:10px 11px;margin-bottom:8px;">' +
        '<div style="font-size:12.5px;line-height:1.5;color:#7d2a20;"><b>' + esc(v.vendor) + '</b> \u2014 ' + v.lineCount + ' item' + many +
          ' with no freight request' + (v.existingStatus === 'SENT' ? ' since ' + esc(v.existingReference || 'the last request') + ' went out' : '') + '.</div>' +
        btn + '</div>';
    });
    // A request that was raised and never emailed is still an open action.
    var drafts = {};
    (cov.lines || []).forEach(function (l) {
      if (l.state !== 'DRAFT' || !l.rfqId || seen[String(l.vendor || '').toLowerCase()]) return;
      drafts[l.rfqId] = drafts[l.rfqId] || { id: l.rfqId, reference: l.reference, vendor: l.vendor, count: 0 };
      drafts[l.rfqId].count += 1;
    });
    Object.keys(drafts).forEach(function (k) {
      var d = drafts[k];
      out += '<div style="background:#fdf6e6;border:1px solid #ecd9a6;border-radius:10px;padding:10px 11px;margin-bottom:8px;">' +
        '<div style="font-size:12.5px;line-height:1.5;color:#6b5a24;"><b>' + esc(d.reference || 'A request') + '</b> for ' + esc(d.vendor || 'this vendor') +
          ' has been raised but never sent \u2014 ' + d.count + ' item' + (d.count === 1 ? '' : 's') + '.</div>' +
        '<button class="btn rfqOpen" data-id="' + d.id + '" style="width:auto;padding:8px 14px;margin-top:9px;font-size:13px;">Finish and send</button></div>';
    });
    return out;
  }

  /** Lines the vendor is still quoting that have come off the proposal since. */
  function freightRemovedHtml() {
    var cov = rfqData && rfqData.cov;
    if (!cov || !(cov.removed || []).length) return '';
    return '<div style="border:1px dashed #f0ccc6;background:#fdf7f6;border-radius:10px;padding:10px 11px;margin-bottom:10px;">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#9c3327;margin-bottom:6px;">Off the proposal \u2014 still on the request</div>' +
      cov.removed.map(function (r) {
        return '<div style="font-size:12px;line-height:1.5;color:#9c3327;text-decoration:line-through;text-decoration-color:#c8483a;">' +
            (Number(r.quantity) || 0) + '\u00d7 ' + esc(r.sku) + ' \u2014 ' + esc(r.name) + '</div>' +
          '<div style="font-size:11px;color:#8a8f85;margin:1px 0 6px;">' + esc(r.reference) + ' \u00b7 ' + esc(r.vendor) + '</div>';
      }).join('') +
      '<div style="font-size:11.5px;color:#7d2a20;line-height:1.5;">Revise the request so the vendor quotes what is actually shipping.</div></div>';
  }

  /** Cached per version and per line set: the rail re-renders on every keystroke. */
  function rfqLineSignature() {
    if (!pb) return '';
    return pb.lines.filter(function (l) { return (l.lineType || 'PRODUCT') === 'PRODUCT' && l.sku && !l.optional; })
      .map(function (l) { return l.sku + ':' + (Number(l.quantity) || 0); }).join('|');
  }

  function rfqDraftLines() {
    return pb.lines.map(function (l) {
      return {
        sku: l.sku || '',
        name: l.name || '',
        lineType: l.lineType || 'PRODUCT',
        optional: !!l.optional,
        quantity: Number(l.quantity) || 0,
        costEach: Number(l.costEach) || 0,
      };
    });
  }

  /**
   * Refreshes itself off the lines currently on screen, so dropping a vendor's
   * product onto the proposal raises the freight prompt straight away — no save,
   * no reload. Debounced, because this runs on every builder render.
   */
  async function loadRfqPanel(force) {
    if (!pb) return;
    var sig = rfqLineSignature();
    if (!force && rfqData && rfqData.versionId === pb.versionId && rfqData.sig === sig) { renderRfqRail(); return; }
    if (!force) {
      clearTimeout(loadRfqPanel._t);
      loadRfqPanel._t = setTimeout(function () { loadRfqPanel(true); }, 400);
      renderRfqRail();
      return;
    }
    if (loadRfqPanel._busy) { loadRfqPanel._again = true; return; }
    loadRfqPanel._busy = true;
    renderRfqRail();
    var versionId = pb.versionId;
    try {
      var body = { lines: rfqDraftLines() };
      var vendors = await rfqApi('/proposals/versions/' + versionId + '/rfq/vendors', { method: 'POST', body: body });
      var rfqs = await rfqApi('/proposals/' + pb.proposalId + '/rfqs');
      var cov = await rfqApi('/proposals/versions/' + versionId + '/freight-coverage', { method: 'POST', body: body });
      rfqData = { versionId: versionId, sig: sig, vendors: vendors.vendors || [], rfqs: rfqs.rfqs || [], cov: cov, error: null };
    } catch (e) {
      rfqData = { versionId: versionId, sig: sig, vendors: [], rfqs: [], cov: null, error: e.message };
    }
    loadRfqPanel._busy = false;
    renderRfqRail();
    if (loadRfqPanel._again) { loadRfqPanel._again = false; loadRfqPanel(true); }
  }

  function openRfqVendorPicker() {
    var choices = rfqData.vendors.filter(function (v) { return v.rfqEnabled && !v.existingRfqId; });
    var others = rfqData.vendors.filter(function (v) { return !v.rfqEnabled && !v.existingRfqId; });
    var rows = choices.map(function (v, i) {
      return '<label style="display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border:1px solid #e7e8e3;border-radius:10px;background:#fff;margin-bottom:7px;cursor:pointer;">' +
        '<input type="checkbox" class="rfqV" data-v="' + esc(v.vendor) + '" checked style="margin-top:2px;">' +
        '<span style="flex:1;"><b style="font-size:13.5px;">' + esc(v.vendor) + '</b>' +
        '<span class="muted" style="display:block;font-size:12px;margin-top:2px;">' + v.lineCount + ' line' + (v.lineCount === 1 ? '' : 's') + ' \u00b7 ' + v.unitCount + ' unit' + (v.unitCount === 1 ? '' : 's') + '</span></span></label>';
    }).join('');
    var note = others.length
      ? '<div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:4px;">' + esc(others.map(function (v) { return v.vendor; }).join(', ')) + ' also supply parts here but are not set up for freight requests. Turn that on in Settings \u2192 Manufacturers.</div>'
      : '';

    openModal('Request freight quotes',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">One request per vendor. You pick the items on the next screen.</div>' + rows + note,
      async function (close, showErr) {
        var picked = [].slice.call(document.querySelectorAll('.rfqV')).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-v'); });
        if (!picked.length) return showErr('Pick at least one vendor.');
        var first = null;
        try {
          // The RFQ is built from the SAVED version, so anything still sitting in
          // the builder has to land first or the request goes out short a line.
          await saveBuilderQuiet();
          for (var i = 0; i < picked.length; i++) {
            var made = await rfqApi('/proposals/versions/' + pb.versionId + '/rfqs', { method: 'POST', body: { vendor: picked[i] } });
            if (!first) first = made.id;
          }
        } catch (e) { return showErr(e.message); }
        close();
        await loadRfqPanel(true);
        if (first) openRfqEditor(first);
      }, 'Continue');
  }

  async function openRfqEditor(rfqId) {
    var m;
    try { m = await rfqApi('/rfqs/' + rfqId); } catch (e) { alert(e.message); return; }
    var editable = m.status === 'DRAFT';

    function lineRows() {
      return m.lines.map(function (l) {
        return '<tr style="border-bottom:1px solid #eef0ea;">' +
          '<td style="padding:7px 8px;"><input type="checkbox" class="rfqL" data-id="' + l.id + '"' + (l.included ? ' checked' : '') + (editable ? '' : ' disabled') + '></td>' +
          '<td style="padding:7px 8px;font-family:ui-monospace,monospace;font-size:11.5px;white-space:nowrap;">' + esc(l.sku) + '</td>' +
          '<td style="padding:7px 8px;font-size:12.5px;">' + esc(l.name) + '</td>' +
          '<td style="padding:7px 8px;text-align:right;font-size:12.5px;">' + l.quantity + '</td>' +
          '<td style="padding:7px 8px;text-align:right;font-size:12.5px;">' + fmtMoney(l.unitCostMinor, '') + '</td>' +
          '<td style="padding:7px 8px;text-align:right;font-size:12.5px;font-variant-numeric:tabular-nums;">' + fmtMoney(l.extendedCostMinor, '') + '</td>' +
        '</tr>';
      }).join('');
    }

    var body =
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:12px;">' +
        '<span class="muted" style="font-size:12.5px;">' + esc(m.vendor) + ' \u00b7 ' + esc(m.reference) + '</span>' + rfqStatusChip(m.status) + '</div>' +
      (editable ? '' : '<div style="background:#f2f3ef;border:1px solid #e7e8e3;border-radius:10px;padding:9px 11px;font-size:12.5px;color:#5c6157;line-height:1.5;margin-bottom:12px;">' +
        'This request has been sent, so its items are locked. <b>Send again</b> emails this same document a second time — it goes out as ' +
        esc(m.reference.replace(/ S\d+$/, '')) + ' S' + ((m.submission || 1) + 1) + '. <b>Revise</b> raises ' +
        esc(m.reference.replace(/ R\d+$/, '').replace(/ S\d+$/, '')) + ' R' + (m.revision + 1) + ' with these items carried over, for when the shipment itself has changed.</div>') +
      '<table style="width:100%;border-collapse:collapse;">' +
        '<thead><tr style="border-bottom:1.5px solid #20241f;">' +
          '<th style="width:28px;"></th>' +
          '<th style="padding:6px 8px;text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">SKU</th>' +
          '<th style="padding:6px 8px;text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">Product name</th>' +
          '<th style="padding:6px 8px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">Qty</th>' +
          '<th style="padding:6px 8px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">Unit price</th>' +
          '<th style="padding:6px 8px;text-align:right;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;">Total</th>' +
        '</tr></thead><tbody id="rfqLines">' + lineRows() + '</tbody></table>' +
      '<div style="display:flex;justify-content:flex-end;gap:10px;padding:10px 8px 0;font-size:14px;font-weight:600;"><span>Total</span><span id="rfqTotal" style="font-variant-numeric:tabular-nums;min-width:110px;text-align:right;">' + fmtMoney(m.totalCostMinor, 'USD') + '</span></div>' +
      '<div class="field" style="margin-top:14px;"><label>Special notes for this request</label>' +
        '<textarea id="rfqNotes" rows="3"' + (editable ? '' : ' disabled') + ' placeholder="Anything the vendor needs to know \u2014 dock access, delivery window, liftgate." style="' + IN + 'resize:vertical;">' + esc(m.notes || '') + '</textarea></div>';

    var foot = '<button class="link-btn" id="rfqClose" style="width:auto;padding:10px 16px;">Close</button>' +
      '<button class="link-btn" id="rfqPreview" style="width:auto;padding:10px 16px;">Preview PDF</button>' +
      (editable
        ? '<button class="btn" id="rfqSend" style="width:auto;padding:10px 20px;">Send to vendor</button>'
        : '<button class="btn" id="rfqSend" style="width:auto;padding:10px 20px;">Send again</button>');

    var ov = rfqOverlay('Request for Freight', body, foot);
    ov.querySelector('#rfqClose').addEventListener('click', ov.close);
    ov.querySelector('#rfqPreview').addEventListener('click', async function () {
      // Opening the endpoint directly would send no Authorization header, so the
      // route answers with a 401 body instead of the document. Fetch it as an
      // authenticated request and hand the browser a blob.
      var btn = ov.querySelector('#rfqPreview');
      btn.disabled = true;
      // Opened NOW, while the click is still the reason the browser is running
      // this code. Open it after the await and the popup blocker kills it
      // silently — no error, no tab, nothing to tell the rep what happened.
      var win = window.open('', '_blank');
      try {
        var r = await authed('/render/rfqs/' + rfqId + '.pdf');
        if (!r.ok) throw new Error('Could not build the PDF (' + r.status + ').');
        var blob = await r.blob();
        var url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        if (win) {
          win.location = url;
        } else {
          // Blocked anyway: fall back to a download, which never is.
          var a = document.createElement('a');
          a.href = url;
          a.download = 'RFQ.pdf';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      } catch (e) {
        if (win) win.close();
        ov.err(e.message);
      }
      btn.disabled = false;
    });

    ov.querySelectorAll('.rfqL').forEach(function (c) {
      c.addEventListener('change', async function () {
        try {
          var res = await rfqApi('/rfqs/' + rfqId + '/lines/' + c.getAttribute('data-id'), { method: 'PATCH', body: { included: c.checked } });
          ov.querySelector('#rfqTotal').textContent = fmtMoney(res.totalCostMinor, 'USD');
        } catch (e) { c.checked = !c.checked; ov.err(e.message); }
      });
    });

    var notes = ov.querySelector('#rfqNotes');
    if (editable) {
      notes.addEventListener('blur', async function () {
        try { await rfqApi('/rfqs/' + rfqId + '/notes', { method: 'PATCH', body: { notes: notes.value } }); }
        catch (e) { ov.err(e.message); }
      });
    }

    var send = ov.querySelector('#rfqSend');
    if (send) send.addEventListener('click', async function () {
      if (notes.value !== (m.notes || '')) {
        try { await rfqApi('/rfqs/' + rfqId + '/notes', { method: 'PATCH', body: { notes: notes.value } }); } catch (e) {}
      }
      ov.close();
      openRfqSend(rfqId);
    });
  }

  async function openRfqSend(rfqId) {
    var d;
    try { d = await rfqApi('/rfqs/' + rfqId + '/send-defaults'); } catch (e) { alert(e.message); return; }
    openModal('Send ' + d.reference,
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">The RFQ is attached as a PDF. Replies come back to sales@summitsensory.com. Sending locks this request.</div>' +
      fieldRow('To', '<input id="rfqTo" type="text" style="' + IN + '" value="' + esc(d.to) + '" placeholder="freight@vendor.com">') +
      fieldRow('Cc', '<input id="rfqCc" type="text" style="' + IN + '" value="' + esc(d.cc) + '" placeholder="Optional">') +
      fieldRow('Subject', '<input id="rfqSubj" style="' + IN + '" value="' + esc(d.subject) + '">') +
      '<div class="field"><label>Message</label><textarea id="rfqBodyTxt" rows="8" style="' + IN + 'resize:vertical;">' + esc(d.body) + '</textarea></div>' +
      (d.to ? '' : '<div class="muted" style="font-size:11.5px;line-height:1.5;">No address is stored for this vendor. Add one in Settings \u2192 Manufacturers and it will be filled in next time.</div>'),
      async function (close, showErr) {
        var to = document.getElementById('rfqTo').value.trim();
        if (!to) return showErr('Give at least one recipient.');
        try {
          await rfqApi('/rfqs/' + rfqId + '/send', {
            method: 'POST',
            body: {
              to: to,
              cc: document.getElementById('rfqCc').value.trim(),
              subject: document.getElementById('rfqSubj').value.trim(),
              body: document.getElementById('rfqBodyTxt').value,
            },
          });
        } catch (e) { return showErr(e.message); }
        close();
        await loadRfqPanel(true);
      }, 'Send RFQ');
  }

  /**
   * How deep a line sits: 0 outside any heading, 1 under a group, 2 under a
   * sub-heading. Found by looking back for the nearest heading, which is the only
   * place the structure lives — pb.lines is flat.
   */
  function builderDepth(i) {
    for (var j = i - 1; j >= 0; j--) {
      var lt = pb.lines[j] && pb.lines[j].lineType;
      if (lt === 'SUBGROUP') return 2;
      if (lt === 'GROUP') return 1;
    }
    return 0;
  }

  function builderLineRow(l, i, gsub) {
    var handle = '<div class="bDrag" style="cursor:grab;color:#c2c6bd;font-size:18px;padding:0 4px;user-select:none;" title="Drag to reorder">⋮⋮</div>';
    var del = '<button class="bDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:30px;height:30px;color:#9c3327;cursor:pointer;flex:0 0 auto;">✕</button>';
    /* Adds a note directly beneath this row rather than at the bottom of the
     * proposal. The old "+ Standard note…" picker appended to the end and left the
     * rep to drag it into place, which is why notes drifted away from the thing
     * they were about. Available on headings, sub-headings and products alike. */
    var noteBtn = '<button class="bAddNote" data-i="' + i + '" title="Add a note directly under this line" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;height:30px;padding:0 9px;color:#5c6157;cursor:pointer;flex:0 0 auto;font-size:11.5px;white-space:nowrap;">+ Note</button>';
    var noteBtnLight = noteBtn.replace('border:1px solid #e0e1db;background:#fff', 'border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.12)').replace('color:#5c6157', 'color:#e6ebef');
    if (l.lineType === 'GROUP') {
      var g = (gsub && gsub[i]) || { rev: 0, cogs: 0 };
      var gMargin = g.rev - g.cogs;
      var gPct = g.rev ? Math.round((gMargin / g.rev) * 1000) / 10 : 0;
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="background:#3d4a55;border:1px solid #33404a;border-radius:10px;padding:9px 10px;color:#fff;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' + handle.replace('#c2c6bd', '#8fa0ac') +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="SECTION HEADING" style="flex:1;border:none;background:transparent;font-weight:700;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:#fff;outline:none;">' +
        '<input class="bF" data-i="' + i + '" data-k="description" value="' + esc(l.description || '') + '" placeholder="Heading note (e.g. Frame Dimensions: 10\' × 10\')" style="flex:0 1 250px;border:none;background:rgba(255,255,255,.1);border-radius:7px;padding:5px 8px;font-size:11.5px;color:#e6ebef;outline:none;">' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#cdd6dc;white-space:nowrap;cursor:pointer;"><input type="checkbox" class="bChk" data-i="' + i + '" data-k="optional"' + (l.optional ? ' checked' : '') + '> Optional</label>' +
        '<span style="font-size:12.5px;font-weight:600;color:#cdd6dc;min-width:90px;text-align:right;">' + fmtMoney(g.rev, 'USD') + '</span>' + noteBtnLight + del.replace('#9c3327', '#f0b8ae').replace('background:#fff', 'background:rgba(255,255,255,.12)').replace('border:1px solid #e0e1db', 'border:1px solid rgba(255,255,255,.25)') +
        '</div>' +
        (isMock() ? '' :
          '<div style="display:flex;gap:16px;justify-content:flex-end;font-size:11px;color:#a9bac6;padding:6px 40px 0 0;">' +
            '<span>Revenue <b style="color:#fff;font-weight:600;">' + fmtMoney(g.rev, '') + '</b></span>' +
            '<span>COGS <b style="color:#fff;font-weight:600;">' + fmtMoney(g.cogs, '') + '</b></span>' +
            '<span>Margin <b style="color:' + (gMargin >= 0 ? '#9fe0c4' : '#f0b8ae') + ';font-weight:600;">' + fmtMoney(gMargin, '') + ' · ' + gPct + '%</b></span>' +
          '</div>') + '</div>';
    }
    if (l.lineType === 'SUBGROUP') {
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;background:#eef0ea;border:1px solid #e2e5dd;border-radius:9px;padding:7px 10px;margin-left:14px;">' + handle +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Sub-heading" style="flex:1;border:none;background:transparent;font-weight:600;font-size:13px;color:#3d4a55;outline:none;">' +
        // Matches the one-line note a GROUP heading already has, and prints the
        // same way — beneath the heading, before the first product under it.
        '<input class="bF" data-i="' + i + '" data-k="description" value="' + esc(l.description || '') + '" placeholder="Sub-heading note" style="flex:0 1 260px;border:1px solid #dfe3da;background:#fff;border-radius:7px;padding:5px 8px;font-size:11.5px;color:#3d4a55;outline:none;">' +
        noteBtn + del + '</div>';
    }
    if (l.lineType === 'NOTE') {
      // Lines up with the heading it was added under, on the same 14px step the
      // sub-heading row uses, so a note reads as belonging to its section rather than
      // to the whole proposal.
      var noteIndent = builderDepth(i) * 14;
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid #ece9db;border-radius:10px;padding:10px;' + (noteIndent ? 'margin-left:' + noteIndent + 'px;' : '') + '">' + handle +
        '<div style="flex:1;"><input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Note title" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        '<textarea class="bF" data-i="' + i + '" data-k="description" rows="3" placeholder="Note text" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(l.description) + '</textarea>' +
        '<div style="font-size:10.5px;color:#8a8f85;margin-top:3px;">Formatting: <b>**bold**</b> · <i>*italic*</i> · line breaks are kept · HTML: &lt;ul&gt;&lt;li&gt; &lt;b&gt; &lt;i&gt; &lt;a href&gt;</div></div>' + del + '</div>';
    }
    // PRODUCT
    var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
    var hasNotes = l.delivery || l.returnable || l.addlFreight || l.freightCalc || l.tpFreightMinor || showsFreightTbd(l);
    var freightTbdBlock = showsFreightTbd(l)
      ? '<div style="background:#fdf6e6;border:1px solid #ecd9a6;border-radius:8px;padding:9px 11px;margin-bottom:10px;">' +
          '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#8a6d1f;font-weight:700;margin-bottom:4px;">Freight to be determined · prints on the proposal</div>' +
          '<div style="font-size:12px;color:#6b5a24;line-height:1.55;">' + esc(FREIGHT_TBD_NOTE) + '</div>' +
          '<div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Added automatically because this part’s vendor quotes freight after approval. Enter a freight amount below, or set “Freight charges calculated” to Yes, and it is removed.</div>' +
        '</div>'
      : '';
    var notesPanel = l.showNotes ?
      '<div style="margin-top:10px;padding:10px;background:#f7f8f4;border:1px solid #eef0ea;border-radius:9px;">' +
        freightTbdBlock +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
          '<div><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Delivery timeline</label><input class="bF" data-i="' + i + '" data-k="delivery" value="' + esc(l.delivery) + '" placeholder="e.g. 8–10 weeks" style="' + IN + 'padding:7px 9px;"></div>' +
          '<div><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Returnable</label>' + ynSelect(i, 'returnable', l.returnable) + '</div>' +
          '<div><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Additional freight charges apply</label>' + ynSelect(i, 'addlFreight', l.addlFreight) + '</div>' +
          '<div><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Freight charges calculated</label>' + ynSelect(i, 'freightCalc', l.freightCalc) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;align-items:flex-end;">' +
          '<div style="flex:1;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">3rd-party freight line (shown under item)</label><input class="bF" data-i="' + i + '" data-k="tpFreightLabel" value="' + esc(l.tpFreightLabel) + '" placeholder="e.g. Steamroller Ramp freight" style="' + IN + 'padding:7px 9px;"></div>' +
          '<div style="width:120px;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Freight $</label><input class="bF" data-i="' + i + '" data-k="tpFreight" value="' + m2d(l.tpFreightMinor) + '" style="' + IN + 'padding:7px 9px;text-align:right;"></div>' +
        '</div>' +
      '</div>' : '';
    return '<div class="bRow" draggable="true" data-i="' + i + '" style="background:#fff;border:1px solid #e7e8e3;border-radius:10px;padding:10px;">' +
      '<div style="display:flex;align-items:flex-start;gap:8px;">' + handle +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;gap:8px;margin-bottom:5px;">' +
            '<span class="bFreightMark" data-sku="' + esc(l.sku || '') + '" style="display:flex;align-items:center;flex:0 0 auto;">' + freightMarkHtml(l.sku) + '</span>' +
            '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Product / activity" style="flex:1;border:none;font-weight:600;font-size:14px;outline:none;">' +
            '<input class="bF" data-i="' + i + '" data-k="sku" value="' + esc(l.sku) + '" placeholder="SKU" style="width:130px;border:1px solid #eef0ea;border-radius:6px;padding:3px 7px;font-size:11.5px;color:#5c6157;font-family:ui-monospace,monospace;">' +
          '</div>' +
          '<textarea class="bF" data-i="' + i + '" data-k="description" rows="2" placeholder="Description" style="width:100%;border:1px solid #eef0ea;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;color:#4a4f47;">' + esc(l.description) + '</textarea>' +
          // An engineering warning for whoever is building this proposal. Styled as
          // an obvious internal flag and never written into the description, so it
          // cannot reach the printed document.
          (l.internalNote
            ? '<div style="margin-top:6px;display:flex;gap:7px;align-items:flex-start;background:#fdf6e6;border:1px solid #ecd9a6;border-radius:7px;padding:6px 9px;font-size:11.5px;color:#6b5a24;line-height:1.5;">' +
                '<b style="font-weight:700;white-space:nowrap;">Internal</b><span>' + esc(l.internalNote) + '</span></div>'
            : '') +
          '<div style="display:flex;align-items:center;gap:14px;margin-top:6px;flex-wrap:wrap;">' +
            '<button class="bToggleNotes" data-i="' + i + '" style="border:none;background:transparent;color:#3d4a55;font-size:11.5px;cursor:pointer;padding:0;font-weight:500;">' + (l.showNotes ? '− Hide delivery / freight notes' : (hasNotes ? '● Delivery / freight notes' : '+ Delivery / freight notes')) + '</button>' +
            // Every fastener behind a rolled-up kit line, on a proposal that was
            // built at any point in the past — the breakdown travels on the line.
            ((l.components && l.components.length)
              ? '<button class="bHwLogic" data-i="' + i + '" style="border:none;background:transparent;color:#3d4a55;font-size:11.5px;cursor:pointer;padding:0;font-weight:500;text-decoration:underline;">Show the ' + esc(l.sku || 'kit') + ' calculation (' + l.components.length + ' part numbers) →</button>'
              : '') +
            '<button class="bAddNote" data-i="' + i + '" style="border:none;background:transparent;color:#3d4a55;font-size:11.5px;cursor:pointer;padding:0;font-weight:500;">+ Note under this item</button>' +
          '</div>' +
          notesPanel +
          // Flagged on the line itself, not only in the banner — the banner tells you
          // how many, this tells you which.
          (showsFreightTbd(l) && !l.showNotes
            ? '<div style="margin-top:6px;font-size:11.5px;color:#8a6d1f;line-height:1.5;">Freight to be determined — the vendor’s standing freight note prints on this line.</div>'
            : '') +
          (l.kind === 'INCLUDED' && l.sku && !(Number(l.rateMinor) || 0)
            ? '<div style="margin-top:6px;font-size:11.5px;color:#8a5a12;">No rate on this line' +
                (itemDefaults[l.sku] && itemDefaults[l.sku].priceMinor
                  ? ' — the catalog has $' + (itemDefaults[l.sku].priceMinor / 100).toFixed(2) + '. Use “Pull from catalog” above.'
                  : ' — and no price in the catalog for ' + esc(l.sku) + '.') + '</div>'
            : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:5px;width:74px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Qty</label><input class="bF" data-i="' + i + '" data-k="quantity" value="' + esc(l.quantity) + '" style="width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;"></div>' +
        '<div style="display:flex;flex-direction:column;gap:5px;width:104px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Rate</label><input class="bF" data-i="' + i + '" data-k="rate" value="' + m2d(l.rateMinor) + '" style="width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;"></div>' +
        (isMock() ? '' : '<div style="display:flex;flex-direction:column;gap:5px;width:96px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;" title="Internal only — never printed">Cost</label><input class="bF" data-i="' + i + '" data-k="cost" value="' + m2d(l.costEach) + '" style="width:100%;padding:6px 8px;border:1px solid #e4dfd0;background:#fdfcf7;border-radius:7px;text-align:right;"></div>') +
        '<div style="width:96px;flex:0 0 auto;text-align:right;padding-top:20px;font-weight:600;font-size:14px;">' + fmtMoney(amt, 'USD') + '</div>' + del +
      '</div></div>';
  }
  function ynSelect(i, k, val) {
    return '<select class="bF" data-i="' + i + '" data-k="' + k + '" style="' + IN + 'padding:7px 9px;"><option value="">—</option><option value="YES"' + (val === 'YES' ? ' selected' : '') + '>Yes</option><option value="NO"' + (val === 'NO' ? ' selected' : '') + '>No</option></select>';
  }

  var bDragFrom = null;
  function wireBuilder() {
    if (!wireBuilder._rail) {
      wireBuilder._rail = true;
      window.addEventListener('resize', function () { var el = document.getElementById('bMarginRail'); if (el) el.setAttribute('style', marginRailStyle()); });
    }
    document.getElementById('bBack').addEventListener('click', function () {
      // A mock has no proposal behind it, so there is nothing to go back TO — and
      // nothing to lose either, which is why it leaves without the unsaved-work prompt.
      if (isMock()) { var u = pb.user; pb = null; pbDirty = false; activateNav('mock'); renderMockProposal(u); return; }
      openProposalDetail(pb.proposalId, pb.user);
    });
    if (isMock()) {
      document.getElementById('bMkReal').addEventListener('click', function () { convertMockToProposal(pb.user); });
    } else {
      document.getElementById('bSave').addEventListener('click', saveBuilder);
      document.getElementById('bPreview').addEventListener('click', function () { previewProposalDoc(builderDoc()); });
    // Straight to the print dialog. The preview still opens behind it, so cancelling
    // the print leaves the document on screen rather than dumping you back.
      document.getElementById('bPdf').addEventListener('click', function () { previewProposalDoc(builderDoc(), true); });
    // Leaves the builder. Identical to "‹ Cancel" — both honour the unsaved-changes
    // guard — and it is here because the exit belongs beside Save, not only in the
    // top-left corner.
    }
    document.getElementById('bClose').addEventListener('click', function () { document.getElementById('bBack').click(); });
    loadRfqPanel();
    // A mock has no customer behind it, so there is nothing to keep notes against.
    if (!isMock()) loadCustomerNotes();
    if (!isMock()) {
      document.getElementById('bSaveTpl').addEventListener('click', saveAsTemplate);
      document.getElementById('bLoadTpl').addEventListener('click', loadTemplate);
    }
    document.getElementById('bAddProd').addEventListener('click', openProductPicker);
    document.getElementById('bAdvSeries').addEventListener('click', openAdventureConfigurator);
    document.getElementById('bSoarSeries').addEventListener('click', openSoarConfigurator);
    document.getElementById('bFlexSeries').addEventListener('click', function () { openLinePicker('Summit Flex'); });
    document.getElementById('bAddGroup').addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: '', description: '', quantity: 0, rateMinor: 0, group: '', optional: false }); renderBuilder(); });
    document.getElementById('bAddSub').addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'SUBGROUP', kind: 'SUBGROUP', name: '', description: '', quantity: 0, rateMinor: 0, group: '' }); renderBuilder(); });
    var hwTest = document.getElementById('bHwTest');
    if (hwTest) hwTest.addEventListener('click', function () { openHardwareAudit(hardwareKitLine()); });
    var noteSel = document.getElementById('bAddNote');
    noteSel.addEventListener('change', function () {
      var v = noteSel.value; if (!v) return;
      if (v === '__custom') pb.lines.push({ ref: uid(), lineType: 'NOTE', kind: 'NOTE', name: 'Note', description: '', quantity: 0, rateMinor: 0 });
      else {
        var nn = (pb.stdNotes || [])[Number(v)];
        if (nn && nn.placement === 'FOOTER') { pb.meta.footerNotes = (pb.meta.footerNotes || []).concat([{ title: nn.title, body: nn.body }]); }
        else if (nn) pb.lines.push({ ref: uid(), lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0 });
      }
      noteSel.value = ''; renderBuilder();
    });
    document.querySelectorAll('.bFN').forEach(function (el) {
      el.addEventListener('input', function () {
        var n = (pb.meta.footerNotes || [])[+el.getAttribute('data-i')];
        if (n) n[el.getAttribute('data-k')] = el.value;
      });
    });
    document.querySelectorAll('.bFNDel').forEach(function (b) {
      b.addEventListener('click', function () { (pb.meta.footerNotes || []).splice(+b.getAttribute('data-i'), 1); renderBuilder(); });
    });
    document.getElementById('bAddFooter').addEventListener('click', function () {
      pb.meta.footerNotes = (pb.meta.footerNotes || []).concat([{ title: '', body: '' }]); renderBuilder();
    });
    document.querySelectorAll('.grpChip').forEach(function (c) { c.addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: c.getAttribute('data-g'), description: '', quantity: 0, rateMinor: 0, optional: /trolley|adventure|foundation|mat/i.test(c.getAttribute('data-g')) }); renderBuilder(); }); });
    // header/meta inputs
    var mt = document.getElementById('mTitle'); if (mt) mt.addEventListener('input', function () { pb.title = mt.value; markBuilderDirty(); });
    var mct = document.getElementById('mContact'); if (mct) mct.addEventListener('input', function () { pb.meta.contactName = mct.value; });
    var mp = document.getElementById('mProj'); if (mp) mp.addEventListener('input', function () { pb.meta.projectId = mp.value; });
    var mpd = document.getElementById('mPropDate'); if (mpd) mpd.addEventListener('input', function () { pb.meta.proposalDate = mpd.value; pb.meta.expiration = addDays(mpd.value, 7); var me2 = document.getElementById('mExp'); if (me2) me2.value = pb.meta.expiration; });
    var msp = document.getElementById('mShowProj'); if (msp) msp.addEventListener('change', function () { pb.meta.showProjectId = msp.checked; });
    var mdep = document.getElementById('mShowDeposit'); if (mdep) mdep.addEventListener('change', function () {
      pb.meta.showDeposit = mdep.checked;
      // Wording that references the deposit is swapped for wording that does not, and
      // the other way round — see applyConditionalNotes.
      if (applyConditionalNotes()) markBuilderDirty();
      renderBuilderKeepingFocus();
    });
    var mst = document.getElementById('mShowTitle'); if (mst) mst.addEventListener('change', function () { pb.meta.showTitle = mst.checked; });
    // Bill to mirrors ship to until someone types in it. Editing it is what breaks
    // the link — no mode to switch, and the text stays whatever was typed.
    var mb = document.getElementById('mBill'), mbs = document.getElementById('mBillSame');
    if (mb) mb.addEventListener('input', function () {
      pb.meta.billTo = mb.value;
      if (pb.meta.billSameAsShip && mb.value !== (pb.meta.shipTo || '')) {
        pb.meta.billSameAsShip = false;
        if (mbs) mbs.checked = false;
      }
    });
    if (mbs) mbs.addEventListener('change', function () {
      pb.meta.billSameAsShip = mbs.checked;
      if (mbs.checked) { pb.meta.billTo = pb.meta.shipTo || ''; if (mb) mb.value = pb.meta.billTo; }
    });
    var me = document.getElementById('mExp'); if (me) me.addEventListener('input', function () { pb.meta.expiration = me.value; });
    var ms = document.getElementById('mShip');
    if (ms) ms.addEventListener('input', function () {
      pb.meta.shipTo = ms.value;
      // Keep meta.billTo resolved at all times, so the preview, PDF, template and
      // save path need to know nothing about the link.
      if (pb.meta.billSameAsShip) { pb.meta.billTo = ms.value; if (mb) mb.value = ms.value; }
    });
    var mtx = document.getElementById('mTax'); if (mtx) mtx.addEventListener('change', function () { pb.meta.taxAmountMinor = d2m(mtx.value); pb.meta.taxTouched = true; renderBuilderKeepingFocus(); });
    [['mTaxTbd', 'tbdTax'], ['mStructFreightTbd', 'tbdStructureFreight'], ['mMatsFreightTbd', 'tbdMatsFreight']].forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (el) {
        // A plain number typed in here IS money (see overrideMinor), so Total and
        // Deposit have to move with it. It only updated the stored meta before, which
        // is why the printed proposal was right and the screen was not.
        var upd = function () { pb.meta[p[1]] = el.value.trim(); markBuilderDirty(); renderBuilderKeepingFocus(); };
        el.addEventListener('input', upd);
        el.addEventListener('change', upd);
      }
    });
    var mdisc = document.getElementById('mDisc');
    if (mdisc) mdisc.addEventListener('change', function () {
      var v = parseFloat(String(mdisc.value).replace(/[$,]/g, '')) || 0;
      // Whichever field is not in play is zeroed, so a mode switch can never leave
      // a stale figure behind that a later switch would silently resurrect.
      if (pb.meta.discountMode === 'AMT') { pb.meta.discountAmountMinor = Math.round(v * 100); pb.meta.discountPct = 0; }
      else { pb.meta.discountPct = v; pb.meta.discountAmountMinor = 0; }
      renderBuilderKeepingFocus();
    });
    var mdiscMode = document.getElementById('mDiscMode');
    if (mdiscMode) mdiscMode.addEventListener('change', function () {
      pb.meta.discountMode = mdiscMode.value === 'AMT' ? 'AMT' : 'PCT';
      pb.meta.discountPct = 0; pb.meta.discountAmountMinor = 0;
      renderBuilderKeepingFocus();
    });
    var msf = document.getElementById('mStructFreight'); if (msf) msf.addEventListener('change', function () { pb.meta.structureFreightMinor = d2m(msf.value); renderBuilderKeepingFocus(); });
    var mmf = document.getElementById('mMatsFreight'); if (mmf) mmf.addEventListener('change', function () { pb.meta.matsFreightMinor = d2m(mmf.value); pb.meta.matsFreightTouched = true; renderBuilderKeepingFocus(); });
    // Standard Freight. The amount commits on blur rather than per keystroke: the box
    // re-renders formatted, and reformatting mid-type eats the digits.
    var mso = document.getElementById('mStdFreightOn');
    if (mso) mso.addEventListener('change', function () { pb.meta.stdFreightOn = mso.checked; markBuilderDirty(); renderBuilderKeepingFocus(); });
    var msf2 = document.getElementById('mStdFreight');
    if (msf2) msf2.addEventListener('change', function () { pb.meta.stdFreightMinor = d2m(msf2.value); markBuilderDirty(); renderBuilderKeepingFocus(); });
    var brp = document.getElementById('bRepull');
    if (brp) brp.addEventListener('click', repullCatalogFigures);
    var bfr = document.getElementById('bFreightReq'); if (bfr) bfr.addEventListener('click', requestFreight);
    var bfs = document.getElementById('bFreightSync'); if (bfs) bfs.addEventListener('click', pullFreightAmount);
    // line field inputs
    document.querySelectorAll('.bF').forEach(function (el) {
      var handler = function () {
        var i = +el.getAttribute('data-i'), k = el.getAttribute('data-k'), l = pb.lines[i]; if (!l) return;
        markBuilderDirty();
        if (k === 'rate') l.rateMinor = d2m(el.value);
        else if (k === 'cost') l.costEach = d2m(el.value);
        else if (k === 'tpFreight') l.tpFreightMinor = d2m(el.value);
        else if (k === 'quantity') l.quantity = parseFloat(el.value) || 0;
        else l[k] = el.value;
      };
      el.addEventListener('input', handler);
      var k = el.getAttribute('data-k');
      if (k === 'rate' || k === 'cost' || k === 'quantity' || k === 'tpFreight' || el.tagName === 'SELECT') el.addEventListener('change', renderBuilderKeepingFocus);
    });
    document.querySelectorAll('.bChk').forEach(function (el) { el.addEventListener('change', function () { markBuilderDirty(); var l = pb.lines[+el.getAttribute('data-i')]; if (l) { l[el.getAttribute('data-k')] = el.checked; } }); });
    document.querySelectorAll('.bToggleNotes').forEach(function (b) { b.addEventListener('click', function () { var l = pb.lines[+b.getAttribute('data-i')]; if (l) { l.showNotes = !l.showNotes; renderBuilder(); } }); });
    document.querySelectorAll('.bHwLogic').forEach(function (b) { b.addEventListener('click', function () { openHardwareAudit(pb.lines[+b.getAttribute('data-i')]); }); });
    document.querySelectorAll('.bDel').forEach(function (b) { b.addEventListener('click', function () { markBuilderDirty(); pb.lines.splice(+b.getAttribute('data-i'), 1); renderBuilder(); }); });
    /* A note added from a row goes directly beneath it. Under a heading that means
     * before the first product in the section; under a product it means attached to
     * that product. Either way the rep never has to drag it into place. */
    document.querySelectorAll('.bAddNote').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.getAttribute('data-i');
        markBuilderDirty();
        pb.lines.splice(i + 1, 0, normalizeLine({
          lineType: 'NOTE', kind: 'NOTE', name: '', description: '', quantity: 0, rateMinor: 0,
        }));
        renderBuilder();
        // Land the caret in the new note's title so it can be typed straight away.
        var rows = document.querySelectorAll('.bRow');
        var next = rows[i + 1];
        if (next) { var f = next.querySelector('input.bF'); if (f) f.focus(); }
      });
    });
    /* Drag reorder.
     *
     * Dragging a header moves its whole section — the header and every line under
     * it, to the next header of the same or higher level. Moving a header on its
     * own left its products stranded under the section above, which is never what
     * anyone means by moving a section.
     *
     * A single line still drags on its own; only headers carry their contents. */
    function blockAt(i) {
      var l = pb.lines[i];
      if (!l) return { from: i, count: 1 };
      if (l.lineType !== 'GROUP' && l.lineType !== 'SUBGROUP') return { from: i, count: 1 };
      var end = i + 1;
      while (end < pb.lines.length) {
        var t = pb.lines[end].lineType;
        // A GROUP ends at the next GROUP; a SUBGROUP ends at either.
        if (t === 'GROUP' || (l.lineType === 'SUBGROUP' && t === 'SUBGROUP')) break;
        end++;
      }
      return { from: i, count: end - i };
    }

    document.querySelectorAll('.bRow').forEach(function (row) {
      row.addEventListener('dragstart', function () { bDragFrom = +row.getAttribute('data-i'); row.style.opacity = '0.4'; });
      row.addEventListener('dragend', function () { row.style.opacity = '1'; });
      row.addEventListener('dragover', function (e) { e.preventDefault(); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        var to = +row.getAttribute('data-i');
        if (bDragFrom == null || bDragFrom === to) return;
        var blk = blockAt(bDragFrom);
        // Dropping a section onto one of its own lines is a no-op, not a shuffle.
        if (to >= blk.from && to < blk.from + blk.count) { bDragFrom = null; return; }
        var moved = pb.lines.splice(blk.from, blk.count);
        // Removing the block shifts everything after it back by its length.
        var at = to > blk.from ? to - blk.count : to;
        pb.lines.splice.apply(pb.lines, [Math.max(0, at), 0].concat(moved));
        bDragFrom = null;
        markBuilderDirty();
        renderBuilder();
      });
    });
  }

  /**
   * Add-product-line picker.
   *
   * Reads /catalog/items — the SAME merged Product + Sku list the Catalog screen
   * shows — so any part visible in Catalog is selectable here, by construction.
   *
   * Two separate faults used to hide parts, and either alone was enough:
   *   1. it fetched a single 100-row page of /catalog/products and then filtered
   *      that page in the browser, so a part outside the first 100 could never be
   *      found no matter what was typed;
   *   2. /catalog/products reads the Product table only, while Catalog merges
   *      Product and Sku by part number — so a part carried solely as a Sku row
   *      was invisible however much was fetched.
   * Search is now server-side across the whole catalog.
   */
  async function openProductPicker() {
    var bundles = [], bundleSkus = {};
    try {
      var rb = await authed('/catalog/bundles');
      if (rb.ok) bundles = (await rb.json()) || [];
    } catch (e) {}
    bundles.forEach(function (b) { if (b.sku) bundleSkus[b.sku] = true; });

    var items = [], loading = true, seq = 0;

    function closeForm() {
      var form = document.getElementById('mForm');
      if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
    }

    /* Queries the whole catalog, not a page held in memory. `seq` discards a slow
       response that a later keystroke has already superseded. */
    async function fetchItems(term) {
      var mine = ++seq;
      loading = true; paint();
      var found = [];
      try {
        var r = await authed('/catalog/items?pageSize=200&q=' + encodeURIComponent(term || ''));
        if (r.ok) found = (await r.json()).items || [];
      } catch (e) {}
      if (mine !== seq) return;
      items = found.filter(function (i) { return i.active && !bundleSkus[i.part]; });
      loading = false; paint();
    }

    function rowsHtml(term) {
      var out = '';
      var t = (term || '').toLowerCase();
      var bnd = bundles.filter(function (b) {
        return !t || ((b.name || '') + ' ' + (b.sku || '')).toLowerCase().indexOf(t) !== -1;
      });
      if (bnd.length) {
        out += '<div style="padding:6px 12px;background:#f7f8f4;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;">Bundles</div>' +
          bnd.map(function (b) {
            return '<button type="button" class="pkBundle" data-id="' + b.id + '" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid #f2f3ef;background:#fff;padding:10px 12px;cursor:pointer;font-size:13.5px;">' +
              '<b style="font-weight:600;">' + esc(b.name) + '</b> <span class="muted" style="font-size:12px;">' + esc(b.sku) + '</span>' +
              '<div class="muted" style="font-size:11.5px;">' + (b.componentCount || 0) + ' parts · $' + (Number(b.unitPriceMinor) / 100).toFixed(2) + '</div></button>';
          }).join('') +
          '<div style="padding:6px 12px;background:#f7f8f4;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;">Products</div>';
      }
      out += items.map(function (p) {
        var price = Number(p.unitPriceMinor) || 0;
        return '<button type="button" class="pkRow" data-part="' + esc(p.part) + '" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid #f2f3ef;background:#fff;padding:10px 12px;cursor:pointer;font-size:13.5px;">' +
          '<b style="font-weight:600;">' + esc(p.name || p.part) + '</b> <span class="muted" style="font-size:12px;">' + esc(p.part) + '</span>' +
          '<div class="muted" style="font-size:11.5px;">' + esc(p.category || '—') + (price ? ' · $' + (price / 100).toFixed(2) : '') + '</div></button>';
      }).join('');
      if (out) return out;
      if (loading) return '<div class="muted" style="padding:16px;">Searching…</div>';
      return '<div class="muted" style="padding:16px;">No active catalog part matches that search.</div>';
    }

    function wire() {
      document.querySelectorAll('.pkRow').forEach(function (b) {
        b.addEventListener('click', function () {
          var part = b.getAttribute('data-part');
          var p = items.filter(function (x) { return x.part === part; })[0];
          if (!p) return;
          // productId is null for a part carried only as a Sku row; the line is
          // keyed by part number, which is what pricing and the BOM read.
          // Wrapped because a throw in here used to leave the picker open with the
          // line silently half-added, which read as "clicking does nothing".
          try {
            var line = applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: p.productId || null, sku: p.part, name: p.name || p.part, description: '', quantity: 1, rateMinor: 0, group: '' });
            insertLineInOrder(line);
            applyTriggeredNotes(p.part, pb.lines.indexOf(line));
            markBuilderDirty();
          } catch (err) {
            alert('Could not add ' + (p.part || 'that part') + ': ' + (err && err.message ? err.message : err));
            return;
          }
          closeForm(); renderBuilder();
        });
      });
      // A bundle becomes one priced line plus its components as zero-rate
      // sub-lines: the customer sees a single price, while the sub-lines carry the
      // real part numbers, cost and weight for the BOM, the COGS and freight.
      document.querySelectorAll('.pkBundle').forEach(function (b) {
        b.addEventListener('click', function () {
          var bn = bundles.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
          if (!bn) return;
          pb.lines.push(applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: bn.id, sku: bn.sku || '', name: bn.name, description: bn.proposalDescription || '', quantity: 1, rateMinor: bn.unitPriceMinor || 0, costEach: 0, weightEach: 0, group: bn.name }));
          (bn.components || []).forEach(function (c) {
            pb.lines.push(applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: c.productId, sku: c.sku || '', name: '— ' + c.name, description: '', quantity: c.quantity || 1, rateMinor: 0, costEach: c.unitCostMinor || 0, weightEach: c.weightLbs || 0, group: bn.name }));
          });
          closeForm(); renderBuilder();
        });
      });
    }

    function paint() {
      var list = document.getElementById('pkList');
      if (!list) return;
      var s = document.getElementById('pkSearch');
      list.innerHTML = rowsHtml(s ? s.value.trim() : '');
      wire();
    }

    openModal('Add product line',
      '<input id="pkSearch" placeholder="Search part number or name…" style="' + IN + 'margin-bottom:10px;">' +
      '<div id="pkList" style="max-height:320px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;"><div class="muted" style="padding:16px;">Searching…</div></div>' +
      '<div class="muted" style="font-size:12px;margin-top:8px;">Rate is entered per proposal after adding. A bundle adds one priced line plus its parts as zero-rate sub-lines.</div>',
      async function (close) { close(); }, 'Done');

    setTimeout(function () {
      var s = document.getElementById('pkSearch');
      if (s) {
        var t;
        s.addEventListener('input', function () {
          clearTimeout(t);
          t = setTimeout(function () { fetchItems(s.value.trim()); }, 200);
        });
        s.focus();
      }
      fetchItems('');
    }, 50);
  }

  function builderDoc() {
    return { title: pb.title, number: pb.number, orgName: pb.orgName, meta: pb.meta, lines: pb.lines, totals: builderTotals() };
  }

  /** The version payload, shared by the Save button and the quiet save below. */
  function builderVersionPayload() {
    var sections = [{ id: 'meta', type: 'CUSTOMER_INFO', title: 'Proposal', order: 0, enabled: true, data: pb.meta }];
    var items = pb.lines.map(function (l, i) { return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, internalNote: l.internalNote || '', components: l.components || null, source: l.source || '', freightTbd: !!l.freightTbd, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, costEach: Number(l.costEach) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i }; });
    return { title: pb.title || undefined, sections: sections, items: items, expirationDate: pb.meta.expiration || undefined };
  }

  /**
   * Save without leaving the builder. Used before raising an RFQ, which is built
   * server-side from the stored version and would otherwise miss a line the rep
   * added a moment ago.
   */
  async function saveBuilderQuiet() {
    // The freight review opens a frozen version in the same state shape, and a mock has
    // no version at all. Nothing to save either way, and the API would refuse it.
    if (pb && (pb.readOnly || pb.mock)) return;
    var r = await authed('/proposals/versions/' + pb.versionId, { method: 'PATCH', body: builderVersionPayload() });
    if (!r.ok) throw new Error('Could not save the proposal before raising the request (' + r.status + ').');
    clearBuilderDirty();
  }

  async function saveBuilder() {
    var btn = document.getElementById('bSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var r = await authed('/proposals/versions/' + pb.versionId, { method: 'PATCH', body: builderVersionPayload() });
      if (!r.ok) { alert('Could not save (' + r.status + ').'); btn.disabled = false; btn.textContent = 'Save'; return; }
      btn.textContent = 'Saved ✓';
      clearBuilderDirty();
      // Stay in the builder. Saving mid-edit is the common case; bouncing back to
      // the detail page forced a re-entry for every save. "‹ Cancel" is the way out.
      setTimeout(function () { var b = document.getElementById('bSave'); if (b) { b.disabled = false; b.textContent = 'Save'; } }, 1200);
    } catch (e) { alert('Could not reach the server.'); btn.disabled = false; btn.textContent = 'Save'; }
  }

  function saveAsTemplate() {
    openModal('Save as template',
      fieldRow('Template name', '<input id="tplName" style="' + IN + '" placeholder="e.g. Full Gym, Flex Quote, Soar" required>') +
      fieldRow('Description (optional)', '<input id="tplDesc" style="' + IN + '">'),
      async function (close, showErr) {
        var name = document.getElementById('tplName').value.trim(); if (!name) return showErr('Give the template a name.');
        var data = { title: pb.title, meta: { taxAmountMinor: pb.meta.taxAmountMinor, discountPct: pb.meta.discountPct, discountMode: pb.meta.discountMode === 'AMT' ? 'AMT' : 'PCT', discountAmountMinor: pb.meta.discountAmountMinor || 0, structureFreightMinor: pb.meta.structureFreightMinor, matsFreightMinor: pb.meta.matsFreightMinor, stdFreightOn: !!pb.meta.stdFreightOn, stdFreightMinor: pb.meta.stdFreightMinor || 0, shipTo: '', projectId: '', expiration: '' }, lines: pb.lines.map(function (l) { return { lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, quantity: l.quantity, rateMinor: l.rateMinor, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: l.tpFreightMinor || 0, tpFreightLabel: l.tpFreightLabel || '' }; }) };
        var r = await authed('/proposal-templates', { method: 'POST', body: { name: name, description: document.getElementById('tplDesc').value.trim() || undefined, data: data } });
        if (!r.ok) return showErr('Could not save template (' + r.status + ').');
        close();
      }, 'Save template');
  }

  async function loadTemplate() {
    var tpls = [];
    try { var r = await authed('/proposal-templates'); if (r.ok) tpls = await r.json(); } catch (e) {}
    if (!tpls.length) { alert('No saved templates yet. Build a proposal and use “Save as template” first.'); return; }
    openModal('Load template',
      '<div style="max-height:320px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' + tpls.map(function (t) { return '<div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid #f2f3ef;padding:10px 12px;"><button type="button" class="tplRow" data-id="' + t.id + '" style="flex:1;text-align:left;border:none;background:#fff;cursor:pointer;font-size:13.5px;"><b style="font-weight:600;">' + esc(t.name) + '</b>' + (t.description ? '<div class="muted" style="font-size:12px;">' + esc(t.description) + '</div>' : '') + '</button><button type="button" class="tplDel" data-id="' + t.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:5px 9px;">Delete</button></div>'; }).join('') + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:8px;">Loading replaces the current line items (header stays).</div>',
      async function (close) { close(); }, 'Close');
    setTimeout(function () {
      document.querySelectorAll('.tplRow').forEach(function (b) { b.addEventListener('click', function () {
        var t = tpls.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0]; var d = t.data || {};
        if (d.meta) { pb.meta.taxRatePct = d.meta.taxRatePct || 0; pb.meta.freightMinor = d.meta.freightMinor || 0; }
        pb.lines = (d.lines || []).map(function (l) { return normalizeLine(l); });
        var ov = document.querySelector('div[style*="position:fixed"]'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        renderBuilder();
      }); });
      document.querySelectorAll('.tplDel').forEach(function (b) { b.addEventListener('click', async function () { if (!confirm('Delete this template?')) return; await authed('/proposal-templates/' + b.getAttribute('data-id'), { method: 'DELETE' }); var ov = document.querySelector('div[style*="position:fixed"]'); if (ov && ov.parentNode) ov.parentNode.removeChild(ov); loadTemplate(); }); });
    }, 50);
  }

  /* --- Proposal preview (PDF-style) --- */
  async function previewProposal(proposal, version) {
    previewProposalDoc(await proposalDocData(proposal, version));
  }

  /**
   * Everything the proposal document needs, assembled from a version. Shared by the
   * preview and the send path so both produce the same figures.
   */
  async function proposalDocData(proposal, version) {
    var orgName = '';
    try { var ro = await authed('/crm/organizations?pageSize=100'); if (ro.ok) { var f = ((await ro.json()).items || []).filter(function (o) { return o.id === proposal.organizationId; })[0]; orgName = f ? f.name : ''; } } catch (e) {}
    var secs = version.sections || []; var metaSec = Array.isArray(secs) ? secs.filter(function (s) { return s && s.id === 'meta'; })[0] : null;
    var meta = (metaSec && metaSec.data) || {};
    var lines = (version.items || []);
    var subtotal = 0, weight = 0; lines.forEach(function (l) { if ((l.lineType || 'PRODUCT') === 'PRODUCT') { subtotal += (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0); weight += (Number(l.quantity) || 0) * (Number(l.weightEach) || 0); } });
    var tpFreight = 0; lines.forEach(function (l) { if ((l.lineType || 'PRODUCT') === 'PRODUCT') tpFreight += Number(l.tpFreightMinor) || 0; });
    var disc = discountOf(meta, subtotal); var discountPct = disc.pct, discountMode = disc.mode, discount = disc.amount;
    var tax = metaAmount(meta.taxAmountMinor, meta.tbdTax);
    var structureFreight = metaAmount(meta.structureFreightMinor != null ? meta.structureFreightMinor : meta.freightMinor, meta.tbdStructureFreight);
    var matsFreight = metaAmount(meta.matsFreightMinor, meta.tbdMatsFreight);
    var stdFreight = stdFreightOf(meta);
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight + stdFreight;
    return {
      title: proposal.title, number: proposal.number, version: version.version || 1,
      orgName: orgName, meta: meta, lines: lines,
      totals: {
        subtotal: subtotal, discountPct: discountPct, discountMode: discountMode, discount: discount, tpFreight: tpFreight,
        tax: tax, structureFreight: structureFreight, matsFreight: matsFreight, stdFreight: stdFreight,
        total: total, deposit: depositOf(total), weight: weight,
      },
    };
  }

  /**
   * The customer proposal as a self-contained HTML string.
   *
   * Extracted from the preview so the SAME markup can be sent to the server and
   * rendered to PDF there. Two renderers for one document is exactly how the BOM's
   * Excel export drifted away from its PDF, and I am not repeating it.
   */
  function proposalDocHtml(doc) {
    var d = doc, m = d.meta || {}, t = d.totals || {};
    // Tax and freight are frequently unknown when a proposal goes out. Showing a
    // hard $0.00 reads as "free"; TBD states the truth.
    var TBD = '<span style="color:#8a8f85;font-weight:600;">TBD</span>';
    // A zero amount prints TBD unless this proposal overrides the wording — plenty of
    // jobs genuinely carry no tax or no freight, and TBD there reads as unanswered.
    var anyTbd = false;
    function amountCell(value, override) {
      if (value) return fmtUsd(value);
      if (overrideMinor(override)) return fmtUsd(overrideMinor(override));
      if (override) return '<span style="color:#5c6157;">' + esc(override) + '</span>';
      anyTbd = true;
      return TBD;
    }
    var cellTax = amountCell(t.tax, m.tbdTax);
    var cellStructureFreight = amountCell(t.structureFreight, m.tbdStructureFreight);
    var cellMatsFreight = amountCell(t.matsFreight, m.tbdMatsFreight);
    var body = '';
    var groupOpenSub = null, groupName = '';
    // Indent depth: top-level group flush, sub-heading indented, line items
    // indented one step further than whichever heading they sit under.
    var inSub = false;
    var bottomNotes = [];
    /** Indent for anything sitting inside the current heading. */
    function lineIndent() { return groupOpenSub != null ? (inSub ? 34 : 20) : 8; }
    function subtotalRow() {
      if (groupOpenSub == null) return '';
      var r = '<tr style="break-inside:avoid;"><td colspan="5" style="padding:5px 8px;text-align:right;font-weight:600;font-size:11px;border-bottom:2px solid #d5d8d2;">Subtotal: ' + fmtUsd(groupOpenSub) + '</td></tr>';
      groupOpenSub = null; return r;
    }
    (d.lines || []).forEach(function (l) {
      var lt = l.lineType || 'PRODUCT';
      if (lt === 'GROUP') {
        body += subtotalRow();
        groupOpenSub = 0; groupName = l.name; inSub = false;
        body += '<tr data-brk="head" style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:6px 10px;font-weight:700;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:#3d4a55;background:#eef0ea;border-bottom:1px solid #d5d8d2;"><span style="display:inline-flex;align-items:baseline;gap:46px;"><span>' + esc(tc(stripOptional(l.name))) + (l.optional ? ' <span style="font-weight:400;text-transform:none;color:#8a8f85;">(Optional)</span>' : '') + '</span>' + (l.description ? '<span style="color:#20241f;">' + esc(l.description) + '</span>' : '') + '</span></td></tr>';
        return;
      }
      if (lt === 'SUBGROUP') {
        inSub = true;
        var subNote = String(l.description || '').trim();
        body += '<tr data-brk="head" style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:7px 8px 3px 22px;font-weight:600;font-size:11.5px;color:#3d4a55;border-bottom:1px solid #d5d8d2;">' + esc(tc(l.name)) +
          (subNote ? '<div style="font-weight:400;font-size:10.5px;color:#5c6157;margin-top:2px;line-height:1.5;">' + rt(subNote) + '</div>' : '') +
          '</td></tr>';
        return;
      }
      // A note reads as belonging to the section it was added under, so it takes the
      // same indent as the lines around it rather than sitting flush left where it
      // looked like a statement about the whole proposal.
      if (lt === 'NOTE') {
        body += '<tr style="break-inside:avoid;"><td colspan="5" style="padding:7px 8px 7px ' + lineIndent() + 'px;background:#fbfaf4;font-size:11px;color:#5c6157;line-height:1.5;"><b style="display:block;color:#20241f;margin-bottom:2px;">' + esc(tc(l.name)) + '</b>' + rt(l.description) + '</td></tr>';
        return;
      }
      var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
      var indent = lineIndent();
      if (groupOpenSub != null) groupOpenSub += amt + (Number(l.tpFreightMinor) || 0);
      body += '<tr style="break-inside:avoid;"><td style="padding:5px 8px 5px ' + indent + 'px;border-bottom:1px solid #eef0ea;vertical-align:top;"><b style="font-weight:600;">' + esc(tc(l.name)) + '</b>' + (l.description ? '<div style="font-size:10.5px;color:#5c6157;line-height:1.45;margin-top:2px;">' + esc(l.description) + '</div>' : '') +
        (l.delivery ? '<div style="font-size:10px;color:#7a7f75;margin-top:2px;">Delivery: ' + esc(l.delivery) + '</div>' : '') +
        (showsFreightTbd(l) ? '<div style="font-size:10px;color:#5c6157;line-height:1.45;margin-top:3px;font-style:italic;">' + esc(FREIGHT_TBD_NOTE) + '</div>' : '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-size:10px;color:#7a7f75;vertical-align:top;font-family:ui-monospace,monospace;">' + esc(l.sku || '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:center;vertical-align:top;">' + (Number(l.quantity) || 0) + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;vertical-align:top;">' + fmtMoney(l.rateMinor, '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;vertical-align:top;font-weight:600;">' + fmtMoney(amt, '') + '</td></tr>';
      if (Number(l.tpFreightMinor) > 0) {
        body += '<tr style="break-inside:avoid;"><td style="padding:2px 8px 5px 20px;border-bottom:1px solid #eef0ea;font-size:10.5px;color:#5c6157;font-style:italic;">+ ' + esc(tc(l.tpFreightLabel || 'Third-Party Freight')) + '</td><td style="border-bottom:1px solid #eef0ea;"></td><td style="border-bottom:1px solid #eef0ea;"></td><td style="border-bottom:1px solid #eef0ea;"></td><td style="padding:2px 8px 5px;border-bottom:1px solid #eef0ea;text-align:right;font-size:10.5px;color:#5c6157;">' + fmtMoney(l.tpFreightMinor, '') + '</td></tr>';
      }
      var flags = [];
      if (l.returnable) flags.push('Returnable: ' + (l.returnable === 'YES' ? 'Yes' : 'No'));
      if (l.addlFreight) flags.push('Additional freight: ' + (l.addlFreight === 'YES' ? 'Yes' : 'No'));
      if (l.freightCalc) flags.push('Freight calculated: ' + (l.freightCalc === 'YES' ? 'Yes' : 'No'));
      if (flags.length) bottomNotes.push({ name: l.name, text: flags.join(' · ') });
    });
    body += subtotalRow();
    var bottomNotesHtml = bottomNotes.length ? '<div style="margin-top:22px;padding-top:12px;border-top:1px solid #e7e8e3;font-size:10.5px;color:#5c6157;line-height:1.6;break-inside:avoid;"><div style="font-weight:600;color:#20241f;margin-bottom:4px;">Delivery, Returns &amp; Freight Notes</div>' + bottomNotes.map(function (n) { return '<div><b style="font-weight:600;">' + esc(tc(n.name)) + ':</b> ' + esc(n.text) + '</div>'; }).join('') + '</div>' : '';
    var u = (pb && pb.user) || currentUser || {};
    var preparerLine2 = [u.title, u.phone].filter(Boolean).join(' · ');
    // Notes that print beneath the signature lines (terms, acceptance language).
    var footerNotes = (m.footerNotes || []).filter(function (fn) { return fn && (fn.title || fn.body); });
    var footerNotesHtml = footerNotes.length
      ? '<div style="margin-top:24px;padding-top:13px;border-top:1px solid #e7e8e3;break-inside:avoid;">' +
        footerNotes.map(function (fn) {
          return '<div style="margin-bottom:9px;font-size:10.5px;line-height:1.6;color:#5c6157;">' +
            (fn.title ? '<div style="font-weight:700;font-size:11px;color:#20241f;margin-bottom:2px;">' + esc(fn.title) + '</div>' : '') + rt(fn.body) + '</div>';
        }).join('') + '</div>'
      : '';
    var preparedBy =
      // Line rhythm matches the "Prepared For" block below it — same 12px size and
      // the same 1px / 2px steps between lines, so the two read as one system.
      '<div style="margin-top:12px;font-size:12px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:4px;">Proposal Prepared By</div>' +
        '<div style="font-weight:600;">' + esc(u.name || u.email || '') + '</div>' +
        (preparerLine2 ? '<div style="color:#5c6157;margin-top:1px;">' + esc(preparerLine2) + '</div>' : '') +
        (u.email ? '<div style="color:#5c6157;margin-top:2px;">' + esc(u.email) + '</div>' : '') +
      '</div>';
    var html =
      '<div id="propPrintArea" style="max-width:760px;margin:0 auto;background:#fff;padding:44px 48px;font-family:\'IBM Plex Sans\',sans-serif;color:#20241f;">' +
        '<div style="border-bottom:2px solid #3d4a55;padding-bottom:16px;margin-bottom:20px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;">' +
          '<div style="display:flex;flex-direction:column;">' +
          '<div style="display:flex;gap:14px;align-items:center;"><img src="logo.png" alt="Summit Sensory Gym" width="84" height="84" style="width:84px;height:84px;display:block;"><div><div style="font-family:\'Newsreader\',serif;font-weight:600;font-size:19px;">Summit Sensory Gym</div><div style="font-size:11px;color:#8a8f85;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111<br>(720) 457-5500 · Sales@SummitSensory.com</div></div></div>' + preparedBy + '</div>' +
          '<div style="text-align:right;"><div style="font-family:\'Newsreader\',serif;font-size:22px;font-weight:600;">Proposal</div><div style="font-size:11.5px;color:#5c6157;margin-top:4px;">' + esc(d.number || '') +
            // The number stays constant across revisions so both sides can say "P-2026-000021"
            // and mean the project. The revision is what distinguishes the documents, so it
            // prints beside it — and only from v2, because a first proposal is not a revision
            // of anything and "Revision 1" on it just invites the question.
            ((Number(d.version) || 1) > 1 ? ' · Revision ' + (Number(d.version) - 1) : '') + '</div>' +
            '<div style="font-size:11px;color:#5c6157;margin-top:8px;line-height:1.7;">' +
              '<div>Proposal Date: <b style="color:#20241f;">' + (m.proposalDate ? fmtDate(m.proposalDate) : fmtDate(todayISO())) + '</b></div>' +
              (m.expiration ? '<div>Expiration Date: <b style="color:#20241f;">' + fmtDate(m.expiration) + '</b></div>' : '') +
              (m.showProjectId !== false && m.projectId ? '<div>Project ID: <b style="color:#20241f;">' + esc(m.projectId) + '</b></div>' : '') +
              '<div>Total Weight: <b style="color:#20241f;">' + (Number(t.weight) || 0).toLocaleString() + ' lbs</b></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-start;gap:56px;margin-bottom:20px;font-size:12px;">' +
          '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:4px;">Prepared For</div><div style="font-weight:600;">' + esc(d.orgName || '') + '</div>' +
            (m.contactName ? '<div style="color:#20241f;margin-top:1px;">' + esc(m.contactName) + '</div>' : '') +
            (m.billTo ? '<div style="color:#5c6157;white-space:pre-line;margin-top:2px;">' + esc(m.billTo) + '</div>' : '') + '</div>' +
          (m.shipTo ? '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:4px;">Ship To</div><div style="color:#5c6157;white-space:pre-line;">' + esc(m.shipTo) + '</div></div>' : '') +
        '</div>' +
        (m.showTitle !== false && d.title ? '<div style="font-family:\'Newsreader\',serif;font-size:24px;font-weight:600;margin-bottom:14px;">' + esc(d.title) + '</div>' : '') +
        '<table style="width:100%;border-collapse:collapse;font-size:11px;"><thead><tr style="color:#8a8f85;font-size:10px;text-transform:uppercase;letter-spacing:.04em;"><th style="text-align:left;padding:6px 8px;border-bottom:2px solid #3d4a55;">Activity / Description</th><th style="text-align:left;padding:6px 8px;border-bottom:2px solid #3d4a55;width:90px;">SKU</th><th style="text-align:center;padding:6px 8px;border-bottom:2px solid #3d4a55;width:44px;">Qty</th><th style="text-align:right;padding:6px 8px;border-bottom:2px solid #3d4a55;width:84px;">Rate</th><th style="text-align:right;padding:6px 8px;border-bottom:2px solid #3d4a55;width:94px;">Amount</th></tr></thead><tbody>' + body + '</tbody></table>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:16px;break-inside:avoid;"><div style="min-width:260px;">' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Subtotal</span><span>' + fmtUsd(t.subtotal) + '</span></div>' +
          (t.discount ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;color:#9c3327;"><span>' + discountLabel(t) + '</span><span>− ' + fmtUsd(t.discount) + '</span></div>' +
            '<div style="padding:0 8px 3px;font-size:10px;color:#8a8f85;text-align:right;">Discount expires ' + (m.expiration ? fmtDate(m.expiration) : 'with this proposal') + '</div>' : '') +
          (t.tpFreight ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Third-Party Freight</span><span>' + fmtUsd(t.tpFreight) + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Mat Freight Tax Pass-Through</span><span>' + cellTax + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Structure Crating &amp; Freight</span><span>' + cellStructureFreight + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Mats &amp; Padding Freight</span><span>' + cellMatsFreight + '</span></div>' +
          // Standard Freight is opt-in: unticked, the customer never sees the line.
          (m.stdFreightOn ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Standard Freight</span><span>' + amountCell(t.stdFreight, '') + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;padding:8px;margin-top:5px;border-top:2px solid #3d4a55;font-size:15px;font-weight:700;"><span>Total</span><span>' + fmtUsd(t.total) + '</span></div>' +
          (anyTbd ? '<div style="padding:2px 8px 0;font-size:10px;color:#8a8f85;text-align:right;line-height:1.5;">Total excludes items marked TBD.</div>' : '') +
          (m.showDeposit !== false ? '<div style="display:flex;justify-content:space-between;padding:6px 8px 0;font-size:13px;color:#3d4a55;font-weight:700;"><span>Deposit Due (' + depositPct() + '%)</span><span>' + fmtUsd(t.deposit) + '</span></div>' : '') +
        '</div></div>' + bottomNotesHtml +
        '<div style="display:flex;gap:40px;margin-top:40px;padding-top:14px;">' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Name</div></div>' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Signature</div></div>' +
          '<div style="flex:0 0 150px;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Date</div></div>' +
        '</div>' + footerNotesHtml +
      '</div>';
    return html;
  }

  /**
   * A standalone document for the server renderer: the same markup, wrapped so it
   * stands alone with no stylesheet, no fonts to fetch and no script. Georgia stands
   * in for Newsreader — a webfont fetch inside a headless browser is the one thing
   * that can hang a render, and the serif shape is what carries the brand here.
   */
  function proposalStandaloneHtml(doc) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(doc.title || 'Proposal') + '</title>' +
      '<style>@page{margin:0.5in;}body{margin:0;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#20241f;}' +
      'tr{break-inside:avoid;}thead{display:table-header-group;}' +
      "*[style*='Newsreader']{font-family:Georgia,serif !important;}</style></head><body>" +
      proposalDocHtml(doc) + '</body></html>';
  }

  function previewProposalDoc(doc, printNow) {
    ensurePrintStyle();
    var html = proposalDocHtml(doc);
    var ov = document.createElement('div');
    ov.id = 'propPreviewOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#e7e8e3;z-index:60;overflow:auto;padding:24px 16px;';
    ov.innerHTML = '<div class="noprint" style="max-width:760px;margin:0 auto 14px;display:flex;justify-content:space-between;gap:10px;"><button class="link-btn" id="pvClose" style="width:auto;padding:9px 16px;background:#fff;">‹ Close preview</button><button class="btn" id="pvPrint" style="width:auto;padding:9px 20px;">Print / Save PDF</button></div>' + html;
    document.body.appendChild(ov);
    document.getElementById('pvClose').addEventListener('click', function () { document.body.removeChild(ov); });
    function firePrint() {
      // Browsers name the saved PDF after the document title, so set it for the print
      // and put it back afterwards.
      var prev = document.title;
      document.title = proposalFileName(doc);
      var restore = function () { document.title = prev; window.removeEventListener('afterprint', restore); };
      window.addEventListener('afterprint', restore);
      window.print();
      setTimeout(restore, 60000);
    }
    document.getElementById('pvPrint').addEventListener('click', firePrint);
    // Save as PDF goes straight through. One frame's delay so the overlay has laid
    // out — the page-break pass measures real geometry and needs it.
    if (printNow) setTimeout(firePrint, 120);
  }

  /**
   * Save-as-PDF file name: Customer Name-Model-Frame Size-Proposal#-MMDDYYYY.
   * Model and frame size are read off the itemized frame heading the builder writes
   * (“SQ-2MBL2T — Itemized” / “Frame Dimensions: 10' × 8'”), so an edited heading is
   * respected and a proposal without a frame simply drops those segments.
   */
  function proposalFileName(d) {
    var model = '', size = '';
    (d.lines || []).forEach(function (l) {
      if ((l.lineType || '') !== 'GROUP') return;
      if (!model && /itemized/i.test(l.name || '')) {
        model = String(l.name).replace(/\s*[-\u2013\u2014]\s*itemized.*$/i, '').trim();
      }
      if (!size) {
        var sm = String(l.description || '').match(/(\d+)\s*'?\s*[\u00d7x]\s*(\d+)/i);
        if (sm) size = sm[1] + 'x' + sm[2];
      }
    });
    var now = new Date();
    var p2 = function (v) { return String(v).length < 2 ? '0' + v : String(v); };
    var today = p2(now.getMonth() + 1) + p2(now.getDate()) + now.getFullYear();
    var rev = (Number(d.version) || 1) > 1 ? 'Rev' + (Number(d.version) - 1) : '';
    return [d.orgName || 'Proposal', model, size, d.number || '', rev, today]
      .filter(Boolean).join('-')
      .replace(/[\\/:*?"<>|]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  function ensurePrintStyle() {
    if (document.getElementById('propPrintStyle')) return;
    var st = document.createElement('style'); st.id = 'propPrintStyle';
    st.textContent = '@page{margin:0.5in;}' +
      '@media print{html,body{height:auto!important;overflow:visible!important;background:#fff!important;}' +
      'body > *{display:none!important;}body > #propPreviewOverlay{display:block!important;}' +
      '#propPreviewOverlay{position:static!important;inset:auto!important;height:auto!important;background:#fff!important;padding:0!important;overflow:visible!important;}#propPreviewOverlay .noprint{display:none!important;}' +
      // Keep rows, headings and the totals block from being split across sheets.
      //
      // This is deliberately CSS rather than measured-and-spaced markup. An earlier
      // version walked the rendered rows and inserted spacer rows to push headings off
      // a page bottom, but it measured the on-screen preview while the print layout has
      // its own geometry — so the arithmetic was wrong and it left visible holes in the
      // middle of the document. The browser is the only thing that knows where a page
      // break will actually fall, so the rules below tell it what to keep together and
      // nothing moves anything by hand.
      '#propPrintArea tr,#propPrintArea thead{break-inside:avoid!important;page-break-inside:avoid!important;}' +
      // A heading must not be the last thing on a sheet: keep it with what follows, and
      // keep the row after it with the heading. Both halves are needed — either one
      // alone is treated as advisory by the print engines.
      '#propPrintArea tr[data-brk="head"]{break-after:avoid!important;page-break-after:avoid!important;}' +
      '#propPrintArea tr[data-brk="head"] + tr{break-before:avoid!important;page-break-before:avoid!important;}' +
      '#propPrintArea thead{display:table-header-group;}' +
      '#propPrintArea{padding:0!important;max-width:none!important;}}';
    document.head.appendChild(st);
  }

  /* --- Adventure Series guided configurator (decision tree) --- */
  /**
   * Legs for a frame length. Mirrors legsForLength() in src/proposals/formulaSettings.ts,
   * including the hard floor: a frame over 10 ft gets at least six legs no matter what the
   * editable bands say. The bands are admin-editable, so a saved "Small frame up to 20"
   * used to quote a 20 ft frame on four legs.
   */
  var FOUR_LEG_MAX_FT = 10, MIN_LEGS_OVER_FOUR_LEG_MAX = 6;
  function legsFor(len) {
    len = Number(len) || 0;
    var banded = len <= Number(fxSettings.legsSmallMaxFt) ? Number(fxSettings.legsSmallCount)
      : len <= Number(fxSettings.legsMediumMaxFt) ? Number(fxSettings.legsMediumCount)
      : Number(fxSettings.legsLargeCount);
    if (!Number.isFinite(banded) || banded <= 0) banded = MIN_LEGS_OVER_FOUR_LEG_MAX;
    return len > FOUR_LEG_MAX_FT ? Math.max(banded, MIN_LEGS_OVER_FOUR_LEG_MAX) : banded;
  }
  function _xlfnPrefix(config) { return config === 'Square' ? 'SQ-' : config === 'L-Shape' ? 'L-' : config === 'T-Shape' ? 'T-' : 'R-'; }
  var adv = null;
  function openAdventureConfigurator() {
    adv = advBlank();
    // Reopen where the proposal actually is. The configurator used to reset to a
    // 10×10 square every time, so revisiting it on a draft meant re-answering
    // everything and then generating a second set of lines beside the first.
    var prior = pb && pb.meta ? pb.meta.advAnswers : null;
    if (prior) advApplyAnswers(prior);
    else adv.legs = legsFor(adv.length);
    advOverridable = null;
    loadAdvOverridable();
    var ov = document.createElement('div');
    ov.id = 'advOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.4);z-index:70;overflow:auto;padding:24px 16px;';
    document.body.appendChild(ov);
    renderAdv();
  }
  function advBlank() {
    return {
      length: 10, width: 10, config: 'Square', legs: 6, legsAuto: true, configManual: false,
      monkeyBars: false, monkeyBarsQty: 1, ladders: false, laddersQty: 1, ladderShield: false,
      trolley: false, trolleyType: 'Dual', interiorBeams: false, interiorBeamsQty: 1,
      zipLine: false, zipLineQty: 1, ballRack: false,
      slide: false, slideA2216: false, slideGray: false, steamroller: false, slideConvKit: false,
      cargoNet: false, cargoNet10x8: false, cargoNet10x8Qty: 1, cargoNet8x6: false, cargoNet8x6Qty: 1,
      cargoHwCarabiner: true, cargoHwCarabinerQty: 1, cargoHwVRing: true, cargoHwVRingQty: 2,
      climbFrame: false, climbWall: false, climbShield: false, climbMat: false,
      matFloor: false, matColumn: false, uShaped: 0, completeWrap: 0, matLadderLeg: false, matCustom: false,
      floorPadding: false, floorPadThickness: '3.25',
      brackets: false, bracketsQty: 0, swivel360: 0, swivelStandalone: 0, forged: 0, swingHanger: 0, vRings: 0, carabiner: 0, webbingSling: 0,
      partOverrides: {},
      hwTouched: {},
    };
  }

  /**
   * The stored answers, back into the configurator's own shape.
   *
   * The two differ in a few places on purpose: the engine takes `ladders` as a count
   * while the form has a toggle and a quantity beside it, and the form tracks which
   * fields a rep has typed in so catalog defaults cannot overwrite them. Everything
   * reloaded counts as touched — a saved quantity is a decision, and re-seeding it
   * from the catalog on reopen would quietly undo that decision.
   */
  function advApplyAnswers(a) {
    if (!a) return;
    adv.length = Number(a.length) || 10;
    adv.width = Number(a.width) || 10;
    adv.config = a.config || autoConfig();
    adv.configManual = adv.config !== autoConfig();
    // A saved leg count is a decision and is kept, except where it is below the
    // engineering minimum for the length — answers stored while the leg-count bands
    // were misconfigured hold a 4 on frames that need six.
    adv.legs = Math.max(Number(a.legs) || legsFor(adv.length), adv.length > FOUR_LEG_MAX_FT ? MIN_LEGS_OVER_FOUR_LEG_MAX : 0);
    adv.monkeyBars = !!a.monkeyBars; adv.monkeyBarsQty = Number(a.monkeyBarsQty) || 1;
    adv.ladders = Number(a.ladders) > 0; adv.laddersQty = Number(a.ladders) || 1;
    adv.trolley = !!a.trolley; adv.trolleyType = a.trolleyType || 'Dual';
    adv.interiorBeams = !!a.interiorBeams; adv.interiorBeamsQty = Number(a.interiorBeamsQty) || 1;
    adv.zipLine = !!a.zipLine; adv.zipLineQty = Number(a.zipLineQty) || 1;
    adv.ballRack = !!a.ballRack;
    adv.slide = !!a.slide; adv.slideGray = !!a.slideGray; adv.steamroller = !!a.steamroller;
    // Undefined means the answer predates the toggle, when the deck always shipped.
    adv.slideA2216 = a.slideA2216 === undefined ? !!a.slide : !!a.slideA2216;
    // Undefined means the answer predates the toggle, when the kit always rode with
    // the ramp — see slideConvKitOn() in adventureSeries.ts.
    adv.slideConvKit = a.slideConvKit === undefined ? !!a.steamroller : !!a.slideConvKit;
    adv.cargoNet = !!a.cargoNet;
    adv.cargoNet10x8 = !!a.cargoNet10x8; adv.cargoNet10x8Qty = Number(a.cargoNet10x8Qty) || 1;
    adv.cargoNet8x6 = !!a.cargoNet8x6; adv.cargoNet8x6Qty = Number(a.cargoNet8x6Qty) || 1;
    adv.cargoHwCarabiner = a.cargoHwCarabiner !== false;
    adv.cargoHwCarabinerQty = Number(a.cargoHwCarabinerQty) || 1;
    adv.cargoHwVRing = a.cargoHwVRing !== false;
    adv.cargoHwVRingQty = Number(a.cargoHwVRingQty) || 2;
    adv.climbFrame = !!a.climbFrame; adv.climbWall = !!a.climbWall;
    adv.climbShield = !!a.climbShield; adv.climbMat = !!a.climbMat;
    adv.floorPadding = !!(a.floorPadding || a.matFloor);
    adv.floorPadThickness = a.floorPadThickness === '2' ? '2' : '3.25';
    adv.matColumn = !!a.matColumn; adv.uShaped = Number(a.uShaped) || 0; adv.completeWrap = Number(a.completeWrap) || 0;
    adv.matLadderLeg = !!a.matLadderLeg; adv.matCustom = !!a.matCustom;
    adv.brackets = !!a.brackets; adv.bracketsQty = Number(a.bracketsQty) || 0; adv.swivel360 = Number(a.swivel360) || 0;
    adv.swivelStandalone = Number(a.swivelStandalone) || 0; adv.forged = Number(a.forged) || 0;
    adv.swingHanger = Number(a.swingHanger) || 0; adv.vRings = Number(a.vRings) || 0;
    adv.carabiner = Number(a.carabiner) || 0; adv.webbingSling = Number(a.webbingSling) || 0;
    adv.partOverrides = a.partOverrides ? JSON.parse(JSON.stringify(a.partOverrides)) : {};
    adv.hwTouched = { forged: 1, swivelStandalone: 1, swingHanger: 1, vRings: 1, carabiner: 1, webbingSling: 1 };
  }

  /** True when this proposal already carries a generated Adventure Series set. */
  function advAlreadyBuilt() { return !!(pb && pb.meta && pb.meta.advAnswers); }
  function advGenLabel() { return advAlreadyBuilt() ? 'Revise Current Proposal' : 'Generate Proposal'; }

  function advClose() { var o = document.getElementById('advOverlay'); if (o) document.body.removeChild(o); }
  function climbWalls() { return (adv.climbFrame ? 1 : 0) + (adv.climbWall ? 1 : 0); }
  /**
   * What the cargo net adds to the fastener totals. Mirrors
   * CARGO_NET_CARABINER_PER_NET / CARGO_NET_VRING_PER_NET in adventureSeries.ts so the
   * form can state the number before the server prices it — keep both in step. These
   * are ADDED to the quantities answered under Hardware rather than becoming their own
   * lines, so the same part number never appears on a proposal twice.
   */
  function cargoNetOn() { return !!(adv.cargoNet && (adv.cargoNet10x8 || adv.cargoNet8x6)); }
  function eyeboltSum() { var nonSwivel = Math.max(0, (Number(adv.bracketsQty) || 0) - (Number(adv.swivel360) || 0)); return (Number(adv.swivel360) || 0) + nonSwivel + (Number(adv.forged) || 0) + (Number(adv.swingHanger) || 0); }

  /**
   * Floor padding price, mirroring src/proposals/matPricing.ts so the builder can
   * show the number before the server prices the proposal. Keep both in step.
   */
  function matRate(th) {
    var v = Number(fxSettings[th === '2' ? 'matCostPerSqFt2' : 'matCostPerSqFt325']);
    return Number.isFinite(v) ? v : (th === '2' ? 7.65 : 11.78);
  }
  function matMarkup() { var v = Number(fxSettings.matMarkupMultiplier); return Number.isFinite(v) && v > 0 ? v : 1.4; }
  function matOverageIn() { var v = Number(fxSettings.matOverageIn); return Number.isFinite(v) ? v : 14; }

  /**
   * The part number each Additional Hardware quantity resolves to, mirroring
   * hardwareRules.ts and the accessory constants in adventureSeries.ts. Shown so a
   * rep can see what they are actually quoting. An array means the answer drives
   * more than one part, which is never substitutable.
   */
  /**
   * The net's carabiner is the 50-pack of snap hooks, NOT the 4-pack auto-locking
   * carabiner answered under Essential Carabiners & Connectors. Mirrors
   * CARGO_NET_CARABINER_PART in adventureSeries.ts.
   */
  var CARGO_NET_CARABINER_PART = 'B0937DRYYF';
  var ADV_HW_PARTS = {
    forged: '6820H-LP',
    swivelStandalone: 'SSG-SA-SWIVEL-EYE',
    swingHanger: 'B0C4Y8XSNB',
    vRings: 'B07MB985GW',
    carabiner: 'B0CDVDZSB1',
    webbingSling: '6820H-LAN',
  };
  /** Parts a quantity also pulls into the H-1000 kit, per unit answered. */
  var ADV_HW_ROLLUP = {
    vRings: [{ part: '6820H-LAE', per: 10 }, { part: '6820H-LAF', per: 10 }],
  };
  /** Parts the CATALOG has pre-approved for substitution. Null until loaded. */
  var advOverridable = null;
  /** Catalog default quantities, part -> number. Empty until loaded. */
  var advDefaults = {};
  async function loadAdvOverridable() {
    var map = {}, defs = {};
    try {
      var r = await authed('/skus/builder-meta');
      if (r.ok) {
        var d = await r.json();
        (d.items || []).forEach(function (s) {
          if (s.overrideAllowed) map[s.part] = s.description || '';
          if (s.defaultQty != null) defs[s.part] = Number(s.defaultQty) || 0;
        });
      }
    } catch (e) { /* leave empty — nothing is overridable or defaulted if we cannot confirm it */ }
    advOverridable = map;
    advDefaults = defs;
    applyHwDefaults();
    if (document.getElementById('advOverlay')) renderAdv();
  }

  /**
   * Seed the Additional Hardware quantities from the catalog defaults. Only fields
   * the rep has not touched are seeded — an entered quantity always wins, including
   * a deliberate 0. Parts with no catalog default stay at 0.
   */
  function applyHwDefaults() {
    if (!adv) return;
    adv.hwTouched = adv.hwTouched || {};
    Object.keys(ADV_HW_PARTS).forEach(function (key) {
      var p = ADV_HW_PARTS[key];
      if (Array.isArray(p)) p = p[0];
      var def = advDefaults[p];
      if (def == null || adv.hwTouched[key]) return;
      if (!(Number(adv[key]) > 0)) adv[key] = def;
    });
  }
  function matQuote() {
    var th = adv.floorPadThickness === '2' ? '2' : '3.25';
    var L = Number(adv.length) || 0, W = Number(adv.width) || 0;
    var ov = matOverageIn();
    var li = L * 12 + ov, wi = W * 12 + ov;
    var sqIn = li * wi, sqFt = sqIn / 144;
    var costMinor = Math.round(sqFt * matRate(th) * 100);
    var p2 = function (v) { return String(Math.max(0, Math.round(v))).padStart(2, '0'); };
    return {
      thickness: th, matLengthIn: li, matWidthIn: wi, squareInches: sqIn, squareFeet: sqFt,
      rate: matRate(th), sellRate: matRate(th) * matMarkup(),
      costMinor: costMinor, priceMinor: Math.round(costMinor * matMarkup()),
      sku: 'R-SSG-' + p2(L) + p2(W) + 'CLM' + (th === '2' ? '-2' : ''),
    };
  }
  function padThicknessPicker() {
    var th = adv.floorPadThickness === '2' ? '2' : '3.25';
    function opt(val, label, sub) {
      var on = th === val;
      return '<label style="flex:1;display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border:1px solid ' + (on ? '#3d4a55' : '#dcded7') + ';border-radius:10px;background:' + (on ? '#f3f6f8' : '#fff') + ';cursor:pointer;">' +
        '<input type="radio" name="advPadTh" data-ak="floorPadThickness" value="' + val + '"' + (on ? ' checked' : '') + ' style="margin-top:2px;">' +
        '<span><b style="font-weight:600;font-size:13.5px;">' + label + '</b><span class="muted" style="display:block;font-size:11.5px;">' + sub + '</span></span></label>';
    }
    // Sell rate, not cost. The configurator is opened in front of customers, so no
    // part of it quotes what we pay or the markup applied to it.
    var per = function (v) { return '$' + (matRate(v) * matMarkup()).toFixed(2) + ' / sq ft'; };
    return '<div style="font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px;">Padding thickness</div>' +
      '<div style="display:flex;gap:10px;">' + opt('3.25', '3.25" thick', per('3.25')) + opt('2', '2" thick', per('2')) + '</div>';
  }
  function padQuoteHint() {
    var q = matQuote();
    return '<div style="margin-top:10px;background:#f8f9f6;border:1px solid #e7e8e3;border-radius:10px;padding:10px 12px;font-size:12px;color:#5c6157;line-height:1.6;">' +
      '<div style="font-family:ui-monospace,monospace;font-size:11.5px;color:#3d4a55;font-weight:600;">' + esc(q.sku) + '</div>' +
      q.matLengthIn + '" × ' + q.matWidthIn + '" = ' + q.squareInches.toLocaleString() + ' sq in ÷ 144 = <b>' + q.squareFeet.toFixed(2) + ' sq ft</b><br>' +
      q.squareFeet.toFixed(2) + ' sq ft × $' + q.sellRate.toFixed(2) + ' = <b style="color:#2f7d5d;">' + fmtMoney(q.priceMinor, 'USD') + '</b>' +
      '</div>';
  }

  function renderAdv() {
    var o = document.getElementById('advOverlay'); if (!o) return;
    var nonSwivel = Math.max(0, (Number(adv.bracketsQty) || 0) - (Number(adv.swivel360) || 0));
    var carabRec = Math.ceil(eyeboltSum() / 4);
    function sec(title, inner) { return '<div style="margin-bottom:18px;"><div style="font-family:\'Newsreader\',serif;font-size:16px;font-weight:600;color:#3d4a55;border-bottom:1px solid #e7e8e3;padding-bottom:6px;margin-bottom:12px;">' + title + '</div>' + inner + '</div>'; }
    function num(key, label, min, max, extra, hint) { return '<div class="af" style="' + (extra || '') + '"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">' + label + '</label><input type="number" data-ak="' + key + '" value="' + adv[key] + '"' + (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') + ' style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;">' + (hint ? '<span class="muted" style="font-size:11px;">' + hint + '</span>' : '') + '</div>'; }
    function tog(key, label, hint) { return '<label style="display:flex;align-items:center;gap:9px;padding:8px 0;cursor:pointer;font-size:14px;border-bottom:1px solid #f2f3ef;"><input type="checkbox" data-ak="' + key + '"' + (adv[key] ? ' checked' : '') + ' style="width:17px;height:17px;flex:0 0 auto;"><span style="flex:1;"><b style="font-weight:600;">' + label + '</b>' + (hint ? '<span class="muted" style="font-size:12px;display:block;">' + hint + '</span>' : '') + '</span></label>'; }
    function sel(key, label, opts) { return '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">' + label + '</label><select data-ak="' + key + '" style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;background:#fff;">' + opts.map(function (op) { return '<option value="' + op + '"' + (String(adv[key]) === String(op) ? ' selected' : '') + '>' + op + '</option>'; }).join('') + '</select></div>'; }
    /** The part number under a hardware quantity — editable only when pre-approved. */
    function hwPartRow(key) {
      var p = ADV_HW_PARTS[key]; if (!p) return '';
      var lab = 'font-size:10.5px;color:#8a8f85;letter-spacing:.02em;';
      if (Array.isArray(p)) return '<div style="' + lab + 'margin-top:5px;">Part ' + p.map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' + ') + '</div>';
      if (!advOverridable) return '<div style="' + lab + 'margin-top:5px;">Part <code>' + esc(p) + '</code></div>';
      if (!(p in advOverridable)) return '<div style="' + lab + 'margin-top:5px;">Part <code>' + esc(p) + '</code> · fixed</div>';
      var cur = (adv.partOverrides && adv.partOverrides[p]) || p, swapped = cur !== p;
      return '<div style="display:flex;align-items:center;gap:6px;margin-top:5px;">' +
        '<span style="' + lab + 'flex:0 0 auto;">Part</span>' +
        '<input data-ovr="' + esc(p) + '" value="' + esc(cur) + '" style="flex:1;min-width:0;padding:4px 7px;border:1px solid ' + (swapped ? '#c9a227' : '#dcded7') + ';border-radius:6px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' +
        (swapped
          ? '<button data-ovrclear="' + esc(p) + '" style="border:none;background:none;color:#8a8f85;cursor:pointer;font-size:11px;padding:2px 3px;flex:0 0 auto;">reset</button>'
          : '<span style="font-size:10px;color:#3f9d78;flex:0 0 auto;">pre-approved</span>') +
      '</div>';
    }
    /** The catalog default under a hardware quantity, with a one-click way back to it. */
    function hwDefaultRow(key) {
      var p = ADV_HW_PARTS[key]; if (Array.isArray(p)) p = p[0];
      var def = advDefaults[p];
      if (def == null) return '';
      var cur = Number(adv[key]) || 0;
      return '<div style="font-size:10.5px;color:#8a8f85;margin-top:4px;">Catalog default ' + def +
        (cur !== def
          ? ' · <button data-hwdef="' + key + '" style="border:none;background:none;padding:0;color:#3d4a55;text-decoration:underline;cursor:pointer;font-size:10.5px;">use default</button>'
          : ' · applied') +
        '</div>';
    }
    /** What a quantity adds behind the visible line, priced inside H-1000. */
    function hwRollRow(key) {
      var r = ADV_HW_ROLLUP[key]; if (!r) return '';
      var q = Number(adv[key]) || 0; if (q <= 0) return '';
      return '<div style="font-size:10.5px;color:#8a8f85;margin-top:3px;">Also adds ' +
        r.map(function (x) { return (q * x.per) + '× <code>' + esc(x.part) + '</code>'; }).join(' + ') +
        ' into the H-1000 hardware kit</div>';
    }
    function hwNum(key, label, min, max, hint) { return '<div>' + num(key, label, min, max, '', hint) + hwDefaultRow(key) + hwPartRow(key) + hwRollRow(key) + '</div>'; }
    var grid = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;';
    var stack = 'display:flex;flex-direction:column;gap:10px;';

    var html =
      '<div style="max-width:720px;margin:0 auto;background:#fbfbf9;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.5);overflow:hidden;">' +
        '<div style="background:#3d4a55;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:2;">' +
          '<div><div style="font-family:\'Newsreader\',serif;font-size:20px;font-weight:600;">Summit Adventure Series</div><div style="font-size:12px;color:#cdd6dc;">Answer the questions — the proposal builds itself</div></div>' +
          '<button id="advX" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;">Cancel</button>' +
        '</div>' +
        '<div style="padding:22px 24px;">' +
          sec('Frame Dimensions', '<div style="' + grid + '">' + sel('length', 'Length (long, ft)', rangeArr(6, 30)) + sel('width', 'Width (short, ft)', rangeArr(6, 20)) + '</div>') +
          sec('Frame Configuration', '<div style="' + grid + '">' + sel('config', 'Configuration' + (adv.configManual ? ' (overridden)' : ' (auto)'), ['Rectangle', 'Square', 'L-Shape', 'T-Shape']) + num('legs', '# of Frame Legs (auto, editable)', 0, 20) + '</div>' +
            '<div class="muted" style="font-size:11.5px;margin-top:6px;">' + (adv.configManual ? 'Manually set — auto would be ' + autoConfig() + '. <a href="#" id="advCfgReset">Reset to auto</a>' : 'Auto from dimensions: ' + autoConfig()) + ' · legs auto-set from length (' + legsFor(adv.length) + ')' + (Number(adv.legs) !== legsFor(adv.length) ? ' — currently ' + Number(adv.legs) + ', set by hand' : '') + '</div>') +
          sec('Frame Options',
            tog('monkeyBars', 'Monkey Bars') + (adv.monkeyBars ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('monkeyBarsQty', '# of Monkey Bars', 1, 3) + '</div>' : '') +
            tog('ladders', 'Ladders') + (adv.ladders ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('laddersQty', '# of Ladders', 1, 4) + '</div>' + tog('ladderShield', 'Ladder — Safety Shield', 'Qty mirrors # of ladders (' + adv.laddersQty + ')') : '') +
            tog('trolley', 'Trolley System') + (adv.trolley ? '<div style="' + grid + 'margin:8px 0 4px;">' + sel('trolleyType', 'Type of Trolley System', ['Dual', 'Single']) + '</div>' : '') +
            tog('interiorBeams', 'Interior Beams') + (adv.interiorBeams ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('interiorBeamsQty', '# of Interior Beams', 1, 6) + '</div>' : '')
          ) +
          sec('Frame Accessories',
            tog('zipLine', 'Zip Line') + (adv.zipLine ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('zipLineQty', '# of Zip Line', 1, 3) + '</div>' : '') +
            tog('ballRack', 'Frame Mount — Ball Rack') +
            tog('slide', 'Summit Adventure Slide System') +
            (adv.slide ? '<div style="padding-left:16px;">' +
              tog('slideA2216', 'Slide', 'Part A-2216') +
              tog('slideGray', 'Slide — Gray Upcharge') +
              tog('steamroller', 'Steamroller Ramp (3rd Party)', 'Ticks the conversion kit below') +
              (adv.steamroller ? '<div style="padding-left:16px;">' + tog('slideConvKit', 'Adventure Steamroller/Scooter Board — Conversion Kit', 'Part A-2349 · required with the ramp') + '</div>' : '') +
            '</div>' : '') +
            tog('cargoNet', 'Cargo Net') +
            (adv.cargoNet ? '<div style="padding-left:16px;">' +
              tog('cargoNet10x8', "10' x 8' — Climbing Cargo Net Black", 'Part B07V3J9S2R') +
              (adv.cargoNet10x8 ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('cargoNet10x8Qty', "# of 10' x 8' nets", 1, 20) + '</div>' : '') +
              tog('cargoNet8x6', "8' x 6' — Climbing Cargo Net Black", 'Part B07TSDMPNQ') +
              (adv.cargoNet8x6 ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('cargoNet8x6Qty', "# of 8' x 6' nets", 1, 20) + '</div>' : '') +
              (adv.cargoNet10x8 || adv.cargoNet8x6
                ? '<div style="margin-top:10px;padding:10px 12px;background:#f8f9f6;border:1px solid #e7e8e3;border-radius:9px;">' +
                    '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#8a8f85;margin-bottom:2px;">Comes with the net · prints under Cargo Net</div>' +
                    tog('cargoHwCarabiner', 'Heavy Duty Carabiners — 5/16" Spring Snap (50 Pack)', 'Part ' + CARGO_NET_CARABINER_PART) +
                    (adv.cargoHwCarabiner !== false ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('cargoHwCarabinerQty', '# of carabiner packs', 1, 40) + '</div>' : '') +
                    tog('cargoHwVRing', 'V-Ring Bolt', 'Part ' + ADV_HW_PARTS.vRings) +
                    (adv.cargoHwVRing !== false ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('cargoHwVRingQty', '# of V-ring packs', 1, 40) + '</div>' : '') +
                  '</div>'
                : '') +
            '</div>' : '') +
            tog('climbFrame', 'Climbing Wall — Frame Mounted') + tog('climbWall', 'Climbing Wall — Wall Mounted') +
            (climbWalls() > 0 ? '<div style="padding-left:16px;">' + tog('climbShield', 'Climbing Wall — Safety Shield', 'Qty mirrors # climbing walls (' + climbWalls() + ')') + tog('climbMat', 'Climbing Wall — Mat', 'Qty mirrors # climbing walls (' + climbWalls() + ')') + '</div>' : '')
          ) +
          // Two fixings that belong to the whole frame rather than to any one
          // accessory, so they have their own section instead of sitting at the very
          // bottom under Additional Hardware where they were routinely missed.
          sec('Essential Carabiners &amp; Connectors',
            '<div style="' + stack + '">' +
              hwNum('carabiner', 'Auto-Locking Carabiner (4pk)', 0, 8, 'Suggested: ' + carabRec + ' — enter a quantity to include it') +
              hwNum('webbingSling', 'Multi-Pocket Webbing Sling', 0, 16, 'Suggested: ' + (Number(adv.legs) || 0) + ' (one per leg)') +
            '</div>'
          ) +
          sec('Mats & Padding',
            tog('floorPadding', 'Floor Padding', 'Sized from the frame: 14" added to each side. Priced per sq ft.') +
            (adv.floorPadding ? '<div style="margin:8px 0 12px;padding-left:16px;">' + padThicknessPicker() + padQuoteHint() + '</div>' : '') +
            tog('matColumn', 'Adventure Mat System — Column') +
            (adv.matColumn ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('uShaped', 'U-Shaped Column Wraps (def = # ladders)', 0, 40) + num('completeWrap', 'Complete Column Wraps (def = legs − U-shaped)', 0, 40) + '</div>' : '') +
            tog('matLadderLeg', 'Adventure Mat System — Ladder Leg', 'Qty = # of ladders (' + adv.laddersQty + ')') +
            tog('matCustom', 'Adventure Mat System — CUSTOM', 'Mat SKU logic to be provided — added as manual line')
          ) +
          sec('Hardware',
            '<div style="font-weight:600;font-size:13.5px;color:#3d4a55;margin-bottom:4px;">Quick Shift Saddle Bracket</div>' +
            tog('brackets', 'Quick Shift Saddle Bracket') +
            (adv.brackets ? '<div style="' + stack + 'margin:10px 0 4px;">' +
              num('bracketsQty', '# of Saddle Brackets', 0, 8) +
              num('swivel360', '# of 360 Swivel / 180 Eye Bolts (≤ brackets)', 0, 8) +
              '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;margin-bottom:4px;"># of 3/8" Non-Swivel Eye Bolts (auto)</label><input value="' + nonSwivel + '" disabled style="width:100%;padding:8px 10px;border:1px solid #eef0ea;border-radius:8px;font-size:14px;background:#f2f3ef;"></div>' +
            '</div>' : '') +
            '<div style="' + stack + 'margin-top:14px;border-top:1px solid #f2f3ef;padding-top:14px;">' +
              hwNum('forged', '# 1/2" Forged Eye Bolts (×6)', 0, 36) +
              hwNum('swivelStandalone', '# Swing &amp; Swivel Eye Bolt (stand-alone)', 0, 24) +
              hwNum('swingHanger', '# Swing Hanger w/ Bearing (×2)', 0, 12) +
            '</div>'
          ) +
          '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid #e7e8e3;">' +
            // Revising already knows which lines are its own, so the blunt "replace
            // everything" switch is only offered on a first build.
            (advAlreadyBuilt()
              ? '<div class="muted" style="font-size:12px;line-height:1.5;max-width:300px;">Replaces the lines this configurator generated and re-pulls their catalog prices. Anything you added by hand is left alone.</div>'
              : '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#5c6157;"><input type="checkbox" id="advReplace"> Replace existing lines</label>') +
            '<div style="display:flex;gap:8px;align-items:flex-start;">' +
            '<button class="link-btn" id="advTrace" style="width:auto;padding:11px 16px;">Test the logic →</button>' +
            '<button class="btn" id="advGen" style="width:auto;padding:11px 22px;">' + advGenLabel() + '</button></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    o.innerHTML = html;
    o.addEventListener('mousedown', function (e) { if (e.target === o) advClose(); });
    document.getElementById('advX').addEventListener('click', advClose);
    var cfgReset = document.getElementById('advCfgReset');
    if (cfgReset) cfgReset.addEventListener('click', function (e) { e.preventDefault(); adv.configManual = false; adv.config = autoConfig(); renderAdv(); });
    document.getElementById('advGen').addEventListener('click', function () {
      var rp = document.getElementById('advReplace');
      generateAdvLines(!!(rp && rp.checked));
    });
    document.getElementById('advTrace').addEventListener('click', function () { openAdvTrace(); });
    o.querySelectorAll('[data-ovr]').forEach(function (el) {
      el.addEventListener('change', function () {
        var base = el.getAttribute('data-ovr'), v = el.value.trim();
        adv.partOverrides = adv.partOverrides || {};
        if (!v || v === base) delete adv.partOverrides[base]; else adv.partOverrides[base] = v;
        renderAdvKeepingTab(null, '[data-ovr="' + base.replace(/"/g, '') + '"]');
      });
    });
    o.querySelectorAll('[data-ovrclear]').forEach(function (b) {
      b.addEventListener('click', function () { if (adv.partOverrides) delete adv.partOverrides[b.getAttribute('data-ovrclear')]; renderAdv(); });
    });
    o.querySelectorAll('[data-hwdef]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-hwdef'), p = ADV_HW_PARTS[key];
        if (Array.isArray(p)) p = p[0];
        adv[key] = advDefaults[p] || 0;
        adv.hwTouched = adv.hwTouched || {};
        delete adv.hwTouched[key];
        renderAdv();
      });
    });
    o.querySelectorAll('[data-ak]').forEach(function (el) {
      var k = el.getAttribute('data-ak');
      if (el.type === 'checkbox') { el.addEventListener('change', function () { adv[k] = el.checked; syncAdvDefaults(k); renderAdvKeepingTab(k); }); }
      else {
        el.addEventListener('input', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; markHwTouched(k); });
        el.addEventListener('change', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; markHwTouched(k); syncAdvDefaults(k); renderAdvKeepingTab(k); });
      }
    });
  }
  function renderAdvKeepingTab(key, sel) {
    renderKeepingTab(renderAdv, function () { return document.getElementById('advOverlay'); },
      sel || (key ? '[data-ak="' + key + '"]' : null));
  }

  /** Once a rep types in a hardware field, no default may overwrite it. */
  function markHwTouched(key) {
    if (!(key in ADV_HW_PARTS)) return;
    adv.hwTouched = adv.hwTouched || {};
    adv.hwTouched[key] = true;
  }
  /** Square when the footprint is a square, Rectangle otherwise. */
  function autoConfig() { return (Number(adv.length) || 0) === (Number(adv.width) || 0) ? 'Square' : 'Rectangle'; }

  function syncAdvDefaults(changed) {
    if (changed === 'config') adv.configManual = true;
    if ((changed === 'length' || changed === 'width') && !adv.configManual) adv.config = autoConfig();
    if (changed === 'length') { adv.legs = legsFor(adv.length); }
    // Turning the bracket option ON is an explicit choice, so its own quantities may
    // seed themselves. Nothing under Additional Hardware ever self-populates — a
    // quantity nobody typed used to reach the proposal as a priced line.
    if (changed === 'brackets' && adv.brackets && !Number(adv.bracketsQty)) { adv.bracketsQty = 4; adv.swivel360 = 4; }
    // The ramp cannot be used without its conversion kit, so choosing the ramp ticks
    // the kit. Unticking the ramp puts the kit away with it.
    if (changed === 'steamroller') adv.slideConvKit = !!adv.steamroller;
    // Turning the slide system off puts everything under it away.
    if (changed === 'slide' && !adv.slide) { adv.slideA2216 = false; adv.slideGray = false; adv.steamroller = false; adv.slideConvKit = false; }
    // A net has to hang off something. Both fixings come with the first net and can
    // be unticked afterwards; clearing the section clears them.
    if (changed === 'cargoNet10x8' || changed === 'cargoNet8x6') {
      if (adv.cargoNet10x8 || adv.cargoNet8x6) {
        adv.cargoHwCarabiner = true; adv.cargoHwVRing = true;
        if (!(Number(adv.cargoHwCarabinerQty) > 0)) adv.cargoHwCarabinerQty = 1;
        if (!(Number(adv.cargoHwVRingQty) > 0)) adv.cargoHwVRingQty = 2;
      }
    }
    if (changed === 'cargoNet' && !adv.cargoNet) {
      adv.cargoNet10x8 = false; adv.cargoNet8x6 = false;
      adv.cargoHwCarabiner = true; adv.cargoHwVRing = true;
    }
    if (changed === 'legs' || changed === 'length') { adv.completeWrap = Math.max(0, (Number(adv.legs) || 0) - (Number(adv.uShaped) || 0)); }
    if (changed === 'ladders' || changed === 'laddersQty') { if (adv.ladders && adv.matColumn && !adv.uShaped) adv.uShaped = adv.laddersQty; }
    if (changed === 'matColumn' && adv.matColumn) { if (!adv.uShaped) adv.uShaped = adv.ladders ? adv.laddersQty : 0; adv.completeWrap = Math.max(0, (Number(adv.legs) || 0) - (Number(adv.uShaped) || 0)); }
    if (changed === 'uShaped') { adv.completeWrap = Math.max(0, (Number(adv.legs) || 0) - (Number(adv.uShaped) || 0)); }
  }
  function advAnswers() {
    return {
      length: Number(adv.length), width: Number(adv.width), config: adv.config, legs: Number(adv.legs), ladders: adv.ladders ? Number(adv.laddersQty) : 0,
      monkeyBars: !!adv.monkeyBars, monkeyBarsQty: Number(adv.monkeyBarsQty),
      interiorBeams: !!adv.interiorBeams, interiorBeamsQty: Number(adv.interiorBeamsQty),
      trolley: !!adv.trolley, trolleyType: adv.trolleyType, zipLine: !!adv.zipLine, zipLineQty: Number(adv.zipLineQty), ballRack: !!adv.ballRack,
      slide: !!adv.slide, slideA2216: !!adv.slideA2216, slideGray: !!adv.slideGray, steamroller: !!adv.steamroller, slideConvKit: !!adv.slideConvKit,
      cargoNet: !!adv.cargoNet,
      cargoNet10x8: !!adv.cargoNet10x8, cargoNet10x8Qty: Number(adv.cargoNet10x8Qty) || 1,
      cargoNet8x6: !!adv.cargoNet8x6, cargoNet8x6Qty: Number(adv.cargoNet8x6Qty) || 1,
      cargoHwCarabiner: adv.cargoHwCarabiner !== false, cargoHwCarabinerQty: Number(adv.cargoHwCarabinerQty) || 1,
      cargoHwVRing: adv.cargoHwVRing !== false, cargoHwVRingQty: Number(adv.cargoHwVRingQty) || 2,
      climbFrame: !!adv.climbFrame, climbWall: !!adv.climbWall, climbShield: !!adv.climbShield, climbMat: !!adv.climbMat,
      matFloor: !!adv.floorPadding, matColumn: !!adv.matColumn, uShaped: Number(adv.uShaped), completeWrap: Number(adv.completeWrap), matLadderLeg: !!adv.matLadderLeg, matCustom: !!adv.matCustom,
      floorPadding: !!adv.floorPadding, floorPadThickness: adv.floorPadThickness === '2' ? '2' : '3.25',
      brackets: !!adv.brackets, bracketsQty: Number(adv.bracketsQty), swivel360: Number(adv.swivel360), swivelStandalone: Number(adv.swivelStandalone), forged: Number(adv.forged), swingHanger: Number(adv.swingHanger), vRings: Number(adv.vRings), carabiner: Number(adv.carabiner), webbingSling: Number(adv.webbingSling),
      partOverrides: adv.partOverrides || {},
    };
  }

  /** Logic trace overlay — every derived quantity, its formula, and the catalog price behind it. */
  async function openAdvTrace(answers) {
    var btn = document.getElementById('advTrace'); if (btn) { btn.disabled = true; btn.textContent = 'Tracing…'; }
    var t = null;
    try { var r = await authed('/proposals/adventure-series/trace', { method: 'POST', body: answers || advAnswers() }); if (r.ok) t = await r.json(); } catch (e) {}
    if (btn) { btn.disabled = false; btn.textContent = 'Test the logic →'; }
    if (!t) { alert('Could not reach the logic engine. Is the server running the latest build?'); return; }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.5);z-index:80;overflow:auto;padding:24px 16px;';
    function th(label, right) { return '<th style="text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;border-bottom:2px solid #3d4a55;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#8a8f85;white-space:nowrap;">' + label + '</th>'; }
    var rows = (t.rows || []).map(function (r) {
      return '<tr style="' + (r.rolledIntoH1000 ? 'background:#fdfcf7;' : '') + '">' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-size:11.5px;color:#5c6157;">' + esc(r.rule) + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-family:ui-monospace,monospace;font-size:11px;">' + esc(r.part) + (r.inCatalog ? '' : ' <span style="color:#9c3327;">✕</span>') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-size:11.5px;">' + esc(r.description) + (r.rolledIntoH1000 ? '<span style="color:#8a6d1f;font-size:10.5px;"> — rolled into H-1000</span>' : '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-size:11px;color:#5c6157;">' + esc(r.formula) + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-weight:600;font-size:12px;">' + r.qty + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;">' + fmtMoney(r.unitPriceMinor, '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;font-weight:600;">' + fmtMoney(r.extendedMinor, '') + '</td>' +
        '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;color:#5c6157;">' + fmtMoney(r.extendedCostMinor, '') + '</td></tr>';
    }).join('');
    var hw = t.hardware || { components: [] };
    var hwRows = (hw.components || []).map(function (c) {
      return '<tr><td style="padding:4px 8px;border-bottom:1px solid #eef0ea;font-family:ui-monospace,monospace;font-size:11px;">' + esc(c.part || '—') + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;font-size:11.5px;">' + esc(c.name) + (c.inCatalog ? '' : ' <span style="color:#9c3327;font-size:10.5px;">no SKU record</span>') + (c.edited ? ' <span style="background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:1px 6px;font-size:10px;font-weight:600;">edited formula</span>' : '') + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;font-size:11px;color:#5c6157;">' + esc(c.formula || '') + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;">' + c.qty + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;">' + fmtMoney(c.unitPriceMinor, '') + '</td>' +
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11.5px;font-weight:600;">' + fmtMoney(c.unitPriceMinor * c.qty, '') + '</td></tr>';
    }).join('');
    var warn = (t.warnings || []).length ? '<div style="margin-top:14px;padding:10px 12px;background:#fbecea;border:1px solid #f0d5d0;border-radius:9px;font-size:12px;color:#9c3327;line-height:1.6;">' + t.warnings.map(esc).join('<br>') + '</div>' : '';
    ov.innerHTML =
      '<div style="max-width:1080px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -20px rgba(32,36,31,.55);">' +
        '<div style="background:#3d4a55;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div><div style="font-family:\'Newsreader\',serif;font-size:19px;font-weight:600;">Calculation trace — ' + esc(t.model) + '</div>' +
            '<div style="font-size:12px;color:#cdd6dc;">Frame Dimensions: ' + esc(t.dimensions) + ' · every quantity, formula and catalog price behind this configuration</div></div>' +
          '<button id="trClose" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;">Close</button>' +
        '</div>' +
        '<div style="padding:18px 22px;">' +
          '<div style="display:flex;gap:22px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid #eef0ea;margin-bottom:14px;">' +
            '<div><div style="font-size:10px;text-transform:uppercase;color:#8a8f85;letter-spacing:.05em;">Revenue</div><div style="font-size:17px;font-weight:600;">' + fmtMoney(t.totals.revenueMinor, 'USD') + '</div></div>' +
            '<div><div style="font-size:10px;text-transform:uppercase;color:#8a8f85;letter-spacing:.05em;">COGS</div><div style="font-size:17px;font-weight:600;">' + fmtMoney(t.totals.cogsMinor, 'USD') + '</div></div>' +
            '<div><div style="font-size:10px;text-transform:uppercase;color:#8a8f85;letter-spacing:.05em;">Margin</div><div style="font-size:17px;font-weight:600;color:' + (t.totals.marginMinor >= 0 ? '#2f7d5d' : '#9c3327') + ';">' + fmtMoney(t.totals.marginMinor, 'USD') + ' · ' + t.totals.marginPct + '%</div></div>' +
            '<div><div style="font-size:10px;text-transform:uppercase;color:#8a8f85;letter-spacing:.05em;">Weight</div><div style="font-size:17px;font-weight:600;">' + (t.totals.weightLbs || 0).toLocaleString() + ' lbs</div></div>' +
          '</div>' +
          warn +
          '<div style="font-weight:600;font-size:13.5px;margin:14px 0 6px;">Bill of materials</div>' +
          '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' + th('Rule') + th('Part') + th('Description') + th('Quantity formula') + th('Qty', 1) + th('Unit', 1) + th('Extended', 1) + th('Ext. cost', 1) + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
          '<div style="font-weight:600;font-size:13.5px;margin:20px 0 6px;">H-1000 hardware roll-up</div>' +
          '<div class="muted" style="font-size:12px;margin-bottom:8px;">Fastener quantities are driven off the frame BOM per the v73 workbook. Every one of these is summed into the single H-1000 line — the brackets and eye bolts answered by name in the configurator are excluded here and print as their own proposal lines.</div>' +
          (hwRows ? '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' + th('Part') + th('Component') + th('Quantity formula') + th('Qty', 1) + th('Unit', 1) + th('Extended', 1) + '</tr></thead><tbody>' + hwRows +
            '<tr><td colspan="5" style="padding:7px 8px;text-align:right;font-weight:700;font-size:12.5px;">H-1000 total</td><td style="padding:7px 8px;text-align:right;font-weight:700;font-size:12.5px;">' + fmtMoney(hw.priceMinor, 'USD') + '</td></tr>' +
            '</tbody></table></div>' : '<div class="muted" style="font-size:12.5px;">No hardware selected.</div>') +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) document.body.removeChild(ov); });
    document.getElementById('trClose').addEventListener('click', function () { document.body.removeChild(ov); });
  }

  /**
   * The full calculation behind a rolled-up kit line (H-1000), read from the
   * breakdown stored ON the line. Works on any draft, however long ago it was built
   * and whether or not the configurator answers were kept with it.
   */
  function openHardwareAudit(line) {
    if (!line || !(line.components || []).length) return;
    var comps = line.components.slice().sort(function (x, y) { return String(x.part).localeCompare(String(y.part)); });
    var qtyLine = Number(line.quantity) || 1;
    var sumPrice = comps.reduce(function (s, c) { return s + (Number(c.unitPriceMinor) || 0) * (Number(c.qty) || 0); }, 0);
    var sumCost = comps.reduce(function (s, c) { return s + (Number(c.unitCostMinor) || 0) * (Number(c.qty) || 0); }, 0);
    var sumWeight = comps.reduce(function (s, c) { return s + (Number(c.weightLbs) || 0) * (Number(c.qty) || 0); }, 0);
    var pieces = comps.reduce(function (s, c) { return s + (Number(c.qty) || 0); }, 0);
    var lineRate = (Number(line.rateMinor) || 0) * qtyLine;
    var lineCost = (Number(line.costEach) || 0) * qtyLine;
    var noPrice = comps.filter(function (c) { return !c.unitPriceMinor; }).length;
    // Lines generated before unit prices were stored on the breakdown carry cost and
    // weight only. Reconciling their $0 price sum against the line would read as a
    // pricing fault when nothing is actually wrong.
    var hasPrices = comps.some(function (c) { return Number(c.unitPriceMinor) > 0; });
    var drift = hasPrices && (Math.abs(sumPrice - lineRate) > 1 || Math.abs(sumCost - lineCost) > 1);
    var hasAnswers = !!(pb && pb.meta && pb.meta.advAnswers);
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.5);z-index:80;overflow:auto;padding:24px 16px;';
    function th(label, right) { return '<th style="text-align:' + (right ? 'right' : 'left') + ';padding:6px 8px;border-bottom:2px solid #3d4a55;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#8a8f85;white-space:nowrap;">' + label + '</th>'; }
    function td(v, right, mono) { return '<td style="padding:5px 8px;border-bottom:1px solid #eef0ea;font-size:11.5px;' + (right ? 'text-align:right;' : '') + (mono ? 'font-family:ui-monospace,monospace;font-size:11px;' : '') + '">' + v + '</td>'; }
    function stat(label, value, color) {
      return '<div><div style="font-size:10px;text-transform:uppercase;color:#8a8f85;letter-spacing:.05em;">' + label + '</div>' +
        '<div style="font-size:17px;font-weight:600;' + (color ? 'color:' + color + ';' : '') + '">' + value + '</div></div>';
    }
    var rows = comps.map(function (c) {
      var q = Number(c.qty) || 0;
      var up = Number(c.unitPriceMinor) || 0, uc = Number(c.unitCostMinor) || 0;
      return '<tr>' +
        td(esc(c.part || '—') + (c.inCatalog === false ? ' <span style="color:#9c3327;">✕</span>' : ''), 0, 1) +
        td(esc(c.name || '') + (c.edited ? ' <span style="background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:1px 6px;font-size:10px;font-weight:600;">edited formula</span>' : '')) +
        td('<span style="color:#5c6157;font-family:ui-monospace,monospace;font-size:11px;">' + esc(c.formula || '—') + '</span>') +
        td('<b>' + q + '</b>', 1) +
        td(fmtMoney(up, ''), 1) +
        td(hasPrices ? '<b>' + fmtMoney(up * q, '') + '</b>' : '—', 1) +
        td(fmtMoney(uc, ''), 1) +
        td(fmtMoney(uc * q, ''), 1) +
        td(((Number(c.weightLbs) || 0) * q).toFixed(2), 1) +
      '</tr>';
    }).join('');
    ov.innerHTML =
      '<div style="max-width:1120px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px -20px rgba(32,36,31,.55);">' +
        '<div style="background:#3d4a55;color:#fff;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div><div style="font-family:\'Newsreader\',serif;font-size:19px;font-weight:600;">' + esc(line.sku || 'Kit') + ' — how this line was calculated</div>' +
            '<div style="font-size:12px;color:#cdd6dc;">' + esc(line.name || '') + ' · ' + comps.length + ' part numbers · ' + pieces + ' pieces</div></div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            (hasAnswers ? '<button id="hwLive" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;">Re-run the live logic →</button>' : '') +
            '<button id="hwClose" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;">Close</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:18px 22px;">' +
          '<div style="display:flex;gap:22px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid #eef0ea;margin-bottom:14px;">' +
            stat('Sum of components', hasPrices ? fmtMoney(sumPrice, 'USD') : 'not stored') +
            stat('On the line', fmtMoney(lineRate, 'USD'), drift ? '#9c3327' : '#2f7d5d') +
            stat('Component cost', fmtMoney(sumCost, 'USD')) +
            stat('Cost on the line', fmtMoney(lineCost, 'USD'), Math.abs(sumCost - lineCost) > 1 ? '#9c3327' : '#2f7d5d') +
            stat('Weight', sumWeight.toFixed(2) + ' lbs') +
          '</div>' +
          (drift
            ? '<div style="margin-bottom:14px;padding:10px 12px;background:#fbecea;border:1px solid #f0d5d0;border-radius:9px;font-size:12px;color:#9c3327;line-height:1.6;">The rate or cost on this line no longer matches the sum of its components — someone typed over it, or catalog prices have moved since the line was generated. Re-generate the Adventure Series lines, or pull from the catalog, to bring them back in step.</div>'
            : '') +
          (noPrice && hasPrices
            ? '<div style="margin-bottom:14px;padding:10px 12px;background:#fdf6e6;border:1px solid #ecd9a6;border-radius:9px;font-size:12px;color:#6b5a24;line-height:1.6;">' + noPrice + ' of these part numbers carried no unit price when this line was built, so they added $0.00 to the kit. Set their price in Catalog → Pricing &amp; SKUs and re-generate.</div>'
            : '') +
          (!hasPrices
            ? '<div style="margin-bottom:14px;padding:10px 12px;background:#f8f9f6;border:1px solid #e7e8e3;border-radius:9px;font-size:12px;color:#5c6157;line-height:1.6;">This line was generated before unit prices were kept on the breakdown, so only quantities, costs and weights are stored. The kit total is still the one on the line. Re-generate the Adventure Series lines to see the price side reconciled part by part.</div>'
            : '') +
          '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' +
            th('Part') + th('Component') + th('Quantity formula') + th('Qty', 1) + th('Unit', 1) + th('Extended', 1) + th('Unit cost', 1) + th('Ext. cost', 1) + th('Weight', 1) +
          '</tr></thead><tbody>' + rows +
            '<tr><td colspan="3" style="padding:8px;text-align:right;font-weight:700;font-size:12.5px;">Totals</td>' +
            td('<b>' + pieces + '</b>', 1) + td('', 1) + td('<b>' + (hasPrices ? fmtMoney(sumPrice, 'USD') : '—') + '</b>', 1) + td('', 1) + td('<b>' + fmtMoney(sumCost, 'USD') + '</b>', 1) + td('<b>' + sumWeight.toFixed(2) + '</b>', 1) +
          '</tr></tbody></table></div>' +
          '<div class="muted" style="font-size:11.5px;margin-top:12px;line-height:1.6;">Quantities come from Administration → Formulas → Hardware quantities, evaluated against this configuration when the lines were generated. Prices and costs are the catalog figures at that moment. The eye bolts and brackets answered by name in the configurator print as their own lines and are deliberately excluded from this kit, so nothing is billed twice.' +
            (hasAnswers ? '' : ' This proposal was built before the configurator answers were kept with the proposal, so the live re-run is not available here — re-generate the lines from the configurator to enable it.') + '</div>' +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) document.body.removeChild(ov); });
    document.getElementById('hwClose').addEventListener('click', function () { document.body.removeChild(ov); });
    var live = document.getElementById('hwLive');
    if (live) live.addEventListener('click', function () { openAdvTrace(pb.meta.advAnswers); });
  }

  async function generateAdvLines(replace) {
    var btn = document.getElementById('advGen'); if (btn) { btn.disabled = true; btn.textContent = 'Pricing…'; }
    var answers = advAnswers();
    var priced = null;
    try {
      var r = await authed('/proposals/adventure-series/price', { method: 'POST', body: answers });
      if (r.ok) priced = await r.json();
    } catch (e) {}
    if (!priced) { if (btn) { btn.disabled = false; btn.textContent = advGenLabel(); } alert('Could not reach the pricing engine. Is the server running the latest build?'); return; }
    var out = (priced.lines || []).map(function (l) {
      return normalizeLine({
        lineType: l.lineType, kind: l.lineType === 'GROUP' ? 'GROUP' : l.lineType === 'SUBGROUP' ? 'SUBGROUP' : l.lineType === 'NOTE' ? 'NOTE' : 'INCLUDED',
        name: l.name, sku: l.sku || '', description: l.description || '', quantity: l.quantity == null ? 0 : l.quantity,
        rateMinor: l.rateMinor || 0, costEach: l.costEach || 0, weightEach: l.weightEach || 0, optional: !!l.optional,
        internalNote: l.internalNote || '', components: l.components || null, source: 'ADV',
      });
    });
    out.forEach(applyItemDefaults);
    var revising = advAlreadyBuilt();
    if (revising) {
      var at = replaceAdvLines(out);
      if (at === -1) pb.lines = pb.lines.concat(out);
    } else if (replace) {
      pb.lines = out;
    } else {
      pb.lines = pb.lines.concat(out);
    }
    // Kept with the proposal so the hardware logic can be re-run against the same
    // configuration later, on a draft nobody has open in the configurator.
    pb.meta.advAnswers = answers;
    pb.meta.advWarnings = priced.warnings || [];
    hoistHardwareKit(pb.lines);
    applyAllTriggeredNotes();
    // The configurator has just produced the kit itself — record its quantities so
    // the automatic refresh does not immediately recompute what was just computed.
    hwSig = JSON.stringify(hardwareQty());
    advClose(); renderBuilder();
    var bl = document.getElementById('bLines'); if (bl) bl.scrollIntoView({ block: 'start' });
  }
  /**
   * Swap the configurator's own lines for a freshly generated set, in place.
   *
   * Revising used to append, so a second pass through the configurator left two of
   * every line. What makes a clean replacement possible is knowing which lines belong
   * to the configurator: lines it generated carry source 'ADV'.
   *
   * Proposals built before that marker existed have none, so they are matched instead
   * against the set the configurator WOULD have produced — the same generated block,
   * compared on line type, part number and name. Only a line that matches something
   * in the new set is removed, and each match is consumed once, so a part a rep added
   * by hand on top of a generated one survives. If nothing can be matched the caller
   * appends rather than guessing.
   *
   * Returns the index the block was written back to, or -1 when nothing was replaced.
   */
  function replaceAdvLines(out) {
    var owned = [];
    for (var i = 0; i < pb.lines.length; i++) if (pb.lines[i] && pb.lines[i].source === 'ADV') owned.push(i);

    if (!owned.length) {
      // Legacy fallback: match on identity against the new set.
      var key = function (l) {
        return (l.lineType || 'PRODUCT') + '|' + String(l.sku || '').toUpperCase() + '|' + String(l.name || '').trim().toLowerCase();
      };
      var wanted = {};
      out.forEach(function (l) { var k = key(l); wanted[k] = (wanted[k] || 0) + 1; });
      for (var j = 0; j < pb.lines.length; j++) {
        var k2 = key(pb.lines[j]);
        if (wanted[k2] > 0) { wanted[k2]--; owned.push(j); }
      }
      if (!owned.length) return -1;
    }

    var at = owned[0];
    // Back to front, so the earlier indexes stay valid as we splice.
    for (var d = owned.length - 1; d >= 0; d--) pb.lines.splice(owned[d], 1);
    // Anything sitting between the removed lines has moved up; the block goes back
    // where it started, which keeps a hand-added line below it below it.
    if (at > pb.lines.length) at = pb.lines.length;
    pb.lines.splice.apply(pb.lines, [at, 0].concat(out));
    return at;
  }

  function rangeArr(a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; }

  /* --- Summit Soar configurator ---------------------------------------------
   * Ported from the "Soar Series Build Logic" block of the product workbook.
   * Soar is a catalogue pick: choose one or more of the eight K-40xx frames, then
   * optionally switch on the padding & column-wrap package, whose five lines carry
   * the workbook's Default Qty values. Server engine: src/proposals/soarSeries.ts.
   */
  var soar = null, soarCat = null;
  var SOAR_FRAME_FALLBACK = [
    { part: 'K-4000', label: 'S1 — Single Cross Beam', xl: false },
    { part: 'K-4002', label: 'S2 — Two Cross Beams', xl: false },
    { part: 'K-4003', label: 'S3 — Three Cross Beams', xl: false },
    { part: 'K-4001', label: "S1-XL — Single Cross Beam (Width 12')", xl: true },
    { part: 'K-4006', label: "S2-XL — Two Cross Beams (Width 12')", xl: true },
    { part: 'K-4007', label: "S3-XL — Three Cross Beams (Width 12')", xl: true },
    { part: 'K-4004', label: "S1 — Single Cross Beam (Height 7')", xl: false },
    { part: 'K-4005', label: "S2 — Single Cross Beam (Height 7')", xl: false }
  ];
  var SOAR_PAD_FALLBACK = [
    { key: 'matXlQty', part: 'CLM325', defaultQty: 0, matFor: 'xl', description: 'Soar-XL Floor Mat System (138" x 80" x 3.25") - Single Fold' },
    { key: 'matStdQty', part: 'SSM80100', defaultQty: 1, matFor: 'std', description: 'Soar Floor Mat System (100" x 80" x 3.25") - Single Fold' },
    { key: 'uWrapQty', part: 'COLU2812', defaultQty: 4, description: 'Soar Base Beam U Column Wrap' },
    { key: 'gussetQty', part: 'SFGPC', defaultQty: 2, description: 'Gusset Plate Padding' },
    { key: 'colWrapQty', part: 'COLW2812', defaultQty: 2, description: 'Soar Column Wrap' }
  ];
  function soarFrameList() { return soarCat && soarCat.frames && soarCat.frames.length ? soarCat.frames : SOAR_FRAME_FALLBACK; }
  function soarPadList() { return soarCat && soarCat.padRows && soarCat.padRows.length ? soarCat.padRows : SOAR_PAD_FALLBACK; }

  function openSoarConfigurator() {
    soar = {
      rows: [{ part: 'K-4000', qty: 1 }],
      padding: false,
      matXlQty: null, matStdQty: null, uWrapQty: null, gussetQty: null, colWrapQty: null,
      includeOverview: true
    };
    var ov = document.createElement('div');
    ov.id = 'soarOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.4);z-index:70;overflow:auto;padding:24px 16px;';
    document.body.appendChild(ov);
    renderSoar();
    if (!soarCat) loadSoarCatalog();
  }
  function soarClose() { var o = document.getElementById('soarOverlay'); if (o) document.body.removeChild(o); }
  async function loadSoarCatalog() {
    try {
      var r = await authed('/proposals/soar-series/catalog');
      if (r.ok) soarCat = (await r.json()) || null;
    } catch (e) {}
    if (document.getElementById('soarOverlay')) renderSoar();
  }
  function soarUnits() { return soar.rows.reduce(function (s, r) { return s + (Number(r.qty) || 0); }, 0); }
  /** Padding defaults for the current frame mix — mirrors soarPadDefaults() server-side. */
  function soarPadDefaults() {
    var byPart = {};
    soarFrameList().forEach(function (f) { byPart[f.part] = f; });
    var xl = 0, std = 0;
    soar.rows.forEach(function (r) {
      var q = Number(r.qty) || 0; if (q <= 0) return;
      if (byPart[r.part] && byPart[r.part].xl) xl += q; else std += q;
    });
    var units = xl + std || 1, out = {};
    soarPadList().forEach(function (p) {
      out[p.key] = p.matFor === 'xl' ? xl : p.matFor === 'std' ? std : (p.defaultQty || 0) * units;
    });
    return out;
  }
  function soarVal(key, fallback) { return soar[key] == null || soar[key] === '' ? fallback : Math.max(0, Number(soar[key]) || 0); }

  function renderSoar() {
    var o = document.getElementById('soarOverlay'); if (!o) return;
    var frames = soarFrameList(), pads = soarPadList(), defs = soarPadDefaults();
    function sec(title, inner, note) {
      return '<div style="margin-bottom:18px;">' +
        '<div style="font-family:\'Newsreader\',serif;font-size:16px;font-weight:600;color:#3d4a55;border-bottom:1px solid #e7e8e3;padding-bottom:6px;margin-bottom:12px;">' + title + '</div>' +
        inner + (note ? '<div class="muted" style="font-size:11.5px;margin-top:8px;">' + note + '</div>' : '') + '</div>';
    }
    var frameRows = soar.rows.map(function (r, i) {
      var hit = null;
      frames.forEach(function (f) { if (f.part === r.part) hit = f; });
      var price = hit && hit.unitPriceMinor ? hit.unitPriceMinor : 0;
      var missing = hit && hit.inCatalog === false;
      return '<div style="margin-bottom:9px;">' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<select data-sfpart="' + i + '" style="flex:1;min-width:0;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;background:#fff;">' +
            frames.map(function (f) {
              return '<option value="' + esc(f.part) + '"' + (f.part === r.part ? ' selected' : '') + '>' +
                esc(f.part) + ' — ' + esc(f.label) + (f.unitPriceMinor ? '  ' + fmtMoney(f.unitPriceMinor, 'USD') : '') + '</option>';
            }).join('') +
          '</select>' +
          '<input type="number" min="0" data-sfqty="' + i + '" value="' + r.qty + '" title="Quantity" style="width:74px;flex:0 0 auto;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;text-align:right;">' +
          (soar.rows.length > 1
            ? '<button data-sfdel="' + i + '" style="border:none;background:none;color:#8a8f85;cursor:pointer;font-size:18px;line-height:1;padding:0 4px;flex:0 0 auto;" title="Remove">×</button>'
            : '<span style="width:22px;flex:0 0 auto;"></span>') +
        '</div>' +
        (missing
          ? '<div style="font-size:11px;color:#b4522e;margin-top:3px;">Not in the catalog yet — import the Soar workbook so this prices.</div>'
          : (price ? '<div style="font-size:11px;color:#8a8f85;margin-top:3px;">' + fmtMoney(price * (Number(r.qty) || 0), 'USD') + ' extended</div>' : '')) +
      '</div>';
    }).join('');

    var padBody = !soar.padding ? '' : '<div style="margin-top:4px;">' +
      pads.map(function (p) {
        var isDef = soar[p.key] == null || soar[p.key] === '';
        var v = soarVal(p.key, defs[p.key]);
        return '<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #f2f3ef;' + (v <= 0 ? 'opacity:.55;' : '') + '">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13.5px;font-weight:600;">' + esc(p.description || p.part) + '</div>' +
            '<div style="font-size:11px;color:#8a8f85;margin-top:2px;"><code>' + esc(p.part) + '</code>' +
              (p.unitPriceMinor ? ' · ' + fmtMoney(p.unitPriceMinor, 'USD') + ' each' : '') +
              (p.matFor ? ' · mat for ' + (p.matFor === 'xl' ? "12' frames" : 'standard frames') : '') +
              (isDef ? ' · <span style="color:#3f9d78;">workbook default</span>' : ' · <span style="color:#b4522e;">overridden</span>') +
            '</div>' +
          '</div>' +
          '<input type="number" min="0" data-sk="' + p.key + '" value="' + v + '" style="width:82px;flex:0 0 auto;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;text-align:right;">' +
        '</div>';
      }).join('') + '</div>';

    o.innerHTML =
      '<div style="max-width:720px;margin:0 auto;background:#fbfbf9;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.5);overflow:hidden;">' +
        '<div style="background:#3d4a55;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:2;">' +
          '<div><div style="font-family:\'Newsreader\',serif;font-size:20px;font-weight:600;">Summit Soar Series</div>' +
          '<div style="font-size:12px;color:#cdd6dc;">Pick the frame, choose padding — the proposal builds itself</div></div>' +
          '<button id="soarX" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;">Cancel</button>' +
        '</div>' +
        '<div style="padding:22px 24px;">' +
          sec('Swing Frame', frameRows +
            '<button class="link-btn" id="soarAddFrame" style="width:auto;padding:7px 13px;font-size:12.5px;">+ Add another frame</button>',
            soarUnits() + ' frame' + (soarUnits() === 1 ? '' : 's') + ' on this proposal. All eight models are K-40xx parts.') +
          sec('Padding / Column Wraps',
            '<label style="display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;font-size:14px;">' +
              '<input type="checkbox" data-sk="padding"' + (soar.padding ? ' checked' : '') + ' style="width:17px;height:17px;flex:0 0 auto;">' +
              '<span><b style="font-weight:600;">Include the padding package</b>' +
              '<span class="muted" style="font-size:12px;display:block;">Floor mat, base beam U wraps, gusset plate padding and column wraps</span></span>' +
            '</label>' + padBody,
            soar.padding ? 'Quantities are the workbook defaults (4 / 2 / 2 per frame). The mat follows frame width — XL frames take CLM325, everything else SSM80100. Edit any number to override.' : '') +
          '<label style="display:flex;align-items:center;gap:9px;font-size:13px;color:#5c6157;cursor:pointer;padding:6px 0;">' +
            '<input type="checkbox" data-sk="includeOverview"' + (soar.includeOverview ? ' checked' : '') + '> Print the Summit Soar overview &amp; Engineer-of-Record copy on each frame line' +
          '</label>' +
          '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid #e7e8e3;">' +
            '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#5c6157;"><input type="checkbox" id="soarReplace"> Replace existing lines</label>' +
            '<button class="btn" id="soarGen" style="width:auto;padding:11px 22px;">Generate proposal lines →</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    o.addEventListener('mousedown', function (e) { if (e.target === o) soarClose(); });
    document.getElementById('soarX').addEventListener('click', soarClose);
    document.getElementById('soarGen').addEventListener('click', function () { generateSoarLines(document.getElementById('soarReplace').checked); });
    document.getElementById('soarAddFrame').addEventListener('click', function () {
      var used = soar.rows.map(function (r) { return r.part; });
      var next = frames.filter(function (f) { return used.indexOf(f.part) < 0; })[0] || frames[0];
      soar.rows.push({ part: next.part, qty: 1 }); renderSoar();
    });
    o.querySelectorAll('[data-sfpart]').forEach(function (el) {
      el.addEventListener('change', function () {
        var ix = Number(el.getAttribute('data-sfpart'));
        soar.rows[ix].part = el.value;
        renderKeepingTab(renderSoar, function () { return document.getElementById('soarOverlay'); }, '[data-sfpart="' + ix + '"]');
      });
    });
    o.querySelectorAll('[data-sfqty]').forEach(function (el) {
      el.addEventListener('change', function () {
        var ix = Number(el.getAttribute('data-sfqty'));
        soar.rows[ix].qty = Math.max(0, Number(el.value) || 0);
        renderKeepingTab(renderSoar, function () { return document.getElementById('soarOverlay'); }, '[data-sfqty="' + ix + '"]');
      });
    });
    o.querySelectorAll('[data-sfdel]').forEach(function (el) {
      el.addEventListener('click', function () { soar.rows.splice(Number(el.getAttribute('data-sfdel')), 1); renderSoar(); });
    });
    o.querySelectorAll('[data-sk]').forEach(function (el) {
      var key = el.getAttribute('data-sk');
      el.addEventListener('change', function () {
        if (el.type === 'checkbox') soar[key] = el.checked;
        else soar[key] = el.value === '' ? null : Math.max(0, Number(el.value) || 0);
        renderKeepingTab(renderSoar, function () { return document.getElementById('soarOverlay'); }, '[data-sk="' + key + '"]');
      });
    });
  }
  function soarAnswers() {
    var a = {
      frames: soar.rows.filter(function (r) { return (Number(r.qty) || 0) > 0; })
        .map(function (r) { return { part: r.part, qty: Number(r.qty) || 0 }; }),
      padding: !!soar.padding,
      includeOverview: !!soar.includeOverview
    };
    // Only send a quantity the rep actually typed, so the server applies its own
    // workbook default otherwise and the two can never drift apart.
    soarPadList().forEach(function (p) {
      if (soar[p.key] != null && soar[p.key] !== '') a[p.key] = Math.max(0, Number(soar[p.key]) || 0);
    });
    return a;
  }
  /** Same contract as the Adventure path — see replaceAdvLines. */
  async function generateSoarLines(replace) {
    var btn = document.getElementById('soarGen');
    if (btn) { btn.disabled = true; btn.textContent = 'Pricing…'; }
    var priced = null;
    try {
      var r = await authed('/proposals/soar-series/price', { method: 'POST', body: soarAnswers() });
      if (r.ok) priced = await r.json();
    } catch (e) {}
    if (!priced) {
      if (btn) { btn.disabled = false; btn.textContent = 'Generate proposal lines →'; }
      alert('Could not reach the pricing engine. Is the server running the latest build?');
      return;
    }
    var out = (priced.lines || []).map(function (l) {
      return normalizeLine({
        lineType: l.lineType,
        kind: l.lineType === 'GROUP' ? 'GROUP' : l.lineType === 'SUBGROUP' ? 'SUBGROUP' : l.lineType === 'NOTE' ? 'NOTE' : 'INCLUDED',
        name: l.name, sku: l.sku || '', description: l.description || '',
        quantity: l.quantity == null ? 0 : l.quantity, rateMinor: l.rateMinor || 0,
        costEach: l.costEach || 0, weightEach: l.weightEach || 0, optional: !!l.optional,
        internalNote: l.internalNote || '', components: l.components || null
      });
    });
    out.forEach(applyItemDefaults);
    if (replace) pb.lines = out; else pb.lines = pb.lines.concat(out);
    soarClose();
    renderBuilder();
  }

  /**
   * Generic "start from a product line" picker (currently Summit Flex). Unlike
   * Adventure/Soar, this line has no bespoke configurator — it is just its tier
   * tree, so the picker fetches that tree and lets a rep check the products they
   * want at whatever quantity the catalog defaults to.
   */
  var linePicker = null;
  function openLinePicker(lineName) {
    linePicker = { lineName: lineName, nodes: null, error: null, checked: {}, qty: {} };
    var ov = document.createElement('div');
    ov.id = 'linePickerOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.4);z-index:70;overflow:auto;padding:24px 16px;';
    document.body.appendChild(ov);
    renderLinePicker();
    loadLineTree(lineName);
  }
  function linePickerClose() { var o = document.getElementById('linePickerOverlay'); if (o) document.body.removeChild(o); linePicker = null; }

  async function loadLineTree(lineName) {
    try {
      var r = await authed('/proposals/line-tree/' + encodeURIComponent(lineName));
      if (r.ok) {
        var nodes = (await r.json()) || [];
        linePicker.nodes = nodes;
        // Prefill every product's quantity from the tier's default, falling back to
        // the product's own default — nothing is checked yet, so nothing is added
        // until the rep opts in.
        nodes.forEach(function (n) { if (n.sku) linePicker.qty[n.slug] = n.defaultQuantity != null ? n.defaultQuantity : 1; });
      } else {
        linePicker.error = 'Could not load ' + lineName + ' (' + r.status + ').';
      }
    } catch (e) {
      linePicker.error = 'Could not reach the server.';
    }
    if (document.getElementById('linePickerOverlay')) renderLinePicker();
  }

  /**
   * Sibling order within a tier.
   *
   * The workbook's sortOrder wins where it is set. Where a whole run of siblings
   * shares one number — the belts all import as 0 — falling back to insertion
   * order put XX Small after Medium. Size is the meaning behind those names, so
   * it is what breaks the tie, and plain alphabetical is the last resort.
   */
  var SIZE_ORDER = ['xxxs', 'xxs', 'xs', 'x small', 'small', 'medium', 'large', 'x large', 'xl', 'xxl', 'xxxl'];
  function sizeRank(name) {
    var n = String(name || '').toLowerCase();
    var m = n.match(/\(\s*size\s*[-–—:]?\s*([^)]+)\)/);
    var size = (m ? m[1] : n).trim().replace(/\s+/g, ' ');
    var table = [
      [/^(xxx\s*small|3x\s*small|xxxs)$/, 0],
      [/^(xx\s*small|2x\s*small|xxs)$/, 1],
      [/^(x\s*small|xs)$/, 2],
      [/^(small|s)$/, 3],
      [/^(medium|med|m)$/, 4],
      [/^(large|l)$/, 5],
      [/^(x\s*large|xl)$/, 6],
      [/^(xx\s*large|2x\s*large|xxl)$/, 7],
      [/^(xxx\s*large|3x\s*large|xxxl)$/, 8],
    ];
    for (var i = 0; i < table.length; i++) if (table[i][0].test(size)) return table[i][1];
    return null;
  }
  function linePickerSiblingCmp(a, b) {
    var d = (Number(a.node.sortOrder) || 0) - (Number(b.node.sortOrder) || 0);
    if (d) return d;
    var ra = sizeRank(a.node.name), rb = sizeRank(b.node.name);
    if (ra != null && rb != null && ra !== rb) return ra - rb;
    if (ra != null && rb == null) return -1;
    if (ra == null && rb != null) return 1;
    return String(a.node.name || '').localeCompare(String(b.node.name || ''));
  }

  /**
   * A header whose products are sold as one kit — every part beneath it is
   * required, so the group is checked and unchecked as a unit and the individual
   * rows are not separately selectable.
   */
  function isKitHeader(node) {
    return !!node && !node.sku && /\bkits?\b/i.test(String(node.name || ''));
  }
  /** The kit header above this entry, if any — kits do not nest. */
  function kitAncestor(entries, slug) {
    var found = null;
    (function walk(list, kit) {
      list.forEach(function (e) {
        var k = kit || (isKitHeader(e.node) ? e.node : null);
        if (e.node.slug === slug) found = k;
        walk(e.children, k);
      });
    })(entries, null);
    return found;
  }

  /** Flat nodes -> a parent/child tree, siblings in sortOrder. */
  function linePickerTree() {
    var nodes = linePicker.nodes || [];
    var bySlug = {};
    nodes.forEach(function (n) { bySlug[n.slug] = { node: n, children: [] }; });
    var roots = [];
    nodes.forEach(function (n) {
      var entry = bySlug[n.slug];
      var parent = n.parentSlug ? bySlug[n.parentSlug] : null;
      if (parent) parent.children.push(entry); else roots.push(entry);
    });
    (function sortRec(list) { list.sort(linePickerSiblingCmp); list.forEach(function (e) { sortRec(e.children); }); })(roots);
    return roots;
  }
  /** Depth-first walk of a linePickerTree(), in tier sort order. */
  function walkLinePickerTree(entries, depth, visit) {
    entries.forEach(function (e) { visit(e.node, depth, e); walkLinePickerTree(e.children, depth + 1, visit); });
  }
  /** Every checkbox-able product beneath a header entry, at any depth. */
  function productDescendantSlugs(entry) {
    var out = [];
    entry.children.forEach(function (c) {
      if (c.node.sku) out.push(c.node.slug); else out = out.concat(productDescendantSlugs(c));
    });
    return out;
  }
  /** The tree entry for a slug, searching a linePickerTree() result. */
  function findLinePickerEntry(entries, slug) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].node.slug === slug) return entries[i];
      var found = findLinePickerEntry(entries[i].children, slug);
      if (found) return found;
    }
    return null;
  }

  function renderLinePicker() {
    var o = document.getElementById('linePickerOverlay'); if (!o) return;
    var nodes = linePicker.nodes;
    var body;
    if (linePicker.error) {
      body = '<div style="padding:24px;color:#b4522e;">' + esc(linePicker.error) + '</div>';
    } else if (!nodes) {
      body = '<div class="muted" style="padding:24px;text-align:center;">Loading…</div>';
    } else if (!nodes.length) {
      body = '<div class="muted" style="padding:24px;text-align:center;">No items found for ' + esc(linePicker.lineName) + '.</div>';
    } else {
      var rows = '';
      var tree = linePickerTree();
      walkLinePickerTree(tree, 0, function (n, depth, entry) {
        var indent = depth * 20;
        if (!n.sku) {
          // A header node — Tier 1 is the section heading; anything deeper is a
          // sub-heading purely for visual grouping in the tree. A header with no
          // product beneath it (a TBD placeholder) stays a plain heading; one with
          // products gets a checkbox that reflects and drives their check state.
          var isTier1 = n.tierLevel === 1;
          var prodSlugs = productDescendantSlugs(entry);
          var headerCheck = '';
          var kit = isKitHeader(n);
          if (prodSlugs.length) {
            var checkedN = prodSlugs.filter(function (s) { return !!linePicker.checked[s]; }).length;
            var state = checkedN === 0 ? 'none' : checkedN === prodSlugs.length ? 'all' : 'some';
            headerCheck = '<input type="checkbox" class="lpHeaderCheck" data-slug="' + esc(n.slug) + '" data-state="' + state + '"' + (state === 'all' ? ' checked' : '') + ' style="width:16px;height:16px;flex:0 0 auto;margin-right:8px;">';
          }
          rows += '<div style="display:flex;align-items:center;margin-left:' + indent + 'px;padding:' + (isTier1 ? '14px 0 6px' : '8px 0 4px') + ';' + (isTier1 ? 'border-top:1px solid #e7e8e3;' : '') + '">' +
            headerCheck +
            '<span style="font-weight:600;font-size:' + (isTier1 ? '14.5px' : '13px') + ';color:#3d4a55;">' + esc(n.name) + '</span>' +
            (kit ? '<span style="margin-left:8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;border:1px solid #dcded7;border-radius:999px;padding:2px 8px;">All parts required</span>' : '') +
          '</div>';
          return;
        }
        var checked = !!linePicker.checked[n.slug];
        var qty = linePicker.qty[n.slug] != null ? linePicker.qty[n.slug] : 1;
        var price = n.unitPriceMinor || 0;
        // Inside a kit the row is not independently selectable: the header owns the
        // whole group. The box still reports the state, so the rep can see what the
        // kit contains and that all of it is coming.
        var inKit = !!kitAncestor(tree, n.slug);
        rows += '<label style="display:flex;align-items:center;gap:10px;padding:6px 0;margin-left:' + indent + 'px;cursor:' + (inKit ? 'default' : 'pointer') + ';">' +
          '<input type="checkbox" class="lpCheck" data-slug="' + esc(n.slug) + '"' + (checked ? ' checked' : '') + (inKit ? ' disabled title="Part of a kit — the whole kit is selected together"' : '') + ' style="width:16px;height:16px;flex:0 0 auto;">' +
          '<span style="flex:1;min-width:0;font-size:13.5px;">' + esc(n.name) + ' <span class="muted" style="font-size:11.5px;">' + esc(n.sku) + (price ? ' · ' + fmtMoney(price, 'USD') + ' each' : '') + '</span></span>' +
          '<input type="number" min="0" class="lpQty" data-slug="' + esc(n.slug) + '" value="' + qty + '"' + (checked ? '' : ' disabled') + ' style="width:64px;flex:0 0 auto;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;font-size:13px;text-align:right;">' +
        '</label>';
      });
      body = rows;
    }
    var checkedCount = Object.keys(linePicker.checked).filter(function (k) { return linePicker.checked[k]; }).length;

    o.innerHTML =
      '<div style="max-width:640px;margin:0 auto;background:#fbfbf9;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.5);overflow:hidden;">' +
        '<div style="background:#3d4a55;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:2;">' +
          '<div><div style="font-family:\'Newsreader\',serif;font-size:20px;font-weight:600;">' + esc(linePicker.lineName) + '</div>' +
          '<div style="font-size:12px;color:#cdd6dc;">Check the items to add, set quantities, then insert</div></div>' +
          '<button id="lpX" style="border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;">Cancel</button>' +
        '</div>' +
        '<div style="padding:22px 24px;max-height:60vh;overflow:auto;">' + body + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:16px 24px;border-top:1px solid #e7e8e3;">' +
          '<span class="muted" style="font-size:12.5px;">' + checkedCount + ' item' + (checkedCount === 1 ? '' : 's') + ' selected</span>' +
          '<button class="btn" id="lpGen" style="width:auto;padding:11px 22px;"' + (checkedCount ? '' : ' disabled') + '>Insert into proposal →</button>' +
        '</div>' +
      '</div>';

    o.addEventListener('mousedown', function (e) { if (e.target === o) linePickerClose(); });
    var x = document.getElementById('lpX'); if (x) x.addEventListener('click', linePickerClose);
    var gen = document.getElementById('lpGen'); if (gen) gen.addEventListener('click', insertLinePickerSelection);
    o.querySelectorAll('.lpCheck').forEach(function (el) {
      el.addEventListener('change', function () {
        linePicker.checked[el.getAttribute('data-slug')] = el.checked;
        renderLinePicker();
      });
    });
    o.querySelectorAll('.lpQty').forEach(function (el) {
      el.addEventListener('change', function () { linePicker.qty[el.getAttribute('data-slug')] = Math.max(0, Number(el.value) || 0); });
    });
    o.querySelectorAll('.lpHeaderCheck').forEach(function (el) {
      // Indeterminate is a DOM property, not a markup attribute — it has to be set
      // here, after the checkbox already exists.
      if (el.getAttribute('data-state') === 'some') el.indeterminate = true;
      el.addEventListener('change', function () {
        var entry = findLinePickerEntry(tree, el.getAttribute('data-slug'));
        if (!entry) return;
        productDescendantSlugs(entry).forEach(function (slug) { linePicker.checked[slug] = el.checked; });
        renderLinePicker();
      });
    });
  }

  /**
   * One PRODUCT line per checked node, in tier sort order. A Tier 1 header
   * becomes a GROUP section heading whenever it has at least one checked
   * descendant, checked at any depth beneath it — mirroring how the rest of
   * the builder's groups work (one heading, its lines follow).
   */
  function insertLinePickerSelection() {
    var out = [];
    function hasCheckedDescendant(entry) {
      return entry.children.some(function (c) { return (c.node.sku && linePicker.checked[c.node.slug]) || (!c.node.sku && hasCheckedDescendant(c)); });
    }
    function walk(entries) {
      entries.forEach(function (e) {
        var n = e.node;
        if (!n.sku) {
          if (n.tierLevel === 1 && hasCheckedDescendant(e)) {
            out.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: n.name, description: '', quantity: 0, rateMinor: 0, group: '', optional: false });
          }
          walk(e.children);
          return;
        }
        if (!linePicker.checked[n.slug]) return;
        var qty = linePicker.qty[n.slug] != null ? Math.max(0, Number(linePicker.qty[n.slug]) || 0) : 1;
        out.push(applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: null, sku: n.sku, name: n.name, description: '', quantity: qty, rateMinor: 0, group: '' }));
      });
    }
    walk(linePickerTree());
    if (out.length) pb.lines = pb.lines.concat(out);
    linePickerClose();
    renderBuilder();
  }

  function openLockForm(versionId, user) {
    openModal('Lock to operational order',
      fieldRow('Approval method', selectEl('aMethod', ['SIGNATURE', 'COUNTERSIGNED_PROPOSAL', 'PURCHASE_ORDER', 'EMAIL', 'VERBAL', 'PORTAL'], 'COUNTERSIGNED_PROPOSAL')) +
      fieldRow('Approver name', '<input id="aName" style="' + IN + '" required>') +
      fieldRow('Approver title', '<input id="aTitle" style="' + IN + '">') +
      fieldRow('PO number (optional)', '<input id="aPo" style="' + IN + '">') +
      fieldRow('Approved on', '<input id="aDate" type="date" value="' + todayISO() + '" style="' + IN + '">') +
      fieldRow('Notes', '<textarea id="aNotes" rows="2" style="' + IN + 'resize:vertical;"></textarea>'),
      async function (close, showErr) {
        var name = document.getElementById('aName').value.trim(); if (!name) return showErr('Approver name is required.');
        var body = { method: document.getElementById('aMethod').value, approverName: name, approverTitle: document.getElementById('aTitle').value.trim() || undefined, poNumber: document.getElementById('aPo').value.trim() || undefined, approvedAt: new Date(document.getElementById('aDate').value || Date.now()).toISOString(), notes: document.getElementById('aNotes').value.trim() || undefined };
        var r = await authed('/orders/from-version/' + versionId, { method: 'POST', body: body });
        if (!r.ok) {
          var msg = '';
          try { msg = ((await r.json()) || {}).message || ''; } catch (e) {}
          return showErr(msg || 'Could not lock order (' + r.status + ').');
        }
        close(); alert('Operational order created.');
        var nb = document.querySelector('[data-view="orders"]'); if (nb) nb.click();
      }, 'Lock order');
  }

  /* --- Orders & Bill of Materials --- */
  /**
   * Unlock an operational order so a last-minute customer change can be made. The
   * order is cancelled (kept on record with the reason) and a new draft version of
   * the proposal is cloned for the edit.
   */
  function openUnlockForm(order, user) {
    openModal('Unlock ' + (order.number || 'order') + ' for changes',
      '<div style="background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#8a6d1f;line-height:1.55;margin-bottom:12px;">' +
        'The order is cancelled and kept on record with this reason on its timeline. The accepted proposal stays frozen as the signed record, and a new draft version is created for the change. Re-accept and lock the new version when the customer signs off.' +
      '</div>' +
      '<div class="field"><label>Reason (required)</label><textarea id="ulReason" rows="3" placeholder="e.g. Customer added a second zip line before production started" style="' + IN + 'resize:vertical;"></textarea></div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="ulRevision" checked> Create a new draft version to edit</label>',
      async function (close, showErr) {
        var reason = document.getElementById('ulReason').value.trim();
        if (reason.length < 4) return showErr('Please give a reason — it goes on the order record.');
        var r = await authed('/orders/' + order.id + '/unlock', { method: 'POST', body: { reason: reason, createRevision: document.getElementById('ulRevision').checked } });
        if (!r.ok) {
          var msg = ''; try { msg = ((await r.json()) || {}).message || ''; } catch (e) {}
          return showErr(msg || 'Could not unlock (' + r.status + ').');
        }
        var d = await r.json();
        close();
        if (d.revision) {
          alert('Order ' + (d.number || '') + ' unlocked. Draft v' + d.revision.version + ' is ready to edit.');
          activateNav('proposals');
          openProposalDetail(d.proposalId, user);
        } else {
          alert('Order ' + (d.number || '') + ' unlocked.');
          renderOrders(user);
        }
      }, 'Unlock order');
  }

  /* --- Orders list: columns are configurable; customer + signed date lead. --- */
  var ORDER_COLS = [
    { key: 'customer', label: 'Customer', fixed: true, cell: function (o) { return '<b style="font-weight:600;">' + esc(o.customer || '—') + '</b>'; }, plain: function (o) { return o.customer || ''; } },
    { key: 'signedAt', label: 'Signed', fixed: true, cell: function (o) { return fmtDate(o.signedAt); }, plain: function (o) { return o.signedAt || ''; } },
    { key: 'number', label: 'Order', cell: function (o) { return esc(o.number); }, plain: function (o) { return o.number; } },
    { key: 'status', label: 'Status', cell: function (o) { return '<span class="chip">' + titleCase(o.status) + '</span>'; }, plain: function (o) { return titleCase(o.status); } },
    { key: 'total', label: 'Total', cell: function (o) { return fmtMoney(o.grandTotalMinor, o.currency); }, plain: function (o) { return money(o.grandTotalMinor); } },
    { key: 'deposit', label: 'Deposit', cell: function (o) { return o.depositRequired ? fmtMoney(o.depositDueMinor, o.currency) : '—'; }, plain: function (o) { return o.depositRequired ? money(o.depositDueMinor) : ''; } },
    { key: 'createdAt', label: 'Created', cell: function (o) { return fmtDate(o.createdAt); }, plain: function (o) { return o.createdAt || ''; } },
    { key: 'balance', label: 'Balance due', cell: function (o) { return fmtMoney(o.balanceDueMinor, o.currency); }, plain: function (o) { return money(o.balanceDueMinor); } },
    { key: 'proposalNumber', label: 'Proposal #', cell: function (o) { return esc(o.proposalNumber || '—'); }, plain: function (o) { return o.proposalNumber || ''; } },
    { key: 'proposalTitle', label: 'Project', cell: function (o) { return esc(o.proposalTitle || '—'); }, plain: function (o) { return o.proposalTitle || ''; } },
    { key: 'acceptedVersion', label: 'Accepted version', cell: function (o) { return o.acceptedVersion ? 'v' + o.acceptedVersion : '—'; }, plain: function (o) { return o.acceptedVersion || ''; } },
    { key: 'approvedBy', label: 'Approved by', cell: function (o) { return esc(o.approvedBy || '—'); }, plain: function (o) { return o.approvedBy || ''; } },
    { key: 'approvalMethod', label: 'Approval method', cell: function (o) { return o.approvalMethod ? titleCase(o.approvalMethod) : '—'; }, plain: function (o) { return titleCase(o.approvalMethod || ''); } },
    { key: 'poNumber', label: 'PO number', cell: function (o) { return esc(o.poNumber || '—'); }, plain: function (o) { return o.poNumber || ''; } },
    { key: 'tasks', label: 'Open tasks', cell: function (o) { return (o.openTasks || 0) + ' / ' + (o.taskCount || 0); }, plain: function (o) { return (o.openTasks || 0) + ' of ' + (o.taskCount || 0); } },
    { key: 'requirements', label: 'Open requirements', cell: function (o) { return (o.openRequirements || 0) + ' / ' + (o.requirementCount || 0); }, plain: function (o) { return (o.openRequirements || 0) + ' of ' + (o.requirementCount || 0); } },
    { key: 'procurement', label: 'Sourced', cell: function (o) { return (o.procurementSourced || 0) + ' / ' + (o.procurementCount || 0); }, plain: function (o) { return (o.procurementSourced || 0) + ' of ' + (o.procurementCount || 0); } },
    { key: 'qbo', label: 'QuickBooks', cell: function (o) { return o.qboEstimateTxnId ? '<span class="chip">Linked</span>' : '<span class="muted">Not pushed</span>'; }, plain: function (o) { return o.qboEstimateTxnId ? 'Linked' : 'Not pushed'; } },
    { key: 'monday', label: 'monday.com', cell: function (o) { return o.mondayProjectId ? '<span class="chip">Linked</span>' : '<span class="muted">—</span>'; }, plain: function (o) { return o.mondayProjectId ? 'Linked' : ''; } },
    { key: 'updatedAt', label: 'Last activity', cell: function (o) { return fmtDate(o.updatedAt); }, plain: function (o) { return o.updatedAt || ''; } }
  ];
  var ORDER_COLS_DEFAULT = ['customer', 'signedAt', 'number', 'status', 'total', 'deposit', 'createdAt'];
  var ORDER_COLS_KEY = 'ssg.orderColumns';
  function money(minor) { return minor == null ? '' : (Number(minor) / 100).toFixed(2); }
  function orderColKeys() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(ORDER_COLS_KEY) || 'null'); } catch (e) {}
    var keys = Array.isArray(saved) && saved.length ? saved : ORDER_COLS_DEFAULT.slice();
    // Customer then signed date always lead, whatever else is chosen.
    keys = keys.filter(function (k) { return k !== 'customer' && k !== 'signedAt' && ORDER_COLS.some(function (c) { return c.key === k; }); });
    return ['customer', 'signedAt'].concat(keys);
  }
  function orderCol(key) { for (var i = 0; i < ORDER_COLS.length; i++) if (ORDER_COLS[i].key === key) return ORDER_COLS[i]; return null; }

  var ordersData = [];
  async function renderOrders(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:14px;">' +
        '<button class="link-btn" id="ordCols" style="width:auto;padding:9px 15px;">Columns</button>' +
        '<button class="link-btn" id="ordCsv" style="width:auto;padding:9px 15px;">Export Excel (CSV)</button>' +
      '</div><div id="ordList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    document.getElementById('ordCols').addEventListener('click', function () { openOrderColumnPicker(user); });
    document.getElementById('ordCsv').addEventListener('click', function () {
      var cols = orderColKeys().map(orderCol);
      downloadCsv('orders-' + todayISO() + '.csv',
        [cols.map(function (c) { return c.label; })].concat(ordersData.map(function (o) { return cols.map(function (c) { return c.plain(o); }); })));
    });
    try {
      var r = await authed('/orders'); if (!r.ok) { document.getElementById('ordList').innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      ordersData = (await r.json()) || [];
      var cols = orderColKeys().map(orderCol);
      var rows = ordersData.map(function (o) {
        return '<tr style="cursor:pointer;" data-id="' + o.id + '">' + cols.map(function (c) { return td(c.cell(o)); }).join('') + '</tr>';
      }).join('');
      document.getElementById('ordList').innerHTML = tableShell(cols.map(function (c) { return c.label; }), rows, cols.length, 'No operational orders yet. Lock an accepted proposal to create one.');
      document.querySelectorAll('#ordList tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { openOrderDetail(tr.getAttribute('data-id'), user); }); });
    } catch (e) { document.getElementById('ordList').innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function openOrderColumnPicker(user) {
    var chosen = orderColKeys();
    var body = '<div class="muted" style="font-size:13px;margin-bottom:12px;">Customer and signed date always lead the table. Choose what else to show.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;">' +
      ORDER_COLS.filter(function (c) { return !c.fixed; }).map(function (c) {
        return '<label style="display:flex;gap:8px;align-items:center;font-size:13.5px;"><input type="checkbox" class="ordColChk" value="' + c.key + '"' + (chosen.indexOf(c.key) > -1 ? ' checked' : '') + '>' + esc(c.label) + '</label>';
      }).join('') + '</div>';
    openModal('Table columns', body, function (close) {
      var keys = [];
      document.querySelectorAll('.ordColChk').forEach(function (chk) { if (chk.checked) keys.push(chk.value); });
      localStorage.setItem(ORDER_COLS_KEY, JSON.stringify(keys));
      close();
      renderOrders(user);
    }, 'Apply');
  }

  async function openOrderDetail(id, user) {
    var view = document.getElementById('view'); view.innerHTML = '<div class="muted" style="padding:24px;">Loading…</div>';
    var order, st, audit;
    try {
      // Check the status before reading the body. Without this an error response
      // parses into an object with none of the expected fields and the page renders
      // completely blank — which looks like "the order is empty" rather than "the
      // request failed", and sends you looking in the wrong place.
      var r1 = await authed('/orders/' + id);
      if (!r1.ok) {
        var msg = ''; try { msg = ((await r1.json()) || {}).message || ''; } catch (e0) {}
        view.innerHTML = '<div class="err">Could not load this order (' + r1.status + ').' +
          (msg ? '<div style="margin-top:6px;font-weight:400;">' + esc(msg) + '</div>' : '') +
          '<div style="margin-top:8px;font-weight:400;font-size:13px;">If this mentions a missing column, a migration has not been deployed yet.</div></div>';
        return;
      }
      order = await r1.json();
      var r2 = await authed('/orders/' + id + '/status'); st = r2.ok ? await r2.json() : {};
      var r3 = await authed('/orders/' + id + '/audit'); audit = r3.ok ? await r3.json() : [];
    } catch (e) { view.innerHTML = '<div class="err">Could not load order.</div>'; return; }
    var canHandoff = hasRole(HANDOFF_ROLES, user.role);
    var integ = st.integrity || {};
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;">' +
        '<button class="link-btn" id="ordBack" style="width:auto;padding:7px 13px;">‹ Back to orders</button>' +
        (hasRole(ORDERS_MANAGE_ROLES, user.role) && order.status !== 'CANCELLED' && order.status !== 'COMPLETE'
          ? '<button class="link-btn" id="ordUnlock" style="width:auto;padding:8px 15px;color:#9c3327;">Unlock for changes</button>' : '') +
      '</div>' +
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;"><div><div class="k">' + esc(order.number) + '</div><h2 style="font-size:22px;margin-top:2px;">Operational order</h2><div class="muted" style="font-size:13px;margin-top:4px;">Accepted proposal v' + (order.acceptedVersion || '') + '</div></div>' +
        '<div style="text-align:right;"><span class="chip">' + titleCase(order.status) + '</span><div style="margin-top:8px;font-size:13px;">' + (integ.ok ? '<span class="dot ok"></span>Integrity verified' : '<span class="dot bad"></span>Integrity drift') + '</div></div></div>' +
        '<div class="grid" style="margin-top:16px;"><div><div class="k">Total</div><div class="v small">' + fmtMoney(order.grandTotalMinor, order.currency) + '</div></div>' +
        '<div><div class="k">Deposit</div><div class="v small">' + (order.depositRequired ? fmtMoney(order.depositDueMinor, order.currency) : '—') + '</div></div>' +
        '<div><div class="k">Balance due</div><div class="v small">' + fmtMoney(order.balanceDueMinor, order.currency) + '</div></div>' +
        '<div><div class="k">Customer approval</div><div class="v small">' + (order.customerApproval ? esc(order.customerApproval.approverName) : '—') + '</div></div></div></div>' +
      (hasRole(ORDERS_MANAGE_ROLES, user.role) ? sectionBlock('Manufacturing', '<div id="mfgBox"><div class="muted" style="padding:16px;">Loading…</div></div>') : '') +
      sectionBlock('Requirements', reqRows(order.requirements || [], canHandoff)) +
      sectionBlock('Internal tasks', taskRows(order.tasks || [], canHandoff)) +
      (hasRole(QBO_VIEW_ROLES, user.role) ? sectionBlock('QuickBooks', '<div id="qboBox"><div class="muted" style="padding:16px;">Loading…</div></div>') : '') +
      sectionBlock('Bill of Materials', '<div id="bomBox"><div class="muted" style="padding:16px;">Loading…</div></div>') +
      sectionBlock('Audit timeline', auditRows(audit));
    document.getElementById('ordBack').addEventListener('click', function () { renderOrders(user); });
    loadBomSections(order, user, canHandoff);
    if (hasRole(QBO_VIEW_ROLES, user.role)) loadQbo(order, user);
    if (hasRole(ORDERS_MANAGE_ROLES, user.role)) loadManufacturing(order, user);
    var unl = document.getElementById('ordUnlock');
    if (unl) unl.addEventListener('click', function () { openUnlockForm(order, user); });
    if (canHandoff) {
      document.querySelectorAll('.hoStatus').forEach(function (sel) {
        sel.addEventListener('change', async function () {
          var kind = sel.getAttribute('data-kind'), rid = sel.getAttribute('data-id');
          var path = kind === 'req' ? '/orders/requirements/' + rid : '/orders/tasks/' + rid;
          var r = await authed(path, { method: 'PATCH', body: { status: sel.value } });
          if (!r.ok) { alert('Could not update (' + r.status + ').'); openOrderDetail(id, user); }
        });
      });
    }
  }
  function hoStatusSelect(kind, id, opts, sel) { return '<select data-kind="' + kind + '" data-id="' + id + '" class="hoStatus" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;">' + opts.map(function (o) { return '<option value="' + o + '"' + (o === sel ? ' selected' : '') + '>' + titleCase(o) + '</option>'; }).join('') + '</select>'; }
  /**
   * Who last touched a row, under its status. A status on its own says what state
   * something is in but never who put it there — which is the question actually
   * asked when a requirement is disputed.
   */
  function changedBy(row) {
    if (!row.updatedByName) return '';
    return '<div class="muted" style="font-size:11.5px;margin-top:5px;line-height:1.4;">' +
      esc(row.updatedByName) + ' · ' + fmtDate(row.updatedAt) + '</div>';
  }
  function reqRows(reqs, edit) {
    var rows = reqs.map(function (r) {
      var cell = edit ? hoStatusSelect('req', r.id, ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'WAIVED'], r.status) : '<span class="chip">' + titleCase(r.status) + '</span>';
      return '<tr>' + td(esc(titleCase(r.category))) + td(esc(r.title)) + td(cell + changedBy(r)) + td(r.isException ? '<span class="chip" style="background:#fbecea;color:#9c3327;">Exception</span>' : '—') + '</tr>';
    }).join('');
    return tableShell(['Category', 'Requirement', 'Status & last change', 'Flag'], rows, 4, 'No requirements.');
  }
  function taskRows(tasks, edit) {
    var rows = tasks.map(function (t) {
      var cell = edit ? hoStatusSelect('task', t.id, ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], t.status) : '<span class="chip">' + titleCase(t.status) + '</span>';
      return '<tr>' + td('<b style="font-weight:600;">' + esc(t.title) + '</b>') + td(esc(t.assigneeRole ? titleCase(t.assigneeRole) : 'Unassigned')) + td(cell + changedBy(t)) + td(t.dueDate ? fmtDate(t.dueDate) : '—') + '</tr>';
    }).join('');
    return tableShell(['Task', 'Owner', 'Status & last change', 'Due'], rows, 4, 'No tasks.');
  }
  /* --- Manufacturing release ---------------------------------------------
   * Pushing an order to manufacturing is the moment the shop starts spending
   * money on it, so it is gated on the customer having been invoiced in
   * QuickBooks. The gate can be waived by anyone who can manage orders, but only
   * with a typed reason, and Accounting is emailed when it happens — a waiver is
   * a decision on the record, not a way around the rule.
   */
  async function loadManufacturing(order, user) {
    var box = document.getElementById('mfgBox');
    if (!box) return;
    var gate = {};
    try {
      var r = await authed('/orders/' + order.id + '/manufacturing');
      if (!r.ok) { box.innerHTML = '<div class="muted" style="padding:16px;">Could not read the manufacturing gate (' + r.status + ').</div>'; return; }
      gate = await r.json();
    } catch (e) { box.innerHTML = '<div class="muted" style="padding:16px;">Could not read the manufacturing gate.</div>'; return; }

    var released = !!order.manufacturingReleasedAt;
    var cancelled = order.status === 'CANCELLED';

    var state = released
      ? '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">' +
          '<span class="chip" style="background:#eaf1ec;color:#2f6b4f;">Released to manufacturing</span>' +
          '<span class="muted" style="font-size:12.5px;">' + fmtDateTime(order.manufacturingReleasedAt) +
          (order.manufacturingReleasedByName ? ' · ' + esc(order.manufacturingReleasedByName) : '') + '</span>' +
        '</div>'
      : '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">' +
          '<span class="chip">Not released</span>' +
          '<span class="muted" style="font-size:12.5px;">The shop starts on this order once it is released.</span>' +
        '</div>';

    // The gate, stated as a fact rather than as a disabled button with no reason.
    var gateLine = gate.invoiceCreated
      ? '<div style="font-size:13px;color:#2f6b4f;"><span class="dot ok"></span>Invoice ' +
          esc(gate.invoiceDocNumber || '') + ' created in QuickBooks' +
          (gate.invoiceCreatedAt ? ' on ' + fmtDate(gate.invoiceCreatedAt) : '') + '.</div>'
      : gate.waived
        ? '<div style="font-size:13px;color:#6b5a24;"><span class="dot"></span>Invoice requirement waived' +
            (gate.waivedAt ? ' on ' + fmtDate(gate.waivedAt) : '') + '.' +
            (gate.waivedReason ? '<div class="muted" style="font-size:12.5px;margin-top:4px;">“' + esc(gate.waivedReason) + '”</div>' : '') + '</div>'
        : '<div style="font-size:13px;color:#9c3327;"><span class="dot bad"></span>No QuickBooks invoice yet. Create the invoice under QuickBooks above, or waive the requirement with a reason.</div>';

    var docs = (gate.documents || []).length
      ? '<div class="muted" style="font-size:11.5px;margin-top:8px;">In QuickBooks: ' +
          gate.documents.map(function (d) { return esc(titleCase(d.type)) + ' ' + esc(d.docNumber || '—') + ' (' + esc(titleCase(d.status)) + ')'; }).join(' · ') +
        '</div>'
      : '';

    var actions = released || cancelled
      ? ''
      : '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">' +
          '<button class="btn" id="mfgRelease" style="width:auto;padding:9px 16px;"' + (gate.satisfied ? '' : ' disabled') + '>Push to Manufacturing</button>' +
          (gate.satisfied ? '' : '<button class="link-btn" id="mfgWaive" style="width:auto;padding:9px 16px;color:#9c3327;">Waive the invoice requirement…</button>') +
        '</div>';

    box.innerHTML = '<div style="padding:16px 18px;">' + state +
      '<div style="margin-top:12px;">' + gateLine + docs + '</div>' + actions + '</div>';

    var rel = document.getElementById('mfgRelease');
    if (rel) rel.addEventListener('click', async function () {
      if (!confirm('Release ' + (order.number || 'this order') + ' to manufacturing?\n\nThe shop treats this as the go-ahead to build.')) return;
      rel.disabled = true;
      var rr = await authed('/orders/' + order.id + '/manufacturing/release', { method: 'POST', body: {} });
      if (!rr.ok) { rel.disabled = false; alert(await serverMessage(rr, 'Could not release this order (' + rr.status + ').')); return; }
      openOrderDetail(order.id, user);
    });

    var wv = document.getElementById('mfgWaive');
    if (wv) wv.addEventListener('click', function () {
      openModal('Waive the invoice requirement',
        '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">Manufacturing normally waits for a QuickBooks invoice. Waiving that is recorded against your name on the order timeline, and Accounting is emailed straight away. Say why.</div>' +
        fieldRow('Reason', '<input id="mfgWaiveReason" placeholder="e.g. PO received, invoice to follow Monday" style="' + IN + '">'),
        async function (close, showErr) {
          var reason = document.getElementById('mfgWaiveReason').value.trim();
          if (!reason) return showErr('Give a reason — the waiver is not recorded without one.');
          var rw = await authed('/orders/' + order.id + '/manufacturing/waive-invoice', { method: 'POST', body: { reason: reason } });
          if (!rw.ok) { var m = ''; try { m = ((await rw.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not waive (' + rw.status + ').'); }
          var out = await rw.json();
          close();
          if (out && out.notifyError) alert('Waived, but Accounting was not emailed: ' + out.notifyError);
          openOrderDetail(order.id, user);
        }, 'Waive');
    });
  }

  /* --- Bill of Materials: the vendor-facing document, grouped by vendor. ---
   * Quantities and part numbers come from the accepted proposal and the catalog;
   * powder colour, vendor notes and the sourced flag are operational and editable
   * here. Prices shown are OUR unit cost — this is a purchasing document. */
  var procData = [];
  var bomOrder = null;

  function bomFieldStyle(w) {
    return 'width:' + (w || '100%') + ';padding:7px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;color:#20241f;outline:none;';
  }

  /* Per-vendor sections. Each vendor gets its own header, questions, colours,
   * lock and send history — a fabricator and a distributor are prepared, confirmed
   * and sent independently, so one shared header could never be right. */
  var bomSectionData = [];
  var bomBrands = [];
  /** The ship-to address book, loaded with the sections that offer it. */
  var bomShipToAddresses = [];

  function bomFieldStyle(w, locked) {
    return 'width:' + (w || '100%') + ';padding:7px 9px;border:1px solid ' + (locked ? '#e7e8e3' : '#dcded7') +
      ';border-radius:8px;font-size:13px;background:' + (locked ? '#f6f7f4' : '#fff') +
      ';color:' + (locked ? '#8a8f85' : '#20241f') + ';outline:none;';
  }

  async function loadBomSections(order, user, canHandoff) {
    var box = document.getElementById('bomBox'); if (!box) return;
    bomOrder = order;
    procData = order.procurement || [];
    try {
      var r = await authed('/orders/' + order.id + '/bom/sections');
      bomSectionData = r.ok ? ((await r.json()).sections || []) : [];
      var rb = await authed('/powder-colors');
      bomBrands = rb.ok ? ((await rb.json()).brands || []) : [];
      var ra = await authed('/ship-to-addresses');
      bomShipToAddresses = ra.ok ? ((await ra.json()) || []) : [];
    } catch (e) { box.innerHTML = '<div class="err">Could not load the Bill of Materials.</div>'; return; }

    if (!procData.length) {
      box.innerHTML = '<div class="placeholder" style="padding:20px;"><p class="muted" style="margin:0;">No Bill of Materials lines.</p></div>';
      return;
    }
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:-4px 0 14px;flex-wrap:wrap;">' +
        '<div class="muted" style="font-size:12.5px;max-width:620px;line-height:1.55;">One section per vendor. Each has its own submission date, questions and send history, and locks on its own when you confirm it.</div>' +
        '<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;color:#5c6157;cursor:pointer;white-space:nowrap;" title="Prints the rest of that vendor’s catalogue at quantity 0, like a full order form">' +
          '<input type="checkbox" id="bomZeroQty"> Include zero-quantity parts</label>' +
      '</div>' +
      bomSectionData.map(function (s, i) { return sectionCard(s, i, canHandoff); }).join('') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">' +
        '<button class="link-btn" data-proc="csv" data-vendor="*" style="width:auto;padding:8px 14px;">Export all vendors — Excel</button>' +
        '<button class="link-btn" data-proc="pdf" data-vendor="*" style="width:auto;padding:8px 14px;">Export all vendors — PDF</button>' +
      '</div>';
    wireBom(order, user, canHandoff);
  }

  /** One vendor's block: visually separated, greyed out once submitted. */
  function sectionCard(s, idx, canHandoff) {
    var locked = !s.editable;
    var edit = canHandoff && !locked;
    var dis = edit ? '' : ' disabled';
    var lines = (procData || []).filter(function (p) {
      return ((p.vendor && String(p.vendor).trim()) || 'Unassigned vendor') === s.vendor;
    });
    var money2 = function (m) { return '$' + (Number(m || 0) / 100).toFixed(2); };
    // Unsubmitted sections SHOW today without having written it — the date is only
    // persisted when someone types one or confirms the section.
    var dateVal = s.submittedOn ? String(s.submittedOn).slice(0, 10) : s.submittedOnDefault;
    var placeholderDate = !s.submittedOn;

    var statusChip = locked
      ? '<span class="chip" style="background:#eaf1ec;color:#2f6b4f;">Submitted ' + (s.submittedOn ? fmtDate(s.submittedOn) : '') + '</span>'
      : '<span class="chip">Draft</span>';

    var confirmLine = locked && s.confirmedBy
      ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">Confirmed by ' + esc(s.confirmedBy) + ' · ' + fmtDate(s.confirmedAt) + '</div>'
      : (s.unlockedBy ? '<div class="muted" style="font-size:11.5px;margin-top:4px;">Reopened by ' + esc(s.unlockedBy) + ' · ' + fmtDate(s.unlockedAt) + '</div>' : '');

    var showColor = !!s.showPowderColor;
    // The bag column is opt-in per vendor and only offered when a part on this
    // section actually has a bag number — most vendors ship nothing bagged.
    var hasBag = lines.some(function (p) { return p.packagingBag; });
    var showBag = hasBag && !!s.showPackagingBag;
    // The vendor's own number for a part, where they number it differently to us.
    // Managed under Catalog → Manufacturers → Part numbers; the column only appears
    // when something on this section is mapped.
    var showVendorPart = lines.some(function (p) { return p.vendorPart; });
    var cols = 8 + (showVendorPart ? 1 : 0) + (showColor ? 1 : 0) + (showBag ? 1 : 0) + (edit ? 1 : 0);
    var rowHtmlFor = function (p) {
      var ext = (Number(p.unitCostMinor) || 0) * (Number(p.quantity) || 0);
      var buy = p.productUrl
        ? ' <a href="' + esc(p.productUrl) + '" target="_blank" rel="noopener" style="font-size:11.5px;margin-left:6px;">Buy ↗</a>' : '';
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(p.name) + '</b>' + buy) +
        td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(p.sku || '—') + '</code>') +
        (showVendorPart ? td(p.vendorPart
          ? '<code style="font-size:12.5px;color:#4a4f47;">' + esc(p.vendorPart) + '</code>'
          : '<span class="muted">—</span>') : '') +
        td(qtyCell(p, edit)) +
        (showBag ? td(esc(p.packagingBag || '—')) : '') +
        (showColor ? td((p.paintGroup ? '<span class="chip" style="font-size:10.5px;margin-bottom:4px;display:inline-block;" title="Paint colour group">' + esc(p.paintGroup) + '</span> ' : '') + (edit ? colorCell(p) : esc(p.powderColor || '—'))) : '') +
        td(((Number(p.unitWeightLbs) || 0) * (Number(p.quantity) || 0)).toFixed(2)) +
        td(money2(p.unitCostMinor)) +
        td(money2(ext)) +
        td(edit
          ? '<input class="bomLine" data-id="' + p.id + '" data-f="vendorNotes" value="' + esc(p.vendorNotes || '') + '" placeholder="—" style="' + bomFieldStyle('160px') + '">'
          : esc(p.vendorNotes || '—')) +
        td(edit
          ? '<select class="bomLine" data-id="' + p.id + '" data-f="sourced" style="' + bomFieldStyle('110px') + '">' +
              '<option value="false"' + (p.sourced ? '' : ' selected') + '>Pending</option>' +
              '<option value="true"' + (p.sourced ? ' selected' : '') + '>Ordered</option></select>'
          : (p.sourced ? '<span class="chip">Ordered</span>' : '<span class="muted">Pending</span>')) +
        (edit ? td('<button class="link-btn" data-line-del="' + p.id + '" data-line-name="' + esc(p.name) + '" title="Take this part off the order" style="width:auto;padding:5px 10px;font-size:12px;color:#a2402f;">Remove</button>') : '') +
        '</tr>';
    };

    // Same two blocks as the printed sheet: products in product-tree order, then a
    // Hardware block. The screen and the document must not disagree about order.
    var prodLines = lines.filter(function (p) { return !p.isHardwareComponent; });
    var hwLines = lines.filter(function (p) { return p.isHardwareComponent; });
    var divider = function (label) {
      return '<tr><td colspan="' + cols + '" style="padding:11px 16px 5px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#5c6157;background:#f4f5f1;border-top:1px solid #e7e8e3;">' + label + '</td></tr>';
    };
    var rows = prodLines.map(rowHtmlFor).join('') +
      (hwLines.length ? divider('Hardware') + hwLines.map(rowHtmlFor).join('') : '') +
      '<tr><td style="padding:12px 16px;border-top:1px solid #e7e8e3;font-weight:600;">Total — ' + s.lineCount + ' line' + (s.lineCount === 1 ? '' : 's') + '</td>' +
      '<td colspan="' + (showVendorPart ? 2 : 1) + '" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td>' +
      '<td style="padding:12px 16px;border-top:1px solid #e7e8e3;font-weight:600;">' + s.unitCount + '</td>' +
      '<td colspan="' + (2 + (showColor ? 1 : 0) + (showBag ? 1 : 0)) + '" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td>' +
      '<td style="padding:12px 16px;border-top:1px solid #e7e8e3;font-weight:600;">' + money2(s.extendedCostMinor) + '</td>' +
      '<td colspan="' + (edit ? 3 : 2) + '" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td></tr>';

    var warn = s.missingColorSkus.length
      ? '<div style="background:#fdf6e6;border:1px solid #ecd9a6;border-radius:9px;padding:9px 12px;font-size:12.5px;color:#6b5a24;margin-bottom:10px;">' +
        s.missingColorSkus.length + ' part' + (s.missingColorSkus.length === 1 ? '' : 's') + ' still need a colour: <code>' + s.missingColorSkus.slice(0, 6).map(esc).join('</code>, <code>') + '</code>' +
        (s.missingColorSkus.length > 6 ? ' and ' + (s.missingColorSkus.length - 6) + ' more' : '') + '</div>' : '';

    return '<div class="card" data-section="' + s.id + '" style="margin-bottom:22px;padding:0;overflow:hidden;border-left:3px solid ' + (locked ? '#3f9d78' : '#c9a227') + ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 18px;background:' + (locked ? '#f6f7f4' : '#fbfbf9') + ';border-bottom:1px solid #e7e8e3;">' +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">' +
            '<h3 style="font-size:16px;margin:0;font-weight:650;">' + esc(s.vendor) + '</h3>' + statusChip +
          '</div>' +
          '<div class="muted" style="font-size:12.5px;margin-top:3px;">' + s.unitCount + ' unit' + (s.unitCount === 1 ? '' : 's') + ' · ' + money2(s.extendedCostMinor) + ' at cost</div>' +
          confirmLine +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
          (canHandoff && idx > 0 ? '<button class="link-btn" data-sec-move="up" data-id="' + s.id + '" title="Move this section earlier in the export" style="width:auto;padding:6px 10px;">↑</button>' : '') +
          (canHandoff && idx < bomSectionData.length - 1 ? '<button class="link-btn" data-sec-move="down" data-id="' + s.id + '" title="Move this section later in the export" style="width:auto;padding:6px 10px;">↓</button>' : '') +
          '<button class="link-btn" data-proc="csv" data-vendor="' + esc(s.vendor) + '" style="width:auto;padding:7px 13px;">Excel</button>' +
          '<button class="link-btn" data-proc="pdf" data-vendor="' + esc(s.vendor) + '" style="width:auto;padding:7px 13px;">PDF</button>' +
          (canHandoff ? '<button class="btn" data-sec-email="' + s.id + '" title="Emails this vendor their sheet and submits the section" style="width:auto;padding:8px 14px;">Email vendor</button>' : '') +
          (canHandoff && !locked ? '<button class="link-btn" data-sec-confirm="' + s.id + '" title="Use when the sheet went out some other way" style="width:auto;padding:8px 14px;">Mark sent by hand</button>' : '') +
          (canHandoff && locked ? '<button class="link-btn" data-sec-unlock="' + s.id + '" style="width:auto;padding:8px 14px;color:#9c3327;">Unlock for revisions</button>' : '') +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 18px;">' +
        warn +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
          '<div><div class="k">Job name</div><input class="secF" data-id="' + s.id + '" data-f="jobName" value="' + esc(s.jobName || '') + '" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
          '<div><div class="k">Ship to</div>' + shipToSelect(s, locked, dis) +
            (s.shipToAddress
              ? '<div class="muted" style="font-size:11px;margin-top:4px;line-height:1.45;">' + esc(shipToAddressLines(s.shipToAddress).join(' · ')) + '</div>'
              : '') + '</div>' +
          '<div><div class="k">Submission date</div><input class="secF" data-id="' + s.id + '" data-f="submittedOn" type="date" value="' + esc(dateVal) + '" style="' + bomFieldStyle(null, locked) + (placeholderDate ? 'color:#8a8f85;' : '') + '"' + dis + '>' +
            (placeholderDate ? '<div class="muted" style="font-size:11px;margin-top:3px;">Today, until you confirm or change it</div>' : '') + '</div>' +
          '<div><div class="k">Delivery type</div><input class="secF" data-id="' + s.id + '" data-f="deliveryType" value="' + esc(s.deliveryType || '') + '" placeholder="e.g. Lift Gate" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
          '<div><div class="k">Estimated shipment quote</div><input class="secF" data-id="' + s.id + '" data-f="shipmentQuote" value="' + esc(s.shipmentQuote || '') + '" placeholder="TBD" style="' + bomFieldStyle(null, locked) + '"' + dis + '>' +
            '<div class="muted" style="font-size:11px;margin-top:3px;">' +
              (s.freightSource === 'MATS' ? 'Mats freight from the deal' : s.freightSource === 'NONE' ? 'This vendor quotes no freight' : 'Structure freight from the deal') +
            '</div></div>' +
          // The deal carries one tax figure for the order; it is shown on each
          // sheet rather than divided between vendors.
          '<div><div class="k">Estimated tax</div><input class="secF" data-id="' + s.id + '" data-f="estimatedTax" value="' + esc(s.estimatedTax || '') + '" placeholder="From the deal" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
        '</div>' +
        (edit
          ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">' +
              '<button class="link-btn" data-deal-pull="' + s.id + '" style="width:auto;padding:6px 12px;">Pull freight &amp; tax from the deal</button>' +
              '<span class="muted" style="font-size:11.5px;">Reads the Deal Tracking board. Figures you have typed are kept.</span>' +
            '</div>'
          : '') +
        '<div style="margin-top:12px;"><div class="k">Notes to this vendor</div>' +
          '<textarea class="secF" data-id="' + s.id + '" data-f="notes" rows="2" placeholder="Prints beneath the line items" style="' + bomFieldStyle(null, locked) + 'resize:vertical;"' + dis + '>' + esc(s.notes || '') + '</textarea></div>' +
        // Opt-in per vendor: most vendors powder coat nothing, and the column was
        // printing a row of dashes on their sheet. Forced on once a line has a colour.
        '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:#5c6157;margin-top:10px;' + (edit ? 'cursor:pointer;' : 'opacity:.6;') + '">' +
          '<input type="checkbox" class="secColorCol" data-id="' + s.id + '"' + (s.showPowderColor ? ' checked' : '') + (edit ? '' : ' disabled') + '>' +
          'Show the powder colour column on this vendor’s sheet</label>' +
        // Same opt-in for the packaging bag. Hidden entirely when nothing on this
        // section is bagged, so it never becomes a column of dashes.
        (hasBag
          ? '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:#5c6157;margin-top:6px;' + (edit ? 'cursor:pointer;' : 'opacity:.6;') + '">' +
              '<input type="checkbox" class="secBagCol" data-id="' + s.id + '"' + (s.showPackagingBag ? ' checked' : '') + (edit ? '' : ' disabled') + '>' +
              'Show the packaging bag column on this vendor’s sheet</label>'
          : '') +
        questionBlock(s, edit) +
        (edit && s.showPowderColor ? colorApplyRow(s, lines) : '') +
        '<div style="margin-top:14px;overflow:auto;">' +
          tableShell(
            ['Item', 'Part #'].concat(showVendorPart ? ['Vendor part #'] : [], ['Qty'], showBag ? ['Bag #'] : [], showColor ? ['Powder color'] : [], ['Weight (lb)', 'Cost each', 'Total cost', 'Notes', 'Status'], edit ? [''] : []),
            rows, cols, '') +
        '</div>' +
        sectionMoney(s) +
        (edit
          ? '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:11px;flex-wrap:wrap;">' +
              '<span class="muted" style="font-size:11.5px;">Parts added or removed here change what is purchased, not the accepted proposal. Both go on the order timeline.</span>' +
              '<button class="link-btn" data-line-add="' + esc(s.vendor) + '" style="width:auto;padding:8px 14px;white-space:nowrap;">Add a part</button>' +
            '</div>'
          : '') +
        sendHistory(s) +
      '</div>' +
    '</div>';
  }

  /**
   * The quantity cell.
   *
   * Editable while the section is open: what the shop buys is not always what the
   * formula produced, and the alternative was a spreadsheet nobody could see. The
   * formula figure is kept in quantityOriginal, so an edited line says what it used
   * to be and can be put back by typing the original number in.
   */
  function qtyCell(p, edit) {
    var orig = p.quantityOriginal == null ? null : Number(p.quantityOriginal);
    var changed = orig != null && orig !== Number(p.quantity);
    var badge = changed
      ? '<div class="muted" style="font-size:11px;margin-top:3px;color:#8a6d1f;" title="' +
          (p.quantityEditedBy ? esc(p.quantityEditedBy) + ' · ' : '') + (p.quantityEditedAt ? esc(fmtDateTime(p.quantityEditedAt)) : '') +
          '">Was ' + orig + '</div>'
      : '';
    if (!edit) return String(p.quantity) + badge;
    return '<input class="bomLine" data-id="' + p.id + '" data-f="quantity" type="number" min="1" step="1" value="' + Number(p.quantity) +
      '" style="' + bomFieldStyle('72px') + (changed ? 'border-color:#c9a227;' : '') + '">' + badge;
  }

  /** Brand from the managed list, code typed per part. */
  function colorCell(p) {
    var opts = '<option value="">—</option>' + bomBrands.map(function (b) {
      return '<option value="' + b.id + '"' + (p.powderBrandId === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>';
    }).join('');
    return '<div style="display:flex;gap:5px;">' +
      '<select class="bomLine" data-id="' + p.id + '" data-f="powderBrandId" style="' + bomFieldStyle('92px') + '">' + opts + '</select>' +
      '<input class="bomLine" data-id="' + p.id + '" data-f="powderColorCode" value="' + esc(p.powderColorCode || '') + '" placeholder="Code" style="' + bomFieldStyle('80px') + '">' +
    '</div>';
  }

  /**
   * A brand and a code per paint colour group.
   *
   * The customer does not pick one colour for the whole structure — they pick one
   * per group of parts, and which group a part is in is set once under
   * Administration → Formulas → Paint colour. One row per group present on this
   * section, so the person filling it in sees exactly the choices the customer was
   * given. Parts the chart has nothing to say about get a row of their own rather
   * than silently losing the ability to be coloured.
   */
  function colorApplyRow(s, lines) {
    var codes = [];
    bomBrands.forEach(function (b) { (b.recentCodes || []).forEach(function (c) { codes.push(c); }); });

    // Groups in the order the chart lists them, counting only what is on this sheet.
    var seen = [], counts = {}, labels = {}, ungrouped = 0;
    (lines || []).forEach(function (p) {
      var g = p.paintGroup || '';
      if (!g) { ungrouped++; return; }
      if (seen.indexOf(g) === -1) { seen.push(g); labels[g] = p.paintGroupLabel || ''; }
      counts[g] = (counts[g] || 0) + 1;
    });
    seen.sort();

    var brandSelect = function (key) {
      return '<select class="secColorBrand" data-key="' + key + '" style="' + bomFieldStyle('130px') + '">' +
        '<option value="">Brand…</option>' +
        bomBrands.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + '</option>'; }).join('') +
      '</select>';
    };
    var codeInput = function (key) {
      return '<input class="secColorCode" data-key="' + key + '" list="bomCodeList" placeholder="Colour code" style="' + bomFieldStyle('140px') + '">';
    };
    var line = function (key, title, note, group) {
      return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;">' +
        '<span style="font-size:12.5px;color:#3d4a55;font-weight:600;min-width:150px;">' + title + '</span>' +
        brandSelect(key) + codeInput(key) +
        '<button class="link-btn" data-sec-color="' + s.id + '" data-group="' + esc(group || '') + '" style="width:auto;padding:7px 13px;">Apply</button>' +
        '<span class="muted" style="font-size:11.5px;">' + note + '</span>' +
      '</div>';
    };

    var rows = seen.map(function (g) {
      return line(s.id + '|' + g,
        'Group ' + esc(g) + (labels[g] ? ' — ' + esc(labels[g]) : ''),
        counts[g] + ' part' + (counts[g] === 1 ? '' : 's') + ' on this sheet',
        g);
    }).join('');

    if (ungrouped) {
      rows += line(s.id + '|', 'Not in a group',
        ungrouped + ' part' + (ungrouped === 1 ? '' : 's') + ' the chart does not cover', '');
    }

    return '<div style="margin-top:12px;padding:11px 13px;background:#fbfbf9;border:1px solid #eceee8;border-radius:9px;">' +
      '<div style="font-size:12.5px;color:#5c6157;margin-bottom:2px;">Colour by group. Parts that already have a colour are left alone.</div>' +
      rows +
      (codes.length ? '<datalist id="bomCodeList">' + codes.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' : '') +
      (seen.length ? '' : '<div class="muted" style="font-size:11.5px;margin-top:4px;">No part on this sheet is in the paint colour chart yet — build it under Administration → Formulas → Paint colour.</div>') +
    '</div>';
  }

  /** User-defined questions for this vendor. */
  function questionBlock(s, edit) {
    var qs = s.questions || [];
    if (!qs.length && !edit) return '';
    var fields = qs.map(function (q) {
      var name = 'q_' + q.id, v = q.value || '', st = bomFieldStyle(null, !edit), dis = edit ? '' : ' disabled';
      var input;
      if (q.type === 'SELECT') {
        input = '<select class="secQ" data-id="' + q.id + '" style="' + st + '"' + dis + '><option value="">—</option>' +
          q.options.map(function (o) { return '<option value="' + esc(o) + '"' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      } else if (q.type === 'MULTI_SELECT') {
        var picked = []; try { picked = JSON.parse(v || '[]'); } catch (e) {}
        input = '<div style="display:flex;flex-wrap:wrap;gap:9px;padding:4px 0;">' + q.options.map(function (o) {
          return '<label style="display:flex;gap:5px;align-items:center;font-size:13px;cursor:' + (edit ? 'pointer' : 'default') + ';">' +
            '<input type="checkbox" class="secQM" data-id="' + q.id + '" value="' + esc(o) + '"' + (picked.indexOf(o) >= 0 ? ' checked' : '') + dis + '> ' + esc(o) + '</label>';
        }).join('') + '</div>';
      } else if (q.type === 'BOOLEAN') {
        input = '<select class="secQ" data-id="' + q.id + '" style="' + st + '"' + dis + '>' +
          '<option value="">—</option><option value="Yes"' + (v === 'Yes' ? ' selected' : '') + '>Yes</option>' +
          '<option value="No"' + (v === 'No' ? ' selected' : '') + '>No</option></select>';
      } else if (q.type === 'LONG_TEXT') {
        input = '<textarea class="secQ" data-id="' + q.id + '" rows="2" style="' + st + 'resize:vertical;"' + dis + '>' + esc(v) + '</textarea>';
      } else {
        var t = q.type === 'NUMBER' ? 'number' : q.type === 'DATE' ? 'date' : 'text';
        input = '<input type="' + t + '" class="secQ" data-id="' + q.id + '" value="' + esc(v) + '" style="' + st + '"' + dis + '>';
      }
      return '<div><div class="k">' + esc(q.label) + (q.required ? ' <span style="color:#9c3327;">*</span>' : '') +
        (edit && !q.fromTemplate ? ' <button class="link-btn" data-q-del="' + q.id + '" title="Remove this question" style="width:auto;padding:0 4px;font-size:11px;color:#9c3327;display:inline;">×</button>' : '') +
        '</div>' + input + '</div>';
    }).join('');
    return '<div style="margin-top:14px;padding-top:14px;border-top:1px dashed #e2e4de;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:9px;">' +
        '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;">Vendor questions</div>' +
        (edit ? '<button class="link-btn" data-q-add="' + s.id + '" style="width:auto;padding:6px 11px;font-size:12px;">Add a question</button>' : '') +
      '</div>' +
      (qs.length
        ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">' + fields + '</div>'
        : '<div class="muted" style="font-size:12.5px;">None yet. Questions you add here are asked of this vendor on this order; add a reusable one under Administration.</div>') +
    '</div>';
  }

  /** "$1,240.50" → 124050; null when it is not a number ("TBD"). */
  function moneyMinor(v) {
    var raw = String(v == null ? '' : v).replace(/[$,\s]/g, '').trim();
    if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
    return Math.round(Number(raw) * 100);
  }

  function shipToAddressLines(a) {
    var street = [a.line1, a.line2].filter(Boolean).join(', ');
    var city = [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return [street, city, a.contactName, a.phone].filter(Boolean);
  }

  /**
   * Where this vendor's shipment goes. The customer's site and Summit's dock are
   * the two standing answers; anything else — a job trailer, an installer's
   * warehouse — is a saved address, because the same one is used across vendors on
   * an order and re-typing it is how two sheets end up disagreeing.
   */
  function shipToSelect(s, locked, dis) {
    var saved = (bomShipToAddresses || []).map(function (a) {
      return '<option value="addr:' + a.id + '"' + (s.shipToAddressId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('');
    return '<select class="secShipTo" data-id="' + s.id + '" style="' + bomFieldStyle(null, locked) + '"' + dis + '>' +
      '<option value="CUSTOMER"' + (!s.shipToAddressId && s.shipTo !== 'SUMMIT' ? ' selected' : '') + '>Customer site</option>' +
      '<option value="SUMMIT"' + (!s.shipToAddressId && s.shipTo === 'SUMMIT' ? ' selected' : '') + '>Summit Sensory Gym</option>' +
      (saved ? '<optgroup label="Saved addresses">' + saved + '</optgroup>' : '') +
      '<option value="new">+ New ship-to address…</option>' +
    '</select>';
  }

  /**
   * What the sheet adds up to. Freight and tax are typed as text, so a figure that
   * is not a number prints as it reads and the grand total waits — a total that
   * quietly leaves the freight out is worse than no total.
   */
  function sectionMoney(s) {
    var items = Number(s.extendedCostMinor) || 0;
    var ship = moneyMinor(s.shipmentQuote);
    var tax = moneyMinor(s.estimatedTax);
    var money2 = function (m) { return '$' + (Number(m || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var rows = [
      ['Item cost total', money2(items), 0],
      ['Estimated shipment total', ship == null ? (s.shipmentQuote || 'TBD') : money2(ship), 0],
    ];
    if (s.estimatedTax) rows.push(['Estimated tax', tax == null ? s.estimatedTax : money2(tax), 0]);
    var grand = ship == null || (s.estimatedTax && tax == null) ? null : items + ship + (tax || 0);
    rows.push(['Bill of Materials grand total', grand == null ? 'Pending freight' : money2(grand), 1]);

    return '<div style="display:flex;justify-content:flex-end;margin-top:12px;">' +
      '<table style="border-collapse:collapse;font-size:13px;min-width:280px;">' +
        rows.map(function (r) {
          var top = r[2] ? 'border-top:1px solid #dcded7;' : '';
          return '<tr>' +
            '<td style="padding:5px 16px 5px 0;color:' + (r[2] ? '#20241f' : '#5c6157') + ';font-weight:' + (r[2] ? '700' : '400') + ';' + top + '">' + esc(r[0]) + '</td>' +
            '<td style="padding:5px 0;text-align:right;font-weight:' + (r[2] ? '700' : '600') + ';' + top + '">' + esc(r[1]) + '</td>' +
          '</tr>';
        }).join('') +
      '</table></div>';
  }

  /** Append-only record of every BOM emailed to this vendor. */
  function sendHistory(s) {
    if (!s.sends.length) return '';
    var rows = s.sends.map(function (x) {
      var chip = x.status === 'FAILED' || x.status === 'BOUNCED'
        ? '<span class="chip" style="background:#fbecea;color:#9c3327;">' + titleCase(x.status) + '</span>'
        : '<span class="chip" style="background:#eaf1ec;color:#2f6b4f;">' + titleCase(x.status) + '</span>';
      // Delivery is what the provider reported back, not what we attempted: a row
      // with a sent time and no delivery time is a send nobody has confirmed landed.
      var delivered = x.deliveredAt
        ? fmtDateTime(x.deliveredAt) + (x.openedAt ? '<div class="muted" style="font-size:11px;margin-top:2px;">Opened ' + fmtDateTime(x.openedAt) + '</div>' : '')
        : '<span class="muted">Not confirmed</span>';
      return '<tr>' + td(fmtDateTime(x.sentAt)) + td(esc(x.sentBy || '—')) + td(esc(x.toEmail)) +
        td(esc(x.format)) + td(chip + (x.error ? '<div class="muted" style="font-size:11px;color:#9c3327;margin-top:3px;">' + esc(x.error) + '</div>' : '')) +
        td(delivered) + '</tr>';
    }).join('');
    return '<div style="margin-top:14px;">' +
      '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;margin-bottom:8px;">Sent to this vendor</div>' +
      tableShell(['Sent', 'Sent by', 'To', 'Format', 'Status', 'Delivered'], rows, 6, '') +
    '</div>';
  }

  function fmtDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /** Wire every control inside the section cards. */
  function wireBom(order, user, canHandoff) {
    var reload = function () { loadBomSections(order, user, canHandoff); };
    var fail = async function (r, what) {
      var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {}
      alert(m || (what + ' (' + r.status + ').'));
    };

    document.querySelectorAll('.secColorCol').forEach(function (el) {
      el.addEventListener('change', async function () {
        var r = await authed('/bom/sections/' + el.getAttribute('data-id'), { method: 'PATCH', body: { showPowderColor: el.checked } });
        if (!r.ok) { alert('Could not change that (' + r.status + ').'); el.checked = !el.checked; return; }
        loadBomSections(order, user, canHandoff);
      });
    });

    document.querySelectorAll('.secBagCol').forEach(function (el) {
      el.addEventListener('change', async function () {
        var rb = await authed('/bom/sections/' + el.getAttribute('data-id'), { method: 'PATCH', body: { showPackagingBag: el.checked } });
        if (!rb.ok) { alert('Could not change that (' + rb.status + '). If this says the column is missing, migration 0033 has not been deployed.'); el.checked = !el.checked; return; }
        loadBomSections(order, user, canHandoff);
      });
    });

    document.querySelectorAll('.secF').forEach(function (el) {
      el.addEventListener('change', async function () {
        var f = el.getAttribute('data-f'), body = {};
        if (f === 'submittedOn') body[f] = el.value ? new Date(el.value + 'T12:00:00').toISOString() : null;
        else body[f] = el.value.trim ? el.value.trim() : el.value;
        el.style.borderColor = '#c9a227';
        var r = await authed('/bom/sections/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) return fail(r, 'Could not save');
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });

    document.querySelectorAll('.bomLine').forEach(function (el) {
      el.addEventListener('change', async function () {
        var f = el.getAttribute('data-f'), body = {};
        if (f === 'sourced') body[f] = el.value === 'true';
        else if (f === 'quantity') body[f] = Math.round(Number(el.value));
        else body[f] = el.value.trim();
        if (f === 'quantity' && !(body[f] >= 1)) { alert('Quantity must be a whole number of at least 1.'); reload(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/orders/procurement/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { await fail(r, 'Could not save the line'); reload(); return; }
        // A quantity change moves the section totals and the edited badge, so the
        // panel is rebuilt from the server rather than patched in place.
        if (f === 'quantity') { refreshLines(); return; }
        var line = (procData || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
        if (line) line[f] = body[f];
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });

    /* Add / remove parts. The BOM is the purchasing list: the shop routinely needs a
     * part the proposal never mentioned, and just as routinely does not buy one it
     * did. Both are refused once the vendor's section is submitted. */
    var refreshLines = async function () {
      var rr = await authed('/orders/' + order.id);
      if (rr.ok) { var oo = await rr.json(); order.procurement = oo.procurement; }
      reload();
    };

    document.querySelectorAll('[data-line-del]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        if (!confirm('Take “' + bt.getAttribute('data-line-name') + '” off this order?\n\nIt leaves the Bill of Materials but stays on the accepted proposal. The removal is recorded on the order timeline.')) return;
        bt.disabled = true;
        var r = await authed('/orders/procurement/' + bt.getAttribute('data-line-del'), { method: 'DELETE' });
        bt.disabled = false;
        if (!r.ok) return fail(r, 'Could not remove the line');
        refreshLines();
      });
    });

    document.querySelectorAll('[data-line-add]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        var vendor = bt.getAttribute('data-line-add');
        openModal('Add a part to ' + vendor,
          '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">Type a part number and the catalog fills in the rest. Leave cost blank to use the catalog’s.</div>' +
          fieldRow('Part #', '<input id="plSku" placeholder="e.g. 6820H-114" style="' + IN + 'text-transform:uppercase;">') +
          fieldRow('Item', '<input id="plName" placeholder="Description" style="' + IN + '">') +
          fieldRow('Qty', '<input id="plQty" type="number" min="1" step="1" value="1" style="' + IN + '">') +
          fieldRow('Cost each', '<input id="plCost" type="number" min="0" step="0.01" placeholder="From the catalog" style="' + IN + '">'),
          async function (close, showErr) {
            var name = document.getElementById('plName').value.trim();
            var sku = document.getElementById('plSku').value.trim().toUpperCase();
            var qty = parseFloat(document.getElementById('plQty').value);
            var cost = document.getElementById('plCost').value.trim();
            if (!name) return showErr('Give the item a description.');
            if (!(qty > 0)) return showErr('Quantity must be greater than zero.');
            var body = { name: name, quantity: qty };
            if (sku) body.sku = sku;
            // The section the button was pressed in wins, so a part lands where the
            // person adding it expects even when the catalog names another vendor.
            if (vendor && vendor !== 'Unassigned vendor') body.vendor = vendor;
            if (cost !== '') body.unitCostMinor = Math.round(parseFloat(cost) * 100);
            var r = await authed('/orders/' + order.id + '/procurement', { method: 'POST', body: body });
            if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not add the part (' + r.status + ').'); }
            close();
            refreshLines();
          });

        // Part-number lookup: fills the description and cost from the SKU master.
        var skuEl = document.getElementById('plSku');
        if (skuEl) skuEl.addEventListener('blur', async function () {
          var q = skuEl.value.trim();
          if (!q) return;
          var rs = await authed('/skus?q=' + encodeURIComponent(q) + '&pageSize=5');
          if (!rs.ok) return;
          var items = ((await rs.json()) || {}).items || [];
          var hit = items.filter(function (k) { return String(k.part).toUpperCase() === q.toUpperCase(); })[0];
          if (!hit) return;
          var nameEl = document.getElementById('plName'), costEl = document.getElementById('plCost');
          if (nameEl && !nameEl.value.trim()) nameEl.value = hit.description || '';
          if (costEl && !costEl.value.trim() && hit.unitCostMinor != null) costEl.value = (Number(hit.unitCostMinor) / 100).toFixed(2);
        });
      });
    });

    document.querySelectorAll('.secQ').forEach(function (el) {
      el.addEventListener('change', async function () {
        el.style.borderColor = '#c9a227';
        var r = await authed('/bom/questions/' + el.getAttribute('data-id'), { method: 'PATCH', body: { value: el.value } });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) return fail(r, 'Could not save the answer');
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
      });
    });
    document.querySelectorAll('.secQM').forEach(function (el) {
      el.addEventListener('change', async function () {
        var id = el.getAttribute('data-id');
        var picked = [];
        document.querySelectorAll('.secQM[data-id="' + id + '"]').forEach(function (c) { if (c.checked) picked.push(c.value); });
        var r = await authed('/bom/questions/' + id, { method: 'PATCH', body: { value: JSON.stringify(picked) } });
        if (!r.ok) return fail(r, 'Could not save the answer');
      });
    });
    document.querySelectorAll('[data-q-del]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        if (!confirm('Remove this question and its answer?')) return;
        var r = await authed('/bom/questions/' + bt.getAttribute('data-q-del'), { method: 'DELETE' });
        if (!r.ok) return fail(r, 'Could not remove');
        reload();
      });
    });
    document.querySelectorAll('[data-q-add]').forEach(function (bt) {
      bt.addEventListener('click', function () { openQuestionForm(bt.getAttribute('data-q-add'), reload); });
    });

    document.querySelectorAll('[data-sec-color]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var id = bt.getAttribute('data-sec-color');
        var group = bt.getAttribute('data-group') || '';
        var key = id + '|' + group;
        var brand = document.querySelector('.secColorBrand[data-key="' + key + '"]').value;
        var code = document.querySelector('.secColorCode[data-key="' + key + '"]').value.trim();
        if (!brand || !code) { alert('Pick a brand and type the colour code.'); return; }
        var sec = bomSectionData.filter(function (x) { return x.id === id; })[0];
        var body = { brandId: brand, code: code, vendor: sec.vendor, overwrite: false };
        if (group) {
          // The group names the parts; the server resolves them from the chart, so a
          // screen left open while the chart changed cannot paint the wrong ones.
          body.group = group;
        } else {
          // Ungrouped parts have no name to send, so the part numbers go instead.
          body.skus = (procData || []).filter(function (p) {
            return !p.paintGroup && ((p.vendor && String(p.vendor).trim()) || 'Unassigned vendor') === sec.vendor;
          }).map(function (p) { return p.sku; }).filter(Boolean);
          if (!body.skus.length) { alert('Nothing to paint here.'); return; }
        }
        var r = await authed('/orders/' + order.id + '/bom/apply-color', { method: 'POST', body: body });
        if (!r.ok) return fail(r, 'Could not apply the colour');
        var d = await r.json();
        alert(d.applied + ' part' + (d.applied === 1 ? '' : 's') +
          (group ? ' in group ' + group : '') + ' set to ' + d.color +
          (d.skipped ? '. ' + d.skipped + ' skipped — already coloured, in another group, or in another section.' : '.'));
        var o = await (await authed('/orders/' + order.id)).json();
        order.procurement = o.procurement; reload();
      });
    });

    document.querySelectorAll('.secShipTo').forEach(function (el) {
      el.addEventListener('change', async function () {
        var id = el.getAttribute('data-id');
        var v = el.value;
        if (v === 'new') { openShipToForm(order, id, reload); return; }
        var body = v.indexOf('addr:') === 0
          ? { shipToAddressId: v.slice(5) }
          // Back to a standing answer: the named address is cleared, or it would
          // keep winning over the one just chosen.
          : { shipTo: v, shipToAddressId: null };
        var r = await authed('/bom/sections/' + id, { method: 'PATCH', body: body });
        if (!r.ok) { await fail(r, 'Could not change the ship-to'); }
        reload();
      });
    });

    document.querySelectorAll('[data-deal-pull]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        bt.disabled = true;
        var r = await authed('/orders/' + order.id + '/deal-figures/pull', { method: 'POST', body: {} });
        bt.disabled = false;
        if (!r.ok) return fail(r, 'Could not read the deal');
        var d = await r.json();
        if (d.figures && d.figures.error) { alert('Nothing pulled: ' + d.figures.error); return; }
        if (!d.updated) {
          alert('Nothing to pull — every section already has its freight and tax, or the deal has none recorded.');
          return;
        }
        reload();
      });
    });

    document.querySelectorAll('[data-sec-move]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var id = bt.getAttribute('data-id'), dir = bt.getAttribute('data-sec-move');
        var ids = bomSectionData.map(function (x) { return x.id; });
        var i = ids.indexOf(id), j = dir === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        ids[i] = ids[j]; ids[j] = id;
        var r = await authed('/orders/' + order.id + '/bom/sections/reorder', { method: 'POST', body: { ids: ids } });
        if (!r.ok) return fail(r, 'Could not reorder');
        reload();
      });
    });

    document.querySelectorAll('[data-sec-confirm]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var id = bt.getAttribute('data-sec-confirm');
        var sec = bomSectionData.filter(function (x) { return x.id === id; })[0];
        if (!confirm('Record the ' + sec.vendor + ' Bill of Materials as sent?\n\nUse this only when the sheet went out some other way — emailing it from here submits the section on its own. Its fields lock until you unlock them for revisions.')) return;
        bt.disabled = true;
        var r = await authed('/bom/sections/' + id + '/confirm', { method: 'POST', body: {} });
        bt.disabled = false;
        if (!r.ok) return fail(r, 'Could not confirm');
        reload();
      });
    });
    document.querySelectorAll('[data-sec-unlock]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        var id = bt.getAttribute('data-sec-unlock');
        openModal('Unlock for revisions',
          '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">This reopens the section for editing. The vendor already has the version you sent, so note what is changing — it goes on the order timeline.</div>' +
          fieldRow('Reason', '<input id="secUnlockReason" placeholder="e.g. customer changed two colours" style="' + IN + '">'),
          async function (close, showErr) {
            var reason = document.getElementById('secUnlockReason').value.trim();
            if (!reason) return showErr('Give a reason.');
            var r = await authed('/bom/sections/' + id + '/unlock', { method: 'POST', body: { reason: reason } });
            if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not unlock.'); }
            close(); reload();
          }, 'Unlock');
      });
    });

    document.querySelectorAll('[data-sec-email]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        var sec = bomSectionData.filter(function (x) { return x.id === bt.getAttribute('data-sec-email'); })[0];
        openSendForm(order, sec, reload);
      });
    });

    document.querySelectorAll('[data-proc]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var vendor = bt.getAttribute('data-vendor');
        var zero = document.getElementById('bomZeroQty');
        var qs = '?vendor=' + encodeURIComponent(vendor) + (zero && zero.checked ? '&includeZeroQty=true' : '');
        var label = bt.textContent;
        bt.disabled = true;

        // Both formats come from the server, off one shared model, so the
        // spreadsheet and the PDF carry identical content. The browser-side CSV
        // below is only a fallback for a deployment without the renderer.
        var kind = bt.getAttribute('data-proc');
        if (kind === 'csv') {
          bt.textContent = 'Building…';
          try {
            var rx = await authed('/render/orders/' + order.id + '/bom.xls' + qs);
            if (rx.ok) {
              downloadBlob(await rx.blob(), bomFileSlug(vendor, order) + '.xls');
              bt.disabled = false; bt.textContent = label; return;
            }
          } catch (e) {}
          bt.textContent = label;
        }

        if (kind === 'pdf') {
          // The server renders the same HTML the print dialog would, so the emailed
          // and downloaded documents cannot drift apart. If the renderer is not
          // installed, fall back to the browser print path rather than failing.
          bt.textContent = 'Rendering…';
          try {
            var rp = await authed('/render/orders/' + order.id + '/bom.pdf' + qs);
            if (rp.ok) {
              downloadBlob(await rp.blob(), bomFileSlug(vendor, order) + '.pdf');
              bt.disabled = false; bt.textContent = label; return;
            }
          } catch (e) {}
          bt.textContent = label;
        }

        var doc = null;
        try { var r = await authed('/orders/' + order.id + '/bom' + qs); if (r.ok) doc = await r.json(); } catch (e) {}
        bt.disabled = false;
        if (!doc) { alert('Could not build the Bill of Materials.'); return; }
        if (bt.getAttribute('data-proc') === 'csv') downloadBomCsv(doc, vendor);
        else printBom(doc, vendor);
      });
    });
  }

  var Q_TYPES = [['TEXT', 'Short text'], ['LONG_TEXT', 'Paragraph'], ['NUMBER', 'Number'], ['DATE', 'Date'],
    ['SELECT', 'Dropdown — pick one'], ['MULTI_SELECT', 'Dropdown — pick several'], ['BOOLEAN', 'Yes / No']];

  function openQuestionForm(sectionId, done) {
    openModal('Add a question',
      '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">Asked on this vendor’s section of this order. For a question you ask the same vendor every time, add it under Administration instead.</div>' +
      fieldRow('Question', '<input id="qLabel" placeholder="e.g. What gauge steel?" style="' + IN + '">') +
      fieldRow('Answer type', '<select id="qType" style="' + IN + '">' + Q_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') + '</select>') +
      '<div id="qOptWrap" style="display:none;">' +
        fieldRow('Options', '<textarea id="qOpts" rows="3" placeholder="One per line" style="' + IN + 'resize:vertical;"></textarea>') +
      '</div>' +
      fieldRow('Required', '<select id="qReq" style="' + IN + '"><option value="false">Optional</option><option value="true">Required before the section can be confirmed</option></select>'),
      async function (close, showErr) {
        var type = document.getElementById('qType').value;
        var label = document.getElementById('qLabel').value.trim();
        if (!label) return showErr('Type the question.');
        var opts = document.getElementById('qOpts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        if ((type === 'SELECT' || type === 'MULTI_SELECT') && !opts.length) return showErr('A dropdown needs at least one option.');
        var r = await authed('/bom/sections/' + sectionId + '/questions', {
          method: 'POST',
          body: { label: label, type: type, options: opts, required: document.getElementById('qReq').value === 'true' },
        });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not add.'); }
        close(); done();
      }, 'Add question');
    var t = document.getElementById('qType');
    t.addEventListener('change', function () {
      document.getElementById('qOptWrap').style.display = (t.value === 'SELECT' || t.value === 'MULTI_SELECT') ? 'block' : 'none';
    });
  }

  /**
   * Add a ship-to address and put this section on it.
   *
   * Saved rather than typed onto the section: the same address is normally used by
   * every vendor on the order, and it comes back on the next job at the same site.
   */
  function openShipToForm(order, sectionId, done) {
    var two = function (a, b) { return '<div style="display:flex;gap:8px;"><div style="flex:1;">' + a + '</div><div style="flex:1;">' + b + '</div></div>'; };
    openModal('New ship-to address',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">This address is saved and offered on every vendor&rsquo;s sheet, on this order and the next. It prints in the Ship to block of the Bill of Materials.</div>' +
      fieldRow('Name it', '<input id="stName" placeholder="e.g. Denver job trailer" style="' + IN + '" required>') +
      fieldRow('Street', '<input id="stLine1" style="' + IN + '">') +
      fieldRow('Suite / unit', '<input id="stLine2" placeholder="Optional" style="' + IN + '">') +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:2;">' + fieldRow('City', '<input id="stCity" style="' + IN + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('State', '<input id="stRegion" style="' + IN + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('ZIP', '<input id="stZip" style="' + IN + '">') + '</div>' +
      '</div>' +
      two(fieldRow('Site contact', '<input id="stContact" style="' + IN + '">'),
          fieldRow('Phone', '<input id="stPhone" style="' + IN + '">')) +
      fieldRow('Email', '<input id="stEmail" type="email" placeholder="Optional" style="' + IN + '">'),
      async function (close, showErr) {
        var name = document.getElementById('stName').value.trim();
        if (!name) return showErr('Give the address a name — that is what the picker shows.');
        var r = await authed('/ship-to-addresses', {
          method: 'POST',
          body: {
            name: name,
            line1: document.getElementById('stLine1').value.trim(),
            line2: document.getElementById('stLine2').value.trim(),
            city: document.getElementById('stCity').value.trim(),
            region: document.getElementById('stRegion').value.trim(),
            postalCode: document.getElementById('stZip').value.trim(),
            contactName: document.getElementById('stContact').value.trim(),
            phone: document.getElementById('stPhone').value.trim(),
            email: document.getElementById('stEmail').value.trim(),
          },
        });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not save that address (' + r.status + ').'));
        var addr = await r.json();
        // The section that asked for it goes onto it straight away; every other
        // section can now pick it from the list.
        if (sectionId) {
          var rs = await authed('/bom/sections/' + sectionId, { method: 'PATCH', body: { shipToAddressId: addr.id } });
          if (!rs.ok) return showErr(await serverMessage(rs, 'Address saved, but this section could not be moved onto it.'));
        }
        close();
        if (done) done();
      }, 'Save address');
  }

  /** Email this vendor's BOM, pre-filled from the vendor's saved defaults. */
  function openSendForm(order, sec, done) {
    var e = sec.email;
    openModal('Email the ' + sec.vendor + ' Bill of Materials',
      (sec.editable
        ? '<div style="background:#f2f5f3;border:1px solid #d7e0da;border-radius:9px;padding:9px 12px;font-size:12.5px;color:#3f5347;margin-bottom:12px;">Sending submits this section: its fields lock once the email goes out. Unlock it for revisions if it has to change afterwards.</div>'
        : '<div style="background:#f2f3ef;border:1px solid #e2e5dd;border-radius:9px;padding:9px 12px;font-size:12.5px;color:#5c6157;margin-bottom:12px;">This section is already submitted. Sending again re-issues the same sheet and does not reopen it.</div>') +
      (e.hasDefault ? '' : '<div style="background:#fdf6e6;border:1px solid #ecd9a6;border-radius:9px;padding:9px 12px;font-size:12.5px;color:#6b5a24;margin-bottom:12px;">No saved address for this vendor. Type one below, then set a default under Manufacturers so it is pre-filled next time.</div>') +
      fieldRow('To', '<input id="sndTo" value="' + esc(e.to) + '" placeholder="purchasing@vendor.com" style="' + IN + '">') +
      fieldRow('Cc', '<input id="sndCc" value="' + esc(e.cc) + '" placeholder="Optional" style="' + IN + '">') +
      fieldRow('Subject', '<input id="sndSubject" value="' + esc(e.subject) + '" style="' + IN + '">') +
      fieldRow('Attach', '<select id="sndFormat" style="' + IN + '">' +
        '<option value="PDF"' + (e.format === 'PDF' ? ' selected' : '') + '>PDF</option>' +
        '<option value="EXCEL"' + (e.format === 'EXCEL' ? ' selected' : '') + '>Excel</option>' +
        '<option value="BOTH"' + (e.format === 'BOTH' ? ' selected' : '') + '>Both</option></select>') +
      fieldRow('Message', '<textarea id="sndBody" rows="8" style="' + IN + 'resize:vertical;font-family:inherit;">' + esc(e.body) + '</textarea>'),
      async function (close, showErr) {
        var to = document.getElementById('sndTo').value.trim();
        if (!to) return showErr('Type at least one address.');
        var r = await authed('/bom/sections/' + sec.id + '/send', {
          method: 'POST',
          body: {
            to: to, cc: document.getElementById('sndCc').value.trim(),
            subject: document.getElementById('sndSubject').value.trim(),
            body: document.getElementById('sndBody').value,
            format: document.getElementById('sndFormat').value,
          },
        });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e2) {} return showErr(m || 'Could not send.'); }
        close(); done();
      }, 'Send');
  }

  /**
   * `Customer_Name-Order_Number-Vendor_Name`, matching the server and the email
   * subject exactly. It used to be the vendor slug alone, which is why repeat
   * downloads piled up as "goldberg-brothers (4).pdf" — every order produced the
   * same filename.
   */
  function bomFileSlug(vendor, order) {
    var part = function (v) {
      return String(v || '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    };
    var o = order || bomOrder || {};
    return [part(o.customerName || o.organizationName || ''), part(o.number || ''), part(vendor === '*' ? 'All Vendors' : vendor)]
      .filter(Boolean).join('-');
  }

  function downloadBomCsv(doc, vendor) {
    var all = vendor === '*';
    var head = (all ? ['Vendor'] : []).concat(['Line #', 'Description', 'Qty', 'Powder color', 'Weight (lb)', 'Cost each', 'Total cost']);
    var body = (doc.lines || []).map(function (l) {
      var base = [l.lineNo, l.name, String(l.quantity), l.powderColor, (Number(l.extendedWeightLbs) || 0).toFixed(2),
        (l.unitCostMinor / 100).toFixed(2), (l.extendedCostMinor / 100).toFixed(2)];
      return all ? [l.vendor].concat(base) : base;
    });
    var t = doc.totals || {};
    var totalRow = (all ? [''] : []).concat(['Total', '', String(t.unitCount || 0), '', (Number(t.totalWeightLbs) || 0).toFixed(2), '', ((t.extendedCostMinor || 0) / 100).toFixed(2)]);
    var meta = [
      ['Bill of Materials', doc.order.number],
      ['Job', doc.order.jobName], ['Vendor', all ? 'All vendors' : vendor],
      ['Submission date', doc.order.submittedOn ? String(doc.order.submittedOn).slice(0, 10) : todayISO()],
      ['Ship to', doc.shipTo.name], ['Delivery type', doc.order.deliveryType],
      ['Powder coat brand', doc.order.powderCoatBrand], ['Estimated shipment quote', doc.order.shipmentQuote],
      ['Total steel weight (lb)', (Number(t.steelWeightLbs) || 0).toFixed(2)],
      ['Prepared by', (doc.createdBy && doc.createdBy.name) || ''], ['Prepared on', new Date(doc.createdAt).toLocaleString()],
      []
    ];
    downloadCsv(bomFileSlug(vendor, { number: doc.order.number, customerName: doc.customer && doc.customer.name }) + '.csv', meta.concat([head]).concat(body).concat([totalRow]));
  }

  /**
   * The printed Bill of Materials: Summit branding, ship-from / ship-to blocks like
   * a purchase order, the fabrication header, then the lines. Print-to-PDF from the
   * browser dialog; the table header repeats on every page.
   */
  function printBom(doc, vendor) {
    var w = window.open('', '_blank', 'width=1000,height=1100');
    if (!w) { alert('Allow pop-ups to export a PDF.'); return; }
    var all = vendor === '*';
    var t = doc.totals || {};
    var c = doc.company;
    var money2 = function (minor) { return '$' + (Number(minor || 0) / 100).toFixed(2); };
    var dateStr = function (v) { return v ? new Date(v).toLocaleDateString() : '—'; };
    var block = function (label, name, lines, contact, phone, email) {
      return '<div style="flex:1;min-width:200px;">' +
        '<div style="font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#8a8f85;margin-bottom:3px;">' + esc(label) + '</div>' +
        '<div style="font-size:12.5px;line-height:1.5;">' +
          '<b>' + esc(name || '—') + '</b>' +
          (lines || []).map(function (l) { return '<br>' + esc(l); }).join('') +
          (contact ? '<br>' + esc(contact) : '') +
          (phone ? '<br>' + esc(phone) : '') +
          (email ? '<br>' + esc(email) : '') +
        '</div></div>';
    };
    var field = function (label, value) {
      return '<div><div style="font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#8a8f85;">' + esc(label) + '</div>' +
        '<div style="font-size:12.5px;font-weight:600;">' + esc(value == null || value === '' ? '—' : value) + '</div></div>';
    };
    var cols = (all ? ['Vendor'] : []).concat(['Line #', 'Description', 'Qty', 'Powder color', 'Weight (lb)', 'Cost each', 'Total cost', 'Notes']);
    var rightFrom = all ? 3 : 2;
    var thead = cols.map(function (h, i) {
      return '<th style="text-align:' + (i > rightFrom ? 'right' : 'left') + ';padding:6px 8px;font-size:9px;letter-spacing:.05em;text-transform:uppercase;color:#5c6157;border-bottom:1.5px solid #3d4a55;white-space:nowrap;">' + esc(h) + '</th>';
    }).join('');
    var tbody = (doc.lines || []).map(function (l) {
      var cells = (all ? [esc(l.vendor)] : []).concat([
        '<code style="font-size:10.5px;">' + esc(l.lineNo) + '</code>', esc(l.name), String(l.quantity),
        esc(l.powderColor || '—'), (Number(l.extendedWeightLbs) || 0).toFixed(2), money2(l.unitCostMinor), money2(l.extendedCostMinor), esc(l.vendorNotes || '')
      ]);
      var zeroed = l.quantity === 0;
      return '<tr style="' + (zeroed ? 'color:#9a9f95;' : '') + '">' + cells.map(function (v, i) {
        return '<td style="padding:5px 8px;border-bottom:1px solid #e7e8e3;font-size:10.5px;text-align:' + (i > rightFrom ? 'right' : 'left') + ';">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var totalCells = (all ? [''] : []).concat(['', 'Total', String(t.unitCount || 0), '', (Number(t.totalWeightLbs) || 0).toFixed(2), '', money2(t.extendedCostMinor), '']);

    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' +
      esc('BOM ' + doc.order.number + ' — ' + (all ? 'all vendors' : vendor)) + '</title>' +
      '<style>@page{margin:14mm 12mm;}body{font-family:Helvetica,Arial,sans-serif;color:#20241f;margin:0;}' +
      'thead{display:table-header-group;}tr{page-break-inside:avoid;}</style></head>' +
      '<body>' +
      // Branding band
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2.5px solid #1c4039;padding-bottom:10px;">' +
        '<div style="display:flex;gap:12px;align-items:center;">' +
          '<img src="' + location.origin + '/logo.png" alt="" style="height:52px;width:auto;">' +
          '<div><div style="font-family:Georgia,serif;font-size:20px;font-weight:700;letter-spacing:-.01em;">' + esc(c.name) + '</div>' +
            '<div style="font-size:10.5px;color:#5c6157;line-height:1.45;">' + esc(c.addressLine1) + ' · ' + esc(c.city + ', ' + c.region + ' ' + c.postalCode) +
            '<br>' + esc(c.phone) + ' · ' + esc(c.email) + '</div></div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div style="font-family:Georgia,serif;font-size:17px;font-weight:700;">Bill of Materials</div>' +
          '<div style="font-size:11px;color:#5c6157;margin-top:2px;">' + esc(doc.order.number) + ' · accepted proposal v' + (doc.order.acceptedVersion || '') + '</div>' +
          '<div style="font-size:11px;color:#5c6157;">' + esc(all ? 'All vendors' : vendor) + '</div>' +
        '</div>' +
      '</div>' +
      // Ship from / ship to
      '<div style="display:flex;gap:24px;margin-top:14px;">' +
        block('Ship from (vendor)',
          doc.vendor ? doc.vendor.name : (all ? 'Multiple vendors — see line items' : vendor),
          doc.vendor ? [streetLine(doc.vendor.addressLine1, doc.vendor.addressLine2), [doc.vendor.city, [doc.vendor.region, doc.vendor.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean) : [],
          doc.vendor ? [doc.vendor.contactName, doc.vendor.contactTitle].filter(Boolean).join(', ') : '',
          doc.vendor ? doc.vendor.contactPhone : '', doc.vendor ? doc.vendor.contactEmail : '') +
        block('Ship to (' + doc.shipTo.label + ')', doc.shipTo.name, doc.shipTo.lines, doc.shipTo.contactName, doc.shipTo.phone, doc.shipTo.email) +
      '</div>' +
      // Fabrication header
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px 18px;margin-top:14px;padding:11px 13px;background:#f7f8f4;border:1px solid #e7e8e3;border-radius:8px;">' +
        field('Job', doc.order.jobName) +
        field('Submission date', dateStr(doc.order.submittedOn)) +
        field('Delivery type', doc.order.deliveryType) +
        field('Powder coat brand', doc.order.powderCoatBrand) +
        field('Total steel weight', (Number(t.steelWeightLbs) || 0).toFixed(2) + ' lb') +
        field('Total weight', (Number(t.totalWeightLbs) || 0).toFixed(2) + ' lb') +
        field('Estimated shipment quote', doc.order.shipmentQuote || 'TBD') +
        field('Vendor terms', doc.vendor ? (doc.vendor.paymentTerms || '—') : '—') +
      '</div>' +
      '<div style="font-size:9.5px;color:#8a8f85;margin:5px 0 0;">Total steel weight is fabricated steel only — it excludes hardware and crating.</div>' +
      // Lines
      '<table style="width:100%;border-collapse:collapse;margin-top:12px;"><thead><tr>' + thead + '</tr></thead><tbody>' + tbody +
      '<tr>' + totalCells.map(function (v, i) {
        return '<td style="padding:7px 8px;border-top:1.5px solid #3d4a55;font-size:11px;font-weight:700;text-align:' + (i > rightFrom ? 'right' : 'left') + ';">' + esc(v) + '</td>';
      }).join('') + '</tr></tbody></table>' +
      (doc.order.notes ? '<div style="margin-top:12px;padding:10px 12px;border:1px solid #e7e8e3;border-radius:8px;font-size:11px;line-height:1.55;"><b>Notes:</b> ' + esc(doc.order.notes) + '</div>' : '') +
      // Sign-off footer
      '<div style="display:flex;justify-content:space-between;gap:20px;margin-top:18px;padding-top:10px;border-top:1px solid #e7e8e3;font-size:10px;color:#5c6157;">' +
        '<div>Prepared by <b>' + esc((doc.createdBy && doc.createdBy.name) || '—') + '</b>' +
          ((doc.createdBy && doc.createdBy.email) ? ' · ' + esc(doc.createdBy.email) : '') +
          '<br>Created ' + esc(new Date(doc.createdAt).toLocaleString()) + '</div>' +
        '<div style="text-align:right;">' + esc(c.name) + ' · ' + esc(c.email) + '<br>' + esc(doc.order.number) + '</div>' +
      '</div>' +
      '</body></html>');
    w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 400);
  }
  /* --- QuickBooks push: prepare → authorize → execute, on the order itself. --- */
  var QBO_TYPES = [
    ['ESTIMATE', 'Estimate'],
    // The full itemized invoice — same lines as the estimate, with the accepted
    // payment split carried as QuickBooks terms. The backend has always accepted
    // this type; it was missing from this list, which left the portion invoices
    // as the only way to bill from the CRM.
    ['INVOICE', 'Invoice (full order, itemized)'],
    ['DEPOSIT_INVOICE', 'Deposit invoice'],
    ['PROGRESS_INVOICE', 'Progress invoice'],
    ['FINAL_INVOICE', 'Final invoice']
  ];
  function qboTypeLabel(t) { for (var i = 0; i < QBO_TYPES.length; i++) if (QBO_TYPES[i][0] === t) return QBO_TYPES[i][1]; return titleCase(t); }
  function qboStatusChip(s) {
    var tone = { PAID: '#3f9d78', PARTIALLY_PAID: '#b7873a', OVERDUE: '#c2452f', OPEN: '#5c6357' }[s] || '#82877d';
    return '<span class="chip" style="color:' + tone + ';border-color:' + tone + '33;">' + titleCase(s || 'Open') + '</span>';
  }
  /** Date and time, because "was it sent" is usually really "was it sent before the call". */
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  async function loadQbo(order, user) {
    var box = document.getElementById('qboBox'); if (!box) return;
    var txns = [], billing = null, conn = null;
    try {
      var rs = await authed('/integrations/quickbooks/status'); conn = rs.ok ? await rs.json() : null;
      var r = await authed('/integrations/quickbooks/transactions?proposalId=' + encodeURIComponent(order.proposalId));
      if (r.status === 403) { box.innerHTML = '<div class="placeholder" style="padding:18px;"><p class="muted" style="margin:0;">Your role cannot view QuickBooks documents.</p></div>'; return; }
      if (r.ok) txns = (await r.json()) || [];
      // Local mirror, not a live read: opening an order must not cost an Intuit
      // round trip per document. The Refresh button is the live one.
      var rb = await authed('/integrations/quickbooks/billing/' + encodeURIComponent(order.proposalId));
      if (rb.ok) billing = await rb.json();
    } catch (e) { box.innerHTML = '<div class="err">Could not reach QuickBooks.</div>'; return; }

    var connected = conn && (conn.connections || 0) > 0;
    /**
     * Why Step 1 is unavailable, in words, instead of an absent button.
     *
     * This panel used to hide the Prepare button whenever any one of these was false,
     * which left the operator staring at a QuickBooks section with nothing to press
     * and no way to find out which condition had failed. The button is now always
     * rendered; when it cannot be used it is disabled and carries the reason.
     */
    var blockReason = '';
    if (!hasRole(QBO_TXN_ROLES, user.role)) {
      blockReason = 'Your role (' + titleCase(user.role || 'unknown') + ') cannot create QuickBooks documents. Accounting or System Admin can.';
    } else if (!conn) {
      blockReason = 'This app could not read the QuickBooks connection status. Your role may lack the QuickBooks management permission, or Integrations is unreachable.';
    } else if (!conn.configured) {
      blockReason = 'QuickBooks is not configured on this deployment — the QBO environment variables are missing.';
    } else if (!connected) {
      blockReason = 'No active QuickBooks connection for the ' + titleCase(conn.environment || 'current') + ' environment. Connect it under Integrations.';
    } else if (order.status === 'CANCELLED') {
      blockReason = 'This order is cancelled, so its totals are no longer a thing to bill. Re-accept the proposal first.';
    } else if (!order.proposalVersionId) {
      blockReason = 'This record has no linked proposal version, so there are no accepted totals to freeze.';
    }
    var canTransact = !blockReason;
    // A separate, softer warning: preparing and authorizing will both work, and the
    // create at Step 3 will be refused by the server. Saying so here rather than two
    // clicks later is the difference between a decision and a dead end.
    var writeGate = connected && conn && conn.environment === 'PRODUCTION' && !conn.productionWritesEnabled
      ? 'QuickBooks is connected to <b>Production</b> but production writes are switched off (QBO_PRODUCTION_WRITE_ENABLED is not true). You can prepare and authorize; Step 3 will be refused until that variable is set and the app redeployed.'
      : '';
    var billByTxn = {};
    ((billing && billing.documents) || []).forEach(function (d) { billByTxn[d.id] = d; });

    // Two tables rather than one wide one. Before a document exists in
    // QuickBooks the only question is which of the three steps is next; after it
    // exists the question is entirely different — was it sent, has it been paid.
    var pending = txns.filter(function (t) { return t.status !== 'CREATED'; });
    var live = txns.filter(function (t) { return t.status === 'CREATED'; });

    var pendingRows = pending.map(function (t) {
      var step = '';
      if (canTransact) {
        if (t.status === 'DRAFT' || t.status === 'PENDING_AUTHORIZATION') step = '<button class="link-btn" data-qbo="authorize" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 2 · Authorize</button>';
        else if (t.status === 'AUTHORIZED') step = '<button class="btn" data-qbo="execute" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 3 · Create in QuickBooks</button>';
        else if (t.status === 'FAILED') step = '<button class="link-btn" data-qbo="retry" data-id="' + t.id + '" style="width:auto;padding:7px 13px;color:#9c3327;">Retry</button>';
      }
      return '<tr>' + td('<b style="font-weight:600;">' + esc(qboTypeLabel(t.type)) + '</b>' + (t.error ? '<div style="font-size:12px;color:#9c3327;">' + esc(t.error) + '</div>' : '')) +
        td('<span class="chip">' + titleCase(t.status) + '</span>') +
        td(fmtMoney(t.amountMinor, t.currency)) +
        td('<div style="display:flex;justify-content:flex-end;">' + (step || '<span class="muted">—</span>') + '</div>') + '</tr>';
    }).join('');

    var liveRows = live.map(function (t) {
      var d = billByTxn[t.id] || {};
      var isEstimate = t.type === 'ESTIMATE';
      var sent = d.sentAt
        ? '<b style="font-weight:600;color:#3f9d78;">Sent</b><div style="font-size:12px;color:#82877d;">' + esc(fmtStamp(d.sentAt)) +
          (d.sentToEmail ? '<br>' + esc(d.sentToEmail) : '') + (d.sentBy ? '<br>by ' + esc(d.sentBy) : '') + '</div>'
        : (isEstimate
            ? '<span class="muted">Not sent</span>'
            : '<span class="muted" title="Biller Genie collects each invoice from QuickBooks within a few minutes of creation and emails the customer on Summit letterhead. QuickBooks itself sends nothing.">Biller Genie</span>') +
          (d.sendError ? '<div style="font-size:12px;color:#9c3327;">' + esc(d.sendError) + '</div>' : '');
      var moneyCell = isEstimate ? '<span class="muted">—</span>'
        : (d.balanceMinor == null
            ? '<span class="muted">Not synced yet</span>'
            : qboStatusChip(d.qboStatus) +
              '<div style="font-size:12px;color:#82877d;margin-top:3px;">' +
              fmtMoney(d.paidMinor || '0', t.currency) + ' paid of ' + fmtMoney(d.qboTotalMinor || t.amountMinor, t.currency) +
              (Number(d.balanceMinor) > 0 ? '<br><b style="color:#20241f;">' + fmtMoney(d.balanceMinor, t.currency) + ' outstanding</b>' : '') +
              (d.dueDate ? '<br>Due ' + esc(fmtDate(d.dueDate)) : '') + '</div>');
      var acts = ['<button class="link-btn" data-qbob="pdf" data-id="' + t.id + '" style="width:auto;padding:6px 11px;">View</button>'];
      // No Send or Remind button. Biller Genie owns every customer-facing email — it
      // picks each invoice up from QuickBooks within minutes of creation and delivers
      // it on Summit letterhead with its own payment link and follow-up schedule. A
      // send from here would reach the customer twice, from two systems, with two ways
      // to pay. The endpoints refuse it too; this only removes the temptation.
      return '<tr>' + td('<b style="font-weight:600;">' + esc(qboTypeLabel(t.type)) + '</b><div style="font-size:12px;color:#82877d;">' + esc(t.qboDocNumber || t.qboId || '') + '</div>') +
        td(sent) + td(moneyCell) +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">' + acts.join('') + '</div>') + '</tr>';
    }).join('');

    var payRows = ((billing && billing.payments) || []).map(function (p) {
      return '<tr>' + td(esc(fmtDate(p.txnDate))) +
        td('<b style="font-weight:600;">' + fmtMoney(p.amountMinor, p.currency) + '</b>' +
          (p.totalAmountMinor !== p.amountMinor ? '<div style="font-size:12px;color:#82877d;">of a ' + fmtMoney(p.totalAmountMinor, p.currency) + ' payment</div>' : '')) +
        td(esc(p.method || '—')) + td(esc(p.referenceNumber || '—')) + td(esc(p.depositToAccount || '—')) + '</tr>';
    }).join('');

    var remRows = ((billing && billing.reminders) || []).map(function (m) {
      return '<tr>' + td(esc(fmtStamp(m.at))) + td(esc(m.toEmail)) +
        td(esc(m.subject) + (m.error ? '<div style="font-size:12px;color:#9c3327;">' + esc(m.error) + '</div>' : '')) +
        td(fmtMoney(m.balanceMinor, 'USD')) +
        td(m.status === 'sent' ? '<span class="chip" style="color:#3f9d78;border-color:#3f9d7833;">Sent</span>' : '<span class="chip" style="color:#c2452f;border-color:#c2452f33;">Failed</span>') + '</tr>';
    }).join('');

    var lastSync = ((billing && billing.documents) || []).map(function (d) { return d.lastSyncedAt; }).filter(Boolean).sort().pop();

    box.innerHTML =
      '<div class="muted" style="font-size:12.5px;margin:-4px 0 10px;line-height:1.55;">Pushing to QuickBooks is three deliberate steps: <b>prepare</b> freezes the totals and an idempotency key (nothing leaves this app), <b>authorize</b> is the sign-off, <b>create</b> writes the document into QuickBooks. A retry reuses the same key, so it can never duplicate a document. Invoices are emailed to the customer by Biller Genie, which reads them out of QuickBooks on its own schedule — nothing is sent from here.</div>' +
      (!connected ? '<div class="placeholder" style="padding:16px;margin-bottom:10px;"><p class="muted" style="margin:0;">QuickBooks is not connected — connect it under Integrations first.</p></div>' : '') +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">' +
        (order.organizationId ? '<button class="link-btn" id="qboProfile" style="width:auto;padding:9px 14px;">Check customer profile</button>' : '') +
        '<button class="link-btn" id="qboRefresh" style="width:auto;padding:9px 14px;">Refresh from QuickBooks</button>' +
        (lastSync ? '<span class="muted" style="font-size:12px;">Last read ' + esc(fmtStamp(lastSync)) + '</span>' : '') +
        '<div style="margin-left:auto;">' +
          '<button class="btn" id="qboPrepare"' + (canTransact ? '' : ' disabled title="' + esc(blockReason) + '" style="width:auto;padding:9px 15px;opacity:.45;cursor:not-allowed;"') +
          (canTransact ? ' style="width:auto;padding:9px 15px;"' : '') + '>Step 1 · Prepare a document</button>' +
        '</div>' +
      '</div>' +
      (blockReason
        ? '<div style="background:#fbe9e6;border:1px solid #f0cdc7;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#9c3327;line-height:1.55;margin-bottom:10px;"><b style="font-weight:600;">Step 1 is unavailable.</b> ' + esc(blockReason) + '</div>'
        : '') +
      (writeGate
        ? '<div style="background:#fdf6e3;border:1px solid #eadfbe;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#8a6d1f;line-height:1.55;margin-bottom:10px;">' + writeGate + '</div>'
        : '') +
      (pending.length ? '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;margin:14px 0 6px;">Waiting to be created</div>' +
        tableShell(['Document', 'Status', 'Amount', ''], pendingRows, 4, '') : '') +
      '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;margin:16px 0 6px;">In QuickBooks</div>' +
      tableShell(['Document', 'Delivery', 'Payment', ''], liveRows, 4, 'Nothing has been created in QuickBooks for this order yet.') +
      (payRows ? '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;margin:18px 0 6px;">Payments received</div>' +
        tableShell(['Date', 'Applied', 'Method', 'Reference', 'Deposited to'], payRows, 5, '') : '') +
      (remRows ? '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;margin:18px 0 6px;">Payment reminders</div>' +
        tableShell(['Sent', 'To', 'Subject', 'Balance then', 'Status'], remRows, 5, '') : '');

    var pb = document.getElementById('qboPrepare');
    if (pb && canTransact) pb.addEventListener('click', function () { openQboPrepare(order, user, txns); });
    var prof = document.getElementById('qboProfile');
    if (prof) prof.addEventListener('click', function () { openQboProfile(order, user); });
    var rf = document.getElementById('qboRefresh');
    if (rf) rf.addEventListener('click', async function () {
      rf.disabled = true; rf.textContent = 'Reading QuickBooks…';
      var rr = await authed('/integrations/quickbooks/billing/' + encodeURIComponent(order.proposalId) + '?refresh=1');
      if (!rr.ok) alert('Could not read QuickBooks (' + rr.status + ').');
      else {
        var jd = await rr.json();
        // Per-document failures are reported rather than swallowed: a partial
        // refresh that looks complete is how a stale balance gets trusted.
        if (jd.refreshErrors && jd.refreshErrors.length) {
          alert(jd.refreshErrors.length + ' document(s) could not be read:\n\n' + jd.refreshErrors.map(function (e) { return e.error; }).join('\n'));
        }
      }
      loadQbo(order, user);
    });

    document.querySelectorAll('[data-qbo]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var act = bt.getAttribute('data-qbo');
        if (act === 'execute' && !confirm('This creates the document in QuickBooks. Continue?')) return;
        bt.disabled = true; bt.textContent = 'Working…';
        var r = await authed('/integrations/quickbooks/transactions/' + bt.getAttribute('data-id') + '/' + act, { method: 'POST', body: {} });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || ('Step failed (' + r.status + ').')); }
        loadQbo(order, user);
      });
    });

    document.querySelectorAll('[data-qbob]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        var id = bt.getAttribute('data-id'), act = bt.getAttribute('data-qbob');
        if (act === 'pdf') return openQboPdf(id, bt);
        // 'send' and 'remind' are deliberately gone — see the row builder above.
      });
    });
  }

  /**
   * The document as the customer received it. Fetched with the session's
   * credentials and opened as a blob — a plain link to the route would arrive
   * without an Authorization header and 401.
   */
  async function openQboPdf(txnId, bt) {
    var label = bt.textContent; bt.disabled = true; bt.textContent = 'Fetching…';
    try {
      var r = await authed('/integrations/quickbooks/transactions/' + txnId + '/pdf');
      if (!r.ok) { alert('QuickBooks did not return a PDF (' + r.status + ').'); return; }
      var url = URL.createObjectURL(await r.blob());
      if (!window.open(url, '_blank')) alert('Allow pop-ups to view the invoice.');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } finally { bt.disabled = false; bt.textContent = label; }
  }

  /**
   * Send through QuickBooks, not from here — the customer gets the QuickBooks
   * invoice with its pay-online link, and the send is recorded in QuickBooks'
   * own history, which is what the bookkeeper reconciles against.
   */
  function openQboSend(txnId, doc, order, user) {
    openModal(doc.sentAt ? 'Resend this document' : 'Send to the customer',
      '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">QuickBooks emails the document and records the delivery on its side. ' +
        (doc.sentAt ? 'It was last sent ' + esc(fmtStamp(doc.sentAt)) + '.' : 'It has not been sent yet.') + '</div>' +
      fieldRow('Send to', '<input id="qbSendTo" type="email" value="' + esc(doc.sentToEmail || '') + '" placeholder="Leave blank to use the address on the invoice" style="' + IN + '">'),
      async function (close, showErr) {
        var r = await authed('/integrations/quickbooks/transactions/' + txnId + '/send', { method: 'POST', body: { to: document.getElementById('qbSendTo').value.trim() || null } });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not send (' + r.status + ').'); }
        close(); loadQbo(order, user);
      }, doc.sentAt ? 'Resend' : 'Send');
  }

  /**
   * Compose a reminder. The draft comes from the server, which re-reads the
   * balance from QuickBooks first — so nobody chases a customer for money that
   * arrived this morning.
   */
  async function openQboReminder(txnId, order, user) {
    var r = await authed('/integrations/quickbooks/transactions/' + txnId + '/reminder');
    if (!r.ok) { alert('Could not prepare a reminder (' + r.status + ').'); return; }
    var d = await r.json();
    if (d.blockers && d.blockers.length) { alert(d.blockers.join('\n\n')); return; }
    openModal('Remind ' + (d.customerName || 'the customer') + ' about ' + fmtMoney(d.balanceMinor, d.currency),
      '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">' +
        fmtMoney(d.balanceMinor, d.currency) + ' outstanding' + (d.daysOverdue > 0 ? ', ' + d.daysOverdue + ' day' + (d.daysOverdue === 1 ? '' : 's') + ' past due' : '') +
        '. The invoice PDF is attached as it currently stands in QuickBooks.</div>' +
      fieldRow('To', '<input id="qbRemTo" type="text" value="' + esc(d.toEmail || '') + '" style="' + IN + '">') +
      fieldRow('Cc', '<input id="qbRemCc" type="text" placeholder="Optional" style="' + IN + '">') +
      fieldRow('Subject', '<input id="qbRemSubj" type="text" value="' + esc(d.subject) + '" style="' + IN + '">') +
      fieldRow('Message', '<textarea id="qbRemBody" rows="12" style="' + IN + 'font-family:inherit;line-height:1.6;">' + esc(d.body) + '</textarea>'),
      async function (close, showErr) {
        var rr = await authed('/integrations/quickbooks/transactions/' + txnId + '/reminder', { method: 'POST', body: {
          to: document.getElementById('qbRemTo').value.trim(),
          cc: document.getElementById('qbRemCc').value.trim() || null,
          subject: document.getElementById('qbRemSubj').value.trim(),
          body: document.getElementById('qbRemBody').value
        } });
        if (!rr.ok) { var m = ''; try { m = ((await rr.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not send the reminder (' + rr.status + ').'); }
        close(); loadQbo(order, user);
      }, 'Send reminder');
  }

  /**
   * What QuickBooks holds for this customer against what we hold. Read-only:
   * the CRM owns every field here, so the fix for a difference is to correct the
   * customer record and re-sync, never to pull QuickBooks' copy back in.
   */
  async function openQboProfile(order, user) {
    var r = await authed('/integrations/quickbooks/customers/' + encodeURIComponent(order.organizationId) + '/profile');
    if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || ('Could not read the QuickBooks profile (' + r.status + ').')); return; }
    var d = await r.json();
    // Only somebody who may edit a customer gets the editor; everyone else keeps the
    // read-only comparison they had.
    var canEditTax = canCrmWrite(user && user.role);
    function profileRows(fields) {
      return (fields || []).map(function (f) {
        var tone = f.differs ? '#c2452f' : f.missingInQbo ? '#b7873a' : '#82877d';
        var note = f.differs ? 'Differs' : f.missingInQbo ? 'Not in QuickBooks' : f.empty ? 'Blank in both' : '';
        return '<tr>' +
          '<td style="padding:8px 10px;border-bottom:1px solid #e7e8e3;vertical-align:top;color:#5c6357;white-space:nowrap;">' + esc(f.label) + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid #e7e8e3;vertical-align:top;">' + (esc(f.crm) || '<span class="muted">—</span>') + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid #e7e8e3;vertical-align:top;' + (f.differs ? 'color:#9c3327;' : '') + '">' + (esc(f.qbo) || '<span class="muted">—</span>') + '</td>' +
          '<td style="padding:8px 10px;border-bottom:1px solid #e7e8e3;vertical-align:top;font-size:12px;color:' + tone + ';white-space:nowrap;">' + note + '</td>' +
          '</tr>';
      }).join('');
    }
    var rows = profileRows(d.fields);
    openModal('QuickBooks customer profile',
      (!d.linked
        ? '<div class="placeholder" style="padding:16px;margin-bottom:12px;"><p class="muted" style="margin:0;">This customer is not linked to a QuickBooks customer yet. One will be created — or an existing customer with the same name adopted — the first time a document is pushed.</p></div>'
        : '<div class="muted" style="font-size:12.5px;margin-bottom:12px;line-height:1.55;">QuickBooks customer ' + esc(d.qboCustomerId) +
          (d.qboActive === false ? ' <b style="color:#9c3327;">(inactive)</b>' : '') +
          (d.qboBalanceMinor != null ? ' · ' + fmtMoney(d.qboBalanceMinor, 'USD') + ' owed across all their invoices' : '') + '</div>') +
      (d.warnings.length ? '<div style="background:#fbf6ec;border:1px solid #e6d9bd;border-radius:6px;padding:11px 13px;margin-bottom:12px;font-size:13px;color:#6b5a34;line-height:1.55;">' +
        d.warnings.map(function (w) { return esc(w); }).join('<br>') + '</div>' : '') +
      '<table style="width:100%;border-collapse:collapse;font-size:13.5px;">' +
        '<thead><tr>' + ['', 'In this CRM', 'In QuickBooks', ''].map(function (h) {
          return '<th style="text-align:left;padding:6px 10px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #cfd3ca;">' + h + '</th>';
        }).join('') + '</tr></thead><tbody id="ctxRows">' + rows + '</tbody></table>' +
      /**
       * Tax standing, editable here.
       *
       * This is the one field on the comparison whose correct value is a decision
       * rather than a data-entry fix, and it is the field that decides whether
       * QuickBooks adds sales tax to the invoice about to be pushed. Sending someone
       * to CRM to change it was not possible in any case — an organization could not
       * be edited after it was created — and sending them to Integrations to sync
       * afterwards, from the screen where they are about to bill, was two detours from
       * the place the question came up.
       *
       * Save writes the CRM record and immediately pushes the customer, then re-reads
       * the comparison, so the row above either agrees or says why it does not.
       */
      (canEditTax
        ? '<div style="border:1px solid #dcded7;border-radius:10px;padding:13px 14px;margin-top:14px;">' +
            '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f85;font-weight:600;margin-bottom:9px;">Tax standing</div>' +
            '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;cursor:pointer;">' +
              '<input type="checkbox" id="ctxExempt"' + (d.taxExempt ? ' checked' : '') + '>' +
              ' This customer is exempt from sales tax</label>' +
            '<div style="display:flex;gap:9px;align-items:flex-end;margin-top:11px;flex-wrap:wrap;">' +
              '<div style="flex:1 1 220px;">' +
                '<div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;margin-bottom:5px;">Exemption / resale certificate no.</div>' +
                '<input id="ctxNum" value="' + esc(d.taxExemptId || '') + '" placeholder="As printed on the certificate" style="' + IN + '"' + (d.taxExempt ? '' : ' disabled') + '>' +
              '</div>' +
              '<button class="btn" id="ctxSave" style="width:auto;padding:10px 16px;">Save &amp; push to QuickBooks</button>' +
            '</div>' +
            '<div id="ctxMsg" class="muted" style="font-size:12.5px;margin-top:9px;line-height:1.55;">Exempt sends <b>Taxable: false</b> and the certificate number to QuickBooks. Taxable sends <b>Taxable: true</b>, which is what clears an exemption QuickBooks is holding.</div>' +
          '</div>'
        : '') +
      '<div class="muted" style="font-size:12.5px;margin-top:12px;line-height:1.55;">' +
        (d.differenceCount || d.missingCount
          ? 'Correct anything else on the customer record, then push it with <b>Sync customer to QuickBooks</b> under Integrations. The CRM is the source of truth for every field above, so nothing here is ever pulled back the other way.'
          : 'The two records agree.') + '</div>',
      null, 'Close', { maxWidth: '760px' });

    var ctxEx = document.getElementById('ctxExempt');
    var ctxNum = document.getElementById('ctxNum');
    // A certificate number against a taxable customer is meaningless, so the field
    // follows the flag rather than sitting there holding a stale value.
    if (ctxEx && ctxNum) ctxEx.addEventListener('change', function () {
      ctxNum.disabled = !ctxEx.checked;
      if (!ctxEx.checked) ctxNum.value = '';
    });
    var ctxSave = document.getElementById('ctxSave');
    if (ctxSave) ctxSave.addEventListener('click', async function () {
      var msg = document.getElementById('ctxMsg');
      var say = function (text, colour) { if (msg) { msg.style.color = colour || ''; msg.innerHTML = esc(text); } };
      ctxSave.disabled = true; say('Saving…');
      var rp = await authed('/crm/organizations/' + order.organizationId, {
        method: 'PATCH',
        body: { taxExempt: ctxEx.checked, taxExemptId: ctxEx.checked ? ctxNum.value.trim() : null },
      });
      if (!rp.ok) {
        var pm = ''; try { pm = ((await rp.json()) || {}).message || ''; } catch (e) {}
        ctxSave.disabled = false;
        return say(pm || ('Could not save the customer record (' + rp.status + ').'), '#9c3327');
      }
      say('Saved. Pushing to QuickBooks…');
      var rs = await authed('/integrations/quickbooks/customers/' + order.organizationId + '/sync', { method: 'POST' });
      ctxSave.disabled = false;
      if (!rs.ok) {
        var sm = ''; try { sm = ((await rs.json()) || {}).message || ''; } catch (e) {}
        return say('Saved in the CRM, but the push failed: ' + (sm || ('HTTP ' + rs.status)) + '. Retry with Sync customer to QuickBooks under Integrations.', '#9c3327');
      }
      // Re-read from QuickBooks and repaint the comparison. The whole point of this
      // panel is that it reports what QuickBooks actually holds, so a success message
      // on its own would be the app telling you it worked instead of showing you.
      var rr = await authed('/integrations/quickbooks/customers/' + encodeURIComponent(order.organizationId) + '/profile');
      if (!rr.ok) return say('Pushed to QuickBooks. Close and re-open this panel to see the result.', '#2f7d5d');
      var nd = await rr.json();
      var tb = document.getElementById('ctxRows');
      if (tb) tb.innerHTML = profileRows(nd.fields);
      say(nd.differenceCount ? 'Pushed. ' + nd.differenceCount + ' field(s) still differ above.' : 'Pushed. QuickBooks now matches the CRM.',
        nd.differenceCount ? '#8a6d1f' : '#2f7d5d');
    });
  }

  /**
   * Copy number of a prepared document, read off the tail of its idempotency key
   * (`qbo:<env>:<type>:<versionId>:<seq>`). The key is already on the wire, so the
   * copy number needs no column of its own.
   */
  function qboSeqOf(t) {
    var m = /:(\d+)$/.exec(String((t && t.idempotencyKey) || ''));
    return m ? Number(m[1]) : 1;
  }

  /**
   * Prepare a document, with an explicit way to create a SECOND one of the same
   * type for the same accepted version.
   *
   * The idempotency key is (environment, type, version, copy number) and it travels
   * to QuickBooks as the requestid, which is what makes a retry safe. The same
   * property means a document that already exists cannot simply be pushed again:
   * prepare hands back the original row and create returns the original document.
   * Deleting the estimate inside QuickBooks does not release the key either — the
   * CRM still holds a CREATED row, and Intuit still recognises the requestid. So a
   * genuine second document has to be a new copy, and the operator has to ask for
   * it deliberately.
   */
  function openQboPrepare(order, user, txns) {
    txns = txns || [];
    function priorOf(type) { return txns.filter(function (t) { return t.type === type; }); }
    function createdOf(type) { return priorOf(type).filter(function (t) { return t.status === 'CREATED'; }); }
    function nextSeq(type) {
      return priorOf(type).reduce(function (n, t) { return Math.max(n, qboSeqOf(t)); }, 0) + 1;
    }
    /** The panel under the type picker: what already exists, and the copy opt-in. */
    function noteHtml(type) {
      var made = createdOf(type);
      var pending = priorOf(type).filter(function (t) { return t.status !== 'CREATED'; });
      if (!made.length) {
        return pending.length
          ? '<div class="muted" style="font-size:12.5px;line-height:1.55;">A ' + esc(qboTypeLabel(type).toLowerCase()) + ' is already prepared and waiting to be created. Preparing again reopens that one rather than starting a second.</div>'
          : '';
      }
      var list = made.map(function (t) {
        return '<div>' + esc(qboTypeLabel(t.type)) + ' ' + esc(t.qboDocNumber || t.qboId || '') +
          (qboSeqOf(t) > 1 ? ' (copy ' + qboSeqOf(t) + ')' : '') +
          (t.createdAt ? ' · ' + esc(fmtStamp(t.createdAt)) : '') + '</div>';
      }).join('');
      return '<div style="background:#fbf6ec;border:1px solid #e6d9bd;border-radius:8px;padding:11px 13px;font-size:13px;color:#6b5a34;line-height:1.55;">' +
        '<b style="font-weight:600;">Already in QuickBooks</b>' + list +
        '<label style="display:flex;align-items:flex-start;gap:8px;margin-top:9px;cursor:pointer;color:#20241f;">' +
          '<input type="checkbox" id="qboAnother" style="margin-top:3px;">' +
          '<span>Create another copy (copy ' + nextSeq(type) + ')</span>' +
        '</label>' +
        '<div style="margin-top:6px;font-size:12px;">A copy is a genuinely new document in QuickBooks, with its own number. Deleting the original inside QuickBooks does not free the original to be re-sent — a copy is still the way to replace it.</div>' +
      '</div>';
    }
    var initial = QBO_TYPES[0][0];
    openModal('Prepare a QuickBooks document',
      '<div class="muted" style="font-size:13px;margin-bottom:12px;">This freezes the accepted totals of ' + esc(order.number) + ' against an idempotency key. Nothing is sent to QuickBooks until you authorize and create it.</div>' +
      fieldRow('Document type', '<select id="qboType" style="' + IN + '">' + QBO_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') + '</select>') +
      '<div id="qboPrepNote">' + noteHtml(initial) + '</div>',
      async function (close, showErr) {
        var type = document.getElementById('qboType').value;
        var another = document.getElementById('qboAnother');
        // An existing CREATED document is a hard stop unless the copy box is ticked.
        // Without this the prepare silently returns the original row and the operator
        // is left clicking Create on a document that will never change.
        if (createdOf(type).length && !(another && another.checked)) {
          return showErr('A ' + qboTypeLabel(type).toLowerCase() + ' already exists in QuickBooks for this version. Tick “Create another copy” to make a second one.');
        }
        var body = { proposalVersionId: order.proposalVersionId, type: type };
        if (another && another.checked) body.sequence = nextSeq(type);
        var r = await authed('/integrations/quickbooks/transactions/prepare', { method: 'POST', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not prepare (' + r.status + ').'); }
        close(); loadQbo(order, user);
      }, 'Prepare');
    var sel = document.getElementById('qboType');
    if (sel) sel.addEventListener('change', function () {
      var box = document.getElementById('qboPrepNote');
      if (box) box.innerHTML = noteHtml(sel.value);
    });
  }

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
  /** Print-to-PDF of one table — the browser's print dialog saves it as PDF. */
  function printTable(title, subtitle, head, rows, totalRow) {
    var w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { alert('Allow pop-ups to export a PDF.'); return; }
    var cell = function (v, b) { return '<td style="padding:7px 10px;border-bottom:1px solid #e7e8e3;' + (b ? 'font-weight:600;border-top:1px solid #cfd3ca;' : '') + '">' + esc(v) + '</td>'; };
    w.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<body style="font-family:Georgia,serif;color:#23261f;margin:34px;">' +
      '<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8a8f85;">Summit Sensory Gym</div>' +
      '<h1 style="font-size:21px;margin:4px 0 2px;">' + esc(title) + '</h1>' +
      '<div style="font-size:12.5px;color:#6c7266;margin-bottom:16px;">' + esc(subtitle) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;font-size:12.5px;"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:left;padding:7px 10px;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;border-bottom:1px solid #cfd3ca;">' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (v) { return cell(v); }).join('') + '</tr>'; }).join('') +
      (totalRow ? '<tr>' + totalRow.map(function (v) { return cell(v, 1); }).join('') + '</tr>' : '') +
      '</tbody></table></body>');
    w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 300);
  }
  function auditRows(events) {
    if (!events || !events.length) return '<div class="placeholder" style="padding:20px;"><p class="muted" style="margin:0;">No events recorded.</p></div>';
    return '<div class="card">' + events.map(function (e, i) { return '<div style="display:flex;gap:12px;padding:' + (i ? '10px' : '0') + ' 0 0;border-top:' + (i ? '1px solid #f2f3ef;margin-top:10px;' : 'none;') + 'font-size:13.5px;"><span style="color:#8a8f85;min-width:150px;">' + fmtDate(e.at) + '</span><span style="font-weight:500;">' + esc(e.action) + '</span></div>'; }).join('') + '</div>';
  }

  /* --- Reusable Bill of Materials questions --- */
  var QT_TYPES = [['TEXT', 'Short text'], ['LONG_TEXT', 'Paragraph'], ['NUMBER', 'Number'], ['DATE', 'Date'],
    ['SELECT', 'Dropdown — pick one'], ['MULTI_SELECT', 'Dropdown — pick several'], ['BOOLEAN', 'Yes / No']];
  var qtVendors = [];

  async function loadQuestionTemplates() {
    var box = document.getElementById('qtList'); if (!box) return;
    var rows = [];
    try {
      var r = await authed('/bom/question-templates');
      rows = r.ok ? (await r.json()) : [];
      if (!qtVendors.length) {
        var rm = await authed('/manufacturers');
        if (rm.ok) qtVendors = ((await rm.json()) || []).map(function (m) { return m.name; });
      }
    } catch (e) { box.innerHTML = '<div class="err">Could not load questions.</div>'; return; }

    var body = rows.map(function (q) {
      var typeLabel = (QT_TYPES.filter(function (t) { return t[0] === q.type; })[0] || ['', q.type])[1];
      var opts = Array.isArray(q.options) ? q.options : [];
      return '<tr' + (q.active ? '' : ' style="opacity:.55;"') + '>' +
        td('<b style="font-weight:600;">' + esc(q.label) + '</b>' +
          (q.helpText ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' + esc(q.helpText) + '</div>' : '')) +
        td(q.vendor ? esc(q.vendor) : '<span class="chip">Every vendor</span>') +
        td(esc(typeLabel) + (opts.length ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' + opts.slice(0, 4).map(esc).join(' · ') + (opts.length > 4 ? ' …' : '') + '</div>' : '')) +
        td(q.required ? '<span class="chip" style="background:#fdf6e6;color:#6b5a24;">Required</span>' : '<span class="muted">Optional</span>') +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;">' +
          '<button class="link-btn" data-qt-edit="' + q.id + '" style="width:auto;padding:6px 11px;font-size:12px;">Edit</button>' +
          '<button class="link-btn" data-qt-del="' + q.id + '" style="width:auto;padding:6px 10px;font-size:12px;color:#9c3327;">✕</button>' +
        '</div>') +
      '</tr>';
    }).join('');

    box.innerHTML = tableShell(['Question', 'Asked of', 'Answer type', '', ''], body, 5,
      'No reusable questions yet. Add one and every new Bill of Materials section will ask it.');

    box.querySelectorAll('[data-qt-edit]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        openQuestionTemplateForm(rows.filter(function (x) { return x.id === bt.getAttribute('data-qt-edit'); })[0]);
      });
    });
    box.querySelectorAll('[data-qt-del]').forEach(function (bt) {
      bt.addEventListener('click', async function () {
        if (!confirm('Remove this question?\n\nSections that already ask it keep their copy and their answers — only new sections stop asking.')) return;
        var r = await authed('/bom/question-templates/' + bt.getAttribute('data-qt-del'), { method: 'DELETE' });
        if (!r.ok) { alert('Could not remove (' + r.status + ').'); return; }
        loadQuestionTemplates();
      });
    });
  }

  function openQuestionTemplateForm(q) {
    q = q || {};
    var opts = Array.isArray(q.options) ? q.options.join('\n') : '';
    var isChoice = q.type === 'SELECT' || q.type === 'MULTI_SELECT';
    openModal(q.id ? 'Edit question' : 'New vendor question',
      fieldRow('Question', '<input id="qtLabel" style="' + IN + '" value="' + esc(q.label || '') + '" placeholder="e.g. What gauge steel?">') +
      fieldRow('Asked of', '<select id="qtVendor" style="' + IN + '"><option value="">Every vendor</option>' +
        qtVendors.map(function (v) { return '<option value="' + esc(v) + '"' + (q.vendor === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') +
        '</select>') +
      fieldRow('Answer type', '<select id="qtType" style="' + IN + '">' +
        QT_TYPES.map(function (t) { return '<option value="' + t[0] + '"' + (q.type === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select>') +
      '<div id="qtOptWrap" style="display:' + (isChoice ? 'block' : 'none') + ';">' +
        fieldRow('Options', '<textarea id="qtOpts" rows="4" placeholder="One per line" style="' + IN + 'resize:vertical;">' + esc(opts) + '</textarea>') +
      '</div>' +
      fieldRow('Help text', '<input id="qtHelp" style="' + IN + '" value="' + esc(q.helpText || '') + '" placeholder="Optional — shown under the question">') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:4px;"><input type="checkbox" id="qtReq"' + (q.required ? ' checked' : '') + '> Required — blocks the section from being confirmed until answered</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-top:6px;"><input type="checkbox" id="qtActive"' + (q.id ? (q.active !== false ? ' checked' : '') : ' checked') + '> Active — asked on new sections</label>',
      async function (close, showErr) {
        var type = document.getElementById('qtType').value;
        var label = document.getElementById('qtLabel').value.trim();
        if (!label) return showErr('Type the question.');
        var list = document.getElementById('qtOpts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        if ((type === 'SELECT' || type === 'MULTI_SELECT') && !list.length) return showErr('A dropdown needs at least one option.');
        var payload = {
          label: label,
          vendor: document.getElementById('qtVendor').value || null,
          type: type,
          options: list,
          helpText: document.getElementById('qtHelp').value.trim(),
          required: document.getElementById('qtReq').checked,
          active: document.getElementById('qtActive').checked,
        };
        var r = q.id
          ? await authed('/bom/question-templates/' + q.id, { method: 'PATCH', body: payload })
          : await authed('/bom/question-templates', { method: 'POST', body: payload });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not save.'); }
        close(); loadQuestionTemplates();
      }, q.id ? 'Save' : 'Add question');
    var t = document.getElementById('qtType');
    t.addEventListener('change', function () {
      document.getElementById('qtOptWrap').style.display = (t.value === 'SELECT' || t.value === 'MULTI_SELECT') ? 'block' : 'none';
    });
  }

  async function loadFinancingAdmin() {
    var box = document.getElementById('finAdmin'); if (!box) return;
    var d = null;
    try { var r = await authed('/admin/financing'); if (r.ok) d = await r.json(); } catch (e) {}
    if (!d) { box.innerHTML = '<div class="err">Could not load financing settings.</div>'; return; }

    var factorRows = d.factors.map(function (f) {
      // A factor is shown at six decimals because that is the precision the lessor
      // publishes; rounding it would move a payment by real dollars.
      return '<tr>' +
        td('<b style="font-weight:600;">' + f.termMonths + ' months</b>') +
        td('<input class="finFactor" data-term="' + f.termMonths + '" type="number" step="0.000001" min="0.0001" max="1" value="' + Number(f.factor).toFixed(6) + '" style="width:130px;padding:7px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;">') +
        td('<span class="muted" style="font-size:12.5px;">$100,000 → <b style="color:#20241f;">$' + Math.round(100000 * f.factor).toLocaleString() + '</b>/mo</span>') +
        td('<label style="display:flex;gap:6px;align-items:center;font-size:12.5px;cursor:pointer;"><input type="checkbox" class="finActive" data-term="' + f.termMonths + '"' + (f.active ? ' checked' : '') + '> Offered</label>') +
        '</tr>';
    }).join('');

    var settingRows = d.settings.map(function (s) {
      return '<div style="margin-bottom:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
          '<div><div style="font-size:13.5px;font-weight:600;">' + esc(s.label) + '</div>' +
            '<div class="muted" style="font-size:12px;line-height:1.5;max-width:560px;margin-top:2px;">' + esc(s.help) + '</div></div>' +
          '<input class="finSetting" data-key="' + s.key + '" type="number" step="' + s.step + '" min="' + s.min + '" max="' + s.max + '" value="' + s.value + '" style="width:140px;padding:7px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;text-align:right;">' +
        '</div></div>';
    }).join('');

    box.innerHTML =
      tableShell(['Term', 'Payment factor', 'Example', 'Offered'], factorRows, 4, '') +
      '<div style="margin-top:18px;padding:14px 16px;background:#fbfbf9;border:1px solid #e7e8e3;border-radius:10px;">' + settingRows + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:10px;">Financing enquiries are sent to <b>' + esc(d.partnerEmail) + '</b>.</div>';

    var save = async function (el, path, body) {
      el.style.borderColor = '#c9a227';
      var r = await authed(path, { method: 'PUT', body: body });
      el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
      if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save.'); }
      setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
    };
    document.querySelectorAll('.finFactor').forEach(function (el) {
      el.addEventListener('change', function () {
        save(el, '/admin/financing/factors/' + el.getAttribute('data-term'), { factor: Number(el.value) }).then(loadFinancingAdmin);
      });
    });
    document.querySelectorAll('.finActive').forEach(function (el) {
      el.addEventListener('change', function () {
        authed('/admin/financing/factors/' + el.getAttribute('data-term'), { method: 'PUT', body: { active: el.checked } });
      });
    });
    document.querySelectorAll('.finSetting').forEach(function (el) {
      el.addEventListener('change', function () {
        save(el, '/admin/financing/settings/' + el.getAttribute('data-key'), { value: Number(el.value) });
      });
    });
  }

  /* --- Ryan Capital financing ---
   * Computed entirely from the proposal total: there is no document to create and
   * nothing to fill in. Payments come from the lessor's published payment factors,
   * editable under Administration → Financing. */
  var finCache = null;
  async function loadFinancing(p, user) {
    var box = document.getElementById('finBox'); if (!box) return;
    var d = null;
    try { var r = await authed('/proposals/' + p.id + '/financing'); if (r.ok) d = await r.json(); } catch (e) {}
    finCache = d;
    if (!d) { box.innerHTML = '<div class="placeholder" style="padding:18px;"><p class="muted" style="margin:0;">No released version to quote from yet.</p></div>'; return; }
    var q = d.quote, s = q.section179;
    var m0 = function (x) { return '$' + Math.round(Number(x || 0) / 100).toLocaleString(); };
    var lowest = q.terms.reduce(function (a2, b) { return b.monthlyPaymentMinor < a2.monthlyPaymentMinor ? b : a2; }, q.terms[0]);

    box.innerHTML =
      '<div class="muted" style="font-size:12.5px;margin:-4px 0 12px;line-height:1.55;">Calculated from the ' + fmtMoney(d.proposal.grandTotalMinor) + ' project total. Nothing to fill in — the sheet is generated on demand.</div>' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:14px;">' +
        q.terms.map(function (t) {
          var best = t.termMonths === lowest.termMonths;
          return '<div style="flex:1;min-width:112px;border:1px solid ' + (best ? '#c9a227' : '#e7e8e3') + ';border-radius:11px;padding:12px 11px;background:' + (best ? '#fdfaf0' : '#fff') + ';text-align:center;">' +
            '<div class="k" style="margin:0;">' + t.termMonths + ' months</div>' +
            '<div style="font-family:Georgia,serif;font-size:19px;font-weight:700;margin:5px 0 1px;">' + m0(t.monthlyPaymentMinor) + '</div>' +
            '<div class="muted" style="font-size:11px;">per month</div>' +
            '<div class="muted" style="font-size:11px;margin-top:7px;padding-top:7px;border-top:1px solid #eceee8;">' + m0(t.totalOfPaymentsMinor) + ' total</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;padding:12px 14px;background:#fbfbf9;border:1px solid #e7e8e3;border-radius:10px;margin-bottom:14px;">' +
        '<div><div class="k">Section 179 deduction</div><div class="v small">' + fmtMoney(s.deductionMinor) + '</div></div>' +
        '<div><div class="k">Estimated savings at ' + s.taxRatePct + '%</div><div class="v small" style="color:#2f6b4f;">' + fmtMoney(s.estimatedSavingsMinor) + '</div></div>' +
        '<div><div class="k">Net cost</div><div class="v small">' + fmtMoney(s.netCostMinor) + '</div></div>' +
        (s.exceedsCap ? '<div class="muted" style="font-size:11.5px;align-self:center;max-width:230px;">Above the ' + m0(s.capMinor) + ' cap — the excess may still be depreciated.</div>' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="link-btn" id="finPreview" style="width:auto;padding:9px 15px;">Preview the sheet</button>' +
        '<button class="link-btn" id="finPdf" style="width:auto;padding:9px 15px;">Download PDF</button>' +
        (hasRole(PROP_WRITE, user.role)
          ? '<button class="link-btn" id="finSendCust" style="width:auto;padding:9px 15px;">Send to the customer</button>' +
            '<button class="btn" id="finSend" style="width:auto;padding:9px 15px;">Send to Ryan Capital</button>'
          : '') +
      '</div>';

    document.getElementById('finPreview').addEventListener('click', async function () {
      var r = await authed('/proposals/' + p.id + '/financing.html');
      if (!r.ok) { alert('Could not build the sheet.'); return; }
      var w = window.open('', '_blank');
      w.document.write(await r.text()); w.document.close();
    });
    document.getElementById('finPdf').addEventListener('click', async function () {
      var bt = this; bt.disabled = true; bt.textContent = 'Rendering…';
      try {
        var r = await authed('/render/proposals/' + p.id + '/financing.pdf');
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not render the PDF.'); }
        else downloadBlob(await r.blob(), d.proposal.number + '-financing.pdf');
      } catch (e) { alert('Could not reach the renderer.'); }
      bt.disabled = false; bt.textContent = 'Download PDF';
    });
    var sb = document.getElementById('finSend');
    if (sb) sb.addEventListener('click', function () { openSendDocuments(p, d, 'partner'); });
    var sc = document.getElementById('finSendCust');
    // Financing only, to the customer — the "they asked about payments" case, weeks
    // after the proposal already went out.
    if (sc) sc.addEventListener('click', function () { openSendDocuments(p, d, 'financing'); });
  }

  /**
   * One dialog for sending the customer's documents.
   *
   * Both jobs live here on purpose: "proposal and financing together" and "financing
   * on its own, weeks later, because they asked" are the same act with different
   * boxes ticked. Two separate flows would drift, and one would become the neglected
   * one that nobody trusts.
   *
   * `preset` chooses what it opens with — 'customer', 'financing' (customer, sheet
   * only) or 'partner' (Ryan Capital).
   */
  async function openSendDocuments(p, fin, preset) {
    var ctx = { contacts: [], partnerEmail: 'ckinsey@ryancapital.com', history: [] };
    try { var rc = await authed('/proposals/' + p.id + '/send-context'); if (rc.ok) ctx = await rc.json(); } catch (e) {}

    var toPartner = preset === 'partner';
    var wantProposal = preset !== 'financing';
    var wantFinancing = preset === 'financing' || preset === 'partner';
    var hasFinancing = !!(fin && fin.quote && fin.quote.terms && fin.quote.terms.length);
    var dm = ctx.contacts.filter(function (c) { return c.isDecisionMaker; })[0] || ctx.contacts[0];
    var defaultTo = toPartner ? ctx.partnerEmail : (dm ? dm.email : '');

    // Past sends, newest first. Without this someone re-sends a proposal the customer
    // already has, or hesitates to send one they never got.
    var histHtml = (ctx.history || []).length
      ? '<div style="margin-top:14px;padding-top:12px;border-top:1px solid #e7e8e3;">' +
          '<div class="k" style="margin-bottom:6px;">Already sent</div>' +
          ctx.history.slice(0, 5).map(function (h) {
            var det = h.details || {};
            var who = Array.isArray(det.to) ? det.to.join(', ') : (det.to || '');
            var docs = Array.isArray(det.documents) ? det.documents.length + ' file' + (det.documents.length === 1 ? '' : 's') : 'financing sheet';
            return '<div style="font-size:12px;color:' + (h.failed ? '#9c3327' : '#5c6157') + ';line-height:1.6;">' +
              (h.failed ? '✕ Failed — ' : '✓ ') + esc(docs) + ' to ' + esc(who) +
              ' · ' + fmtDate(h.at) + (h.by ? ' · ' + esc(h.by) : '') + '</div>';
          }).join('') +
        '</div>'
      : '';

    var contactChips = ctx.contacts.length
      ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;">' +
          ctx.contacts.map(function (c) {
            return '<button type="button" class="sdWho link-btn" data-email="' + esc(c.email) + '" style="width:auto;padding:5px 10px;font-size:12px;">' +
              esc(c.name || c.email) + (c.isDecisionMaker ? ' ★' : '') + '</button>';
          }).join('') +
          '<button type="button" class="sdWho link-btn" data-email="' + esc(ctx.partnerEmail) + '" style="width:auto;padding:5px 10px;font-size:12px;">Ryan Capital</button>' +
        '</div>'
      : '';

    var check = function (id, on, label, note, disabled) {
      return '<label style="display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border:1px solid #e7e8e3;border-radius:9px;background:' + (disabled ? '#f4f5f1' : '#fff') + ';' + (disabled ? 'opacity:.6;' : 'cursor:pointer;') + '">' +
        '<input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + ' style="margin-top:2px;">' +
        '<span><b style="font-weight:600;font-size:13px;">' + label + '</b>' +
        '<div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:1px;">' + note + '</div></span></label>';
    };

    openModal('Send documents',
      '<div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.55;">' +
        'Attaches the documents as PDFs. Replies come back to your orders inbox.</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' +
        check('sdProp', wantProposal, 'Proposal', 'The customer document, exactly as the preview shows it.') +
        check('sdFin', wantFinancing && hasFinancing, 'Financing options',
          hasFinancing ? 'Monthly payments and the Section 179 position, calculated from this proposal.' : 'Not available until the proposal has a saved price.',
          !hasFinancing) +
      '</div>' +
      fieldRow('To', '<input id="sdTo" value="' + esc(defaultTo) + '" placeholder="name@company.com" style="' + IN + '">' + contactChips) +
      fieldRow('Cc', '<input id="sdCc" placeholder="Optional — comma separated" style="' + IN + '">') +
      fieldRow('Subject', '<input id="sdSubject" placeholder="Leave blank for the default" style="' + IN + '">') +
      fieldRow('Message', '<textarea id="sdMsg" rows="5" placeholder="Leave blank for a short default note" style="' + IN + 'resize:vertical;"></textarea>') +
      histHtml,
      async function (close, showErr) {
        var wantP = document.getElementById('sdProp').checked;
        var wantF = document.getElementById('sdFin').checked;
        if (!wantP && !wantF) return showErr('Choose at least one document to send.');
        var to = document.getElementById('sdTo').value.trim();
        if (!to) return showErr('Give a recipient.');

        var body = {
          to: to,
          cc: document.getElementById('sdCc').value.trim(),
          subject: document.getElementById('sdSubject').value.trim(),
          message: document.getElementById('sdMsg').value,
          includeProposal: wantP,
          includeFinancing: wantF,
        };

        // The proposal PDF is rendered from the markup the browser already builds for
        // the preview, so the customer receives the document they were shown.
        if (wantP) {
          var doc = await buildProposalDocForSend(p);
          if (!doc) return showErr('Could not prepare the proposal. Open the proposal preview once, then try again.');
          body.proposalHtml = doc.html;
          body.proposalFilename = doc.filename;
        }

        var r = await authed('/proposals/' + p.id + '/send-documents', { method: 'POST', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not send.'); }
        var out = await r.json();
        close();
        alert('Sent to ' + out.to.join(', ') + ':\n' + out.documents.join('\n'));
      }, 'Send');

    document.querySelectorAll('.sdWho').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.getElementById('sdTo');
        var cur = el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        var em = b.getAttribute('data-email');
        // Toggle rather than replace: sending to two people at a customer is normal.
        if (cur.indexOf(em) === -1) cur.push(em); else cur = cur.filter(function (x) { return x !== em; });
        el.value = cur.join(', ');
      });
    });
  }

  /**
   * Build the proposal document for sending: load the current version, assemble the
   * same markup the preview uses, and wrap it to stand alone.
   */
  async function buildProposalDocForSend(p, versionId) {
    try {
      var rv = await authed('/proposals/' + p.id);
      if (!rv.ok) return null;
      var full = await rv.json();
      var versions = (full.versions || []).slice().sort(function (x, y) { return y.version - x.version; });
      var v = versionId ? (versions.filter(function (x) { return x.id === versionId; })[0] || versions[0]) : versions[0];
      if (!v) return null;
      var doc = await proposalDocData(full, v);
      return { html: proposalStandaloneHtml(doc), filename: proposalFileName(doc) };
    } catch (e) { return null; }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* --- Admin --- */
  async function renderAdmin(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:16px;">' +
        '<button class="link-btn" id="admMailTest" style="width:auto;padding:10px 15px;">Send test email</button>' +
        '<button class="btn" id="admNew" style="width:auto;padding:10px 17px;">New user</button></div>' +
      '<div id="admList"><div class="muted" style="padding:24px;">Loading…</div></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:26px;"><div class="section-title" style="margin:0;">Standard proposal notes</div>' +
        '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;">+ New note</button></div>' +
      '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;">Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically, and a note can name the parts that pull it in. Table notes print inside the line items; footer notes print below the signature lines. Also editable under Catalog → Proposal notes.</div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
      '<div class="section-title" style="margin-top:26px;">Formulas</div>' +
      '<div class="muted" style="font-size:12.5px;margin:0 0 10px;">Every calculation the pricing engine runs. Frame and hardware quantities are editable coefficients; business numbers are the scalars the proposal math uses; the last tab lists what is fixed in code and why.</div>' +
      '<div id="fxTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;"></div>' +
      // The log sits beside the formulas, not behind a tab: the question it answers
      // is "what does this rule say now versus what it said before", and that needs
      // both on screen at once.
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start;">' +
        '<div id="fxBody"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<aside id="fxLog" style="position:sticky;top:16px;"></aside>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:26px;"><div class="section-title" style="margin:0;">Vendor questions</div>' +
        '<button class="btn" id="qtNew" style="width:auto;padding:9px 15px;">+ New question</button></div>' +
      '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;">Questions asked on a Bill of Materials section. A question with no vendor is asked of <b>every</b> vendor; one with a vendor is asked only of theirs. Each new section starts with a copy, so editing a question here never rewrites an answer already given on an order.</div>' +
      '<div id="qtList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
      '<div class="section-title" style="margin-top:26px;">Financing</div>' +
      '<div class="muted" style="font-size:12.5px;margin:0 0 10px;">Ryan Capital quotes from a <b>payment factor</b> per term, not an interest rate: the monthly payment is the amount financed × the factor. Change a factor here and every financing sheet uses it immediately.</div>' +
      '<div id="finAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>';
    document.getElementById('admNew').addEventListener('click', openUserForm);
    document.getElementById('admMailTest').addEventListener('click', async function () {
      var bt = this, label = bt.textContent;
      bt.disabled = true; bt.textContent = 'Sending…';
      try {
        var r = await authed('/admin/email/test', { method: 'POST', body: {} });
        var d = null; try { d = await r.json(); } catch (e) {}
        if (r.ok && d && d.sent) alert('Sent to ' + d.to + '\nFrom: ' + d.from + '\nReply-to: ' + d.replyTo + '\n\nIf it does not arrive, check spam and the Resend dashboard.');
        else if (r.ok && d) alert(d.message || 'Email is not configured.');
        else alert((d && d.message) || 'Test failed (' + r.status + ').');
      } catch (e) { alert('Could not reach the server.'); }
      bt.disabled = false; bt.textContent = label;
    });
    document.getElementById('snNew').addEventListener('click', function () { openStandardNoteForm(null); });
    document.getElementById('qtNew').addEventListener('click', function () { openQuestionTemplateForm(null); });
    loadUsers();
    loadStandardNotes();
    loadFormulas();
    loadFinancingAdmin();
    loadQuestionTemplates();
  }

  async function loadStandardNotes() {
    var box = document.getElementById('snList'); if (!box) return;
    try {
      var r = await authed('/standard-notes');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load standard notes (' + r.status + '). Run the 0019 migration if this persists.</div>'; return; }
      var notes = await r.json();
      var rows = (notes || []).map(function (n) {
        return '<tr>' + td('<b style="font-weight:600;">' + esc(n.title) + '</b><div class="muted" style="font-size:12px;max-width:520px;line-height:1.45;">' + rt(String(n.body).slice(0, 160)) + (String(n.body).length > 160 ? '…' : '') + '</div>') +
          td(n.placement === 'FOOTER' ? '<span class="chip">Below signatures</span>' : '<span class="chip">In line items</span>') +
          td(n.autoInclude ? '<span style="display:inline-block;background:#eaf3ee;border:1px solid #cfe3d7;color:#2f7d5d;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;">Always</span>' : '<span class="muted">On request</span>') +
          td(n.active ? '<span class="chip">Active</span>' : '<span class="muted">Hidden</span>') +
          td('<div style="display:flex;gap:6px;justify-content:flex-end;"><button class="link-btn snEdit" data-id="' + n.id + '" style="width:auto;padding:6px 11px;">Edit</button>' +
            '<button class="link-btn snDel" data-id="' + n.id + '" style="width:auto;padding:6px 11px;color:#9c3327;">Delete</button></div>') + '</tr>';
      }).join('');
      box.innerHTML = tableShell(['Note', 'Prints', 'Include', 'Status', ''], rows, 5, 'No standard notes yet.');
      box.querySelectorAll('.snEdit').forEach(function (b) {
        b.addEventListener('click', function () { openStandardNoteForm((notes || []).filter(function (n) { return n.id === b.getAttribute('data-id'); })[0]); });
      });
      box.querySelectorAll('.snDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Delete this standard note?')) return;
          var rr = await authed('/standard-notes/' + b.getAttribute('data-id'), { method: 'DELETE' });
          if (!rr.ok && rr.status !== 204) { alert('Could not delete (' + rr.status + ').'); return; }
          loadStandardNotes();
        });
      });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  function openStandardNoteForm(note) {
    var n = note || { title: '', body: '', placement: 'TABLE', autoInclude: false, sortOrder: 0, active: true, triggerParts: '', condition: null };
    openModal(note ? 'Edit standard note' : 'New standard note',
      fieldRow('Title', '<input id="snTitle" style="' + IN + '" value="' + esc(n.title) + '">') +
      richTextField('snBody', 'Note text', n.body, 'Line breaks are kept. Bold and italic print on the customer proposal.') +
      fieldRow('Where it prints', '<select id="snPlace" style="' + IN + '"><option value="TABLE"' + (n.placement === 'TABLE' ? ' selected' : '') + '>Inside the line items</option><option value="FOOTER"' + (n.placement === 'FOOTER' ? ' selected' : '') + '>Below the signature lines</option></select>') +
      fieldRow('Order', '<input id="snOrder" type="number" style="' + IN + '" value="' + (Number(n.sortOrder) || 0) + '">') +
      fieldRow('When it applies',
        '<select id="snCond" style="' + IN + '">' +
          '<option value=""' + (!n.condition ? ' selected' : '') + '>Always</option>' +
          '<option value="DEPOSIT_SHOWN"' + (n.condition === 'DEPOSIT_SHOWN' ? ' selected' : '') + '>Only when the deposit is shown on the proposal</option>' +
          '<option value="DEPOSIT_HIDDEN"' + (n.condition === 'DEPOSIT_HIDDEN' ? ' selected' : '') + '>Only when the deposit is NOT shown</option>' +
        '</select>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Write the two versions of a paragraph as two notes, one for each case, and tick “always include” on both. Unticking the deposit on a proposal then swaps the wording rather than leaving a note that contradicts the totals.</div>') +
      fieldRow('Add this note when these parts are on the proposal',
        '<input id="snParts" style="' + IN + '" value="' + esc(n.triggerParts || '') + '" placeholder="SSUSP67, SSCW67, SSUSP72">' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.5;">Part numbers, comma separated. The note is added once, at the end of the section the part is in, and can still be deleted from a proposal. Leave blank for a note that is always included or picked by hand.</div>') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;cursor:pointer;"><input type="checkbox" id="snAuto"' + (n.autoInclude ? ' checked' : '') + '> Always include on new proposals</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="snActive"' + (n.active !== false ? ' checked' : '') + '> Available in the builder</label>',
      async function (close, showErr) {
        var body = {
          title: document.getElementById('snTitle').value.trim(),
          body: readRichText('snBody'),
          placement: document.getElementById('snPlace').value,
          sortOrder: Number(document.getElementById('snOrder').value) || 0,
          triggerParts: document.getElementById('snParts').value.trim(),
          condition: document.getElementById('snCond').value || null,
          autoInclude: document.getElementById('snAuto').checked,
          active: document.getElementById('snActive').checked,
        };
        if (!body.title || !body.body) return showErr('Title and note text are both required.');
        var r = note
          ? await authed('/standard-notes/' + note.id, { method: 'PATCH', body: body })
          : await authed('/standard-notes', { method: 'POST', body: body });
        if (!r.ok) return showErr('Could not save (' + r.status + ').');
        close(); loadStandardNotes();
      }, note ? 'Save changes' : 'Create note');
    wireRichText('snBody');
  }

  /* --- Formulas: every editable calculation in the engine --- */
  var fx = { data: null, tab: 'frame' };
  /** Undo is the one formula action held tighter than the edit it reverses. */
  function isSystemAdmin() { return !!(currentUser && currentUser.role === 'SYSTEM_ADMIN'); }
  var FX_TABS = [
    { id: 'frame', label: 'Frame & components' },
    { id: 'hardware', label: 'Hardware fasteners' },
    { id: 'settings', label: 'Business numbers' },
    { id: 'paint', label: 'Paint colour' },
    { id: 'vendorparts', label: 'Vendor part numbers' },
    { id: 'code', label: 'Fixed in code' },
  ];
  /** The chart, loaded on demand — only the Paint colour tab reads it. */
  var fxPaint = { data: null, loading: false };
  function fxSet(kind) { return fx.data ? fx.data[kind] : null; }
  function fxInputs(kind) { var set = fxSet(kind); return (set && set.inputs) || []; }
  function fxSourceLabel(kind, src) {
    if (!src) return '';
    if (src.indexOf('in:') === 0 || src.indexOf('flag:') === 0) {
      var k = src.slice(src.indexOf(':') + 1);
      var f = fxInputs(kind).filter(function (i) { return i.key === k; })[0];
      return f ? f.label : k;
    }
    return src.slice(src.indexOf(':') + 1);
  }
  function fxCondText(kind, c) {
    if (!c) return '';
    var lbl = fxSourceLabel(kind, 'in:' + c.input) || c.input;
    if (c.value === true) return 'when ' + lbl;
    if (c.value === false) return 'when not ' + lbl;
    return 'when ' + lbl + ' ' + c.op + ' ' + c.value;
  }
  function fxFormulaText(kind, r) {
    if (!r.active) return r.note || 'switched off — always 0';
    var body = (r.terms || []).map(function (t, i) {
      var sign = t.coefficient < 0 ? ' − ' : (i ? ' + ' : '');
      var mag = Math.abs(t.coefficient);
      var base = t.source ? fxSourceLabel(kind, t.source) + (mag === 1 ? '' : ' × ' + mag) : String(mag);
      return sign + base + (t.when ? ' (' + fxCondText(kind, t.when) + ')' : '');
    }).join('') || '0';
    if (r.mode === 'PRESENCE') body = '(' + body + ') > 0 ? ' + r.constant + ' : 0';
    else {
      if (r.constant) body += (r.constant < 0 ? ' − ' : ' + ') + Math.abs(r.constant);
      if (Number(r.factor) !== 1) body = '(' + body + ') × ' + r.factor;
      if (r.roundMode === 'CEIL') body = 'ceil(' + body + (Number(r.roundStep) > 1 ? ', step ' + r.roundStep : '') + ')';
      else if (r.roundMode === 'ROUND') body = 'round(' + body + (Number(r.roundStep) > 1 ? ', step ' + r.roundStep : '') + ')';
    }
    return body + (r.when ? '  —  only ' + fxCondText(kind, r.when) : '');
  }
  async function loadFormulas() {
    var box = document.getElementById('fxBody'); if (!box) return;
    box.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
    try {
      var r = await authed('/formulas');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load formulas (' + r.status + '). Run the 0021 migration if this persists.</div>'; return; }
      fx.data = await r.json();
      drawFormulas();
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  function drawFxTabs() {
    var box = document.getElementById('fxTabs'); if (!box) return;
    box.innerHTML = FX_TABS.map(function (t) {
      var on = fx.tab === t.id;
      var count = fx.data && fx.data[t.id] && fx.data[t.id].rules ? fx.data[t.id].rules.length : 0;
      return '<button data-fxt="' + t.id + '" style="border:1px solid ' + (on ? '#3d4a55' : '#dcded7') + ';background:' + (on ? '#3d4a55' : '#fff') + ';color:' + (on ? '#fff' : '#3d4a55') + ';border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;">' + esc(t.label) + (count ? ' <span style="opacity:.65;">' + count + '</span>' : '') + '</button>';
    }).join('');
    box.querySelectorAll('[data-fxt]').forEach(function (b) {
      b.addEventListener('click', function () { fx.tab = b.getAttribute('data-fxt'); drawFxTabs(); drawFormulas(); });
    });
  }
/**
   * The typed confirmation every formula write goes through.
   *
   * One window, not two: it states what is about to change, lists the open orders
   * built on the current figures (read from the server, so the warning and the
   * recorded impact are the same list), and enables Save only once the word has
   * been typed. Resolves the typed word, or null when it is cancelled — Escape and
   * a click on the backdrop both cancel and send nothing. The server enforces the
   * same rule, so this is the courtesy, not the lock.
   */
  function fxConfirmChange(opts) {
    var word = (fx.data && fx.data.confirmWord) || 'CONFIRMED';
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(30,34,30,.45);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px;';
      var card = document.createElement('div');
      card.style.cssText = 'background:#fff;border:1px solid #dcded7;border-radius:14px;max-width:560px;width:100%;padding:22px 24px;box-shadow:0 18px 50px rgba(0,0,0,.18);max-height:88vh;overflow:auto;';
      wrap.appendChild(card);
      document.body.appendChild(wrap);
      function done(v) { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(null); }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) done(null); });

      var rows = (opts.changes || []).map(function (c) {
        return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:8px 0;border-top:1px solid #f2f3ef;font-size:13.5px;">' +
          '<span>' + esc(String(c.label)) + '</span>' +
          '<span style="font-family:ui-monospace,monospace;font-size:12.5px;white-space:nowrap;">' +
            '<span style="color:#8a8f85;text-decoration:line-through;">' + esc(String(c.from)) + '</span>' +
            ' &rarr; <b style="color:#9c3327;">' + esc(String(c.to)) + '</b>' +
            ' <span class="muted">' + esc(String(c.unit || '')) + '</span></span></div>';
      }).join('');

      card.innerHTML =
        '<div style="font-family:\'Newsreader\',serif;font-size:19px;font-weight:600;color:#3d4a55;">Type ' + esc(word) + ' to ' + esc(opts.what) + '</div>' +
        '<div class="muted" style="font-size:13px;line-height:1.6;margin-top:8px;">New proposals use the new figure. Proposals already accepted keep what they were signed with; drafts re-price the next time they are opened. The change is recorded against your name and can be undone from the revision log.</div>' +
        (rows ? '<div style="margin:14px 0 2px;">' + rows + '</div>' : '') +
        '<div id="fxcImpact" class="muted" style="font-size:12.5px;line-height:1.55;margin-top:14px;">Checking which open orders were built on the current figures…</div>' +
        '<input id="fxcWord" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' + esc(word) + '" style="width:100%;margin-top:14px;padding:11px 13px;border:1px solid #dcded7;border-radius:9px;font-size:15px;font-family:ui-monospace,monospace;letter-spacing:.1em;">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">' +
          '<button id="fxcCancel" style="border:1px solid #dcded7;background:#fff;border-radius:9px;padding:9px 16px;font-size:13px;color:#3d4a55;cursor:pointer;">Cancel</button>' +
          '<button id="fxcGo" disabled style="border:1px solid #dcded7;background:#eef0ea;color:#9aa093;border-radius:9px;padding:9px 16px;font-size:13px;cursor:not-allowed;">Save change</button></div>';

      // The same list the server records and emails, read before anything is written
      // so the warning and the record cannot disagree.
      (async function () {
        var el = card.querySelector('#fxcImpact');
        var qs = (opts.parts || []).map(function (p) { return 'part=' + encodeURIComponent(p); }).join('&');
        try {
          var r = await authed('/formulas/impact' + (qs ? '?' + qs : ''));
          if (!r.ok) { el.textContent = 'Could not check which open orders this affects.'; return; }
          var d = await r.json();
          var list = (d.orders || []).slice(0, 8).map(function (o) {
            return '<div style="padding:3px 0;">' + esc(o.number || '') + (o.customer ? ' · ' + esc(o.customer) : '') + '</div>';
          }).join('');
          el.innerHTML = '<b style="font-weight:600;color:' + (d.count ? '#9c3327' : '#4a4f47') + ';">' + esc(d.sentence || '') + '</b>' +
            (list ? '<div style="margin-top:6px;font-family:ui-monospace,monospace;font-size:11.5px;">' + list +
              ((d.orders || []).length > 8 ? '<div class="muted" style="padding:3px 0;">and ' + ((d.orders || []).length - 8) + ' more</div>' : '') + '</div>' : '');
        } catch (e) { el.textContent = 'Could not check which open orders this affects.'; }
      })();

      var input = card.querySelector('#fxcWord'), go = card.querySelector('#fxcGo');
      function sync() {
        var ok = input.value.trim().toUpperCase() === word.toUpperCase();
        go.disabled = !ok;
        go.style.cssText = 'border:1px solid ' + (ok ? '#9c3327' : '#dcded7') + ';background:' + (ok ? '#9c3327' : '#eef0ea') +
          ';color:' + (ok ? '#fff' : '#9aa093') + ';border-radius:9px;padding:9px 16px;font-size:13px;cursor:' + (ok ? 'pointer' : 'not-allowed') + ';';
        return ok;
      }
      input.addEventListener('input', sync);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && sync()) done(input.value.trim()); });
      card.querySelector('#fxcCancel').addEventListener('click', function () { done(null); });
      go.addEventListener('click', function () { if (!go.disabled) done(input.value.trim()); });
      input.focus();
    });
  }

  /**
   * What a write reported back. Silent on the ordinary case; speaks up when open
   * orders are affected or when the notification to the team did not go out — an
   * unsent alert is worse than no alert, so it is never swallowed.
   */
  function fxReportRevision(res) {
    var rev = res && res.revision;
    if (!rev) return;
    if (rev.notifyError) {
      alert('Saved, but the impact notification was not sent: ' + rev.notifyError);
      return;
    }
    if (rev.impactedCount) {
      var nums = (rev.impactedOrders || []).slice(0, 10).map(function (o) { return o.number; }).join(', ');
      alert('Saved. ' + rev.impactedCount + ' open order' + (rev.impactedCount === 1 ? '' : 's') +
        ' were built on the previous figures and need reviewing:\n\n' + nums +
        (rev.impactedCount > 10 ? '\n…and ' + (rev.impactedCount - 10) + ' more' : ''));
    }
  }

  /* --- Revision log -------------------------------------------------------
   * Docked beside the formulas rather than on a tab of its own, so a coefficient
   * on screen can be read against what it used to be. It scopes itself to the tab
   * being looked at; "All sets" gives the combined log.
   */
  var fxLogAll = false;
  function fxKindForTab() {
    return fx.tab === 'frame' ? 'FRAME' : fx.tab === 'hardware' ? 'HARDWARE' : fx.tab === 'settings' ? 'SETTING' : null;
  }
  async function drawRevisionLog() {
    var box = document.getElementById('fxLog'); if (!box) return;
    var kind = fxLogAll ? null : fxKindForTab();
    var head =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">' +
        '<div class="section-title" style="margin:0;">Revision log</div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#5c6157;cursor:pointer;">' +
          '<input type="checkbox" id="fxLogAll"' + (fxLogAll ? ' checked' : '') + '> All sets</label>' +
      '</div>';
    box.innerHTML = head + '<div class="card" style="padding:14px;"><div class="muted" style="font-size:12.5px;">Loading…</div></div>';
    var wireToggle = function () {
      var t = document.getElementById('fxLogAll');
      if (t) t.addEventListener('change', function () { fxLogAll = t.checked; drawRevisionLog(); });
    };

    var rows = [];
    try {
      var r = await authed('/formulas/revisions' + (kind ? '?kind=' + kind : ''));
      if (!r.ok) {
        box.innerHTML = head + '<div class="card" style="padding:14px;"><div class="muted" style="font-size:12.5px;">Could not load the log (' + r.status + ').</div></div>';
        wireToggle(); return;
      }
      rows = await r.json();
    } catch (e) {
      box.innerHTML = head + '<div class="card" style="padding:14px;"><div class="muted" style="font-size:12.5px;">Could not reach the server.</div></div>';
      wireToggle(); return;
    }

    if (!rows.length) {
      box.innerHTML = head + '<div class="card" style="padding:14px;"><div class="muted" style="font-size:12.5px;line-height:1.55;">' +
        (kind ? 'Nothing in this set has been changed yet.' : 'No formula has been changed yet.') +
        ' Every edit, reset and restore is recorded here with what it was, what it became, and which open orders it reached.</div></div>';
      wireToggle(); return;
    }

    var KIND_LABEL = { FRAME: 'Frame', HARDWARE: 'Hardware', SETTING: 'Business number' };
    box.innerHTML = head +
      '<div class="card" style="padding:0;max-height:70vh;overflow:auto;">' +
      rows.map(function (x) {
        var undone = !!x.undoneAt;
        return '<div style="padding:12px 14px;border-bottom:1px solid #f2f3ef;' + (undone ? 'opacity:.55;' : '') + '">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">' +
            '<code style="font-size:12px;color:#4a4f47;">' + esc(x.target) + '</code>' +
            '<span class="muted" style="font-size:11px;white-space:nowrap;">' + esc(KIND_LABEL[x.kind] || x.kind) + '</span>' +
          '</div>' +
          '<div style="font-size:12.5px;line-height:1.5;margin-top:4px;">' + esc(x.summary) + '</div>' +
          '<div class="muted" style="font-size:11px;margin-top:5px;">' + esc(x.actorName || '') + ' · ' + fmtDateTime(x.createdAt) +
            (x.impactedCount ? ' · <span style="color:#9c3327;">' + x.impactedCount + ' open order' + (x.impactedCount === 1 ? '' : 's') + '</span>' : '') +
            (undone ? ' · undone' + (x.undoneByName ? ' by ' + esc(x.undoneByName) : '') : '') + '</div>' +
          '<div style="display:flex;gap:10px;margin-top:6px;">' +
            '<button class="fxRevDetail" data-id="' + x.id + '" style="border:none;background:none;padding:0;font-size:11.5px;color:#3d4a55;text-decoration:underline;cursor:pointer;">Before / after</button>' +
            (x.undoable && isSystemAdmin() ? '<button class="fxRevUndo" data-id="' + x.id + '" style="border:none;background:none;padding:0;font-size:11.5px;color:#9c3327;text-decoration:underline;cursor:pointer;">Undo</button>' : '') +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    wireToggle();

    box.querySelectorAll('.fxRevDetail').forEach(function (b) {
      b.addEventListener('click', async function () {
        var rr = await authed('/formulas/revisions/' + b.getAttribute('data-id'));
        if (!rr.ok) { alert('Could not load that revision (' + rr.status + ').'); return; }
        var d = await rr.json();
        var pane = function (label, v) {
          return '<div style="flex:1;min-width:0;"><div class="k">' + label + '</div>' +
            '<pre style="margin:4px 0 0;padding:10px;background:#fbfbf9;border:1px solid #eceee8;border-radius:9px;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;">' +
            esc(v == null ? 'No override — the workbook default applied.' : JSON.stringify(v, null, 2)) + '</pre></div>';
        };
        openModal(esc(d.targetName || d.target),
          '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' + esc(d.summary) + '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;">' + pane('Before', d.before) + pane('After', d.after) + '</div>' +
          '<div class="muted" style="font-size:11.5px;margin-top:12px;">' + esc(d.actorName || '') + ' · ' + fmtDateTime(d.createdAt) +
            (d.confirmedWord ? ' · typed ' + esc(d.confirmedWord) : '') + '</div>',
          null, null);
      });
    });

    box.querySelectorAll('.fxRevUndo').forEach(function (b) {
      b.addEventListener('click', async function () {
        // One row back to what it was, not the workbook default: those are different
        // states, and only the first is what "undo" means.
        if (!confirm('Undo this change?\n\nThe value goes back to what it was immediately before this edit — not to the workbook default. The undo is itself recorded.')) return;
        var rr = await authed('/formulas/revisions/' + b.getAttribute('data-id') + '/undo', { method: 'POST', body: {} });
        if (!rr.ok) { alert(await serverMessage(rr, 'Could not undo (' + rr.status + ').')); return; }
        fxReportRevision(await rr.json());
        loadFormulas();
      });
    });
  }

  function drawFormulas() {
    var box = document.getElementById('fxBody'); if (!box || !fx.data) return;
    drawFxTabs();
    drawRevisionLog();
    if (fx.tab === 'code') {
      box.innerHTML =
        '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">These are lookups and naming conventions rather than coefficients, so they live in code. Listed here so this page is a complete inventory of the engine — tell me what should change and I will change it.</div>' +
        (fx.data.inCode || []).map(function (c) {
          return '<div class="card" style="margin-bottom:10px;"><div style="font-weight:600;font-size:14px;">' + esc(c.name) + '</div>' +
            '<div class="muted" style="font-size:12px;font-family:ui-monospace,monospace;margin-top:2px;">' + esc(c.where) + '</div>' +
            '<div style="font-size:13px;line-height:1.55;margin-top:6px;">' + esc(c.what) + '</div>' +
            '<div class="muted" style="font-size:12.5px;line-height:1.5;margin-top:4px;">Why it is not a setting: ' + esc(c.why) + '</div></div>';
        }).join('');
      return;
    }
    if (fx.tab === 'paint') {
      drawPaintColors();
      return;
    }
    if (fx.tab === 'vendorparts') {
      drawVendorPartsTab();
      return;
    }
    if (fx.tab === 'settings') {
      var st = fx.data.settings || { values: {}, defs: [], defaults: {} };
      var groups = [];
      st.defs.forEach(function (d) { if (groups.indexOf(d.group) === -1) groups.push(d.group); });
      box.innerHTML =
        '<div class="muted" style="font-size:12.5px;margin-bottom:12px;">The business numbers the proposal math uses. Changing one affects new proposals; documents already saved keep their own figures. Saving asks you to type ' + esc((fx.data && fx.data.confirmWord) || 'CONFIRMED') + ' and lists the open orders built on the current figures.</div>' +
        groups.map(function (g) {
          return '<div class="card" style="margin-bottom:12px;"><div class="section-title" style="margin:0 0 10px;">' + esc(g) + '</div>' +
            st.defs.filter(function (d) { return d.group === g; }).map(function (d) {
              var v = st.values[d.key];
              var changed = Number(v) !== Number(st.defaults[d.key]);
              return '<div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-top:1px solid #f2f3ef;">' +
                '<div style="flex:1;"><div style="font-size:13.5px;font-weight:600;">' + esc(d.label) +
                  (changed ? ' <span style="background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;">changed from ' + st.defaults[d.key] + '</span>' : '') +
                  (d.confirm ? ' <span title="Feeds the price of every Adventure mat quoted from now on" style="background:#fbf0ee;border:1px solid #e6cbc6;color:#9c3327;border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;">affects mat pricing</span>' : '') + '</div>' +
                  '<div class="muted" style="font-size:12px;line-height:1.5;margin-top:2px;">' + esc(d.help) + '</div></div>' +
                '<div style="display:flex;align-items:center;gap:6px;flex:0 0 auto;">' +
                  '<input class="fxSet" data-k="' + d.key + '" type="number" min="' + d.min + '" max="' + d.max + '" step="' + d.step + '" value="' + esc(v) + '" style="width:92px;padding:7px 9px;border:1px solid #dcded7;border-radius:8px;text-align:right;font-size:13.5px;">' +
                  '<span class="muted" style="font-size:12px;min-width:34px;">' + esc(d.unit) + '</span></div></div>';
            }).join('') + '</div>';
        }).join('') +
        '<div style="display:flex;gap:8px;align-items:center;"><button class="btn" id="fxSaveSet" style="width:auto;padding:10px 18px;">Save business numbers</button>' +
          '<span id="fxSetMsg" class="muted" style="font-size:12.5px;"></span></div>';
      document.getElementById('fxSaveSet').addEventListener('click', async function () {
        var body = {};
        document.querySelectorAll('.fxSet').forEach(function (el) { body[el.getAttribute('data-k')] = Number(el.value); });
        var msg = document.getElementById('fxSetMsg');
        // Numbers flagged `confirm` server-side (mat pricing) need the two-window typed
        // confirmation, but only when the value has actually moved — saving the panel
        // with the mat rates untouched goes straight through.
        var moved = (st.defs || []).filter(function (d) {
          return body[d.key] !== undefined && Number(body[d.key]) !== Number(st.values[d.key]);
        }).map(function (d) {
          return { label: d.label, from: st.values[d.key], to: body[d.key], unit: d.unit };
        });
        if (!moved.length) { msg.textContent = 'Nothing changed.'; return; }
        var word = await fxConfirmChange({
          what: 'change ' + moved.map(function (g) { return g.label; }).join(', '),
          changes: moved,
          parts: [],
        });
        if (!word) { msg.textContent = 'Cancelled — nothing was saved.'; return; }
        body.confirm = word;
        msg.textContent = 'Saving…';
        var r = await authed('/formulas/settings', { method: 'PATCH', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} msg.textContent = m || 'Could not save (' + r.status + ').'; return; }
        var savedSettings = await r.json();
        fxReportRevision(savedSettings);
        delete savedSettings.revision;
        fx.data.settings.values = savedSettings;
        // The configurator reads these through the shared fxSettings object, loaded
        // once at sign-in. Without this the number saves, the screen shows the new
        // value, and the leg count keeps using the old one until a hard refresh.
        Object.keys(fx.data.settings.values).forEach(function (k) {
          fxSettings[k] = Number(fx.data.settings.values[k]);
        });
        msg.textContent = 'Saved.';
        drawFormulas();
      });
      return;
    }
    // rule sets: frame or hardware
    var kind = fx.tab;
    var set = fxSet(kind);
    var over = set.overriddenParts || [];
    var lastGroup = null;
    var rows = (set.rules || []).map(function (rl) {
      var edited = over.indexOf(rl.part) !== -1;
      var head = '';
      if (kind === 'frame' && rl.group && rl.group !== lastGroup) {
        lastGroup = rl.group;
        head = '<tr><td colspan="4" style="padding:9px 14px 5px;background:#f7f8f4;border-bottom:1px solid #e7e8e3;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#3d4a55;">' + esc(rl.group) + '</td></tr>';
      }
      return head + '<tr' + (rl.active ? '' : ' style="opacity:.6;"') + '>' +
        td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(rl.part) + '</code>' + (edited ? '<div><span style="display:inline-block;margin-top:3px;background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600;">Edited</span></div>' : '')) +
        td('<span style="font-size:13px;">' + esc(rl.name) + '</span>') +
        td('<span style="font-size:12.5px;color:#4a4f47;font-family:ui-monospace,monospace;line-height:1.45;">' + esc(fxFormulaText(kind, rl)) + '</span>') +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;"><button class="fxEdit" data-part="' + esc(rl.part) + '" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;color:#3d4a55;cursor:pointer;">Edit</button>' +
          (edited ? '<button class="fxRevert" data-part="' + esc(rl.part) + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;color:#9c3327;cursor:pointer;">Reset</button>' : '') + '</div>') + '</tr>';
    }).join('');
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
        '<div class="muted" style="font-size:12.5px;max-width:760px;line-height:1.55;">' + esc(set.blurb || '') + ' Quantities stay formula-driven — these are the numbers each formula multiplies by. Rows you have changed are badged <b>Edited</b> and can be reset individually.</div>' +
        '<div style="display:flex;gap:8px;white-space:nowrap;">' +
          '<button class="link-btn" id="fxNewRule" style="width:auto;padding:8px 14px;">+ New rule</button>' +
          '<button class="link-btn" id="fxResetKind" style="width:auto;padding:8px 14px;">Restore workbook defaults</button></div>' +
      '</div>' +
      tableShell(['Part #', 'Item', 'Quantity formula', ''], rows, 4, 'No rules.');
    document.getElementById('fxNewRule').addEventListener('click', function () {
      var part = (prompt('Part number for the new quantity rule (e.g. 6820H-LP-ZP):') || '').trim();
      if (!part) return;
      if ((set.rules || []).some(function (x) { return x.part === part; })) { alert('That part already has a rule — edit it in the list.'); return; }
      openFormulaForm(kind, {
        part: part, name: part, terms: [], constant: 0, factor: 1, roundMode: 'NONE', roundStep: 1,
        mode: 'SUM', minZero: true, active: true, when: null, group: kind === 'frame' ? 'Zip line' : 'Hardware',
      });
    });
    document.getElementById('fxResetKind').addEventListener('click', async function () {
      var word = await fxConfirmChange({
        what: 'restore the workbook defaults for ' + (set.label || kind),
        // A blanket restore is not part-specific, so its reach is every open order.
        parts: [],
      });
      if (!word) return;
      var r = await authed('/formulas/reset', { method: 'POST', body: { kind: kind.toUpperCase(), confirm: word } });
      if (!r.ok) { alert(await serverMessage(r, 'Could not reset (' + r.status + ').')); return; }
      fxReportRevision(await r.json());
      loadFormulas();
    });
    box.querySelectorAll('.fxEdit').forEach(function (b) {
      b.addEventListener('click', function () {
        openFormulaForm(kind, (set.rules || []).filter(function (x) { return x.part === b.getAttribute('data-part'); })[0]);
      });
    });
    box.querySelectorAll('.fxRevert').forEach(function (b) {
      b.addEventListener('click', async function () {
        var part = b.getAttribute('data-part');
        var word = await fxConfirmChange({ what: 'reset ' + part + ' to its workbook default', parts: [part] });
        if (!word) return;
        var rr = await authed('/formulas/' + kind.toUpperCase() + '/' + encodeURIComponent(part) +
          '?confirm=' + encodeURIComponent(word), { method: 'DELETE' });
        if (!rr.ok && rr.status !== 204) { alert(await serverMessage(rr, 'Could not reset (' + rr.status + ').')); return; }
        if (rr.ok) fxReportRevision(await rr.json());
        loadFormulas();
      });
    });
  }
  /**
   * Every vendor's part-number mapping, in one place.
   *
   * The same data as Catalog → Manufacturers → Part numbers, reached from the
   * other direction: the mat numbers this maps are generated by the pricing
   * engine, so whoever is looking at the formulas is often the person who needs
   * the mapping. Both doors open the same editor.
   */
  async function drawVendorPartsTab() {
    var box = document.getElementById('fxBody'); if (!box) return;
    box.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
    var vendors = [];
    try {
      var r = await authed('/manufacturers?includeInactive=true');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load vendors (' + r.status + ').</div>'; return; }
      vendors = (await r.json()) || [];
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; return; }

    // One request per vendor would be a dozen round trips for a page that mostly
    // shows zeroes, so the counts come from the vendor records themselves.
    var counts = {};
    var rc = await authed('/formulas/vendor-parts');
    if (rc.ok) {
      var all = await rc.json();
      (all.rows || []).forEach(function (x) { counts[x.manufacturerId] = (counts[x.manufacturerId] || 0) + 1; });
    }

    var rows = vendors.map(function (m) {
      var n = counts[m.id] || 0;
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(m.name) + '</b>' +
          (m.isActive === false ? ' <span class="chip" style="font-size:10.5px;background:#f2f3ef;color:#8a8f85;">Inactive</span>' : '')) +
        td(n ? n + ' mapped part' + (n === 1 ? '' : 's') : '<span class="muted">None</span>') +
        td('<div style="display:flex;justify-content:flex-end;"><button class="vpOpen link-btn" data-id="' + m.id + '" style="width:auto;padding:6px 12px;">' + (n ? 'Edit' : 'Add') + '</button></div>') +
        '</tr>';
    }).join('');

    box.innerHTML =
      '<div class="muted" style="font-size:12.5px;max-width:760px;line-height:1.55;margin-bottom:10px;">What a vendor calls a part we sell under our own number — Resilite sell our <code>R-SSG-1010CLM</code> as <code>A-3204</code>. The vendor&rsquo;s number prints on the Bill of Materials beside ours and appears nowhere a customer can see. The same list is on each vendor under Catalog → Manufacturers.</div>' +
      tableShell(['Vendor', 'Mapped parts', ''], rows, 3, 'No vendors yet.');

    box.querySelectorAll('.vpOpen').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = vendors.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
        openVendorParts(m, currentUser);
      });
    });
  }

  /* --- Paint colour chart ------------------------------------------------
   * Which parts a customer picks one colour for.
   *
   * Goldberg Brothers powder coat our steel, and the choice is not one colour for
   * the structure: it is one per group of parts. The grouping belongs to the PART,
   * so it is set here once and every Bill of Materials reads it — the BOM then asks
   * for a brand and a code per group and paints only that group.
   */
  async function drawPaintColors() {
    var box = document.getElementById('fxBody'); if (!box) return;
    if (!fxPaint.data) {
      box.innerHTML = '<div class="muted" style="padding:16px;">Loading…</div>';
      var r = await authed('/formulas/paint-colors');
      if (!r.ok) {
        box.innerHTML = '<div class="err">Could not load the paint colour chart (' + r.status + '). Run migration 0048 if this persists.</div>';
        return;
      }
      fxPaint.data = await r.json();
    }
    var groups = fxPaint.data.groups || [];
    var admin = isSystemAdmin() || hasRole(['SYSTEM_ADMIN', 'EXECUTIVE'], (currentUser || {}).role);

    var reload = async function () { fxPaint.data = null; await drawPaintColors(); };

    var groupCard = function (g) {
      var skus = g.skus || [];
      return '<div class="card" style="margin-bottom:12px;padding:0;overflow:hidden;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;background:#fbfbf9;border-bottom:1px solid #e7e8e3;">' +
          '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;">' +
            '<span style="font-family:\'Newsreader\',serif;font-size:17px;font-weight:600;color:#3d4a55;">Group ' + esc(g.name) + '</span>' +
            '<input class="pcLabel" data-id="' + g.id + '" value="' + esc(g.label || '') + '" placeholder="What this group is, e.g. Uprights and posts" style="' + bomFieldStyle('280px') + '"' + (admin ? '' : ' disabled') + '>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<span class="muted" style="font-size:12px;">' + skus.length + ' part' + (skus.length === 1 ? '' : 's') + '</span>' +
            (admin ? '<button class="pcGroupDel link-btn" data-id="' + g.id + '" data-name="' + esc(g.name) + '" data-count="' + skus.length + '" style="width:auto;padding:6px 11px;color:#9c3327;">Remove group</button>' : '') +
          '</div>' +
        '</div>' +
        '<div style="padding:12px 16px;">' +
          (skus.length
            ? '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + skus.map(function (x) {
                return '<span style="display:inline-flex;align-items:center;gap:6px;background:#f4f5f1;border:1px solid #e7e8e3;border-radius:999px;padding:4px 6px 4px 11px;font-size:12.5px;font-family:ui-monospace,monospace;">' +
                  esc(x.sku) +
                  (admin ? '<button class="pcRemove" data-sku="' + esc(x.sku) + '" title="Take this part out of the chart" style="border:none;background:none;cursor:pointer;color:#9c3327;font-size:13px;line-height:1;padding:0 3px;">×</button>' : '') +
                '</span>';
              }).join('') + '</div>'
            : '<div class="muted" style="font-size:12.5px;">No parts in this group yet.</div>') +
          (admin
            ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">' +
                '<input class="pcAddSku" data-id="' + g.id + '" list="pcPartList" placeholder="Part # — e.g. A-2245" style="' + bomFieldStyle('190px') + 'text-transform:uppercase;font-family:ui-monospace,monospace;">' +
                '<button class="pcAdd link-btn" data-id="' + g.id + '" style="width:auto;padding:7px 13px;">Add to this group</button>' +
                '<span class="muted" style="font-size:11.5px;">A part already in another group moves here.</span>' +
              '</div>'
            : '') +
        '</div>' +
      '</div>';
    };

    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<div class="muted" style="font-size:12.5px;max-width:720px;line-height:1.55;">Which parts the customer picks one colour for. A Bill of Materials asks for a brand and a colour code per group and paints only the parts in it, so a part belongs to exactly one group. Parts not in the chart can still be coloured by hand on the sheet.</div>' +
        (admin
          ? '<div style="display:flex;gap:8px;white-space:nowrap;">' +
              '<button class="link-btn" id="pcNewGroup" style="width:auto;padding:8px 14px;">+ New group</button>' +
              '<button class="link-btn" id="pcPaste" style="width:auto;padding:8px 14px;">Paste the chart…</button>' +
            '</div>'
          : '') +
      '</div>' +
      (groups.length ? groups.map(groupCard).join('') : '<div class="placeholder"><p class="muted" style="margin:0;">No groups yet. Add one to start the chart.</p></div>') +
      '<datalist id="pcPartList">' + (fxPaint.data.skuParts || []).map(function (p) { return '<option value="' + esc(p) + '">'; }).join('') + '</datalist>';

    if (!admin) return;

    document.querySelectorAll('.pcLabel').forEach(function (el) {
      el.addEventListener('change', async function () {
        var r = await authed('/formulas/paint-colors/groups/' + el.getAttribute('data-id'), {
          method: 'PATCH', body: { label: el.value.trim() },
        });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) alert(await serverMessage(r, 'Could not save that (' + r.status + ').'));
      });
    });

    var assign = async function (sku, groupId) {
      var r = await authed('/formulas/paint-colors/assign', { method: 'POST', body: { sku: sku, groupId: groupId } });
      if (!r.ok) { alert(await serverMessage(r, 'Could not save that (' + r.status + ').')); return false; }
      return true;
    };

    document.querySelectorAll('.pcAdd').forEach(function (b) {
      b.addEventListener('click', async function () {
        var id = b.getAttribute('data-id');
        var el = document.querySelector('.pcAddSku[data-id="' + id + '"]');
        var sku = el.value.trim().toUpperCase();
        if (!sku) return;
        if (await assign(sku, id)) reload();
      });
    });

    document.querySelectorAll('.pcRemove').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (await assign(b.getAttribute('data-sku'), null)) reload();
      });
    });

    document.querySelectorAll('.pcGroupDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        var count = Number(b.getAttribute('data-count')) || 0;
        var name = b.getAttribute('data-name');
        if (!confirm('Remove group ' + name + '?' + (count ? '\n\nIts ' + count + ' part' + (count === 1 ? ' is' : 's are') + ' taken out of the chart — they are not deleted, and can still be coloured by hand.' : ''))) return;
        var r = await authed('/formulas/paint-colors/groups/' + b.getAttribute('data-id') + (count ? '?force=true' : ''), { method: 'DELETE' });
        if (!r.ok && r.status !== 204) { alert(await serverMessage(r, 'Could not remove that group (' + r.status + ').')); return; }
        reload();
      });
    });

    document.getElementById('pcNewGroup').addEventListener('click', function () {
      openModal('New paint colour group',
        fieldRow('Name', '<input id="pcName" maxlength="40" placeholder="F" style="' + IN + '">') +
        fieldRow('What it covers', '<input id="pcLabelNew" placeholder="Optional — e.g. Ladder rungs" style="' + IN + '">'),
        async function (close, showErr) {
          var name = document.getElementById('pcName').value.trim();
          if (!name) return showErr('Give the group a name.');
          var r = await authed('/formulas/paint-colors/groups', {
            method: 'POST', body: { name: name, label: document.getElementById('pcLabelNew').value.trim() },
          });
          if (!r.ok) return showErr(await serverMessage(r, 'Could not add that group (' + r.status + ').'));
          close(); reload();
        }, 'Add group');
    });

    document.getElementById('pcPaste').addEventListener('click', function () { openPaintColorPaste(reload); });
  }

  /**
   * Paste the chart out of the spreadsheet it lives in today: part number, group.
   * Checked before anything is written, so the counts and any clash are seen first.
   */
  function openPaintColorPaste(done) {
    openModal('Paste the paint colour chart',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:10px;">One row per part: the part number, then its group, separated by a tab or a comma. The group has to exist already. Paste straight out of the spreadsheet.</div>' +
      '<textarea id="pcText" rows="12" placeholder="A-2245&#9;A&#10;A-2246&#9;A&#10;A-2241&#9;B" style="' + IN + 'resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px;"></textarea>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;cursor:pointer;">' +
        '<input type="checkbox" id="pcOverwrite"> Move parts that are already in another group</label>' +
      '<div id="pcPreview" class="muted" style="font-size:12.5px;line-height:1.6;margin-top:10px;"></div>',
      async function (close, showErr) {
        var text = document.getElementById('pcText').value;
        if (!text.trim()) return showErr('Nothing pasted.');
        var overwrite = document.getElementById('pcOverwrite').checked;
        var pre = document.getElementById('pcPreview');

        if (!pre.getAttribute('data-checked')) {
          var rc = await authed('/formulas/paint-colors/import', { method: 'POST', body: { text: text, dryRun: true, overwrite: overwrite } });
          if (!rc.ok) return showErr(await serverMessage(rc, 'Could not read that list (' + rc.status + ').'));
          var d = await rc.json();
          pre.innerHTML =
            '<b style="color:#3d4a55;">' + d.parsed + ' row' + (d.parsed === 1 ? '' : 's') + ' read.</b> ' +
            d.created + ' to add, ' + d.moved + ' to move, ' + d.skipped + ' unchanged or skipped.' +
            ((d.conflicts || []).length
              ? '<div style="margin-top:6px;color:#8a6d1f;">Already grouped and left alone: ' +
                d.conflicts.slice(0, 8).map(function (c) { return esc(c.sku) + ' (' + esc(c.current) + ' → ' + esc(c.incoming) + ')'; }).join(', ') +
                ((d.conflicts || []).length > 8 ? ' and ' + (d.conflicts.length - 8) + ' more' : '') +
                '. Tick the box above to move them.</div>'
              : '') +
            ((d.errors || []).length ? '<div style="margin-top:6px;color:#9c3327;">' + d.errors.slice(0, 8).map(esc).join('<br>') + '</div>' : '') +
            '<div style="margin-top:6px;">Press Import again to write these.</div>';
          pre.setAttribute('data-checked', '1');
          return;
        }

        var r = await authed('/formulas/paint-colors/import', { method: 'POST', body: { text: text, overwrite: overwrite } });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not import (' + r.status + ').'));
        close();
        if (done) done();
      }, 'Import');

    var t = document.getElementById('pcText'), o = document.getElementById('pcOverwrite');
    var reset = function () { var p = document.getElementById('pcPreview'); if (p) { p.removeAttribute('data-checked'); p.innerHTML = ''; } };
    if (t) t.addEventListener('input', reset);
    if (o) o.addEventListener('change', reset);
  }

  function fxSourceOptions(kind, sel) {
    var set = fxSet(kind) || {};
    var src = (fx.data && fx.data.sources) || {};
    var group = function (label, opts) {
      if (!opts.length) return '';
      return '<optgroup label="' + label + '">' + opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === sel ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</optgroup>';
    };
    var inputs = (set.inputs || []);
    var numeric = inputs.filter(function (i) { return i.kind !== 'flag' && i.kind !== 'choice'; }).map(function (i) { return ['in:' + i.key, i.label]; });
    var flags = inputs.filter(function (i) { return i.kind === 'flag'; }).map(function (i) { return ['flag:' + i.key, i.label + ' (yes = 1)']; });
    var out = '<option value=""' + (sel ? '' : ' selected') + '>— a plain number —</option>' + group('Configurator answers', numeric) + group('Yes / no answers', flags);
    if (kind === 'hardware') {
      out += group('Frame quantities', (src.frameParts || []).concat((src.skuParts || []).filter(function (p) { return (src.frameParts || []).indexOf(p) === -1 && p.indexOf('6820H-') !== 0; })).map(function (p) { return ['bom:' + p, p]; }));
      out += group('Other fastener rows', (src.hardwareParts || []).map(function (p) { return ['hw:' + p, p]; }));
    }
    return out;
  }
  function openFormulaForm(kind, rule) {
    if (!rule) return;
    var terms = (rule.terms || []).map(function (t) { return { source: t.source || '', coefficient: t.coefficient, when: t.when ? { input: t.when.input, op: t.when.op, value: t.when.value } : null }; });
    var ruleWhen = rule.when ? { input: rule.when.input, op: rule.when.op, value: rule.when.value } : null;
    var inputs = fxInputs(kind);
    var condOptions = function (sel) {
      return '<option value="">always</option>' + inputs.map(function (i) {
        return '<option value="' + esc(i.key) + '"' + (sel === i.key ? ' selected' : '') + '>' + esc(i.label) + '</option>';
      }).join('');
    };
    var opOptions = function (sel) {
      return ['=', '!=', '>', '<', '>=', '<='].map(function (o) { return '<option value="' + o + '"' + (sel === o ? ' selected' : '') + '>' + o + '</option>'; }).join('');
    };
    var condValueField = function (cls, i, cond) {
      var key = cond ? cond.input : '';
      var def = inputs.filter(function (x) { return x.key === key; })[0];
      if (def && def.kind === 'flag') {
        return '<select class="' + cls + 'V" data-i="' + i + '" style="' + IN + 'width:110px;"><option value="true"' + (cond && cond.value !== false ? ' selected' : '') + '>yes</option><option value="false"' + (cond && cond.value === false ? ' selected' : '') + '>no</option></select>';
      }
      if (def && def.kind === 'choice') {
        var shapes = (fxSet(kind) || {}).shapes || [];
        return '<select class="' + cls + 'V" data-i="' + i + '" style="' + IN + 'width:130px;">' + shapes.map(function (sh) { return '<option value="' + esc(sh) + '"' + (cond && cond.value === sh ? ' selected' : '') + '>' + esc(sh) + '</option>'; }).join('') + '</select>';
      }
      return '<input class="' + cls + 'V" data-i="' + i + '" value="' + esc(cond && cond.value != null ? cond.value : 0) + '" style="' + IN + 'width:80px;text-align:right;">';
    };
    var termsHtml = function () {
      return terms.map(function (t, i) {
        return '<div style="border:1px solid #eef0ea;border-radius:9px;padding:8px;margin-bottom:7px;background:#fff;">' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<select class="fxTermSrc" data-i="' + i + '" style="' + IN + 'flex:1;">' + fxSourceOptions(kind, t.source) + '</select>' +
            '<span class="muted" style="font-size:13px;">×</span>' +
            '<input class="fxTermK" data-i="' + i + '" value="' + esc(t.coefficient) + '" style="width:84px;padding:9px 10px;border:1px solid #dcded7;border-radius:9px;text-align:right;font-size:14px;">' +
            '<button type="button" class="fxTermDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:32px;height:32px;color:#9c3327;cursor:pointer;">✕</button>' +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:6px;">' +
            '<span class="muted" style="font-size:11.5px;min-width:44px;">Count</span>' +
            '<select class="fxTermCond" data-i="' + i + '" style="' + IN + 'flex:1;">' + condOptions(t.when ? t.when.input : '') + '</select>' +
            (t.when ? '<select class="fxTermOp" data-i="' + i + '" style="' + IN + 'width:74px;">' + opOptions(t.when.op) + '</select>' + condValueField('fxTermCond', i, t.when) : '') +
          '</div></div>';
      }).join('') || '<div class="muted" style="font-size:12.5px;margin-bottom:6px;">No drivers — this rule produces its constant only.</div>';
    };
    var readTerms = function () {
      document.querySelectorAll('.fxTermSrc').forEach(function (el) { terms[+el.getAttribute('data-i')].source = el.value; });
      document.querySelectorAll('.fxTermK').forEach(function (el) { terms[+el.getAttribute('data-i')].coefficient = Number(el.value) || 0; });
      document.querySelectorAll('.fxTermCond').forEach(function (el) {
        var i = +el.getAttribute('data-i'), t = terms[i];
        if (!el.value) { t.when = null; return; }
        var opEl = document.querySelector('.fxTermOp[data-i="' + i + '"]');
        var vEl = document.querySelector('.fxTermCondV[data-i="' + i + '"]');
        var raw = vEl ? vEl.value : 'true';
        var val = raw === 'true' ? true : raw === 'false' ? false : (isNaN(Number(raw)) ? raw : Number(raw));
        t.when = { input: el.value, op: opEl ? opEl.value : '=', value: val };
      });
    };
    var wireTerms = function () {
      var host = document.getElementById('fxTerms'); if (!host) return;
      host.innerHTML = termsHtml();
      host.querySelectorAll('.fxTermSrc, .fxTermK, .fxTermOp, .fxTermCondV').forEach(function (el) {
        el.addEventListener('change', function () { readTerms(); });
      });
      host.querySelectorAll('.fxTermCond').forEach(function (el) {
        el.addEventListener('change', function () { readTerms(); wireTerms(); });
      });
      host.querySelectorAll('.fxTermDel').forEach(function (b) {
        b.addEventListener('click', function () { readTerms(); terms.splice(+b.getAttribute('data-i'), 1); wireTerms(); });
      });
    };
    openModal('Quantity formula — ' + rule.part,
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;">' + esc(rule.name) + (rule.group ? ' · ' + esc(rule.group) : '') + '</div>' +
      '<div class="field"><label>Driven by</label><div id="fxTerms"></div>' +
        '<button type="button" class="link-btn" id="fxAddTerm" style="width:auto;padding:7px 12px;">+ Add driver</button></div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div class="field" style="flex:1;"><label>Constant</label><input id="fxConst" value="' + esc(rule.constant) + '" style="' + IN + 'text-align:right;"></div>' +
        '<div class="field" style="flex:1;"><label>Overage factor</label><input id="fxFactor" value="' + esc(rule.factor) + '" style="' + IN + 'text-align:right;"></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div class="field" style="flex:1;"><label>Rounding</label><select id="fxRound" style="' + IN + '">' +
          [['NONE', 'None'], ['CEIL', 'Round up'], ['ROUND', 'Nearest']].map(function (o) { return '<option value="' + o[0] + '"' + (rule.roundMode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
        '<div class="field" style="flex:1;"><label>Sold in multiples of</label><input id="fxStep" value="' + esc(rule.roundStep) + '" style="' + IN + 'text-align:right;"></div>' +
        '<div class="field" style="flex:1;"><label>Mode</label><select id="fxMode" style="' + IN + '">' +
          [['SUM', 'Sum of drivers'], ['PRESENCE', 'If any, use constant']].map(function (o) { return '<option value="' + o[0] + '"' + (rule.mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label>Only include this item</label><div style="display:flex;gap:6px;align-items:center;">' +
        '<select id="fxRuleCond" style="' + IN + 'flex:1;">' + condOptions(ruleWhen ? ruleWhen.input : '') + '</select>' +
        '<select id="fxRuleOp" style="' + IN + 'width:74px;' + (ruleWhen ? '' : 'display:none;') + '">' + opOptions(ruleWhen ? ruleWhen.op : '=') + '</select>' +
        '<span id="fxRuleValWrap">' + (ruleWhen ? condValueField('fxRuleCond', 0, ruleWhen) : '') + '</span>' +
      '</div></div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:2px 0;cursor:pointer;"><input type="checkbox" id="fxMinZero"' + (rule.minZero !== false ? ' checked' : '') + '> Never go below zero</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="fxActive"' + (rule.active !== false ? ' checked' : '') + '> Include this item at all</label>' +
      '<div style="margin-top:10px;"><button type="button" class="link-btn" id="fxPreview" style="width:auto;padding:8px 13px;">Preview against a 10′ × 10′ frame</button>' +
        '<div id="fxPreviewOut" class="muted" style="font-size:12.5px;margin-top:8px;"></div></div>',
      async function (close, showErr) {
        var body = fxFormBody();
        if (body.factor <= 0) return showErr('Overage factor must be greater than zero.');
        var word = await fxConfirmChange({
          what: 'change ' + rule.part + (rule.name ? ' (' + rule.name + ')' : ''),
          parts: [rule.part],
        });
        if (!word) return showErr('Cancelled — nothing was saved.');
        body.confirm = word;
        var r = await authed('/formulas/' + kind.toUpperCase() + '/' + encodeURIComponent(rule.part), { method: 'PATCH', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not save (' + r.status + ').'); }
        fxReportRevision(await r.json());
        close(); loadFormulas();
      }, 'Save formula');
    function readRuleCond() {
      var sel = document.getElementById('fxRuleCond');
      if (!sel.value) return null;
      var opEl = document.getElementById('fxRuleOp');
      var vEl = document.querySelector('.fxRuleCondV');
      var raw = vEl ? vEl.value : 'true';
      var val = raw === 'true' ? true : raw === 'false' ? false : (isNaN(Number(raw)) ? raw : Number(raw));
      return { input: sel.value, op: opEl ? opEl.value : '=', value: val };
    }
    function fxFormBody() {
      readTerms();
      return {
        terms: terms.map(function (t) {
          var out = { coefficient: t.coefficient };
          if (t.source) out.source = t.source;
          if (t.when) out.when = t.when;
          return out;
        }),
        constant: Number(document.getElementById('fxConst').value) || 0,
        factor: Number(document.getElementById('fxFactor').value) || 1,
        roundMode: document.getElementById('fxRound').value,
        roundStep: Number(document.getElementById('fxStep').value) || 1,
        mode: document.getElementById('fxMode').value,
        minZero: document.getElementById('fxMinZero').checked,
        active: document.getElementById('fxActive').checked,
        when: readRuleCond(),
        name: rule.name || rule.part,
        group: rule.group || null,
      };
    }
    wireTerms();
    document.getElementById('fxAddTerm').addEventListener('click', function () { readTerms(); terms.push({ source: '', coefficient: 1, when: null }); wireTerms(); });
    document.getElementById('fxRuleCond').addEventListener('change', function () {
      var sel = this.value;
      document.getElementById('fxRuleOp').style.display = sel ? '' : 'none';
      var def = inputs.filter(function (x) { return x.key === sel; })[0];
      document.getElementById('fxRuleValWrap').innerHTML = sel
        ? condValueField('fxRuleCond', 0, { input: sel, op: '=', value: def && def.kind === 'flag' ? true : (def && def.kind === 'choice' ? ((fxSet(kind) || {}).shapes || [''])[0] : 0) })
        : '';
    });
    document.getElementById('fxPreview').addEventListener('click', async function () {
      var out = document.getElementById('fxPreviewOut');
      out.textContent = 'Calculating…';
      var answers = adv || { length: 10, width: 10, config: 'Square', legs: 4, ladders: 1, monkeyBars: true, trolley: true, trolleyType: 'Dual', zipLine: true, zipLineQty: 1, brackets: true, bracketsQty: 4, swivel360: 2, forged: 2, swingHanger: 1, vRings: 1 };
      var body = fxFormBody();
      body.part = rule.part;
      var r = await authed('/formulas/preview', { method: 'POST', body: { kind: kind.toUpperCase(), answers: answers, overrides: [body] } });
      if (!r.ok) { out.textContent = 'Preview failed (' + r.status + ').'; return; }
      var d = await r.json();
      var changed = (d.rows || []).filter(function (x) { return x.changed; });
      var mine = (d.rows || []).filter(function (x) { return x.part === rule.part; })[0];
      out.innerHTML =
        (mine ? '<div style="color:#20241f;"><b>' + esc(rule.part) + '</b>: ' + mine.qtyBefore + ' → <b>' + mine.qtyAfter + '</b> · <span style="font-family:ui-monospace,monospace;font-size:11.5px;">' + esc(mine.formula) + '</span></div>' : '') +
        (changed.filter(function (x) { return x.part !== rule.part; }).length
          ? '<div style="margin-top:5px;">Knock-on changes: ' + changed.filter(function (x) { return x.part !== rule.part; }).map(function (x) { return esc(x.part) + ' ' + x.qtyBefore + '→' + x.qtyAfter; }).join(', ') + '</div>'
          : (changed.length ? '' : '<div style="margin-top:5px;">No change on this configuration.</div>'));
    });
  }

  async function loadUsers() {
    var box = document.getElementById('admList'); if (!box) return;
    try {
      var r = await authed('/admin/users'); if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var users = await r.json();
      // Keep the loaded records so Edit opens with what is actually stored rather
      // than re-reading the values back out of table cells.
      admUsers = {};
      (users || []).forEach(function (u) { admUsers[u.id] = u; });
      var rows = (users || []).map(function (u) {
        return '<tr>' +
          td('<b style="font-weight:600;">' + esc(u.name || '—') + '</b>' +
            (u.title ? '<div class="muted" style="font-size:12px;margin-top:2px;">' + esc(u.title) + '</div>' : '')) +
          td(esc(u.email) +
            (u.phone ? '<div class="muted" style="font-size:12px;margin-top:2px;">' + esc(u.phone) + '</div>' : '')) +
          td('<select data-id="' + u.id + '" class="roleSel" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;">' + ROLES.map(function (rl) { return '<option value="' + rl + '"' + (rl === u.role ? ' selected' : '') + '>' + titleCase(rl) + '</option>'; }).join('') + '</select>') +
          td(u.isActive ? '<span class="chip">Active</span>' : '<span class="muted">Inactive</span>') +
          td('<div style="display:flex;gap:6px;justify-content:flex-end;">' +
            '<button class="link-btn" data-edit="' + u.id + '" style="width:auto;padding:6px 11px;">Edit</button>' +
            '<button class="link-btn" data-pwd="' + u.id + '" data-email="' + esc(u.email) + '" style="width:auto;padding:6px 11px;">Reset password</button>' +
            (u.isActive
              ? '<button class="link-btn" data-deact="' + u.id + '" style="width:auto;padding:6px 11px;">Deactivate</button>'
              : '<button class="link-btn" data-react="' + u.id + '" style="width:auto;padding:6px 11px;">Reactivate</button>') +
          '</div>') + '</tr>';
      }).join('');
      box.innerHTML = tableShell(['Name', 'Email', 'Role', 'Status', ''], rows, 5, 'No users.');
      document.querySelectorAll('.roleSel').forEach(function (sel) { sel.addEventListener('change', async function () { var r2 = await authed('/admin/users/' + sel.getAttribute('data-id') + '/role', { method: 'PATCH', body: { role: sel.value } }); if (!r2.ok) { alert('Could not change role (' + r2.status + ').'); loadUsers(); } }); });
      document.querySelectorAll('[data-deact]').forEach(function (bt) { bt.addEventListener('click', async function () { if (!confirm('Deactivate this user?')) return; var r2 = await authed('/admin/users/' + bt.getAttribute('data-deact') + '/deactivate', { method: 'PATCH', body: {} }); if (!r2.ok) alert('Could not deactivate.'); loadUsers(); }); });
      document.querySelectorAll('[data-react]').forEach(function (bt) { bt.addEventListener('click', async function () { var r2 = await authed('/admin/users/' + bt.getAttribute('data-react') + '/reactivate', { method: 'PATCH', body: {} }); if (!r2.ok) alert('Could not reactivate.'); loadUsers(); }); });
      document.querySelectorAll('[data-pwd]').forEach(function (bt) { bt.addEventListener('click', function () { openResetPasswordForm(bt.getAttribute('data-pwd'), bt.getAttribute('data-email')); }); });
      document.querySelectorAll('[data-edit]').forEach(function (bt) { bt.addEventListener('click', function () { openEditUserForm(admUsers[bt.getAttribute('data-edit')]); }); });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  /** Users from the last /admin/users load, by id — the source for the Edit form. */
  var admUsers = {};

  /**
   * Edit another user's profile. Email is included deliberately: it is the login
   * identifier, and moving an account off a shared address like admin@ onto a
   * personal one is the whole reason this form exists.
   */
  function openEditUserForm(u) {
    if (!u) return;
    var isMe = currentUser && currentUser.id === u.id;
    openModal('Edit ' + (u.name || u.email),
      fieldRow('Name', '<input id="eName" style="' + IN + '" value="' + esc(u.name || '') + '">') +
      fieldRow('Email', '<input id="eEmail" type="email" style="' + IN + '" value="' + esc(u.email || '') + '" required>') +
      '<div class="muted" style="font-size:12px;margin:-6px 0 14px;">' +
        (isMe ? 'This is the address you sign in with. Changing it takes effect immediately — you stay signed in here.'
              : 'This is the address they sign in with. Tell them before you change it.') + '</div>' +
      fieldRow('Title', '<input id="eTitle" style="' + IN + '" value="' + esc(u.title || '') + '" placeholder="e.g. Sales Director">') +
      fieldRow('Phone', '<input id="ePhone" style="' + IN + '" value="' + esc(u.phone || '') + '" placeholder="720-457-5500">'),
      async function (close, showErr) {
        var email = document.getElementById('eEmail').value.trim();
        if (!/.+@.+\..+/.test(email)) return showErr('Enter a valid email.');
        var body = {
          email: email,
          name: document.getElementById('eName').value.trim(),
          title: document.getElementById('eTitle').value.trim(),
          phone: document.getElementById('ePhone').value.trim(),
        };
        var r = await authed('/admin/users/' + u.id, { method: 'PATCH', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not save (' + r.status + ').'));
        var updated = await r.json().catch(function () { return null; });
        close();
        // The sidebar greets you by name and the proposal footer prints your title
        // and phone — rebuild the shell when you edited your own record, otherwise
        // just refresh the table.
        if (isMe && updated && currentUser) {
          currentUser.name = updated.name; currentUser.email = updated.email;
          currentUser.title = updated.title; currentUser.phone = updated.phone;
          renderShell(currentUser);
          renderAdmin(currentUser);
        } else {
          loadUsers();
        }
      }, 'Save');
  }

  function openUserForm() {
    openModal('New user',
      fieldRow('Email', '<input id="uEmail" type="email" style="' + IN + '" required>') +
      fieldRow('Name', '<input id="uName" style="' + IN + '">') +
      fieldRow('Title', '<input id="uTitle" style="' + IN + '" placeholder="e.g. Sales Director">') +
      fieldRow('Phone', '<input id="uPhone" style="' + IN + '" placeholder="720-457-5500">') +
      fieldRow('Temporary password', '<input id="uPass" style="' + IN + '" placeholder="at least 12 characters" required>') +
      fieldRow('Role', selectEl('uRole', ROLES, 'SALES_REP')),
      async function (close, showErr) {
        var email = document.getElementById('uEmail').value.trim(); if (!/.+@.+\..+/.test(email)) return showErr('Enter a valid email.');
        var pass = document.getElementById('uPass').value; if (pass.length < 12) return showErr('Password must be at least 12 characters.');
        var body = { email: email, name: document.getElementById('uName').value.trim() || undefined, password: pass, role: document.getElementById('uRole').value };
        var r = await authed('/admin/users', { method: 'POST', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not create (' + r.status + ').'));
        // Title and phone are not part of the create payload; set them in the same
        // action so a new user is not left with a half-filled profile.
        var created = await r.json().catch(function () { return null; });
        var title = document.getElementById('uTitle').value.trim();
        var phone = document.getElementById('uPhone').value.trim();
        if (created && created.id && (title || phone)) {
          await authed('/admin/users/' + created.id, { method: 'PATCH', body: { title: title, phone: phone } });
        }
        close(); loadUsers();
      });
  }

  /** Read the API's error message so the user sees the cause, not just a status code. */
  async function serverMessage(r, fallback) {
    try { var d = await r.json(); if (d && d.message) return d.message; } catch (e) {}
    return fallback;
  }

  /** Admin-set password reset for a locked-out user. Revokes their sessions. */
  function openResetPasswordForm(id, email) {
    openModal('Reset password',
      '<div class="muted" style="font-size:12.5px;margin-bottom:12px;">Sets a new password for <b>' + esc(email) + '</b> and signs them out everywhere. Give them the new password directly — they can change it themselves from Change password once signed in.</div>' +
      fieldRow('New password', '<input id="rPass" style="' + IN + '" placeholder="at least 12 characters" required>'),
      async function (close, showErr) {
        var pass = document.getElementById('rPass').value;
        if (pass.length < 12) return showErr('Password must be at least 12 characters.');
        var r = await authed('/admin/users/' + id + '/reset-password', { method: 'POST', body: { password: pass } });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not reset (' + r.status + ').'));
        close(); loadUsers();
      }, 'Reset password');
  }

  function openProfileForm(user) {
    openModal('My profile',
      fieldRow('Full name', '<input id="upName" style="' + IN + '" value="' + esc(user.name || '') + '" required>') +
      fieldRow('Title', '<input id="upTitle" style="' + IN + '" placeholder="e.g. Director of Sales" value="' + esc(user.title || '') + '">') +
      fieldRow('Phone', '<input id="upPhone" style="' + IN + '" placeholder="e.g. (720) 457-5500" value="' + esc(user.phone || '') + '">') +
      fieldRow('Email', '<input style="' + IN + 'background:#f2f3ef;" value="' + esc(user.email || '') + '" disabled>') +
      '<div class="muted" style="font-size:12px;margin-top:2px;">These details appear in the “Proposal Prepared By” block on every proposal you generate.</div>',
      async function (close, showErr) {
        var name = document.getElementById('upName').value.trim();
        if (name.length < 2) return showErr('Enter your full name.');
        var r = await authed('/auth/me', { method: 'PATCH', body: { name: name, title: document.getElementById('upTitle').value.trim(), phone: document.getElementById('upPhone').value.trim() } });
        if (!r.ok) return showErr('Could not save your profile (' + r.status + ').');
        var updated = await r.json();
        user.name = updated.name; user.title = updated.title; user.phone = updated.phone;
        if (currentUser) { currentUser.name = updated.name; currentUser.title = updated.title; currentUser.phone = updated.phone; }
        close(); renderShell(user);
      }, 'Save profile');
  }

  function openPasswordForm() {
    openModal('Change password',
      fieldRow('Current password', '<input id="pwCur" type="password" autocomplete="current-password" style="' + IN + '" required>') +
      fieldRow('New password', '<input id="pwNew" type="password" autocomplete="new-password" minlength="12" style="' + IN + '" required>') +
      fieldRow('Confirm new password', '<input id="pwNew2" type="password" autocomplete="new-password" minlength="12" style="' + IN + '" required>') +
      '<div style="font-size:12px;color:#8a8f85;line-height:1.5;">At least 12 characters. Signing you out of every device once changed.</div>',
      async function (close, fail) {
        var cur = document.getElementById('pwCur').value;
        var next = document.getElementById('pwNew').value;
        if (next !== document.getElementById('pwNew2').value) return fail('The new passwords do not match.');
        if (next.length < 12) return fail('New password must be at least 12 characters.');
        var r = await authed('/auth/password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
        if (!r.ok) {
          var msg = 'Could not change the password.';
          try { var e = await r.json(); if (e && e.message) msg = e.message; } catch (x) {}
          return fail(msg);
        }
        close();
        clearTokens();
        renderLogin('Password changed. Please sign in again.');
      }, 'Change password');
  }

  /* --- Integrations --- */
  async function renderIntegrations(user) {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="muted" style="padding:24px;">Loading…</div>';

    var r = await authed('/integrations/quickbooks/status');
    if (!r.ok) {
      view.innerHTML = '<div class="err">Could not read integration status (' + r.status + ').</div>';
      return;
    }
    var s = await r.json();
    var connected = (s.connections || 0) > 0;
    var envLabel = titleCase(s.environment || 'sandbox');

    view.innerHTML =
      '<div class="card" style="margin-bottom:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">' +
          '<div>' +
            '<div class="k">Accounting</div>' +
            '<h2 style="font-size:19px;margin:2px 0 6px;">QuickBooks Online</h2>' +
            '<div style="font-size:13.5px;color:#82877d;">' +
              (s.configured
                ? (connected
                  ? '<span class="dot ok"></span>Connected to the ' + esc(envLabel.toLowerCase()) + ' company.'
                  : '<span class="dot wait"></span>Credentials set, not yet connected.')
                : '<span class="dot bad"></span>Not configured — the QBO environment variables are missing.') +
            '</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<span class="chip">' + esc(envLabel) + '</span>' +
            (s.productionWritesEnabled
              ? '<div style="margin-top:8px;font-size:12.5px;color:#c2452f;font-weight:600;">Live financial writes ENABLED</div>'
              : '<div style="margin-top:8px;font-size:12.5px;color:#82877d;">Live writes disabled</div>') +
          '</div>' +
        '</div>' +
        (s.configured
          ? '<div style="margin-top:18px;"><button class="btn" id="qboConnect" style="width:auto;padding:10px 18px;">' +
              (connected ? 'Reconnect to QuickBooks' : 'Connect to QuickBooks') + '</button></div>'
          : '') +
      '</div>' +
      '<div class="placeholder"><h3>What connecting does</h3><p>Sends you to Intuit to approve access, then stores an encrypted token. ' +
        'In the ' + esc(envLabel.toLowerCase()) + ' environment nothing touches your real books.</p></div>';

    var btn = document.getElementById('qboConnect');
    if (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true; btn.textContent = 'Opening Intuit…';
        var c = await authed('/integrations/quickbooks/connect');
        if (!c.ok) {
          btn.disabled = false; btn.textContent = 'Connect to QuickBooks';
          view.insertAdjacentHTML('afterbegin', '<div class="err">Could not start the connection (' + c.status + ').</div>');
          return;
        }
        var d = await c.json();
        location.href = d.url;
      });
    }
  }

  async function logout() {
    var rt = tokens().rt;
    try { if (rt) await api('/auth/logout', { method: 'POST', noAuth: true, body: { refreshToken: rt } }); } catch (e) {}
    clearTokens(); renderLogin();
  }

  async function boot() {
    // An emailed reset link wins over any existing session — the person clicking it
    // is by definition trying to get back in.
    var resetToken = null;
    try { resetToken = new URLSearchParams(location.search).get('reset'); } catch (e) {}
    if (resetToken) { renderResetPassword(resetToken); return; }
    if (!tokens().at && !tokens().rt) { renderLogin(); return; }
    try { var r = await authed('/auth/me'); if (r.ok) { renderShell(await r.json()); return; } clearTokens(); renderLogin(); }
    catch (e) { renderLogin('Could not reach the server. Is it running?'); }
  }
  boot();
})();

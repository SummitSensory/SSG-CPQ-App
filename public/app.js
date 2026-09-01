/* Summit Sensory Gym Proposal Management Software — web client.
   Slice 1: login + shell + dashboard.  Slice 2: CRM (organizations + opportunities).
   Talks to the same-origin API. No build step. */
(function () {
  'use strict';

  var AT = 'ssg_at', RT = 'ssg_rt';
  var root = document.getElementById('root');
  var currentUser = null;
  /* --- Shared UI primitives, from public/ssg-ui.js ---------------------------
   *
   * Escaping, money, dates, table cells, the modal, the toast. Twenty-eight small
   * things every screen in this app is built out of, and the reason none of the
   * screens could be lifted out of this file: Catalog needed twenty-one things from
   * the shell and seventeen of them were these; Administration's thirty contained the
   * same seventeen. So did the CRM's and Reports'. They now live in ssg-ui.js, which
   * loads first and has no dependencies of its own.
   *
   * Aliased back in here under their original names rather than rewritten as
   * SSGUI.esc(...) at every call site. esc has 780 references and td has 301; a
   * mechanical edit of two thousand call sites is all risk and no benefit, and it
   * would bury the one thing this commit needs to be reviewable — that every body
   * moved unchanged.
   *
   * These are var bindings, not hoisted function declarations, so they exist from
   * this line down rather than from the top of the closure. Every call site is inside
   * a function that runs after boot, so that is all of them; a use added ABOVE this
   * block would throw on the spot rather than misbehave quietly, which is the right
   * failure.
   */
  if (!window.SSGUI) {
    // Loudly, and in the one place a person is already looking. A missing primitive
    // module is not a degraded shell, it is no shell at all, and 'esc is not a
    // function' thrown from three thousand lines down says nothing about why.
    if (root) root.innerHTML = '<div style="padding:40px;text-align:center;color:#9c3327;font:14px/1.6 system-ui;">ssg-ui.js did not load.<br>It must be the first script tag in index.html.</div>';
    throw new Error('SSGUI is missing: public/ssg-ui.js must load before app.js.');
  }
  var esc = window.SSGUI.esc,
    titleCase = window.SSGUI.titleCase,
    rt = window.SSGUI.rt,
    isoLocal = window.SSGUI.isoLocal,
    todayISO = window.SSGUI.todayISO,
    fmtDate = window.SSGUI.fmtDate,
    fmtDateTime = window.SSGUI.fmtDateTime,
    fmtMoney = window.SSGUI.fmtMoney,
    fmt0 = window.SSGUI.fmt0,
    money = window.SSGUI.money,
    costMoney = window.SSGUI.costMoney,
    d2m = window.SSGUI.d2m,
    hasRole = window.SSGUI.hasRole,
    roleLabel = window.SSGUI.roleLabel,
    td = window.SSGUI.td,
    tableShell = window.SSGUI.tableShell,
    statusChip = window.SSGUI.statusChip,
    kpi = window.SSGUI.kpi,
    fieldRow = window.SSGUI.fieldRow,
    formSection = window.SSGUI.formSection,
    IN = window.SSGUI.IN,
    selectEl = window.SSGUI.selectEl,
    bomFieldStyle = window.SSGUI.bomFieldStyle,
    openModal = window.SSGUI.openModal,
    toast = window.SSGUI.toast,
    downloadCsv = window.SSGUI.downloadCsv,
    downloadBlob = window.SSGUI.downloadBlob,
    serverMessage = window.SSGUI.serverMessage,
    streetLine = window.SSGUI.streetLine;


  function tokens() { return { at: localStorage.getItem(AT), rt: localStorage.getItem(RT) }; }
  function setTokens(at, rt) { if (at) localStorage.setItem(AT, at); if (rt) localStorage.setItem(RT, rt); }
  function clearTokens() { localStorage.removeItem(AT); localStorage.removeItem(RT); }
  // Title-case a product/section name word-by-word, preserving punctuation and existing caps mid-word.
  function tc(s) { return String(s || '').replace(/\b([a-z])/g, function (m0, c) { return c.toUpperCase(); }); }
  // Section headings carry the "(Optional)" tag from the optional flag, never from the name itself.
  function stripOptional(s) { return String(s || '').replace(/\s*[—-]?\s*\(\s*optional\s*\)\s*$/i, '').replace(/\s*[—-]\s*optional\s*(?=\))/i, '').trim(); }
  /** Money as it prints in the proposal totals block: "USD $8,662.50". */
  // Held together with nowrap: the totals column is 78px wide, and left to itself the
  // browser broke 'USD' onto its own line above the figure.
  function fmtUsd(minor) {
    return '<span style="white-space:nowrap;">USD ' + fmtMoney(minor, '') + '</span>';
  }
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
  /**
   * Whether the "prints instead of TBD" box holds a NUMBER rather than wording.
   *
   * Separate from overrideMinor because that returns 0 both for a typed zero and for
   * text it cannot parse, and those mean opposite things on a proposal: a typed 0
   * prints USD $0.00, while "call to confirm" prints as itself.
   */
  /* isNumericOverride moved to proposal-document.js with the renderer that used it. */
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

  /**
   * How long any one request may take before the app stops waiting.
   *
   * There was no ceiling at all. fetch() on its own waits as long as the browser
   * will hold the socket open, so a request the server never answers — a
   * serverless invocation killed mid-PDF, a connection dropped by a proxy — left
   * the caller awaiting a promise that would never settle. Nothing timed out,
   * nothing threw, and the button that started it kept saying "Saving…" for the
   * rest of the session. That is the hang.
   *
   * RENDER_TIMEOUT_MS is deliberately longer than the 60 seconds vercel.json
   * gives the render function: the client must not give up on a PDF the server is
   * still legitimately building, or a document goes out while the operator is
   * being told it failed.
   */
  var REQUEST_TIMEOUT_MS = 60000;
  var RENDER_TIMEOUT_MS = 70000;

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    var at = tokens().at;
    if (at && !opts.noAuth) headers['Authorization'] = 'Bearer ' + at;
    var limit = opts.timeoutMs || REQUEST_TIMEOUT_MS;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, limit) : null;
    var done = function () { if (timer) { clearTimeout(timer); timer = null; } };
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) { done(); return r; }, function (err) {
      done();
      // An abort and a dead network look identical to the caller unless we say
      // which happened, and they need different advice.
      if (err && err.name === 'AbortError') {
        throw new Error('The server did not answer within ' + Math.round(limit / 1000) +
          ' seconds. It may still have gone through — check before sending again.');
      }
      throw err;
    });
  }

  /* --- Saving a field as it is typed -----------------------------------------
   * Editable fields used to save on 'change', which the browser fires only when
   * focus LEAVES the field. That is the "nothing sticks until I click something
   * else" problem: you type a figure, look at the totals, and they are the old
   * ones because no request has been made yet.
   *
   * bindLiveField saves a short pause after typing stops, and also on blur, on
   * Enter, and on 'change' — and never saves the same value twice, so the
   * trailing 'change' after a debounced save is a no-op rather than a second
   * PATCH. Controls with no "still typing" state commit immediately.
   */
  var LIVE_SAVE_IDLE_MS = 800;
  function bindLiveField(el, save) {
    var timer = null, last = el.value, running = false, queued = false;
    var fire = function () {
      if (timer) { clearTimeout(timer); timer = null; }
      if (el.value === last) return Promise.resolve();
      // One save in flight at a time. A keystroke landing mid-request marks the
      // field dirty again and is picked up when that request returns, instead of
      // racing it and letting the older value win.
      if (running) { queued = true; return Promise.resolve(); }
      last = el.value; running = true;
      return Promise.resolve()
        .then(function () { return save(el); })
        .catch(function (err) { alert((err && err.message) || 'Could not save that.'); })
        .then(function () {
          running = false;
          if (queued) { queued = false; return fire(); }
        });
    };
    var instant = el.tagName === 'SELECT' || el.type === 'checkbox' ||
      el.type === 'radio' || el.type === 'date';
    el.addEventListener('change', fire);
    if (!instant) {
      el.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, LIVE_SAVE_IDLE_MS);
      });
      el.addEventListener('blur', fire);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') { e.preventDefault(); fire(); }
      });
    }
    return fire;
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
    { id: 'belts', label: 'Belt Shipments', ready: true, roles: '*' },
    { id: 'admin', label: 'Administration', ready: true, roles: ['SYSTEM_ADMIN'] },
    { id: 'integrations', label: 'Integrations', ready: true, roles: ['SYSTEM_ADMIN', 'EXECUTIVE', 'ACCOUNTING'] },
  ];
  var CRM_WRITE_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'SALES_REP', 'DESIGNER', 'ESTIMATOR', 'OPERATIONS', 'PROJECT_MANAGER'];
  function canCrmWrite(role) { return CRM_WRITE_ROLES.indexOf(role) !== -1; }
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
  function navFor(role) {
    return NAV.filter(function (n) {
      if (n.roles === '*') return true;
      // Defensive: a nav entry whose role list is missing used to throw here and take
      // the entire shell down rather than just hiding one tab.
      return Array.isArray(n.roles) && n.roles.indexOf(role) !== -1;
    });
  }

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
            '<div id="buildStamp" style="text-align:center;font-size:10px;color:#b3b7ac;margin-top:8px;letter-spacing:.04em;line-height:1.5;">&nbsp;</div></div>' +
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
      else if (id === 'catalog') window.SSGCatalog.render(user);
      else if (id === 'proposals') renderProposals(user);
      else if (id === 'mock') renderMockProposal(user);
      else if (id === 'reports') renderReports(user);
      else if (id === 'orders') renderOrders(user);
      // Belts owed to customers, and the slip that goes in the box. See
      // public/belt-shipments.js — narrow by design: no freight, no BOM, no prices.
      else if (id === 'belts' && window.SSGBeltShipments) window.SSGBeltShipments.mount();
      else if (id === 'admin') renderAdmin(user);
      else if (id === 'integrations') renderIntegrations(user);
      else renderSoon(item.label);
    });
    document.getElementById('logoutBtn').addEventListener('click', logout);
    showBuildStamp();
    document.getElementById('pwdBtn').addEventListener('click', openPasswordForm);
    document.getElementById('profBtn').addEventListener('click', function () { openProfileForm(user); });
    /* Freight true-up lives in public/freight-trueup.js. It borrows the shell's
     * helpers rather than reimplementing them, so styling, auth, modals and money
     * formatting stay identical to everything around it — the list below is the whole
     * of what it depends on. Guarded because a client script that fails to load must
     * not take the shell with it: the dashboard block and the workspace simply won't
     * be there, which is the same failure mode as never wiring it up. */
    if (window.FreightTrueUp) {
      window.FreightTrueUp.init({
        esc: esc,
        authed: authed,
        titleCase: titleCase,
        fmtDate: fmtDate,
        openModal: openModal,
        goToProposals: function (u) {
          activateNav('proposals');
          document.getElementById('viewTitle').textContent = 'Proposals';
          renderProposals(u || user);
        },
      });

      /* The invoice-short banner sits above every screen rather than inside the
       * freight panel, because an invoice missing money should not be discoverable
       * only by whoever happens to open that panel. Mounted once, here, for the
       * same reason init is: this is where the session is known. */
      window.FreightTrueUp.mountBanner(user);
    }

    /* Introduction pages: the same two helpers, and one fetch for the photographs the
     * templates print with. Loaded here rather than per proposal so building a
     * document is synchronous — see proposal-front-matter.js. */
    if (window.SSGFrontMatter) {
      window.SSGFrontMatter.init({ authed: authed, esc: esc });
      window.SSGFrontMatter.loadArt();
    }
    if (window.SSGIntroAdmin) window.SSGIntroAdmin.init({ authed: authed, esc: esc });
    if (window.SSGBeltShipments) window.SSGBeltShipments.init({ authed: authed, esc: esc });
    // Standard proposal notes: rendered by Catalog AND Administration, so it belongs to
    // neither. Everything else it needs it reads off window.SSGUI.
    if (window.SSGStandardNotes) window.SSGStandardNotes.init({ authed: authed });
    // The renderer fetches the published legal wording here, once, so html() — which is
    // synchronous, deep inside the document builder — always has it by the time anyone
    // opens a proposal. Without this call the shipped wording prints and nothing breaks.
    if (window.SSGContractPages) window.SSGContractPages.init({ authed: authed });
    // Same fetch-once-at-sign-in shape as SSGContractPages, for the builder's
    // reference-documents checklist (a W9, a certificate of insurance).
    if (window.SSGReferenceDocuments) window.SSGReferenceDocuments.init({ authed: authed, esc: esc });
    /*
     * The paginator, lent to the legal document editor.
     *
     * Its preview has to show the sheets a customer will actually receive — with the real
     * page breaks and the "Page 1 of 3" footer every sheet is required to state. A second
     * implementation would be a second set of page breaks to disagree with this one, so
     * the editor borrows the real thing rather than approximating it.
     */
    window.SSGPaginate = paginateProposalArea;
    if (window.SSGLegalAdmin) window.SSGLegalAdmin.init({ authed: authed, esc: esc });
    // Vendor part numbers: the dialog lives here for Catalog AND Administration, which
    // is why it is no longer inside either.
    if (window.SSGVendorParts) window.SSGVendorParts.init({ authed: authed });
    // The Catalog screen. One entry point, one injected dependency; everything else it
    // needs it reads off window.SSGUI.
    if (window.SSGCatalog) window.SSGCatalog.init({ authed: authed });
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
        // Both contract documents unless someone says otherwise.
        includeRelease: true, includeTerms: true,
        projectId: '', showProjectId: false, showDeposit: true,
        // Adventure Series front matter: the photos attached to this proposal, and
        // whether the document is the introduction, the proposal, or both. Only has
        // any effect on an Adventure proposal — see SSGFrontMatter.applies().
        // Which introduction this proposal prints. Photography belongs to the
        // template and is managed in Admin; what to generate is chosen at the moment
        // of previewing or saving — see proposal-front-matter.js.
        introTemplate: '',
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
      '<div id="ftuDash"></div>' +
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
    document.getElementById('dqCatalog').addEventListener('click', function () { activateNav('catalog'); window.SSGCatalog.render(user); });
    try { var r = await fetch('/health'); var el = document.getElementById('apiStatus'); if (el) el.innerHTML = r.ok ? '<span class="dot ok"></span>Online' : '<span class="dot bad"></span>Error ' + r.status; }
    catch (e) { var el2 = document.getElementById('apiStatus'); if (el2) el2.innerHTML = '<span class="dot bad"></span>Offline'; }
    loadDashboard(user);
    /* Freight outstanding — jobs that went out without final freight costs. Filled
     * after loadDashboard is kicked off, so a slow /freight/queue never holds up the
     * rest of the dashboard, and left empty when nothing is outstanding:
     * dashboardSection returns '' rather than an empty card, so the block disappears
     * instead of sitting there saying nothing. Clicking a row opens the workspace. */
    if (window.FreightTrueUp) {
      try {
        var ftuHtml = await window.FreightTrueUp.dashboardSection(user);
        var ftuHost = document.getElementById('ftuDash');
        if (ftuHost && ftuHtml) {
          ftuHost.innerHTML = ftuHtml;
          window.FreightTrueUp.bindDashboard(user);
        }
      } catch (e) {}
    }
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
        foldRows(rows.map(function (r, i) {
          return '<div class="dashRow" data-id="' + r.id + '" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' + (i ? 'border-top:1px solid #f2f3ef;' : '') + '">' +
            '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
              '<div class="muted" style="font-size:12px;">' + esc(r.title) + ' · ' + esc(r.number) + '</div></div>' +
            '<div style="text-align:right;white-space:nowrap;font-size:12.5px;">' + fmt0(r.total) +
              '<div class="muted" style="font-size:11.5px;">' + (r.expiration ? 'expires ' + fmtDate(r.expiration) : r.daysOpen + ' days old') + '</div></div></div>';
        }), 6, '#f2f3ef', color) + '</div></div>';
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
        foldRows(rows.map(function (r, i) {
          var win = r.decisionFrom || r.decisionTo
            ? 'decides ' + (r.decisionFrom ? fmtDate(r.decisionFrom) : '?') + ' – ' + (r.decisionTo ? fmtDate(r.decisionTo) : '?')
            : 'no decision window recorded';
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;' + (i ? 'border-top:1px solid #f2f3ef;' : '') + '">' +
            '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
              '<div class="muted" style="font-size:12px;">' + esc(win) + '</div></div>' +
            '<div style="text-align:right;white-space:nowrap;font-size:12.5px;">' + esc(fmtDate(r.followUpDate)) +
              '<div class="muted" style="font-size:11.5px;">follow-up date</div></div></div>';
        }), 6, '#f2f3ef', '#8a6d1f') + '</div></div>';
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
    bindFolds();
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
      foldRows(rows.map(function (r, i) {
        var vend = (r.vendors || []).join(', ');
        return '<div class="freightRow" data-pid="' + r.proposalId + '" data-vid="' + r.versionId + '" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;cursor:pointer;' + (i ? 'border-top:1px solid #f6dcd7;' : '') + '">' +
          '<div style="min-width:0;"><b style="font-weight:600;font-size:13.5px;">' + esc(r.customer) + '</b>' +
            '<div class="muted" style="font-size:12px;">' + esc(r.title) + ' \u00b7 ' + esc(r.number) + ' v' + r.version + '</div></div>' +
          '<div style="text-align:right;white-space:nowrap;font-size:12.5px;color:#9c3327;font-weight:600;">' + r.pendingCount + ' item' + (r.pendingCount === 1 ? '' : 's') +
            '<div class="muted" style="font-size:11.5px;font-weight:400;">' + esc(vend || 'freight outstanding') + (r.removedCount ? ' \u00b7 ' + r.removedCount + ' removed' : '') + '</div></div></div>';
      }), 8, '#f6dcd7', '#9c3327') + '</div></div>';
  }

  /**
   * Attention groups FOLD rather than truncate.
   *
   * Every row is rendered; the ones past the limit start hidden behind a footer that
   * opens them. A group headed "30" that shows eight and ends in a dead "and 22 more"
   * is a count nobody can act on, and these are the lists the day is worked from.
   * Row handlers are attached by class after render, so a hidden row is wired exactly
   * like a visible one.
   */
  function foldRows(rowHtmls, limit, lineColor, textColor) {
    var extra = rowHtmls.length - limit;
    if (extra <= 0) return rowHtmls.join('');
    return rowHtmls.slice(0, limit).join('') +
      rowHtmls.slice(limit).map(function (h) {
        return '<div class="foldExtra" style="display:none;">' + h + '</div>';
      }).join('') +
      '<button type="button" class="foldMore" data-shown="0" data-limit="' + limit +
      '" data-total="' + rowHtmls.length + '" data-hidden="' + extra + '" ' +
      'style="display:block;width:100%;text-align:left;background:none;border:0;border-top:1px solid ' + lineColor +
      ';padding:9px 14px;font:inherit;font-size:12px;color:' + textColor + ';cursor:pointer;">' +
      'Show all ' + rowHtmls.length + ' \u00b7 ' + extra + ' more</button>';
  }

  /** Wire every fold footer on the page. Each toggles only its own group. */
  function bindFolds() {
    document.querySelectorAll('.foldMore').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('data-shown') === '1';
        btn.parentNode.querySelectorAll('.foldExtra').forEach(function (n) {
          n.style.display = open ? 'none' : '';
        });
        btn.setAttribute('data-shown', open ? '0' : '1');
        btn.textContent = open
          ? 'Show all ' + btn.getAttribute('data-total') + ' \u00b7 ' + btn.getAttribute('data-hidden') + ' more'
          : 'Show the first ' + btn.getAttribute('data-limit') + ' only';
      });
    });
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
      /* Freight true-up — the same entry form as the standalone workspace, embedded
       * here because this is the screen the freight owner is already on when a vendor
       * invoice lands. One implementation, two places it can be reached from. */
      '<div class="section-title">Freight true-up</div>' +
      '<div id="ftuReviewPanel"><div class="muted" style="padding:14px 0;">Loading freight\u2026</div></div>' +
      '<div class="section-title">Line items</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
        (covLines.length
          ? covLines.map(freightReviewRow).join('') + removed.map(freightRemovedRow).join('')
          : '<div class="placeholder" style="padding:22px;"><p class="muted" style="margin:0;">No product lines on this version.</p></div>') +
      '</div>';

    document.getElementById('frBack').addEventListener('click', function () { renderProposals(user); });
    document.getElementById('frDoc').addEventListener('click', function () { previewProposal(p, v); });
    loadRfqPanel(true);
    /* Mounted last, and guarded: the true-up panel reads its own endpoint, and a
     * failure there must leave the RFQ rail above it working. Its container is
     * emptied rather than left saying "Loading" if the script never loaded. */
    if (window.FreightTrueUp) {
      try { await window.FreightTrueUp.mountPanel('ftuReviewPanel', p.id, v.id, user); }
      catch (e3) { document.getElementById('ftuReviewPanel').innerHTML = '<div class="err">Could not load the freight true-up.</div>'; }
    } else {
      var ftuSlot = document.getElementById('ftuReviewPanel');
      if (ftuSlot) { ftuSlot.previousElementSibling.remove(); ftuSlot.remove(); }
    }
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

  /* --- monday customer lookup: pull one customer on demand ---
   *
   * Two callers, one dialog. From the CRM it imports and refreshes the list; from
   * the New proposal form it imports and hands the customer back, so a rep who
   * cannot find their customer in the dropdown does not have to leave the proposal,
   * go to the CRM, import it there, and come back. `opts.onImported` is what tells
   * the two apart — without it the CRM behaviour is exactly as it was.
   */
  function openMondayLookup(user, opts) {
    opts = opts || {};
    var ov = openModal('Find a customer in monday',
      '<div class="field"><label for="mSearch">Customer name</label>' +
        '<input id="mSearch" style="' + IN + '" placeholder="e.g. Soar Autism Center" value="' + esc(opts.q || crm.q || '') + '" autocomplete="off"></div>' +
      '<div id="mResults" class="muted" style="font-size:13px;padding:6px 0;">Type a name and press Search.</div>',
      async function (close, showErr) { await run(); var s = document.getElementById('mSave'); if (s) { s.disabled = false; s.textContent = 'Search'; } },
      'Search');

    // Scoped to this overlay, per the note in openModal: two dialogs can be on
    // screen at once and getElementById returns the older node.
    var input = ov.querySelector('#mSearch');
    var box = ov.querySelector('#mResults');
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
            '<button class="link-btn mImp" data-id="' + esc(x.itemId) + '" data-name="' + esc(x.name) + '" style="width:auto;padding:6px 12px;white-space:nowrap;">Import</button>' +
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
              // From the proposal form the customer goes back to the caller; from the
              // CRM the list refreshes, as before.
              // The name comes off the button, not from the row that drew it: these
              // handlers are wired in a second pass, where the row variable is out of
              // scope. Reading it there threw after a perfectly good import and the
              // catch below reported "Failed".
              if (opts.onImported) {
                // Close this dialog before handing back, or the form that reopens
                // stacks on top of it and duplicates its field ids.
                if (ov.parentNode) ov.parentNode.removeChild(ov);
                opts.onImported(b.getAttribute('data-name') || '');
                return;
              }
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

  /**
   * The same idea as renderKeepingTab, for a repaint that has to fetch first.
   *
   * renderKeepingTab assumes `render` rebuilds the DOM synchronously. A panel
   * that re-reads the order from the server does not, so the caret restore ran
   * against the old markup and was lost. This awaits the repaint before looking
   * for the field again — which is what makes saving-as-you-type usable: the
   * totals update under you without the caret jumping out of the box.
   */
  async function repaintKeepingFocus(repaint, host, sel) {
    var dir = tabDir;
    var was = document.activeElement, range = null;
    try { range = was && was.selectionStart != null ? [was.selectionStart, was.selectionEnd] : null; } catch (e) {}
    await repaint();
    var root = typeof host === 'function' ? host() : host;
    if (!root) return;
    var same = null;
    try { same = sel ? root.querySelector(sel) : null; } catch (e2) { same = null; }
    if (!same) return;
    if (dir) {
      var list = focusablesIn(root);
      var i = list.indexOf(same);
      var next = i === -1 ? null : list[dir === 'fwd' ? i + 1 : i - 1];
      if (next) { next.focus(); try { next.select(); } catch (e3) {} return; }
    }
    same.focus();
    try { if (range) same.setSelectionRange(range[0], range[1]); } catch (e4) {}
  }

  /* ---- Canadian Customer ---------------------------------------------------
   *
   * One switch. Ticking it makes this a Canadian job end to end: the customer's
   * billing country becomes CA (which is the only thing the pricing engine reads —
   * Bill to above is document text), cross-border pricing is switched on company-wide
   * if it was off, percent entry is permitted, and this proposal gets the province's
   * standard tax rate as a starting figure. Unticking it takes all of that back off
   * the proposal.
   *
   * Everything it does is in one server call, so a half-configured Canadian proposal
   * cannot exist because a second request failed. */
  var canState = null;

  /** 'Calgary, AB T2A5N7' out of the Bill to / Ship to box, to prefill the dialog. */
  function guessAddressLines() {
    var raw = String((pb && pb.meta && (pb.meta.billTo || pb.meta.shipTo)) || '').trim();
    if (!raw) return null;
    var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    var last = lines[lines.length - 1];
    var m = /^(.*?),\s*([A-Za-z]{2}|[A-Za-z][A-Za-z ]+?)\s+([A-Za-z0-9][A-Za-z0-9 -]{2,9})$/.exec(last);
    return {
      line1: lines[0] || '',
      city: m ? m[1] : '',
      region: m ? m[2] : '',
      postalCode: m ? m[3] : '',
    };
  }

  function paintCanadian() {
    var host = document.getElementById('pbJurisRow');
    if (!host) return;
    // A proposal with no saved version has nothing to attach Canadian figures to yet.
    if (!pb || !pb.versionId) {
      host.innerHTML =
        '<span class="muted" style="font-size:11.5px;">Save the proposal to mark this a Canadian customer.</span>';
      return;
    }
    if (!canState || canState.versionId !== pb.versionId) {
      host.innerHTML = '<span class="muted" style="font-size:12px;">Checking the customer\u2019s country\u2026</span>';
      return;
    }
    var on = !!canState.canadian;
    var note = on
      ? 'Priced as a Canadian job \u00b7 ' +
        esc(canState.province || 'province not set') +
        (canState.taxPercent != null
          ? ' \u00b7 ' + esc(canState.taxLabel || 'tax') + ' ' + esc(String(canState.taxPercent)) + '%'
          : '') +
        '. Tariff, brokerage and the CAD column are on the Customs and duties panel.'
      : 'Priced as a domestic US job \u2014 no Canadian tax, tariff or CAD column.';
    host.innerHTML =
      '<label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer;">' +
      '<input type="checkbox" id="pbCanadian"' + (on ? ' checked' : '') + '>' +
      '<b style="font-weight:600;">Canadian Customer</b></label>' +
      '<span style="font-size:11.5px;color:' + (on ? '#2f6b4f' : '#8a8f85') + ';">' + note + '</span>';
    var cb = document.getElementById('pbCanadian');
    if (cb) cb.addEventListener('change', function () { onCanadianToggle(cb); });
  }

  async function loadCanadian(force) {
    if (!pb || !pb.versionId || (typeof isMock === 'function' && isMock())) return;
    if (!force && canState && canState.versionId === pb.versionId) { paintCanadian(); return; }
    var r = await authed('/proposals/versions/' + pb.versionId + '/canadian-customer');
    if (!r.ok) { var h = document.getElementById('pbJurisRow'); if (h) h.innerHTML = ''; return; }
    var d = await r.json();
    d.versionId = pb.versionId;
    canState = d;
    paintCanadian();
  }

  async function postCanadian(payload) {
    var r = await authed('/proposals/versions/' + pb.versionId + '/canadian-customer', {
      method: 'POST',
      body: payload,
    });
    if (!r.ok) {
      var msg = 'That could not be saved.';
      try { var j = await r.json(); msg = j.message || j.error || msg; } catch (e) {}
      return { ok: false, message: msg };
    }
    return { ok: true, data: await r.json() };
  }

  function canadianDoneToast(d) {
    var extra = [];
    if (d.enabledFeature) extra.push('cross-border pricing switched on');
    if (d.allowedSimple) extra.push('percent entry permitted');
    toast(
      'Canadian customer \u00b7 ' +
        d.province +
        (d.taxPercent != null ? ' \u00b7 ' + (d.taxLabel || 'tax') + ' ' + d.taxPercent + '%' : '') +
        (extra.length ? ' (' + extra.join(', ') + ')' : '') +
        '. Check the figures on Customs and duties before this goes out.',
    );
  }

  async function onCanadianToggle(cb) {
    if (!pb || !pb.versionId) return;
    cb.disabled = true;

    if (!cb.checked) {
      if (
        !confirm(
          'Remove the Canadian tax, tariff and brokerage figures from this proposal, and put this customer back to a US billing address?',
        )
      ) {
        cb.checked = true;
        cb.disabled = false;
        return;
      }
      var off = await postCanadian({ canadian: false });
      cb.disabled = false;
      if (!off.ok) { cb.checked = true; toast(off.message, true); return; }
      await loadCanadian(true);
      await loadCrossBorder(true);
      toast('Back to a domestic US job. The Canadian figures have been cleared.');
      return;
    }

    // A billing address already on file with a province the engine recognizes needs no
    // dialog — the switch is the whole interaction.
    var st = canState || {};
    var bl = st.billing;
    cb.disabled = false;
    if (st.province && bl && bl.line1 && bl.city && bl.postalCode) {
      cb.disabled = true;
      var direct = await postCanadian({ canadian: true });
      cb.disabled = false;
      if (!direct.ok) { cb.checked = false; toast(direct.message, true); return; }
      await loadCanadian(true);
      await loadCrossBorder(true);
      canadianDoneToast(direct.data);
      return;
    }
    cb.checked = false;
    openCanadianDialog();
  }

  /* Asked for once, on the first Canadian proposal for this customer: the billing
   * address the engine reads, and the tax rate to quote from. The province drives the
   * rate, so choosing one fills the two tax boxes in. */
  function openCanadianDialog() {
    var st = canState || {};
    var rates = st.provinceRates || {};
    var b = st.billing || guessAddressLines() || {};
    var lbl = 'font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;display:block;margin-bottom:3px;';
    var box = 'width:100%;padding:9px 11px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;';
    var provinces = Object.keys(rates).sort();
    var guessProv = String(b.region || '').toUpperCase();

    openModal(
      'Canadian customer',
      '<div class="muted" style="font-size:12.5px;line-height:1.6;margin-bottom:14px;">' +
        'This is the billing address the pricing engine reads, and the tax rate this proposal quotes from. ' +
        'Saved on the customer, so their next proposal is Canadian from the start.' +
        '</div>' +
        '<div style="margin-bottom:10px;"><label style="' + lbl + '">Street</label>' +
        '<input id="ccLine1" style="' + box + '" value="' + esc(b.line1 || '') + '"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
        '<div style="flex:2;min-width:150px;"><label style="' + lbl + '">City</label>' +
        '<input id="ccCity" style="' + box + '" value="' + esc(b.city || '') + '"></div>' +
        '<div style="flex:1;min-width:120px;"><label style="' + lbl + '">Province</label>' +
        '<select id="ccProv" style="' + box + '">' +
        '<option value="">Choose\u2026</option>' +
        provinces
          .map(function (p) {
            return (
              '<option value="' + p + '"' + (p === guessProv ? ' selected' : '') + '>' +
              p + ' \u00b7 ' + esc(rates[p].label) + ' ' + rates[p].percent + '%</option>'
            );
          })
          .join('') +
        '</select></div>' +
        '<div style="flex:1;min-width:110px;"><label style="' + lbl + '">Postal code</label>' +
        '<input id="ccPostal" style="' + box + '" value="' + esc(b.postalCode || '') + '"></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<div style="flex:1;min-width:150px;"><label style="' + lbl + '">What the tax is called</label>' +
        '<input id="ccTaxLabel" placeholder="HST" style="' + box + '" value="' +
        esc((rates[guessProv] && rates[guessProv].label) || '') + '"></div>' +
        '<div style="flex:1;min-width:110px;"><label style="' + lbl + '">Tax rate %</label>' +
        '<input id="ccTaxPct" inputmode="decimal" style="' + box + '" value="' +
        esc(rates[guessProv] ? String(rates[guessProv].percent) : '') + '"></div>' +
        '</div>' +
        '<div class="muted" style="font-size:11px;line-height:1.55;margin-top:10px;">' +
        'The rate is Summit\u2019s own figure and the proposal says so. Tariff and brokerage are entered on ' +
        'Customs and duties, where these can also be changed.' +
        '</div>',
      async function (close, showError) {
        var prov = document.getElementById('ccProv').value;
        var pctRaw = (document.getElementById('ccTaxPct').value || '').trim();
        var pct = pctRaw === '' ? null : Number(pctRaw.replace(/[^0-9.]/g, ''));
        if (!prov) { showError('Choose the province \u2014 it is what decides the tax.'); return; }
        if (pct != null && !Number.isFinite(pct)) {
          showError('Enter the tax rate as a plain number \u2014 13, or 14.975.');
          return;
        }
        var out = await postCanadian({
          canadian: true,
          address: {
            line1: (document.getElementById('ccLine1').value || '').trim(),
            city: (document.getElementById('ccCity').value || '').trim(),
            region: prov,
            postalCode: (document.getElementById('ccPostal').value || '').trim(),
          },
          taxLabel: (document.getElementById('ccTaxLabel').value || '').trim() || null,
          taxPercent: pct,
        });
        if (!out.ok) { showError(out.message); return; }
        close();
        await loadCanadian(true);
        await loadCrossBorder(true);
        canadianDoneToast(out.data);
      },
      'Make this a Canadian job',
    );

    // Choosing a province fills the tax boxes, unless they have been typed in.
    setTimeout(function () {
      var sel = document.getElementById('ccProv');
      if (!sel) return;
      sel.addEventListener('change', function () {
        var r = rates[sel.value];
        if (!r) return;
        document.getElementById('ccTaxLabel').value = r.label;
        document.getElementById('ccTaxPct').value = String(r.percent);
      });
    }, 0);
  }

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

  /* --- shared table helpers --- */
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
          organizationId: p.organizationId || '', projectId: meta.projectId || '',
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
      .filter(function (r) { return !q || (r.customer + ' ' + r.contact + ' ' + r.title + ' ' + r.number + ' ' + r.preparedBy + ' ' + r.projectId).toLowerCase().indexOf(q) !== -1; });
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
      // Follow-up sits on the row because the list IS the follow-up queue — this is the
      // screen where a rep reads down the past-expiration band deciding who to chase, and
      // sending them into each proposal first to do it costs a page load per customer.
      // Offered only while a proposal is still live or lapsed: a follow-up sequence has
      // nothing to say to an accepted or rejected deal.
      var followUp = !r.archivedAt && (OPEN_STATUSES.indexOf(r.status) !== -1 || r.status === 'EXPIRED') && r.organizationId
        ? '<button class="pFollowUp" data-id="' + r.id + '" title="Pick a follow-up email for this customer, and see which ones they have already had" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 9px;font-size:12px;color:#3d4a55;cursor:pointer;white-space:nowrap;">Follow-up…</button>'
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
        ptd('<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">' + followUp + reengage + quick + arch + '</div>', 'right', 'padding:8px 11px;') + '</tr>';
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
    box.querySelectorAll('button.pFollowUp').forEach(function (bt) {
      bt.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = props.rows.filter(function (r) { return r.id === bt.getAttribute('data-id'); })[0];
        if (row) openFollowUpPicker(row, user);
      });
    });
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
        // No button to relabel here, so the notice carries the progress instead.
        if (act === 'release') toast('Building the proposal document…');
        var rr = await authed(path, { method: 'POST', body: await actionBody(act, id, vid) });
        if (!rr.ok) { alert(await serverMessage(rr, 'Could not update (' + rr.status + ').')); sel.disabled = false; sel.value = ''; return; }
        startReleaseAttachment(act, rr);
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
        // The document itself is NOT sent here. pushReleasedProposal receives
        // proposalHtml and does nothing with it but log that the document follows
        // from the renderer — the PDF is made by the second call, against the
        // render function. So this used to upload several megabytes of base64
        // photographs, twice, and use them once: the first copy sat in front of
        // the status change doing nothing but making it slower. The filename stays
        // because it costs nothing and names the file the renderer will attach.
        return { proposalFilename: doc.filename };
      }
    } catch (e) {}
    return {};
  }

  /**
   * The document's trip to the deal board, after the release itself is finished.
   *
   * Deliberately NOT awaited. The release is complete the moment the status has
   * changed; rendering the PDF and uploading it takes longer than everything
   * before it put together, and holding the page for it made a finished release
   * look like a stuck one.
   *
   * A failure here costs the attachment, never the release, so it is reported and
   * never thrown. The notice names the file, because by the time it arrives the rep
   * may be on an unrelated screen — an unattributed failure there reads as that
   * screen's bug.
   */
  function startReleaseAttachment(act, rr) {
    if (act !== 'release') return;
    // Captured synchronously, before any await: releasing a second proposal while
    // the first is still uploading would otherwise attach the wrong document.
    var doc = lastReleaseDoc;
    lastReleaseDoc = null;
    (async function () {
      var d = null;
      try { d = await rr.json(); } catch (e) { return; }
      var m = d && d.monday;
      if (!m) return;
      if (!m.pushed) {
        toast('Released. monday.com was not updated: ' +
          (m.skipped || m.error || 'the deal board did not respond') + '.', 1);
        return;
      }
      if (!doc) return;
      var who = doc.filename || 'the proposal';
      toast('Released. Attaching ' + who + ' to monday…');
      var note = '';
      try {
        var fr = await authed('/render/proposals/versions/' + doc.versionId + '/monday-file', {
          method: 'POST',
          body: { proposalHtml: doc.html, filename: doc.filename },
          timeoutMs: RENDER_TIMEOUT_MS,
        });
        var fd = fr.ok ? await fr.json() : null;
        if (!fr.ok) note = await serverMessage(fr, 'the renderer did not respond (' + fr.status + ')');
        else if (!fd || !fd.uploaded) note = (fd && (fd.skipped || fd.error)) || 'monday did not accept the file';
      } catch (e) { note = (e && e.message) || 'the renderer could not be reached'; }
      if (note) toast('The deal row was updated, but ' + who + ' did not attach: ' + note + '.', 1);
      else toast(who + ' is attached to the deal.');
    })();
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
    var vItems = (version && version.items) || [];
    var vCounted = countedRevenueByIndex(vItems);
    var subtotal = 0, tpFreight = 0;
    vItems.forEach(function (l, i) {
      if ((l.lineType || 'PRODUCT') !== 'PRODUCT') return;
      subtotal += vCounted[i];
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
  /**
   * Pick a follow-up email, copy it, log it.
   *
   * The ten templates run in a deliberate order — financing is not raised until
   * budget is known to be the obstacle, and a concession is not hinted at until the
   * gap is known to be small — so the picker leads with the sequence number and the
   * "when to send" line rather than just a list of subjects.
   *
   * Copy rather than send. The rep pastes into Outlook and sends from their own
   * mailbox, so the reply comes back to them and the mail is not a machine's. Two
   * clipboard flavours go on at once: text/html keeps the paragraphs and the bolded
   * question when pasted into Outlook, text/plain covers anything that refuses HTML.
   *
   * Nothing is blocked. The history is shown against each template and the rep
   * decides — a hard block would be wrong the first time a project restarts a year
   * later or the contact changes.
   */
  async function openFollowUpPicker(row, user) {
    var orgId = row.organizationId;
    if (!orgId) { alert('This proposal has no customer on it.'); return; }

    var ov = null;
    var $ = function (sel) { return ov ? ov.querySelector(sel) : null; };
    var d = null;
    var selectedKey = null;

    var url = function (contactId) {
      return '/crm/organizations/' + orgId + '/follow-ups' +
        '?proposalId=' + encodeURIComponent(row.id) +
        (contactId ? '&contactId=' + encodeURIComponent(contactId) : '');
    };

    var load = async function (contactId) {
      var r = await authed(url(contactId));
      if (!r.ok) {
        var box = $('#fuBody');
        if (box) box.innerHTML = '<div class="err">Could not load the templates (' + r.status + '). Run migration 0052 if this persists.</div>';
        return;
      }
      d = await r.json();
      draw();
    };

    ov = openModal('Follow-up email — ' + (row.customer || 'customer'),
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:12px;">' +
        'Pick a template and open it in Outlook — already addressed, with the subject and body filled in. It sends from your mailbox, so the reply comes back to you. ' +
        'The history below each one is per customer, so a second proposal does not reset it.</div>' +
      '<div id="fuBody"><div class="muted" style="font-size:12.5px;padding:12px 0;">Loading…</div></div>',
      null, 'Done', { maxWidth: '760px' });

    var fmtWhen = function (iso) {
      try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
      catch (e) { return String(iso || '').slice(0, 10); }
    };

    function draw() {
      var box = $('#fuBody');
      if (!box || !d) return;
      var contacts = d.contacts || [];
      if (!contacts.length) {
        box.innerHTML = '<div class="muted" style="font-size:13px;line-height:1.6;">No contact on ' +
          esc(d.customer.name) + ' has an email address, so there is nobody to address this to. Add one under CRM → Contacts, then come back.</div>';
        return;
      }
      var sel = d.selectedContactId;

      var rows = (d.templates || []).map(function (t) {
        var chosen = t.key === selectedKey;
        var sent = t.lastSent;
        return '<div class="fuRow" data-key="' + t.key + '" style="border:1px solid ' + (chosen ? '#203060' : '#e7e8e3') + ';border-radius:10px;padding:10px 12px;margin-bottom:7px;cursor:pointer;background:' + (chosen ? '#f3f6fb' : '#fff') + ';">' +
          '<div style="display:flex;gap:10px;align-items:baseline;">' +
            '<div style="font-family:Georgia,serif;font-size:12px;font-weight:700;color:' + (sent ? '#9aa1b0' : '#d02030') + ';flex:none;width:16px;">' + String(t.step < 10 ? '0' + t.step : t.step) + '</div>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13.5px;font-weight:600;color:#203060;">' + esc(t.name) +
                (sent ? ' <span class="chip" style="font-size:10.5px;background:#f2f3ef;color:#7b8190;">Sent ' + esc(fmtWhen(sent.copiedAt)) + '</span>' : '') +
                (t.sentCount > 1 ? ' <span class="muted" style="font-size:11px;">×' + t.sentCount + '</span>' : '') + '</div>' +
              '<div class="muted" style="font-size:11.5px;line-height:1.45;margin-top:1px;">' + esc(t.whenToSend) + '</div>' +
              (sent ? '<div class="muted" style="font-size:11.5px;">Last to ' + esc(sent.toName || sent.toEmail) + (sent.by ? ' by ' + esc(sent.by) : '') + '</div>' : '') +
              (t.caution ? '<div style="font-size:11.5px;color:#8a6d1f;line-height:1.45;margin-top:3px;">' + esc(t.caution) + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');

      var chosenT = (d.templates || []).filter(function (t) { return t.key === selectedKey; })[0];

      box.innerHTML =
        '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:12px;">' +
          '<div style="flex:1;"><div class="k">To</div><select id="fuTo" style="' + IN + '">' +
            contacts.map(function (c) {
              return '<option value="' + c.id + '"' + (c.id === sel ? ' selected' : '') + '>' +
                esc(c.name + ' <' + c.email + '>') + (c.isDecisionMaker ? ' — decision maker' : '') + '</option>';
            }).join('') + '</select></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;">' +
          '<div style="max-height:52vh;overflow:auto;">' + rows + '</div>' +
          '<div id="fuPreview" style="position:sticky;top:0;">' +
            (chosenT
              ? '<div class="k">Subject</div>' +
                '<div style="font-size:13px;font-weight:600;color:#20241f;line-height:1.4;margin-bottom:10px;">' + esc(chosenT.subject) + '</div>' +
                '<div style="border:1px solid #e7e8e3;border-radius:10px;padding:12px 14px;background:#fff;max-height:34vh;overflow:auto;font-size:12.5px;line-height:1.5;">' + chosenT.html + '</div>' +
                '<div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:8px;">' + esc(chosenT.objective) + ' · ' + esc(chosenT.angle) + '</div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
                  '<button type="button" class="btn" id="fuOutlook" style="width:auto;padding:9px 16px;">Open in Outlook</button>' +
                  '<button type="button" class="link-btn" id="fuPlain" style="width:auto;padding:9px 15px;" title="Opens your mail client directly. Plain text — the bold on the question is lost.">Open as plain text</button>' +
                  '<button type="button" class="link-btn" id="fuCopy" style="width:auto;padding:9px 15px;">Copy instead</button>' +
                '</div>' +
                '<label style="display:flex;align-items:center;gap:7px;margin-top:9px;font-size:12px;cursor:pointer;">' +
                  '<input type="checkbox" id="fuLog" checked> Record it in this customer’s history</label>' +
                '<div id="fuMsg" class="muted" style="font-size:12px;margin-top:8px;line-height:1.5;"></div>'
              : '<div class="muted" style="font-size:12.5px;line-height:1.55;padding:12px;border:1px dashed #dcded7;border-radius:10px;">Pick a template on the left to read it before you copy it.</div>') +
          '</div>' +
        '</div>' +
        ((d.history || []).length
          ? '<div class="k" style="margin-top:16px;">Everything sent to this customer</div>' +
            '<div style="max-height:22vh;overflow:auto;">' +
            (d.history || []).map(function (h) {
              return '<div style="display:flex;gap:10px;align-items:baseline;padding:5px 0;border-bottom:1px solid #f2f3ef;font-size:12px;">' +
                '<div class="muted" style="flex:none;width:96px;">' + esc(fmtWhen(h.copiedAt)) + '</div>' +
                '<div style="flex:1;min-width:0;"><b style="font-weight:600;">' + esc(h.templateName) + '</b> ' +
                  '<span class="muted">to ' + esc(h.toName || h.toEmail) + (h.by ? ' · ' + esc(h.by) : '') + '</span></div>' +
                '<button type="button" class="fuDel link-btn" data-id="' + h.id + '" style="flex:none;width:auto;padding:3px 8px;font-size:11px;color:#a2402f;">Remove</button>' +
              '</div>';
            }).join('') + '</div>'
          : '');

      var msg = function (t, bad) {
        var el = $('#fuMsg');
        if (el) { el.style.color = bad ? '#9c3327' : '#2f7d5d'; el.textContent = t; }
      };
      var wantsLog = function () { var el = $('#fuLog'); return !el || el.checked; };

      box.querySelectorAll('.fuRow').forEach(function (el) {
        el.addEventListener('click', function () { selectedKey = el.getAttribute('data-key'); draw(); });
      });

      var toEl = $('#fuTo');
      if (toEl) toEl.addEventListener('change', function () { load(toEl.value); });

      // Two flavours in one clipboard item, so Outlook takes the HTML and a plain
      // editor still gets readable text. The async Clipboard API is the only way to
      // put text/html on the clipboard without a contenteditable hack; where it is
      // unavailable we fall back to a hidden selection copy, which also carries HTML.
      var copy = async function () {
        var html = chosenT.html, text = chosenT.text;
        try {
          if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' }),
            })]);
            return true;
          }
        } catch (e) {}
        try {
          var holder = document.createElement('div');
          holder.setAttribute('contenteditable', 'true');
          holder.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:normal;';
          holder.innerHTML = html;
          document.body.appendChild(holder);
          var range = document.createRange();
          range.selectNodeContents(holder);
          var s2 = window.getSelection();
          s2.removeAllRanges();
          s2.addRange(range);
          var ok = document.execCommand('copy');
          s2.removeAllRanges();
          document.body.removeChild(holder);
          return ok;
        } catch (e2) { return false; }
      };

      var contactOf = function () {
        var id = $('#fuTo') ? $('#fuTo').value : null;
        return contacts.filter(function (c) { return c.id === id; })[0] || contacts[0];
      };

      var logIt = async function () {
        var to = contactOf();
        var r = await authed('/crm/organizations/' + orgId + '/follow-ups', {
          method: 'POST',
          body: {
            templateKey: chosenT.key, proposalId: row.id,
            toEmail: to.email, toName: to.name, subject: chosenT.subject,
          },
        });
        return r.ok;
      };

      /**
       * Hand Outlook a real draft.
       *
       * The .eml comes from the server carrying X-Unsent, which is what makes Outlook open
       * it as an editable, already-addressed draft rather than as a received message the
       * rep would have to forward. It is fetched rather than linked because the route
       * needs the auth header, so the response becomes a blob URL and a synthetic click
       * hands it to whatever the machine has registered for .eml.
       */
      var draftQuery = function (to) {
        return '?proposalId=' + encodeURIComponent(row.id) +
          (to && to.id ? '&contactId=' + encodeURIComponent(to.id) : '');
      };
      var draftBase = function () {
        return '/crm/organizations/' + orgId + '/follow-ups/' + encodeURIComponent(chosenT.key);
      };

      /* The fallback: download the .eml and let Windows hand it to Outlook. Kept because a
       * lapsed OAuth grant must not be the reason a rep cannot follow up on a proposal. */
      var downloadEml = async function (to, prefix) {
        var r = await authed(draftBase() + '/draft.eml' + draftQuery(to));
        if (!r.ok) { msg('Could not build the draft (' + r.status + ').', 1); return; }
        var blob = await r.blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = chosenT.step + '-' + chosenT.key + '.eml';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 4000);
        var logged = wantsLog() ? await logIt() : null;
        if (logged === false) { msg('Draft downloaded, but the history line failed. Record it by hand.', 1); return; }
        msg((prefix || 'Draft downloaded — open it and Outlook will have it addressed and ready.') + (logged ? ' Logged.' : ''));
        if (logged) await load(to && to.id ? to.id : null);
      };

      /**
       * Hand Outlook a real draft.
       *
       * First choice is Microsoft Graph: the message is written straight into the rep's
       * mailbox and the returned link opens it. No file, no download, and the draft is in
       * Drafts on every device at once. If the mailbox is not connected the server answers
       * 409 and we fall back to the .eml download, saying which happened rather than
       * silently doing something different from what the button offered.
       *
       * The blank tab is opened SYNCHRONOUSLY, inside the click, because a popup opened
       * after an await is not attributed to the gesture and every browser blocks it. It is
       * closed again if we end up on the download path.
       */
      var openInOutlook = async function () {
        msg('Building the draft…');
        var to = contactOf();
        var tab = null;
        try { tab = window.open('', '_blank'); } catch (e) { tab = null; }
        if (tab) {
          try {
            tab.document.write('<title>Opening your draft…</title>' +
              '<body style="font-family:system-ui;padding:40px;color:#82877d;">Opening your draft…</body>');
            tab.document.close();
          } catch (e) {}
        }

        var r = await authed(draftBase() + '/draft-in-outlook' + draftQuery(to), { method: 'POST', body: {} });
        if (r.status === 409 || r.status === 404) {
          if (tab) { try { tab.close(); } catch (e) {} }
          await downloadEml(to, 'Outlook is not connected, so the draft downloaded as a file instead. Connect it under Administration to skip the download.');
          return;
        }
        if (!r.ok) {
          if (tab) { try { tab.close(); } catch (e) {} }
          msg(await serverMessage(r, 'Could not create the draft (' + r.status + ').'), 1);
          return;
        }
        var d = null; try { d = await r.json(); } catch (e) {}
        if (!d || !d.webLink) {
          if (tab) { try { tab.close(); } catch (e) {} }
          msg('The draft was created but Outlook did not say where.', 1);
          return;
        }
        if (tab) tab.location.href = d.webLink; else window.open(d.webLink, '_blank');
        var logged = wantsLog() ? await logIt() : null;
        if (logged === false) { msg('Draft is in your Drafts folder, but the history line failed. Record it by hand.', 1); return; }
        msg('Draft created in ' + (d.mailbox || 'your mailbox') + ' — it is open in Outlook and in your Drafts folder.' + (logged ? ' Logged.' : ''));
        if (logged) await load(to && to.id ? to.id : null);
      };

      /**
       * The mailto: route. No download step, but plain text only: the standard has no
       * provision for HTML and Outlook ignores any attempt at it, so the bold on the
       * question is lost. Offered because for a short email it is the fastest path, and
       * these emails are plain by design anyway.
       */
      var openPlain = async function () {
        var to = contactOf();
        var href = 'mailto:' + encodeURIComponent(to.email) +
          '?subject=' + encodeURIComponent(chosenT.subject) +
          '&body=' + encodeURIComponent(chosenT.text);
        // Some clients truncate a long mailto. Say so rather than let a half-written
        // email reach a customer.
        if (href.length > 1900) {
          msg('This one is long enough that a mailto link may be truncated — use Open in Outlook instead.', 1);
          return;
        }
        var a = document.createElement('a');
        a.href = href;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); }, 0);
        var logged = wantsLog() ? await logIt() : null;
        if (logged === false) { msg('Opened, but the history line failed.', 1); return; }
        msg('Opened in your mail client.' + (logged ? ' Logged.' : ''));
        if (logged) await load(to && to.id ? to.id : null);
      };

      var onCopy = async function () {
        var ok = await copy();
        if (!ok) { msg('The browser blocked the copy. Select the preview text and copy it by hand.', 1); return; }
        var logged = wantsLog() ? await logIt() : null;
        if (logged === false) { msg('Copied, but the history line failed.', 1); return; }
        msg('Copied.' + (logged ? ' Logged.' : ''));
        if (logged) await load($('#fuTo') ? $('#fuTo').value : null);
      };

      var ol = $('#fuOutlook'); if (ol) ol.addEventListener('click', openInOutlook);
      var pl = $('#fuPlain'); if (pl) pl.addEventListener('click', openPlain);
      var cp = $('#fuCopy'); if (cp) cp.addEventListener('click', onCopy);

      box.querySelectorAll('.fuDel').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!confirm('Remove this line from the follow-up history?\n\nUse this for a mis-click — the log is meant to be complete, and the removal is audited.')) return;
          var r = await authed('/follow-ups/' + b.getAttribute('data-id'), { method: 'DELETE' });
          if (!r.ok && r.status !== 204) { alert('Could not remove it (' + r.status + ').'); return; }
          load($('#fuTo') ? $('#fuTo').value : null);
        });
      });
    }

    load(null);
  }

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
            '<button class="link-btn" id="propFollowUp" style="width:auto;padding:10px 17px;">Follow-up email…</button>' +
            '<button class="link-btn" id="propEmail" style="width:auto;padding:10px 17px;">Write an email…</button>' +
            '<div class="muted" style="font-size:12.5px;max-width:520px;line-height:1.55;">Send documents attaches the proposal or the financing sheet and records the send. Follow-up email picks from the ten templates and shows which this customer has already had. Write an email opens a plain draft in Outlook for anything else.</div>' +
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
    var pfu = document.getElementById('propFollowUp');
    if (pfu) pfu.addEventListener('click', function () {
      openFollowUpPicker({
        id: p.id, organizationId: p.organizationId, number: p.number || '', title: p.title || '',
        customer: p.organizationName || '',
      }, user);
    });
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
        var stage = actionProgress(bt);
        bt.disabled = true;
        // Two stages, because they fail differently and take different lengths of
        // time: the document is built here in the browser before any request goes
        // out, and on a proposal with introduction photographs that alone is
        // several seconds of apparently nothing happening.
        if (act === 'release') stage('Preparing…', 'Building the proposal document…');
        var body = await actionBody(act, id, vid);
        if (act === 'release') stage('Releasing…', 'Recording the release and updating the deal board…');
        var rr = await authed(path, { method: 'POST', body: body });
        if (!rr.ok) { stage(null); bt.disabled = false; alert(await serverMessage(rr, 'Action failed (' + rr.status + ').')); return; }
        stage(null);
        startReleaseAttachment(act, rr);
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
  /**
   * New proposal.
   *
   * The organization list is sorted here rather than trusted from the API:
   * /crm/organizations returns its own paging order, and a rep scanning a hundred
   * entries needs them alphabetical. localeCompare with sensitivity 'base', so "The
   * Therapy Place" and "the therapy place" sort next to each other rather than by
   * byte value.
   *
   * `preselectName` is the return leg of the monday lookup: the customer just
   * imported is the one selected when the form reopens, because a rep who went
   * looking for one specific customer should not have to find them a second time.
   */
  var ORG_PICK_PAGE = 500;
  function sortOrgs(list) {
    return list.slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }); });
  }
  async function fetchOrgs(q) {
    try {
      var r = await authed('/crm/organizations?pageSize=' + ORG_PICK_PAGE + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!r.ok) return [];
      return sortOrgs((await r.json()).items || []);
    } catch (e) { return []; }
  }
  /** Opportunities carry the Project ID; see GET /crm/opportunities. */
  async function fetchOpportunities(q) {
    try {
      var r = await authed('/crm/opportunities?pageSize=' + ORG_PICK_PAGE + (q ? '&q=' + encodeURIComponent(q) : ''));
      if (!r.ok) return [];
      return (await r.json()).items || [];
    } catch (e) { return []; }
  }
  /**
   * One row per project, the thing a rep is actually choosing when a customer has
   * more than one running concurrently — not one row per customer, which gave no way
   * to say which of several proposals-in-progress a new one belonged to. A customer
   * with no opportunity yet (created by hand, or imported before one existed) still
   * gets exactly one row, carrying the organization alone, so starting a proposal
   * never requires creating a project first.
   */
  function buildPickRows(orgs, opps) {
    // Keyed on the union of both lists' organization ids, not just `orgs` — a search
    // that matches an opportunity by Project ID but not its customer by name (an org
    // search and a Project ID search are two different queries against two different
    // endpoints) must still surface that project, using the org name the opportunity
    // itself carries rather than dropping it for not being in the other list.
    var byOrg = {}, orgName = {};
    orgs.forEach(function (org) { orgName[org.id] = org.name; if (!byOrg[org.id]) byOrg[org.id] = []; });
    opps.forEach(function (o) {
      if (!byOrg[o.organizationId]) byOrg[o.organizationId] = [];
      byOrg[o.organizationId].push(o);
      if (!orgName[o.organizationId]) orgName[o.organizationId] = o.organizationName;
    });
    var rows = [];
    Object.keys(byOrg).forEach(function (orgId) {
      var theirs = byOrg[orgId];
      if (!theirs.length) {
        rows.push({ organizationId: orgId, opportunityId: '', orgName: orgName[orgId] || '', projectId: '', closed: false });
        return;
      }
      theirs.forEach(function (o) {
        rows.push({ organizationId: orgId, opportunityId: o.id, orgName: orgName[orgId] || o.organizationName || '', projectId: o.projectId || '', closed: !!o.closed });
      });
    });
    rows.sort(function (a, b) {
      return String(a.orgName).localeCompare(String(b.orgName), undefined, { sensitivity: 'base' }) ||
        String(a.projectId).localeCompare(String(b.projectId), undefined, { numeric: true });
    });
    return rows;
  }
  function pickRowLabel(esc, row) {
    return esc(row.orgName) +
      (row.projectId ? ' — Project ' + esc(row.projectId) : '') +
      (row.closed ? ' (Closed)' : '');
  }
  async function openProposalForm(user, preselectName) {
    var orgs = await fetchOrgs('');
    var opps = await fetchOpportunities('');
    var rows = buildPickRows(orgs, opps);
    var canFind = canCrmWrite(user.role);
    // With the monday lookup available, an empty CRM is no longer a dead end.
    if (!rows.length && !canFind) { alert('Create an organization first.'); return; }

    // Only preselect when the name is unambiguous. A customer running two concurrent
    // projects now has two rows here on purpose — that used to be exactly the case
    // where a name match silently picked the wrong one, with nothing on screen to
    // say a choice was even made for you. Left blank instead, so the rep — who came
    // through this path specifically to tell two projects apart — picks explicitly.
    var wanted = String(preselectName || '').trim().toLowerCase();
    var nameMatches = wanted ? rows.filter(function (r) { return String(r.orgName || '').trim().toLowerCase() === wanted; }) : [];
    var selectedKey = nameMatches.length === 1 ? (nameMatches[0].opportunityId || nameMatches[0].organizationId) : '';
    function rowKey(r) { return r.opportunityId || r.organizationId; }

    var ov = openModal('New proposal',
      fieldRow('Organization',
        '<input id="fOrgFilter" style="' + IN + 'margin-bottom:7px;" placeholder="Type to search customers or a project ID…" autocomplete="off">' +
        '<select id="fOrg" size="1" style="' + IN + '">' +
          (rows.length ? '' : '<option value="">No organizations yet — find one in monday</option>') +
          rows.map(function (r) { return '<option value="' + esc(rowKey(r)) + '" data-org="' + esc(r.organizationId) + '" data-opp="' + esc(r.opportunityId) + '"' + (rowKey(r) === selectedKey ? ' selected' : '') + '>' + pickRowLabel(esc, r) + '</option>'; }).join('') +
        '</select>' +
        (canFind ? '<button type="button" class="link-btn" id="fOrgMonday" style="width:auto;padding:6px 0;margin-top:6px;font-size:12.5px;">Not listed? Find a customer in monday</button>' : '')) +
      fieldRow('Title', '<input id="fTitle" style="' + IN + '" required>'),
      async function (close, showErr) {
        var opt = ov.querySelector('#fOrg').selectedOptions[0];
        var orgId = opt ? opt.getAttribute('data-org') : '';
        if (!orgId) return showErr('Pick an organization, or find one in monday first.');
        var opportunityId = opt.getAttribute('data-opp') || undefined;
        var title = ov.querySelector('#fTitle').value.trim(); if (title.length < 2) return showErr('Title must be at least 2 characters.');
        var r = await authed('/proposals', { method: 'POST', body: { organizationId: orgId, opportunityId: opportunityId, title: title, sections: [], items: [] } });
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); renderProposals(user);
      });

    /*
     * Typing narrows the list. The first pass is local, so it responds on the
     * keystroke; the server is then always asked too, once there is enough to search
     * on, and its answer replaces the working list.
     *
     * The server is asked even when the local pass already found something — it used
     * to skip the lookup whenever ANY local match existed, on the assumption that a
     * local hit meant the search was already satisfied. It does not: the snapshot is
     * loaded once when this dialog opens, so an organization or project created or
     * imported since then (most often one sharing a name with something already in
     * that snapshot, the exact case where the rep is searching hardest to tell them
     * apart) matched nothing locally except its stale twin, and the search never went
     * further to find it. The dropdown always ends up with the freshest answer either
     * way, since paintOrgs runs again the moment the server responds.
     */
    var filterEl = ov.querySelector('#fOrgFilter');
    var selEl = ov.querySelector('#fOrg');
    var lookupTimer = null;
    function paintOrgs(list, q) {
      selEl.innerHTML = list.length
        ? list.map(function (r) { return '<option value="' + esc(rowKey(r)) + '" data-org="' + esc(r.organizationId) + '" data-opp="' + esc(r.opportunityId) + '">' + pickRowLabel(esc, r) + '</option>'; }).join('')
        : '<option value="">No customer matches “' + esc(q || '') + '”</option>';
    }
    filterEl.addEventListener('input', function () {
      var q = filterEl.value.trim();
      var qq = q.toLowerCase();
      var local = qq ? rows.filter(function (r) { return (r.orgName + ' ' + r.projectId).toLowerCase().indexOf(qq) !== -1; }) : rows;
      paintOrgs(local, q);
      if (lookupTimer) clearTimeout(lookupTimer);
      if (qq.length < 2) return;
      lookupTimer = setTimeout(async function () {
        var foundOrgs = await fetchOrgs(q);
        var foundOpps = await fetchOpportunities(q);
        if (filterEl.value.trim() !== q) return; // they kept typing
        // Replace on a real answer; a failed fetch already comes back as [] from
        // fetchOrgs/fetchOpportunities, and leaving the local (if stale) results up
        // beats wiping the list to "no matches" over what might just be a dropped
        // request. Either list finding something is enough to rebuild: a search that
        // matches only a monday deal's Project ID comes back with opportunities but
        // no newly-matching organizations at all, and still has to show something.
        if (foundOrgs.length || foundOpps.length) {
          rows = buildPickRows(foundOrgs, foundOpps);
          paintOrgs(rows, q);
        }
      }, 250);
    });

    if (canFind) {
      ov.querySelector('#fOrgMonday').addEventListener('click', function () {
        // The detour to monday must not cost the rep the title they already typed.
        var typed = ov.querySelector('#fTitle');
        var titleAtOpen = typed ? typed.value : '';
        // This dialog goes away first. Leaving it open stacked three overlays with
        // two #fTitle inputs between them, and Create then read the empty one and
        // reported a title that was plainly typed as too short.
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        openMondayLookup(user, {
          onImported: async function (name) {
            var next = await openProposalForm(user, name);
            var again = next && next.querySelector('#fTitle');
            if (again && titleAtOpen) again.value = titleAtOpen;
          },
        });
      });
    }
    return ov;
  }
  /* --- Reports: company-wide proposal analytics --- */
  var rep = { data: null, drift: null, driftLoading: false, inv: null, invLoading: false, tab: 'overview', range: '365', from: '', to: '', pq: '', psort: 'proposedValue' };
  var REP_TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'conversion', label: 'Conversion' },
    { id: 'aging', label: 'Aging' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'winloss', label: 'Win / loss' },
    { id: 'products', label: 'Product demand' },
    { id: 'team', label: 'Team' },
    { id: 'detail', label: 'All proposals' },
    { id: 'costdrift', label: 'Cost drift' },
    { id: 'invoices', label: 'Invoice variance' },
  ];
  var REP_RANGES = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 6 months'], ['365', 'Last 12 months'], ['ytd', 'Year to date'], ['all', 'All time'], ['custom', 'Custom…']];
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
  /**
   * Orders carrying a cost the catalog no longer agrees with.
   *
   * Loaded on demand rather than with the rest of the reports: it reads every order
   * line in the database, and nobody should pay for that while looking at conversion
   * rates. Read-only — repricing happens on the order, per line, where it is audited.
   */
  async function loadDrift() {
    rep.driftLoading = true;
    try {
      var r = await authed('/reports/cost-drift');
      rep.drift = r.ok ? await r.json() : { error: 'Could not load cost drift (' + r.status + ').' };
    } catch (e) { rep.drift = { error: 'Could not reach the server.' }; }
    rep.driftLoading = false;
    if (rep.tab === 'costdrift') drawReports();
  }

  function drawDrift() {
    var d = rep.drift;
    if (!d) return '<div class="muted" style="padding:24px;">Comparing every order line against the catalog…</div>';
    if (d.error) return '<div class="err">' + esc(d.error) + '</div>';
    var s = d.summary;
    if (!s.orderCount) {
      return '<div class="placeholder"><h3>Every order matches the catalog</h3>' +
        '<p>No accepted order is carrying a cost the catalog has since changed.</p></div>';
    }
    var money = function (minor) {
      var n = (Number(minor) || 0) / 100;
      return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    return '<div class="grid">' +
        kpi('Orders affected', s.orderCount.toLocaleString(), s.lineCount + ' line' + (s.lineCount === 1 ? '' : 's') + ' in total') +
        kpi('Net cost movement', (s.netMinor > 0 ? '+' : '') + money(s.netMinor), 'if every line were brought up to date', s.netMinor > 0 ? '#9c3327' : '#2f7d5d') +
        kpi('On submitted sheets', s.lockedCount.toLocaleString(), 'unlock that section to reprice') +
      '</div>' +
      '<div class="muted" style="font-size:12.5px;margin:14px 0 10px;line-height:1.6;max-width:720px;">' +
        'Costs are copied onto an order when it is accepted and never re-read, so a sheet already sent to a vendor cannot change under them. ' +
        'These are the jobs where the catalog has moved since. Open the order and use <b>Refresh costs from catalog</b>, or the per-line <b>Use</b> button on the Bill of Materials.' +
      '</div>' +
      d.orders.map(function (o) {
        return '<div class="card" style="margin-bottom:12px;padding:0;overflow:hidden;">' +
          '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;padding:13px 16px;background:#fbfbf9;border-bottom:1px solid #e7e8e3;">' +
            '<div><b style="font-weight:650;">' + esc(o.customer || '—') + '</b>' +
              '<span class="muted" style="font-size:12.5px;"> · ' + esc(o.number) + (o.jobName ? ' · ' + esc(o.jobName) : '') + '</span></div>' +
            '<div style="font-size:13px;font-variant-numeric:tabular-nums;">' + o.lineCount + ' line' + (o.lineCount === 1 ? '' : 's') +
              ' · <b style="color:' + (o.netMinor > 0 ? '#9c3327' : '#2f7d5d') + ';">' + (o.netMinor > 0 ? '+' : '') + money(o.netMinor) + '</b></div>' +
          '</div>' +
          '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
            '<thead><tr>' +
              ['Part', 'Vendor', 'Qty', 'On the order', 'Catalog', 'On this job'].map(function (h, i) {
                return '<th style="padding:8px 14px;text-align:' + (i > 1 ? 'right' : 'left') + ';font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;">' + h + '</th>';
              }).join('') +
            '</tr></thead><tbody>' +
            o.lines.map(function (l) {
              var up = l.extendedDeltaMinor > 0;
              return '<tr' + (l.locked ? ' style="opacity:.6;"' : '') + '>' +
                rtd(esc(l.name) + '<div class="muted" style="font-size:11.5px;font-family:ui-monospace,monospace;">' + esc(l.sku) +
                  (l.freeIssue ? ' · free issue' : '') + (l.locked ? ' · submitted' : '') + '</div>') +
                rtd(esc(l.vendor)) + rtd(l.quantity, 'right') +
                rtd(money(l.currentMinor), 'right') + rtd(money(l.catalogMinor), 'right', 1) +
                rtd('<span style="color:' + (up ? '#9c3327' : '#2f7d5d') + ';">' + (up ? '+' : '') + money(l.extendedDeltaMinor) + '</span>', 'right') +
              '</tr>';
            }).join('') +
          '</tbody></table></div></div>';
      }).join('');
  }

  /**
   * Every vendor invoice that disagrees with the sheet it was checked against, across
   * every project. Loaded on demand — it reads every invoiced line in the database.
   */
  async function loadInvoiceVariance() {
    rep.invLoading = true;
    try {
      var r = await authed('/reports/invoice-variance');
      rep.inv = r.ok ? await r.json() : { error: 'Could not load invoice variance (' + r.status + ').' };
    } catch (e) { rep.inv = { error: 'Could not reach the server.' }; }
    rep.invLoading = false;
    if (rep.tab === 'invoices') drawReports();
  }

  function drawInvoiceVariance() {
    var d = rep.inv;
    if (!d) return '<div class="muted" style="padding:24px;">Comparing every invoiced line against its Bill of Materials…</div>';
    if (d.error) return '<div class="err">' + esc(d.error) + '</div>';
    var s = d.summary;
    if (!s.orderCount) {
      return '<div class="placeholder"><h3>No invoice variances</h3>' +
        '<p>Every vendor invoice checked so far matches the sheet it was checked against.</p></div>';
    }
    var m = function (v) { return costMoney(v); };
    return '<div class="grid">' +
        kpi('Overcharged', m(s.overchargedMinor), 'billed above the sheet', s.overchargedMinor ? RED : '#20241f') +
        kpi('Undercharged', m(s.underchargedMinor), 'billed below the sheet', '#2f7d5d') +
        kpi('Net', (s.netMinor > 0 ? '+' : '') + m(s.netMinor), s.orderCount + ' order' + (s.orderCount === 1 ? '' : 's') + ' · ' + s.vendorCount + ' vendor' + (s.vendorCount === 1 ? '' : 's'), s.netMinor < 0 ? '#2f7d5d' : RED) +
        kpi('Not yet accepted', s.openCount.toLocaleString(), 'waiting on a decision', '#3d4a55') +
        (s.notBilledLines
          ? kpi('Never billed', s.notBilledLines.toLocaleString() + ' line' + (s.notBilledLines === 1 ? '' : 's'),
              costMoney(s.notBilledMinor) + ' of parts — confirm they shipped', RED)
          : '') +
      '</div>' +
      '<div class="muted" style="font-size:12.5px;margin:14px 0 10px;line-height:1.6;max-width:720px;">' +
        'One row per vendor per order. The sheet figure is what that vendor was sent; the invoiced figure is what they billed for the same lines. ' +
        'Accepted differences stay listed — an accepted overcharge is still a fact about that vendor. ' +
        'An accepted invoice becomes the job\u2019s true cost for margin reporting; it changes nothing on the sheet, the proposal or in QuickBooks.' +
      '</div>' +
      d.rows.map(function (o) {
        var neg = o.varianceMinor < 0;
        return '<div class="card" style="margin-bottom:12px;padding:0;overflow:hidden;">' +
          '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;padding:13px 16px;background:#fbfbf9;border-bottom:1px solid #e7e8e3;">' +
            '<div><b style="font-weight:650;">' + esc(o.vendor) + '</b>' +
              '<span class="muted" style="font-size:12.5px;"> · ' + esc(o.customer || '—') + ' · ' + esc(o.number) +
              (o.invoiceNumber ? ' · invoice ' + esc(o.invoiceNumber) : '') + '</span>' +
              (o.accepted ? ' <span class="chip" style="background:#eaf1ec;color:#2f6b4f;">Accepted' + (o.acceptedBy ? ' · ' + esc(o.acceptedBy) : '') + '</span>' : '') +
            '</div>' +
            '<div style="font-size:13px;font-variant-numeric:tabular-nums;">' + o.checkedLines + ' line' + (o.checkedLines === 1 ? '' : 's') +
              ' · <b style="color:' + (neg ? RED : '#20241f') + ';">' + (o.varianceMinor > 0 ? '+' : '') + m(o.varianceMinor) +
              (o.variancePct == null ? '' : ' · ' + (o.variancePct > 0 ? '+' : '') + o.variancePct.toFixed(1) + '%') + '</b></div>' +
          '</div>' +
          '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
            '<thead><tr>' +
              ['Part', 'Qty', 'Sheet each', 'Invoiced each', 'Δ $', 'Δ %'].map(function (h, i) {
                return '<th style="padding:8px 14px;text-align:' + (i ? 'right' : 'left') + ';font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;">' + h + '</th>';
              }).join('') +
            '</tr></thead><tbody>' +
            o.lines.map(function (l) {
              var ln = (l.extendedDeltaMinor || 0) < 0;
              return '<tr>' +
                rtd(esc(l.name) + '<div class="muted" style="font-size:11.5px;font-family:ui-monospace,monospace;">' + esc(l.sku || '—') + '</div>') +
                rtd(l.quantity, 'right') + rtd(m(l.agreedUnitMinor), 'right') + rtd(m(l.invoicedUnitMinor), 'right', 1) +
                rtd('<span style="color:' + (ln ? RED : '#20241f') + ';">' + ((l.extendedDeltaMinor || 0) > 0 ? '+' : '') + m(l.extendedDeltaMinor) + '</span>', 'right') +
                rtd(l.notBilled
                ? '<span style="color:' + RED + ';font-weight:600;">Not billed</span>'
                : (l.deltaPct == null ? '—' : '<span style="color:' + (l.deltaPct < 0 ? RED : '#20241f') + ';">' + (l.deltaPct > 0 ? '+' : '') + l.deltaPct.toFixed(1) + '%</span>'), 'right') +
              '</tr>';
            }).join('') +
          '</tbody></table></div></div>';
      }).join('');
  }

  function drawReports() {
    var box = document.getElementById('repBody'); if (!box) return;
    if (rep.tab === 'invoices') {
      box.innerHTML = drawInvoiceVariance();
      if (!rep.inv && !rep.invLoading) loadInvoiceVariance();
      return;
    }
    if (rep.tab === 'costdrift') {
      box.innerHTML = drawDrift();
      if (!rep.drift && !rep.driftLoading) loadDrift();
      return;
    }
    if (!rep.data) return;
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
      // A NOTE line the customer has to read, printed in an outlined box. Set from the
      // standard note it came from and kept on the line, so a document already sent
      // does not change shape when the note is edited later.
      emphasis: !!it.emphasis,
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
    var openedUpdatedAt = version.updatedAt || null;
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
        lines.push(normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0, emphasis: !!nn.emphasis }));
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
      proposalId: proposal.id, versionId: version.id, user: user, orgId: proposal.organizationId, orgName: orgName, stdNotes: stdNotes, updatedAt: openedUpdatedAt,
      title: proposal.title || '', number: proposal.number || '', version: version.version || 1, status: version.status || 'DRAFT',
      meta: { contactName: meta.contactName || orgContact || '', shipTo: meta.shipTo || orgShipTo || '', billTo: meta.billTo || '', billSameAsShip: !meta.billTo || meta.billTo === (meta.shipTo || orgShipTo || ''), showTitle: meta.showTitle !== false, projectId: meta.projectId || importedProjectId || '', showProjectId: meta.showProjectId !== false, showDeposit: meta.showDeposit !== false, introTemplate: meta.introTemplate || '', tbdTax: meta.tbdTax || '', tbdStructureFreight: meta.tbdStructureFreight || '', tbdMatsFreight: meta.tbdMatsFreight || '', proposalDate: propDate, taxAmountMinor: meta.taxAmountMinor || 0, discountPct: meta.discountPct || 0, discountMode: meta.discountMode === 'AMT' ? 'AMT' : 'PCT', discountAmountMinor: meta.discountAmountMinor || 0, structureFreightMinor: meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0), matsFreightMinor: meta.matsFreightMinor || 0, stdFreightOn: !!meta.stdFreightOn, stdFreightMinor: meta.stdFreightMinor || 0, expiration: meta.expiration || addDays(propDate, 7), footerNotes: footerNotes, advAnswers: meta.advAnswers || null, advWarnings: meta.advWarnings || [] },
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
        // Travels with the line so the saved proposal keeps the treatment even if the
        // note is later edited — a sent document must not change shape retroactively.
        emphasis: !!nn.emphasis,
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
        pb.lines[i] = normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: alt.title, description: alt.body, quantity: 0, rateMinor: 0, emphasis: !!alt.emphasis });
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

  /**
   * Extended revenue per line, with a bundle counted ONCE.
   *
   * A bundle is one priced line followed by its component rows, and the components
   * are written zero-rate on purpose: they exist to carry the real part numbers,
   * costs and weights, while the customer sees the parent's single price.
   *
   * When a rate lands on the components too — a catalog pull, a paste, a rep typing
   * into the wrong row — summing every row counted the parent AND its parts, so an
   * $11,268.45 bundle showed as $22,536.90 on the section header, the totals panel
   * and the printed proposal.
   *
   * This cannot double in either direction: a priced parent owns the bundle's price
   * and its components are ignored; a zero parent lets the components carry it. A
   * component with no parent above it has nothing to double with, so it counts.
   *
   * Cost and weight are deliberately left summing every row: their convention is the
   * reverse — parent zero, components real — so a plain sum is already right.
   *
   * Mirrors countedRevenueMinor in src/proposals/analytics.ts. The two must agree, or
   * the browser and the price snapshot disagree about the total.
   */
  function countedRevenueByIndex(lines) {
    lines = lines || [];
    var ext = function (l) { return Math.round((Number(l.quantity) || 0) * (Number(l.rateMinor) || 0)); };
    var out = lines.map(function () { return 0; });
    var i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (!l || (l.lineType || 'PRODUCT') !== 'PRODUCT') { i++; continue; }
      if (isBundleChild(l)) { out[i] = ext(l); i++; continue; }
      var parentAmt = ext(l);
      var kids = [];
      var j = i + 1;
      while (j < lines.length && isBundleChild(lines[j])) { kids.push(j); j++; }
      if (!kids.length) { out[i] = parentAmt; i = j; continue; }
      if (parentAmt !== 0) out[i] = parentAmt;
      else kids.forEach(function (k) { out[k] = ext(lines[k]); });
      i = j;
    }
    return out;
  }

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

  /**
   * Returns the index `line` ended up at, so a caller inserting more than one
   * line at once (a bundle's zero-rate components) can place the rest
   * immediately after it rather than needing their own tier placement.
   */
  function insertLineInOrder(line) {
    var d = line && line.sku ? itemDefaults[line.sku] : null;
    if (!d) { pb.lines.push(line); return pb.lines.length - 1; }
    var key = d.sortKey || '';
    var path = Array.isArray(d.path) ? d.path.filter(Boolean) : [];
    var keys = tierKeys(d);
    // Names this part could be filed under. A part carried only as a Sku row has no
    // category tree, but it does have a category name — and that name is usually the
    // section it belongs in, which is enough to file it. Without this fallback those
    // parts appended, which is what happened to the floor padding.
    var labels = path.length ? path : (d.category ? [String(d.category)] : []);
    if (!labels.length) { pb.lines.push(line); return pb.lines.length - 1; }

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
      if (!keys) { pb.lines.push(line); return pb.lines.length - 1; }
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
    return at;
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

  /**
   * What Goldberg needs to price the crate, counted from the same lines the weight
   * comes from.
   *
   * A welded leg is a vertical post: the frame rules make A-2245 the plain posts and
   * A-2246 the ladder-bay ones, so the count is both together. The trolley tell is the
   * rail — TR2000-A07 through A10 — which exists only when a trolley system is in the
   * order.
   *
   * Parts arrive either as their own line or as a component under a kit line (an
   * Adventure frame is one customer line carrying its real part numbers beneath it), so
   * both are counted, and a component quantity is per parent unit. Optional lines are
   * skipped for the same reason they are left out of the weight: nobody has bought them.
   */
  var FREIGHT_LEG_PARTS = { 'A-2245': 1, 'A-2246': 1 };
  var FREIGHT_TROLLEY_PARTS = { 'TR2000-A07': 1, 'TR2000-A08': 1, 'TR2000-A09': 1, 'TR2000-A10': 1 };

  function adventureFreightFacts(lines) {
    var legs = 0, trolley = false;
    (lines || []).forEach(function (l) {
      if (!l || l.optional) return;
      var qty = Number(l.quantity) || 0;
      var sku = String(l.sku || '').trim().toUpperCase();
      if (FREIGHT_LEG_PARTS[sku]) legs += qty;
      if (FREIGHT_TROLLEY_PARTS[sku]) trolley = true;
      (l.components || []).forEach(function (c) {
        var part = String((c && c.part) || '').trim().toUpperCase();
        var per = Number(c && c.qty) || 0;
        if (FREIGHT_LEG_PARTS[part]) legs += per * (qty || 1);
        if (FREIGHT_TROLLEY_PARTS[part]) trolley = true;
      });
    });
    return { legs: legs, trolley: trolley, found: legs > 0 || trolley };
  }
  async function requestFreight() {
    var item = freightItemId();
    if (!item) return alert('This proposal needs its Project ID — that is the monday.com deal item the weight is written to.');
    var t = builderTotals();
    pb.meta.freightBusy = 'req'; renderBuilderKeepingFocus();
    var r = await authed('/proposals/' + pb.proposalId + '/freight-request', {
      method: 'POST',
      body: (function () {
        var f = adventureFreightFacts(pb.lines);
        var b = { itemId: item, weightLb: Math.round((Number(t.weight) || 0) * 100) / 100 };
        // Omitted entirely on a proposal with no Adventure content, so the server
        // leaves both board columns alone rather than writing a 0 and a "No".
        if (f.found) { b.weldedLegs = f.legs; b.trolley = f.trolley; }
        return b;
      })(),
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
  /**
   * The model code this proposal is for, read off the itemized frame heading the
   * configurator writes ("SQ-3MBL1TZ — Itemized").
   *
   * This heading is the single source of truth for the model: the save-as-PDF file
   * name derives from it, the customer document prints it, and the title-mismatch
   * warning below compares against it. A proposal with no frame has no model, and
   * everything that reads this simply prints nothing.
   */
  function proposalModelCode(lines) {
    var model = '';
    (lines || []).forEach(function (l) {
      if ((l.lineType || '') !== 'GROUP' || model) return;
      if (/itemized/i.test(l.name || '')) {
        model = String(l.name).replace(/\s*[-\u2013\u2014]\s*itemized.*$/i, '').trim();
      }
    });
    return model;
  }

  /**
   * A model-shaped token inside free text — "SQ-3MBL2TZ", "K-4000".
   *
   * Reps used to type the model into the proposal title. The document now prints the
   * model itself, from the line items, so a model in the title is a second copy that
   * nothing keeps in step: change the frame and the title silently goes stale. This
   * finds that copy so the builder can offer to correct it.
   */
  function modelTokenIn(text) {
    var m = String(text || '').match(/\b[A-Z]{1,3}-[A-Z0-9]{3,}\b/);
    return m ? m[0] : '';
  }

  /**
   * Warn when the title still carries a model code that disagrees with the frame.
   *
   * A warning rather than a silent rewrite: a rep sometimes titles a proposal
   * deliberately, and editing their words without asking is worse than flagging it.
   */
  function titleModelWarningHtml() {
    var model = proposalModelCode(pb.lines);
    var inTitle = modelTokenIn(pb.title);
    if (!model || !inTitle || inTitle.toUpperCase() === model.toUpperCase()) return '';
    return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:10px 12px;background:#fbecea;border:1px solid #e8c4bd;border-radius:9px;font-size:12.5px;color:#7d2f24;">' +
      '<div style="flex:1;min-width:240px;"><b>The title says <code>' + esc(inTitle) + '</code> but this proposal is for <code>' + esc(model) + '</code>.</b> ' +
        'The document prints the model from the line items, so the title does not need to repeat it.</div>' +
      '<button class="btn" id="bFixTitleModel" style="width:auto;padding:7px 13px;white-space:nowrap;">Use ' + esc(model) + '</button></div>';
  }

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
        '. Price them on the Catalog tab, then use “Pull from catalog”.</div>';
    }
    return out;
  }

  function builderTotals() {
    var subtotal = 0, tpFreight = 0, weight = 0, cogs = 0;
    var groups = []; var cur = null;
    var counted = countedRevenueByIndex(pb.lines);
    pb.lines.forEach(function (l, i) {
      if (l.lineType === 'GROUP') { cur = { name: l.name, optional: l.optional, subtotal: 0, cogs: 0 }; groups.push(cur); return; }
      if (l.lineType === 'PRODUCT') {
        var amt = counted[i];
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
        '<div id="pbJurisRow" style="font-size:12px;margin-top:7px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;line-height:1.5;"></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowTitle"' + (pb.meta.showTitle !== false ? ' checked' : '') + '> Show the proposal title on the customer proposal</label>' +
        priceWarningHtml() +
        titleModelWarningHtml() +
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
      // Which introduction, its photos, and what to generate. Empty for a product
      // line that has no introduction registered — see proposal-front-matter.js.
      (window.SSGFrontMatter
        ? '<div id="fmPanel">' + window.SSGFrontMatter.panelHtml({ meta: pb.meta, lines: pb.lines }) + '</div>'
        : '') +
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
        (t.discount ? '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:14px;color:#9c3327;font-weight:700;"><span>' + discountLabel(t) + '</span><span>− ' + fmtMoney(t.discount, 'USD') + '</span></div>' +
          '<div style="font-size:11px;color:#8a8f85;text-align:right;margin-bottom:2px;">Discount expires ' + (pb.meta.expiration ? fmtDate(pb.meta.expiration) : 'with the proposal') + '</div>' : '') +
        optionalAmountRow('Mat Freight Tax Pass-Through', 'mTax', pb.meta.taxAmountMinor, 'mTaxTbd', pb.meta.tbdTax) +
        // Crating and freight are quoted by the desk against a real shipment. A mock has
        // no shipment, so it quotes product retail and says so rather than showing $0.
        (isMock() ? '' :
          optionalAmountRow('Structure Crating &amp; Freight $', 'mStructFreight', pb.meta.structureFreightMinor, 'mStructFreightTbd', pb.meta.tbdStructureFreight) +
          optionalAmountRow('Mats &amp; Padding Freight $', 'mMatsFreight', pb.meta.matsFreightMinor, 'mMatsFreightTbd', pb.meta.tbdMatsFreight) +
          '<div style="font-size:11px;color:#8a8f85;text-align:right;margin:-2px 0 2px;">When the amount is 0 the proposal says TBD. Type <b>0</b> in the left box to print USD $0.00 instead, or any wording to print that.</div>' +
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
      contractPagesCard() +
      referenceDocsCard() +
      (isMock() ? '' : '<div id="bMarginRail" style="' + marginRailStyle() + '">' + marginCard(t) + '<div id="bCbRail"></div><div id="bRfqRail"></div><div id="bDatesRail"></div><div id="bNotesRail"></div></div>');
    wireBuilder();
  }

  /**
   * Which contract documents close this proposal.
   *
   * The list itself, and every label on it, comes from window.SSGContractPages.list() —
   * the same fetch from Administration that decides what actually prints. It used to be
   * two hard-coded rows with hard-coded names, which meant a document renamed in
   * Administration kept showing its old name here, and a document created there never
   * showed up here at all: it printed on every proposal with no way to see or turn it off
   * from the builder.
   *
   * All by default, in the order Administration has them: the release, then the terms,
   * then anything created afterward. That order is not settable here — the release refers
   * to the parties by the names the terms then use, and Administration's reordering
   * screen is where the sequence of a signed instrument belongs.
   *
   * Unchecking is per proposal and per version, so a job quoted under a customer's own
   * master agreement can go out without ours without changing anything for anyone else.
   * The release and the terms keep the two flags this always used
   * (includeRelease/includeTerms, read by public/contract-pages.js); any document created
   * since is opted out through excludedDocKeys instead, a list of keys rather than one
   * more boolean per document, because the set of documents is open-ended.
   */
  function contractPagesCard() {
    if (window.SSGContractPages && !window.SSGContractPages.applies({ meta: pb.meta, status: pb.status })) return '';
    var m = pb.meta;
    var row = function (id, key, on, label, note) {
      return '<label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;cursor:pointer;padding:7px 0;">' +
        '<input type="checkbox" class="bContractDoc" id="' + id + '" data-key="' + esc(key) + '"' + (on ? ' checked' : '') + ' style="margin-top:2px;">' +
        '<span><b style="font-weight:600;">' + label + '</b>' +
        '<span class="muted" style="display:block;font-size:11.5px;margin-top:1px;">' + note + '</span></span></label>';
    };
    var excluded = Array.isArray(m.excludedDocKeys) ? m.excludedDocKeys : [];
    var docs = (window.SSGContractPages && window.SSGContractPages.list()) || [];
    var rows = docs.map(function (item) {
      var key = item.key;
      var content = item.content || {};
      var title = esc(content.title || key);
      if (key === 'RELEASE') {
        return row('mIncRelease', key, m.includeRelease !== false, title,
          (String(m.billTo || m.shipTo || '').trim()
            ? 'The customer\u2019s company and billing address fill in from this proposal. Signed by ' +
              (m.contactName ? esc(m.contactName) : 'the contact named above') + ' and by you.'
            : '<span style="color:#9c3327;font-weight:600;">No billing address on this proposal yet</span> \u2014 the document would print with the address blank. Fill in Bill to above before sending.'));
      }
      // The document's own current shape from Administration \u2014 a clause or article
      // count that cannot go stale the way a hand-typed sentence describing it would.
      var kind = content.kind || 'NUMBERED';
      var count = kind === 'ARTICLES' ? (content.articles || []).length : (content.sections || []).length;
      var noun = kind === 'ARTICLES' ? ' article' : ' clause';
      var note = count + noun + (count === 1 ? '' : 's') + '.';
      if (key === 'TERMS') return row('mIncTerms', key, m.includeTerms !== false, title, note);
      return row('mIncDoc_' + key, key, excluded.indexOf(key) === -1, title, note);
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Contract documents</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:6px;line-height:1.5;">Printed after the acceptance page, in this order.</div>' +
      (rows || '<div class="muted" style="font-size:12.5px;">None configured in Administration.</div>') +
    '</div>';
  }

  /**
   * Which reference documents ride along with this proposal — a W9, a certificate of
   * insurance.
   *
   * Uploaded once in Administration, from window.SSGReferenceDocuments.list(), same
   * "the label here is always the live one" rule contractPagesCard() follows. Opt-IN
   * rather than opt-out, unlike contract documents: a W9 does not belong on every
   * proposal the way the terms of sale do, so nothing is attached until a rep checks
   * it. Selection is per proposal and per version, stored in pb.meta.referenceDocKeys.
   */
  function referenceDocsCard() {
    var docs = (window.SSGReferenceDocuments && window.SSGReferenceDocuments.list()) || [];
    if (!docs.length) return '';
    var selected = Array.isArray(pb.meta.referenceDocKeys) ? pb.meta.referenceDocKeys : [];
    var rows = docs.map(function (d) {
      var id = 'mRefDoc_' + d.key;
      var on = selected.indexOf(d.key) !== -1;
      return '<label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:1.5;cursor:pointer;padding:7px 0;">' +
        '<input type="checkbox" class="bRefDoc" id="' + id + '" data-key="' + esc(d.key) + '"' + (on ? ' checked' : '') + ' style="margin-top:2px;">' +
        '<span><b style="font-weight:600;">' + esc(d.title) + '</b>' +
        '<span class="muted" style="display:block;font-size:11.5px;margin-top:1px;">' + esc(d.filename) + '</span></span></label>';
    }).join('');
    return '<div class="card" style="margin-top:16px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Reference documents</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:6px;line-height:1.5;">Attached to the signing packet and to the copy pushed to monday, unchecked by default.</div>' +
      rows +
    '</div>';
  }

  /** Notes that print below the signature lines on the customer proposal. */
  /**
   * The standard FOOTER notes as Administration currently has them, in its order.
   *
   * Matched on title, which is what every other part of the builder matches on.
   */
  function stdFooterNotes() {
    return (pb.stdNotes || []).filter(function (nn) { return nn.placement === 'FOOTER'; });
  }

  function footerNotesCard() {
    var fn = pb.meta.footerNotes || [];
    // A proposal's footer notes are a SNAPSHOT, taken when the proposal was first
    // opened. That is deliberate — a released proposal must keep the wording it went
    // out with — but it means a note deleted or reordered in Administration afterwards
    // does not move here on its own, which reads as the builder ignoring the change.
    // So a note Administration no longer has is marked, rather than silently kept.
    var known = {};
    stdFooterNotes().forEach(function (nn) { known[String(nn.title || '').trim().toLowerCase()] = true; });
    var orphans = 0;

    var rows = fn.map(function (n, i) {
      var title = String(n.title || '').trim();
      var orphan = title && !known[title.toLowerCase()];
      if (orphan) orphans++;
      var moveBtn = function (dir, label, on) {
        return '<button class="bFNMove" data-i="' + i + '" data-d="' + dir + '"' + (on ? '' : ' disabled') +
          ' title="Move ' + (dir < 0 ? 'up' : 'down') + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;width:30px;height:24px;cursor:' +
          (on ? 'pointer' : 'default') + ';color:' + (on ? '#5c6157' : '#cfd3ca') + ';line-height:1;">' + label + '</button>';
      };
      return '<div style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid ' +
        (orphan ? '#e6c9b8' : '#ece9db') + ';border-radius:10px;padding:10px;margin-bottom:8px;">' +
        '<div style="display:flex;flex-direction:column;gap:4px;flex:0 0 auto;padding-top:1px;">' +
          moveBtn(-1, '\u2191', i > 0) + moveBtn(1, '\u2193', i < fn.length - 1) +
        '</div>' +
        '<div style="flex:1;min-width:0;"><input class="bFN" data-i="' + i + '" data-k="title" value="' + esc(n.title || '') + '" placeholder="Note title (optional)" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        (orphan ? '<div style="font-size:11px;color:#9c3327;margin:-2px 0 5px;line-height:1.45;">Administration no longer has a standard note by this name. It stays on this proposal until you remove it.</div>' : '') +
        '<textarea class="bFN" data-i="' + i + '" data-k="body" rows="3" placeholder="Note text — **bold** supported" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(n.body || '') + '</textarea></div>' +
        '<button class="bFNDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:30px;height:30px;color:#9c3327;cursor:pointer;flex:0 0 auto;">✕</button></div>';
    }).join('');

    return '<div class="card" style="margin-top:16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;"><div class="section-title" style="margin:0;">Notes below the signature lines</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button class="link-btn" id="bSyncFooter" style="width:auto;padding:7px 12px;">Match Administration</button>' +
          '<button class="link-btn" id="bAddFooter" style="width:auto;padding:7px 12px;">+ Add note</button>' +
        '</div></div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55;">Printed at the foot of the proposal, in this order — use the arrows to change it. These are a copy taken when the proposal was created, so later edits in Administration do not reach a proposal already written. <b>Match Administration</b> pulls in any new always-include note and reorders to match, keeping your own notes and any wording you have changed here.</div>' +
      (orphans ? '<div style="font-size:12px;line-height:1.55;background:#fdf1ec;border:1px solid #f0cdc7;border-radius:9px;padding:9px 11px;margin-bottom:10px;color:#7d2b20;">' +
        orphans + ' note' + (orphans === 1 ? '' : 's') + ' below no longer exist' + (orphans === 1 ? 's' : '') + ' in Administration. Removing ' + (orphans === 1 ? 'it' : 'them') + ' is up to you — a proposal keeps the wording it was written with.</div>' : '') +
      (rows || '<div class="muted" style="font-size:12.5px;">None yet.</div>') + '</div>';
  }

  /**
   * Bring this proposal's footer notes into line with Administration.
   *
   * Adds always-include notes it does not have, and applies Administration's order to
   * the ones it recognises. It does NOT rewrite wording and does NOT delete: an edit
   * made here was made deliberately, and a note Administration has dropped may still
   * belong on a proposal already quoted. Both are flagged instead.
   */
  function syncFooterNotesToAdmin() {
    var std = stdFooterNotes();
    var current = (pb.meta.footerNotes || []).slice();
    var key = function (t) { return String(t || '').trim().toLowerCase(); };
    var byTitle = {};
    current.forEach(function (n) { byTitle[key(n.title)] = n; });

    var ordered = [];
    var added = 0;
    std.forEach(function (nn) {
      var k = key(nn.title);
      if (byTitle[k]) { ordered.push(byTitle[k]); delete byTitle[k]; return; }
      // Only always-include notes are pulled in. An optional one is a choice somebody
      // makes per proposal, and adding it here would make that choice for them.
      if (nn.autoInclude) { ordered.push({ title: nn.title, body: nn.body }); added++; }
    });
    // Anything Administration does not have — hand-written notes, and notes it has
    // since dropped — keeps its relative order at the end.
    var leftovers = current.filter(function (n) { return byTitle[key(n.title)]; });
    pb.meta.footerNotes = ordered.concat(leftovers);
    markBuilderDirty();
    renderBuilder();
    return { added: added, kept: leftovers.length };
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
      (t.cogs === 0 ? '<div style="margin-top:10px;font-size:11.5px;color:#8a6d1f;line-height:1.5;">No costs recorded yet — add unit costs on the Catalog tab, or type a cost on any line.</div>' : '') +
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

  /**
   * What the mail provider said about the last send of this request.
   *
   * Separate from the request's own status chip, and deliberately so: a request can be
   * SENT and undelivered at once. That pair is the case worth showing — a vendor who
   * never received the request is not slow to quote, they are absent, and the first
   * anyone notices is usually when the job needs the freight number.
   */
  function rfqDeliveryLine(r) {
    var d = r.delivery;
    if (!d) return '';
    var base = 'font-size:11px;margin-top:3px;line-height:1.45;';
    if (d.status === 'BOUNCED') {
      return '<div style="' + base + 'color:#9c3327;font-weight:600;">Bounced \u2014 ' + esc(d.toEmail) +
        ' did not receive it' + (d.error ? '<div style="font-weight:400;margin-top:1px;">' + esc(d.error) + '</div>' : '') + '</div>';
    }
    if (d.status === 'FAILED') {
      return '<div style="' + base + 'color:#9c3327;font-weight:600;">Not sent' +
        (d.error ? ' \u2014 ' + esc(d.error) : '') + '</div>';
    }
    if (d.status === 'DELIVERED' || d.deliveredAt) {
      return '<div style="' + base + 'color:#2f7d5d;">Delivered ' + rfqDate(d.deliveredAt) +
        (d.openedAt ? ' \u00b7 opened ' + rfqDate(d.openedAt) : '') + '</div>';
    }
    // Sent, and the provider has not reported back. Said plainly rather than left to
    // look like success: "sent" only means the provider accepted the message.
    return '<div style="' + base + 'color:#8a6d1f;">Sent, delivery not yet confirmed</div>';
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
        rfqDeliveryLine(r) +
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
      rfqUnmatchedHtml() +
      freightRemovedHtml() +
      (rows || '<div class="muted" style="font-size:12px;">None raised yet.</div>') +
    '</div>';
  }

  /**
   * Lines on the proposal that belong to no vendor we can name.
   *
   * These used to be dropped in silence, which is how a proposal with several
   * vendors showed a single vendor card and looked finished. A part with no
   * catalog row, or a catalog row naming no manufacturer, can never appear on a
   * freight request — so it is named here rather than omitted, with the one action
   * that fixes it.
   */
  function rfqUnmatchedHtml() {
    var u = (rfqData && rfqData.unmatched) || [];
    if (!u.length) return '';
    var shown = u.slice(0, 6).map(esc).join(', ');
    if (u.length > 6) shown += ' and ' + (u.length - 6) + ' more';
    return '<div style="background:#fdf6e7;border:1px solid #e8d9ae;color:#7a5c1e;font-size:12px;line-height:1.55;padding:9px 11px;border-radius:9px;margin-bottom:10px;">' +
      '<b>' + u.length + ' item' + (u.length === 1 ? '' : 's') + ' cannot be requested.</b> ' +
      'No supplier is recorded for ' + shown + '. ' +
      'Set a manufacturer on the catalog record, or add these to a request by hand once it is open.' +
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



  /* --- Canadian proposals -------------------------------------------------
     Everything below shows only when the customer's BILLING country is Canada and
     an administrator has switched the feature on. On a US proposal the server
     answers applicable:false and this rail renders nothing at all, which is the
     guarantee that no existing proposal changes because this code exists.

     Three separate totals, never merged: what the customer owes SSG, what they
     should expect to pay CBSA or a broker, and the two added together. Merging the
     first two would tell a customer they owe SSG money that goes to the government. */
  var cbData = null;

  async function loadCrossBorder(force) {
    if (!pb || isMock() || !pb.versionId) return;
    if (!force && cbData && cbData.versionId === pb.versionId) { renderCrossBorderRail(); return; }
    if (force) cbData = null;
    renderCrossBorderRail();
    var versionId = pb.versionId;
    try {
      var r = await authed('/proposals/versions/' + versionId + '/cross-border');
      var body = r.ok ? await r.json() : null;
      cbData = body ? Object.assign({ versionId: versionId }, body) : { versionId: versionId, applicable: false };
    } catch (e) {
      cbData = { versionId: versionId, applicable: false, error: 'Could not load the Canadian calculation.' };
    }
    renderCrossBorderRail();
  }

  function renderCrossBorderRail() {
    var el = document.getElementById('bCbRail');
    if (!el) return;
    el.innerHTML = cbCardHtml();
    wireCrossBorderCard();
  }

  /** USD and estimated CAD side by side. Never a bare dollar sign. */
  function cbPair(usdMinor, cadMinor) {
    if (usdMinor == null) return '<span class="muted">—</span>';
    var cad = cadMinor == null ? '' : '<span style="display:block;font-size:11px;color:#8a8f85;">' + fmtMoney(cadMinor, 'CAD') + ' est.</span>';
    return '<span style="font-variant-numeric:tabular-nums;">' + fmtMoney(usdMinor, 'USD') + '</span>' + cad;
  }

  var CB_STATUS_TEXT = {
    CALCULATED: '', CONFIRMED: 'Confirmed', ESTIMATED: 'Estimated',
    TO_BE_CONFIRMED: 'To be confirmed', REQUIRES_CUSTOMS_REVIEW: 'Customs review required',
    REQUIRES_TAX_REVIEW: 'Tax review required', NOT_APPLICABLE: 'Not applicable',
    EXEMPT: 'Exempt', NOT_REGISTERED: 'Not registered'
  };

  function cbStatusChip(status) {
    var text = CB_STATUS_TEXT[status];
    if (!text) return '';
    var warn = status === 'REQUIRES_CUSTOMS_REVIEW' || status === 'REQUIRES_TAX_REVIEW' || status === 'TO_BE_CONFIRMED';
    var bg = warn ? '#fdf6e7' : '#f2f4f0', bd = warn ? '#e8d9ae' : '#e0e3dc', fg = warn ? '#7a5c1e' : '#5c6157';
    return '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:10px;background:' + bg + ';border:1px solid ' + bd + ';color:' + fg + ';white-space:nowrap;">' + esc(text) + '</span>';
  }

  /** Plain-language text for each thing holding the proposal up. */
  var CB_BLOCKER_TEXT = {
    'address:no_billing_address': 'This customer has no billing address on file.',
    'address:missing_country': 'The billing address has no country.',
    'address:missing_province': 'The billing address has no province or territory. Canadian tax cannot be determined without it.',
    'address:unrecognized_province': 'The province or territory on the billing address was not recognized.',
    'address:missing_postal_code': 'The billing address has no postal code.',
    'address:invalid_postal_code': 'The postal code is not a valid Canadian postal code.',
    'address:province_postal_mismatch': 'The postal code belongs to a different province than the address says. Confirm which is right.',
    'fx:review_required': 'The Bank of Canada rate could not be confirmed. CAD figures are indicative only.',
    'tax:manual_amount_present': 'A tax amount has been typed into this proposal by hand. Canadian tax is calculated, so remove the manual amount or the customer is taxed twice.',
    'calc:customs_requires_review': 'Nobody has entered the customs figures yet.',
    'calc:broker_fee_unconfirmed': 'The customs brokerage fee has not been confirmed.',
    'calc:importer_of_record_undetermined': 'Who is the importer of record has not been decided.',
    'calc:tax_requires_review': 'Canadian sales tax needs review before this can be released.'
  };

  function cbCardHtml() {
    if (!cbData) return '';
    if (cbData.error) {
      return '<div class="card" style="margin-top:14px;border:1px solid #f0ccc6;background:#fbecea;"><div class="section-title" style="margin:0 0 4px;">Canadian proposal</div>' +
        '<div style="font-size:12px;color:#9c3327;line-height:1.5;">' + esc(cbData.error) + '</div></div>';
    }
    if (!cbData.applicable) return '';

    var j = cbData.jurisdiction || {};
    var fx = cbData.fx || {};
    var res = cbData.result;

    var head = '<div class="section-title" style="margin:0 0 2px;">Canadian proposal</div>' +
      '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">' +
        esc(j.provinceLabel || 'Canada') + ' \u00b7 billing address</div>';

    // The rate, its source and its date. A customer has to be able to see which
    // published observation their CAD figures came from.
    var fxBlock = fx.rate
      ? '<div style="font-size:11.5px;line-height:1.55;color:#5c6157;padding:8px 10px;background:#f6f7f4;border:1px solid #e7e8e3;border-radius:9px;margin-bottom:10px;">' +
          'Estimated CAD uses <b>1 USD = ' + esc(fx.rate) + ' CAD</b>' +
          (fx.observationDate ? ', published ' + esc(fx.observationDate) : '') +
          (fx.source === 'MANUAL' ? ' (entered by hand, not a Bank of Canada rate)' : fx.source === 'CACHE' ? ' (from cache)' : '') + '.' +
          (fx.warning ? '<div style="color:#7a5c1e;margin-top:5px;">' + esc(fx.warning) + '</div>' : '') +
        '</div>'
      : '<div style="font-size:11.5px;line-height:1.55;color:#7a5c1e;padding:8px 10px;background:#fdf6e7;border:1px solid #e8d9ae;border-radius:9px;margin-bottom:10px;">' +
          'No USD/CAD rate is available, so there are no CAD figures. The USD amounts are unaffected.</div>';

    var blockers = (cbData.blockers || []);
    var blockBlock = blockers.length
      ? '<div style="font-size:11.5px;line-height:1.6;color:#7a5c1e;padding:8px 10px;background:#fdf6e7;border:1px solid #e8d9ae;border-radius:9px;margin-bottom:10px;">' +
          '<b>Before this can be released</b><ul style="margin:5px 0 0;padding-left:16px;">' +
          blockers.map(function (b) { return '<li>' + esc(CB_BLOCKER_TEXT[b] || b) + '</li>'; }).join('') +
          '</ul></div>'
      : '';

    if (!res) {
      return '<div class="card" style="margin-top:14px;border:1px solid #e4dfd0;background:#fdfcf7;">' + head + fxBlock + blockBlock + '</div>';
    }

    var rows = (res.lines || []).map(function (l) {
      return '<tr>' +
        '<td style="padding:4px 0;font-size:12px;vertical-align:top;">' + esc(l.label) + cbStatusChip(l.status) +
          (l.percent ? '<span class="muted" style="font-size:10.5px;"> ' + esc(l.percent) + '%</span>' : '') +
          (l.payableTo === 'CUSTOMS_OR_BROKER' ? '<span style="display:block;font-size:10px;color:#8a8f85;">payable at the border</span>' : '') +
        '</td>' +
        '<td style="padding:4px 0;text-align:right;font-size:12px;vertical-align:top;">' + cbPair(l.usdMinor, l.cadMinor) + '</td>' +
      '</tr>';
    }).join('');

    var totalRow = function (label, t, strong) {
      return '<tr><td style="padding:6px 0 2px;font-size:12px;' + (strong ? 'font-weight:700;' : '') + '">' + esc(label) + '</td>' +
        '<td style="padding:6px 0 2px;text-align:right;font-size:12.5px;' + (strong ? 'font-weight:700;' : '') + '">' + cbPair(t.usdMinor, t.cadMinor) + '</td></tr>';
    };

    var totals = '<table style="width:100%;border-collapse:collapse;border-top:1px solid #ece7d8;margin-top:8px;">' +
      totalRow('Payable to Summit', res.payableToSummit, true) +
      (res.separatelyPayable.usdMinor ? totalRow('Payable at import', res.separatelyPayable, false) : '') +
      (res.separatelyPayable.usdMinor ? totalRow('Estimated landed cost', res.estimatedLandedCost, false) : '') +
      '</table>';

    return '<div class="card" style="margin-top:14px;border:1px solid #e4dfd0;background:#fdfcf7;">' +
      head + fxBlock + blockBlock +
      '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
      totals +
      '<button class="link-btn" id="cbCustoms" style="width:auto;padding:6px 11px;font-size:12px;margin-top:11px;">Customs and duties\u2026</button>' +
    '</div>';
  }

  function wireCrossBorderCard() {
    var b = document.getElementById('cbCustoms');
    if (b) b.addEventListener('click', openCustomsForm);
  }



  /* --- Customs and duties -------------------------------------------------
     Typed in, not calculated. There is no tariff engine here on purpose: working
     out duty needs a tariff classification number, a country of origin, CUSMA
     origin documentation, material composition and the current surtax orders, and
     none of that is in this catalog. A duty computed from missing data is worse
     than no duty, because it produces a figure somebody quotes.

     So the numbers come from the broker, and BLANK MEANS BLANK. A blank duty box is
     "nobody has told us yet", which prints as a review notice; it is not zero. Zero
     is a claim, and only a person gets to make it. */

  /** A money box's value in minor units, or null when it is empty. */
  function cbMinorFromInput(el) {
    if (!el) return null;
    var raw = String(el.value == null ? '' : el.value).trim().replace(/^\$/, '').replace(/,/g, '');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
    return Math.round(parseFloat(raw) * 100);
  }

  function cbInputFromMinor(v) {
    return v == null ? '' : (Number(v) / 100).toFixed(2);
  }

  async function openCustomsForm() {
    if (!pb || !pb.versionId) return;
    var e;
    try {
      var r = await authed('/proposals/versions/' + pb.versionId + '/customs');
      if (!r.ok) { alert('Could not load the customs entry.'); return; }
      e = await r.json();
    } catch (err) { alert('Could not load the customs entry.'); return; }

    var lbl = 'font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;display:block;margin-bottom:3px;';
    var box = 'width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;';

    var money = function (id, label, v) {
      return '<div style="flex:1;min-width:120px;"><label style="' + lbl + '">' + esc(label) + '</label>' +
        '<input id="' + id + '" inputmode="decimal" placeholder="blank = not yet known" value="' + esc(cbInputFromMinor(v)) + '" style="' + box + '"></div>';
    };

    var statusLine = {
      REQUIRES_CUSTOMS_REVIEW: 'Nobody has entered these yet. The proposal shows a customs review notice.',
      ESTIMATED: 'Entered, presented to the customer as an estimate. Not yet approved.',
      CONFIRMED: 'Approved. The proposal can go out as a landed-cost quote.',
      NOT_APPLICABLE: 'Recorded as having no customs charges.'
    }[e.status] || '';

    var pct = function (id, label, v, hint) {
      return '<div style="flex:1;min-width:130px;"><label style="' + lbl + '">' + esc(label) + '</label>' +
        '<div style="position:relative;"><input id="' + id + '" inputmode="decimal" placeholder="blank = none" value="' +
        esc(v == null ? '' : String(v)) + '" style="' + box + 'padding-right:26px;">' +
        '<span style="position:absolute;right:9px;top:8px;font-size:13px;color:#8a8f85;">%</span></div>' +
        (hint ? '<div class="muted" style="font-size:10.5px;line-height:1.45;margin-top:3px;">' + hint + '</div>' : '') + '</div>';
    };
    var simple = !!e.simpleMode;

    var body =
      '<div style="font-size:11.5px;line-height:1.6;color:#5c6157;padding:8px 10px;background:#f6f7f4;border:1px solid #e7e8e3;border-radius:9px;margin-bottom:14px;">' +
        '<b>' + esc(e.status.replace(/_/g, ' ').toLowerCase()) + '</b> \u2014 ' + esc(statusLine) +
        '<div style="margin-top:5px;">Leave a box empty when the figure is not known. An empty box is reported as outstanding; it is not treated as zero.</div>' +
      '</div>' +
      // Percent entry, in front of the typed-amount fields because it is the path
      // most jobs will take until the registrations and rulings are in place.
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.5;margin-bottom:12px;padding:10px 12px;border:1px solid ' +
        (simple ? '#cfe3d7' : '#e7e8e3') + ';border-radius:9px;background:' + (simple ? '#f4faf6' : '#fff') + ';">' +
        '<input type="checkbox" id="cfSimple"' + (simple ? ' checked' : '') + ' style="margin-top:2px;">' +
        '<span><b>Work these out from percentages</b>' +
        '<span class="muted" style="display:block;font-size:11.5px;margin-top:3px;line-height:1.5;">Enter the tax and tariff rates and the broker\u2019s fee, and the amounts are calculated from the proposal. Use this until the tax registrations and tariff rulings are in place. The proposal states that the rates were entered by Summit and that the Canada Border Services Agency assesses the final amounts.</span></span></label>' +
      '<div id="cfSimpleBox" style="' + (simple ? '' : 'display:none;') + 'margin-bottom:14px;padding:12px 13px;border:1px solid #e7e8e3;border-radius:10px;background:#fbfbf9;">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
          '<div style="flex:1;min-width:150px;"><label style="' + lbl + '">What the tax is called</label>' +
            '<input id="cfTaxLabel" placeholder="HST, GST + QST, GST + PST" value="' + esc(e.taxLabel || '') + '" style="' + box + '">' +
            '<div class="muted" style="font-size:10.5px;margin-top:3px;">Printed on the proposal exactly as typed.</div></div>' +
          pct('cfTaxPct', 'Tax rate', e.taxPercentMilli == null ? null : e.taxPercentMilli / 1000, 'Ontario 13 · Quebec 14.975 · Alberta 5') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
          pct('cfTariffPct', 'Tariff rate', e.tariffPercentMilli == null ? null : e.tariffPercentMilli / 1000, 'Applied to the goods. Ask your broker.') +
          money('cfBrokerSimple', 'Broker fee', e.brokerFeeMinor) +
        '</div>' +
        '<label style="display:flex;gap:7px;align-items:flex-start;font-size:12px;line-height:1.5;margin-bottom:6px;">' +
          '<input type="checkbox" id="cfTariffFreight"' + (e.tariffOnFreight ? ' checked' : '') + ' style="margin-top:2px;">' +
          '<span>Apply the tariff to freight as well as the goods<span class="muted" style="display:block;font-size:10.5px;">Off by default: duty is assessed on what the goods are worth.</span></span></label>' +
        '<label style="display:flex;gap:7px;align-items:flex-start;font-size:12px;line-height:1.5;">' +
          '<input type="checkbox" id="cfTaxOnDuty"' + (e.taxOnDuty !== false ? ' checked' : '') + ' style="margin-top:2px;">' +
          '<span>Charge tax on the tariff and the brokerage too<span class="muted" style="display:block;font-size:10.5px;">On by default: that is how GST and HST are assessed on an import.</span></span></label>' +
      '</div>' +
      '<div id="cfAmountBox"' + (simple ? ' style="display:none;"' : '') + '>' +
      '<div style="margin-bottom:12px;"><label style="' + lbl + '">Currency these were quoted in</label>' +
        '<select id="cfCur" style="' + box + '">' +
          '<option value="CAD"' + (e.currency === 'CAD' ? ' selected' : '') + '>CAD \u2014 as the broker quoted</option>' +
          '<option value="USD"' + (e.currency === 'USD' ? ' selected' : '') + '>USD</option>' +
        '</select></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
        money('cfDuty', 'Customs duty', e.dutyMinor) +
        money('cfSurtax', 'Tariff / surtax', e.surtaxMinor) +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
        money('cfSima', 'SIMA duties', e.simaMinor) +
        money('cfOther', 'Other border duties', e.otherDutyMinor) +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
        money('cfImportTax', 'Import tax', e.importTaxMinor) +
        money('cfBroker', 'Brokerage', e.brokerFeeMinor) +
      '</div>' +
      '</div>' +
      '<div style="margin-bottom:12px;"><label style="' + lbl + '">Where these figures came from</label>' +
        '<input id="cfSource" placeholder="Broker quote reference, ruling, or a prior entry" value="' + esc(e.sourceReference || '') + '" style="' + box + '">' +
        '<div class="muted" style="font-size:11px;line-height:1.5;margin-top:4px;">Required before these can be approved \u2014 without it there is nothing to check them against later.</div></div>' +
      '<div style="margin-bottom:12px;"><label style="' + lbl + '">Importer of record</label>' +
        '<select id="cfIor" style="' + box + '">' +
          ['CUSTOMER|The customer', 'SUMMIT|Summit Sensory Gym', 'THIRD_PARTY|A third party', 'TO_BE_DETERMINED|Still to be decided'].map(function (o) {
            var p = o.split('|');
            return '<option value="' + p[0] + '"' + (e.importerOfRecord === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
          }).join('') +
        '</select></div>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;margin-bottom:12px;">' +
        '<input type="checkbox" id="cfIncl"' + (e.includedInSellerTotal ? ' checked' : '') + ' style="margin-top:2px;">' +
        '<span>Summit is collecting these amounts, so add them to the amount payable to Summit.' +
        '<span class="muted" style="display:block;font-size:11px;margin-top:2px;">Leave unticked when the customer pays the border directly \u2014 they then show as payable at import instead.</span></span></label>' +
      '<div style="margin-bottom:4px;"><label style="' + lbl + '">Notes</label>' +
        '<textarea id="cfNotes" rows="2" style="' + box + 'resize:vertical;">' + esc(e.notes || '') + '</textarea></div>' +
      '<div id="cfMsg" style="font-size:11.5px;line-height:1.5;margin-top:10px;"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid #ece7d8;">' +
        '<button type="button" class="link-btn" id="cfApprove" style="width:auto;padding:7px 12px;font-size:12px;">Approve these figures</button>' +
        '<button type="button" class="link-btn" id="cfNone" style="width:auto;padding:7px 12px;font-size:12px;">No customs charges apply</button>' +
        (e.status === 'CONFIRMED' || e.status === 'NOT_APPLICABLE'
          ? '<button type="button" class="link-btn" id="cfReopen" style="width:auto;padding:7px 12px;font-size:12px;">Send back for review</button>' : '') +
      '</div>';

    openModal('Customs and duties', body, async function (close) {
      var msg = document.getElementById('cfMsg');
      var isSimple = document.getElementById('cfSimple').checked;
      // In percent mode the broker fee comes from its own box, and the typed duty
      // fields are left exactly as they were rather than being sent as blanks — a
      // figure someone entered before switching modes is not erased by the switch.
      var amounts = isSimple
        ? { brokerFeeMinor: cbMinorFromInput(document.getElementById('cfBrokerSimple')) }
        : {
            dutyMinor: cbMinorFromInput(document.getElementById('cfDuty')),
            surtaxMinor: cbMinorFromInput(document.getElementById('cfSurtax')),
            simaMinor: cbMinorFromInput(document.getElementById('cfSima')),
            otherDutyMinor: cbMinorFromInput(document.getElementById('cfOther')),
            importTaxMinor: cbMinorFromInput(document.getElementById('cfImportTax')),
            brokerFeeMinor: cbMinorFromInput(document.getElementById('cfBroker'))
          };
      var pctOf = function (id) {
        var el = document.getElementById(id);
        if (!el || !el.value.trim()) return null;
        var n = Number(el.value.replace(/[^0-9.]/g, ''));
        return Number.isFinite(n) ? n : NaN;
      };
      var simplePatch = {
        simpleMode: isSimple,
        taxLabel: (document.getElementById('cfTaxLabel').value || '').trim() || null,
        taxPercent: pctOf('cfTaxPct'),
        tariffPercent: pctOf('cfTariffPct'),
        tariffOnFreight: document.getElementById('cfTariffFreight').checked,
        taxOnDuty: document.getElementById('cfTaxOnDuty').checked
      };
      if (Number.isNaN(simplePatch.taxPercent) || Number.isNaN(simplePatch.tariffPercent)) {
        msg.innerHTML = '<span style="color:#9c3327;">Enter a rate as a plain number \u2014 13, or 9.975.</span>';
        return false;
      }
      for (var k in amounts) {
        if (Number.isNaN(amounts[k])) {
          msg.innerHTML = '<span style="color:#9c3327;">Enter amounts as plain numbers, e.g. 250.00, or leave the box empty.</span>';
          return;
        }
      }
      var payload = Object.assign(amounts, simplePatch, {
        currency: document.getElementById('cfCur').value,
        sourceReference: document.getElementById('cfSource').value.trim() || null,
        importerOfRecord: document.getElementById('cfIor').value,
        includedInSellerTotal: document.getElementById('cfIncl').checked,
        notes: document.getElementById('cfNotes').value.trim() || null
      });
      var r = await authed('/proposals/versions/' + pb.versionId + '/customs', { method: 'PATCH', body: payload });
      if (!r.ok) {
        var j = null; try { j = await r.json(); } catch (err) {}
        msg.innerHTML = '<span style="color:#9c3327;">' + esc((j && j.message) || 'Could not save (' + r.status + ').') + '</span>';
        return;
      }
      close();
      await loadCrossBorder(true);
    }, 'Save figures');

    setTimeout(function () {
      var sw = document.getElementById('cfSimple');
      if (!sw) return;
      sw.addEventListener('change', function () {
        document.getElementById('cfSimpleBox').style.display = sw.checked ? '' : 'none';
        document.getElementById('cfAmountBox').style.display = sw.checked ? 'none' : '';
      });
    }, 0);

    // The three lifecycle actions. Each reloads the rail, because each changes what
    // the proposal is allowed to do.
    var act = async function (path, bodyObj, btn) {
      var msg = document.getElementById('cfMsg');
      btn.disabled = true;
      try {
        var r = await authed('/proposals/versions/' + pb.versionId + '/customs/' + path, { method: 'POST', body: bodyObj });
        if (!r.ok) {
          var j = null; try { j = await r.json(); } catch (e2) {}
          msg.innerHTML = '<span style="color:#9c3327;">' + esc((j && j.message) || 'Could not do that (' + r.status + ').') + '</span>';
          btn.disabled = false;
          return false;
        }
        return true;
      } catch (e3) { btn.disabled = false; return false; }
    };

    setTimeout(function () {
      var ap = document.getElementById('cfApprove');
      if (ap) ap.addEventListener('click', async function () {
        // Approving is a claim about duty and tax, so the reason is offered but the
        // source reference is what the server insists on.
        var why = prompt('Anything to record about this approval? (optional)') || '';
        if (await act('approve', { reason: why.trim() || undefined }, ap)) { closeAllModals(); await loadCrossBorder(true); }
      });
      var no = document.getElementById('cfNone');
      if (no) no.addEventListener('click', async function () {
        var why = prompt('Why do no customs charges apply? (required)');
        if (!why || !why.trim()) return;
        if (await act('not-applicable', { reason: why.trim() }, no)) { closeAllModals(); await loadCrossBorder(true); }
      });
      var re = document.getElementById('cfReopen');
      if (re) re.addEventListener('click', async function () {
        var why = prompt('Why is this going back for review? (required)');
        if (!why || !why.trim()) return;
        if (await act('reopen', { reason: why.trim() }, re)) { closeAllModals(); await loadCrossBorder(true); }
      });
    }, 0);
  }

  /** Dismiss any open overlay. The lifecycle buttons live inside one. */
  function closeAllModals() {
    document.querySelectorAll('form#mForm').forEach(function (f) {
      var ov = f.parentNode;
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
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
      rfqData = { versionId: versionId, sig: sig, vendors: vendors.vendors || [], unmatched: vendors.unmatchedNames || [], rfqs: rfqs.rfqs || [], cov: cov, error: null };
    } catch (e) {
      rfqData = { versionId: versionId, sig: sig, vendors: [], unmatched: [], rfqs: [], cov: null, error: e.message };
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
          // /render/*: this send builds the RFQ PDF before it can attach it, and
          // vercel.json routes that prefix to the function with the memory and
          // 60-second ceiling headless Chromium needs. On the main API function a
          // cold browser start ran past 30 seconds and the request was killed,
          // which is what left this dialog on "Sending…" indefinitely.
          await rfqApi('/render/rfqs/' + rfqId + '/send', {
            method: 'POST',
            timeoutMs: RENDER_TIMEOUT_MS,
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

  function builderIsHeading(l) {
    return !!l && (l.lineType === 'GROUP' || l.lineType === 'SUBGROUP');
  }

  /**
   * The rows that move as one when this row moves.
   *
   * A heading owns everything beneath it until the next heading that ends it: a tier 1
   * GROUP ends at the next GROUP, a tier 2 SUBGROUP ends at either. Anything else is
   * just itself. This is the rule the drag-and-drop already used; it lives up here now
   * so the arrows and the drag cannot drift apart, which is the sort of thing that ends
   * with two reorder paths that disagree about what a section contains.
   */
  function builderBlockAt(i) {
    var l = pb.lines[i];
    if (!l) return { from: i, count: 1 };
    if (!builderIsHeading(l)) return { from: i, count: 1 };
    var end = i + 1;
    while (end < pb.lines.length) {
      var t = pb.lines[end].lineType;
      if (t === 'GROUP' || (l.lineType === 'SUBGROUP' && t === 'SUBGROUP')) break;
      end++;
    }
    return { from: i, count: end - i };
  }

  /**
   * The blocks this row can trade places with, and where it currently sits among them.
   *
   * Siblings, not neighbours. A tier 1 heading's siblings are the other tier 1 headings;
   * a tier 2 heading's are the other tier 2 headings INSIDE THE SAME tier 1; a product's
   * are the products and notes in the unbroken run it sits in.
   *
   * The run boundary for a product is deliberate. An arrow that carried a part across a
   * heading would silently change which section it prints under and which section's
   * revenue it counts toward — a pricing change disguised as a nudge. Crossing sections
   * stays a drag, where the intent is unmistakable. The arrow greys out instead.
   */
  function builderSiblings(i) {
    var l = pb.lines[i];
    if (!l) return null;

    if (!builderIsHeading(l)) {
      var s = i, e = i, k;
      while (s - 1 >= 0 && !builderIsHeading(pb.lines[s - 1])) s--;
      while (e + 1 < pb.lines.length && !builderIsHeading(pb.lines[e + 1])) e++;
      var run = [];
      for (k = s; k <= e; k++) run.push({ from: k, count: 1 });
      return { blocks: run, at: i - s };
    }

    // Tier 1 ranges over the whole proposal; tier 2 only within its own tier 1.
    var lo = 0, hi = pb.lines.length, j;
    if (l.lineType === 'SUBGROUP') {
      for (j = i - 1; j >= 0; j--) {
        if (pb.lines[j].lineType === 'GROUP') {
          var gb = builderBlockAt(j);
          lo = j + 1;
          hi = gb.from + gb.count;
          break;
        }
      }
    }
    var blocks = [], at = -1, m = lo;
    while (m < hi) {
      if (pb.lines[m].lineType === l.lineType) {
        var b = builderBlockAt(m);
        if (m === i) at = blocks.length;
        blocks.push(b);
        m = b.from + b.count;
      } else m++;
    }
    return at === -1 ? null : { blocks: blocks, at: at };
  }

  /**
   * Swap this row's block with the sibling block above or below it.
   * Returns the block's new starting index, or -1 if it could not move.
   */
  function builderMove(i, dir) {
    var sib = builderSiblings(i);
    if (!sib) return -1;
    var to = sib.at + dir;
    if (to < 0 || to >= sib.blocks.length) return -1;
    var me = sib.blocks[sib.at], other = sib.blocks[to];
    var moved = pb.lines.splice(me.from, me.count);
    // Moving down, removing this block first shifts the target back by its length, so
    // landing after the target means other.from - me.count + other.count.
    var at = dir < 0 ? other.from : other.from + other.count - me.count;
    pb.lines.splice.apply(pb.lines, [at, 0].concat(moved));
    return at;
  }

  /** Up/down controls for one row, greyed at the ends of its own sibling run. */
  function builderArrows(i, light) {
    var l = pb.lines[i];
    var sib = builderSiblings(i);
    var canUp = !!sib && sib.at > 0;
    var canDown = !!sib && sib.at < sib.blocks.length - 1;
    var what = l && l.lineType === 'GROUP' ? 'this section and everything in it'
      : l && l.lineType === 'SUBGROUP' ? 'this sub-section and its products'
      : 'this line within its section';
    var base = 'border-radius:7px;width:25px;height:26px;padding:0;font-size:9px;line-height:1;'
      + 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;';
    var on = light
      ? 'border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#e6ebef;cursor:pointer;'
      : 'border:1px solid #e0e1db;background:#fff;color:#5c6157;cursor:pointer;';
    var off = light
      ? 'border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.28);cursor:default;'
      : 'border:1px solid #f0f1ec;background:#fbfbf9;color:#cfd2ca;cursor:default;';
    var endNote = builderIsHeading(l) ? 'already first' : 'already at the top of its section';
    var endNoteD = builderIsHeading(l) ? 'already last' : 'already at the bottom of its section';
    return '<div style="display:flex;flex-direction:column;gap:2px;flex:0 0 auto;">' +
      '<button class="bUp" data-i="' + i + '"' + (canUp ? '' : ' disabled') +
        ' title="' + (canUp ? 'Move ' + what + ' up' : endNote) + '"' +
        ' style="' + base + (canUp ? on : off) + '">\u25b2</button>' +
      '<button class="bDn" data-i="' + i + '"' + (canDown ? '' : ' disabled') +
        ' title="' + (canDown ? 'Move ' + what + ' down' : endNoteD) + '"' +
        ' style="' + base + (canDown ? on : off) + '">\u25bc</button>' +
    '</div>';
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
        '<div style="display:flex;align-items:center;gap:8px;">' + handle.replace('#c2c6bd', '#8fa0ac') + builderArrows(i, true) +
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
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;background:#eef0ea;border:1px solid #e2e5dd;border-radius:9px;padding:7px 10px;margin-left:14px;">' + handle + builderArrows(i, false) +
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
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid #ece9db;border-radius:10px;padding:10px;' + (noteIndent ? 'margin-left:' + noteIndent + 'px;' : '') + '">' + handle + builderArrows(i, false) +
        '<div style="flex:1;"><input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Note title" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        '<textarea class="bF" data-i="' + i + '" data-k="description" rows="3" placeholder="Note text" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(l.description) + '</textarea>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:3px;">' +
          '<div style="font-size:10.5px;color:#8a8f85;">Formatting: <b>**bold**</b> · <i>*italic*</i> · line breaks are kept · HTML: &lt;ul&gt;&lt;li&gt; &lt;b&gt; &lt;i&gt; &lt;a href&gt;</div>' +
          // Shown here because the box is invisible until the proposal is previewed, and
          // because a rep sometimes wants this one note boxed on this one proposal.
          '<label style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:#5c6157;cursor:pointer;white-space:nowrap;" title="Prints this note inside a ruled box on the customer proposal">' +
            '<input type="checkbox" class="bNoteBox" data-i="' + i + '"' + (l.emphasis ? ' checked' : '') + '> Outlined box on the proposal</label>' +
        '</div></div>' + del + '</div>';
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
      '<div style="display:flex;align-items:flex-start;gap:8px;">' + handle + builderArrows(i, false) +
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
    if (!isMock()) loadCrossBorder();
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
      if (v === '__custom') pb.lines.push(normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: 'Note', description: '', quantity: 0, rateMinor: 0 }));
      else {
        var nn = (pb.stdNotes || [])[Number(v)];
        if (nn && nn.placement === 'FOOTER') { pb.meta.footerNotes = (pb.meta.footerNotes || []).concat([{ title: nn.title, body: nn.body }]); }
        // normalizeLine rather than a bare object: it is what carries `emphasis` (and
        // every other line field) through a save. Built by hand here, a note picked from
        // this dropdown printed unboxed however the note itself was configured.
        else if (nn) pb.lines.push(normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0, emphasis: !!nn.emphasis }));
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
      b.addEventListener('click', function () { (pb.meta.footerNotes || []).splice(+b.getAttribute('data-i'), 1); markBuilderDirty(); renderBuilder(); });
    });
    document.querySelectorAll('.bFNMove').forEach(function (b) {
      b.addEventListener('click', function () {
        var arr = pb.meta.footerNotes || [];
        var i = +b.getAttribute('data-i');
        var j = i + +b.getAttribute('data-d');
        if (j < 0 || j >= arr.length) return;
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        markBuilderDirty();
        renderBuilder();
      });
    });
    var bsf = document.getElementById('bSyncFooter');
    if (bsf) bsf.addEventListener('click', function () {
      var r = syncFooterNotesToAdmin();
      // Said out loud: a button that reorders three notes can otherwise look like it
      // did nothing at all.
      alert(r.added
        ? r.added + ' note' + (r.added === 1 ? '' : 's') + ' added, and the order now matches Administration.'
        : 'The order now matches Administration. Nothing new to add.');
    });
    document.getElementById('bAddFooter').addEventListener('click', function () {
      pb.meta.footerNotes = (pb.meta.footerNotes || []).concat([{ title: '', body: '' }]); renderBuilder();
    });
    document.querySelectorAll('.grpChip').forEach(function (c) { c.addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: c.getAttribute('data-g'), description: '', quantity: 0, rateMinor: 0, optional: /trolley|adventure|foundation|mat/i.test(c.getAttribute('data-g')) }); renderBuilder(); }); });
    // header/meta inputs
    var mt = document.getElementById('mTitle'); if (mt) mt.addEventListener('input', function () { pb.title = mt.value; markBuilderDirty(); });
    // Swap the stale model in the title for the one the line items say, leaving the
    // rest of the rep's wording alone.
    var bFixTitle = document.getElementById('bFixTitleModel');
    if (bFixTitle) {
      bFixTitle.addEventListener('click', function () {
        var model = proposalModelCode(pb.lines), stale = modelTokenIn(pb.title);
        if (!model || !stale) return;
        pb.title = pb.title.split(stale).join(model);
        markBuilderDirty();
        renderBuilder();
      });
    }
    var mct = document.getElementById('mContact'); if (mct) mct.addEventListener('input', function () { pb.meta.contactName = mct.value; });
    var mp = document.getElementById('mProj'); if (mp) mp.addEventListener('input', function () { pb.meta.projectId = mp.value; });
    var mpd = document.getElementById('mPropDate'); if (mpd) mpd.addEventListener('input', function () { pb.meta.proposalDate = mpd.value; pb.meta.expiration = addDays(mpd.value, 7); var me2 = document.getElementById('mExp'); if (me2) me2.value = pb.meta.expiration; });
    var msp = document.getElementById('mShowProj'); if (msp) msp.addEventListener('change', function () { pb.meta.showProjectId = msp.checked; });
    // One listener for every contract-document checkbox, RELEASE and TERMS included —
    // see contractPagesCard(). RELEASE/TERMS keep writing the two flags that always
    // existed; anything else writes into excludedDocKeys, the open-ended list.
    document.querySelectorAll('.bContractDoc').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var key = cb.getAttribute('data-key');
        if (key === 'RELEASE') pb.meta.includeRelease = cb.checked;
        else if (key === 'TERMS') pb.meta.includeTerms = cb.checked;
        else {
          var excl = Array.isArray(pb.meta.excludedDocKeys) ? pb.meta.excludedDocKeys.slice() : [];
          var idx = excl.indexOf(key);
          if (cb.checked) { if (idx !== -1) excl.splice(idx, 1); }
          else if (idx === -1) excl.push(key);
          pb.meta.excludedDocKeys = excl;
        }
        markBuilderDirty();
      });
    });
    // Reference documents are opt-in, so the checked set IS the list — see
    // referenceDocsCard().
    document.querySelectorAll('.bRefDoc').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var key = cb.getAttribute('data-key');
        var sel = Array.isArray(pb.meta.referenceDocKeys) ? pb.meta.referenceDocKeys.slice() : [];
        var idx = sel.indexOf(key);
        if (cb.checked) { if (idx === -1) sel.push(key); }
        else if (idx !== -1) sel.splice(idx, 1);
        pb.meta.referenceDocKeys = sel;
        markBuilderDirty();
      });
    });
    if (window.SSGFrontMatter) {
      window.SSGFrontMatter.bindPanel(document.getElementById('fmPanel'), pb.meta, function () {
        markBuilderDirty();
        renderBuilderKeepingFocus();
      });
    }
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
    if (document.getElementById('pbJurisRow')) { paintCanadian(); loadCanadian(false); }
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
    // One definition of what a section contains, shared with the up/down arrows. Two
    // reorder paths disagreeing about a section's extent is a bug that only shows up on
    // somebody's proposal.
    function blockAt(i) { return builderBlockAt(i); }

    /**
     * Where a drag from `from` lands if dropped on `to`, computed against the
     * CURRENT array (before anything moves).
     *
     * Returns the index the dragged block will sit immediately before once the
     * move is complete — pb.lines.length means "at the very end" — or null for a
     * no-op drop (nothing dragged, dropped on itself, or dropped on one of the
     * dragged block's own lines).
     *
     * Used by both the drop handler and the preview line drawn while dragging, so
     * the line is never a promise the drop then breaks — same computation, so
     * they cannot disagree.
     *
     * A single line is free to land anywhere it is dropped, including into a
     * different section — see the note on builderSiblings, which is what a
     * cross-section product move actually is. A HEADER is different: it drags a
     * whole section, so the drop has to resolve to a section boundary —
     * immediately before or after a SIBLING section — never to an arbitrary line
     * inside one. Dropping mid-section used to splice the dragged section between
     * two of that OTHER section's own lines, which is what read as products
     * belonging to nobody in particular. Siblings are the same list builderMove
     * already walks a step at a time for the up/down arrows, so a drag can never
     * land anywhere those arrows could not eventually reach.
     */
    function dragBoundary(from, to) {
      if (from == null || from === to) return null;
      var blk = blockAt(from);
      if (to >= blk.from && to < blk.from + blk.count) return null;
      var target;
      if (blk.count > 1) {
        var sib = builderSiblings(from);
        target = null;
        for (var k = 0; k < sib.blocks.length; k++) {
          var b = sib.blocks[k];
          if (to >= b.from && to < b.from + b.count) { target = b; break; }
        }
        if (!target) {
          // Dropped outside every sibling's range: before the first or after the
          // last, or — for a sub-heading — on a product with no sub-heading of
          // its own above it. Land at whichever end is closer rather than guessing.
          var first = sib.blocks[0], last = sib.blocks[sib.blocks.length - 1];
          target = to < first.from
            ? { from: first.from, count: 0 }
            : { from: last.from + last.count, count: 0 };
        }
      } else {
        target = { from: to, count: 1 };
      }
      return blk.from < target.from ? target.from + target.count : target.from;
    }

    /** Remove any preview line left over from a previous hover. */
    function clearDragPreview() {
      var el = document.getElementById('bDragLine');
      if (el) el.remove();
    }

    /** Draw the preview line at the boundary a drop would land on right now. */
    function showDragPreview(boundary) {
      clearDragPreview();
      if (boundary == null) return;
      var rows = document.querySelectorAll('.bRow');
      var line = document.createElement('div');
      line.id = 'bDragLine';
      line.style.cssText = 'height:3px;background:#2f6f4f;border-radius:2px;margin:2px 0;pointer-events:none;';
      for (var idx = 0; idx < rows.length; idx++) {
        if (+rows[idx].getAttribute('data-i') === boundary) {
          rows[idx].insertAdjacentElement('beforebegin', line);
          return;
        }
      }
      // boundary is past the last row: lands at the very end of the proposal.
      if (rows.length) rows[rows.length - 1].insertAdjacentElement('afterend', line);
    }

    document.querySelectorAll('.bRow').forEach(function (row) {
      row.addEventListener('dragstart', function () { bDragFrom = +row.getAttribute('data-i'); row.style.opacity = '0.4'; });
      row.addEventListener('dragend', function () { row.style.opacity = '1'; clearDragPreview(); });
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        showDragPreview(dragBoundary(bDragFrom, +row.getAttribute('data-i')));
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        var to = +row.getAttribute('data-i');
        var from = bDragFrom;
        bDragFrom = null;
        clearDragPreview();
        var boundary = dragBoundary(from, to);
        if (boundary == null) return;
        var blk = blockAt(from);
        // Removing the dragged block shifts everything after it back by its own length.
        var at = boundary > blk.from ? boundary - blk.count : boundary;
        var moved = pb.lines.splice(blk.from, blk.count);
        pb.lines.splice.apply(pb.lines, [Math.max(0, at), 0].concat(moved));
        markBuilderDirty();
        renderBuilder();
      });
    });

    document.querySelectorAll('.bUp, .bDn').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (b.disabled) return;
        var from = +b.getAttribute('data-i');
        var up = b.classList.contains('bUp');
        var to = builderMove(from, up ? -1 : 1);
        if (to === -1) return;
        markBuilderDirty();
        renderBuilder();
        // Follow the row to its new index so the same button is under the cursor for a
        // second press. Without this a rep moving a section three places has to find the
        // arrow again after every click, because the re-render rebuilds every row.
        var again = document.querySelector((up ? '.bUp' : '.bDn') + '[data-i="' + to + '"]');
        if (again && !again.disabled) again.focus();
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
      //
      // The parent files by its OWN catalogue tree position, the same way any
      // other picked part does — it used to always be pushed onto the very end
      // regardless of where the bundle actually sits in the product tree. The
      // components are then spliced in immediately after wherever the parent
      // landed, never through insertLineInOrder themselves: they carry their own
      // part numbers and would otherwise be scattered to THEIR OWN tiers instead
      // of staying under their parent, which is what every bundle-child rule
      // elsewhere (pricing, notes, the printed proposal) depends on.
      document.querySelectorAll('.pkBundle').forEach(function (b) {
        b.addEventListener('click', function () {
          var bn = bundles.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
          if (!bn) return;
          var parent = applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: bn.id, sku: bn.sku || '', name: bn.name, description: bn.proposalDescription || '', quantity: 1, rateMinor: bn.unitPriceMinor || 0, costEach: 0, weightEach: 0, group: bn.name });
          var at = insertLineInOrder(parent);
          (bn.components || []).forEach(function (c, idx) {
            pb.lines.splice(at + 1 + idx, 0, applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: c.productId, sku: c.sku || '', name: '— ' + c.name, description: '', quantity: c.quantity || 1, rateMinor: 0, costEach: c.unitCostMinor || 0, weightEach: c.weightLbs || 0, group: bn.name }));
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
    return {
      title: pb.title, number: pb.number, orgName: pb.orgName, meta: pb.meta, lines: pb.lines,
      status: pb.status, version: pb.version,
      totals: builderTotals(),
      // Already loaded for the rail. Attached only when it belongs to THIS version,
      // so a stale answer from a previously open proposal cannot reach a document.
      crossBorder: (cbData && cbData.versionId === pb.versionId && cbData.applicable) ? cbData : null
    };
  }

  /** The version payload, shared by the Save button and the quiet save below. */
  function builderVersionPayload() {
    var sections = [{ id: 'meta', type: 'CUSTOMER_INFO', title: 'Proposal', order: 0, enabled: true, data: pb.meta }];
    var items = pb.lines.map(function (l, i) { return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, internalNote: l.internalNote || '', components: l.components || null, source: l.source || '', freightTbd: !!l.freightTbd, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, costEach: Number(l.costEach) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i }; });
    return { title: pb.title || undefined, sections: sections, items: items, expirationDate: pb.meta.expiration || undefined, expectedUpdatedAt: pb.updatedAt || undefined };
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
    if (r.status === 409) throw new Error('Someone else saved this proposal while you were editing it. Reload before raising the request.');
    if (!r.ok) throw new Error('Could not save the proposal before raising the request (' + r.status + ').');
    var qj = null; try { qj = await r.json(); } catch (e) {}
    if (qj && qj.updatedAt) pb.updatedAt = qj.updatedAt;
    clearBuilderDirty();
  }

  async function saveBuilder() {
    var btn = document.getElementById('bSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var r = await authed('/proposals/versions/' + pb.versionId, { method: 'PATCH', body: builderVersionPayload() });
      if (r.status === 409) { alert('Someone else saved this proposal while you were editing it. Reload the page to see their changes before saving yours.'); btn.disabled = false; btn.textContent = 'Save'; return; }
      if (!r.ok) { alert('Could not save (' + r.status + ').'); btn.disabled = false; btn.textContent = 'Save'; return; }
      var sj = null; try { sj = await r.json(); } catch (e) {}
      if (sj && sj.updatedAt) pb.updatedAt = sj.updatedAt;
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
    // Fetched here rather than reused from the rail, because this path also builds
    // the document that goes for signature and to the deal board — those must carry
    // the Canadian content even when nobody has the builder open. A failure leaves
    // crossBorder null, which prints the document exactly as it prints today.
    var cb = null;
    try {
      var rc = await authed('/proposals/versions/' + version.id + '/cross-border');
      if (rc.ok) { var body = await rc.json(); if (body && body.applicable) cb = body; }
    } catch (e0) {}
    // One organization, by id. This used to list a hundred of them and filter in
    // the browser for the single name it needed — on the release path, before the
    // document could even start building. A customer outside the first hundred also
    // printed with no name at all.
    try {
      var ro = await authed('/crm/organizations/' + encodeURIComponent(proposal.organizationId));
      if (ro.ok) { var o = await ro.json(); orgName = (o && o.name) || ''; }
    } catch (e) {}
    var secs = version.sections || []; var metaSec = Array.isArray(secs) ? secs.filter(function (s) { return s && s.id === 'meta'; })[0] : null;
    var meta = (metaSec && metaSec.data) || {};
    var lines = (version.items || []);
    var subtotal = 0, weight = 0; var pCounted = countedRevenueByIndex(lines); lines.forEach(function (l, i) { if ((l.lineType || 'PRODUCT') === 'PRODUCT') { subtotal += pCounted[i]; weight += (Number(l.quantity) || 0) * (Number(l.weightEach) || 0); } });
    var tpFreight = 0; lines.forEach(function (l) { if ((l.lineType || 'PRODUCT') === 'PRODUCT') tpFreight += Number(l.tpFreightMinor) || 0; });
    var disc = discountOf(meta, subtotal); var discountPct = disc.pct, discountMode = disc.mode, discount = disc.amount;
    var tax = metaAmount(meta.taxAmountMinor, meta.tbdTax);
    var structureFreight = metaAmount(meta.structureFreightMinor != null ? meta.structureFreightMinor : meta.freightMinor, meta.tbdStructureFreight);
    var matsFreight = metaAmount(meta.matsFreightMinor, meta.tbdMatsFreight);
    var stdFreight = stdFreightOf(meta);
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight + stdFreight;
    return {
      title: proposal.title, number: proposal.number, version: version.version || 1,
      status: version.status || 'DRAFT',
      orgName: orgName, meta: meta, lines: lines, crossBorder: cb,
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

  /* --- Canadian content on the customer's document ------------------------
     USD is the controlling currency and stays exactly as it was. CAD is added
     alongside as a reference figure, always labelled "est." and always derived from
     the USD amount — never the other way round.

     Amounts the customer pays at the border are printed in their own block below
     the Total, never folded into it. Telling a customer that money going to CBSA is
     "payable to Summit" would be wrong on a document they sign. */

  /*
   * The cross-border document helpers moved with it: cbIsCanadian, cbApplies, cbCad,
   * cbDocAmount, cbRateStamp, cbFxBanner, cbSellerLines, cbSellerAddMinor,
   * cbBorderBlock and cbClauses. Every caller of them was the document itself, so
   * they were a closed set and moved as one. public/cross-border.js is a different
   * thing — the Canada admin screen — and is unaffected.
   */

  /**
   * Lay the customer proposal out onto real Letter sheets.
   *
   * The browser's own print pagination cannot count pages, cannot pin a footer to the
   * foot of a sheet, and decides for itself where a table breaks. A proposal is a
   * legal document: every sheet has to say "Page 1 of 3", the footer has to sit in the
   * footer, and a section must not be sliced in half. So the document is measured and
   * packed into fixed 816 x 1056 px sheets before it is ever shown or printed, and
   * preview, print and the server PDF all render the same finished sheets.
   *
   * Only the proposal is paginated. The introduction pages are already fixed sheets of
   * their own and pass through untouched — and they are deliberately left out of the
   * page count, which numbers the legal document, not the brochure in front of it.
   *
   * Takes the container holding a rendered document; replaces #propPrintArea in place.
   */
  function paginateProposalArea(root) {
    var PAGE_W = 816, PAGE_H = 1056;
    var PAD_TOP = 46, PAD_SIDE = 44, PAD_BOTTOM = 64;
    var CONTENT_H = PAGE_H - PAD_TOP - PAD_BOTTOM;

    var area = root.querySelector('#propPrintArea');
    if (!area || area.getAttribute('data-paginated')) return;

    /*
     * Fit the title to a single line before anything is measured.
     *
     * A proposal title is set by a rep and can be any length. Two lines of 23px serif
     * costs a line of the sheet and reads as a paragraph rather than a heading, so the
     * type steps down until it fits — to 14px, below which the title would be smaller
     * than the table it introduces and shrinking further stops helping.
     */
    Array.prototype.forEach.call(area.querySelectorAll('[data-fit-one-line]'), function (el) {
      var size = parseFloat(getComputedStyle(el).fontSize) || 23;
      while (size > 14 && el.scrollWidth > el.clientWidth) {
        size -= 0.5;
        el.style.fontSize = size + 'px';
      }
    });

    var footLeft = area.getAttribute('data-foot-left') || '';
    var footRight = area.getAttribute('data-foot-right') || '';

    /** Outer height including margins — what actually has to be placed. */
    function outerH(el) {
      var cs = getComputedStyle(el);
      return el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }

    // Measure at the true printed content width, off-screen, so nothing flashes.
    var gauge = document.createElement('div');
    gauge.style.cssText = 'position:absolute;left:-10000px;top:0;width:' + (PAGE_W - PAD_SIDE * 2) + 'px;visibility:hidden;';
    gauge.innerHTML = area.innerHTML;
    document.body.appendChild(gauge);

    // Break points: every top-level block, and inside the line-item table every
    // section. A section that fits on a sheet is placed whole; one taller than a
    // sheet falls back to breaking between its rows, because it has to go somewhere.
    var atoms = [];
    Array.prototype.forEach.call(gauge.children, function (node) {
      if (node.tagName === 'TABLE') {
        var head = node.querySelector('thead');
        Array.prototype.forEach.call(node.querySelectorAll('tbody'), function (tb) {
          var rows = Array.prototype.slice.call(tb.children);
          var tall = rows.reduce(function (a, r) { return a + r.getBoundingClientRect().height; }, 0);
          if (tb.hasAttribute('data-group') && tall <= CONTENT_H) {
            atoms.push({ kind: 'section', rows: rows, h: tall, head: head });
          } else {
            rows.forEach(function (tr) {
              atoms.push({ kind: 'row', node: tr, h: tr.getBoundingClientRect().height, head: head });
            });
          }
        });
        return;
      }
      var h = outerH(node);
      // A block taller than a sheet is broken at its own children rather than placed
      // whole and clipped. The standard terms are one such block — twelve clauses in a
      // single wrapper, some 18 inches of text — and placed as one atom they printed
      // as far as the sheet allowed and silently lost the rest.
      //
      // Each child is re-wrapped in a copy of the parent's opening tag on the way out,
      // because the wrapper is what carries the typeface and size for everything in it.
      if (h > CONTENT_H && node.children.length > 1) {
        var shell = node.cloneNode(false);
        shell.removeAttribute('data-page-break');
        var open = shell.outerHTML.replace(/<\/[a-z]+>$/i, '');
        Array.prototype.forEach.call(node.children, function (kid, ki) {
          atoms.push({
            kind: 'block',
            node: kid,
            h: outerH(kid),
            // Only the first child inherits the wrapper's forced break; the rest flow.
            brk: ki === 0 && node.hasAttribute('data-page-break'),
            open: open,
            close: '</' + node.tagName.toLowerCase() + '>',
          });
        });
        return;
      }
      atoms.push({ kind: 'block', node: node, h: h, brk: node.hasAttribute('data-page-break') });
    });

    var sheets = [], cur = [], used = 0;
    function flush() { if (cur.length) { sheets.push(cur); cur = []; used = 0; } }
    function tabular(x) { return x.kind === 'row' || x.kind === 'section'; }

    atoms.forEach(function (a) {
      var headH = a.head ? a.head.getBoundingClientRect().height : 0;
      // A continued table repeats its header, so that height has to be reserved.
      var need = a.h + (a.head && !cur.some(tabular) ? headH : 0);
      if (a.brk) flush();
      else if (used + need > CONTENT_H && used > 0) flush();
      cur.push(a);
      used += need;
    });
    flush();
    gauge.remove();

    var total = sheets.length;
    var out = sheets.map(function (items, i) {
      var inner = '', tableOpen = false, head = null;
      items.forEach(function (it) {
        if (tabular(it)) {
          if (!tableOpen) {
            head = it.head;
            inner += '<table style="width:100%;table-layout:fixed;border-collapse:collapse;">' +
              '<colgroup><col style="width:430px;"><col style="width:100px;"><col style="width:40px;"><col style="width:80px;"><col style="width:78px;"></colgroup>' +
              (head ? head.outerHTML : '') + '<tbody>';
            tableOpen = true;
          }
          inner += it.kind === 'section'
            ? it.rows.map(function (r) { return r.outerHTML; }).join('')
            : it.node.outerHTML;
          return;
        }
        if (tableOpen) { inner += '</tbody></table>'; tableOpen = false; }
        // A child hoisted out of an oversized wrapper is put back inside a copy of it,
        // so it keeps the font, size and colour the wrapper set.
        inner += it.open ? it.open + it.node.outerHTML + it.close : it.node.outerHTML;
      });
      if (tableOpen) inner += '</tbody></table>';
      return '<div class="ssg-sheet" style="width:' + PAGE_W + 'px;height:' + PAGE_H + 'px;box-sizing:border-box;' +
        'padding:' + PAD_TOP + 'px ' + PAD_SIDE + 'px ' + PAD_BOTTOM + 'px;position:relative;overflow:hidden;' +
        'background:#fff;margin:0 auto;font-family:\'IBM Plex Sans\',sans-serif;color:#20241f;">' +
        inner +
        // Pinned to the foot of the sheet, not to the end of the content, and carrying
        // the page count every sheet is required to state.
        '<div style="position:absolute;left:' + PAD_SIDE + 'px;right:' + PAD_SIDE + 'px;bottom:32px;' +
          'display:flex;justify-content:space-between;align-items:baseline;gap:20px;' +
          'padding-top:9px;border-top:1px solid #eceef4;font-size:9.5px;color:#9aa1b0;">' +
          '<span>' + footLeft + '</span>' +
          '<span>' + footRight + '</span>' +
          '<span style="white-space:nowrap;">Page ' + (i + 1) + ' of ' + total + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    var holder = document.createElement('div');
    holder.className = 'ssg-proposal-sheets';
    holder.setAttribute('data-paginated', '1');
    holder.innerHTML = out;
    area.parentNode.replaceChild(holder, area);
  }

  /**
   * Turn a rendered document into a page viewer: centred sheets, zoom, and a grid.
   *
   * Both halves of what a rep reviews are already fixed sheets — the introduction
   * pages are authored at 816 x 1056, and the proposal is packed onto sheets of the
   * same size by paginateProposalArea — so the viewer only has to arrange them. That
   * is the point: what is on screen is the set of printed pages, with the real breaks,
   * not a continuous document that will break somewhere else on paper.
   *
   * Zoom is a transform on the stage rather than a width change, so a sheet is never
   * re-laid-out at a different size and the page breaks cannot shift as you zoom. The
   * scroller is given a compensating height so scrolling still reaches the last page.
   *
   * Returns a function that re-measures after the content changes.
   */
  function mountPreviewViewer(ov, sel) {
    var LS_KEY = 'ssgPreviewView';
    var pages = Array.prototype.slice.call(ov.querySelectorAll('.ssg-sheet, .ssg-fm-page'));
    if (!pages.length) return function () {};

    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    var zoom = Number(saved.zoom) || 0;   // 0 = fit the window
    var grid = !!saved.grid;

    // Every page becomes a direct child of one stage. The introduction pages arrive
    // inside a .ssg-front-matter wrapper and the proposal sheets inside the holder the
    // paginator built; left nested, the stage would have two flex children and a grid
    // could never place two pages side by side. The wrappers carry nothing but the
    // pages, so they are dropped.
    var stage = document.createElement('div');
    stage.id = 'pvStage';
    var bar = ov.querySelector('#pvBar');
    pages.forEach(function (p) { stage.appendChild(p); });
    Array.prototype.slice.call(ov.children).forEach(function (c) {
      if (c !== bar && c !== stage) c.remove();
    });

    var frame = document.createElement('div');
    frame.id = 'pvFrame';
    frame.className = 'noprint-passthrough';
    frame.style.cssText = 'position:relative;';
    frame.appendChild(stage);
    ov.appendChild(frame);

    function fitZoom() {
      var avail = ov.clientWidth - 48;
      var per = grid ? 2 : 1;
      var need = 816 * per + 28 * (per - 1) + 4;
      return Math.min(1.5, Math.max(0.15, avail / need));
    }

    function apply() {
      var z = zoom || fitZoom();
      var stageW = grid ? (816 * 2 + 28 + 4) : 816;
      stage.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;align-items:flex-start;' +
        'gap:28px;width:' + stageW + 'px;' +
        // Scaled from the top left and centred by the frame instead: a stage wider
        // than the window cannot be centred by margin:auto, which is what pushed the
        // grid off to one side.
        'transform:scale(' + z + ');transform-origin:top left;';
      pages.forEach(function (p) {
        p.style.margin = '0';
        p.style.flex = '0 0 auto';
        p.style.boxShadow = '0 2px 24px rgba(32,48,96,.13)';
      });
      // The transform does not change layout, so the frame is given the on-screen size
      // explicitly — otherwise it would centre the unscaled width and scrolling would
      // stop short of the last page.
      frame.style.width = Math.ceil(stageW * z) + 'px';
      frame.style.height = Math.ceil(stage.scrollHeight * z) + 'px';
      frame.style.margin = '0 auto';
      frame.style.overflow = 'hidden';
      var pct = ov.querySelector('#pvZoomPct');
      if (pct) pct.textContent = Math.round(z * 100) + '%';
      var gb = ov.querySelector('#pvGrid');
      if (gb) {
        gb.textContent = grid ? 'Single page' : 'Grid';
        gb.setAttribute('aria-pressed', grid ? 'true' : 'false');
      }
      try { localStorage.setItem(LS_KEY, JSON.stringify({ zoom: zoom, grid: grid })); } catch (e) { /* private mode */ }
    }

    function step(dir) {
      var z = zoom || fitZoom();
      zoom = Math.min(1.5, Math.max(0.15, Math.round((z + dir * 0.1) * 100) / 100));
      apply();
    }

    if (sel) {
      var out = sel.querySelector('#pvZoomOut'), inn = sel.querySelector('#pvZoomIn');
      var fit = sel.querySelector('#pvFit'), gb2 = sel.querySelector('#pvGrid');
      if (out) out.addEventListener('click', function () { step(-1); });
      if (inn) inn.addEventListener('click', function () { step(1); });
      if (fit) fit.addEventListener('click', function () { zoom = 0; apply(); });
      if (gb2) gb2.addEventListener('click', function () { grid = !grid; if (zoom) zoom = 0; apply(); });
    }
    // Ctrl/Cmd + wheel zooms, as it does in every other document viewer.
    ov.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      step(e.deltaY > 0 ? -1 : 1);
    }, { passive: false });
    window.addEventListener('resize', apply);

    apply();
    // Fonts land after the first paint and change the measured height.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(function () {});
    return apply;
  }

  /*
   * The customer proposal document now lives in public/proposal-document.js.
   *
   * Moved out because it is the part of this file changed most often, and this file
   * has no module boundaries — a syntax error anywhere in it blanks the whole
   * workspace. The document's own 555 lines, and the ten cross-border helpers only it
   * used, are now the only thing that breaks when the document changes.
   *
   * The rules it needs from here — deposit, discount wording, freight TBD, model code —
   * are handed over once at load rather than duplicated, so there is still exactly one
   * implementation of each. See wireProposalDocument below.
   */
  function proposalDocHtml(doc) {
    if (!window.SSGProposalDocument) {
      // Only reachable if the script tag is missing or failed to load. Says which
      // file, because "undefined is not a function" would not.
      throw new Error('proposal-document.js did not load — the proposal cannot be rendered.');
    }
    return window.SSGProposalDocument.html(doc);
  }

  /**
   * Hand the shared business rules to the document renderer.
   *
   * Called once, from boot. These are the functions the builder and the document must
   * agree on: a second copy of the deposit rule inside the renderer is how a signed
   * document ends up stating a different figure from the screen it was made on.
   */
  function wireProposalDocument() {
    if (!window.SSGProposalDocument) return;
    window.SSGProposalDocument.useRules({
      overrideMinor: overrideMinor,
      depositOf: depositOf,
      depositPct: depositPct,
      stripOptional: stripOptional,
      showsFreightTbd: showsFreightTbd,
      proposalModelCode: proposalModelCode,
      discountLabel: discountLabel,
      // Not formatting, despite appearing so. rt is shared with the builder, which
      // shows the rep the same note as they type it; freightTbdNote is a sentence
      // that prints on a signed document; documentUser reads live state and so
      // cannot be copied at all.
      rt: rt,
      freightTbdNote: FREIGHT_TBD_NOTE,
      // Dates, for the same reason. The renderer's own copies answered in UTC, which
      // printed yesterday's date on the document for part of every day west of
      // Greenwich. These are the shell's — and now ssg-ui.js's — single versions.
      fmtDate: fmtDate,
      todayISO: todayISO,
      documentUser: function () {
        return (pb && pb.user) || currentUser || {};
      },
    });
  }
  /**
   * A standalone document for the server renderer: the same markup, the same fonts and
   * the same paginator the rep saw on screen.
   *
   * The fonts are fetched rather than substituted. A local serif has different metrics,
   * which changes where lines wrap, which changes where sheets break — so a substituted
   * PDF is not the document that was approved. render/pdf.ts waits for the faces to
   * load and for pagination to finish before it takes the picture.
   */
  function proposalStandaloneHtml(doc) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(doc.title || 'Proposal') + '</title>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700&display=swap">' +
      '<style>@page{size:letter;margin:0;}body{margin:0;font-family:"IBM Plex Sans",-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#20241f;}' +
      '#propPrintArea{padding:0.5in;box-sizing:border-box;max-width:none;}' +
      // Sheets produced by the paginator below.
      '.ssg-sheet{width:8.5in;height:11in;margin:0;overflow:hidden;box-sizing:border-box;' +
        'break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always;}' +
      '.ssg-sheet:last-child,.ssg-fm-page:last-child{break-after:auto;page-break-after:auto;}' +
      'tr{break-inside:avoid;}thead{display:table-header-group;}' +
      'tbody[data-group]{break-inside:avoid;page-break-inside:avoid;}' +
      '.ssg-fm-page{width:8.5in;height:11in;min-height:0;margin:0;overflow:hidden;' +
        'break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always;}' +
      "*[style*='Newsreader']{font-family:Georgia,serif !important;}</style></head><body>" +
      proposalDocHtml(doc) +
      // The same pagination the rep sees, run before the renderer takes the picture:
      // fixed sheets, a pinned footer and "Page N of M" on every one. The function is
      // shipped as source so there is one implementation, not two that drift.
      '<script>' + paginateProposalArea.toString() +
        ';(function(){' +
          'function go(){try{paginateProposalArea(document.body);}catch(e){}' +
            // A forced break after the LAST sheet opens a page with nothing on it. The
            // rule above catches it as :last-child; this catches it by document order,
            // which is the version that cannot be defeated by a wrapper element.
            'try{var ss=document.querySelectorAll(".ssg-sheet,.ssg-fm-page");' +
              'if(ss.length){var lp=ss[ss.length-1];lp.style.breakAfter="auto";lp.style.pageBreakAfter="auto";}}catch(e){}' +
            'document.documentElement.setAttribute("data-paginated","1");}' +
          // Measure with the real faces, never with the fallback: a sheet packed
          // against fallback metrics breaks in a different place.
          'if(document.fonts&&document.fonts.ready){document.fonts.ready.then(go).catch(go);}else{go();}' +
        '})();<\/script>' +
      '</body></html>';
  }

  function previewProposalDoc(doc, printNow) {
    ensurePrintStyle();
    var html = proposalDocHtml(doc);
    var ov = document.createElement('div');
    ov.id = 'propPreviewOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#e7e8e3;z-index:60;overflow:auto;padding:24px 16px;';
    // The toolbar carries the what-to-generate switch, so the introduction and the
    // proposal can be pulled separately or together from any version at any time —
    // nothing here depends on the proposal's status and nothing is saved.
    function toolbarHtml() {
      function vb(id, label, title) {
        return '<button class="link-btn" id="' + id + '" title="' + title + '" ' +
          'style="width:auto;padding:6px 11px;background:#fff;font-size:12px;">' + label + '</button>';
      }
      return '<div class="noprint" id="pvBar" style="position:sticky;top:-24px;z-index:5;background:#e7e8e3;padding:24px 16px 14px;margin:-24px -16px 16px;border-bottom:1px solid #d9dad5;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
        '<button class="link-btn" id="pvClose" style="width:auto;padding:9px 16px;background:#fff;">‹ Close preview</button>' +
        // View controls: the pages are real printed sheets, so the viewer gives the
        // same handles any document viewer does.
        '<div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #dfe3ec;border-radius:9px;padding:4px;">' +
          vb('pvZoomOut', '&minus;', 'Zoom out (Ctrl/Cmd + scroll)') +
          '<span id="pvZoomPct" style="min-width:46px;text-align:center;font-size:12px;color:#5b6478;font-variant-numeric:tabular-nums;">100%</span>' +
          vb('pvZoomIn', '+', 'Zoom in (Ctrl/Cmd + scroll)') +
          '<span style="width:1px;height:20px;background:#e6e9f0;"></span>' +
          vb('pvFit', 'Fit', 'Fit the window') +
          vb('pvGrid', 'Grid', 'Show two pages side by side') +
        '</div>' +
        // The what-to-generate switch sits with the print button, because it is a
        // property of the thing about to be produced.
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end;">' +
          (window.SSGFrontMatter ? window.SSGFrontMatter.scopeToggleHtml(doc) : '') +
          '<button class="btn" id="pvPrint" style="width:auto;padding:9px 20px;">Print / Save PDF</button>' +
        '</div>' +
      '</div>';
    }
    ov.innerHTML = toolbarHtml() + html;
    document.body.appendChild(ov);
    paginateProposalArea(ov);
    mountPreviewViewer(ov, ov);

    function wire() {
      document.getElementById('pvClose').addEventListener('click', function () { document.body.removeChild(ov); });
      document.getElementById('pvPrint').addEventListener('click', firePrint);
      if (window.SSGFrontMatter) {
        window.SSGFrontMatter.bindScopeToggle(ov, function () {
          ov.innerHTML = toolbarHtml() + proposalDocHtml(doc);
          paginateProposalArea(ov);
          mountPreviewViewer(ov, ov);
          ov.scrollTop = 0;
          wire();
        });
      }
    }
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
    wire();
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
    var model = '', size = '', firstGroup = '';
    (d.lines || []).forEach(function (l) {
      if ((l.lineType || '') !== 'GROUP') return;
      if (!firstGroup && l.name) firstGroup = String(l.name);
      if (!model && /itemized/i.test(l.name || '')) {
        model = String(l.name).replace(/\s*[-\u2013\u2014]\s*itemized.*$/i, '').trim();
      }
      if (!size) {
        var sm = String(l.description || '').match(/(\d+)\s*'?\s*[\u00d7x]\s*(\d+)/i);
        if (sm) size = sm[1] + 'x' + sm[2];
      }
    });
    // Only Adventure Series writes an "— Itemized" heading. Soar, Flex and anything
    // else has no per-job model code, only a fixed catalog group name ("SUMMIT SOAR
    // SERIES") — without this, "no model code" silently became "no product name at
    // all" in the file name. The first group heading, title-cased, stands in for it.
    if (!model && firstGroup) {
      model = firstGroup.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
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
    st.textContent =
      // Zero page margin so an introduction page prints edge to edge at its authored
      // 8.5in x 11in. The itemized proposal takes that half inch back as padding below,
      // so it prints exactly as it always has.
      '@page{size:letter;margin:0;}' +
      '@media print{html,body{height:auto!important;overflow:visible!important;background:#fff!important;}' +
      'body > *{display:none!important;}body > #propPreviewOverlay,body > #psOverlay{display:block!important;}' +
      '#propPreviewOverlay{position:static!important;inset:auto!important;height:auto!important;background:#fff!important;padding:0!important;overflow:visible!important;}#psOverlay .noprint{display:none!important;}#propPreviewOverlay .noprint{display:none!important;}' +
      // A section (heading, lines, subtotal) is one <tbody> and stays on one sheet;
      // where a section is taller than a sheet the engine drops the rule rather than
      // losing content. The header row repeats on every continued sheet.
      'tbody[data-group]{break-inside:avoid!important;page-break-inside:avoid!important;}' +
      'thead{display:table-header-group!important;}' +
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
      // Proposal sheets are laid out at exactly 8.5in x 11in with their own margins
      // and a pinned footer, so print must not add padding or rescale them.
      '#psOverlay{position:static!important;padding:0!important;background:#fff!important;overflow:visible!important;}' +
      '#psOverlay .ssg-sheet{width:8.5in!important;height:11in!important;margin:0!important;transform:none!important;' +
        'box-shadow:none!important;overflow:hidden!important;break-inside:avoid!important;page-break-inside:avoid!important;' +
        'break-after:page!important;page-break-after:always!important;}' +
      '#propPreviewOverlay .ssg-sheet{width:8.5in!important;height:11in!important;margin:0!important;' +
        'box-shadow:none!important;overflow:hidden!important;break-inside:avoid!important;page-break-inside:avoid!important;' +
        'break-after:page!important;page-break-after:always!important;}' +
      '#propPreviewOverlay .ssg-proposal-sheets{background:#fff!important;}' +
      '#propPreviewOverlay #pvStage{transform:none!important;width:auto!important;display:block!important;gap:0!important;}' +
      '#propPreviewOverlay #pvFrame{width:auto!important;height:auto!important;overflow:visible!important;margin:0!important;}' +
      '#propPreviewOverlay .ssg-sheet,#propPreviewOverlay .ssg-fm-page{box-shadow:none!important;}' +
      '#propPrintArea{padding:0.5in!important;max-width:none!important;}' +
      // Each introduction page is one sheet, printed at the size it was designed at.
      '#propPreviewOverlay .ssg-fm-page{width:8.5in!important;height:11in!important;min-height:0!important;' +
        'margin:0!important;overflow:hidden!important;break-inside:avoid!important;page-break-inside:avoid!important;' +
        'break-after:page!important;page-break-after:always!important;}' +
      '#psOverlay .ssg-sheet:last-child,#propPreviewOverlay .ssg-sheet:last-child,' +
        '#propPreviewOverlay .ssg-fm-page:last-child{break-after:auto!important;page-break-after:auto!important;}' +
      '#propPreviewOverlay .ssg-front-matter{background:#fff;}}';
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
    adv.ladderShield = !!a.ladderShield;
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
      ladderShield: adv.ladders ? !!adv.ladderShield : false,
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
            ? '<div style="margin-bottom:14px;padding:10px 12px;background:#fdf6e6;border:1px solid #ecd9a6;border-radius:9px;font-size:12px;color:#6b5a24;line-height:1.6;">' + noPrice + ' of these part numbers carried no unit price when this line was built, so they added $0.00 to the kit. Set their price on the Catalog tab and re-generate.</div>'
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
          sel.disabled = true;
          var r = await authed(path, { method: 'PATCH', body: { status: sel.value } });
          sel.disabled = false;
          if (!r.ok) alert(await serverMessage(r, 'Could not update (' + r.status + ').'));
          // Repaint either way. On success the "who changed it, and when" line
          // under the status is now wrong, and it used to stay wrong until you
          // left the order and came back into it.
          openOrderDetail(id, user);
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
  /* What the accepted proposal would produce under today's rules, against what is
   * actually on the sheet. A BOM is allowed to differ — kits and component lists
   * replace parts deliberately — but a difference no rule accounts for is a wrong
   * sheet, and until this existed nothing compared the two documents at all. */
  var bomRecon = null;

  // The one-argument bomFieldStyle that used to live here was dead: a second
  // declaration further down (with a `locked` argument) hoisted over it, so every
  // caller was already getting that version. Removed rather than left to mislead the
  // next reader — the surviving one renders identically when `locked` is falsy.

  /* Per-vendor sections. Each vendor gets its own header, questions, colours,
   * lock and send history — a fabricator and a distributor are prepared, confirmed
   * and sent independently, so one shared header could never be right. */
  var bomSectionData = [];
  var bomBrands = [];
  /** The ship-to address book, loaded with the sections that offer it. */
  var bomShipToAddresses = [];
  /**
   * Off by default: the list is scoped to this order, so another customer's
   * portal-confirmed address cannot be picked by accident. On, it shows every saved
   * address including other orders'.
   */
  var bomAllAddresses = false;


  /**
   * The unit cost, editable while the section is open.
   *
   * Costs are copied onto the order at acceptance and never re-read, which is what
   * keeps a sent sheet honest — but it also means a catalog typo is stuck on every
   * job already in flight. This is the per-line correction; "Refresh costs" below
   * does the whole section at once.
   *
   * Cost is internal. Changing it moves this sheet's totals and the job's margin and
   * reaches nothing the customer has seen.
   */
  /**
   * Money for the cost column. `money2` inside sectionCard is out of scope here — the
   * original only reached it on a branch that never ran, which is why the omission went
   * unnoticed until this cell printed a second figure.
   */

  function costCell(p, edit) {
    var drift = catalogDrift(p);
    var note = drift == null ? '' :
      '<div style="margin-top:4px;font-size:11px;line-height:1.45;color:#8a6d1f;white-space:nowrap;" ' +
        'title="This line carries the cost snapshotted when the order was accepted. The catalog has changed since.">' +
        'Catalog ' + costMoney(drift) +
        (edit
          ? ' <button class="bomUseCat" data-id="' + p.id + '" data-cost="' + drift + '" ' +
            'title="Put the catalog cost on this line. Internal — the proposal and invoice are untouched." ' +
            'style="border:1px solid #e4dfd0;background:#fdfcf7;color:#6b5a24;border-radius:7px;padding:2px 7px;font-size:11px;cursor:pointer;margin-left:4px;">Use</button>'
          : '') +
      '</div>';
    if (!edit) return costMoney(p.unitCostMinor) + note;
    return '<input class="bomLine" data-id="' + p.id + '" data-f="unitCostMinor" ' +
      'value="' + (Number(p.unitCostMinor || 0) / 100).toFixed(2) + '" ' +
      'inputmode="decimal" title="Unit cost. Internal — the customer never sees it." ' +
      'style="' + bomFieldStyle('92px') + 'text-align:right;background:#fdfcf7;border-color:' +
      (drift == null ? '#e4dfd0' : '#d8b64a') + ';">' + note;
  }

  /**
   * The catalog cost of a line, when it differs from what the line carries.
   *
   * Costs are snapshotted at acceptance and never re-read — that is what keeps a sent
   * sheet honest — so a catalog correction silently misses every job already in
   * flight. Returning the difference is what lets the screen say so while someone is
   * building the sheet, rather than after the vendor has it.
   */
  /**
   * The invoiced cell, and the two differences beside it.
   *
   * One number to type: what the vendor billed per unit. The comparison is against
   * the cost on the sheet they were sent, and both differences are shown because they
   * answer different questions — the percentage says whether the price moved, the
   * dollar figure says whether it matters on this job.
   *
   * Negative is red, always: on this screen negative means the vendor billed less than
   * the sheet said, which is as much a discrepancy as billing more.
   */
  var RED = '#a2402f';
  function invCell(p, edit) {
    var v = p.invoicedUnitCostMinor;
    var nb = !!p.invoiceNotBilled;
    var val = v == null ? '' : (Number(v) / 100).toFixed(2);
    if (!edit) {
      if (nb) return '<span style="color:' + RED + ';font-weight:600;font-size:11.5px;">Not billed</span>';
      return v == null ? '<span class="muted">—</span>' : costMoney(v);
    }
    // The toggle is the whole point of the column: an unbilled line and an unchecked
    // line look identical without it, and an unbilled line is usually an UNSHIPPED
    // line — which turns up in the shop weeks later as a missing part.
    var toggle = '<button class="link-btn bomNotBilled" data-id="' + p.id + '" data-on="' + (nb ? '1' : '0') + '" ' +
      'title="' + (nb ? 'Marked as not on their invoice. Click to undo.' : 'They did not bill for this line at all.') + '" ' +
      'style="width:auto;padding:2px 6px;font-size:10.5px;margin-top:3px;' +
      (nb ? 'color:' + RED + ';font-weight:600;' : 'color:#8a8f85;') + '">' +
      (nb ? '✓ Not billed' : 'Not billed') + '</button>';
    if (nb) {
      return '<div style="text-align:right;"><span style="color:' + RED + ';font-weight:600;font-size:11.5px;">Not billed</span><br>' + toggle + '</div>';
    }
    return '<div style="text-align:right;"><input class="bomLine" data-id="' + p.id + '" data-f="invoicedUnitCostMinor" ' +
      'value="' + val + '" inputmode="decimal" placeholder="—" ' +
      'title="What the vendor invoiced for this part, per unit. Leave empty until you have checked this line." ' +
      'style="' + bomFieldStyle('92px') + 'text-align:right;background:#fff;border-color:' +
      (v == null ? '#dcded7' : '#cbd3c9') + ';"><br>' + toggle + '</div>';
  }

  /** The per-unit difference across the line's quantity — the money at stake. */
  function invDelta(p) {
    if (!p) return null;
    var qty = Number(p.quantity) || 0;
    // Not billed is invoiced at nothing: the arithmetic is a full negative variance,
    // which is correct, even though it reads as a saving and rarely is one.
    if (p.invoiceNotBilled) {
      var u = -Number(p.unitCostMinor || 0);
      return { unit: u, ext: u * qty, notBilled: true };
    }
    if (p.invoicedUnitCostMinor == null) return null;
    var unit = Number(p.invoicedUnitCostMinor) - Number(p.unitCostMinor || 0);
    return { unit: unit, ext: unit * qty, notBilled: false };
  }

  function invDeltaCell(p) {
    var d = invDelta(p);
    if (!d) return '<span class="muted">—</span>';
    if (d.notBilled) {
      return '<span style="font-variant-numeric:tabular-nums;font-weight:600;color:' + RED + ';">' + costMoney(d.ext) + '</span>' +
        '<div style="font-size:10.5px;color:' + RED + ';line-height:1.35;">check it shipped</div>';
    }
    if (!d.ext && !d.unit) return '<span style="color:#2f7d5d;">—</span>';
    var neg = d.ext < 0;
    return '<span style="font-variant-numeric:tabular-nums;font-weight:600;color:' + (neg ? RED : '#20241f') + ';">' +
        (d.ext > 0 ? '+' : '') + costMoney(d.ext) + '</span>' +
      '<div class="muted" style="font-size:11px;color:' + (neg ? RED : '#8a8f85') + ';">' +
        (d.unit > 0 ? '+' : '') + costMoney(d.unit) + ' each</div>';
  }

  function invPctCell(p) {
    var d = invDelta(p);
    if (!d) return '<span class="muted">—</span>';
    var base = Number(p.unitCostMinor || 0);
    if (!base) return '<span class="muted">n/a</span>';
    var pct = (d.unit / base) * 100;
    if (!pct) return '<span style="color:#2f7d5d;">0%</span>';
    return '<span style="font-variant-numeric:tabular-nums;font-weight:600;color:' +
      (pct < 0 ? RED : '#20241f') + ';">' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%</span>';
  }

  function catalogDrift(p) {
    if (!p || p.catalogCostMinor == null) return null;
    var cat = Number(p.catalogCostMinor);
    if (!isFinite(cat)) return null;
    return cat === Number(p.unitCostMinor || 0) ? null : cat;
  }


  /** The sheet against the proposal: only what no rule explains. */
  function bomReconHtml() {
    var r = bomRecon;
    if (!r || r.clean) return '';
    var list = function (label, rows, fmt) {
      if (!rows || !rows.length) return '';
      return '<div style="margin-top:7px;"><b style="font-weight:600;">' + label + '</b>' +
        '<ul style="margin:4px 0 0;padding-left:18px;">' +
        rows.slice(0, 12).map(fmt).join('') +
        (rows.length > 12 ? '<li>and ' + (rows.length - 12) + ' more</li>' : '') +
        '</ul></div>';
    };
    var part = function (p) { return '<code>' + esc(p.sku || '—') + '</code>'; };
    return '<div style="background:#fbecea;border:1px solid #f0ccc6;border-radius:11px;padding:12px 14px;font-size:12.5px;line-height:1.55;color:#7a2f22;margin-bottom:14px;">' +
      '<b style="font-weight:700;">This Bill of Materials does not match the accepted proposal.</b>' +
      '<div style="margin-top:4px;">Everything below is a difference no kit, component list or roll-up accounts for. Check it before the sheet goes to a vendor.</div>' +
      list('On the proposal, missing from the sheet', r.missing, function (p) {
        return '<li>' + part(p) + ' ' + esc(p.name || '') + ' \u00d7' + p.quantity + '</li>';
      }) +
      list('On the sheet, not on the proposal', r.unexpected, function (p) {
        return '<li>' + part(p) + ' ' + esc(p.name || '') + ' \u00d7' + p.quantity + '</li>';
      }) +
      list('Quantities that disagree', r.quantity, function (p) {
        return '<li>' + part(p) + ' ' + esc(p.name || '') + ' \u2014 proposal ' + p.proposal + ', sheet ' + p.sheet + '</li>';
      }) +
      list('Part numbers that are in no catalog', r.unknownParts, function (p) {
        return '<li>' + part(p) + ' ' + esc(p.name || '') +
          ' \u2014 the number matches nothing; the cost and weight on this line came from a description match</li>';
      }) +
      '</div>';
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
      var ra = await authed('/ship-to-addresses?orderId=' + encodeURIComponent(order.id) +
        (bomAllAddresses ? '&all=true' : ''));
      bomShipToAddresses = ra.ok ? ((await ra.json()) || []) : [];
      var rr = await authed('/orders/' + order.id + '/bom-reconciliation');
      bomRecon = rr.ok ? await rr.json() : null;
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
        '<label style="display:flex;gap:7px;align-items:center;font-size:12.5px;color:#5c6157;cursor:pointer;white-space:nowrap;" title="Off, the ship-to list shows this order’s confirmed address and the reusable ones. On, it also shows addresses confirmed by other orders’ customers.">' +
          '<input type="checkbox" id="bomAllAddr"' + (bomAllAddresses ? ' checked' : '') + '> Show every saved address</label>' +
        (canHandoff
          ? '<button class="link-btn" id="bomApplyBuild" title="Re-read Catalog → BOM build: explode any part declared as made of other parts, and move free-issue parts onto the vendor they ship to" style="width:auto;padding:8px 14px;white-space:nowrap;">Apply BOM build rules</button>' +
            '<button class="link-btn" id="bomCostRefresh" title="Compare every line against the catalog cost and pick which to bring up to date. Internal only — the customer’s proposal and invoice are untouched." style="width:auto;padding:8px 14px;white-space:nowrap;">Refresh costs from catalog</button>'
          : '') +
      '</div>' +
      bomReconHtml() +
      bomSectionData.map(function (s, i) { return sectionCard(s, i, canHandoff); }).join('') +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">' +
        '<button class="link-btn" data-proc="csv" data-vendor="*" style="width:auto;padding:8px 14px;">Export all vendors — Excel</button>' +
        '<button class="link-btn" data-proc="csvfile" data-vendor="*" style="width:auto;padding:8px 14px;">Export all vendors — CSV</button>' +
        '<button class="link-btn" data-proc="pdf" data-vendor="*" style="width:auto;padding:8px 14px;">Export all vendors — PDF</button>' +
      '</div>';
    wireBom(order, user, canHandoff);
  }

  /**
   * Whether this vendor's money from the deal has actually landed.
   *
   * A figure has to contain a digit to count: the freight field can hold "TBD" and the
   * board can answer "Yes" to a freight REQUEST, and neither is a shipment total. Tax
   * only counts where the vendor carries it — one vendor holds the job's tax, so
   * demanding it everywhere would leave every other section looking unfinished.
   */
  function dealFiguresIn(s) {
    var hasFigure = function (v) { return /\d/.test(String(v == null ? '' : v)); };
    if (!hasFigure(s.shipmentQuote)) return false;
    return !s.showsEstimatedTax || hasFigure(s.estimatedTax);
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

    // Said at the top of the vendor's block, not only per line: the person about to
    // email this sheet should not have to scan the table to learn it is stale.
    var driftCount = lines.filter(function (p) { return catalogDrift(p) != null; }).length;
    if (driftCount) {
      statusChip += '<span class="chip" style="background:#fdf6e6;color:#6b5a24;border:1px solid #ecd9a6;" ' +
        'title="These lines carry the cost snapshotted at acceptance; the catalog has changed since. Use the catalog figure per line, or Refresh costs from catalog.">' +
        driftCount + ' line' + (driftCount === 1 ? '' : 's') + ' differ from catalog</span>';
    }

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
    // +3 for the invoice columns: invoiced each, Δ $, Δ %.
    var cols = 11 + (showVendorPart ? 1 : 0) + (showColor ? 1 : 0) + (showBag ? 1 : 0) + (edit ? 1 : 0);
    var rowHtmlFor = function (p) {
      // Free issue: bought elsewhere, shipped here, already paid for. The row shows
      // what is arriving and no money, matching the sheet this vendor is sent.
      var free = !!p.freeIssue;
      var ext = free ? 0 : (Number(p.unitCostMinor) || 0) * (Number(p.quantity) || 0);
      var buy = p.productUrl
        ? ' <a href="' + esc(p.productUrl) + '" target="_blank" rel="noopener" style="font-size:11.5px;margin-left:6px;">Buy ↗</a>' : '';
      var freeCell = '<span class="muted" title="Summit has already paid for this part. It prints on the vendor’s sheet with no cost and is left out of their total.">Free issue</span>';
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(p.name) + '</b>' + buy +
          // A line that replaced a proposal part says so. Without this, a component
          // list pointing at the wrong part number is indistinguishable from a part
          // the customer actually bought.
          (p.kitSku
            ? '<div class="muted" style="font-size:11px;margin-top:3px;">from <code>' + esc(p.kitSku) +
              '</code> on the proposal \u00b7 component list</div>'
            : '') +
          (free
            ? '<div style="margin-top:3px;"><span class="chip" style="font-size:10px;background:#eef0ea;color:#5c6157;">Free issue</span>' +
              '<span class="muted" style="font-size:11px;margin-left:6px;">Paid by Summit' +
              (p.purchaseVendor ? ' · bought from ' + esc(p.purchaseVendor) : '') + '</span></div>'
            : '')) +
        td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(p.sku || '—') + '</code>') +
        (showVendorPart ? td(p.vendorPart
          ? '<code style="font-size:12.5px;color:#4a4f47;">' + esc(p.vendorPart) + '</code>'
          : '<span class="muted">—</span>') : '') +
        td(qtyCell(p, edit)) +
        (showBag ? td(esc(p.packagingBag || '—')) : '') +
        (showColor ? td((p.paintGroup ? '<span class="chip" style="font-size:10.5px;margin-bottom:4px;display:inline-block;" title="Paint colour group">' + esc(p.paintGroup) + '</span> ' : '') + (edit ? colorCell(p) : esc(p.powderColor || '—'))) : '') +
        td(((Number(p.unitWeightLbs) || 0) * (Number(p.quantity) || 0)).toFixed(2)) +
        td(free ? freeCell : costCell(p, edit)) +
        td(free ? freeCell : money2(ext)) +
        td(free ? freeCell : invCell(p, edit)) +
        td(free ? '' : invDeltaCell(p)) +
        td(free ? '' : invPctCell(p)) +
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
      '<td colspan="' + (edit ? 6 : 5) + '" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td></tr>';

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
          '<button class="link-btn" data-proc="csvfile" data-vendor="' + esc(s.vendor) + '" style="width:auto;padding:7px 13px;">CSV</button>' +
          '<button class="link-btn" data-proc="pdf" data-vendor="' + esc(s.vendor) + '" style="width:auto;padding:7px 13px;">PDF</button>' +
          (canHandoff ? '<button class="btn" data-sec-email="' + s.id + '" title="Emails this vendor their sheet and submits the section" style="width:auto;padding:8px 14px;">Email vendor</button>' : '') +
          (canHandoff && !locked ? '<button class="link-btn" data-sec-confirm="' + s.id + '" title="Use when the sheet went out some other way" style="width:auto;padding:8px 14px;">Mark sent by hand</button>' : '') +
          (canHandoff && locked ? '<button class="link-btn" data-sec-unlock="' + s.id + '" style="width:auto;padding:8px 14px;color:#9c3327;">Unlock for revisions</button>' : '') +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 18px;">' +
        warn +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
          '<div><div class="k">Job name</div><input class="secF" data-id="' + s.id + '" data-f="jobName" value="' + esc(s.jobName || '') + '" placeholder="' + esc(s.jobNameDefault || '') + '" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
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
          // The deal carries one tax figure for the job, so it belongs on one vendor's
          // sheet. Shown against the mats vendor only — on every section it read as
          // though the order owed the tax once per vendor, and each grand total was
          // overstated by it.
          (s.showsEstimatedTax
            ? '<div><div class="k">Estimated tax</div><input class="secF" data-id="' + s.id + '" data-f="estimatedTax" value="' + esc(s.estimatedTax || '') + '" placeholder="From the deal" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>'
            : '') +
        '</div>' +
        (edit
          ? '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">' +
              '<button class="link-btn" data-deal-pull="' + s.id + '" title="' +
                (dealFiguresIn(s)
                  ? 'This vendor has its freight' + (s.showsEstimatedTax ? ' and tax' : '') + ' figure. Press again to re-read the board.'
                  : 'This vendor has no freight figure yet, so its grand total cannot be worked out. Reads the Deal Tracking board.') +
                '" style="width:auto;padding:6px 12px;font-weight:600;border:1px solid transparent;color:#fff;background:' +
                (dealFiguresIn(s) ? '#2f7d5d' : '#a2402f') + ';">Pull freight &amp; tax from the deal</button>' +
              '<span class="muted" data-deal-out style="font-size:11.5px;line-height:1.5;flex:1;min-width:220px;">Reads the Deal Tracking board and replaces the freight and tax figures with what it holds.</span>' +
            '</div>'
          : '') +
        invoiceBlock(s, canHandoff) +
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
            ['Item', 'Part #'].concat(showVendorPart ? ['Vendor part #'] : [], ['Qty'], showBag ? ['Bag #'] : [], showColor ? ['Powder color'] : [], ['Weight (lb)', 'Cost each', 'Total cost', 'Invoiced each', 'Δ $', 'Δ %', 'Notes', 'Status'], edit ? [''] : []),
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
      var v = q.value || '', st = bomFieldStyle(null, !edit), dis = edit ? '' : ' disabled';
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
    // Grouped by whose address it is. An address confirmed by THIS order's customer
    // is the one almost always wanted; a hand-typed job trailer is reusable; another
    // order's confirmed address is only here when "show every saved address" is on.
    var opt = function (a) {
      return '<option value="addr:' + a.id + '"' + (s.shipToAddressId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    };
    var list = bomShipToAddresses || [];
    var ours = list.filter(function (a) { return a.scope === 'order'; }).map(opt).join('');
    var general = list.filter(function (a) { return a.scope !== 'order' && !a.source; }).map(opt).join('');
    var others = list.filter(function (a) { return a.scope !== 'order' && a.source; }).map(opt).join('');
    return '<select class="secShipTo" data-id="' + s.id + '" style="' + bomFieldStyle(null, locked) + '"' + dis + '>' +
      '<option value="CUSTOMER"' + (!s.shipToAddressId && s.shipTo !== 'SUMMIT' ? ' selected' : '') + '>Customer site</option>' +
      '<option value="SUMMIT"' + (!s.shipToAddressId && s.shipTo === 'SUMMIT' ? ' selected' : '') + '>Summit Sensory Gym</option>' +
      (ours ? '<optgroup label="This order">' + ours + '</optgroup>' : '') +
      (general ? '<optgroup label="Saved addresses">' + general + '</optgroup>' : '') +
      (others ? '<optgroup label="Other orders — check before using">' + others + '</optgroup>' : '') +
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
    var showTax = s.showsEstimatedTax && s.estimatedTax;
    if (showTax) rows.push(['Estimated tax', tax == null ? s.estimatedTax : money2(tax), 0]);
    var grand = ship == null || (showTax && tax == null) ? null : items + ship + (showTax ? tax || 0 : 0);
    rows.push(['Bill of Materials grand total', grand == null ? 'Pending freight' : money2(grand), 1]);
    // What the vendor says they are owed, against what this sheet says. Stated as its
    // own pair of rows rather than folded into the total above: the total is what we
    // agreed, and their figure is a claim about it.
    if (s.vendorInvoiceTotalMinor != null) {
      var stated = Number(s.vendorInvoiceTotalMinor) || 0;
      var diff = stated - items;
      rows.push(['Vendor invoice total', money2(stated), 0]);
      rows.push([
        'Difference from this sheet',
        (diff > 0 ? '+' : '') + money2(diff),
        0,
        diff < 0 ? RED : diff > 0 ? '#20241f' : '#2f7d5d',
      ]);
    }

    return '<div style="display:flex;justify-content:flex-end;margin-top:12px;">' +
      '<table style="border-collapse:collapse;font-size:13px;min-width:280px;">' +
        rows.map(function (r) {
          var top = r[2] ? 'border-top:1px solid #dcded7;' : '';
          return '<tr>' +
            '<td style="padding:5px 16px 5px 0;color:' + (r[2] ? '#20241f' : '#5c6157') + ';font-weight:' + (r[2] ? '700' : '400') + ';' + top + '">' + esc(r[0]) + '</td>' +
            '<td style="padding:5px 0;text-align:right;font-weight:' + (r[2] ? '700' : '600') + ';' + top +
              (r[3] ? 'color:' + r[3] + ';' : '') + '">' + esc(r[1]) + '</td>' +
          '</tr>';
        }).join('') +
      '</table></div>';
  }

  /**
   * The vendor's invoice, beside the sheet they were sent.
   *
   * Only offered once the section has been submitted: an invoice for a sheet that has
   * not gone out is a document for something nobody ordered. The fields stay writable
   * after submission — the invoice is a fact about what happened afterwards, and
   * recording it changes nothing about the vendor's copy.
   */
  function invoiceBlock(s, canHandoff) {
    if (s.status !== 'SUBMITTED') return '';
    var inv = s.invoice || { checkedLines: 0, uncheckedLines: 0, varianceMinor: 0, variancePct: null, needsApproval: false, thresholdMinor: 0, agreedMinor: 0, invoicedMinor: 0 };
    var accepted = !!s.invoiceApprovedAt;
    var neg = inv.varianceMinor < 0;
    var chip = accepted
      ? '<span class="chip" style="background:#eaf1ec;color:#2f6b4f;">Accepted ' + fmtDate(s.invoiceApprovedAt) +
        (s.invoiceApprovedBy ? ' · ' + esc(s.invoiceApprovedBy) : '') + '</span>'
      : (inv.checkedLines
          ? '<span class="chip" style="background:#fdf6e6;color:#6b5a24;border:1px solid #ecd9a6;">Not accepted</span>'
          : '');
    var dis = canHandoff ? '' : ' disabled';
    var f = function (label, field, value, w, extra) {
      return '<div><div class="k">' + label + '</div>' +
        '<input class="secF" data-id="' + s.id + '" data-f="' + field + '" value="' + esc(value == null ? '' : value) + '" ' +
        (extra || '') + ' style="' + bomFieldStyle(w || null) + '"' + dis + '></div>';
    };
    var statedTotal = s.vendorInvoiceTotalMinor == null ? '' : (Number(s.vendorInvoiceTotalMinor) / 100).toFixed(2);

    var summary = inv.checkedLines
      ? '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;margin-top:10px;font-size:13px;">' +
          '<span class="muted">' + inv.checkedLines + ' line' + (inv.checkedLines === 1 ? '' : 's') + ' checked' +
            (inv.uncheckedLines ? ' · <span style="color:#8a6d1f;">' + inv.uncheckedLines + ' still to check</span>' : '') + '</span>' +
          (inv.notBilledLines
            ? '<span style="color:' + RED + ';font-weight:600;">' + inv.notBilledLines + ' line' + (inv.notBilledLines === 1 ? '' : 's') +
              ' not billed · ' + costMoney(inv.notBilledMinor) + '</span>'
            : '') +
          '<span>Sheet <b>' + costMoney(inv.agreedMinor) + '</b></span>' +
          '<span>Invoiced <b>' + costMoney(inv.invoicedMinor) + '</b></span>' +
          '<span>Difference <b style="color:' + (neg ? RED : (inv.varianceMinor ? '#20241f' : '#2f7d5d')) + ';">' +
            (inv.varianceMinor > 0 ? '+' : '') + costMoney(inv.varianceMinor) +
            (inv.variancePct == null ? '' : ' · ' + (inv.variancePct > 0 ? '+' : '') + inv.variancePct.toFixed(1) + '%') +
          '</b></span>' +
        '</div>'
      : '<div class="muted" style="font-size:12.5px;margin-top:10px;">Type what the vendor billed into the <b>Invoiced each</b> column on any line. Nothing is compared until you do.</div>';

    var actions = !canHandoff || !inv.checkedLines
      ? ''
      : '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">' +
          (accepted
            ? '<button class="link-btn" data-inv-reopen="' + s.id + '" style="width:auto;padding:7px 13px;color:#9c3327;">Reopen this invoice</button>'
            : '<button class="btn" data-inv-approve="' + s.id + '" style="width:auto;padding:8px 14px;">Accept the difference</button>') +
          (!accepted && inv.needsApproval
            ? '<span class="muted" style="font-size:11.5px;">Over ' + costMoney(inv.thresholdMinor) + ' — a manager has to accept this.</span>'
            : '') +
          (!accepted && inv.notBilledLines
            ? '<span style="font-size:11.5px;color:' + RED + ';line-height:1.5;">' + inv.notBilledLines + ' line' +
              (inv.notBilledLines === 1 ? ' was' : 's were') + ' not billed. Confirm ' +
              (inv.notBilledLines === 1 ? 'it' : 'they') + ' shipped before accepting — an unbilled part is usually one that never left.</span>'
            : '') +
        '</div>';

    return '<div style="margin-top:14px;padding:13px 14px;border:1px solid #e7e8e3;border-radius:12px;background:#fbfbf9;">' +
      '<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">' +
        '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;">Vendor invoice</div>' + chip +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">' +
        f('Invoice number', 'vendorInvoiceNumber', s.vendorInvoiceNumber) +
        f('Invoice date', 'vendorInvoiceDate', s.vendorInvoiceDate ? String(s.vendorInvoiceDate).slice(0, 10) : '', null, 'type="date"') +
        f('Total they billed', 'vendorInvoiceTotalMinor', statedTotal, null, 'inputmode="decimal" placeholder="0.00"') +
        f('Note', 'vendorInvoiceNotes', s.vendorInvoiceNotes) +
      '</div>' + summary + actions +
    '</div>';
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

  /** Wire every control inside the section cards. */
  function wireBom(order, user, canHandoff) {
    // Returns the promise: callers that repaint and then restore the caret have
    // to know when the new markup exists.
    var reload = function () { return loadBomSections(order, user, canHandoff); };
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
      bindLiveField(el, async function () {
        var f = el.getAttribute('data-f'), id = el.getAttribute('data-id'), body = {};
        if (f === 'submittedOn' || f === 'vendorInvoiceDate') body[f] = el.value ? new Date(el.value + 'T12:00:00').toISOString() : null;
        else if (f === 'vendorInvoiceTotalMinor') body[f] = el.value.trim() === '' ? null : d2m(el.value);
        else body[f] = el.value.trim ? el.value.trim() : el.value;
        el.style.borderColor = '#c9a227';
        var r = await authed('/bom/sections/' + id, { method: 'PATCH', body: body });
        if (!r.ok) { el.style.borderColor = '#c2452f'; return fail(r, 'Could not save'); }
        el.style.borderColor = '#3f9d78';
        // The invoice figures move the section summary, the difference and the
        // "Not accepted" chip; the dates move the vendor's status line. Those all
        // stayed stale — the border went green and nothing else on the panel
        // changed until you left the tab. Repaint from the server instead,
        // keeping the caret where it was.
        if (f === 'vendorInvoiceTotalMinor' || f === 'vendorInvoiceDate' || f === 'submittedOn') {
          await repaintKeepingFocus(reload,
            function () { return document.getElementById('bomBox'); },
            '.secF[data-id="' + id + '"][data-f="' + f + '"]');
          return;
        }
        setTimeout(function () { if (el.parentNode) el.style.borderColor = '#dcded7'; }, 900);
      });
    });

    /* One line, brought up to the catalog. The bulk dialog still covers a whole
     * order; this is the case where you are looking at one part and can see it is
     * wrong. Same endpoint, same audit trail. */
    document.querySelectorAll('.bomNotBilled').forEach(function (el) {
      el.addEventListener('click', async function () {
        var on = el.getAttribute('data-on') === '1';
        var r = await authed('/orders/procurement/' + el.getAttribute('data-id'), {
          method: 'PATCH', body: { invoiceNotBilled: !on }
        });
        if (!r.ok) return fail(r, 'Could not mark that line');
        refreshLines();
      });
    });

    document.querySelectorAll('[data-inv-approve]').forEach(function (el) {
      el.addEventListener('click', async function () {
        el.disabled = true;
        var r = await authed('/bom/sections/' + el.getAttribute('data-inv-approve') + '/invoice/approve', { method: 'POST', body: {} });
        el.disabled = false;
        if (!r.ok) return fail(r, 'Could not accept this invoice');
        reload();
      });
    });

    document.querySelectorAll('[data-inv-reopen]').forEach(function (el) {
      el.addEventListener('click', async function () {
        var why = prompt('Why is this invoice being reopened?');
        if (!why || !why.trim()) return;
        var r = await authed('/bom/sections/' + el.getAttribute('data-inv-reopen') + '/invoice/reopen', { method: 'POST', body: { reason: why.trim() } });
        if (!r.ok) return fail(r, 'Could not reopen this invoice');
        reload();
      });
    });

    document.querySelectorAll('.bomUseCat').forEach(function (el) {
      el.addEventListener('click', async function () {
        el.disabled = true;
        var rc = await authed('/orders/procurement/' + el.getAttribute('data-id'), {
          method: 'PATCH', body: { unitCostMinor: Number(el.getAttribute('data-cost')) },
        });
        el.disabled = false;
        if (!rc.ok) return fail(rc, 'Could not put the catalog cost on that line');
        // refreshLines, not reload: reload repaints from the order already in memory,
        // whose lines still carry the old cost. This re-reads the order first.
        refreshLines();
      });
    });

    document.querySelectorAll('.bomLine').forEach(function (el) {
      bindLiveField(el, async function () {
        var f = el.getAttribute('data-f'), lineId = el.getAttribute('data-id'), body = {};
        if (f === 'sourced') body[f] = el.value === 'true';
        else if (f === 'quantity') body[f] = Math.round(Number(el.value));
        else if (f === 'unitCostMinor') body[f] = d2m(el.value);
        // An emptied cell is "not checked yet", which is a different fact from zero.
        else if (f === 'invoicedUnitCostMinor') body[f] = el.value.trim() === '' ? null : d2m(el.value);
        else body[f] = el.value.trim();
        if (f === 'quantity' && !(body[f] >= 1)) { alert('Quantity must be a whole number of at least 1.'); reload(); return; }
        if (f === 'unitCostMinor' && !(body[f] >= 0)) { alert('Enter the cost as plain dollars — 145 or 145.00.'); reload(); return; }
        if (f === 'invoicedUnitCostMinor' && body[f] !== null && !(body[f] >= 0)) { alert('Enter what the vendor billed as plain dollars — 145 or 145.00.'); refreshLines(); return; }
        el.style.borderColor = '#c9a227';
        var r = await authed('/orders/procurement/' + lineId, { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) { await fail(r, 'Could not save the line'); reload(); return; }
        // A quantity change moves the section totals and the edited badge, so the
        // panel is rebuilt from the server rather than patched in place. The
        // rebuild now restores the caret, because these fields save while you are
        // still typing in them.
        if (f === 'quantity' || f === 'unitCostMinor' || f === 'invoicedUnitCostMinor') {
          await repaintKeepingFocus(refreshLines,
            function () { return document.getElementById('bomBox'); },
            '.bomLine[data-id="' + lineId + '"][data-f="' + f + '"]');
          return;
        }
        var line = (procData || []).filter(function (x) { return x.id === lineId; })[0];
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
      await reload();
    };

    // Re-applies Catalog → BOM build to an order that is already locked, so a kit or a
    // free-issue part configured today reaches an order locked last week. Idempotent.
    var allAddr = document.getElementById('bomAllAddr');
    if (allAddr) allAddr.addEventListener('change', function () {
      bomAllAddresses = allAddr.checked;
      reload();
    });

    /**
     * Refresh costs from the catalog.
     *
     * A preview first, always. Costs were copied onto this order at acceptance and
     * nothing has propagated since, which is deliberate — but when a catalog figure
     * was simply wrong, every line carrying it needs correcting, and doing that
     * silently would mean a job's margin changed with nobody able to say when or why.
     * So: the differences in words, tick what to apply, and the whole thing lands in
     * the order's history.
     */
    var costBtn = document.getElementById('bomCostRefresh');
    if (costBtn) costBtn.addEventListener('click', async function () {
      costBtn.disabled = true;
      var was = costBtn.textContent;
      costBtn.textContent = 'Comparing…';
      var pr = await authed('/orders/' + order.id + '/bom/cost-refresh');
      costBtn.disabled = false;
      costBtn.textContent = was;
      if (!pr.ok) { await fail(pr, 'Could not compare the costs'); return; }
      var pv = await pr.json();

      if (!pv.rows.length) {
        openModal('Costs match the catalog',
          '<p style="font-size:13.5px;line-height:1.6;">Every line on this order already carries the catalog cost.' +
          (pv.unmatched ? ' ' + pv.unmatched + ' line' + (pv.unmatched === 1 ? ' has' : 's have') +
            ' no catalog row to compare against — hand-added parts and generated mat numbers.' : '') +
          '</p>', null);
        return;
      }

      var chosen = {};
      pv.rows.forEach(function (row) { if (!row.blocked) chosen[row.lineId] = true; });

      function money(minor) {
        var n = (Number(minor) || 0) / 100;
        return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      function body() {
        var picked = pv.rows.filter(function (r) { return chosen[r.lineId]; });
        var net = picked.reduce(function (t, r) { return t + r.extendedDeltaMinor; }, 0);
        return '<p style="font-size:13.5px;line-height:1.6;margin:0 0 12px;">' +
            pv.rows.length + ' line' + (pv.rows.length === 1 ? '' : 's') + ' differ from the catalog. ' +
            'Cost is internal: this moves this sheet\u2019s totals and the job\u2019s margin, and reaches nothing ' +
            'the customer has signed or been sent.' +
          '</p>' +
          '<div style="max-height:46vh;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
          '<thead><tr style="background:#fbfbf9;">' +
            '<th style="padding:8px 10px;text-align:left;width:28px;"></th>' +
            '<th style="padding:8px 10px;text-align:left;">Part</th>' +
            '<th style="padding:8px 10px;text-align:right;">Now</th>' +
            '<th style="padding:8px 10px;text-align:right;">Catalog</th>' +
            '<th style="padding:8px 10px;text-align:right;">On this job</th>' +
          '</tr></thead><tbody>' +
          pv.rows.map(function (r) {
            var up = r.extendedDeltaMinor > 0;
            return '<tr style="border-top:1px solid #f2f3ef;' + (r.blocked ? 'opacity:.55;' : '') + '">' +
              '<td style="padding:7px 10px;">' +
                (r.blocked
                  ? '<span title="' + esc(r.blocked) + '" style="color:#8a8f85;">\u2014</span>'
                  : '<input type="checkbox" class="crPick" data-id="' + esc(r.lineId) + '"' +
                    (chosen[r.lineId] ? ' checked' : '') + ' style="width:15px;height:15px;">') +
              '</td>' +
              '<td style="padding:7px 10px;">' + esc(r.name) +
                '<div class="muted" style="font-size:11.5px;">' + esc(r.sku || '\u2014') + ' \u00b7 ' +
                esc(r.vendor) + ' \u00b7 qty ' + r.quantity +
                (r.freeIssue ? ' \u00b7 free issue' : '') +
                (r.blocked ? '<div style="color:#9c3327;">' + esc(r.blocked) + '</div>' : '') + '</div></td>' +
              '<td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;">' + money(r.currentMinor) + '</td>' +
              '<td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">' + money(r.catalogMinor) + '</td>' +
              '<td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;color:' +
                (up ? '#9c3327' : '#2f7d5d') + ';">' + (up ? '+' : '') + money(r.extendedDeltaMinor) + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div>' +
          '<div style="display:flex;justify-content:space-between;gap:12px;margin-top:11px;font-size:13.5px;font-weight:600;">' +
            '<span>' + picked.length + ' of ' + pv.rows.length + ' selected</span>' +
            '<span style="font-variant-numeric:tabular-nums;">Job cost moves ' + (net > 0 ? '+' : '') + money(net) + '</span>' +
          '</div>' +
          (pv.unmatched
            ? '<div class="muted" style="font-size:12px;margin-top:8px;">' + pv.unmatched + ' line' +
              (pv.unmatched === 1 ? ' has' : 's have') + ' no catalog row and are left alone \u2014 hand-added parts and generated mat numbers.</div>'
            : '') +
          (pv.blocked
            ? '<div style="font-size:12px;margin-top:6px;color:#9c3327;">' + pv.blocked + ' line' +
              (pv.blocked === 1 ? '' : 's') + ' sit on a submitted sheet. Unlock that section to reprice them.</div>'
            : '');
      }

      openModal('Refresh costs from the catalog', '<div id="crBody">' + body() + '</div>', async function (close, showErr) {
        var ids = Object.keys(chosen).filter(function (k) { return chosen[k]; });
        if (!ids.length) return showErr('Tick at least one line.');
        var rr = await authed('/orders/' + order.id + '/bom/cost-refresh', {
          method: 'POST', body: { lineIds: ids },
        });
        if (!rr.ok) {
          var msg = 'Could not reprice the lines';
          try { var j = await rr.json(); msg = j.message || j.error || msg; } catch (e2) {}
          return showErr(msg);
        }
        var res = await rr.json();
        close();
        if (res.skipped && res.skipped.length) {
          alert(res.applied + ' line(s) repriced. ' + res.skipped.length +
            ' were skipped:\n\n' + res.skipped.map(function (x) { return '\u2022 ' + x.reason; }).join('\n'));
        }
        refreshLines();
      }, 'Reprice the selected lines', { maxWidth: '760px' });

      /* Re-tick in place. The running total at the bottom has to move as lines are
       * ticked — a selection whose consequence you cannot see is not a review — so the
       * container is repainted and re-wired on every change. */
      var wirePicks = function () {
        var host = document.getElementById('crBody');
        if (!host) return;
        host.querySelectorAll('.crPick').forEach(function (cb) {
          cb.addEventListener('change', function () {
            var id = cb.getAttribute('data-id');
            if (cb.checked) chosen[id] = true; else delete chosen[id];
            host.innerHTML = body();
            wirePicks();
          });
        });
      };
      setTimeout(wirePicks, 0);
    });

    var applyBtn = document.getElementById('bomApplyBuild');
    if (applyBtn) applyBtn.addEventListener('click', async function () {
      applyBtn.disabled = true;
      var was = applyBtn.textContent;
      applyBtn.textContent = 'Applying…';
      var r = await authed('/orders/' + order.id + '/bom/apply-build', { method: 'POST' });
      applyBtn.disabled = false;
      applyBtn.textContent = was;
      if (!r.ok) return fail(r, 'Could not apply the BOM build rules');
      var d = (await r.json()) || {};
      var said = [];
      if (d.exploded && d.exploded.length)
        said.push(d.exploded.length + ' part' + (d.exploded.length === 1 ? '' : 's') + ' expanded into ' + d.componentsAdded + ' component' + (d.componentsAdded === 1 ? '' : 's'));
      if (d.redirected) said.push(d.redirected + ' free-issue line' + (d.redirected === 1 ? '' : 's') + ' moved to the receiving vendor');
      alert(said.length ? said.join('\n') + '.' : 'Nothing to change — this order already matches the rules in Catalog → BOM build.');
      refreshLines();
    });

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
      bindLiveField(el, async function () {
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

    /**
     * Pull the freight and tax figures off the deal.
     *
     * The outcome is reported beside the button rather than in an alert, and it always
     * says what the deal actually held. "Nothing populated" has four different causes
     * — the order is not linked to a deal, monday is unreachable, the deal's columns are
     * empty, or every section already has a figure — and an alert that does not
     * distinguish them leaves the rep guessing which.
     */
    document.querySelectorAll('[data-deal-pull]').forEach(function (bt) {
      var out = bt.parentNode ? bt.parentNode.querySelector('[data-deal-out]') : null;
      var say = function (html, bad) {
        if (!out) { if (bad) alert(String(html).replace(/<[^>]+>/g, '')); return; }
        out.style.color = bad ? '#9c3327' : '#5c6157';
        out.innerHTML = html;
      };
      bt.addEventListener('click', async function () {
        bt.disabled = true;
        say('Reading the deal…');
        // overwrite: the board is the authority on freight and tax. Keeping a typed
        // figure meant a re-quote never landed until someone emptied both fields by
        // hand, and a stale "TBD" blocked the pull it was waiting for.
        var r = await authed('/orders/' + order.id + '/deal-figures/pull', { method: 'POST', body: { overwrite: true } });
        bt.disabled = false;
        if (!r.ok) { say('Could not read the deal (' + r.status + ').', 1); return; }
        var d = await r.json();
        var f = d.figures || {};

        if (f.error) {
          say(esc(f.error) + (f.itemId ? ' <span class="muted">(deal ' + esc(f.itemId) + ')</span>' : ''), 1);
          return;
        }

        // What the three columns held, named individually. A figure that is blank on the
        // board is the single most common reason a pull appears to do nothing, and this
        // is the only way to see it without opening monday.
        var found = [
          'structure freight ' + (f.structureFreight ? '<b>' + esc(f.structureFreight) + '</b>' : '<i>blank</i>'),
          'mats freight ' + (f.matsFreight ? '<b>' + esc(f.matsFreight) + '</b>' : '<i>blank</i>'),
          'tax ' + (f.estimatedTax ? '<b>' + esc(f.estimatedTax) + '</b>' : '<i>blank</i>'),
        ].join(' \u00b7 ');
        var head = 'Deal ' + esc(f.itemId || '?') + ': ' + found;

        if (!d.updated) {
          var why = (!f.structureFreight && !f.matsFreight && !f.estimatedTax)
            ? 'Nothing to copy — those columns are empty on the Deal Tracking board. Fill them in there, then pull again.'
            : 'Every section already holds exactly what the deal says.';
          say(head + '<br>' + why, 1);
          return;
        }
        say(head + '<br>Filled in ' + d.updated + ' section' + (d.updated === 1 ? '' : 's') +
          (d.skipped ? ', left ' + d.skipped + ' alone' : '') + '.' +
          (f.note ? '<br><span style="color:#8a6d1f;">' + esc(f.note) + '</span>' : ''));
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

        // All three formats come from the server, off one shared model, so the
        // spreadsheet, the CSV and the PDF carry identical content.
        var kind = bt.getAttribute('data-proc');
        if (kind === 'csv' || kind === 'csvfile') {
          var ext = kind === 'csv' ? 'xlsx' : 'csv';
          bt.textContent = 'Building…';
          try {
            var rx = await authed('/render/orders/' + order.id + '/bom.' + ext + qs);
            if (rx.ok) {
              downloadBlob(await rx.blob(), bomFileSlug(vendor, order) + '.' + ext);
              bt.disabled = false; bt.textContent = label; return;
            }
          } catch (e) {}
          bt.disabled = false; bt.textContent = label;
          alert('Could not build the ' + (ext === 'xlsx' ? 'Excel' : 'CSV') + ' export.');
          return;
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

          var doc = null;
          try { var r = await authed('/orders/' + order.id + '/bom' + qs); if (r.ok) doc = await r.json(); } catch (e2) {}
          bt.disabled = false;
          if (!doc) { alert('Could not build the Bill of Materials.'); return; }
          printBom(doc, vendor);
        }
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
    var txns = [], billing = null, conn = null, drift = null;
    try {
      var rs = await authed('/integrations/quickbooks/status'); conn = rs.ok ? await rs.json() : null;
      var r = await authed('/integrations/quickbooks/transactions?proposalId=' + encodeURIComponent(order.proposalId));
      if (r.status === 403) { box.innerHTML = '<div class="placeholder" style="padding:18px;"><p class="muted" style="margin:0;">Your role cannot view QuickBooks documents.</p></div>'; return; }
      if (r.ok) txns = (await r.json()) || [];
      // Local mirror, not a live read: opening an order must not cost an Intuit
      // round trip per document. The Refresh button is the live one.
      var rb = await authed('/integrations/quickbooks/billing/' + encodeURIComponent(order.proposalId));
      if (rb.ok) billing = await rb.json();
      // Whether the frozen accepted price still describes this version's own lines.
      // Read here rather than discovered at Step 1: the push refusing is the last
      // moment anyone would want to find out, and until now it was the only one.
      var rd = await authed('/proposals/versions/' + encodeURIComponent(order.proposalVersionId) + '/price-drift');
      if (rd.ok) drift = await rd.json();
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
    // VOIDED is neither waiting nor live — it was prepared and then abandoned, and
    // leaving it in the waiting list would make a discard look like it did nothing.
    var pending = txns.filter(function (t) { return t.status !== 'CREATED' && t.status !== 'VOIDED'; });
    var live = txns.filter(function (t) { return t.status === 'CREATED'; });

    // What the order is worth NOW. A prepared document freezes its total, so freight
    // corrected afterwards leaves it holding a figure the order no longer carries —
    // and creating it would put that stale figure in front of the customer.
    var orderTotalMinor = (order && (order.grandTotalMinor != null ? order.grandTotalMinor : order.totalMinor)) || null;

    var pendingRows = pending.map(function (t) {
      var stale = orderTotalMinor != null && t.amountMinor != null && t.amountMinor !== orderTotalMinor;
      var step = '';
      if (canTransact) {
        if (t.status === 'DRAFT' || t.status === 'PENDING_AUTHORIZATION') step = '<button class="link-btn" data-qbo="authorize" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 2 · Authorize</button>';
        else if (t.status === 'AUTHORIZED') step = '<button class="btn" data-qbo="execute" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 3 · Create in QuickBooks</button>';
        else if (t.status === 'FAILED') step = '<button class="link-btn" data-qbo="retry" data-id="' + t.id + '" style="width:auto;padding:7px 13px;color:#9c3327;">Retry</button>';
      }
      // Discard is offered on anything not yet in QuickBooks. A created document is
      // voided or credited in QuickBooks itself, never quietly dropped here.
      var discard = canTransact
        ? '<button class="link-btn" data-qbo="discard" data-id="' + t.id + '" style="width:auto;padding:7px 11px;color:#9c3327;">Discard</button>'
        : '';
      return '<tr>' + td('<b style="font-weight:600;">' + esc(qboTypeLabel(t.type)) + '</b>' +
          (t.error ? '<div style="font-size:12px;color:#9c3327;">' + esc(t.error) + '</div>' : '') +
          (stale
            ? '<div style="font-size:12px;color:#8a6d1f;line-height:1.5;margin-top:2px;">Prepared at ' +
              fmtMoney(t.amountMinor, t.currency) + '; this order is now ' + fmtMoney(orderTotalMinor, t.currency) +
              '. Discard it and prepare again, or it will be created at the old figure.</div>'
            : '')) +
        td('<span class="chip"' + (stale ? ' style="background:#fdf6e6;color:#6b5a24;"' : '') + '>' + titleCase(t.status) + '</span>') +
        td(fmtMoney(t.amountMinor, t.currency)) +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;">' + (step || '<span class="muted">—</span>') + discard + '</div>') + '</tr>';
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

    /**
     * The frozen price and the version's lines disagree.
     *
     * Shown with both figures and a way out. Previously this surfaced only as a refusal
     * at Step 1, whose advice — make a new version — could not work, because a new
     * version inherited the same frozen price and drifted identically. Re-freezing is
     * the decision that the lines are right and the frozen figure is the stale one; it
     * changes no line and is recorded against the order.
     */
    var driftHtml = (drift && drift.drifted)
      ? '<div style="background:#fbf1ef;border:1px solid #e6c9c2;border-radius:9px;padding:12px 14px;margin-bottom:10px;font-size:13px;line-height:1.6;color:#7a3a2c;">' +
          '<b style="font-weight:650;">The accepted price does not match this version\u2019s lines</b>' +
          '<div style="margin-top:5px;">Frozen accepted total <b>' + fmtMoney(drift.frozenMinor, 'USD') + '</b> \u00b7 ' +
            'the version\u2019s lines come to <b>' + fmtMoney(drift.liveMinor, 'USD') + '</b> \u00b7 ' +
            'a difference of <b>' + fmtMoney(Math.abs(drift.driftMinor), 'USD') + '</b>.</div>' +
          '<div style="margin-top:5px;">Nothing can be sent to QuickBooks while the two disagree. If the lines are right, re-freeze the accepted price at ' +
            fmtMoney(drift.liveMinor, 'USD') + ' \u2014 the lines are not touched, and the change is recorded on this order.</div>' +
          '<button class="btn" id="qboRefreeze" style="width:auto;padding:8px 14px;margin-top:9px;">Re-freeze the accepted price</button>' +
        '</div>'
      : '';

    box.innerHTML = driftHtml +
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

    var rf = document.getElementById('qboRefreeze');
    if (rf) rf.addEventListener('click', async function () {
      if (!confirm('Re-freeze the accepted price at ' + fmtMoney(drift.liveMinor, 'USD') + '?\n\nThe proposal\u2019s lines are not changed. The frozen total, the deposit and the order\u2019s figures are restated to match them.')) return;
      rf.disabled = true;
      var r2 = await authed('/proposals/versions/' + encodeURIComponent(order.proposalVersionId) + '/refreeze-price', { method: 'POST', body: {} });
      rf.disabled = false;
      if (!r2.ok) {
        // fail() is a var local to loadBomSections, not a function in this scope, so
        // this line threw a ReferenceError instead of reporting anything: a failed
        // re-freeze left the panel silent, with no indication that the attempt had
        // failed at all.
        var m2 = '';
        try { m2 = ((await r2.json()) || {}).message || ''; } catch (e) {}
        alert(m2 || ('Could not re-freeze the accepted price (' + r2.status + ').'));
        return;
      }
      loadQbo(order, user);
    });

    var pb = document.getElementById('qboPrepare');
    if (pb && canTransact) pb.addEventListener('click', function () { openQboPrepare(order, user, txns); });
    var prof = document.getElementById('qboProfile');
    if (prof) prof.addEventListener('click', function () { openQboProfile(order, user); });
    // Named apart from the re-freeze button above on purpose. Both were `var rf` in
    // the same function scope, so this declaration rebound the name: the re-freeze
    // handler's rf.disabled toggled the REFRESH button instead, leaving the button it
    // was meant to guard clickable while its request was in flight.
    var rfr = document.getElementById('qboRefresh');
    if (rfr) rfr.addEventListener('click', async function () {
      rfr.disabled = true; rfr.textContent = 'Reading QuickBooks…';
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
        var body = {};
        if (act === 'discard') {
          // A reason, because a discarded document is a decision somebody made and the
          // audit trail is the only place it survives.
          var why = prompt('Why is this document being discarded?\n\nIt has not been created in QuickBooks, so nothing there changes. The order can be prepared again at its current total.');
          if (!why || !why.trim()) return;
          body = { reason: why.trim() };
        }
        bt.disabled = true; bt.textContent = 'Working…';
        var r = await authed('/integrations/quickbooks/transactions/' + bt.getAttribute('data-id') + '/' + act, { method: 'POST', body: body });
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

  /*
   * openQboSend and openQboReminder used to live here: two complete dialogs that
   * asked QuickBooks to email a document, and composed a balance reminder.
   *
   * Removed, not wired up. Biller Genie owns every customer-facing email — it picks
   * each invoice out of QuickBooks within minutes of creation and delivers it on
   * Summit letterhead with its own payment link and follow-up schedule. A send from
   * here would reach the customer twice, from two systems, with two ways to pay. The
   * server refuses both anyway (see the send and reminder routes in
   * src/routes/quickbooks.ts, which return that explanation), so all this code could
   * do was tempt someone into wiring up a button that cannot work.
   *
   * The reminder HISTORY table below stays: reminders sent before Biller Genie took
   * over are still part of the record of how a balance was chased.
   */

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
    // A discarded document is neither waiting nor created. Counted as waiting, the
    // dialog says one is already prepared and preparing "reopens" a row that no longer
    // exists — the button then appears to do nothing.
    function waitingOf(type) {
      return priorOf(type).filter(function (t) { return t.status !== 'CREATED' && t.status !== 'VOIDED'; });
    }
    function nextSeq(type) {
      return priorOf(type).reduce(function (n, t) { return Math.max(n, qboSeqOf(t)); }, 0) + 1;
    }
    /** The panel under the type picker: what already exists, and the copy opt-in. */
    function noteHtml(type) {
      var made = createdOf(type);
      var pending = waitingOf(type);
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

  /**
   * A short notice that does not stop the user.
   *
   * alert() is right for "your document did not attach". It is wrong for "this is
   * still working", which is most of what a release has to say — and an alert in
   * that role means the rep cannot see the screen the notice is about. Appended to
   * the body rather than to a panel, so it survives the repaint that follows a
   * release. Colours are the RELEASED and REJECTED status chips.
   */

  /**
   * Progress for a proposal action: the button's own label, plus a line beneath it.
   *
   * The only feedback used to be `disabled = true`. A greyed-out button and a hung
   * request look identical, which is the whole reason a release that was working
   * read as frozen — and releasing is genuinely several seconds of work, most of it
   * before the first request is even sent.
   *
   * The line is appended to the button's own container (#propActions is a wrapping
   * flex row, so flex-basis:100% puts it on its own line under the buttons).
   * stage(null) restores the original label and removes the line.
   */
  function actionProgress(bt) {
    var label = bt.textContent, line = null;
    return function (btnLabel, note) {
      if (btnLabel == null) {
        bt.textContent = label;
        if (line && line.parentNode) line.parentNode.removeChild(line);
        line = null;
        return;
      }
      bt.textContent = btnLabel;
      if (!note) return;
      if (!line) {
        line = document.createElement('div');
        line.className = 'muted';
        line.style.cssText = 'flex-basis:100%;font-size:12px;line-height:1.5;margin-top:2px;';
        if (bt.parentNode) bt.parentNode.appendChild(line);
      }
      line.textContent = note;
    };
  }

  /*
   * printTable used to live here: a browser print-to-PDF of one on-screen table.
   * Every table that wanted it now has a server-rendered PDF under /render/*, which
   * paginates properly and does not depend on the operator's pop-up settings.
   */
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

  /* --- Follow-up email templates -------------------------------------------
   * The wording used to live in code, so changing a sentence meant a deploy. It now lives
   * in the database, seeded once from the ten that shipped; this is where it is edited.
   *
   * The body is plain text on purpose: a blank line starts a paragraph, **asterisks** mark
   * the one bolded question. A rich-text or HTML field would let one unclosed tag reach a
   * customer, and nobody notices that until after it has gone. */
  /**
   * Per-user Outlook connection + email signature.
   *
   * Lives on the administration screen next to the templates because that is where
   * someone goes to think about follow-up email, but it is NOT an administrative action:
   * it connects the mailbox of whoever is signed in. There is deliberately no way for an
   * admin to connect another person's mailbox.
   */
  async function loadOutlookPanel() {
    var box = document.getElementById('olPanel'); if (!box) return;
    var d = null;
    try {
      var r = await authed('/me/outlook');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not read your Outlook status (' + r.status + ').</div>'; return; }
      d = await r.json();
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; return; }

    if (!d.configured) {
      box.innerHTML = '<div class="muted" style="padding:14px 16px;border:1px solid #e8eae4;border-radius:8px;font-size:13px;line-height:1.6;">' +
        'Outlook drafts are not switched on for this deployment yet. Until they are, a follow-up downloads as an <code>.eml</code> file that opens in Outlook. ' +
        'Setting it up needs four settings on the server: <code>GRAPH_REDIRECT_URI</code>, <code>GRAPH_TOKEN_ENC_KEY</code>, and the existing Microsoft sign-in tenant and client credentials.</div>';
      return;
    }

    var status = d.connected
      ? '<span class="chip">Connected</span> <span class="muted" style="font-size:12.5px;">' + esc(d.mailbox || '') + '</span>'
      : '<span class="muted" style="font-size:12.5px;">Not connected — follow-ups will download as a file.</span>';

    box.innerHTML =
      '<div style="border:1px solid #e8eae4;border-radius:8px;padding:14px 16px;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<div>' + status +
            (d.lastError ? '<div class="muted" style="font-size:12px;margin-top:4px;color:#9c3327;">' + esc(d.lastError) + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button class="btn" id="olConnect" style="width:auto;padding:8px 14px;">' + (d.connected ? 'Reconnect' : 'Connect Outlook') + '</button>' +
            (d.connected ? '<button class="link-btn" id="olDisconnect" style="width:auto;padding:8px 14px;color:#9c3327;">Disconnect</button>' : '') +
          '</div>' +
        '</div>' +
        '<div style="margin-top:14px;">' +
          '<div style="font-size:13px;font-weight:600;margin-bottom:4px;">Your signature</div>' +
          '<div class="muted" style="font-size:12px;margin-bottom:6px;line-height:1.55;">Copy your signature out of Outlook and paste it below, then save. It is added to the bottom of every draft this app creates.</div>' +
          '<div id="olSig" contenteditable="true" style="min-height:110px;border:1px solid #dfe2da;border-radius:6px;padding:10px 12px;background:#fff;font-size:13px;overflow:auto;"></div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;">' +
            '<button class="btn" id="olSigSave" style="width:auto;padding:8px 14px;">Save signature</button>' +
            '<button class="link-btn" id="olSigClear" style="width:auto;padding:8px 14px;">Clear</button>' +
            '<span class="muted" id="olSigMsg" style="font-size:12px;"></span>' +
          '</div>' +
        '</div>' +
      '</div>';

    var sig = document.getElementById('olSig');
    // Assigned rather than interpolated: the stored signature is HTML, and it is the
    // server's sanitized copy that should render, not a re-escaped version of it.
    if (sig) sig.innerHTML = d.signatureHtml || '';

    var cn = document.getElementById('olConnect');
    if (cn) cn.addEventListener('click', async function () {
      cn.disabled = true;
      try {
        var r = await authed('/me/outlook/connect', { method: 'POST', body: {} });
        var c = null; try { c = await r.json(); } catch (e) {}
        if (!r.ok || !c || !c.url) { alert((c && c.message) || 'Could not start the connection (' + r.status + ').'); cn.disabled = false; return; }
        // Same tab: Microsoft refuses to render its consent screen inside a frame, and a
        // popup here is routinely blocked. The callback page comes back with a link home.
        window.location.href = c.url;
      } catch (e) { alert('Could not reach the server.'); cn.disabled = false; }
    });

    var dc = document.getElementById('olDisconnect');
    if (dc) dc.addEventListener('click', async function () {
      if (!confirm('Disconnect ' + (d.mailbox || 'your mailbox') + '?\n\nFollow-ups will download as a file again until you reconnect. Drafts already created are untouched.')) return;
      var r = await authed('/me/outlook', { method: 'DELETE' });
      if (!r.ok && r.status !== 204) { alert('Could not disconnect (' + r.status + ').'); return; }
      loadOutlookPanel();
    });

    var saveSig = async function (html) {
      var note = document.getElementById('olSigMsg');
      var r = await authed('/me/outlook/signature', { method: 'PUT', body: { html: html } });
      if (!r.ok) { if (note) { note.textContent = 'Could not save (' + r.status + ').'; note.style.color = '#9c3327'; } return; }
      var out = null; try { out = await r.json(); } catch (e) {}
      if (sig && out && typeof out.signatureHtml === 'string') sig.innerHTML = out.signatureHtml;
      if (note) { note.textContent = out && out.hasSignature ? 'Saved.' : 'Cleared.'; note.style.color = ''; }
    };
    var sv = document.getElementById('olSigSave');
    if (sv) sv.addEventListener('click', function () { saveSig(sig ? sig.innerHTML : ''); });
    var cl = document.getElementById('olSigClear');
    if (cl) cl.addEventListener('click', function () { if (sig) sig.innerHTML = ''; saveSig(''); });
  }

  var futCache = null;
  async function loadFollowUpTemplates() {
    var box = document.getElementById('futList'); if (!box) return;
    try {
      var r = await authed('/admin/follow-up-templates');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load the templates (' + r.status + '). Run migration 0053 if this persists.</div>'; return; }
      futCache = await r.json();
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; return; }

    /* Render inside its own guard. The list used to build its markup in one unguarded
     * assignment, so a single bad reference anywhere in it threw before box.innerHTML was
     * ever set and the section sat on "Loading…" with the real error only in the console.
     * A screen that cannot draw itself should say so. */
    try {
      renderFollowUpTemplates(box);
    } catch (e) {
      console.error('follow-up templates: render failed', e);
      box.innerHTML = '<div class="err">The templates loaded but this list could not be drawn. ' + esc(String(e && e.message ? e.message : e)) + '</div>';
    }
  }

  function renderFollowUpTemplates(box) {

    var rows = (futCache.templates || []).map(function (t) {
      return '<tr>' +
        td('<div style="display:flex;gap:9px;align-items:baseline;">' +
            '<span style="font-family:Georgia,serif;font-size:12px;font-weight:700;color:#8a8f85;">' + (t.step < 10 ? '0' + t.step : t.step) + '</span>' +
            '<div><b style="font-weight:600;">' + esc(t.name) + '</b>' +
              (t.isBuiltIn ? '' : ' <span class="chip" style="font-size:10.5px;">Custom</span>') +
              '<div class="muted" style="font-size:12px;max-width:460px;line-height:1.45;">' + esc(t.subject) + '</div>' +
              '<div class="muted" style="font-size:11.5px;margin-top:2px;">' + esc(t.whenToSend) + '</div>' +
            '</div></div>') +
        td(t.active ? '<span class="chip">Active</span>' : '<span class="muted">Retired</span>') +
        td('<span class="muted" style="font-size:12.5px;">' + (t.sentCount ? t.sentCount + ' sent' : 'Never sent') + '</span>') +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;">' +
          '<button class="link-btn futEdit" data-id="' + t.id + '" style="width:auto;padding:6px 11px;">Edit</button>' +
          (t.isBuiltIn ? '<button class="link-btn futReset" data-id="' + t.id + '" style="width:auto;padding:6px 11px;">Reset</button>' : '') +
          '<button class="link-btn futDel" data-id="' + t.id + '" style="width:auto;padding:6px 11px;color:#9c3327;">' + (t.active ? 'Retire' : 'Delete') + '</button>' +
          '</div>') +
        '</tr>';
    }).join('');

    box.innerHTML = tableShell(['Template', 'Status', 'Use', ''], rows, 4, 'No templates yet.') +
      '<div class="muted" style="font-size:12px;margin-top:8px;line-height:1.6;">Placeholders: ' +
      (futCache.placeholders || []).map(function (p) {
        return '<code style="font-size:11.5px;">' + esc(p.token) + '</code> ' + esc(p.means);
      }).join(' &nbsp;&mdash;&nbsp; ') + '</div>';

    var find = function (id) {
      return (futCache.templates || []).filter(function (t) { return t.id === id; })[0];
    };
    box.querySelectorAll('.futEdit').forEach(function (b) {
      b.addEventListener('click', function () { openFollowUpTemplateForm(find(b.getAttribute('data-id')), futCache); });
    });
    box.querySelectorAll('.futReset').forEach(function (b) {
      b.addEventListener('click', async function () {
        var t = find(b.getAttribute('data-id'));
        if (!confirm('Put ' + t.name + ' back to the wording it shipped with?\n\nYour edits to it are lost.')) return;
        var r = await authed('/admin/follow-up-templates/' + t.id + '/reset', { method: 'POST', body: {} });
        if (!r.ok) { alert(await serverMessage(r, 'Could not reset it (' + r.status + ').')); return; }
        loadFollowUpTemplates();
      });
    });
    box.querySelectorAll('.futDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        var t = find(b.getAttribute('data-id'));
        var q = t.sentCount || t.isBuiltIn
          ? 'Retire ' + t.name + '?\n\nIt stops appearing in the picker. It is kept rather than deleted because the send history refers to it.'
          : 'Delete ' + t.name + '?';
        if (!confirm(q)) return;
        var r = await authed('/admin/follow-up-templates/' + t.id, { method: 'DELETE' });
        if (!r.ok && r.status !== 204) { alert(await serverMessage(r, 'Could not do that (' + r.status + ').')); return; }
        loadFollowUpTemplates();
      });
    });
  }

  function openFollowUpTemplateForm(t, cache) {
    var isNew = !t;
    var count = ((cache && cache.templates) || []).length;
    t = t || {
      key: '', name: '', step: count + 1, whenToSend: '', objective: '', angle: '',
      caution: '', subject: '', body: '', active: true, isBuiltIn: false, sentCount: 0,
    };
    var v = function (k) { return esc(t[k] == null ? '' : t[k]); };
    var pv = openModal(isNew ? 'New follow-up email' : 'Edit ' + t.name,
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:2;">' + fieldRow('Name', '<input id="futName" style="' + IN + '" value="' + v('name') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Step', '<input id="futStep" type="number" min="1" max="99" style="' + IN + '" value="' + (Number(t.step) || 1) + '">') + '</div>' +
      '</div>' +
      fieldRow('Key',
        '<input id="futKey" style="' + IN + 'font-family:ui-monospace,monospace;" value="' + v('key') + '"' + (t.sentCount ? ' disabled' : '') + '>' +
        '<div class="muted" style="font-size:12px;margin-top:4px;line-height:1.5;">Lower-case letters, numbers and hyphens. ' +
          (t.sentCount ? 'Fixed now that this template has been sent — the history refers to it.' : 'The send history records it, so pick it once.') + '</div>') +
      fieldRow('Subject', '<input id="futSubj" style="' + IN + '" value="' + v('subject') + '">') +
      '<div class="field"><label>Body</label>' +
        '<textarea id="futBody" rows="13" style="' + IN + 'resize:vertical;font-size:13px;line-height:1.6;">' + esc(t.body || '') + '</textarea>' +
        '<div class="muted" style="font-size:12px;margin-top:5px;line-height:1.55;">Blank line between paragraphs. Wrap the one question you want answered in <code>**double asterisks**</code> and it prints bold on its own line. The greeting and sign-off are added for you.</div></div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin:14px 0 6px;">Guidance for the rep — never sent to the customer</div>' +
      fieldRow('When to send', '<input id="futWhen" style="' + IN + '" value="' + v('whenToSend') + '">') +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;">' + fieldRow('Objective', '<input id="futObj" style="' + IN + '" value="' + v('objective') + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Angle', '<input id="futAngle" style="' + IN + '" value="' + v('angle') + '">') + '</div>' +
      '</div>' +
      fieldRow('Caution', '<input id="futCaution" placeholder="Optional warning shown in the picker" style="' + IN + '" value="' + v('caution') + '">') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:2px 0 4px;cursor:pointer;">' +
        '<input type="checkbox" id="futActive"' + (t.active !== false ? ' checked' : '') + '> Offer it in the picker</label>' +
      '<div id="futPrev" class="muted" style="font-size:12.5px;margin-top:10px;"></div>',
      async function (close, showErr) {
        var body = {
          key: pv.querySelector('#futKey').value.trim(),
          name: pv.querySelector('#futName').value.trim(),
          step: Number(pv.querySelector('#futStep').value) || 1,
          whenToSend: pv.querySelector('#futWhen').value.trim(),
          objective: pv.querySelector('#futObj').value.trim(),
          angle: pv.querySelector('#futAngle').value.trim(),
          caution: pv.querySelector('#futCaution').value.trim(),
          subject: pv.querySelector('#futSubj').value.trim(),
          body: pv.querySelector('#futBody').value,
          active: pv.querySelector('#futActive').checked,
        };
        if (!body.name) return showErr('Give it a name.');
        if (!body.subject) return showErr('Give it a subject line.');
        if (!body.body.trim()) return showErr('The body is empty.');
        if (!body.whenToSend) return showErr('Say when a rep should send it — that line is how they choose between ten of these.');
        if (!body.objective) body.objective = body.name;
        if (!body.angle) body.angle = body.name;
        if (isNew && !/^[a-z0-9][a-z0-9-]*$/.test(body.key)) {
          return showErr('The key should be lower-case letters, numbers and hyphens.');
        }
        if (t.sentCount) delete body.key;
        var r = isNew
          ? await authed('/admin/follow-up-templates', { method: 'POST', body: body })
          : await authed('/admin/follow-up-templates/' + t.id, { method: 'PATCH', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not save it (' + r.status + ').'));
        close();
        loadFollowUpTemplates();
      }, isNew ? 'Create' : 'Save', { maxWidth: '640px' });

    // Live preview, so the asterisk rule is learned by seeing it rather than by reading
    // about it.
    var prev = function () {
      var el = pv.querySelector('#futPrev');
      if (!el) return;
      var paras = String(pv.querySelector('#futBody').value || '')
        .replace(/\r\n/g, '\n').split(/\n{2,}/)
        .map(function (c) { return c.trim(); }).filter(Boolean);
      if (!paras.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="k">Preview</div>' +
        '<div style="border:1px solid #e7e8e3;border-radius:9px;padding:11px 13px;background:#fff;color:#000;font-size:12.5px;line-height:1.55;">' +
        '<div>Hi Emily,</div><div style="height:8px;"></div>' +
        paras.map(function (c) {
          var ask = /^\*\*[\s\S]+\*\*$/.test(c);
          var text = esc(ask ? c.replace(/^\*\*|\*\*$/g, '').trim() : c).replace(/\n/g, '<br>');
          return '<div style="margin-bottom:8px;">' + (ask ? '<b>' + text + '</b>' : text) + '</div>';
        }).join('') +
        '<div>Best,<br>Bryan</div></div>';
    };
    var bodyEl = pv.querySelector('#futBody');
    if (bodyEl) bodyEl.addEventListener('input', prev);
    prev();
  }

  async function loadFinancingAdmin() {
    var box = document.getElementById('finAdmin'); if (!box) return;
    var d = null;
    try { var r = await authed('/admin/financing'); if (r.ok) d = await r.json(); } catch (e) {}
    if (!d) { box.innerHTML = '<div class="err">Could not load financing settings.</div>'; return; }

    // The rate grid: bands down, terms across. Every cell is editable and the whole
    // sheet is saved in one request — a grid half-written by a dropped request would
    // quote a payment nobody published.
    var card = d.current;
    var terms = card ? card.termMonths.slice() : [];
    var money0 = function (v) { return '$' + Math.round(Number(v || 0)).toLocaleString(); };
    var bandRange = function (b) {
      var lo = money0(b.minMinor / 100);
      return b.maxMinor == null ? lo + ' and above' : lo + ' – ' + money0(b.maxMinor / 100 - 1);
    };
    var cellStyle = 'width:96px;padding:6px 7px;border:1px solid #dcded7;border-radius:7px;font-size:12.5px;text-align:right;font-family:ui-monospace,monospace;';

    var gridRows = card ? card.bands.map(function (b, bi) {
      var byTerm = {};
      b.terms.forEach(function (t) { byTerm[t.termMonths] = t.factor; });
      return '<tr>' +
        td('<div style="font-weight:600;font-size:13px;">' + esc(b.label) + '</div>' +
           '<div class="muted" style="font-size:11.5px;">' + esc(bandRange(b)) + '</div>') +
        terms.map(function (t) {
          var f = byTerm[t];
          // An empty cell is a term the lessor does not offer at this amount, which is
          // a real state on the published sheet — not a missing value to default to 0.
          return td('<input class="frCell" data-band="' + bi + '" data-term="' + t + '" value="' + (f == null ? '' : Number(f).toFixed(5)) + '" placeholder="—" style="' + cellStyle + '">');
        }).join('') +
        td('<button type="button" class="frBandDel link-btn" data-band="' + bi + '" style="width:auto;padding:5px 9px;font-size:12px;color:#a2402f;">Remove</button>') +
        '</tr>';
    }).join('') : '';

    var gridHead = ['Amount band'].concat(terms.map(function (t) { return t + ' mo'; }), ['']);

    var cardShelf = (d.cards || []).map(function (c) {
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(c.name) + '</b>' +
          (c.isCurrent ? ' <span class="chip" style="background:#eaf3ee;border:1px solid #cfe3d7;color:#2f7d5d;font-size:10.5px;">In use</span>' : '') +
          (c.source ? '<div class="muted" style="font-size:11.5px;">' + esc(c.source) + '</div>' : '')) +
        td('<span class="muted" style="font-size:12.5px;">' + esc(String(c.effectiveOn).slice(0, 10)) + '</span>') +
        td('<span class="muted" style="font-size:12.5px;">' + c.bandCount + ' band' + (c.bandCount === 1 ? '' : 's') + '</span>') +
        td('<div style="display:flex;gap:6px;justify-content:flex-end;">' +
          (c.isCurrent ? '' : '<button type="button" class="frUse link-btn" data-id="' + c.id + '" style="width:auto;padding:5px 10px;font-size:12px;">Publish</button>') +
          (c.isCurrent ? '' : '<button type="button" class="frDel link-btn" data-id="' + c.id + '" style="width:auto;padding:5px 10px;font-size:12px;color:#a2402f;">Delete</button>') +
          '</div>') +
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
      (card
        ? '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:8px;">' +
            '<div><div style="font-size:13.5px;font-weight:600;">' + esc(card.name) + '</div>' +
              '<div class="muted" style="font-size:12px;">Effective ' + esc(String(card.effectiveOn).slice(0, 10)) +
              (card.source ? ' · ' + esc(card.source) : '') + '</div></div>' +
            '<div style="display:flex;gap:8px;">' +
              '<button type="button" class="link-btn" id="frPaste" style="width:auto;padding:8px 14px;">Paste a sheet…</button>' +
              '<button type="button" class="link-btn" id="frTerm" style="width:auto;padding:8px 14px;">Add a term</button>' +
              '<button type="button" class="link-btn" id="frBand" style="width:auto;padding:8px 14px;">Add a band</button>' +
              '<button type="button" class="btn" id="frSave" style="width:auto;padding:8px 16px;">Save sheet</button>' +
            '</div>' +
          '</div>' +
          tableShell(gridHead, gridRows, gridHead.length, '') +
          '<div class="muted" style="font-size:12px;margin-top:7px;">An empty cell means the term is not offered at that amount. Bands must not overlap, and the last one may be left open-ended.</div>' +
          '<div style="display:flex;gap:8px;align-items:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid #eceee8;">' +
            '<div><div class="k">Try an amount</div><input id="frTry" placeholder="150000" style="width:150px;padding:7px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;"></div>' +
            '<button type="button" class="link-btn" id="frTryGo" style="width:auto;padding:8px 14px;">Quote it</button>' +
            '<div id="frTryOut" class="muted" style="font-size:12.5px;line-height:1.5;"></div>' +
          '</div>'
        : '<div style="padding:14px 16px;background:#fdf8ec;border:1px solid #ecdcb4;border-radius:10px;">' +
            '<div style="font-size:13.5px;font-weight:600;color:#7a5c1a;">No rate sheet published</div>' +
            '<div class="muted" style="font-size:12.5px;line-height:1.55;margin:4px 0 10px;max-width:640px;">Financing sheets are falling back to one flat factor per term, which quotes the same payment at every amount. Load ' + esc(d.builtIn.name) + ' to start, then paste future sheets.</div>' +
            '<div style="display:flex;gap:8px;">' +
              '<button type="button" class="btn" id="frSeed" style="width:auto;padding:8px 16px;">Load ' + esc(d.builtIn.name) + '</button>' +
              '<button type="button" class="link-btn" id="frPaste" style="width:auto;padding:8px 14px;">Paste a sheet…</button>' +
            '</div>' +
          '</div>') +
      (cardShelf
        ? '<div class="k" style="margin-top:20px;">Sheets on record</div>' +
          tableShell(['Sheet', 'Effective', 'Bands', ''], cardShelf, 4, '')
        : '') +
      '<div style="margin-top:18px;padding:14px 16px;background:#fbfbf9;border:1px solid #e7e8e3;border-radius:10px;">' + settingRows + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:10px;">Financing enquiries are sent to <b>' + esc(d.partnerEmail) + '</b>.</div>';

    var save = async function (el, path, body) {
      el.style.borderColor = '#c9a227';
      var r = await authed(path, { method: 'PUT', body: body });
      el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
      if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} alert(m || 'Could not save.'); }
      setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
    };
    var on = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

    // Read the grid back out of the DOM. One payload, so a band added and a factor
    // corrected in the same sitting are saved together or not at all.
    var collect = function () {
      var bands = card.bands.map(function (b) {
        return { label: b.label, minDollars: b.minMinor / 100, maxDollars: b.maxMinor == null ? null : b.maxMinor / 100, factors: {} };
      });
      var bad = null;
      document.querySelectorAll('.frCell').forEach(function (el) {
        var v = el.value.trim();
        if (!v) return;
        var n = Number(v);
        if (!isFinite(n) || n <= 0 || n >= 1) { bad = el; return; }
        bands[Number(el.getAttribute('data-band'))].factors[el.getAttribute('data-term')] = n;
      });
      if (bad) { bad.style.borderColor = '#c2452f'; bad.focus(); return null; }
      return bands;
    };

    on('frSave', async function () {
      var bands = collect();
      if (!bands) { alert('A payment factor is the payment per $1 financed, so it sits between 0 and 1.'); return; }
      var bt = document.getElementById('frSave');
      bt.disabled = true; bt.textContent = 'Saving…';
      var r = await authed('/admin/financing/rate-cards/' + card.id, {
        method: 'PUT',
        body: {
          name: card.name, source: card.source || undefined,
          effectiveOn: String(card.effectiveOn).slice(0, 10),
          notes: card.notes || undefined, active: card.active, bands: bands,
        },
      });
      bt.disabled = false; bt.textContent = 'Save sheet';
      if (!r.ok) { alert(await serverMessage(r, 'Could not save the sheet (' + r.status + ').')); return; }
      loadFinancingAdmin();
    });

    on('frSeed', async function () {
      var r = await authed('/admin/financing/rate-cards/seed', { method: 'POST', body: {} });
      if (!r.ok) { alert(await serverMessage(r, 'Could not load the sheet (' + r.status + ').')); return; }
      loadFinancingAdmin();
    });

    on('frPaste', function () { openRateSheetPaste(loadFinancingAdmin); });

    on('frBand', function () {
      openModal('Add an amount band',
        fieldRow('Label', '<input id="rbLabel" placeholder="$200,000-299,999" style="' + IN + '">') +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + fieldRow('From ($)', '<input id="rbMin" type="number" min="0" step="1" style="' + IN + '">') + '</div>' +
          '<div style="flex:1;">' + fieldRow('Up to ($)', '<input id="rbMax" type="number" min="0" step="1" placeholder="Blank = and above" style="' + IN + '">') + '</div>' +
        '</div>',
        async function (close, showErr) {
          var minD = Number(document.getElementById('rbMin').value);
          var maxRaw = document.getElementById('rbMax').value.trim();
          var maxD = maxRaw === '' ? null : Number(maxRaw);
          if (!isFinite(minD) || minD < 0) return showErr('Give the bottom of the band.');
          if (maxD != null && maxD <= minD) return showErr('The top of the band must be above the bottom.');
          var bands = collect();
          if (!bands) return showErr('Fix the highlighted factor first.');
          bands.push({
            label: document.getElementById('rbLabel').value.trim() || ('$' + minD.toLocaleString() + (maxD == null ? ' and above' : '-' + maxD.toLocaleString())),
            minDollars: minD,
            // The label's top is inclusive of cents, so the stored bound is the next dollar.
            maxDollars: maxD == null ? null : maxD + 1,
            factors: {},
          });
          var r = await authed('/admin/financing/rate-cards/' + card.id, {
            method: 'PUT',
            body: {
              name: card.name, source: card.source || undefined,
              effectiveOn: String(card.effectiveOn).slice(0, 10),
              notes: card.notes || undefined, active: card.active, bands: bands,
            },
          });
          if (!r.ok) return showErr(await serverMessage(r, 'Could not add the band (' + r.status + ').'));
          close(); loadFinancingAdmin();
        }, 'Add band');
    });

    on('frTerm', function () {
      var months = prompt('How many months? The term is added to every band, with no factor until you type one.');
      if (!months) return;
      var n = Number(months);
      if (!isFinite(n) || n < 1 || n > 120 || n % 1) { alert('Give a whole number of months.'); return; }
      if (terms.indexOf(n) !== -1) { alert('That term is already on the sheet.'); return; }
      // A term with no factor anywhere would vanish on save, so it starts on the first
      // band at that band's nearest existing factor, which the user then corrects.
      var bands = collect();
      if (!bands) { alert('Fix the highlighted factor first.'); return; }
      var seed = card.bands[0] && card.bands[0].terms[0];
      if (!seed) { alert('Add a band with at least one factor first.'); return; }
      bands[0].factors[String(n)] = seed.factor;
      authed('/admin/financing/rate-cards/' + card.id, {
        method: 'PUT',
        body: {
          name: card.name, source: card.source || undefined,
          effectiveOn: String(card.effectiveOn).slice(0, 10),
          notes: card.notes || undefined, active: card.active, bands: bands,
        },
      }).then(async function (r) {
        if (!r.ok) { alert(await serverMessage(r, 'Could not add the term (' + r.status + ').')); return; }
        loadFinancingAdmin();
      });
    });

    document.querySelectorAll('.frBandDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        var idx = Number(b.getAttribute('data-band'));
        var band = card.bands[idx];
        if (!confirm('Remove the ' + band.label + ' band?\n\nAmounts in it will fall to the nearest remaining band and be marked as an estimate.')) return;
        var bands = collect();
        if (!bands) { alert('Fix the highlighted factor first.'); return; }
        bands.splice(idx, 1);
        if (!bands.length) { alert('A sheet needs at least one band.'); return; }
        var r = await authed('/admin/financing/rate-cards/' + card.id, {
          method: 'PUT',
          body: {
            name: card.name, source: card.source || undefined,
            effectiveOn: String(card.effectiveOn).slice(0, 10),
            notes: card.notes || undefined, active: card.active, bands: bands,
          },
        });
        if (!r.ok) { alert(await serverMessage(r, 'Could not remove the band (' + r.status + ').')); return; }
        loadFinancingAdmin();
      });
    });

    document.querySelectorAll('.frUse').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Publish this sheet?\n\nNew financing documents will quote from it. Proposals that have already had a sheet sent keep the rates they were quoted.')) return;
        var r = await authed('/admin/financing/rate-cards/' + b.getAttribute('data-id') + '/activate', { method: 'POST', body: {} });
        if (!r.ok) { alert(await serverMessage(r, 'Could not publish that sheet (' + r.status + ').')); return; }
        loadFinancingAdmin();
      });
    });

    document.querySelectorAll('.frDel').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Delete this rate sheet?')) return;
        var r = await authed('/admin/financing/rate-cards/' + b.getAttribute('data-id'), { method: 'DELETE' });
        if (!r.ok && r.status !== 204) { alert(await serverMessage(r, 'Could not delete it (' + r.status + ').')); return; }
        loadFinancingAdmin();
      });
    });

    // Quote an arbitrary amount. The fastest way to confirm a freshly pasted sheet is
    // loaded the way the lessor wrote it.
    on('frTryGo', async function () {
      var out = document.getElementById('frTryOut');
      var amt = Number((document.getElementById('frTry').value || '').replace(/[^0-9.]/g, ''));
      if (!isFinite(amt) || amt <= 0) { out.textContent = 'Give an amount.'; return; }
      out.textContent = 'Quoting…';
      var r = await authed('/admin/financing/quote?amount=' + amt + (card ? '&cardId=' + card.id : ''));
      if (!r.ok) { out.textContent = await serverMessage(r, 'Could not quote that.'); return; }
      var q = await r.json();
      if (!q.terms.length) { out.textContent = 'No terms available at that amount.'; return; }
      out.innerHTML =
        '<b style="color:#20241f;">' + esc(q.basis ? q.basis.bandLabel : 'flat factors') + '</b> — ' +
        q.terms.map(function (t) { return t.termMonths + ' mo ' + money0(t.monthlyPaymentMinor / 100) + '/mo'; }).join(' · ') +
        (q.basis && q.basis.approximate ? '<div style="color:#8a6d1f;">Outside the published bands — quoted from the nearest and marked as an estimate on the sheet.</div>' : '');
    });

    document.querySelectorAll('.finSetting').forEach(function (el) {
      el.addEventListener('change', function () {
        save(el, '/admin/financing/settings/' + el.getAttribute('data-key'), { value: Number(el.value) });
      });
    });
  }

  /**
   * Paste a rate sheet out of the lessor's workbook.
   *
   * Two presses, the same shape as the vendor part number importer: the first parses
   * and shows what was read, the second writes. A rate grid is not something to load
   * blind — a column read one place left would quote every job wrong.
   */
  function openRateSheetPaste(done) {
    var pv = openModal('Paste a rate sheet',
      '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-bottom:10px;">' +
        'Copy the rate block out of Ryan Capital&rsquo;s workbook, header row included: the terms across the top, one row per amount band. ' +
        'Tabs, commas or aligned columns all work. A blank cell, a dash or <code>.0000</code> means the term is not offered at that amount.</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1.4;">' + fieldRow('Sheet name', '<input id="rsName" placeholder="Ryan Capital 2026" style="' + IN + '">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('Effective', '<input id="rsDate" type="date" style="' + IN + '">') + '</div>' +
      '</div>' +
      '<textarea id="rsText" rows="11" placeholder="COST&#9;12&#9;24&#9;36&#9;48&#9;60&#10;$5,000-9,999&#9;.09590&#9;.05016&#9;.03514&#9;.02769&#9;.02324" style="' + IN + 'resize:vertical;font-family:ui-monospace,monospace;font-size:12.5px;"></textarea>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:10px;cursor:pointer;">' +
        '<input type="checkbox" id="rsPublish"> Publish it as soon as it loads</label>' +
      '<div id="rsPreview" class="muted" style="font-size:12.5px;line-height:1.6;margin-top:10px;"></div>',
      async function (close, showErr) {
        var text = pv.querySelector('#rsText').value;
        if (!text.trim()) return showErr('Nothing pasted.');
        var pre = pv.querySelector('#rsPreview');
        var body = {
          text: text,
          name: pv.querySelector('#rsName').value.trim() || undefined,
          effectiveOn: pv.querySelector('#rsDate').value || undefined,
          activate: pv.querySelector('#rsPublish').checked,
        };

        if (!pre.getAttribute('data-checked')) {
          var rc = await authed('/admin/financing/rate-cards/import', { method: 'POST', body: body });
          if (!rc.ok) return showErr(await serverMessage(rc, 'Could not read that sheet (' + rc.status + ').'));
          var d = await rc.json();
          var money0 = function (v) { return '$' + Math.round(Number(v || 0)).toLocaleString(); };
          pre.innerHTML =
            '<b style="color:#3d4a55;">' + d.bands.length + ' band' + (d.bands.length === 1 ? '' : 's') + ', terms ' + d.termMonths.join(' / ') + '.</b>' +
            '<div style="margin-top:6px;">' + d.bands.map(function (b) {
              return money0(b.minDollars) + (b.maxDollars == null ? ' and above' : '–' + money0(b.maxDollars - 1)) +
                ': ' + d.termMonths.map(function (t) { return b.factors[t] == null ? '—' : Number(b.factors[t]).toFixed(5); }).join(' ') +
                (b.missing.length ? ' <span style="color:#8a6d1f;">(' + b.missing.join(', ') + ' mo not offered)</span>' : '');
            }).join('<br>') + '</div>' +
            (d.topBandClosed
              ? '<div style="margin-top:6px;color:#8a6d1f;">The highest band stops at a ceiling, so any project above it will be quoted from that band and marked as an estimate. If Ryan Capital apply the top row above that figure, edit the band and clear its upper bound.</div>'
              : '') +
            ((d.errors || []).length ? '<div style="margin-top:6px;color:#9c3327;">' + d.errors.map(esc).join('<br>') + '</div>' : '') +
            '<div style="margin-top:6px;">Press Load again to write this sheet.</div>';
          pre.setAttribute('data-checked', '1');
          return;
        }

        body.commit = true;
        var r = await authed('/admin/financing/rate-cards/import', { method: 'POST', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not load that sheet (' + r.status + ').'));
        close();
        if (done) done();
      }, 'Load');

    // Any edit invalidates the check, so both presses describe the same paste.
    var reset = function () {
      var p = pv.querySelector('#rsPreview');
      if (p) { p.removeAttribute('data-checked'); p.innerHTML = ''; }
    };
    ['#rsText', '#rsPublish', '#rsName', '#rsDate'].forEach(function (sel) {
      var el = pv.querySelector(sel);
      if (el) el.addEventListener(sel === '#rsText' ? 'input' : 'change', reset);
    });
  }

  /* --- Ryan Capital financing ---
   * Computed entirely from the proposal total: there is no document to create and
   * nothing to fill in. Payments come from the lessor's published rate sheet — a
   * factor per amount band and term, loaded under Administration → Financing — and a
   * sheet that has been sent keeps the rates it was quoted on. */
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
      '<div class="muted" style="font-size:12.5px;margin:-4px 0 12px;line-height:1.55;">Calculated from the ' + fmtMoney(d.proposal.grandTotalMinor) + ' project total. Nothing to fill in — the sheet is generated on demand.' +
        (q.basis
          ? ' Factors from <b>' + esc(q.basis.cardName) + '</b>, ' + esc(q.basis.bandLabel) + ' band' + (q.basis.pinned ? ', pinned when this sheet was sent' : '') + '.'
          : ' No rate sheet is published yet, so these use the flat per-term factors.') + '</div>' +
      (q.basis && q.basis.approximate
        ? '<div style="margin:-6px 0 12px;padding:8px 11px;background:#fdf8ec;border:1px solid #ecdcb4;border-radius:8px;font-size:12.5px;color:#7a5c1a;line-height:1.5;">' +
            'This total is ' + (q.basis.direction === 'above' ? 'above' : 'below') + ' every band Ryan Capital publish, so the payments come from the closest one (' + esc(q.basis.bandLabel) + ') and print as an estimate. Ask them to confirm before the customer commits.</div>'
        : '') +
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

        // /render/*, for the same reason as the RFQ send: this renders the
        // proposal and the financing sheet to PDF before it can send them.
        var r = await authed('/render/proposals/' + p.id + '/send-documents',
          { method: 'POST', body: body, timeoutMs: RENDER_TIMEOUT_MS });
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


  /* --- Admin --- */
  /* --- Admin ---
   *
   * Nine unrelated administrative jobs used to print one under another down a single
   * scroll, which made the page read as a list of everything rather than a place to
   * do one thing. They are grouped here into sub-tabs by the job somebody came to do:
   * the people, what a proposal says, what it costs, what happens to an order, and
   * Canada.
   *
   * Every section is still rendered into the DOM on open and every element id is
   * unchanged — the tabs only show and hide. That is deliberate on two counts: the
   * loaders (loadUsers, loadFormulas, the panels that mount themselves) can keep
   * running exactly once as they always have, and #crossBorderPanel exists for
   * cross-border.js to find, which is how that panel mounts itself.
   */
  var ADM_TABS = [
    { id: 'users', label: 'Users' },
    { id: 'proposals', label: 'Proposal content' },
    { id: 'email', label: 'Email' },
    { id: 'pricing', label: 'Pricing & formulas' },
    { id: 'orders', label: 'Orders & vendors' },
    { id: 'canada', label: 'Canada' },
  ];

  /** Remembered, because an administrator returning to this screen is usually
   *  returning to the same job. */
  function admTab() {
    var saved = '';
    try { saved = localStorage.getItem('ssgAdminTab') || ''; } catch (e) {}
    return ADM_TABS.some(function (t) { return t.id === saved; }) ? saved : 'users';
  }

  function drawAdmTabs() {
    var box = document.getElementById('admTabs'); if (!box) return;
    var active = admTab();
    box.innerHTML = ADM_TABS.map(function (t) {
      var on = t.id === active;
      return '<button data-admt="' + t.id + '" style="border:none;background:none;padding:10px 2px;margin-right:22px;font-size:13.5px;font-family:inherit;cursor:pointer;color:' +
        (on ? '#3d4a55' : '#8a8f85') + ';font-weight:' + (on ? '600' : '400') +
        ';border-bottom:2px solid ' + (on ? '#3d4a55' : 'transparent') + ';">' + esc(t.label) + '</button>';
    }).join('');
    box.querySelectorAll('[data-admt]').forEach(function (b) {
      b.addEventListener('click', function () {
        try { localStorage.setItem('ssgAdminTab', b.getAttribute('data-admt')); } catch (e) {}
        drawAdmTabs();
        showAdmTab();
      });
    });
  }

  function showAdmTab() {
    var active = admTab();
    document.querySelectorAll('[data-adm]').forEach(function (s) {
      s.style.display = s.getAttribute('data-adm') === active ? '' : 'none';
    });
  }

  async function renderAdmin(user) {
    var sec = function (id, inner) {
      return '<section data-adm="' + id + '">' + inner + '</section>';
    };
    var head = function (title, note, button) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;' +
          'margin-top:4px;"><div class="section-title" style="margin:0;">' + title + '</div>' +
          (button || '') + '</div>' +
        (note ? '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;max-width:820px;line-height:1.55;">' + note + '</div>' : '');
    };

    document.getElementById('view').innerHTML =
      '<div id="admTabs" style="display:flex;flex-wrap:wrap;border-bottom:1px solid #e7e8e3;margin-bottom:20px;"></div>' +

      sec('users',
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:16px;">' +
          '<div class="section-title" style="margin:0;">People with access</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button class="link-btn" id="admMailTest" style="width:auto;padding:10px 15px;">Send test email</button>' +
            '<button class="btn" id="admNew" style="width:auto;padding:10px 17px;">New user</button>' +
          '</div></div>' +
        '<div id="admList"><div class="muted" style="padding:24px;">Loading…</div></div>') +

      sec('proposals',
        head('Standard proposal notes',
          'Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically, and a note can name the parts that pull it in. Table notes print inside the line items; footer notes print below the signature lines. Also editable under Catalog → Proposal notes.',
          '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;">+ New note</button>') +
        '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div class="section-title" style="margin-top:26px;">Proposal introductions</div>' +
        '<div class="muted" style="font-size:12.5px;margin:0 0 10px;max-width:820px;line-height:1.55;">The pages that print ahead of the itemized proposal, one product line at a time. The photographs are set here and used by every proposal that prints that introduction &mdash; a rep picks the template on the proposal, never the pictures. Each slot names the size it prints at; anything larger is downscaled on upload. Page wording ships with the application.</div>' +
        '<div id="introAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div class="section-title" style="margin-top:26px;">Contract documents</div>' +
        '<div class="muted" style="font-size:12.5px;margin:0 0 10px;max-width:820px;line-height:1.55;">The general release and the standard terms, printed after the acceptance page. Editing them here changes what future proposals print; a proposal already released keeps the wording it went out with. Saving a draft is not publishing it.</div>' +
        '<div id="legalAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div class="section-title" style="margin-top:26px;">Reference documents</div>' +
        '<div class="muted" style="font-size:12.5px;margin:0 0 10px;max-width:820px;line-height:1.55;">Pre-made PDFs — a W9, a certificate of insurance — a rep can attach to an individual proposal from the builder, the same way contract documents are attached. Uploaded once here; unlike the contract documents, these print exactly as uploaded rather than being retyped.</div>' +
        '<div id="referenceDocsAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>') +

      sec('email',
        '<div class="section-title" style="margin:4px 0 0;">Outlook drafts</div>' +
        '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;max-width:820px;line-height:1.55;">Connect your own mailbox and a follow-up opens as a draft in Outlook instead of downloading a file. Each person connects their own — consent is per mailbox, so nobody can connect on your behalf and this app can never read anyone else&rsquo;s mail. Your signature is pasted here because Outlook keeps signatures in the app on your machine, where nothing on the server can reach them.</div>' +
        '<div id="olPanel"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:26px;"><div class="section-title" style="margin:0;">Follow-up emails</div>' +
          '<button class="btn" id="futNew" style="width:auto;padding:9px 15px;">+ New template</button></div>' +
        '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;max-width:820px;line-height:1.55;">The emails a rep can pick from on a proposal. The order matters — financing is not raised until the email before it has established that budget is the obstacle — so the step number decides the sequence. Editing here changes what everyone sends, immediately.</div>' +
        '<div id="futList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:22px;padding-top:14px;border-top:1px solid #eef0ea;line-height:1.55;max-width:820px;">Payment-request emails and the letters they carry are edited with the invoices they belong to, under <b style="font-weight:600;">Accounts Receivable → Letters &amp; email</b>.</div>') +

      sec('pricing',
        '<div class="section-title" style="margin:4px 0 0;">Formulas</div>' +
        '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;max-width:820px;line-height:1.55;">Every calculation the pricing engine runs. Frame and hardware quantities are editable coefficients; business numbers are the scalars the proposal math uses; the last tab lists what is fixed in code and why.</div>' +
        '<div id="fxTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;"></div>' +
        // The log sits beside the formulas, not behind a tab: the question it answers
        // is "what does this rule say now versus what it said before", and that needs
        // both on screen at once.
        '<div style="display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start;">' +
          '<div id="fxBody"><div class="muted" style="padding:16px;">Loading…</div></div>' +
          '<aside id="fxLog" style="position:sticky;top:16px;"></aside>' +
        '</div>' +
        '<div class="section-title" style="margin-top:26px;">Financing</div>' +
        '<div class="muted" style="font-size:12.5px;margin:0 0 10px;max-width:820px;line-height:1.55;">Ryan Capital quote a <b>payment factor</b> per amount band and term, not an interest rate: the monthly payment is the amount financed × the factor at that intersection. Paste their sheet or edit a cell; the published sheet is what every new financing document quotes from.</div>' +
        '<div id="finAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>') +

      sec('orders',
        head('Vendor questions',
          'Questions asked on a Bill of Materials section. A question with no vendor is asked of <b>every</b> vendor; one with a vendor is asked only of theirs. Each new section starts with a copy, so editing a question here never rewrites an answer already given on an order.',
          '<button class="btn" id="qtNew" style="width:auto;padding:9px 15px;">+ New question</button>') +
        '<div id="qtList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
        '<div class="section-title" style="margin-top:26px;">Freight alert banner</div>' +
        '<div class="muted" style="font-size:12.5px;margin:0 0 10px;max-width:820px;line-height:1.55;">The bar that appears above every screen when an invoice is short of freight. It is the most-seen thing in the application, so its colours are yours to set: pick a preset or two exact colours per state. The preview is live.</div>' +
        '<div id="ftuBannerAdmin"><div class="muted" style="padding:16px;">Loading…</div></div>') +

      // cross-border.js appends #crossBorderPanel to #view when it cannot find it.
      // Giving it a home inside this tab is what keeps it from landing at the foot of
      // whichever tab happens to be open.
      sec('canada',
        '<div id="crossBorderPanel"></div>');

    drawAdmTabs();
    showAdmTab();

    if (window.FreightTrueUp) window.FreightTrueUp.mountAdmin('ftuBannerAdmin', user);
    if (window.SSGIntroAdmin) window.SSGIntroAdmin.mountAdmin('introAdmin');
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
    document.getElementById('qtNew').addEventListener('click', function () { openQuestionTemplateForm(null); });
    document.getElementById('futNew').addEventListener('click', function () { openFollowUpTemplateForm(null, futCache); });
    loadUsers();
    // The panel wires its own + New note button and loads its own list.
    window.SSGStandardNotes.mount();
    // Admin-only, and the route enforces it. A non-admin sees the empty container rather
    // than an error, which is the same thing the other admin panels do.
    if (window.SSGLegalAdmin) window.SSGLegalAdmin.render(document.getElementById('legalAdmin'));
    if (window.SSGReferenceDocuments)
      window.SSGReferenceDocuments.render(document.getElementById('referenceDocsAdmin'));
    loadFormulas();
    loadFollowUpTemplates();
    loadOutlookPanel();
    loadFinancingAdmin();
    loadQuestionTemplates();
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
        window.SSGVendorParts.open(m, currentUser);
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

    /*
     * What to do with the signature when Save is pressed.
     *
     * null  — leave whatever is on file alone. The starting state, so editing a
     *         phone number cannot wipe a signature the form never showed.
     * ''    — remove it.
     * a data URI — replace it.
     */
    var sigPending = null;

    openModal('Edit ' + (u.name || u.email),
      fieldRow('Name', '<input id="eName" style="' + IN + '" value="' + esc(u.name || '') + '">') +
      fieldRow('Email', '<input id="eEmail" type="email" style="' + IN + '" value="' + esc(u.email || '') + '" required>') +
      '<div class="muted" style="font-size:12px;margin:-6px 0 14px;">' +
        (isMe ? 'This is the address you sign in with. Changing it takes effect immediately — you stay signed in here.'
              : 'This is the address they sign in with. Tell them before you change it.') + '</div>' +
      fieldRow('Title', '<input id="eTitle" style="' + IN + '" value="' + esc(u.title || '') + '" placeholder="e.g. Sales Director">') +
      fieldRow('Phone', '<input id="ePhone" style="' + IN + '" value="' + esc(u.phone || '') + '" placeholder="720-457-5500">') +
      formSection('Address') +
      fieldRow('Street', '<input id="eAddr1" style="' + IN + '" value="' + esc(u.addressLine1 || '') + '" placeholder="6150 S Geneva Court">') +
      fieldRow('Suite, unit', '<input id="eAddr2" style="' + IN + '" value="' + esc(u.addressLine2 || '') + '" placeholder="Optional">') +
      '<div style="display:flex;gap:10px;">' +
        '<div style="flex:2;">' + fieldRow('City', '<input id="eCity" style="' + IN + '" value="' + esc(u.city || '') + '" placeholder="Englewood">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('State', '<input id="eRegion" style="' + IN + '" value="' + esc(u.region || '') + '" placeholder="CO">') + '</div>' +
        '<div style="flex:1;">' + fieldRow('ZIP', '<input id="ePostal" style="' + IN + '" value="' + esc(u.postalCode || '') + '" placeholder="80111">') + '</div>' +
      '</div>' +
      fieldRow('Country', '<input id="eCountry" style="' + IN + '" value="' + esc(u.country || '') + '" placeholder="Leave blank for United States">') +
      formSection('Electronic signature') +
      '<div class="muted" style="font-size:12px;margin:-6px 0 10px;line-height:1.55;">' +
        'A PNG or JPEG of their handwritten signature, under about 300 KB. It prints above the sender block on every letter this app generates for them. ' +
        'Left empty, the letter prints the signature space blank rather than somebody else&rsquo;s name.</div>' +
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">' +
        '<div id="eSigPreview" style="width:210px;height:70px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;">' +
          '<span class="muted" style="font-size:12px;">' + (u.hasSignature ? 'Loading&hellip;' : 'Nothing on file') + '</span></div>' +
        '<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-start;">' +
          '<input type="file" id="eSigFile" accept="image/png,image/jpeg" style="font-size:12.5px;max-width:230px;">' +
          '<button type="button" id="eSigClear" class="link-btn" style="width:auto;padding:5px 11px;font-size:12.5px;color:#a2402f;">Remove the signature</button>' +
        '</div>' +
      '</div>',
      async function (close, showErr) {
        var email = document.getElementById('eEmail').value.trim();
        if (!/.+@.+\..+/.test(email)) return showErr('Enter a valid email.');
        var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
        var body = {
          email: email,
          name: val('eName'),
          title: val('eTitle'),
          phone: val('ePhone'),
          addressLine1: val('eAddr1'),
          addressLine2: val('eAddr2'),
          city: val('eCity'),
          region: val('eRegion'),
          postalCode: val('ePostal'),
          country: val('eCountry'),
        };
        // Only sent when it changed. Absent leaves what is on file alone, which is
        // what saving a name edit should do; '' removes it.
        if (sigPending !== null) body.signatureImage = sigPending;
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
      }, 'Save', { maxWidth: '560px' });

    /* ---- signature: preview, pick, remove ---- */

    var preview = document.getElementById('eSigPreview');
    var showImage = function (dataUri) {
      if (!preview) return;
      preview.innerHTML = dataUri
        ? '<img alt="Signature" src="' + dataUri + '" style="max-width:100%;max-height:100%;object-fit:contain;">'
        : '<span class="muted" style="font-size:12px;">Nothing on file</span>';
    };

    // Fetched rather than carried on the user list: the image is tens of kilobytes
    // and the list would otherwise haul every signature nobody on that screen looks at.
    if (u.hasSignature) {
      authed('/admin/users/' + u.id + '/signature')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { showImage(d && d.signatureImage); })
        .catch(function () { showImage(null); });
    }

    var file = document.getElementById('eSigFile');
    if (file) {
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        if (f.type !== 'image/png' && f.type !== 'image/jpeg') {
          alert('Use a PNG or a JPEG.');
          file.value = '';
          return;
        }
        // Checked here as well as on the server. The base64 encoding adds about a
        // third, so 300 KB of file is roughly the 400 KB the column accepts —
        // catching it before the upload saves a confusing round trip.
        if (f.size > 300 * 1024) {
          alert('That image is ' + Math.round(f.size / 1024) + ' KB. Use one under 300 KB.');
          file.value = '';
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          sigPending = String(reader.result || '');
          showImage(sigPending);
        };
        reader.onerror = function () { alert('Could not read that file.'); };
        reader.readAsDataURL(f);
      });
    }

    var clear = document.getElementById('eSigClear');
    if (clear) {
      clear.addEventListener('click', function () {
        sigPending = '';
        if (file) file.value = '';
        showImage(null);
      });
    }
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

  /**
   * Shrink a picked image to something a letter can use.
   *
   * A phone photo or a flatbed scan of a signature is several megabytes, and it
   * prints at 90px wide. 600px is generous for that at any sensible print density and
   * lands comfortably under the 400 KB the API accepts, so nobody has to know what a
   * data URI is to get their signature onto a letter.
   *
   * PNG out, always: a signature scanned as JPEG carries grey compression fringing
   * around the strokes that is obvious against white paper.
   */
  function signatureDataUri(file, maxWidth) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('That file could not be read.')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('That file is not an image.')); };
        img.onload = function () {
          var scale = Math.min(1, (maxWidth || 600) / (img.width || 1));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  function openProfileForm(user) {
    // undefined leaves the stored signature alone; '' removes it; a string sets it.
    // Tracked rather than read off the form so that saving a phone number never
    // rewrites a signature that took somebody three attempts to scan.
    var sigNext;

    openModal('My profile',
      fieldRow('Full name', '<input id="upName" style="' + IN + '" value="' + esc(user.name || '') + '" required>') +
      fieldRow('Title', '<input id="upTitle" style="' + IN + '" placeholder="e.g. Director of Sales" value="' + esc(user.title || '') + '">') +
      fieldRow('Phone', '<input id="upPhone" style="' + IN + '" placeholder="e.g. (720) 457-5500" value="' + esc(user.phone || '') + '">') +
      fieldRow('Email', '<input style="' + IN + 'background:#f2f3ef;" value="' + esc(user.email || '') + '" disabled>') +
      fieldRow('Signature',
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<div id="upSigBox" style="width:150px;height:56px;border:1px solid #dfe3ec;border-radius:7px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;">' +
            '<span id="upSigEmpty" style="font-size:11.5px;color:#8a8f85;">None saved</span>' +
            '<img id="upSigImg" alt="" style="display:none;max-width:138px;max-height:46px;">' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<button type="button" id="upSigPick" style="font:inherit;font-size:12.5px;padding:7px 12px;border-radius:7px;border:1px solid #dfe3ec;background:#fff;cursor:pointer;">Choose image…</button>' +
            '<button type="button" id="upSigClear" style="font:inherit;font-size:12.5px;padding:7px 12px;border-radius:7px;border:1px solid #dfe3ec;background:#fff;color:#8d2f20;cursor:pointer;display:none;">Remove</button>' +
          '</div>' +
          '<input type="file" id="upSigFile" accept="image/png,image/jpeg" style="display:none;">' +
        '</div>' +
        '<div id="upSigNote" class="muted" style="font-size:11.5px;margin-top:6px;line-height:1.5;">Signed in black ink on white paper, scanned or photographed. It prints above your name on every payment letter you generate.</div>') +
      '<div class="muted" style="font-size:12px;margin-top:2px;">These details appear in the “Proposal Prepared By” block on every proposal you generate.</div>',
      async function (close, showErr) {
        var name = document.getElementById('upName').value.trim();
        if (name.length < 2) return showErr('Enter your full name.');
        var body = { name: name, title: document.getElementById('upTitle').value.trim(), phone: document.getElementById('upPhone').value.trim() };
        if (sigNext !== undefined) body.signatureImage = sigNext;
        var r = await authed('/auth/me', { method: 'PATCH', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not save your profile (' + r.status + ').'));
        var updated = await r.json();
        user.name = updated.name; user.title = updated.title; user.phone = updated.phone; user.hasSignature = updated.hasSignature;
        if (currentUser) { currentUser.name = updated.name; currentUser.title = updated.title; currentUser.phone = updated.phone; currentUser.hasSignature = updated.hasSignature; }
        close(); renderShell(user);
      }, 'Save profile');

    var box = document.getElementById('upSigImg');
    var empty = document.getElementById('upSigEmpty');
    var clear = document.getElementById('upSigClear');
    var file = document.getElementById('upSigFile');
    var note = document.getElementById('upSigNote');

    function show(dataUri) {
      if (dataUri) {
        box.src = dataUri; box.style.display = 'block';
        empty.style.display = 'none'; clear.style.display = 'inline-block';
      } else {
        box.removeAttribute('src'); box.style.display = 'none';
        empty.style.display = 'block'; clear.style.display = 'none';
      }
    }

    // Fetched separately from /auth/me: the image is a few hundred KB and that
    // response is read on every page load.
    if (user.hasSignature) {
      authed('/auth/me/signature').then(async function (r) {
        if (!r.ok) return;
        var d = await r.json();
        if (sigNext === undefined && d.signatureImage) show(d.signatureImage);
      });
    }

    document.getElementById('upSigPick').addEventListener('click', function () { file.click(); });
    clear.addEventListener('click', function () {
      sigNext = '';
      show(null);
      note.textContent = 'Your signature will be removed when you save.';
    });
    file.addEventListener('change', async function () {
      var picked = file.files && file.files[0];
      if (!picked) return;
      try {
        var uri = await signatureDataUri(picked, 600);
        sigNext = uri;
        show(uri);
        note.textContent = 'Looks right? It prints at about this size above your name.';
      } catch (e) {
        note.textContent = 'That file could not be read as an image. Try a PNG or JPEG.';
      }
      file.value = '';
    });
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
        'In the ' + esc(envLabel.toLowerCase()) + ' environment nothing touches your real books.</p></div>' +
      '<div id="portalDeliveryPanel"></div>';

    // Portal delivery submissions. The panel lives in public/portal-delivery.js —
    // this file only says where it goes and hands it the authed() wrapper. Guarded so
    // a failed load leaves the QuickBooks screen exactly as it was.
    if (window.SSGPortalDelivery) {
      window.SSGPortalDelivery.mount(document.getElementById('portalDeliveryPanel'), { authed: authed });
    }

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

  /**
   * What build am I looking at?
   *
   * Two dates are available and they answer different questions: the commit date is when
   * the code was written and pushed, the build date is when Vercel deployed it. The
   * commit date is the one shown, because "is my fix live?" is a question about the push
   * — the build time only differs from it when a deploy was retried or promoted later.
   * Both are in the tooltip so the difference is visible when it matters.
   *
   * Fails silently. A shell that will not render because it could not label itself would
   * be a poor trade.
   */
  async function showBuildStamp() {
    var el = document.getElementById('buildStamp');
    if (!el) return;
    try {
      // Cache-busted: this file's whole job is to be current, and a cached copy of it
      // reporting the previous deploy is worse than no label at all.
      var r = await api('/build-info?t=' + Date.now(), { noAuth: true });
      if (!r.ok) return;
      var b = await r.json();
      if (!b || !b.shortCommit) {
        el.textContent = 'local build';
        return;
      }
      var stamp = b.committedAt || b.builtAt;
      var when = '';
      if (stamp) {
        var dt = new Date(stamp);
        when = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      }
      el.innerHTML = 'build ' + esc(b.shortCommit) + (when ? '<br>' + esc(when) : '') +
        (b.environment && b.environment !== 'production' ? '<br>' + esc(b.environment) : '');
      var tip = [
        b.message ? b.message : null,
        b.branch ? 'branch ' + b.branch : null,
        b.author ? 'by ' + b.author : null,
        b.committedAt ? 'pushed ' + new Date(b.committedAt).toLocaleString() : null,
        b.builtAt ? 'deployed ' + new Date(b.builtAt).toLocaleString() : null,
      ].filter(Boolean).join('\n');
      if (tip) el.setAttribute('title', tip);
    } catch (e) {}
  }

  async function logout() {
    var rt = tokens().rt;
    try { if (rt) await api('/auth/logout', { method: 'POST', noAuth: true, body: { refreshToken: rt } }); } catch (e) {}
    clearTokens(); renderLogin();
  }

  async function boot() {
    // Hand the shared rules to the document renderer before any screen can ask for a
    // document. Cheap, and it throws here rather than mid-render if the file is stale.
    wireProposalDocument();
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

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
  // Notes accept lightweight formatting: **bold**, *italic*, and real line breaks.
  function rt(s) {
    var out = esc(s == null ? '' : s)
      .replace(/\*\*([^*]+)\*\*/g, '<b style="font-weight:700;color:#20241f;">$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
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
          '<span class="muted" style="font-size:11px;margin-left:4px;">Select text, then click B or I</span>' +
        '</div>' +
        '<div id="' + id + '" contenteditable="true" style="min-height:120px;padding:10px 12px;font-size:14px;line-height:1.55;outline:none;">' + mdToEditHtml(value) + '</div>' +
      '</div>' +
      (hint ? '<div class="muted" style="font-size:11.5px;margin-top:3px;">' + hint + '</div>' : '') + '</div>';
  }
  /** Wire the toolbar + keyboard shortcuts + plain-text paste for a rich-text field. */
  function wireRichText(id) {
    var el = document.getElementById(id); if (!el) return;
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
  function fmtDate(s) { if (!s) return '—'; var d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  function fmtMoney(minor, cur) { if (minor == null) return '—'; var n = Number(minor) / 100; return (cur ? cur + ' ' : '$') + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
  var ORDERS_MANAGE_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'OPERATIONS', 'PROJECT_MANAGER'];
  var HANDOFF_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'OPERATIONS', 'PROJECT_MANAGER'];
  // quickbooks:transact — who may authorize and create live financial documents.
  var QBO_TXN_ROLES = ['SYSTEM_ADMIN', 'ACCOUNTING'];
  var QBO_VIEW_ROLES = ['SYSTEM_ADMIN', 'EXECUTIVE', 'ACCOUNTING'];
  function hasRole(list, role) { return list.indexOf(role) !== -1; }
  function navFor(role) { return NAV.filter(function (n) { return n.roles === '*' || n.roles.indexOf(role) !== -1; }); }
  function roleLabel(role) { return titleCase(role); }

  // Business numbers (deposit %, proposal validity, leg spans) come from
  // Administration → Formulas → Business numbers; these are the fallbacks.
  var fxSettings = { depositPct: 50, proposalValidityDays: 7, legsSmallMaxFt: 10, legsSmallCount: 4, legsMediumMaxFt: 20, legsMediumCount: 6, legsLargeCount: 8 };
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

  function renderShell(user) {
    currentUser = user;
    loadFxSettings();
    var items = navFor(user.role);
    var initials = (user.name || user.email || '?').slice(0, 1).toUpperCase();
    root.innerHTML =
      '<div class="shell">' +
        '<aside class="side">' + brandHtml() +
          '<nav class="nav" id="nav">' +
            items.map(function (n) {
              return '<button class="nav-item' + (n.id === 'dashboard' ? ' active' : '') + (n.ready ? '' : ' soon') + '" data-view="' + n.id + '">' +
                '<span>' + esc(n.label) + '</span>' + (n.ready ? '' : '<span class="nav-tag">soon</span>') + '</button>';
            }).join('') +
          '</nav>' +
          '<div class="side-foot"><div class="user-row"><div class="avatar">' + esc(initials) + '</div>' +
            '<div class="user-meta"><b>' + esc(user.name || user.email) + '</b><span>' + esc(roleLabel(user.role)) + '</span></div></div>' +
            '<button class="link-btn" id="profBtn" style="margin-bottom:6px;">My profile</button>' +
            '<button class="link-btn" id="pwdBtn" style="margin-bottom:6px;">Change password</button>' +
            '<button class="link-btn" id="logoutBtn">Sign out</button>' +
            '<div style="text-align:center;font-size:10px;color:#b3b7ac;margin-top:8px;letter-spacing:.04em;">build 40 · auto freight · SKU repair</div></div>' +
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
    var kpis = document.getElementById('dashKpis'); if (!kpis) return;
    if (!data) { kpis.innerHTML = '<div class="card"><div class="k">Proposals</div><div class="v small">Unavailable</div><div class="muted" style="font-size:12.5px;margin-top:4px;">Could not load reporting data.</div></div>'; return; }
    var s = data.summary;
    var released = (data.pipeline.filter(function (p) { return p.status === 'RELEASED'; })[0] || { count: 0, value: 0 });
    var review = (data.pipeline.filter(function (p) { return p.status === 'INTERNAL_REVIEW'; })[0] || { count: 0, value: 0 });
    var stale = data.rows.filter(function (r) { return r.status === 'DRAFT' && r.daysOpen >= 14; });
    var attn = data.expiredOpen.length + data.expiringSoon.length + review.count + stale.length;
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
    var box = document.getElementById('dashAttention');
    var html = attnGroup('Past expiration', data.expiredOpen, '#9c3327', 're-date or mark inactive') +
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
  function openModal(title, bodyHtml, onSubmit, submitLabel) {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.34);display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;z-index:50;overflow:auto;';
    ov.innerHTML = '<form id="mForm" style="width:100%;max-width:460px;background:#fbfbf9;border:1px solid #e7e8e3;border-radius:16px;box-shadow:0 24px 60px -20px rgba(32,36,31,.4);padding:24px 24px 22px;">' +
      '<h2 style="font-size:20px;margin-bottom:16px;">' + esc(title) + '</h2>' +
      '<div id="mErr"></div>' + bodyHtml +
      '<div style="display:flex;gap:10px;margin-top:20px;"><button type="button" id="mCancel" class="link-btn" style="width:auto;padding:11px 18px;">Cancel</button>' +
      '<button type="submit" class="btn" id="mSave" style="flex:1;">' + (submitLabel || 'Create') + '</button></div></form>';
    document.body.appendChild(ov);
    function close() { document.body.removeChild(ov); }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.getElementById('mCancel').addEventListener('click', close);
    document.getElementById('mForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      var save = document.getElementById('mSave'); save.disabled = true; save.textContent = 'Saving…';
      try { await onSubmit(close, function (msg) { document.getElementById('mErr').innerHTML = '<div class="err">' + esc(msg) + '</div>'; save.disabled = false; save.textContent = submitLabel || 'Create'; }); }
      catch (err) { document.getElementById('mErr').innerHTML = '<div class="err">Something went wrong.</div>'; save.disabled = false; save.textContent = submitLabel || 'Create'; }
    });
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
        '<div class="muted" style="font-size:12.5px;max-width:640px;line-height:1.5;">Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically; the rest are picked from <b style="font-weight:600;">+ Standard note…</b> in the builder. Table notes print inside the line items; footer notes print below the signature lines.</div>' +
        '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;white-space:nowrap;">+ New note</button></div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>';
    document.getElementById('snNew').addEventListener('click', function () { openStandardNoteForm(null); });
    document.getElementById('qtNew').addEventListener('click', function () { openQuestionTemplateForm(null); });
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
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;"><button class="link-btn" id="catCats" style="width:auto;padding:10px 14px;">Categories &amp; tiers</button><button class="link-btn" id="catOrder" style="width:auto;padding:10px 14px;">Reorder list</button><button class="link-btn" id="catSortAudit" style="width:auto;padding:10px 14px;">Sort order</button><button class="link-btn" id="catExport" style="width:auto;padding:10px 14px;">Export tree</button><button class="link-btn" id="catImport" style="width:auto;padding:10px 14px;">Import tree</button><button class="btn" id="catNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
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
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="skuImport" style="width:auto;padding:10px 15px;">Import Excel / CSV</button><button class="btn" id="skuNew" style="width:auto;padding:10px 17px;">New SKU</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">These prices &amp; weights feed the Adventure Series engine and the proposal builder. Edit a price or weight inline and it saves automatically. <b>Override OK</b> lets a rep substitute that part number in the Adventure Series builder — leave it off and the part is fixed.</div>' +
      '<div id="skuList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('skuSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { skuState.q = s.value.trim(); skuState.page = 1; loadSkus(user); }, 300); });
    if (admin) {
      document.getElementById('skuNew').addEventListener('click', function () { openSkuForm(user); });
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
    { key: 'status', label: 'Status', w: 170, type: 'enum' },
    { key: '', label: '', w: 96 },
  ];

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
        td(esc(titleCase(p.kind))) + td('<span style="font-size:13px;">' + esc(p.categoryName || '—') + '</span>' + (p.categoryPath && p.categoryPath !== p.categoryName ? '<div class="muted" style="font-size:11.5px;line-height:1.4;">' + esc(p.categoryPath) + '</div>' : '')) + td(statusCell) +
        td(admin ? '<button class="prodEdit" data-pid="' + p.id + '" style="border:1px solid #dcded7;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;color:#3d4a55;cursor:pointer;">Edit</button>' : '') + '</tr>';
    }).join('');

    box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
      '<table style="width:100%;min-width:1040px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
      '<colgroup>' + PT_COLS.map(function (c) { return '<col' + (c.w ? ' style="width:' + c.w + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
      '<thead><tr>' + colHead(PT_COLS, cat, 'background:#f7f8f4;') + '</tr>' +
      '<tr>' + PT_COLS.map(function (c) { return filterCell('colFilter', c, all, cat.filters); }).join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="6">' + (all.length ? 'No products match these filters.' : 'No products yet.') + '</td></tr>') + '</tbody></table></div>' +
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
    Array.prototype.forEach.call(box.querySelectorAll('.prodEdit'), function (b) {
      b.addEventListener('click', function () {
        var p = (cat.rows || []).filter(function (x) { return x.id === b.getAttribute('data-pid'); })[0];
        if (p) openProductEditForm(p, user);
      });
    });
  }

  /** Edit a product-tree record in place: name, kind, category, descriptions, dimensions. */
  function openProductEditForm(p, user) {
    var catOpts = catOptionsTree(p.categoryId);
    var num = function (v) { return v == null || v === '' ? '' : String(v); };
    /** Where this product sits, and what else is filed in the same category. */
    function tierPanel(categoryId) {
      var c = catById(categoryId);
      var path = catPath(categoryId);
      var siblings = (cat.rows || []).filter(function (x) { return x.categoryId === categoryId && x.id !== p.id; });
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
        '<div style="margin-top:8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;">Also in this category (' + siblings.length + ')</div>' +
        (siblings.length
          ? '<div style="max-height:132px;overflow:auto;margin-top:4px;">' + siblings.slice(0, 40).map(function (x) {
            return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0;">' +
              '<span style="color:#20241f;">' + esc(x.name) + '</span>' +
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
  }

  function openManufacturerForm(m, user) {
    m = m || {};
    var v = function (k) { return esc(m[k] == null ? '' : m[k]); };
    var two = function (a, b) { return '<div style="display:flex;gap:8px;"><div style="flex:1;">' + a + '</div><div style="flex:1;">' + b + '</div></div>'; };
    openModal(m.id ? 'Edit ' + m.name : 'New manufacturer',
      fieldRow('Manufacturer name', '<input id="mfName" style="' + IN + '" value="' + v('name') + '" required>') +
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
      '<div class="field" style="margin-top:10px;"><label>Notes</label><textarea id="mfNotes" rows="2" style="' + IN + 'resize:vertical;">' + esc(m.notes || '') + '</textarea></div>' +
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
    var list = (cat.rows || []).slice().sort(function (a, b) {
      return ((a.sortOrder || 0) - (b.sortOrder || 0)) || a.name.localeCompare(b.name);
    });
    function rowHtml(p, i) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #f2f3ef;">' +
        '<span class="muted" style="width:34px;font-size:11.5px;">' + (i + 1) + '</span>' +
        '<div style="flex:1;font-size:13px;">' + esc(p.name) + ' <code style="font-size:11.5px;color:#7a7f75;">' + esc(p.sku) + '</code></div>' +
        '<span class="muted" style="font-size:11.5px;">' + esc(p.categoryName || '') + '</span>' +
        '<button type="button" class="prUp" data-i="' + i + '" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▲</button>' +
        '<button type="button" class="prDown" data-i="' + i + '" style="border:1px solid #dcded7;background:#fff;border-radius:5px;cursor:pointer;font-size:10px;padding:3px 6px;">▼</button>' +
      '</div>';
    }
    openModal('Reorder the default product list',
      '<div class="muted" style="font-size:12.5px;margin-bottom:10px;line-height:1.55;">This is the order products are offered in — the proposal builder’s picker and the tier listings both follow it.</div>' +
      '<div id="prList" style="border:1px solid #e7e8e3;border-radius:10px;max-height:420px;overflow:auto;">' + list.map(rowHtml).join('') + '</div>',
      async function (close, showErr) {
        var r = await authed('/catalog/products/reorder', { method: 'POST', body: { ids: list.map(function (p) { return p.id; }) } });
        if (!r.ok) return showErr('Could not save the order (' + r.status + ').');
        close(); loadProducts(user);
      }, 'Save order');
    function repaint() {
      var host = document.getElementById('prList'); if (!host) return;
      host.innerHTML = list.map(rowHtml).join('');
      host.querySelectorAll('.prUp').forEach(function (b) { b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i > 0) { var t = list[i - 1]; list[i - 1] = list[i]; list[i] = t; repaint(); } }); });
      host.querySelectorAll('.prDown').forEach(function (b) { b.addEventListener('click', function () { var i = Number(b.getAttribute('data-i')); if (i < list.length - 1) { var t = list[i + 1]; list[i + 1] = list[i]; list[i] = t; repaint(); } }); });
    }
    setTimeout(repaint, 50);
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

  async function exportProductTree() {
    var r = await authed('/catalog/tree/export');
    if (!r.ok) { alert('Could not export the tree (' + r.status + ').'); return; }
    var data = await r.json();
    downloadText('product-tree-' + new Date().toISOString().slice(0, 10) + '.xls', treeWorkbookXml(data), 'application/vnd.ms-excel');
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
    { id: 'active', label: 'Active' },
    { id: 'expired', label: 'Past expiration' },
    { id: 'inactive', label: 'Inactive' },
    { id: 'won', label: 'Accepted' },
    { id: 'lost', label: 'Rejected' },
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
      var count = f.id === 'all' ? props.rows.length : props.rows.filter(function (r) { return matchFilter(r, f.id); }).length;
      return '<button data-f="' + f.id + '" style="border:1px solid ' + (on ? '#3d4a55' : '#dcded7') + ';background:' + (on ? '#3d4a55' : '#fff') + ';color:' + (on ? '#fff' : '#3d4a55') + ';border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer;">' + esc(f.label) +
        (props.rows.length ? ' <span style="opacity:.65;">' + count + '</span>' : '') + '</button>';
    }).join('');
    box.querySelectorAll('[data-f]').forEach(function (b) {
      b.addEventListener('click', function () { props.filter = b.getAttribute('data-f'); propsPersist(); drawPropFilters(user); drawProposals(user); });
    });
  }
  function matchFilter(r, f) {
    if (f === 'all') return true;
    if (f === 'active') return OPEN_STATUSES.indexOf(r.status) !== -1 && !r.expired;
    if (f === 'expired') return r.expired;
    if (f === 'inactive') return r.status === 'EXPIRED';
    if (f === 'won') return r.status === 'ACCEPTED';
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
        };
      });
      drawPropFilters(user);
      drawProposals(user);
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  var PROP_COLS = [
    { key: 'customer', label: 'Customer' },
    { key: 'title', label: 'Proposal' },
    { key: 'version', label: 'Ver', align: 'center' },
    { key: 'status', label: 'Status' },
    { key: 'created', label: 'Created' },
    { key: 'modified', label: 'Last modified' },
    { key: 'expires', label: 'Expires' },
    { key: '', label: '' },
  ];
  function ptd(v, align, extra) { return '<td style="padding:12px 14px;border-bottom:1px solid #f2f3ef;white-space:nowrap;text-align:' + (align || 'left') + ';' + (extra || '') + '">' + v + '</td>'; }
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
      var acts = quickActions(r, user);
      var quick = acts.length
        ? '<select class="pQuick" data-id="' + r.id + '" data-vid="' + r.vid + '" style="padding:6px 8px;border:1px solid #dcded7;border-radius:8px;font-size:12px;background:#fff;color:#3d4a55;max-width:170px;">' +
          '<option value="">Quick status…</option>' + acts.map(function (a) { return '<option value="' + a[0] + '">' + esc(a[1]) + '</option>'; }).join('') + '</select>'
        : '';
      return '<tr style="cursor:pointer;" data-id="' + r.id + '">' +
        ptd('<b style="font-weight:600;">' + esc(r.customer) + '</b>' + (r.contact ? '<div class="muted" style="font-size:12px;">' + esc(r.contact) + '</div>' : '')) +
        ptd('<b style="font-weight:600;">' + esc(r.title) + '</b><div class="muted" style="font-size:12px;">' + esc(r.number) + (r.preparedBy ? ' · ' + esc(r.preparedBy) : '') + '</div>') +
        ptd('v' + r.version + (r.versionCount > 1 ? '<div class="muted" style="font-size:11px;">of ' + r.versionCount + '</div>' : ''), 'center') +
        ptd(statusChip(r.status)) + ptd(fmtDate(r.created)) + ptd(fmtDate(r.modified)) + ptd(expCell) +
        ptd(quick, 'right', 'padding:8px 14px;') + '</tr>';
    }
    var body = rows.map(rowHtml).join('');
    // Grouped view: one collapsible header per customer, carrying the count and the
    // open value — the two numbers you actually want when scanning an account.
    if (props.grouped && rows.length) {
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
            '<td colspan="8" style="padding:11px 14px;border-bottom:1px solid #e7e8e3;">' +
              '<span style="display:inline-block;width:14px;color:#8a8f85;">' + (isOpen ? '▾' : '▸') + '</span>' +
              '<b style="font-weight:650;font-size:13.5px;">' + esc(cust) + '</b>' +
              '<span class="muted" style="font-size:12.5px;margin-left:10px;">' + mine.length + ' proposal' + (mine.length === 1 ? '' : 's') +
                (open ? ' · ' + open + ' open' : '') + '</span>' +
              (flagged ? '<span style="margin-left:10px;font-size:12px;color:#9c3327;">⚑ ' + flagged + ' expired</span>' : '') +
            '</td></tr>' +
          (isOpen ? mine.map(rowHtml).join('') : '');
      }).join('');
    }

    box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;"><table style="width:100%;min-width:1160px;border-collapse:collapse;font-size:14px;"><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td style="padding:22px 16px;color:#909689;" colspan="8">' + (props.rows.length ? 'No proposals match this view.' : 'No proposals yet.') + '</td></tr>') + '</tbody></table></div>' +
      (props.rows.filter(function (r) { return r.expired; }).length ? '<div style="margin-top:10px;font-size:12.5px;color:#9c3327;">⚑ Flagged rows are past their expiration date and still open — re-date them or mark them no longer active.</div>' : '');
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
        var rr = await authed(path, { method: 'POST', body: {} });
        if (!rr.ok) { alert('Could not update (' + rr.status + ').'); sel.disabled = false; sel.value = ''; return; }
        loadProposals(user);
      });
    });
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
    return '<span style="display:inline-block;background:' + c[0] + ';border:1px solid ' + c[1] + ';color:' + c[2] + ';border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;white-space:nowrap;">' + esc(titleCase(s === 'EXPIRED' ? 'NO_LONGER_ACTIVE' : s)) + '</span>';
  }
  /** Status changes reachable straight from the list, permission-gated. */
  function quickActions(r, user) {
    var a = [], w = hasRole(PROP_WRITE, user.role), rev = hasRole(PROP_REVIEW, user.role), rel = hasRole(PROP_RELEASE, user.role);
    if (r.status === 'DRAFT') {
      if (w) a.push(['submit-review', 'Submit for review']);
      if (rel) a.push(['release', 'Release']);
      if (w) a.push(['expire', 'Mark no longer active']);
    } else if (r.status === 'INTERNAL_REVIEW') {
      if (rev) a.push(['return-draft', 'Return to draft']);
      if (rel) a.push(['release', 'Release']);
      if (w) a.push(['expire', 'Mark no longer active']);
    } else if (r.status === 'RELEASED') {
      if (rev) { a.push(['accept', 'Mark accepted']); a.push(['reject', 'Mark rejected']); a.push(['expire', 'Mark no longer active']); }
    } else if (w) {
      a.push(['new-version', 'Create new version']);
    }
    return a;
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
    var actions = proposalActions(latest, user, lockedOrder);
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;"><button class="link-btn" id="propBack" style="width:auto;padding:7px 13px;">‹ Back to proposals</button></div>' +
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;"><div><div class="k">' + esc(p.number || '') + '</div><h2 style="font-size:22px;margin-top:2px;">' + esc(p.title) + '</h2></div><span class="chip">' + titleCase(latest.status || 'DRAFT') + '</span></div></div>' +
      sectionBlock('Versions', tableShell(['Version', 'Status', 'Created', 'Frozen', ''], versions.map(function (v) {
        // A frozen version is the record of what went out — it opens read-only.
        var editable = !v.frozen && v.status === 'DRAFT' && hasRole(PROP_WRITE, user.role);
        var action = editable
          ? '<button class="btn" data-open="edit" data-vid="' + v.id + '" style="width:auto;padding:8px 15px;">Build / edit proposal</button>'
          : '<button class="link-btn" data-open="view" data-vid="' + v.id + '" style="width:auto;padding:8px 15px;">View (read only)</button>';
        return '<tr>' + td('v' + v.version) + td('<span class="chip">' + titleCase(v.status) + '</span>') + td(fmtDate(v.createdAt)) + td(v.frozen ? 'Yes' : 'No') + td('<div style="display:flex;justify-content:flex-end;">' + action + '</div>') + '</tr>';
      }).join(''), 5, '')) +
      (hasRole(PROP_WRITE, user.role)
        ? sectionBlock('Send to the customer',
          '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
            '<button class="btn" id="propSendDocs" style="width:auto;padding:10px 17px;">Send documents…</button>' +
            '<div class="muted" style="font-size:12.5px;max-width:520px;line-height:1.55;">Choose the proposal, the financing options, or both. Every send is recorded with the recipient and the date.</div>' +
          '</div>')
        : '') +
      sectionBlock('Financing options', '<div id="finBox"><div class="muted" style="padding:16px;">Loading…</div></div>') +
      (actions ? sectionBlock('Actions', '<div style="display:flex;gap:8px;flex-wrap:wrap;" id="propActions">' + actions + '</div>') : '');
    document.getElementById('propBack').addEventListener('click', function () { renderProposals(user); });
    var psd = document.getElementById('propSendDocs');
    if (psd) psd.addEventListener('click', function () { openSendDocuments(p, finCache, 'customer'); });
    loadFinancing(p, user);
    document.querySelectorAll('[data-open]').forEach(function (bt) {
      bt.addEventListener('click', function () {
        var v = versions.filter(function (x) { return x.id === bt.getAttribute('data-vid'); })[0];
        if (!v) return;
        if (bt.getAttribute('data-open') === 'edit') openBuilder(p, v, user); else previewProposal(p, v);
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
        var rr = await authed(path, { method: 'POST', body: {} });
        if (!rr.ok) { alert('Action failed (' + rr.status + ').'); bt.disabled = false; return; }
        openProposalDetail(id, user);
      });
    });
  }
  function proposalActions(v, user, lockedOrder) {
    var s = v.status || 'DRAFT', b = [];
    function btn(act, label, primary) { return '<button class="' + (primary ? 'btn' : 'link-btn') + '" data-act="' + act + '" data-vid="' + v.id + '" style="width:auto;padding:9px 15px;">' + label + '</button>'; }
    if (s === 'DRAFT') { if (hasRole(PROP_WRITE, user.role)) b.push(btn('submit-review', 'Submit for review')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Release', 1)); }
    else if (s === 'INTERNAL_REVIEW') { if (hasRole(PROP_REVIEW, user.role)) b.push(btn('return-draft', 'Return to draft')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Release', 1)); }
    else if (s === 'RELEASED') { if (hasRole(PROP_REVIEW, user.role)) { b.push(btn('accept', 'Mark accepted', 1)); b.push(btn('reject', 'Reject')); b.push(btn('expire', 'Expire')); } }
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
    return { from: from.toISOString().slice(0, 10), to: '' };
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
    a.download = 'proposal-report-' + new Date().toISOString().slice(0, 10) + '.csv';
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
      // Engineering warning for the person building the proposal. Kept separate
      // from `description` precisely so it can never be printed.
      internalNote: note,
      // Kit breakdown (H-1000 → its fasteners). Opaque to the builder; it exists so
      // the BOM can list the hardware out without re-running the configurator.
      components: it.components || null,
      showNotes: false,
    };
  }

  var pb = null; // active builder document

  function addDays(iso, n) { if (!iso) return ''; var d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return ''; d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
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
    var lines = (version.items || []).map(function (it) {
      return normalizeLine(it);
    });
    var propDate = meta.proposalDate || new Date().toISOString().slice(0, 10);
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
      stdNotes.filter(function (nn) { return nn.autoInclude && nn.placement !== 'FOOTER'; }).forEach(function (nn) {
        lines.push(normalizeLine({ lineType: 'NOTE', kind: 'NOTE', name: nn.title, description: nn.body, quantity: 0, rateMinor: 0 }));
      });
    }
    var footerNotes = Array.isArray(meta.footerNotes) ? meta.footerNotes : null;
    if (!footerNotes) {
      footerNotes = stdNotes.filter(function (nn) { return nn.autoInclude && nn.placement === 'FOOTER'; })
        .map(function (nn) { return { title: nn.title, body: nn.body }; });
    }
    pb = {
      proposalId: proposal.id, versionId: version.id, user: user, orgName: orgName, stdNotes: stdNotes,
      title: proposal.title || '', number: proposal.number || '', version: version.version || 1,
      meta: { contactName: meta.contactName || orgContact || '', shipTo: meta.shipTo || orgShipTo || '', billTo: meta.billTo || '', billSameAsShip: !meta.billTo || meta.billTo === (meta.shipTo || orgShipTo || ''), showTitle: meta.showTitle !== false, projectId: meta.projectId || importedProjectId || '', showProjectId: meta.showProjectId !== false, showDeposit: meta.showDeposit !== false, tbdTax: meta.tbdTax || '', tbdStructureFreight: meta.tbdStructureFreight || '', tbdMatsFreight: meta.tbdMatsFreight || '', proposalDate: propDate, taxAmountMinor: meta.taxAmountMinor || 0, discountPct: meta.discountPct || 0, structureFreightMinor: meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0), matsFreightMinor: meta.matsFreightMinor || 0, expiration: meta.expiration || addDays(propDate, 7), footerNotes: footerNotes },
      lines: lines,
    };
    // A new proposal starts with the billing address the same as the shipping one.
    if (pb.meta.billSameAsShip && !pb.meta.billTo) pb.meta.billTo = pb.meta.shipTo || '';
    // Awaited: the zero-price warning is computed from these, and rendering first
    // would show a clean builder for a moment on a proposal that has stale figures.
    loadItemDefaults().then(renderBuilder);
    renderBuilder();
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
    return line;
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
  function freightControlsHtml() {
    var sent = !!pb.meta.freightRequestedAt;
    var busy = pb.meta.freightBusy || '';
    var quote = pb.meta.freightQuoteMinor;
    var amtLabel = quote != null ? fmtMoney(quote, 'USD') : (pb.meta.freightPending ? 'Awaiting the desk' : 'Not pulled yet');
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
        '<span style="display:block;font-size:14px;font-weight:600;color:' + (quote != null ? '#20241f' : '#8a8f85') + ';">' +
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
    var discountPct = Number(pb.meta.discountPct) || 0;
    var discount = Math.round(subtotal * discountPct / 100);
    var tax = Number(pb.meta.taxAmountMinor) || 0;
    var structureFreight = Number(pb.meta.structureFreightMinor) || 0;
    var matsFreight = Number(pb.meta.matsFreightMinor) || 0;
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight;
    var deposit = depositOf(total);
    var revenue = subtotal - discount + tpFreight;
    groups.forEach(function (g) { g.margin = g.subtotal - g.cogs; g.marginPct = g.subtotal ? Math.round((g.margin / g.subtotal) * 1000) / 10 : 0; });
    return { subtotal: subtotal, discountPct: discountPct, discount: discount, tpFreight: tpFreight, tax: tax, structureFreight: structureFreight, matsFreight: matsFreight, total: total, deposit: deposit, groups: groups, weight: weight,
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
  function markBuilderDirty() { pbDirty = true; }
  function clearBuilderDirty() { pbDirty = false; }
  window.addEventListener('beforeunload', function (e) {
    if (!pbDirty) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  function renderBuilderKeepingFocus() {
    var el = document.activeElement;
    var mark = el && el.classList && el.classList.contains('bF')
      ? { i: el.getAttribute('data-i'), k: el.getAttribute('data-k'), start: el.selectionStart, end: el.selectionEnd }
      : null;
    renderBuilder();
    if (!mark) return;
    var next = document.querySelector('.bF[data-i="' + mark.i + '"][data-k="' + mark.k + '"]');
    if (!next) return;
    next.focus();
    // A number input has no selection range to restore; guarding avoids a throw.
    try { if (mark.start != null) next.setSelectionRange(mark.start, mark.end); } catch (e) {}
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
          '<button class="link-btn" id="bLoadTpl" style="width:auto;padding:9px 14px;">Load template</button>' +
          '<button class="link-btn" id="bSaveTpl" style="width:auto;padding:9px 14px;">Save as template</button>' +
          '<button class="link-btn" id="bPreview" style="width:auto;padding:9px 14px;">Preview</button>' +
          '<button class="btn" id="bSave" style="width:auto;padding:9px 18px;">Save proposal</button>' +
        '</div></div>' +
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
          '<button class="btn" id="bAddProd" style="width:auto;padding:9px 15px;">+ Product line</button>' +
          '<button class="link-btn" id="bAddGroup" style="width:auto;padding:9px 15px;">+ Group section</button>' +
          '<button class="link-btn" id="bAddSub" style="width:auto;padding:9px 15px;">+ Sub-heading</button>' +
          '<select id="bAddNote" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13.5px;background:#fff;"><option value="">+ Standard note…</option>' + (pb.stdNotes || []).map(function (nn, ni) { return '<option value="' + ni + '">' + esc(nn.title) + (nn.placement === 'FOOTER' ? ' — footer' : '') + '</option>'; }).join('') + '<option value="__custom">Custom note…</option></select>' +
        '</div>' +
        '<div style="font-size:12px;color:#8a8f85;margin-bottom:6px;">Optional product groups (click to add a section heading):</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + STD_GROUPS.map(function (g) { return '<button class="grpChip" data-g="' + esc(g) + '" style="border:1px solid #dcded7;background:#fff;border-radius:999px;padding:6px 12px;font-size:12.5px;cursor:pointer;color:#3d4a55;">' + esc(g) + '</button>'; }).join('') + '</div>' +
      '</div>' +
      // lines
      '<div class="section-title">Line items <span class="muted" style="font-weight:400;font-size:12px;">— drag rows to reorder</span></div>' +
      '<div id="bLines" style="display:flex;flex-direction:column;gap:8px;">' + (lineRows || '<div class="placeholder" style="padding:26px;"><p class="muted" style="margin:0;">No lines yet. Add a product line or load a template.</p></div>') + '</div>' +
      // totals
      '<div class="card" style="margin-top:16px;max-width:390px;margin-left:auto;">' +
        '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;"><span class="muted">Subtotal</span><span>' + fmtMoney(t.subtotal, 'USD') + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:14px;"><span class="muted">Discount %</span><input id="mDisc" style="width:80px;padding:5px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;" value="' + esc(pb.meta.discountPct) + '"></div>' +
        (t.discount ? '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:14px;color:#9c3327;"><span>Discount (' + t.discountPct + '%)</span><span>− ' + fmtMoney(t.discount, 'USD') + '</span></div>' +
          '<div style="font-size:11px;color:#8a8f85;text-align:right;margin-bottom:2px;">Discount expires ' + (pb.meta.expiration ? fmtDate(pb.meta.expiration) : 'with the proposal') + '</div>' : '') +
        optionalAmountRow('Tax $', 'mTax', pb.meta.taxAmountMinor, 'mTaxTbd', pb.meta.tbdTax) +
        optionalAmountRow('Structure Crating &amp; Freight $', 'mStructFreight', pb.meta.structureFreightMinor, 'mStructFreightTbd', pb.meta.tbdStructureFreight) +
        optionalAmountRow('Mats &amp; Padding Freight $', 'mMatsFreight', pb.meta.matsFreightMinor, 'mMatsFreightTbd', pb.meta.tbdMatsFreight) +
        '<div style="font-size:11px;color:#8a8f85;text-align:right;margin:-2px 0 2px;">Left box prints in place of TBD when the amount is 0</div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0 0;margin-top:6px;border-top:1px solid #e7e8e3;font-size:16px;font-weight:600;font-family:\'Newsreader\',serif;"><span>Total</span><span>' + fmtMoney(t.total, 'USD') + '</span></div>' +
        (pb.meta.showDeposit !== false ? '<div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:14px;color:#3d4a55;font-weight:600;"><span>Deposit due (' + depositPct() + '%)</span><span>' + fmtMoney(t.deposit, 'USD') + '</span></div>' : '<div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:12.5px;color:#8a8f85;"><span>Deposit</span><span>Not shown on the proposal</span></div>') +
        // Read-only: the sum of quantity × per-unit weight across product lines. Drives
        // crating and freight, so it is worth seeing before those numbers are entered.
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 0;margin-top:6px;border-top:1px solid #e7e8e3;font-size:14px;">' +
          '<span class="muted">Total weight</span>' +
          '<span style="font-variant-numeric:tabular-nums;">' + fmtWeight(t.weight) + '</span>' +
        '</div>' +
      '</div>' +
      footerNotesCard() +
      '<div id="bMarginRail" style="' + marginRailStyle() + '">' + marginCard(t) + '</div>';
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

  function builderLineRow(l, i, gsub) {
    var handle = '<div class="bDrag" style="cursor:grab;color:#c2c6bd;font-size:18px;padding:0 4px;user-select:none;" title="Drag to reorder">⋮⋮</div>';
    var del = '<button class="bDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:30px;height:30px;color:#9c3327;cursor:pointer;flex:0 0 auto;">✕</button>';
    if (l.lineType === 'GROUP') {
      var g = (gsub && gsub[i]) || { rev: 0, cogs: 0 };
      var gMargin = g.rev - g.cogs;
      var gPct = g.rev ? Math.round((gMargin / g.rev) * 1000) / 10 : 0;
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="background:#3d4a55;border:1px solid #33404a;border-radius:10px;padding:9px 10px;color:#fff;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' + handle.replace('#c2c6bd', '#8fa0ac') +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="SECTION HEADING" style="flex:1;border:none;background:transparent;font-weight:700;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:#fff;outline:none;">' +
        '<input class="bF" data-i="' + i + '" data-k="description" value="' + esc(l.description || '') + '" placeholder="Heading note (e.g. Frame Dimensions: 10\' × 10\')" style="flex:0 1 250px;border:none;background:rgba(255,255,255,.1);border-radius:7px;padding:5px 8px;font-size:11.5px;color:#e6ebef;outline:none;">' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#cdd6dc;white-space:nowrap;cursor:pointer;"><input type="checkbox" class="bChk" data-i="' + i + '" data-k="optional"' + (l.optional ? ' checked' : '') + '> Optional</label>' +
        '<span style="font-size:12.5px;font-weight:600;color:#cdd6dc;min-width:90px;text-align:right;">' + fmtMoney(g.rev, 'USD') + '</span>' + del.replace('#9c3327', '#f0b8ae').replace('background:#fff', 'background:rgba(255,255,255,.12)').replace('border:1px solid #e0e1db', 'border:1px solid rgba(255,255,255,.25)') +
        '</div>' +
        '<div style="display:flex;gap:16px;justify-content:flex-end;font-size:11px;color:#a9bac6;padding:6px 40px 0 0;">' +
          '<span>Revenue <b style="color:#fff;font-weight:600;">' + fmtMoney(g.rev, '') + '</b></span>' +
          '<span>COGS <b style="color:#fff;font-weight:600;">' + fmtMoney(g.cogs, '') + '</b></span>' +
          '<span>Margin <b style="color:' + (gMargin >= 0 ? '#9fe0c4' : '#f0b8ae') + ';font-weight:600;">' + fmtMoney(gMargin, '') + ' · ' + gPct + '%</b></span>' +
        '</div></div>';
    }
    if (l.lineType === 'SUBGROUP') {
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;background:#eef0ea;border:1px solid #e2e5dd;border-radius:9px;padding:7px 10px;margin-left:14px;">' + handle +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Sub-heading" style="flex:1;border:none;background:transparent;font-weight:600;font-size:13px;color:#3d4a55;outline:none;">' + del + '</div>';
    }
    if (l.lineType === 'NOTE') {
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid #ece9db;border-radius:10px;padding:10px;">' + handle +
        '<div style="flex:1;"><input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Note title" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        '<textarea class="bF" data-i="' + i + '" data-k="description" rows="3" placeholder="Note text" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(l.description) + '</textarea>' +
        '<div style="font-size:10.5px;color:#8a8f85;margin-top:3px;">Formatting: <b>**bold**</b> · <i>*italic*</i> · line breaks are kept</div></div>' + del + '</div>';
    }
    // PRODUCT
    var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
    var hasNotes = l.delivery || l.returnable || l.addlFreight || l.freightCalc || l.tpFreightMinor;
    var notesPanel = l.showNotes ?
      '<div style="margin-top:10px;padding:10px;background:#f7f8f4;border:1px solid #eef0ea;border-radius:9px;">' +
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
          '<button class="bToggleNotes" data-i="' + i + '" style="margin-top:6px;border:none;background:transparent;color:#3d4a55;font-size:11.5px;cursor:pointer;padding:0;font-weight:500;">' + (l.showNotes ? '− Hide delivery / freight notes' : (hasNotes ? '● Delivery / freight notes' : '+ Delivery / freight notes')) + '</button>' +
          notesPanel +
          // Flagged on the line itself, not only in the banner — the banner tells you
          // how many, this tells you which.
          (l.kind === 'INCLUDED' && l.sku && !(Number(l.rateMinor) || 0)
            ? '<div style="margin-top:6px;font-size:11.5px;color:#8a5a12;">No rate on this line' +
                (itemDefaults[l.sku] && itemDefaults[l.sku].priceMinor
                  ? ' — the catalog has $' + (itemDefaults[l.sku].priceMinor / 100).toFixed(2) + '. Use “Pull from catalog” above.'
                  : ' — and no price in the catalog for ' + esc(l.sku) + '.') + '</div>'
            : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:5px;width:74px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Qty</label><input class="bF" data-i="' + i + '" data-k="quantity" value="' + esc(l.quantity) + '" style="width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;"></div>' +
        '<div style="display:flex;flex-direction:column;gap:5px;width:104px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;">Rate</label><input class="bF" data-i="' + i + '" data-k="rate" value="' + m2d(l.rateMinor) + '" style="width:100%;padding:6px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;"></div>' +
        '<div style="display:flex;flex-direction:column;gap:5px;width:96px;flex:0 0 auto;"><label style="font-size:10px;color:#8a8f85;text-transform:uppercase;" title="Internal only — never printed">Cost</label><input class="bF" data-i="' + i + '" data-k="cost" value="' + m2d(l.costEach) + '" style="width:100%;padding:6px 8px;border:1px solid #e4dfd0;background:#fdfcf7;border-radius:7px;text-align:right;"></div>' +
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
    document.getElementById('bBack').addEventListener('click', function () { openProposalDetail(pb.proposalId, pb.user); });
    document.getElementById('bSave').addEventListener('click', saveBuilder);
    document.getElementById('bPreview').addEventListener('click', function () { previewProposalDoc(builderDoc()); });
    document.getElementById('bSaveTpl').addEventListener('click', saveAsTemplate);
    document.getElementById('bLoadTpl').addEventListener('click', loadTemplate);
    document.getElementById('bAddProd').addEventListener('click', openProductPicker);
    document.getElementById('bAdvSeries').addEventListener('click', openAdventureConfigurator);
    document.getElementById('bSoarSeries').addEventListener('click', openSoarConfigurator);
    document.getElementById('bFlexSeries').addEventListener('click', function () { openLinePicker('Summit Flex'); });
    document.getElementById('bAddGroup').addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: '', description: '', quantity: 0, rateMinor: 0, group: '', optional: false }); renderBuilder(); });
    document.getElementById('bAddSub').addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'SUBGROUP', kind: 'SUBGROUP', name: '', description: '', quantity: 0, rateMinor: 0, group: '' }); renderBuilder(); });
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
    var mt = document.getElementById('mTitle'); if (mt) mt.addEventListener('input', function () { pb.title = mt.value; });
    var mct = document.getElementById('mContact'); if (mct) mct.addEventListener('input', function () { pb.meta.contactName = mct.value; });
    var mp = document.getElementById('mProj'); if (mp) mp.addEventListener('input', function () { pb.meta.projectId = mp.value; });
    var mpd = document.getElementById('mPropDate'); if (mpd) mpd.addEventListener('input', function () { pb.meta.proposalDate = mpd.value; pb.meta.expiration = addDays(mpd.value, 7); var me2 = document.getElementById('mExp'); if (me2) me2.value = pb.meta.expiration; });
    var msp = document.getElementById('mShowProj'); if (msp) msp.addEventListener('change', function () { pb.meta.showProjectId = msp.checked; });
    var mdep = document.getElementById('mShowDeposit'); if (mdep) mdep.addEventListener('change', function () { pb.meta.showDeposit = mdep.checked; renderBuilderKeepingFocus(); });
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
      if (el) el.addEventListener('input', function () { pb.meta[p[1]] = el.value.trim(); });
    });
    var mdisc = document.getElementById('mDisc'); if (mdisc) mdisc.addEventListener('change', function () { pb.meta.discountPct = parseFloat(mdisc.value) || 0; renderBuilderKeepingFocus(); });
    var msf = document.getElementById('mStructFreight'); if (msf) msf.addEventListener('change', function () { pb.meta.structureFreightMinor = d2m(msf.value); renderBuilderKeepingFocus(); });
    var mmf = document.getElementById('mMatsFreight'); if (mmf) mmf.addEventListener('change', function () { pb.meta.matsFreightMinor = d2m(mmf.value); pb.meta.matsFreightTouched = true; renderBuilderKeepingFocus(); });
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
    document.querySelectorAll('.bDel').forEach(function (b) { b.addEventListener('click', function () { markBuilderDirty(); pb.lines.splice(+b.getAttribute('data-i'), 1); renderBuilder(); }); });
    // drag reorder
    document.querySelectorAll('.bRow').forEach(function (row) {
      row.addEventListener('dragstart', function () { bDragFrom = +row.getAttribute('data-i'); row.style.opacity = '0.4'; });
      row.addEventListener('dragend', function () { row.style.opacity = '1'; });
      row.addEventListener('dragover', function (e) { e.preventDefault(); });
      row.addEventListener('drop', function (e) {
        e.preventDefault(); var to = +row.getAttribute('data-i');
        if (bDragFrom == null || bDragFrom === to) return;
        var moved = pb.lines.splice(bDragFrom, 1)[0]; pb.lines.splice(to, 0, moved); bDragFrom = null; renderBuilder();
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
          pb.lines.push(applyItemDefaults({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: p.productId || null, sku: p.part, name: p.name || p.part, description: '', quantity: 1, rateMinor: 0, group: '' }));
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

  async function saveBuilder() {
    var btn = document.getElementById('bSave'); btn.disabled = true; btn.textContent = 'Saving…';
    var sections = [{ id: 'meta', type: 'CUSTOMER_INFO', title: 'Proposal', order: 0, enabled: true, data: pb.meta }];
    var items = pb.lines.map(function (l, i) { return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, internalNote: l.internalNote || '', components: l.components || null, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, costEach: Number(l.costEach) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i }; });
    try {
      var r = await authed('/proposals/versions/' + pb.versionId, { method: 'PATCH', body: { sections: sections, items: items, expirationDate: pb.meta.expiration || undefined } });
      if (!r.ok) { alert('Could not save (' + r.status + ').'); btn.disabled = false; btn.textContent = 'Save proposal'; return; }
      btn.textContent = 'Saved ✓';
      clearBuilderDirty();
      setTimeout(function () { openProposalDetail(pb.proposalId, pb.user); }, 500);
    } catch (e) { alert('Could not reach the server.'); btn.disabled = false; btn.textContent = 'Save proposal'; }
  }

  function saveAsTemplate() {
    openModal('Save as template',
      fieldRow('Template name', '<input id="tplName" style="' + IN + '" placeholder="e.g. Full Gym, Flex Quote, Soar" required>') +
      fieldRow('Description (optional)', '<input id="tplDesc" style="' + IN + '">'),
      async function (close, showErr) {
        var name = document.getElementById('tplName').value.trim(); if (!name) return showErr('Give the template a name.');
        var data = { title: pb.title, meta: { taxAmountMinor: pb.meta.taxAmountMinor, discountPct: pb.meta.discountPct, structureFreightMinor: pb.meta.structureFreightMinor, matsFreightMinor: pb.meta.matsFreightMinor, shipTo: '', projectId: '', expiration: '' }, lines: pb.lines.map(function (l) { return { lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, quantity: l.quantity, rateMinor: l.rateMinor, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: l.tpFreightMinor || 0, tpFreightLabel: l.tpFreightLabel || '' }; }) };
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
    var discountPct = Number(meta.discountPct) || 0; var discount = Math.round(subtotal * discountPct / 100);
    var tax = Number(meta.taxAmountMinor) || 0;
    var structureFreight = Number(meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0)); var matsFreight = Number(meta.matsFreightMinor) || 0;
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight;
    return {
      title: proposal.title, number: proposal.number, version: version.version || 1,
      orgName: orgName, meta: meta, lines: lines,
      totals: {
        subtotal: subtotal, discountPct: discountPct, discount: discount, tpFreight: tpFreight,
        tax: tax, structureFreight: structureFreight, matsFreight: matsFreight,
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
      if (value) return fmtMoney(value, 'USD');
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
    function subtotalRow() {
      if (groupOpenSub == null) return '';
      var r = '<tr style="break-inside:avoid;"><td colspan="5" style="padding:5px 8px;text-align:right;font-weight:600;font-size:11px;border-bottom:2px solid #d5d8d2;">Subtotal: ' + fmtMoney(groupOpenSub, 'USD') + '</td></tr>';
      groupOpenSub = null; return r;
    }
    (d.lines || []).forEach(function (l) {
      var lt = l.lineType || 'PRODUCT';
      if (lt === 'GROUP') {
        body += subtotalRow();
        groupOpenSub = 0; groupName = l.name; inSub = false;
        body += '<tr style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:6px 10px;font-weight:700;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:#3d4a55;background:#eef0ea;border-bottom:1px solid #d5d8d2;"><span style="display:inline-flex;align-items:baseline;gap:46px;"><span>' + esc(tc(stripOptional(l.name))) + (l.optional ? ' <span style="font-weight:400;text-transform:none;color:#8a8f85;">(Optional)</span>' : '') + '</span>' + (l.description ? '<span style="color:#20241f;">' + esc(l.description) + '</span>' : '') + '</span></td></tr>';
        return;
      }
      if (lt === 'SUBGROUP') { inSub = true; body += '<tr style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:7px 8px 3px 22px;font-weight:600;font-size:11.5px;color:#3d4a55;border-bottom:1px solid #d5d8d2;">' + esc(tc(l.name)) + '</td></tr>'; return; }
      if (lt === 'NOTE') { body += '<tr style="break-inside:avoid;"><td colspan="5" style="padding:7px 8px;background:#fbfaf4;font-size:11px;color:#5c6157;line-height:1.5;"><b style="display:block;color:#20241f;margin-bottom:2px;">' + esc(tc(l.name)) + '</b>' + rt(l.description) + '</td></tr>'; return; }
      var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
      var indent = groupOpenSub != null ? (inSub ? 34 : 20) : 8;
      if (groupOpenSub != null) groupOpenSub += amt + (Number(l.tpFreightMinor) || 0);
      body += '<tr style="break-inside:avoid;"><td style="padding:5px 8px 5px ' + indent + 'px;border-bottom:1px solid #eef0ea;vertical-align:top;"><b style="font-weight:600;">' + esc(tc(l.name)) + '</b>' + (l.description ? '<div style="font-size:10.5px;color:#5c6157;line-height:1.45;margin-top:2px;">' + esc(l.description) + '</div>' : '') +
        (l.delivery ? '<div style="font-size:10px;color:#7a7f75;margin-top:2px;">Delivery: ' + esc(l.delivery) + '</div>' : '') + '</td>' +
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
              '<div>Proposal Date: <b style="color:#20241f;">' + (m.proposalDate ? fmtDate(m.proposalDate) : fmtDate(new Date().toISOString())) + '</b></div>' +
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
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Subtotal</span><span>' + fmtMoney(t.subtotal, 'USD') + '</span></div>' +
          (t.discount ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;color:#9c3327;"><span>Discount (' + t.discountPct + '%)</span><span>− ' + fmtMoney(t.discount, 'USD') + '</span></div>' +
            '<div style="padding:0 8px 3px;font-size:10px;color:#8a8f85;text-align:right;">Discount expires ' + (m.expiration ? fmtDate(m.expiration) : 'with this proposal') + '</div>' : '') +
          (t.tpFreight ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Third-Party Freight</span><span>' + fmtMoney(t.tpFreight, 'USD') + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Tax</span><span>' + cellTax + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Structure Crating &amp; Freight</span><span>' + cellStructureFreight + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Mats &amp; Padding Freight</span><span>' + cellMatsFreight + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:8px;margin-top:5px;border-top:2px solid #3d4a55;font-size:15px;font-weight:700;"><span>Total</span><span>' + fmtMoney(t.total, 'USD') + '</span></div>' +
          (anyTbd ? '<div style="padding:2px 8px 0;font-size:10px;color:#8a8f85;text-align:right;line-height:1.5;">Total excludes items marked TBD.</div>' : '') +
          (m.showDeposit !== false ? '<div style="display:flex;justify-content:space-between;padding:6px 8px 0;font-size:13px;color:#3d4a55;font-weight:700;"><span>Deposit Due (' + depositPct() + '%)</span><span>' + fmtMoney(t.deposit, 'USD') + '</span></div>' : '') +
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

  function previewProposalDoc(doc) {
    ensurePrintStyle();
    var html = proposalDocHtml(doc);
    var ov = document.createElement('div');
    ov.id = 'propPreviewOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#e7e8e3;z-index:60;overflow:auto;padding:24px 16px;';
    ov.innerHTML = '<div class="noprint" style="max-width:760px;margin:0 auto 14px;display:flex;justify-content:space-between;gap:10px;"><button class="link-btn" id="pvClose" style="width:auto;padding:9px 16px;background:#fff;">‹ Close preview</button><button class="btn" id="pvPrint" style="width:auto;padding:9px 20px;">Print / Save PDF</button></div>' + html;
    document.body.appendChild(ov);
    document.getElementById('pvClose').addEventListener('click', function () { document.body.removeChild(ov); });
    document.getElementById('pvPrint').addEventListener('click', function () {
      // Browsers name the saved PDF after the document title, so set it for the print
      // and put it back afterwards.
      var prev = document.title;
      document.title = proposalFileName(doc);
      var restore = function () { document.title = prev; window.removeEventListener('afterprint', restore); };
      window.addEventListener('afterprint', restore);
      window.print();
      setTimeout(restore, 60000);
    });
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
      '#propPrintArea tr,#propPrintArea thead{break-inside:avoid!important;page-break-inside:avoid!important;}' +
      '#propPrintArea thead{display:table-header-group;}' +
      '#propPrintArea{padding:0!important;max-width:none!important;}}';
    document.head.appendChild(st);
  }

  /* --- Adventure Series guided configurator (decision tree) --- */
  function legsFor(len) {
    len = Number(len) || 0;
    if (len <= Number(fxSettings.legsSmallMaxFt)) return Number(fxSettings.legsSmallCount);
    if (len <= Number(fxSettings.legsMediumMaxFt)) return Number(fxSettings.legsMediumCount);
    return Number(fxSettings.legsLargeCount);
  }
  function _xlfnPrefix(config) { return config === 'Square' ? 'SQ-' : config === 'L-Shape' ? 'L-' : config === 'T-Shape' ? 'T-' : 'R-'; }
  var adv = null;
  function openAdventureConfigurator() {
    adv = {
      length: 10, width: 10, config: 'Square', legs: 6, legsAuto: true, configManual: false,
      monkeyBars: false, monkeyBarsQty: 1, ladders: false, laddersQty: 1, ladderShield: false,
      trolley: false, trolleyType: 'Dual', interiorBeams: false, interiorBeamsQty: 1,
      zipLine: false, zipLineQty: 1, ballRack: false,
      slide: false, slideGray: false, steamroller: false,
      climbFrame: false, climbWall: false, climbShield: false, climbMat: false,
      matFloor: false, matColumn: false, uShaped: 0, completeWrap: 0, matLadderLeg: false, matCustom: false,
      floorPadding: false, floorPadThickness: '3.25',
      brackets: false, bracketsQty: 0, swivel360: 0, swivelStandalone: 0, forged: 0, swingHanger: 0, vRings: 0, carabiner: 0, webbingSling: 0,
      partOverrides: {},
      hwTouched: {},
    };
    adv.legs = legsFor(adv.length);
    advOverridable = null;
    loadAdvOverridable();
    var ov = document.createElement('div');
    ov.id = 'advOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.4);z-index:70;overflow:auto;padding:24px 16px;';
    document.body.appendChild(ov);
    renderAdv();
  }
  function advClose() { var o = document.getElementById('advOverlay'); if (o) document.body.removeChild(o); }
  function climbWalls() { return (adv.climbFrame ? 1 : 0) + (adv.climbWall ? 1 : 0); }
  function eyeboltSum() { var nonSwivel = Math.max(0, (Number(adv.bracketsQty) || 0) - (Number(adv.swivel360) || 0)); return (Number(adv.swivel360) || 0) + nonSwivel + (Number(adv.forged) || 0) + (Number(adv.swingHanger) || 0); }

  /**
   * Floor padding price, mirroring src/proposals/matPricing.ts so the builder can
   * show the number before the server prices the proposal. Keep both in step.
   */
  var MAT_RATE = { '3.25': 11.78, '2': 7.65 }, MAT_MARKUP = 1.4, MAT_OVERAGE_IN = 14;

  /**
   * The part number each Additional Hardware quantity resolves to, mirroring
   * hardwareRules.ts and the accessory constants in adventureSeries.ts. Shown so a
   * rep can see what they are actually quoting. An array means the answer drives
   * more than one part, which is never substitutable.
   */
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
    var li = L * 12 + MAT_OVERAGE_IN, wi = W * 12 + MAT_OVERAGE_IN;
    var sqIn = li * wi, sqFt = sqIn / 144;
    var costMinor = Math.round(sqFt * MAT_RATE[th] * 100);
    var p2 = function (v) { return String(Math.max(0, Math.round(v))).padStart(2, '0'); };
    return {
      thickness: th, matLengthIn: li, matWidthIn: wi, squareInches: sqIn, squareFeet: sqFt,
      rate: MAT_RATE[th], costMinor: costMinor, priceMinor: Math.round(costMinor * MAT_MARKUP),
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
    return '<div style="font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px;">Padding thickness</div>' +
      '<div style="display:flex;gap:10px;">' + opt('3.25', '3.25" thick', '$11.78 / sq ft cost') + opt('2', '2" thick', '$7.65 / sq ft cost') + '</div>';
  }
  function padQuoteHint() {
    var q = matQuote();
    return '<div style="margin-top:10px;background:#f8f9f6;border:1px solid #e7e8e3;border-radius:10px;padding:10px 12px;font-size:12px;color:#5c6157;line-height:1.6;">' +
      '<div style="font-family:ui-monospace,monospace;font-size:11.5px;color:#3d4a55;font-weight:600;">' + esc(q.sku) + '</div>' +
      q.matLengthIn + '" × ' + q.matWidthIn + '" = ' + q.squareInches.toLocaleString() + ' sq in ÷ 144 = <b>' + q.squareFeet.toFixed(2) + ' sq ft</b><br>' +
      q.squareFeet.toFixed(2) + ' × $' + q.rate.toFixed(2) + ' = ' + fmtMoney(q.costMinor, 'USD') + ' cost × ' + MAT_MARKUP + ' = <b style="color:#2f7d5d;">' + fmtMoney(q.priceMinor, 'USD') + '</b> sell' +
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
          sec('Frame Dimensions', '<div style="' + grid + '">' + sel('length', 'Length (long, ft)', rangeArr(6, 30)) + sel('width', 'Width (short, ft)', rangeArr(6, 10)) + '</div>') +
          sec('Frame Configuration', '<div style="' + grid + '">' + sel('config', 'Configuration' + (adv.configManual ? ' (overridden)' : ' (auto)'), ['Rectangle', 'Square', 'L-Shape', 'T-Shape']) + num('legs', '# of Frame Legs (auto, editable)', 0, 20) + '</div>' +
            '<div class="muted" style="font-size:11.5px;margin-top:6px;">' + (adv.configManual ? 'Manually set — auto would be ' + autoConfig() + '. <a href="#" id="advCfgReset">Reset to auto</a>' : 'Auto from dimensions: ' + autoConfig()) + ' · legs auto-set from length (' + legsFor(adv.length) + ')</div>') +
          sec('Frame Options',
            tog('monkeyBars', 'Monkey Bars') + (adv.monkeyBars ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('monkeyBarsQty', '# of Monkey Bars', 1, 3) + '</div>' : '') +
            tog('ladders', 'Ladders') + (adv.ladders ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('laddersQty', '# of Ladders', 1, 4) + '</div>' + tog('ladderShield', 'Ladder — Safety Shield', 'Qty mirrors # of ladders (' + adv.laddersQty + ')') : '') +
            tog('trolley', 'Trolley System') + (adv.trolley ? '<div style="' + grid + 'margin:8px 0 4px;">' + sel('trolleyType', 'Type of Trolley System', ['Dual', 'Single']) + '</div>' : '') +
            tog('interiorBeams', 'Interior Beams') + (adv.interiorBeams ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('interiorBeamsQty', '# of Interior Beams', 1, 6) + '</div>' : '')
          ) +
          sec('Frame Accessories',
            tog('zipLine', 'Zip Line') + (adv.zipLine ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('zipLineQty', '# of Zip Line', 1, 3) + '</div>' : '') +
            tog('ballRack', 'Frame Mount — Ball Rack') +
            tog('slide', 'Slide') + (adv.slide ? '<div style="padding-left:16px;">' + tog('slideGray', 'Slide — Gray Upcharge') + tog('steamroller', 'Steamroller Ramp (3rd Party)', 'Auto-adds Slide Conversion Kit') + '</div>' : '') +
            tog('climbFrame', 'Climbing Wall — Frame Mounted') + tog('climbWall', 'Climbing Wall — Wall Mounted') +
            (climbWalls() > 0 ? '<div style="padding-left:16px;">' + tog('climbShield', 'Climbing Wall — Safety Shield', 'Qty mirrors # climbing walls (' + climbWalls() + ')') + tog('climbMat', 'Climbing Wall — Mat', 'Qty mirrors # climbing walls (' + climbWalls() + ')') + '</div>' : '')
          ) +
          sec('Mats & Padding',
            tog('floorPadding', 'Floor Padding', 'Sized from the frame: 14" added to each side. Priced per sq ft.') +
            (adv.floorPadding ? '<div style="margin:8px 0 12px;padding-left:16px;">' + padThicknessPicker() + padQuoteHint() + '</div>' : '') +
            tog('matColumn', 'Adventure Mat System — Column') +
            (adv.matColumn ? '<div style="' + grid + 'margin:8px 0 4px;">' + num('uShaped', 'U-Shaped Column Wraps (def = # ladders)', 0, 40) + num('completeWrap', 'Complete Column Wraps (def = legs − U-shaped)', 0, 40) + '</div>' : '') +
            tog('matLadderLeg', 'Adventure Mat System — Ladder Leg', 'Qty = # of ladders (' + adv.laddersQty + ')') +
            tog('matCustom', 'Adventure Mat System — CUSTOM', 'Mat SKU logic to be provided — added as manual line')
          ) +
          sec('Accessories & Hardware',
            '<div style="font-weight:600;font-size:13.5px;color:#3d4a55;margin-bottom:4px;">Quick Shift Saddle Bracket</div>' +
            tog('brackets', 'Include Quick Shift Saddle Bracket') +
            (adv.brackets ? '<div style="' + stack + 'margin:10px 0 4px;">' +
              num('bracketsQty', '# of Saddle Brackets', 0, 8) +
              num('swivel360', '# of 360 Swivel / 180 Eye Bolts (≤ brackets)', 0, 8) +
              '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;margin-bottom:4px;"># of 3/8" Non-Swivel Eye Bolts (auto)</label><input value="' + nonSwivel + '" disabled style="width:100%;padding:8px 10px;border:1px solid #eef0ea;border-radius:8px;font-size:14px;background:#f2f3ef;"></div>' +
            '</div>' : '') +
            '<div style="font-weight:600;font-size:13.5px;color:#3d4a55;margin:14px 0 4px;border-top:1px solid #f2f3ef;padding-top:14px;">Additional Hardware</div>' +
            '<div style="' + stack + '">' +
              hwNum('forged', '# 1/2" Forged Eye Bolts (×6)', 0, 36) +
              hwNum('swivelStandalone', '# Swing &amp; Swivel Eye Bolt (stand-alone)', 0, 24) +
              hwNum('swingHanger', '# Swing Hanger w/ Bearing (×2)', 0, 12) +
              hwNum('vRings', '# V-Rings (10-pack)', 0, 3) +
              hwNum('carabiner', 'Auto-Locking Carabiner (4pk)', 0, 8, 'Suggested: ' + carabRec + ' — enter a quantity to include it') +
              hwNum('webbingSling', 'Multi-Pocket Webbing Sling', 0, 16, 'Suggested: ' + (Number(adv.legs) || 0) + ' (one per leg)') +
            '</div>'
          ) +
          '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid #e7e8e3;">' +
            '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#5c6157;"><input type="checkbox" id="advReplace"> Replace existing lines</label>' +
            '<div style="display:flex;gap:8px;">' +
            '<button class="link-btn" id="advTrace" style="width:auto;padding:11px 16px;">Test the logic →</button>' +
            '<button class="btn" id="advGen" style="width:auto;padding:11px 22px;">Generate proposal lines →</button></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    o.innerHTML = html;
    o.addEventListener('mousedown', function (e) { if (e.target === o) advClose(); });
    document.getElementById('advX').addEventListener('click', advClose);
    var cfgReset = document.getElementById('advCfgReset');
    if (cfgReset) cfgReset.addEventListener('click', function (e) { e.preventDefault(); adv.configManual = false; adv.config = autoConfig(); renderAdv(); });
    document.getElementById('advGen').addEventListener('click', function () { generateAdvLines(document.getElementById('advReplace').checked); });
    document.getElementById('advTrace').addEventListener('click', openAdvTrace);
    o.querySelectorAll('[data-ovr]').forEach(function (el) {
      el.addEventListener('change', function () {
        var base = el.getAttribute('data-ovr'), v = el.value.trim();
        adv.partOverrides = adv.partOverrides || {};
        if (!v || v === base) delete adv.partOverrides[base]; else adv.partOverrides[base] = v;
        renderAdv();
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
      if (el.type === 'checkbox') { el.addEventListener('change', function () { adv[k] = el.checked; syncAdvDefaults(k); renderAdv(); }); }
      else {
        el.addEventListener('input', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; markHwTouched(k); });
        el.addEventListener('change', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; markHwTouched(k); syncAdvDefaults(k); renderAdv(); });
      }
    });
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
      slide: !!adv.slide, slideGray: !!adv.slideGray, steamroller: !!adv.steamroller,
      climbFrame: !!adv.climbFrame, climbWall: !!adv.climbWall, climbShield: !!adv.climbShield, climbMat: !!adv.climbMat,
      matFloor: !!adv.floorPadding, matColumn: !!adv.matColumn, uShaped: Number(adv.uShaped), completeWrap: Number(adv.completeWrap), matLadderLeg: !!adv.matLadderLeg, matCustom: !!adv.matCustom,
      floorPadding: !!adv.floorPadding, floorPadThickness: adv.floorPadThickness === '2' ? '2' : '3.25',
      brackets: !!adv.brackets, bracketsQty: Number(adv.bracketsQty), swivel360: Number(adv.swivel360), swivelStandalone: Number(adv.swivelStandalone), forged: Number(adv.forged), swingHanger: Number(adv.swingHanger), vRings: Number(adv.vRings), carabiner: Number(adv.carabiner), webbingSling: Number(adv.webbingSling),
      partOverrides: adv.partOverrides || {},
    };
  }

  /** Logic trace overlay — every derived quantity, its formula, and the catalog price behind it. */
  async function openAdvTrace() {
    var btn = document.getElementById('advTrace'); if (btn) { btn.disabled = true; btn.textContent = 'Tracing…'; }
    var t = null;
    try { var r = await authed('/proposals/adventure-series/trace', { method: 'POST', body: advAnswers() }); if (r.ok) t = await r.json(); } catch (e) {}
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
          '<div class="muted" style="font-size:12px;margin-bottom:8px;">Fastener quantities are driven off the frame BOM per the v73 workbook — every one of these is summed into the single H-1000 line and none are billed separately.</div>' +
          (hwRows ? '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' + th('Part') + th('Component') + th('Quantity formula') + th('Qty', 1) + th('Unit', 1) + th('Extended', 1) + '</tr></thead><tbody>' + hwRows +
            '<tr><td colspan="5" style="padding:7px 8px;text-align:right;font-weight:700;font-size:12.5px;">H-1000 total</td><td style="padding:7px 8px;text-align:right;font-weight:700;font-size:12.5px;">' + fmtMoney(hw.priceMinor, 'USD') + '</td></tr>' +
            '</tbody></table></div>' : '<div class="muted" style="font-size:12.5px;">No hardware selected.</div>') +
        '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) document.body.removeChild(ov); });
    document.getElementById('trClose').addEventListener('click', function () { document.body.removeChild(ov); });
  }

  async function generateAdvLines(replace) {
    var btn = document.getElementById('advGen'); if (btn) { btn.disabled = true; btn.textContent = 'Pricing…'; }
    var answers = advAnswers();
    var priced = null;
    try {
      var r = await authed('/proposals/adventure-series/price', { method: 'POST', body: answers });
      if (r.ok) priced = await r.json();
    } catch (e) {}
    if (!priced) { if (btn) { btn.disabled = false; btn.textContent = 'Generate proposal lines →'; } alert('Could not reach the pricing engine. Is the server running the latest build?'); return; }
    var out = (priced.lines || []).map(function (l) {
      return normalizeLine({
        lineType: l.lineType, kind: l.lineType === 'GROUP' ? 'GROUP' : l.lineType === 'SUBGROUP' ? 'SUBGROUP' : l.lineType === 'NOTE' ? 'NOTE' : 'INCLUDED',
        name: l.name, sku: l.sku || '', description: l.description || '', quantity: l.quantity == null ? 0 : l.quantity,
        rateMinor: l.rateMinor || 0, costEach: l.costEach || 0, weightEach: l.weightEach || 0, optional: !!l.optional,
        internalNote: l.internalNote || '', components: l.components || null, components: l.components || null,
      });
    });
    out.forEach(applyItemDefaults);
    if (replace) pb.lines = out; else pb.lines = pb.lines.concat(out);
    advClose(); renderBuilder();
    var bl = document.getElementById('bLines'); if (bl) bl.scrollIntoView({ block: 'start' });
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
      el.addEventListener('change', function () { soar.rows[Number(el.getAttribute('data-sfpart'))].part = el.value; renderSoar(); });
    });
    o.querySelectorAll('[data-sfqty]').forEach(function (el) {
      el.addEventListener('change', function () { soar.rows[Number(el.getAttribute('data-sfqty'))].qty = Math.max(0, Number(el.value) || 0); renderSoar(); });
    });
    o.querySelectorAll('[data-sfdel]').forEach(function (el) {
      el.addEventListener('click', function () { soar.rows.splice(Number(el.getAttribute('data-sfdel')), 1); renderSoar(); });
    });
    o.querySelectorAll('[data-sk]').forEach(function (el) {
      var key = el.getAttribute('data-sk');
      el.addEventListener('change', function () {
        if (el.type === 'checkbox') soar[key] = el.checked;
        else soar[key] = el.value === '' ? null : Math.max(0, Number(el.value) || 0);
        renderSoar();
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
    var bySort = function (a, b) { return (Number(a.node.sortOrder) || 0) - (Number(b.node.sortOrder) || 0); };
    (function sortRec(list) { list.sort(bySort); list.forEach(function (e) { sortRec(e.children); }); })(roots);
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
          if (prodSlugs.length) {
            var checkedN = prodSlugs.filter(function (s) { return !!linePicker.checked[s]; }).length;
            var state = checkedN === 0 ? 'none' : checkedN === prodSlugs.length ? 'all' : 'some';
            headerCheck = '<input type="checkbox" class="lpHeaderCheck" data-slug="' + esc(n.slug) + '" data-state="' + state + '"' + (state === 'all' ? ' checked' : '') + ' style="width:16px;height:16px;flex:0 0 auto;margin-right:8px;">';
          }
          rows += '<div style="display:flex;align-items:center;margin-left:' + indent + 'px;padding:' + (isTier1 ? '14px 0 6px' : '8px 0 4px') + ';' + (isTier1 ? 'border-top:1px solid #e7e8e3;' : '') + '">' +
            headerCheck +
            '<span style="font-weight:600;font-size:' + (isTier1 ? '14.5px' : '13px') + ';color:#3d4a55;">' + esc(n.name) + '</span>' +
          '</div>';
          return;
        }
        var checked = !!linePicker.checked[n.slug];
        var qty = linePicker.qty[n.slug] != null ? linePicker.qty[n.slug] : 1;
        var price = n.unitPriceMinor || 0;
        rows += '<label style="display:flex;align-items:center;gap:10px;padding:6px 0;margin-left:' + indent + 'px;cursor:pointer;">' +
          '<input type="checkbox" class="lpCheck" data-slug="' + esc(n.slug) + '"' + (checked ? ' checked' : '') + ' style="width:16px;height:16px;flex:0 0 auto;">' +
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
      fieldRow('Approved on', '<input id="aDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '" style="' + IN + '">') +
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
      downloadCsv('orders-' + new Date().toISOString().slice(0, 10) + '.csv',
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
        '<div><div class="k">Customer approval</div><div class="v small">' + (order.customerApproval ? esc(order.customerApproval.approverName) : '—') + '</div></div></div></div>' +
      sectionBlock('Requirements', reqRows(order.requirements || [], canHandoff)) +
      sectionBlock('Internal tasks', taskRows(order.tasks || [], canHandoff)) +
      (hasRole(QBO_VIEW_ROLES, user.role) ? sectionBlock('QuickBooks', '<div id="qboBox"><div class="muted" style="padding:16px;">Loading…</div></div>') : '') +
      sectionBlock('Bill of Materials', '<div id="bomBox"><div class="muted" style="padding:16px;">Loading…</div></div>') +
      sectionBlock('Audit timeline', auditRows(audit));
    document.getElementById('ordBack').addEventListener('click', function () { renderOrders(user); });
    loadBomSections(order, user, canHandoff);
    if (hasRole(QBO_VIEW_ROLES, user.role)) loadQbo(order, user);
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
    var cols = 8 + (showColor ? 1 : 0) + (showBag ? 1 : 0);
    var rowHtmlFor = function (p) {
      var ext = (Number(p.unitCostMinor) || 0) * (Number(p.quantity) || 0);
      var buy = p.productUrl
        ? ' <a href="' + esc(p.productUrl) + '" target="_blank" rel="noopener" style="font-size:11.5px;margin-left:6px;">Buy ↗</a>' : '';
      return '<tr>' +
        td('<b style="font-weight:600;">' + esc(p.name) + '</b>' + buy) +
        td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(p.sku || '—') + '</code>') +
        td(String(p.quantity)) +
        (showBag ? td(esc(p.packagingBag || '—')) : '') +
        (showColor ? td(edit ? colorCell(p) : esc(p.powderColor || '—')) : '') +
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
      '<td style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td>' +
      '<td style="padding:12px 16px;border-top:1px solid #e7e8e3;font-weight:600;">' + s.unitCount + '</td>' +
      '<td colspan="' + (2 + (showColor ? 1 : 0) + (showBag ? 1 : 0)) + '" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td>' +
      '<td style="padding:12px 16px;border-top:1px solid #e7e8e3;font-weight:600;">' + money2(s.extendedCostMinor) + '</td>' +
      '<td colspan="2" style="padding:12px 16px;border-top:1px solid #e7e8e3;"></td></tr>';

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
          (canHandoff ? '<button class="btn" data-sec-email="' + s.id + '" style="width:auto;padding:8px 14px;">Email vendor</button>' : '') +
          (canHandoff && !locked ? '<button class="btn" data-sec-confirm="' + s.id + '" style="width:auto;padding:8px 14px;">Confirm sent</button>' : '') +
          (canHandoff && locked ? '<button class="link-btn" data-sec-unlock="' + s.id + '" style="width:auto;padding:8px 14px;color:#9c3327;">Unlock for revisions</button>' : '') +
        '</div>' +
      '</div>' +
      '<div style="padding:16px 18px;">' +
        warn +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
          '<div><div class="k">Job name</div><input class="secF" data-id="' + s.id + '" data-f="jobName" value="' + esc(s.jobName || '') + '" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
          '<div><div class="k">Ship to</div><select class="secF" data-id="' + s.id + '" data-f="shipTo" style="' + bomFieldStyle(null, locked) + '"' + dis + '>' +
            '<option value="CUSTOMER"' + (s.shipTo === 'SUMMIT' ? '' : ' selected') + '>Customer site</option>' +
            '<option value="SUMMIT"' + (s.shipTo === 'SUMMIT' ? ' selected' : '') + '>Summit Sensory Gym</option></select></div>' +
          '<div><div class="k">Submission date</div><input class="secF" data-id="' + s.id + '" data-f="submittedOn" type="date" value="' + esc(dateVal) + '" style="' + bomFieldStyle(null, locked) + (placeholderDate ? 'color:#8a8f85;' : '') + '"' + dis + '>' +
            (placeholderDate ? '<div class="muted" style="font-size:11px;margin-top:3px;">Today, until you confirm or change it</div>' : '') + '</div>' +
          '<div><div class="k">Delivery type</div><input class="secF" data-id="' + s.id + '" data-f="deliveryType" value="' + esc(s.deliveryType || '') + '" placeholder="e.g. Lift Gate" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
          '<div><div class="k">Estimated shipment quote</div><input class="secF" data-id="' + s.id + '" data-f="shipmentQuote" value="' + esc(s.shipmentQuote || '') + '" placeholder="TBD" style="' + bomFieldStyle(null, locked) + '"' + dis + '></div>' +
        '</div>' +
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
        (edit && s.showPowderColor ? colorApplyRow(s) : '') +
        '<div style="margin-top:14px;overflow:auto;">' +
          tableShell(
            ['Item', 'Part #', 'Qty'].concat(showBag ? ['Bag #'] : [], showColor ? ['Powder color'] : [], ['Weight (lb)', 'Cost each', 'Total cost', 'Notes', 'Status']),
            rows, cols, '') +
        '</div>' +
        sendHistory(s) +
      '</div>' +
    '</div>';
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

  /** Paint one brand + code across the parts of this section. */
  function colorApplyRow(s) {
    var codes = [];
    bomBrands.forEach(function (b) { (b.recentCodes || []).forEach(function (c) { codes.push(c); }); });
    return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding:11px 13px;background:#fbfbf9;border:1px solid #eceee8;border-radius:9px;">' +
      '<span style="font-size:12.5px;color:#5c6157;">Set a colour across this section:</span>' +
      '<select class="secColorBrand" data-id="' + s.id + '" style="' + bomFieldStyle('130px') + '">' +
        '<option value="">Brand…</option>' +
        bomBrands.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + '</option>'; }).join('') +
      '</select>' +
      '<input class="secColorCode" data-id="' + s.id + '" list="bomCodeList" placeholder="Colour code" style="' + bomFieldStyle('140px') + '">' +
      (codes.length ? '<datalist id="bomCodeList">' + codes.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' : '') +
      '<button class="link-btn" data-sec-color="' + s.id + '" style="width:auto;padding:7px 13px;">Apply</button>' +
      '<span class="muted" style="font-size:11.5px;">Skips parts that already have a colour.</span>' +
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

  /** Append-only record of every BOM emailed to this vendor. */
  function sendHistory(s) {
    if (!s.sends.length) return '';
    var rows = s.sends.map(function (x) {
      var chip = x.status === 'FAILED' || x.status === 'BOUNCED'
        ? '<span class="chip" style="background:#fbecea;color:#9c3327;">' + titleCase(x.status) + '</span>'
        : '<span class="chip" style="background:#eaf1ec;color:#2f6b4f;">' + titleCase(x.status) + '</span>';
      return '<tr>' + td(fmtDateTime(x.sentAt)) + td(esc(x.sentBy || '—')) + td(esc(x.toEmail)) +
        td(esc(x.format)) + td(chip + (x.error ? '<div class="muted" style="font-size:11px;color:#9c3327;margin-top:3px;">' + esc(x.error) + '</div>' : '')) + '</tr>';
    }).join('');
    return '<div style="margin-top:14px;">' +
      '<div style="font-size:12.5px;font-weight:600;color:#4a4f47;margin-bottom:8px;">Sent to this vendor</div>' +
      tableShell(['Date & time', 'Sent by', 'To', 'Format', 'Delivery'], rows, 5, '') +
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
        body[f] = f === 'sourced' ? el.value === 'true' : el.value.trim();
        el.style.borderColor = '#c9a227';
        var r = await authed('/orders/procurement/' + el.getAttribute('data-id'), { method: 'PATCH', body: body });
        el.style.borderColor = r.ok ? '#3f9d78' : '#c2452f';
        if (!r.ok) return fail(r, 'Could not save the line');
        var line = (procData || []).filter(function (x) { return x.id === el.getAttribute('data-id'); })[0];
        if (line) line[f] = body[f];
        setTimeout(function () { el.style.borderColor = '#dcded7'; }, 900);
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
        var brand = document.querySelector('.secColorBrand[data-id="' + id + '"]').value;
        var code = document.querySelector('.secColorCode[data-id="' + id + '"]').value.trim();
        if (!brand || !code) { alert('Pick a brand and type the colour code.'); return; }
        var sec = bomSectionData.filter(function (x) { return x.id === id; })[0];
        var r = await authed('/orders/' + order.id + '/bom/apply-color', {
          method: 'POST', body: { brandId: brand, code: code, vendor: sec.vendor, overwrite: false },
        });
        if (!r.ok) return fail(r, 'Could not apply the colour');
        var d = await r.json();
        alert(d.applied + ' part' + (d.applied === 1 ? '' : 's') + ' set to ' + d.color +
          (d.skipped ? '. ' + d.skipped + ' skipped — already coloured, or in another section.' : '.'));
        var o = await (await authed('/orders/' + order.id)).json();
        order.procurement = o.procurement; reload();
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
        if (!confirm('Confirm the ' + sec.vendor + ' Bill of Materials has been sent?\n\nIts fields lock until you unlock them for revisions.')) return;
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

  /** Email this vendor's BOM, pre-filled from the vendor's saved defaults. */
  function openSendForm(order, sec, done) {
    var e = sec.email;
    openModal('Email the ' + sec.vendor + ' Bill of Materials',
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
      ['Submission date', doc.order.submittedOn ? String(doc.order.submittedOn).slice(0, 10) : new Date().toISOString().slice(0, 10)],
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
    ['DEPOSIT_INVOICE', 'Deposit invoice'],
    ['PROGRESS_INVOICE', 'Progress invoice'],
    ['FINAL_INVOICE', 'Final invoice']
  ];
  function qboTypeLabel(t) { for (var i = 0; i < QBO_TYPES.length; i++) if (QBO_TYPES[i][0] === t) return QBO_TYPES[i][1]; return titleCase(t); }
  async function loadQbo(order, user) {
    var box = document.getElementById('qboBox'); if (!box) return;
    var txns = [];
    var conn = null;
    try {
      var rs = await authed('/integrations/quickbooks/status'); conn = rs.ok ? await rs.json() : null;
      var r = await authed('/integrations/quickbooks/transactions?proposalId=' + encodeURIComponent(order.proposalId));
      if (r.status === 403) { box.innerHTML = '<div class="placeholder" style="padding:18px;"><p class="muted" style="margin:0;">Your role cannot view QuickBooks documents.</p></div>'; return; }
      if (r.ok) txns = (await r.json()) || [];
    } catch (e) { box.innerHTML = '<div class="err">Could not reach QuickBooks.</div>'; return; }

    var connected = conn && (conn.connections || 0) > 0;
    var canTransact = hasRole(QBO_TXN_ROLES, user.role) && connected && order.status !== 'CANCELLED';
    var rows = txns.map(function (t) {
      var step = '';
      if (canTransact) {
        if (t.status === 'DRAFT' || t.status === 'PENDING_AUTHORIZATION') step = '<button class="link-btn" data-qbo="authorize" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 2 · Authorize</button>';
        else if (t.status === 'AUTHORIZED') step = '<button class="btn" data-qbo="execute" data-id="' + t.id + '" style="width:auto;padding:7px 13px;">Step 3 · Create in QuickBooks</button>';
        else if (t.status === 'FAILED') step = '<button class="link-btn" data-qbo="retry" data-id="' + t.id + '" style="width:auto;padding:7px 13px;color:#9c3327;">Retry</button>';
      }
      return '<tr>' + td('<b style="font-weight:600;">' + esc(qboTypeLabel(t.type)) + '</b>' + (t.error ? '<div style="font-size:12px;color:#9c3327;">' + esc(t.error) + '</div>' : '')) +
        td('<span class="chip">' + titleCase(t.status) + '</span>') +
        td(fmtMoney(t.amountMinor, t.currency)) +
        td(esc(t.qboDocNumber || t.qboId || '—')) +
        td('<div style="display:flex;justify-content:flex-end;">' + (step || '<span class="muted">—</span>') + '</div>') + '</tr>';
    }).join('');

    box.innerHTML =
      '<div class="muted" style="font-size:12.5px;margin:-4px 0 10px;line-height:1.55;">Pushing to QuickBooks is three deliberate steps: <b>prepare</b> freezes the totals and an idempotency key (nothing leaves this app), <b>authorize</b> is the sign-off, <b>create</b> writes the document into QuickBooks. A retry reuses the same key, so it can never duplicate a document.</div>' +
      (!connected ? '<div class="placeholder" style="padding:16px;margin-bottom:10px;"><p class="muted" style="margin:0;">QuickBooks is not connected — connect it under Integrations first.</p></div>' : '') +
      (canTransact ? '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button class="btn" id="qboPrepare" style="width:auto;padding:9px 15px;">Step 1 · Prepare a document</button></div>' : '') +
      tableShell(['Document', 'Status', 'Amount', 'QuickBooks #', ''], rows, 5, 'Nothing pushed to QuickBooks for this order yet.');

    var pb = document.getElementById('qboPrepare');
    if (pb) pb.addEventListener('click', function () { openQboPrepare(order, user); });
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
  }
  function openQboPrepare(order, user) {
    openModal('Prepare a QuickBooks document',
      '<div class="muted" style="font-size:13px;margin-bottom:12px;">This freezes the accepted totals of ' + esc(order.number) + ' against an idempotency key. Nothing is sent to QuickBooks until you authorize and create it.</div>' +
      fieldRow('Document type', '<select id="qboType" style="' + IN + '">' + QBO_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') + '</select>'),
      async function (close, showErr) {
        var r = await authed('/integrations/quickbooks/transactions/prepare', { method: 'POST', body: { proposalVersionId: order.proposalVersionId, type: document.getElementById('qboType').value } });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not prepare (' + r.status + ').'); }
        close(); loadQbo(order, user);
      }, 'Prepare');
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
  async function buildProposalDocForSend(p) {
    try {
      var rv = await authed('/proposals/' + p.id);
      if (!rv.ok) return null;
      var full = await rv.json();
      var versions = (full.versions || []).slice().sort(function (x, y) { return y.version - x.version; });
      var v = versions[0];
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
      '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;">Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically. Table notes print inside the line items; footer notes print below the signature lines. Also editable under Catalog → Proposal notes.</div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>' +
      '<div class="section-title" style="margin-top:26px;">Formulas</div>' +
      '<div class="muted" style="font-size:12.5px;margin:0 0 10px;">Every calculation the pricing engine runs. Frame and hardware quantities are editable coefficients; business numbers are the scalars the proposal math uses; the last tab lists what is fixed in code and why.</div>' +
      '<div id="fxTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;"></div>' +
      '<div id="fxBody"><div class="muted" style="padding:16px;">Loading…</div></div>' +
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
    var n = note || { title: '', body: '', placement: 'TABLE', autoInclude: false, sortOrder: 0, active: true };
    openModal(note ? 'Edit standard note' : 'New standard note',
      fieldRow('Title', '<input id="snTitle" style="' + IN + '" value="' + esc(n.title) + '">') +
      richTextField('snBody', 'Note text', n.body, 'Line breaks are kept. Bold and italic print on the customer proposal.') +
      fieldRow('Where it prints', '<select id="snPlace" style="' + IN + '"><option value="TABLE"' + (n.placement === 'TABLE' ? ' selected' : '') + '>Inside the line items</option><option value="FOOTER"' + (n.placement === 'FOOTER' ? ' selected' : '') + '>Below the signature lines</option></select>') +
      fieldRow('Order', '<input id="snOrder" type="number" style="' + IN + '" value="' + (Number(n.sortOrder) || 0) + '">') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;cursor:pointer;"><input type="checkbox" id="snAuto"' + (n.autoInclude ? ' checked' : '') + '> Always include on new proposals</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="snActive"' + (n.active !== false ? ' checked' : '') + '> Available in the builder</label>',
      async function (close, showErr) {
        var body = {
          title: document.getElementById('snTitle').value.trim(),
          body: editHtmlToMd(document.getElementById('snBody')),
          placement: document.getElementById('snPlace').value,
          sortOrder: Number(document.getElementById('snOrder').value) || 0,
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
  var FX_TABS = [
    { id: 'frame', label: 'Frame & components' },
    { id: 'hardware', label: 'Hardware fasteners' },
    { id: 'settings', label: 'Business numbers' },
    { id: 'code', label: 'Fixed in code' },
  ];
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
  function drawFormulas() {
    var box = document.getElementById('fxBody'); if (!box || !fx.data) return;
    drawFxTabs();
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
    if (fx.tab === 'settings') {
      var st = fx.data.settings || { values: {}, defs: [], defaults: {} };
      var groups = [];
      st.defs.forEach(function (d) { if (groups.indexOf(d.group) === -1) groups.push(d.group); });
      box.innerHTML =
        '<div class="muted" style="font-size:12.5px;margin-bottom:12px;">The business numbers the proposal math uses. Changing one affects new proposals; documents already saved keep their own figures.</div>' +
        groups.map(function (g) {
          return '<div class="card" style="margin-bottom:12px;"><div class="section-title" style="margin:0 0 10px;">' + esc(g) + '</div>' +
            st.defs.filter(function (d) { return d.group === g; }).map(function (d) {
              var v = st.values[d.key];
              var changed = Number(v) !== Number(st.defaults[d.key]);
              return '<div style="display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-top:1px solid #f2f3ef;">' +
                '<div style="flex:1;"><div style="font-size:13.5px;font-weight:600;">' + esc(d.label) +
                  (changed ? ' <span style="background:#fdf6e3;border:1px solid #eadfbe;color:#8a6d1f;border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;">changed from ' + st.defaults[d.key] + '</span>' : '') + '</div>' +
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
        var msg = document.getElementById('fxSetMsg'); msg.textContent = 'Saving…';
        var r = await authed('/formulas/settings', { method: 'PATCH', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} msg.textContent = m || 'Could not save (' + r.status + ').'; return; }
        fx.data.settings.values = await r.json();
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
      if (!confirm('Clear every edit in “' + (set.label || kind) + '” and return to the v73 workbook values?')) return;
      var r = await authed('/formulas/reset', { method: 'POST', body: { kind: kind.toUpperCase() } });
      if (!r.ok) { alert('Could not reset (' + r.status + ').'); return; }
      loadFormulas();
    });
    box.querySelectorAll('.fxEdit').forEach(function (b) {
      b.addEventListener('click', function () {
        openFormulaForm(kind, (set.rules || []).filter(function (x) { return x.part === b.getAttribute('data-part'); })[0]);
      });
    });
    box.querySelectorAll('.fxRevert').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Return ' + b.getAttribute('data-part') + ' to the workbook default?')) return;
        var rr = await authed('/formulas/' + kind.toUpperCase() + '/' + encodeURIComponent(b.getAttribute('data-part')), { method: 'DELETE' });
        if (!rr.ok && rr.status !== 204) { alert('Could not reset (' + rr.status + ').'); return; }
        loadFormulas();
      });
    });
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
        var r = await authed('/formulas/' + kind.toUpperCase() + '/' + encodeURIComponent(rule.part), { method: 'PATCH', body: body });
        if (!r.ok) { var m = ''; try { m = ((await r.json()) || {}).message || ''; } catch (e) {} return showErr(m || 'Could not save (' + r.status + ').'); }
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
      var rows = (users || []).map(function (u) {
        return '<tr>' + td('<b style="font-weight:600;">' + esc(u.name || '—') + '</b>') + td(esc(u.email)) +
          td('<select data-id="' + u.id + '" class="roleSel" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;">' + ROLES.map(function (rl) { return '<option value="' + rl + '"' + (rl === u.role ? ' selected' : '') + '>' + titleCase(rl) + '</option>'; }).join('') + '</select>') +
          td(u.isActive ? '<span class="chip">Active</span>' : '<span class="muted">Inactive</span>') +
          td('<div style="display:flex;gap:6px;justify-content:flex-end;">' +
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
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  function openUserForm() {
    openModal('New user',
      fieldRow('Email', '<input id="uEmail" type="email" style="' + IN + '" required>') +
      fieldRow('Name', '<input id="uName" style="' + IN + '">') +
      fieldRow('Temporary password', '<input id="uPass" style="' + IN + '" placeholder="at least 12 characters" required>') +
      fieldRow('Role', selectEl('uRole', ROLES, 'SALES_REP')),
      async function (close, showErr) {
        var email = document.getElementById('uEmail').value.trim(); if (!/.+@.+\..+/.test(email)) return showErr('Enter a valid email.');
        var pass = document.getElementById('uPass').value; if (pass.length < 12) return showErr('Password must be at least 12 characters.');
        var body = { email: email, name: document.getElementById('uName').value.trim() || undefined, password: pass, role: document.getElementById('uRole').value };
        var r = await authed('/admin/users', { method: 'POST', body: body });
        if (!r.ok) return showErr(await serverMessage(r, 'Could not create (' + r.status + ').'));
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

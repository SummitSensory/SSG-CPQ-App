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
  // Auth'd request with one transparent refresh-retry on 401.
  async function authed(path, opts) {
    var r = await api(path, opts);
    if (r.status === 401 && (await refresh())) r = await api(path, opts);
    return r;
  }

  /* --- Login --- */
  function renderLogin(msg) {
    root.innerHTML =
      '<div class="login-wrap"><form class="login-card" id="loginForm">' +
        '<div style="text-align:center;margin-bottom:22px;"><div class="login-logo"></div><div class="login-brandname">Summit Sensory Gym</div><div class="login-brandsub">Proposal Management Software</div></div>' +
        '<h1>Welcome back</h1>' +
        '<div class="login-sub">Sign in to Summit Sensory Gym Proposal Management Software.</div>' +
        (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>' +
        '<button class="btn" type="submit" id="submitBtn">Sign in</button>' +
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
    { id: 'orders', label: 'Orders & Handoff', ready: true, roles: '*' },
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
  function hasRole(list, role) { return list.indexOf(role) !== -1; }
  function navFor(role) { return NAV.filter(function (n) { return n.roles === '*' || n.roles.indexOf(role) !== -1; }); }
  function roleLabel(role) { return titleCase(role); }

  function renderShell(user) {
    currentUser = user;
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
            '<div style="text-align:center;font-size:10px;color:#b3b7ac;margin-top:8px;letter-spacing:.04em;">build 17 · proposal reporting</div></div>' +
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
  var cat = { q: '', status: '', page: 1, tab: 'items' };
  var catCategories = [];
  var KINDS = ['PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE'];
  var STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
  function catName(id) { var c = catCategories.filter(function (x) { return x.id === id; })[0]; return c ? c.name : '—'; }
  function slugify(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  function renderCatalog(user) {
    function ctab(id, label){var on=cat.tab===id;return '<button data-ctab="'+id+'" style="border:none;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:'+(on?'600':'500')+';cursor:pointer;background:'+(on?'#fff':'transparent')+';color:'+(on?'#1c4039':'#6b7065')+';box-shadow:'+(on?'0 1px 2px rgba(0,0,0,.06)':'none')+';">'+label+'</button>';}
    document.getElementById('view').innerHTML = '<div style="display:flex;gap:5px;background:#eef0ea;padding:4px;border-radius:10px;width:max-content;margin-bottom:18px;">'+ctab('items','Catalog')+ctab('products','Product tree')+'</div><div id="catBody"></div>';
    document.querySelectorAll('[data-ctab]').forEach(function(b){b.addEventListener('click',function(){cat.tab=b.getAttribute('data-ctab');renderCatalog(user);});});
    if(cat.tab==='products') renderCatalogProducts(user); else renderItems(user);
  }

  /* --- The one catalog list: Product + SKU merged, one row per part number --- */
  var itemState = { q: '', page: 1, categories: [], manufacturers: [] };
  function renderItems(user) {
    var admin = canCatalogAdmin(user.role);
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<input id="itSearch" placeholder="Search part #, name, category or manufacturer…" value="' + esc(itemState.q) + '" style="flex:1;min-width:240px;max-width:420px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="itImport" style="width:auto;padding:10px 15px;">Import Excel / CSV</button><button class="btn" id="itNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">Every product on one line — name, category, manufacturer, cost, price and weight. Edit any cell and it saves as you leave the field. These prices and weights are what the Adventure Series engine and the proposal builder multiply against.</div>' +
      '<div id="itList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var s = document.getElementById('itSearch'), t;
    s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { itemState.q = s.value.trim(); itemState.page = 1; loadItems(user); }, 300); });
    if (admin) {
      document.getElementById('itNew').addEventListener('click', function () { openSkuForm(user); });
      document.getElementById('itImport').addEventListener('click', function () { openSkuImport(user); });
    }
    loadItems(user);
  }

  async function loadItems(user) {
    var box = document.getElementById('itList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    try {
      if (!itemState.manufacturers.length) {
        try { var rm = await authed('/catalog/manufacturers'); if (rm.ok) itemState.manufacturers = ((await rm.json()) || []).map(function (m) { return m.name; }); } catch (e0) {}
      }
      var r = await authed('/catalog/items?page=' + itemState.page + '&pageSize=100' + (itemState.q ? '&q=' + encodeURIComponent(itemState.q) : ''));
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      itemState.categories = (d.categories || []).map(function (c) { return c.name; });
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
      var rows = (d.items || []).map(function (k) {
        var margin = k.unitPriceMinor ? Math.round(((k.unitPriceMinor - k.unitCostMinor) / k.unitPriceMinor) * 1000) / 10 : 0;
        var where = (k.productId ? '<span class="chip" style="font-size:10px;">Product</span>' : '') + (k.skuId ? ' <span class="chip" style="font-size:10px;background:#fdfcf7;">Priced</span>' : '');
        function cell(v, extra) { return '<td style="padding:7px 10px;border-bottom:1px solid #f2f3ef;vertical-align:middle;' + (extra || '') + '">' + v + '</td>'; }
        return '<tr>' +
          cell('<code style="font-size:12.5px;color:#4a4f47;white-space:nowrap;">' + esc(k.part) + '</code>') +
          cell(admin ? txt(k.part, 'name', k.name) : '<span style="font-size:13px;" title="' + esc(k.name) + '">' + esc(k.name) + '</span>') +
          cell(admin ? (k.categoryOptions && itemState.categories.length ? sel(k.part, 'category', k.category, itemState.categories) : txt(k.part, 'category', k.category)) : '<span title="' + esc(k.category) + '">' + esc(k.category) + '</span>') +
          cell(admin ? txt(k.part, 'manufacturer', k.manufacturer) : '<span title="' + esc(k.manufacturer) + '">' + esc(k.manufacturer) + '</span>') +
          cell(admin ? txt(k.part, 'unitCostMinor', (Number(k.unitCostMinor) / 100).toFixed(2), NUM + 'background:#fdfcf7;border-color:#e4dfd0;') : '$' + (Number(k.unitCostMinor) / 100).toFixed(2), 'text-align:right;') +
          cell(admin ? txt(k.part, 'unitPriceMinor', (Number(k.unitPriceMinor) / 100).toFixed(2), NUM) : '$' + (Number(k.unitPriceMinor) / 100).toFixed(2), 'text-align:right;') +
          cell('<span style="font-size:13px;font-weight:600;color:' + (margin >= 0 ? '#2f7d5d' : '#9c3327') + ';">' + margin + '%</span>', 'text-align:right;') +
          cell(admin ? txt(k.part, 'weightLbs', k.weightLbs, NUM) : String(k.weightLbs), 'text-align:right;') +
          cell(where, 'white-space:nowrap;') + '</tr>';
      }).join('');
      var heads = [['Part #', 128], ['Product name', 0], ['Category', 210], ['Manufacturer', 200], ['Unit cost', 108], ['Unit price', 108], ['Margin', 78], ['Weight (lb)', 96], ['Record', 116]];
      var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 100)));
      box.innerHTML =
        '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow-x:auto;">' +
          '<table style="width:100%;min-width:1240px;border-collapse:collapse;font-size:14px;table-layout:fixed;">' +
          '<colgroup>' + heads.map(function (h) { return '<col' + (h[1] ? ' style="width:' + h[1] + 'px;"' : '') + '>'; }).join('') + '</colgroup>' +
          '<thead><tr>' + heads.map(function (h, i) {
            return '<th style="text-align:' + (i >= 4 && i <= 7 ? 'right' : 'left') + ';padding:10px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #e7e8e3;white-space:nowrap;">' + h[0] + '</th>';
          }).join('') + '</tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="9" style="padding:28px;text-align:center;color:#8a8f85;">Nothing in the catalog yet. Import a sheet or add a product.</td></tr>') + '</tbody></table></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;"><span>' + (d.total || 0) + ' items</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="itPrev" ' + (itemState.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + (d.page || 1) + ' of ' + totalPages + '</span><button id="itNext" ' + (itemState.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';
      var pv = document.getElementById('itPrev'), nx = document.getElementById('itNext');
      if (pv) pv.addEventListener('click', function () { if (itemState.page > 1) { itemState.page--; loadItems(user); } });
      if (nx) nx.addEventListener('click', function () { if (itemState.page < totalPages) { itemState.page++; loadItems(user); } });
      document.querySelectorAll('.itEdit').forEach(function (el) {
        el.addEventListener('change', async function () {
          var f = el.getAttribute('data-f'), part = el.getAttribute('data-part'), body = {};
          if (f === 'unitPriceMinor' || f === 'unitCostMinor') body[f] = d2m(el.value);
          else if (f === 'weightLbs') body[f] = parseFloat(el.value) || 0;
          else body[f] = el.value.trim();
          el.style.borderColor = '#c9a227';
          var r2 = await authed('/catalog/items/' + encodeURIComponent(part), { method: 'PATCH', body: body });
          el.style.borderColor = r2.ok ? '#3f9d78' : '#c2452f';
          if (!r2.ok) { var msg = ''; try { msg = (await r2.json()).message || ''; } catch (e3) {} alert('Could not save' + (msg ? ': ' + msg : ' (' + r2.status + ').')); }
          else if (f === 'unitCostMinor' || f === 'unitPriceMinor') loadItems(user);
          setTimeout(function () { el.style.borderColor = f === 'unitCostMinor' ? '#e4dfd0' : '#dcded7'; }, 900);
        });
      });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  async function renderCatalogProducts(user) {
    var admin = canCatalogAdmin(user.role);
    try { var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : []; } catch (e) { catCategories = []; }
    var statusOpts = '<option value="">All statuses</option>' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (cat.status === s ? ' selected' : '') + '>' + titleCase(s) + '</option>'; }).join('');
    document.getElementById('catBody').innerHTML =
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">' +
        '<input id="catSearch" placeholder="Search SKU or name…" value="' + esc(cat.q) + '" style="flex:1;min-width:220px;max-width:340px;padding:10px 13px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;outline:none;">' +
        '<select id="catStatus" style="padding:10px 12px;border:1px solid #dcded7;border-radius:10px;font-size:14px;background:#fff;">' + statusOpts + '</select>' +
        (admin ? '<div style="margin-left:auto;display:flex;gap:8px;"><button class="link-btn" id="catNewCat" style="width:auto;padding:10px 15px;">New category</button><button class="btn" id="catNew" style="width:auto;padding:10px 17px;">New product</button></div>' : '') +
      '</div>' +
      '<div id="catList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    var search = document.getElementById('catSearch'), t;
    search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { cat.q = search.value.trim(); cat.page = 1; loadProducts(user); }, 300); });
    document.getElementById('catStatus').addEventListener('change', function (e) { cat.status = e.target.value; cat.page = 1; loadProducts(user); });
    if (admin) {
      document.getElementById('catNew').addEventListener('click', function () { openProductForm(user); });
      document.getElementById('catNewCat').addEventListener('click', openCategoryForm);
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
      '<div style="font-size:12px;color:#8a8f85;margin-bottom:10px;">These prices &amp; weights feed the Adventure Series engine and the proposal builder. Edit a price or weight inline and it saves automatically.</div>' +
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
        return '<tr>' + td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(k.part) + '</code>') + td('<span style="font-size:13px;">' + esc(k.description) + '</span>') +
          td(esc(k.category)) + td(priceCell) + td(costCell) + td('<span style="font-size:13px;color:' + (marginPct >= 0 ? '#2f7d5d' : '#9c3327') + ';font-weight:600;">' + marginPct + '%</span>') + td(wtCell) +
          td(admin ? '<button class="skuDel" data-id="' + k.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 9px;font-size:12px;">Delete</button>' : '') + '</tr>';
      }).join('');
      var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 50)));
      box.innerHTML = tableShell(['Part #', 'Description', 'Category', 'Unit price', 'Unit cost', 'Margin', 'Weight (lb)', ''], rows, 8, 'No SKUs yet. Import a sheet or add one.') +
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
  function openSkuImport(user) {
    openModal('Import SKUs from Excel / CSV',
      '<div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.5;">Save your sheet as <b>CSV</b> with a header row of columns: <code>part, description, unitPrice, unitCost, weightLbs, category, manufacturer, proposalGroup</code>. Existing part #s are updated; new ones are added.</div>' +
      '<input type="file" id="skuFile" accept=".csv,text/csv" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">',
      async function (close, showErr) {
        var fi = document.getElementById('skuFile').files[0]; if (!fi) return showErr('Choose a CSV file first.');
        var text = await fi.text();
        var rows = parseCsv(text);
        if (!rows.length) return showErr('No data rows found in that file.');
        var r = await authed('/skus/import', { method: 'POST', body: { rows: rows } });
        if (!r.ok) return showErr('Import failed (' + r.status + ').');
        var d = await r.json();
        close(); alert('Import complete: ' + d.created + ' added, ' + d.updated + ' updated.'); refreshCatalogList(user);
      }, 'Import');
  }
  function parseCsv(text) {
    var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) return [];
    function splitLine(line) { var out = [], cur = '', q = false; for (var i = 0; i < line.length; i++) { var c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } } out.push(cur); return out; }
    var headers = splitLine(lines[0]).map(function (h) { return h.trim(); });
    return lines.slice(1).map(function (ln) { var cells = splitLine(ln); var o = {}; headers.forEach(function (h, i) { o[h] = (cells[i] || '').trim(); }); return o; });
  }

  async function loadProducts(user) {
    var box = document.getElementById('catList'); if (!box) return;
    var admin = canCatalogAdmin(user.role);
    var path = '/catalog/products?page=' + cat.page + '&pageSize=20' + (cat.q ? '&q=' + encodeURIComponent(cat.q) : '') + (cat.status ? '&status=' + cat.status : '');
    try {
      var r = await authed(path);
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var d = await r.json();
      var rows = (d.items || []).map(function (p) {
        var statusCell = admin
          ? '<select data-pid="' + p.id + '" class="rowStatus" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;">' + STATUSES.map(function (s) { return '<option value="' + s + '"' + (p.status === s ? ' selected' : '') + '>' + titleCase(s) + '</option>'; }).join('') + '</select>'
          : '<span class="chip">' + titleCase(p.status) + '</span>';
        return '<tr>' + td('<code style="font-size:13px;color:#4a4f47;">' + esc(p.sku) + '</code>') + td('<b style="font-weight:600;">' + esc(p.name) + '</b>') +
          td(esc(titleCase(p.kind))) + td(esc(catName(p.categoryId))) + td(statusCell) + '</tr>';
      }).join('');
      // reuse the CRM pager
      var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 20)));
      box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' +
        ['SKU', 'Name', 'Kind', 'Category', 'Status'].map(function (h) { return '<th style="text-align:left;padding:11px 16px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #eef0ea;background:#f7f8f4;">' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="5">No products yet.</td></tr>') + '</tbody></table></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;"><span>' + (d.total || 0) + ' total</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="cPrev" ' + (cat.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + (d.page || 1) + ' of ' + totalPages + '</span><button id="cNext" ' + (cat.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';
      var pv = document.getElementById('cPrev'), nx = document.getElementById('cNext');
      if (pv) pv.addEventListener('click', function () { if (cat.page > 1) { cat.page--; loadProducts(user); } });
      if (nx) nx.addEventListener('click', function () { if (cat.page < totalPages) { cat.page++; loadProducts(user); } });
      Array.prototype.forEach.call(document.querySelectorAll('.rowStatus'), function (sel) {
        sel.addEventListener('change', async function () {
          var r2 = await authed('/catalog/products/' + sel.getAttribute('data-pid') + '/status', { method: 'PATCH', body: { status: sel.value, reason: 'changed from workspace' } });
          if (!r2.ok) { alert('Could not change status (' + r2.status + ').'); loadProducts(user); }
        });
      });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }

  function openCategoryForm() {
    openModal('New category',
      fieldRow('Name', '<input id="cName" style="' + IN + '" required>') +
      fieldRow('Slug', '<input id="cSlug" placeholder="auto-generated" style="' + IN + '">') +
      fieldRow('Sort order', '<input id="cSort" type="number" value="0" style="' + IN + '">'),
      async function (close, showErr) {
        var name = document.getElementById('cName').value.trim();
        if (name.length < 2) return showErr('Name must be at least 2 characters.');
        var slug = document.getElementById('cSlug').value.trim() || slugify(name);
        var body = { name: name, slug: slug, sortOrder: parseInt(document.getElementById('cSort').value, 10) || 0, isActive: true };
        var r = await authed('/catalog/categories', { method: 'POST', body: body });
        if (r.status === 409) return showErr('That slug already exists — try another.');
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close();
        var rc = await authed('/catalog/categories'); catCategories = rc.ok ? await rc.json() : catCategories;
      });
    var n = document.getElementById('cName'); if (n) n.addEventListener('input', function () { var sl = document.getElementById('cSlug'); if (sl && !sl.dataset.touched) sl.value = slugify(n.value); });
    var sl2 = document.getElementById('cSlug'); if (sl2) sl2.addEventListener('input', function () { sl2.dataset.touched = '1'; });
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

  /* --- shared table helpers --- */
  function tableShell(head, rows, cols, empty) {
    return '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' +
      head.map(function (h) { return '<th style="text-align:left;padding:11px 16px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8f85;font-weight:600;border-bottom:1px solid #eef0ea;background:#f7f8f4;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + (rows || '<tr><td style="padding:22px 16px;color:#909689;" colspan="' + cols + '">' + esc(empty || 'No records.') + '</td></tr>') + '</tbody></table></div>';
  }
  function sectionBlock(title, inner) { return '<div class="section-title">' + esc(title) + '</div>' + inner; }

  /* --- Proposals --- */
  var OPEN_STATUSES = ['DRAFT', 'INTERNAL_REVIEW', 'RELEASED'];
  var props = { rows: [], sort: { key: 'modified', dir: 'desc' }, filter: 'all', q: '' };
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
          '<input id="propSearch" placeholder="Search customer, title, number…" value="' + esc(props.q) + '" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13.5px;background:#fff;width:240px;">' +
          (hasRole(PROP_WRITE, user.role) ? '<button class="btn" id="propNew" style="width:auto;padding:10px 17px;white-space:nowrap;">New proposal</button>' : '') +
        '</div></div>' +
      '<div id="propList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    drawPropFilters(user);
    if (hasRole(PROP_WRITE, user.role)) document.getElementById('propNew').addEventListener('click', function () { openProposalForm(user); });
    var s = document.getElementById('propSearch');
    s.addEventListener('input', function () { props.q = s.value; drawProposals(user); });
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
      b.addEventListener('click', function () { props.filter = b.getAttribute('data-f'); drawPropFilters(user); drawProposals(user); });
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
    var body = rows.map(function (r) {
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
        td('<b style="font-weight:600;">' + esc(r.customer) + '</b>' + (r.contact ? '<div class="muted" style="font-size:12px;">' + esc(r.contact) + '</div>' : '')) +
        td('<b style="font-weight:600;">' + esc(r.title) + '</b><div class="muted" style="font-size:12px;">' + esc(r.number) + (r.preparedBy ? ' · ' + esc(r.preparedBy) : '') + '</div>') +
        '<td style="padding:12px 14px;border-bottom:1px solid #f2f3ef;text-align:center;">v' + r.version + (r.versionCount > 1 ? '<div class="muted" style="font-size:11px;">of ' + r.versionCount + '</div>' : '') + '</td>' +
        td(statusChip(r.status)) + td(fmtDate(r.created)) + td(fmtDate(r.modified)) + td(expCell) +
        '<td style="padding:8px 14px;border-bottom:1px solid #f2f3ef;text-align:right;">' + quick + '</td></tr>';
    }).join('');
    box.innerHTML = '<div style="background:#fbfbf9;border:1px solid #e7e8e3;border-radius:14px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr>' + head + '</tr></thead><tbody>' +
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
    var actions = proposalActions(latest, user);
    view.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;"><button class="link-btn" id="propBack" style="width:auto;padding:7px 13px;">‹ Back to proposals</button>' +
      (latest.status === 'DRAFT' && hasRole(PROP_WRITE, user.role) ? '<button class="btn" id="propBuild" style="width:auto;padding:9px 17px;">Build / edit proposal</button>' : '<button class="link-btn" id="propPreview" style="width:auto;padding:8px 15px;">Preview</button>') + '</div>' +
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;"><div><div class="k">' + esc(p.number || '') + '</div><h2 style="font-size:22px;margin-top:2px;">' + esc(p.title) + '</h2></div><span class="chip">' + titleCase(latest.status || 'DRAFT') + '</span></div></div>' +
      sectionBlock('Versions', tableShell(['Version', 'Status', 'Created', 'Frozen'], versions.map(function (v) { return '<tr>' + td('v' + v.version) + td('<span class="chip">' + titleCase(v.status) + '</span>') + td(fmtDate(v.createdAt)) + td(v.frozen ? 'Yes' : 'No') + '</tr>'; }).join(''), 4, '')) +
      (actions ? sectionBlock('Actions', '<div style="display:flex;gap:8px;flex-wrap:wrap;" id="propActions">' + actions + '</div>') : '');
    document.getElementById('propBack').addEventListener('click', function () { renderProposals(user); });
    var pbBtn = document.getElementById('propBuild'); if (pbBtn) pbBtn.addEventListener('click', function () { openBuilder(p, latest, user); });
    var pvBtn = document.getElementById('propPreview'); if (pvBtn) pvBtn.addEventListener('click', function () { previewProposal(p, latest); });
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
  function proposalActions(v, user) {
    var s = v.status || 'DRAFT', b = [];
    function btn(act, label, primary) { return '<button class="' + (primary ? 'btn' : 'link-btn') + '" data-act="' + act + '" data-vid="' + v.id + '" style="width:auto;padding:9px 15px;">' + label + '</button>'; }
    if (s === 'DRAFT') { if (hasRole(PROP_WRITE, user.role)) b.push(btn('submit-review', 'Submit for review')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Release', 1)); }
    else if (s === 'INTERNAL_REVIEW') { if (hasRole(PROP_REVIEW, user.role)) b.push(btn('return-draft', 'Return to draft')); if (hasRole(PROP_RELEASE, user.role)) b.push(btn('release', 'Release', 1)); }
    else if (s === 'RELEASED') { if (hasRole(PROP_REVIEW, user.role)) { b.push(btn('accept', 'Mark accepted', 1)); b.push(btn('reject', 'Reject')); b.push(btn('expire', 'Expire')); } }
    else if (s === 'ACCEPTED') { if (hasRole(ORDERS_MANAGE_ROLES, user.role)) b.push('<button class="btn" data-act="lock" data-vid="' + v.id + '" style="width:auto;padding:9px 15px;">Lock to operational order</button>'); }
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
  function uid() { return 'l' + Math.random().toString(36).slice(2, 9); }

  function normalizeLine(it) {
    return {
      ref: it.ref || uid(), lineType: it.lineType || (it.isNote ? 'NOTE' : 'PRODUCT'), kind: it.kind || 'INCLUDED',
      productId: it.productId || null, sku: it.sku || '', name: it.name || '', description: it.description || '',
      quantity: it.quantity == null ? 1 : it.quantity, rateMinor: it.rateMinor || 0, costEach: it.costEach || 0, weightEach: it.weightEach || 0, group: it.group || '',
      optional: !!it.optional,
      delivery: it.delivery || '', returnable: it.returnable || '', addlFreight: it.addlFreight || '', freightCalc: it.freightCalc || '',
      tpFreightMinor: it.tpFreightMinor || 0, tpFreightLabel: it.tpFreightLabel || '',
      showNotes: false,
    };
  }

  var pb = null; // active builder document

  function addDays(iso, n) { if (!iso) return ''; var d = new Date(iso + 'T00:00:00'); if (isNaN(d)) return ''; d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
  function formatOrgShipTo(org) {
    if (!org || !org.addresses || !org.addresses.length) return '';
    var a = org.addresses.filter(function (x) { return x.type === 'SHIPPING'; })[0] || org.addresses.filter(function (x) { return x.type === 'BILLING'; })[0] || org.addresses[0];
    if (!a) return '';
    var l2 = a.line2 ? a.line2 + '\n' : '';
    return a.line1 + '\n' + l2 + a.city + ', ' + a.region + ' ' + a.postalCode;
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
      title: proposal.title || '', number: proposal.number || '',
      meta: { contactName: meta.contactName || orgContact || '', shipTo: meta.shipTo || orgShipTo || '', billTo: meta.billTo || '', showTitle: meta.showTitle !== false, projectId: meta.projectId || importedProjectId || '', showProjectId: meta.showProjectId !== false, proposalDate: propDate, taxAmountMinor: meta.taxAmountMinor || 0, discountPct: meta.discountPct || 0, structureFreightMinor: meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0), matsFreightMinor: meta.matsFreightMinor || 0, expiration: meta.expiration || addDays(propDate, 7), footerNotes: footerNotes },
      lines: lines,
    };
    renderBuilder();
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
    var deposit = Math.round(total * 0.5);
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
        '<div class="field" style="margin-top:4px;"><label>Bill to</label><textarea id="mBill" rows="2" placeholder="Billing address" style="' + IN + 'resize:vertical;">' + esc(pb.meta.billTo || '') + '</textarea></div>' +
        '<div class="field" style="margin-top:4px;"><label>Ship to</label><textarea id="mShip" rows="2" style="' + IN + 'resize:vertical;">' + esc(pb.meta.shipTo) + '</textarea></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowTitle"' + (pb.meta.showTitle !== false ? ' checked' : '') + '> Show the proposal title on the customer proposal</label>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowProj"' + (pb.meta.showProjectId ? ' checked' : '') + '> Show Project ID on the customer proposal</label>' +
      '</div>' +
      // quick add
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px;"><div class="section-title" style="margin:0;">Add to proposal</div>' +
          '<button class="btn" id="bAdvSeries" style="width:auto;padding:9px 16px;background:#3d4a55;">⚙ Start from Adventure Series</button></div>' +
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
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:14px;"><span class="muted">Tax $</span><input id="mTax" style="width:100px;padding:5px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;" value="' + m2d(pb.meta.taxAmountMinor) + '"></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:14px;"><span class="muted">Structure Crating &amp; Freight $</span><input id="mStructFreight" style="width:100px;padding:5px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;" value="' + m2d(pb.meta.structureFreightMinor) + '"></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:14px;"><span class="muted">Mats &amp; Padding Freight $</span><input id="mMatsFreight" style="width:100px;padding:5px 8px;border:1px solid #dcded7;border-radius:7px;text-align:right;" value="' + m2d(pb.meta.matsFreightMinor) + '"></div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0 0;margin-top:6px;border-top:1px solid #e7e8e3;font-size:16px;font-weight:600;font-family:\'Newsreader\',serif;"><span>Total</span><span>' + fmtMoney(t.total, 'USD') + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:6px 0 0;font-size:14px;color:#3d4a55;font-weight:600;"><span>Deposit due (50%)</span><span>' + fmtMoney(t.deposit, 'USD') + '</span></div>' +
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
          '<button class="bToggleNotes" data-i="' + i + '" style="margin-top:6px;border:none;background:transparent;color:#3d4a55;font-size:11.5px;cursor:pointer;padding:0;font-weight:500;">' + (l.showNotes ? '− Hide delivery / freight notes' : (hasNotes ? '● Delivery / freight notes' : '+ Delivery / freight notes')) + '</button>' +
          notesPanel +
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
    var mst = document.getElementById('mShowTitle'); if (mst) mst.addEventListener('change', function () { pb.meta.showTitle = mst.checked; });
    var mb = document.getElementById('mBill'); if (mb) mb.addEventListener('input', function () { pb.meta.billTo = mb.value; });
    var me = document.getElementById('mExp'); if (me) me.addEventListener('input', function () { pb.meta.expiration = me.value; });
    var ms = document.getElementById('mShip'); if (ms) ms.addEventListener('input', function () { pb.meta.shipTo = ms.value; });
    var mtx = document.getElementById('mTax'); if (mtx) mtx.addEventListener('change', function () { pb.meta.taxAmountMinor = d2m(mtx.value); renderBuilder(); });
    var mdisc = document.getElementById('mDisc'); if (mdisc) mdisc.addEventListener('change', function () { pb.meta.discountPct = parseFloat(mdisc.value) || 0; renderBuilder(); });
    var msf = document.getElementById('mStructFreight'); if (msf) msf.addEventListener('change', function () { pb.meta.structureFreightMinor = d2m(msf.value); renderBuilder(); });
    var mmf = document.getElementById('mMatsFreight'); if (mmf) mmf.addEventListener('change', function () { pb.meta.matsFreightMinor = d2m(mmf.value); renderBuilder(); });
    // line field inputs
    document.querySelectorAll('.bF').forEach(function (el) {
      var handler = function () {
        var i = +el.getAttribute('data-i'), k = el.getAttribute('data-k'), l = pb.lines[i]; if (!l) return;
        if (k === 'rate') l.rateMinor = d2m(el.value);
        else if (k === 'cost') l.costEach = d2m(el.value);
        else if (k === 'tpFreight') l.tpFreightMinor = d2m(el.value);
        else if (k === 'quantity') l.quantity = parseFloat(el.value) || 0;
        else l[k] = el.value;
      };
      el.addEventListener('input', handler);
      var k = el.getAttribute('data-k');
      if (k === 'rate' || k === 'cost' || k === 'quantity' || k === 'tpFreight' || el.tagName === 'SELECT') el.addEventListener('change', renderBuilder);
    });
    document.querySelectorAll('.bChk').forEach(function (el) { el.addEventListener('change', function () { var l = pb.lines[+el.getAttribute('data-i')]; if (l) { l[el.getAttribute('data-k')] = el.checked; } }); });
    document.querySelectorAll('.bToggleNotes').forEach(function (b) { b.addEventListener('click', function () { var l = pb.lines[+b.getAttribute('data-i')]; if (l) { l.showNotes = !l.showNotes; renderBuilder(); } }); });
    document.querySelectorAll('.bDel').forEach(function (b) { b.addEventListener('click', function () { pb.lines.splice(+b.getAttribute('data-i'), 1); renderBuilder(); }); });
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

  async function openProductPicker() {
    var products = [];
    try { var r = await authed('/catalog/products?pageSize=100'); if (r.ok) products = (await r.json()).items || []; } catch (e) {}
    var listHtml = function (items) { return items.map(function (p) { return '<button type="button" class="pkRow" data-id="' + p.id + '" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid #f2f3ef;background:#fff;padding:10px 12px;cursor:pointer;font-size:13.5px;"><b style="font-weight:600;">' + esc(p.name) + '</b> <span class="muted" style="font-size:12px;">' + esc(p.sku) + '</span></button>'; }).join('') || '<div class="muted" style="padding:16px;">No products. Add some in Catalog first.</div>'; };
    openModal('Add product line',
      '<input id="pkSearch" placeholder="Search products…" style="' + IN + 'margin-bottom:10px;">' +
      '<div id="pkList" style="max-height:320px;overflow:auto;border:1px solid #e7e8e3;border-radius:10px;">' + listHtml(products) + '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:8px;">Rate is entered per proposal after adding.</div>',
      async function (close) { close(); }, 'Done');
    setTimeout(function () {
      var wire = function () { document.querySelectorAll('.pkRow').forEach(function (b) { b.addEventListener('click', function () {
        var p = products.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
        pb.lines.push({ ref: uid(), lineType: 'PRODUCT', kind: 'INCLUDED', productId: p.id, name: p.name, description: p.proposalDescription || '', quantity: 1, rateMinor: 0, group: '' });
        var form = document.getElementById('mForm'); if (form && form.parentNode && form.parentNode.parentNode) form.parentNode.parentNode.removeChild(form.parentNode);
        renderBuilder();
      }); }); };
      wire();
      var s = document.getElementById('pkSearch');
      if (s) s.addEventListener('input', function () { var q = s.value.toLowerCase(); var filtered = products.filter(function (p) { return (p.name + ' ' + p.sku).toLowerCase().indexOf(q) !== -1; }); document.getElementById('pkList').innerHTML = listHtml(filtered); wire(); });
    }, 50);
  }
  function builderDoc() {
    return { title: pb.title, number: pb.number, orgName: pb.orgName, meta: pb.meta, lines: pb.lines, totals: builderTotals() };
  }

  async function saveBuilder() {
    var btn = document.getElementById('bSave'); btn.disabled = true; btn.textContent = 'Saving…';
    var sections = [{ id: 'meta', type: 'CUSTOMER_INFO', title: 'Proposal', order: 0, enabled: true, data: pb.meta }];
    var items = pb.lines.map(function (l, i) { return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, costEach: Number(l.costEach) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i }; });
    try {
      var r = await authed('/proposals/versions/' + pb.versionId, { method: 'PATCH', body: { sections: sections, items: items, expirationDate: pb.meta.expiration || undefined } });
      if (!r.ok) { alert('Could not save (' + r.status + ').'); btn.disabled = false; btn.textContent = 'Save proposal'; return; }
      btn.textContent = 'Saved ✓';
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
    previewProposalDoc({ title: proposal.title, number: proposal.number, orgName: orgName, meta: meta, lines: lines, totals: { subtotal: subtotal, discountPct: discountPct, discount: discount, tpFreight: tpFreight, tax: tax, structureFreight: structureFreight, matsFreight: matsFreight, total: total, deposit: Math.round(total * 0.5), weight: weight } });
  }

  function previewProposalDoc(doc) {
    ensurePrintStyle();
    var d = doc, m = d.meta || {}, t = d.totals || {};
    // Tax and freight are frequently unknown when a proposal goes out. Showing a
    // hard $0.00 reads as "free"; TBD states the truth.
    var TBD = '<span style="color:#8a8f85;font-weight:600;">TBD</span>';
    var anyTbd = !t.tax || !t.structureFreight || !t.matsFreight;
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
      '<div style="margin-top:12px;font-size:11.5px;line-height:1.55;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:3px;">Proposal Prepared By</div>' +
        '<div style="font-weight:600;">' + esc(u.name || u.email || '') + '</div>' +
        (preparerLine2 ? '<div style="color:#5c6157;">' + esc(preparerLine2) + '</div>' : '') +
        (u.email ? '<div style="color:#5c6157;">' + esc(u.email) + '</div>' : '') +
      '</div>';
    var html =
      '<div id="propPrintArea" style="max-width:760px;margin:0 auto;background:#fff;padding:44px 48px;font-family:\'IBM Plex Sans\',sans-serif;color:#20241f;">' +
        '<div style="border-bottom:2px solid #3d4a55;padding-bottom:16px;margin-bottom:20px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;">' +
          '<div style="display:flex;flex-direction:column;">' +
          '<div style="display:flex;gap:14px;align-items:center;"><img src="logo.png" alt="Summit Sensory Gym" width="84" height="84" style="width:84px;height:84px;display:block;"><div><div style="font-family:\'Newsreader\',serif;font-weight:600;font-size:19px;">Summit Sensory Gym</div><div style="font-size:11px;color:#8a8f85;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111<br>(720) 457-5500 · Sales@SummitSensory.com</div></div></div>' + preparedBy + '</div>' +
          '<div style="text-align:right;"><div style="font-family:\'Newsreader\',serif;font-size:22px;font-weight:600;">Proposal</div><div style="font-size:11.5px;color:#5c6157;margin-top:4px;">' + esc(d.number || '') + '</div>' +
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
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Tax</span><span>' + (t.tax ? fmtMoney(t.tax, 'USD') : TBD) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Structure Crating &amp; Freight</span><span>' + (t.structureFreight ? fmtMoney(t.structureFreight, 'USD') : TBD) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Mats &amp; Padding Freight</span><span>' + (t.matsFreight ? fmtMoney(t.matsFreight, 'USD') : TBD) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:8px;margin-top:5px;border-top:2px solid #3d4a55;font-size:15px;font-weight:700;"><span>Total</span><span>' + fmtMoney(t.total, 'USD') + '</span></div>' +
          (anyTbd ? '<div style="padding:2px 8px 0;font-size:10px;color:#8a8f85;text-align:right;line-height:1.5;">Total excludes items marked TBD.</div>' : '') +
          '<div style="display:flex;justify-content:space-between;padding:6px 8px 0;font-size:13px;color:#3d4a55;font-weight:700;"><span>Deposit Due (50%)</span><span>' + fmtMoney(t.deposit, 'USD') + '</span></div>' +
        '</div></div>' + bottomNotesHtml +
        '<div style="display:flex;gap:40px;margin-top:40px;padding-top:14px;">' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Name</div></div>' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Signature</div></div>' +
          '<div style="flex:0 0 150px;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Date</div></div>' +
        '</div>' + footerNotesHtml +
      '</div>';
    var ov = document.createElement('div');
    ov.id = 'propPreviewOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:#e7e8e3;z-index:60;overflow:auto;padding:24px 16px;';
    ov.innerHTML = '<div class="noprint" style="max-width:760px;margin:0 auto 14px;display:flex;justify-content:space-between;gap:10px;"><button class="link-btn" id="pvClose" style="width:auto;padding:9px 16px;background:#fff;">‹ Close preview</button><button class="btn" id="pvPrint" style="width:auto;padding:9px 20px;">Print / Save PDF</button></div>' + html;
    document.body.appendChild(ov);
    document.getElementById('pvClose').addEventListener('click', function () { document.body.removeChild(ov); });
    document.getElementById('pvPrint').addEventListener('click', function () { window.print(); });
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
  function legsFor(len) { len = Number(len) || 0; if (len <= 10) return 4; if (len <= 20) return 6; return 8; }
  function _xlfnPrefix(config) { return config === 'Square' ? 'SQ-' : config === 'L-Shape' ? 'L-' : config === 'T-Shape' ? 'T-' : 'R-'; }
  var adv = null;
  function openAdventureConfigurator() {
    adv = {
      length: 20, width: 10, config: 'Rectangle', legs: 6, legsAuto: true,
      monkeyBars: false, monkeyBarsQty: 1, ladders: false, laddersQty: 1, ladderShield: false,
      trolley: false, trolleyType: 'Dual', interiorBeams: false, interiorBeamsQty: 1,
      zipLine: false, zipLineQty: 1, ballRack: false,
      slide: false, slideGray: false, steamroller: false,
      climbFrame: false, climbWall: false, climbShield: false, climbMat: false,
      matFloor: false, matColumn: false, uShaped: 0, completeWrap: 0, matLadderLeg: false, matCustom: false,
      brackets: false, bracketsQty: 4, swivel360: 4, swivelStandalone: 0, forged: 12, swingHanger: 0, vRings: 0, carabiner: 0, webbingSling: 6,
    };
    adv.legs = legsFor(adv.length); adv.webbingSling = adv.legs;
    var ov = document.createElement('div');
    ov.id = 'advOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(32,36,31,.4);z-index:70;overflow:auto;padding:24px 16px;';
    document.body.appendChild(ov);
    renderAdv();
  }
  function advClose() { var o = document.getElementById('advOverlay'); if (o) document.body.removeChild(o); }
  function climbWalls() { return (adv.climbFrame ? 1 : 0) + (adv.climbWall ? 1 : 0); }
  function eyeboltSum() { var nonSwivel = Math.max(0, (Number(adv.bracketsQty) || 0) - (Number(adv.swivel360) || 0)); return (Number(adv.swivel360) || 0) + nonSwivel + (Number(adv.forged) || 0) + (Number(adv.swingHanger) || 0); }

  function renderAdv() {
    var o = document.getElementById('advOverlay'); if (!o) return;
    var nonSwivel = Math.max(0, (Number(adv.bracketsQty) || 0) - (Number(adv.swivel360) || 0));
    var carabRec = Math.ceil(eyeboltSum() / 4);
    function sec(title, inner) { return '<div style="margin-bottom:18px;"><div style="font-family:\'Newsreader\',serif;font-size:16px;font-weight:600;color:#3d4a55;border-bottom:1px solid #e7e8e3;padding-bottom:6px;margin-bottom:12px;">' + title + '</div>' + inner + '</div>'; }
    function num(key, label, min, max, extra) { return '<div class="af" style="' + (extra || '') + '"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">' + label + '</label><input type="number" data-ak="' + key + '" value="' + adv[key] + '"' + (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') + ' style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;"></div>'; }
    function tog(key, label, hint) { return '<label style="display:flex;align-items:center;gap:9px;padding:8px 0;cursor:pointer;font-size:14px;border-bottom:1px solid #f2f3ef;"><input type="checkbox" data-ak="' + key + '"' + (adv[key] ? ' checked' : '') + ' style="width:17px;height:17px;flex:0 0 auto;"><span style="flex:1;"><b style="font-weight:600;">' + label + '</b>' + (hint ? '<span class="muted" style="font-size:12px;display:block;">' + hint + '</span>' : '') + '</span></label>'; }
    function sel(key, label, opts) { return '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px;">' + label + '</label><select data-ak="' + key + '" style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;background:#fff;">' + opts.map(function (op) { return '<option value="' + op + '"' + (String(adv[key]) === String(op) ? ' selected' : '') + '>' + op + '</option>'; }).join('') + '</select></div>'; }
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
          sec('Frame Configuration', '<div style="' + grid + '">' + sel('config', 'Configuration (manual)', ['Rectangle', 'Square', 'L-Shape', 'T-Shape']) + num('legs', '# of Frame Legs (auto, editable)', 0, 20) + '</div>' +
            '<div class="muted" style="font-size:11.5px;margin-top:6px;">Suggested: ' + (adv.length === adv.width ? 'Square' : 'Rectangle') + ' · legs auto-set from length (' + legsFor(adv.length) + ')</div>') +
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
            tog('matFloor', 'Adventure Mat System — Floor', 'Mat SKU logic to be provided — added as manual line') +
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
              num('forged', '# 1/2" Forged Eye Bolts (×6)', 0, 36) +
              num('swivelStandalone', '# Swing &amp; Swivel Eye Bolt (stand-alone)', 0, 24) +
              num('swingHanger', '# Swing Hanger w/ Bearing (×2)', 0, 12) +
              num('vRings', '# V-Rings (10-pack)', 0, 3) +
              '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;margin-bottom:4px;">Auto-Locking Carabiner (4pk)</label><input type="number" data-ak="carabiner" value="' + adv.carabiner + '" min="0" max="8" style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;"><span class="muted" style="font-size:11px;">Recommended: ' + carabRec + '</span></div>' +
              num('webbingSling', 'Multi-Pocket Webbing Sling (def = legs)', 0, 16) +
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
    document.getElementById('advGen').addEventListener('click', function () { generateAdvLines(document.getElementById('advReplace').checked); });
    document.getElementById('advTrace').addEventListener('click', openAdvTrace);
    o.querySelectorAll('[data-ak]').forEach(function (el) {
      var k = el.getAttribute('data-ak');
      if (el.type === 'checkbox') { el.addEventListener('change', function () { adv[k] = el.checked; syncAdvDefaults(k); renderAdv(); }); }
      else {
        el.addEventListener('input', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; });
        el.addEventListener('change', function () { adv[k] = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value; syncAdvDefaults(k); renderAdv(); });
      }
    });
  }
  function syncAdvDefaults(changed) {
    if (changed === 'length') { adv.legs = legsFor(adv.length); if (!adv.matColumn) adv.webbingSling = adv.legs; adv.webbingSling = adv.legs; }
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
      matFloor: !!adv.matFloor, matColumn: !!adv.matColumn, uShaped: Number(adv.uShaped), completeWrap: Number(adv.completeWrap), matLadderLeg: !!adv.matLadderLeg, matCustom: !!adv.matCustom,
      brackets: !!adv.brackets, bracketsQty: Number(adv.bracketsQty), swivel360: Number(adv.swivel360), swivelStandalone: Number(adv.swivelStandalone), forged: Number(adv.forged), swingHanger: Number(adv.swingHanger), vRings: Number(adv.vRings), carabiner: Number(adv.carabiner), webbingSling: Number(adv.webbingSling),
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
        '<td style="padding:4px 8px;border-bottom:1px solid #eef0ea;font-size:11.5px;">' + esc(c.name) + (c.inCatalog ? '' : ' <span style="color:#9c3327;font-size:10.5px;">no SKU record</span>') + '</td>' +
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
      });
    });
    if (replace) pb.lines = out; else pb.lines = pb.lines.concat(out);
    advClose(); renderBuilder();
    var bl = document.getElementById('bLines'); if (bl) bl.scrollIntoView({ block: 'start' });
  }
  function rangeArr(a, b) { var r = []; for (var i = a; i <= b; i++) r.push(i); return r; }

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
        if (!r.ok) return showErr('Could not lock order (' + r.status + ').');
        close(); alert('Operational order created.');
        var nb = document.querySelector('[data-view="orders"]'); if (nb) nb.click();
      }, 'Lock order');
  }

  /* --- Orders & Handoff --- */
  async function renderOrders(user) {
    document.getElementById('view').innerHTML = '<div id="ordList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    try {
      var r = await authed('/orders'); if (!r.ok) { document.getElementById('ordList').innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var list = await r.json();
      var rows = (list || []).map(function (o) {
        return '<tr style="cursor:pointer;" data-id="' + o.id + '">' + td('<b style="font-weight:600;">' + esc(o.number) + '</b>') + td('<span class="chip">' + titleCase(o.status) + '</span>') + td(fmtMoney(o.grandTotalMinor, o.currency)) + td(o.depositRequired ? fmtMoney(o.depositDueMinor, o.currency) : '—') + td(fmtDate(o.createdAt)) + '</tr>';
      }).join('');
      document.getElementById('ordList').innerHTML = tableShell(['Order', 'Status', 'Total', 'Deposit', 'Created'], rows, 5, 'No operational orders yet. Lock an accepted proposal to create one.');
      document.querySelectorAll('#ordList tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { openOrderDetail(tr.getAttribute('data-id'), user); }); });
    } catch (e) { document.getElementById('ordList').innerHTML = '<div class="err">Could not reach the server.</div>'; }
  }
  async function openOrderDetail(id, user) {
    var view = document.getElementById('view'); view.innerHTML = '<div class="muted" style="padding:24px;">Loading…</div>';
    var order, st, audit;
    try {
      var r1 = await authed('/orders/' + id); order = await r1.json();
      var r2 = await authed('/orders/' + id + '/status'); st = r2.ok ? await r2.json() : {};
      var r3 = await authed('/orders/' + id + '/audit'); audit = r3.ok ? await r3.json() : [];
    } catch (e) { view.innerHTML = '<div class="err">Could not load order.</div>'; return; }
    var canHandoff = hasRole(HANDOFF_ROLES, user.role);
    var integ = st.integrity || {};
    view.innerHTML =
      '<button class="link-btn" id="ordBack" style="width:auto;padding:7px 13px;margin-bottom:16px;">‹ Back to orders</button>' +
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;"><div><div class="k">' + esc(order.number) + '</div><h2 style="font-size:22px;margin-top:2px;">Operational order</h2><div class="muted" style="font-size:13px;margin-top:4px;">Accepted proposal v' + (order.acceptedVersion || '') + '</div></div>' +
        '<div style="text-align:right;"><span class="chip">' + titleCase(order.status) + '</span><div style="margin-top:8px;font-size:13px;">' + (integ.ok ? '<span class="dot ok"></span>Integrity verified' : '<span class="dot bad"></span>Integrity drift') + '</div></div></div>' +
        '<div class="grid" style="margin-top:16px;"><div><div class="k">Total</div><div class="v small">' + fmtMoney(order.grandTotalMinor, order.currency) + '</div></div>' +
        '<div><div class="k">Deposit</div><div class="v small">' + (order.depositRequired ? fmtMoney(order.depositDueMinor, order.currency) : '—') + '</div></div>' +
        '<div><div class="k">Customer approval</div><div class="v small">' + (order.customerApproval ? esc(order.customerApproval.approverName) : '—') + '</div></div></div></div>' +
      sectionBlock('Requirements', reqRows(order.requirements || [], canHandoff)) +
      sectionBlock('Internal tasks', taskRows(order.tasks || [], canHandoff)) +
      sectionBlock('Procurement', procRows(order.procurement || [])) +
      sectionBlock('Audit timeline', auditRows(audit));
    document.getElementById('ordBack').addEventListener('click', function () { renderOrders(user); });
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
  function reqRows(reqs, edit) {
    var rows = reqs.map(function (r) {
      var cell = edit ? hoStatusSelect('req', r.id, ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE', 'WAIVED'], r.status) : '<span class="chip">' + titleCase(r.status) + '</span>';
      return '<tr>' + td(esc(titleCase(r.category))) + td(esc(r.title)) + td(cell) + td(r.isException ? '<span class="chip" style="background:#fbecea;color:#9c3327;">Exception</span>' : '—') + '</tr>';
    }).join('');
    return tableShell(['Category', 'Requirement', 'Status', 'Flag'], rows, 4, 'No requirements.');
  }
  function taskRows(tasks, edit) {
    var rows = tasks.map(function (t) {
      var cell = edit ? hoStatusSelect('task', t.id, ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], t.status) : '<span class="chip">' + titleCase(t.status) + '</span>';
      return '<tr>' + td('<b style="font-weight:600;">' + esc(t.title) + '</b>') + td(esc(t.assigneeRole ? titleCase(t.assigneeRole) : 'Unassigned')) + td(cell) + td(t.dueDate ? fmtDate(t.dueDate) : '—') + '</tr>';
    }).join('');
    return tableShell(['Task', 'Owner', 'Status', 'Due'], rows, 4, 'No tasks.');
  }
  function procRows(lines) {
    var rows = lines.map(function (p) { return '<tr>' + td('<b style="font-weight:600;">' + esc(p.name) + '</b>') + td(String(p.quantity)) + td(esc(p.vendor || '—')) + td(p.sourced ? '<span class="chip">Sourced</span>' : '<span class="muted">Pending</span>') + '</tr>'; }).join('');
    return tableShell(['Item', 'Qty', 'Vendor', 'Sourcing'], rows, 4, 'No procurement lines.');
  }
  function auditRows(events) {
    if (!events || !events.length) return '<div class="placeholder" style="padding:20px;"><p class="muted" style="margin:0;">No events recorded.</p></div>';
    return '<div class="card">' + events.map(function (e, i) { return '<div style="display:flex;gap:12px;padding:' + (i ? '10px' : '0') + ' 0 0;border-top:' + (i ? '1px solid #f2f3ef;margin-top:10px;' : 'none;') + 'font-size:13.5px;"><span style="color:#8a8f85;min-width:150px;">' + fmtDate(e.at) + '</span><span style="font-weight:500;">' + esc(e.action) + '</span></div>'; }).join('') + '</div>';
  }

  /* --- Admin --- */
  async function renderAdmin(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:flex-end;margin-bottom:16px;"><button class="btn" id="admNew" style="width:auto;padding:10px 17px;">New user</button></div>' +
      '<div id="admList"><div class="muted" style="padding:24px;">Loading…</div></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:26px;"><div class="section-title" style="margin:0;">Standard proposal notes</div>' +
        '<button class="btn" id="snNew" style="width:auto;padding:9px 15px;">+ New note</button></div>' +
      '<div class="muted" style="font-size:12.5px;margin:6px 0 10px;">Reusable note blocks for proposals. “Always include” notes are added to every new proposal automatically. Table notes print inside the line items; footer notes print below the signature lines. Wrap text in **double asterisks** to bold it.</div>' +
      '<div id="snList"><div class="muted" style="padding:16px;">Loading…</div></div>';
    document.getElementById('admNew').addEventListener('click', openUserForm);
    document.getElementById('snNew').addEventListener('click', function () { openStandardNoteForm(null); });
    loadUsers();
    loadStandardNotes();
  }
  async function loadStandardNotes() {
    var box = document.getElementById('snList'); if (!box) return;
    try {
      var r = await authed('/standard-notes');
      if (!r.ok) { box.innerHTML = '<div class="err">Could not load standard notes (' + r.status + '). Run the 0019 migration if this persists.</div>'; return; }
      var notes = await r.json();
      var rows = (notes || []).map(function (n) {
        return '<tr>' + td('<b style="font-weight:600;">' + esc(n.title) + '</b><div class="muted" style="font-size:12px;max-width:520px;line-height:1.45;">' + esc(String(n.body).slice(0, 160)) + (String(n.body).length > 160 ? '…' : '') + '</div>') +
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
      '<div class="field"><label>Note text</label><textarea id="snBody" rows="6" style="' + IN + 'resize:vertical;">' + esc(n.body) + '</textarea>' +
        '<div class="muted" style="font-size:11.5px;margin-top:3px;">**bold** · *italic* · line breaks are kept</div></div>' +
      fieldRow('Where it prints', '<select id="snPlace" style="' + IN + '"><option value="TABLE"' + (n.placement === 'TABLE' ? ' selected' : '') + '>Inside the line items</option><option value="FOOTER"' + (n.placement === 'FOOTER' ? ' selected' : '') + '>Below the signature lines</option></select>') +
      fieldRow('Order', '<input id="snOrder" type="number" style="' + IN + '" value="' + (Number(n.sortOrder) || 0) + '">') +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0;cursor:pointer;"><input type="checkbox" id="snAuto"' + (n.autoInclude ? ' checked' : '') + '> Always include on new proposals</label>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;"><input type="checkbox" id="snActive"' + (n.active !== false ? ' checked' : '') + '> Available in the builder</label>',
      async function (close, showErr) {
        var body = {
          title: document.getElementById('snTitle').value.trim(),
          body: document.getElementById('snBody').value.trim(),
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
          td(u.isActive ? '<button class="link-btn" data-deact="' + u.id + '" style="width:auto;padding:6px 11px;">Deactivate</button>' : '') + '</tr>';
      }).join('');
      box.innerHTML = tableShell(['Name', 'Email', 'Role', 'Status', ''], rows, 5, 'No users.');
      document.querySelectorAll('.roleSel').forEach(function (sel) { sel.addEventListener('change', async function () { var r2 = await authed('/admin/users/' + sel.getAttribute('data-id') + '/role', { method: 'PATCH', body: { role: sel.value } }); if (!r2.ok) { alert('Could not change role (' + r2.status + ').'); loadUsers(); } }); });
      document.querySelectorAll('[data-deact]').forEach(function (bt) { bt.addEventListener('click', async function () { if (!confirm('Deactivate this user?')) return; var r2 = await authed('/admin/users/' + bt.getAttribute('data-deact') + '/deactivate', { method: 'PATCH', body: {} }); if (!r2.ok) alert('Could not deactivate.'); loadUsers(); }); });
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
        if (!r.ok) return showErr('Could not create (' + r.status + ').');
        close(); loadUsers();
      });
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
    if (!tokens().at && !tokens().rt) { renderLogin(); return; }
    try { var r = await authed('/auth/me'); if (r.ok) { renderShell(await r.json()); return; } clearTokens(); renderLogin(); }
    catch (e) { renderLogin('Could not reach the server. Is it running?'); }
  }
  boot();
})();

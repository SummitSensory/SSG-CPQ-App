/* Summit Sensory CPQ — web client.
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
        '<div style="text-align:center;margin-bottom:22px;"><div class="login-logo"></div><div class="login-brandname">Summit Sensory Gym</div><div class="login-brandsub">CPQ Workspace</div></div>' +
        '<h1>Welcome back</h1>' +
        '<div class="login-sub">Sign in to the CPQ workspace.</div>' +
        (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>' +
        '<button class="btn" type="submit" id="submitBtn">Sign in</button>' +
        '<div class="hint">Summit Sensory Group · Configure-Price-Quote</div>' +
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
  }

  function brandHtml() {
    return '<div class="brand"><div class="brand-mark"></div><div class="brand-name"><b>Summit Sensory</b><span>CPQ Workspace</span></div></div>';
  }

  /* --- Shell --- */
  var NAV = [
    { id: 'dashboard', label: 'Dashboard', ready: true, roles: '*' },
    { id: 'crm', label: 'CRM', ready: true, roles: '*' },
    { id: 'catalog', label: 'Catalog', ready: true, roles: '*' },
    { id: 'proposals', label: 'Proposals', ready: true, roles: '*' },
    { id: 'orders', label: 'Orders & Handoff', ready: true, roles: '*' },
    { id: 'admin', label: 'Administration', ready: true, roles: ['SYSTEM_ADMIN'] },
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
            '<button class="link-btn" id="logoutBtn">Sign out</button>' +
            '<div style="text-align:center;font-size:10px;color:#b3b7ac;margin-top:8px;letter-spacing:.04em;">build 2 · proposal builder</div></div>' +
        '</aside>' +
        '<main class="main"><div class="topbar"><div class="eyebrow">Workspace</div><h2 id="viewTitle">Dashboard</h2></div>' +
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
      else if (id === 'orders') renderOrders(user);
      else if (id === 'admin') renderAdmin(user);
      else renderSoon(item.label);
    });
    document.getElementById('logoutBtn').addEventListener('click', logout);
    renderDashboard(user);
  }

  async function renderDashboard(user) {
    document.getElementById('view').innerHTML =
      '<div class="grid">' +
        '<div class="card"><div class="k">Signed in as</div><div class="v small">' + esc(user.name || user.email) + '</div><div class="muted" style="font-size:12.5px;margin-top:4px;">' + esc(user.email) + '</div></div>' +
        '<div class="card"><div class="k">Your role</div><div class="v small"><span class="chip">' + esc(roleLabel(user.role)) + '</span></div></div>' +
        '<div class="card"><div class="k">API status</div><div class="v small" id="apiStatus"><span class="dot wait"></span>Checking…</div></div>' +
        '<div class="card"><div class="k">Workspace</div><div class="v small">Summit Sensory CPQ</div><div class="muted" style="font-size:12.5px;margin-top:4px;">Milestones 1–12 live</div></div>' +
      '</div>' +
      '<div class="section-title">Get started</div>' +
      '<div class="placeholder"><h3>Your modules are being connected</h3>' +
        '<p>All modules are live — CRM, Catalog, Proposals, and Orders &amp; Handoff. Use the sidebar to navigate.</p></div>';
    try { var r = await fetch('/health'); var el = document.getElementById('apiStatus'); if (el) el.innerHTML = r.ok ? '<span class="dot ok"></span>Online' : '<span class="dot bad"></span>Error ' + r.status; }
    catch (e) { var el2 = document.getElementById('apiStatus'); if (el2) el2.innerHTML = '<span class="dot bad"></span>Offline'; }
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
        (writable ? '<button class="btn" id="crmNew" style="width:auto;padding:10px 17px;">' + newLabel + '</button>' : '') +
      '</div>' +
      '<div id="crmList"><div class="muted" style="padding:24px;">Loading…</div></div>';

    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { crm.tab = b.getAttribute('data-tab'); crm.q = ''; crm.page = 1; renderCrm(user); });
    });
    var search = document.getElementById('crmSearch');
    var t; search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { crm.q = search.value.trim(); crm.page = 1; loadCrm(); }, 300); });
    if (writable) document.getElementById('crmNew').addEventListener('click', function () { crm.tab === 'orgs' ? openOrgForm() : openOppForm(); });
    loadCrm();
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
  var cat = { q: '', status: '', page: 1, tab: 'products' };
  var catCategories = [];
  var KINDS = ['PRODUCT', 'VARIANT', 'COMPONENT', 'BUNDLE', 'ACCESSORY', 'SERVICE'];
  var STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];
  function catName(id) { var c = catCategories.filter(function (x) { return x.id === id; })[0]; return c ? c.name : '—'; }
  function slugify(s) { return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  function renderCatalog(user) {
    function ctab(id, label){var on=cat.tab===id;return '<button data-ctab="'+id+'" style="border:none;border-radius:8px;padding:8px 15px;font-size:13.5px;font-weight:'+(on?'600':'500')+';cursor:pointer;background:'+(on?'#fff':'transparent')+';color:'+(on?'#1c4039':'#6b7065')+';box-shadow:'+(on?'0 1px 2px rgba(0,0,0,.06)':'none')+';">'+label+'</button>';}
    document.getElementById('view').innerHTML = '<div style="display:flex;gap:5px;background:#eef0ea;padding:4px;border-radius:10px;width:max-content;margin-bottom:18px;">'+ctab('products','Products')+ctab('skus','Pricing &amp; SKUs')+'</div><div id="catBody"></div>';
    document.querySelectorAll('[data-ctab]').forEach(function(b){b.addEventListener('click',function(){cat.tab=b.getAttribute('data-ctab');renderCatalog(user);});});
    if(cat.tab==='skus') renderSkus(user); else renderCatalogProducts(user);
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
        var wtCell = admin
          ? '<input class="skuEdit" data-id="' + k.id + '" data-f="weightLbs" value="' + k.weightLbs + '" style="width:70px;padding:5px 7px;border:1px solid #dcded7;border-radius:6px;text-align:right;font-size:13px;">'
          : k.weightLbs;
        return '<tr>' + td('<code style="font-size:12.5px;color:#4a4f47;">' + esc(k.part) + '</code>') + td('<span style="font-size:13px;">' + esc(k.description) + '</span>') +
          td(esc(k.category)) + td(priceCell) + td(wtCell) +
          td(admin ? '<button class="skuDel" data-id="' + k.id + '" style="border:1px solid #e0e1db;background:#fff;border-radius:7px;color:#9c3327;cursor:pointer;padding:4px 9px;font-size:12px;">Delete</button>' : '') + '</tr>';
      }).join('');
      var totalPages = Math.max(1, Math.ceil((d.total || 0) / (d.pageSize || 50)));
      box.innerHTML = tableShell(['Part #', 'Description', 'Category', 'Unit price', 'Weight (lb)', ''], rows, 6, 'No SKUs yet. Import a sheet or add one.') +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#82877d;font-size:13px;"><span>' + (d.total || 0) + ' SKUs</span>' +
        '<span style="display:flex;gap:8px;align-items:center;"><button id="skuPrev" ' + (skuState.page <= 1 ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Prev</button><span>Page ' + (d.page || 1) + ' of ' + totalPages + '</span><button id="skuNext" ' + (skuState.page >= totalPages ? 'disabled' : '') + ' class="link-btn" style="width:auto;padding:6px 12px;">Next</button></span></div>';
      var pv = document.getElementById('skuPrev'), nx = document.getElementById('skuNext');
      if (pv) pv.addEventListener('click', function () { if (skuState.page > 1) { skuState.page--; loadSkus(user); } });
      if (nx) nx.addEventListener('click', function () { if (skuState.page < totalPages) { skuState.page++; loadSkus(user); } });
      document.querySelectorAll('.skuEdit').forEach(function (el) {
        el.addEventListener('change', async function () {
          var f = el.getAttribute('data-f'); var body = {};
          body[f] = f === 'unitPriceMinor' ? d2m(el.value) : (parseFloat(el.value) || 0);
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
    openModal('New SKU',
      fieldRow('Part #', '<input id="kPart" style="' + IN + '" required>') +
      fieldRow('Description', '<input id="kDesc" style="' + IN + '" required>') +
      '<div style="display:flex;gap:8px;"><div class="field" style="flex:1;"><label>Unit price ($)</label><input id="kPrice" value="0.00" style="' + IN + '"></div><div class="field" style="flex:1;"><label>Weight (lb)</label><input id="kWt" value="0" style="' + IN + '"></div></div>' +
      fieldRow('Category', '<input id="kCat" value="OTHER" style="' + IN + '">') +
      fieldRow('Proposal group (optional)', '<input id="kGroup" style="' + IN + '">'),
      async function (close, showErr) {
        var part = document.getElementById('kPart').value.trim(); if (!part) return showErr('Part # is required.');
        var desc = document.getElementById('kDesc').value.trim(); if (!desc) return showErr('Description is required.');
        var body = { part: part, description: desc, unitPriceMinor: d2m(document.getElementById('kPrice').value), weightLbs: parseFloat(document.getElementById('kWt').value) || 0, category: document.getElementById('kCat').value.trim() || 'OTHER', proposalGroup: document.getElementById('kGroup').value.trim() || undefined };
        var r = await authed('/skus', { method: 'POST', body: body });
        if (!r.ok) return showErr(r.status === 400 ? 'That part # may already exist.' : 'Could not create (' + r.status + ').');
        close(); skuState.page = 1; loadSkus(user);
      });
  }
  function openSkuImport(user) {
    openModal('Import SKUs from Excel / CSV',
      '<div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.5;">Save your sheet as <b>CSV</b> with a header row of columns: <code>part, description, unitPrice, weightLbs, category, proposalGroup</code>. Existing part #s are updated; new ones are added.</div>' +
      '<input type="file" id="skuFile" accept=".csv,text/csv" style="width:100%;padding:10px;border:1px dashed #cfd3ca;border-radius:9px;background:#fff;">',
      async function (close, showErr) {
        var fi = document.getElementById('skuFile').files[0]; if (!fi) return showErr('Choose a CSV file first.');
        var text = await fi.text();
        var rows = parseCsv(text);
        if (!rows.length) return showErr('No data rows found in that file.');
        var r = await authed('/skus/import', { method: 'POST', body: { rows: rows } });
        if (!r.ok) return showErr('Import failed (' + r.status + ').');
        var d = await r.json();
        close(); alert('Import complete: ' + d.created + ' added, ' + d.updated + ' updated.'); skuState.page = 1; loadSkus(user);
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
  async function renderProposals(user) {
    document.getElementById('view').innerHTML =
      '<div style="display:flex;justify-content:flex-end;margin-bottom:16px;">' + (hasRole(PROP_WRITE, user.role) ? '<button class="btn" id="propNew" style="width:auto;padding:10px 17px;">New proposal</button>' : '') + '</div>' +
      '<div id="propList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    if (hasRole(PROP_WRITE, user.role)) document.getElementById('propNew').addEventListener('click', function () { openProposalForm(user); });
    loadProposals(user);
  }
  async function loadProposals(user) {
    var box = document.getElementById('propList'); if (!box) return;
    try {
      var r = await authed('/proposals'); if (!r.ok) { box.innerHTML = '<div class="err">Could not load (' + r.status + ').</div>'; return; }
      var list = await r.json();
      var rows = (list || []).map(function (p) {
        var v = (p.versions && p.versions[0]) || {};
        return '<tr style="cursor:pointer;" data-id="' + p.id + '">' + td('<b style="font-weight:600;">' + esc(p.title) + '</b><div class="muted" style="font-size:12px;">' + esc(p.number || '') + '</div>') + td('v' + (v.version || p.currentVersion || 1)) + td('<span class="chip">' + titleCase(v.status || 'DRAFT') + '</span>') + td(fmtDate(p.updatedAt)) + '</tr>';
      }).join('');
      box.innerHTML = tableShell(['Proposal', 'Version', 'Status', 'Updated'], rows, 4, 'No proposals yet.');
      document.querySelectorAll('#propList tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { openProposalDetail(tr.getAttribute('data-id'), user); }); });
    } catch (e) { box.innerHTML = '<div class="err">Could not reach the server.</div>'; }
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
      quantity: it.quantity == null ? 1 : it.quantity, rateMinor: it.rateMinor || 0, weightEach: it.weightEach || 0, group: it.group || '',
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
  async function openBuilder(proposal, version, user) {
    var orgName = '', orgShipTo = '';
    try { var rd = await authed('/crm/organizations/' + proposal.organizationId); if (rd.ok) { var org = await rd.json(); orgName = org.name || ''; orgShipTo = formatOrgShipTo(org); } } catch (e) {}
    if (!orgName) { try { var ro = await authed('/crm/organizations?pageSize=100'); if (ro.ok) { var found = ((await ro.json()).items || []).filter(function (o) { return o.id === proposal.organizationId; })[0]; orgName = found ? found.name : ''; } } catch (e2) {} }
    var meta = {};
    var secs = version.sections || [];
    var metaSec = Array.isArray(secs) ? secs.filter(function (s) { return s && s.id === 'meta'; })[0] : null;
    if (metaSec && metaSec.data) meta = metaSec.data;
    var lines = (version.items || []).map(function (it) {
      return normalizeLine(it);
    });
    var propDate = meta.proposalDate || new Date().toISOString().slice(0, 10);
    pb = {
      proposalId: proposal.id, versionId: version.id, user: user, orgName: orgName,
      title: proposal.title || '', number: proposal.number || '',
      meta: { shipTo: meta.shipTo || orgShipTo || '', projectId: meta.projectId || '', showProjectId: meta.showProjectId !== false, proposalDate: propDate, taxAmountMinor: meta.taxAmountMinor || 0, discountPct: meta.discountPct || 0, structureFreightMinor: meta.structureFreightMinor != null ? meta.structureFreightMinor : (meta.freightMinor || 0), matsFreightMinor: meta.matsFreightMinor || 0, expiration: meta.expiration || addDays(propDate, 7) },
      lines: lines,
    };
    renderBuilder();
  }

  function builderTotals() {
    var subtotal = 0, tpFreight = 0, weight = 0;
    var groups = []; var cur = null;
    pb.lines.forEach(function (l) {
      if (l.lineType === 'GROUP') { cur = { name: l.name, optional: l.optional, subtotal: 0 }; groups.push(cur); return; }
      if (l.lineType === 'PRODUCT') {
        var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
        var tp = Number(l.tpFreightMinor) || 0;
        subtotal += amt; tpFreight += tp;
        weight += (Number(l.quantity) || 0) * (Number(l.weightEach) || 0);
        if (cur) cur.subtotal += amt + tp;
      }
    });
    var discountPct = Number(pb.meta.discountPct) || 0;
    var discount = Math.round(subtotal * discountPct / 100);
    var tax = Number(pb.meta.taxAmountMinor) || 0;
    var structureFreight = Number(pb.meta.structureFreightMinor) || 0;
    var matsFreight = Number(pb.meta.matsFreightMinor) || 0;
    var total = subtotal - discount + tpFreight + tax + structureFreight + matsFreight;
    var deposit = Math.round(total * 0.5);
    return { subtotal: subtotal, discountPct: discountPct, discount: discount, tpFreight: tpFreight, tax: tax, structureFreight: structureFreight, matsFreight: matsFreight, total: total, deposit: deposit, groups: groups, weight: weight };
  }
  // subtotal per GROUP line index, for inline display in the builder
  function groupSubtotalMap() {
    var map = {}, curIdx = null;
    pb.lines.forEach(function (l, i) {
      if (l.lineType === 'GROUP') { curIdx = i; map[i] = 0; return; }
      if (l.lineType === 'PRODUCT' && curIdx != null) map[curIdx] += (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0) + (Number(l.tpFreightMinor) || 0);
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
          fieldRow('Proposal date', '<input id="mPropDate" type="date" style="' + IN + '" value="' + esc(pb.meta.proposalDate) + '">') +
          fieldRow('Project ID', '<input id="mProj" style="' + IN + '" value="' + esc(pb.meta.projectId) + '">') +
          fieldRow('Expiration date', '<input id="mExp" type="date" style="' + IN + '" value="' + esc(pb.meta.expiration) + '">') +
        '</div>' +
        '<div class="field" style="margin-top:4px;"><label>Ship to</label><textarea id="mShip" rows="2" style="' + IN + 'resize:vertical;">' + esc(pb.meta.shipTo) + '</textarea></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px;cursor:pointer;"><input type="checkbox" id="mShowProj"' + (pb.meta.showProjectId ? ' checked' : '') + '> Show Project ID on the customer proposal</label>' +
      '</div>' +
      // quick add
      '<div class="card" style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px;"><div class="section-title" style="margin:0;">Add to proposal</div>' +
          '<button class="btn" id="bAdvSeries" style="width:auto;padding:9px 16px;background:#3d4a55;">⚙ Start from Adventure Series</button></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
          '<button class="btn" id="bAddProd" style="width:auto;padding:9px 15px;">+ Product line</button>' +
          '<button class="link-btn" id="bAddGroup" style="width:auto;padding:9px 15px;">+ Group section</button>' +
          '<button class="link-btn" id="bAddSub" style="width:auto;padding:9px 15px;">+ Sub-heading</button>' +
          '<select id="bAddNote" style="padding:9px 12px;border:1px solid #dcded7;border-radius:9px;font-size:13.5px;background:#fff;"><option value="">+ Standard note…</option>' + Object.keys(STD_NOTES).map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join('') + '<option value="__custom">Custom note…</option></select>' +
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
      '</div>';
    wireBuilder();
  }

  function builderLineRow(l, i, gsub) {
    var handle = '<div class="bDrag" style="cursor:grab;color:#c2c6bd;font-size:18px;padding:0 4px;user-select:none;" title="Drag to reorder">⋮⋮</div>';
    var del = '<button class="bDel" data-i="' + i + '" style="border:1px solid #e0e1db;background:#fff;border-radius:8px;width:30px;height:30px;color:#9c3327;cursor:pointer;flex:0 0 auto;">✕</button>';
    if (l.lineType === 'GROUP') {
      var sub = (gsub && gsub[i]) || 0;
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;background:#3d4a55;border:1px solid #33404a;border-radius:10px;padding:9px 10px;color:#fff;">' + handle.replace('#c2c6bd', '#8fa0ac') +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="SECTION HEADING" style="flex:1;border:none;background:transparent;font-weight:700;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:#fff;outline:none;">' +
        '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#cdd6dc;white-space:nowrap;cursor:pointer;"><input type="checkbox" class="bChk" data-i="' + i + '" data-k="optional"' + (l.optional ? ' checked' : '') + '> Optional</label>' +
        '<span style="font-size:12.5px;font-weight:600;color:#cdd6dc;min-width:90px;text-align:right;">' + fmtMoney(sub, 'USD') + '</span>' + del.replace('#9c3327', '#f0b8ae').replace('background:#fff', 'background:rgba(255,255,255,.12)').replace('border:1px solid #e0e1db', 'border:1px solid rgba(255,255,255,.25)') + '</div>';
    }
    if (l.lineType === 'SUBGROUP') {
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;background:#eef0ea;border:1px solid #e2e5dd;border-radius:9px;padding:7px 10px;margin-left:14px;">' + handle +
        '<input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Sub-heading" style="flex:1;border:none;background:transparent;font-weight:600;font-size:13px;color:#3d4a55;outline:none;">' + del + '</div>';
    }
    if (l.lineType === 'NOTE') {
      return '<div class="bRow" draggable="true" data-i="' + i + '" style="display:flex;align-items:flex-start;gap:8px;background:#fbfaf4;border:1px solid #ece9db;border-radius:10px;padding:10px;">' + handle +
        '<div style="flex:1;"><input class="bF" data-i="' + i + '" data-k="name" value="' + esc(l.name) + '" placeholder="Note title" style="width:100%;border:none;background:transparent;font-weight:600;font-size:13.5px;outline:none;margin-bottom:4px;">' +
        '<textarea class="bF" data-i="' + i + '" data-k="description" rows="2" placeholder="Note text" style="width:100%;border:1px solid #ece9db;border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;resize:vertical;background:#fff;">' + esc(l.description) + '</textarea></div>' + del + '</div>';
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
        '<div style="width:96px;flex:0 0 auto;text-align:right;padding-top:20px;font-weight:600;font-size:14px;">' + fmtMoney(amt, 'USD') + '</div>' + del +
      '</div></div>';
  }
  function ynSelect(i, k, val) {
    return '<select class="bF" data-i="' + i + '" data-k="' + k + '" style="' + IN + 'padding:7px 9px;"><option value="">—</option><option value="YES"' + (val === 'YES' ? ' selected' : '') + '>Yes</option><option value="NO"' + (val === 'NO' ? ' selected' : '') + '>No</option></select>';
  }

  var bDragFrom = null;
  function wireBuilder() {
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
      else pb.lines.push({ ref: uid(), lineType: 'NOTE', kind: 'NOTE', name: v, description: STD_NOTES[v], quantity: 0, rateMinor: 0 });
      noteSel.value = ''; renderBuilder();
    });
    document.querySelectorAll('.grpChip').forEach(function (c) { c.addEventListener('click', function () { pb.lines.push({ ref: uid(), lineType: 'GROUP', kind: 'GROUP', name: c.getAttribute('data-g'), description: '', quantity: 0, rateMinor: 0, optional: /trolley|adventure|foundation|mat/i.test(c.getAttribute('data-g')) }); renderBuilder(); }); });
    // header/meta inputs
    var mt = document.getElementById('mTitle'); if (mt) mt.addEventListener('input', function () { pb.title = mt.value; });
    var mp = document.getElementById('mProj'); if (mp) mp.addEventListener('input', function () { pb.meta.projectId = mp.value; });
    var mpd = document.getElementById('mPropDate'); if (mpd) mpd.addEventListener('input', function () { pb.meta.proposalDate = mpd.value; pb.meta.expiration = addDays(mpd.value, 7); var me2 = document.getElementById('mExp'); if (me2) me2.value = pb.meta.expiration; });
    var msp = document.getElementById('mShowProj'); if (msp) msp.addEventListener('change', function () { pb.meta.showProjectId = msp.checked; });
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
        else if (k === 'tpFreight') l.tpFreightMinor = d2m(el.value);
        else if (k === 'quantity') l.quantity = parseFloat(el.value) || 0;
        else l[k] = el.value;
      };
      el.addEventListener('input', handler);
      var k = el.getAttribute('data-k');
      if (k === 'rate' || k === 'quantity' || k === 'tpFreight' || el.tagName === 'SELECT') el.addEventListener('change', renderBuilder);
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
    var items = pb.lines.map(function (l, i) { return { ref: l.ref, lineType: l.lineType, kind: l.kind, productId: l.productId, sku: l.sku || '', name: l.name, description: l.description, quantity: Number(l.quantity) || 0, rateMinor: Number(l.rateMinor) || 0, weightEach: Number(l.weightEach) || 0, group: l.group || '', optional: !!l.optional, delivery: l.delivery || '', returnable: l.returnable || '', addlFreight: l.addlFreight || '', freightCalc: l.freightCalc || '', tpFreightMinor: Number(l.tpFreightMinor) || 0, tpFreightLabel: l.tpFreightLabel || '', order: i }; });
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
    var body = '';
    var groupOpenSub = null, groupName = '';
    var bottomNotes = [];
    function subtotalRow() {
      if (groupOpenSub == null) return '';
      var r = '<tr><td colspan="5" style="padding:7px 8px;text-align:right;font-weight:600;font-size:12px;border-bottom:2px solid #d5d8d2;">Subtotal: ' + fmtMoney(groupOpenSub, 'USD') + '</td></tr>';
      groupOpenSub = null; return r;
    }
    (d.lines || []).forEach(function (l) {
      var lt = l.lineType || 'PRODUCT';
      if (lt === 'GROUP') {
        body += subtotalRow();
        groupOpenSub = 0; groupName = l.name;
        body += '<tr><td colspan="5" style="padding:8px 10px;font-weight:700;font-size:11.5px;letter-spacing:.03em;text-transform:uppercase;color:#3d4a55;background:#eef0ea;border-bottom:1px solid #d5d8d2;">' + esc(tc(l.name)) + (l.optional ? ' <span style="font-weight:400;text-transform:none;color:#8a8f85;">(Optional)</span>' : '') + '</td></tr>';
        return;
      }
      if (lt === 'SUBGROUP') { body += '<tr><td colspan="5" style="padding:10px 8px 4px;font-weight:600;font-size:12px;color:#3d4a55;border-bottom:1px solid #d5d8d2;">' + esc(tc(l.name)) + '</td></tr>'; return; }
      if (lt === 'NOTE') { body += '<tr><td colspan="5" style="padding:9px 8px;background:#fbfaf4;font-size:11px;color:#5c6157;line-height:1.5;"><b style="display:block;color:#20241f;margin-bottom:2px;">' + esc(l.name) + '</b>' + esc(l.description) + '</td></tr>'; return; }
      var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
      if (groupOpenSub != null) groupOpenSub += amt + (Number(l.tpFreightMinor) || 0);
      body += '<tr style="break-inside:avoid;"><td style="padding:9px 8px;border-bottom:1px solid #eef0ea;vertical-align:top;"><b style="font-weight:600;">' + esc(tc(l.name)) + '</b>' + (l.description ? '<div style="font-size:11px;color:#5c6157;line-height:1.5;margin-top:3px;">' + esc(l.description) + '</div>' : '') +
        (l.delivery ? '<div style="font-size:10.5px;color:#7a7f75;margin-top:3px;">Delivery: ' + esc(l.delivery) + '</div>' : '') + '</td>' +
        '<td style="padding:9px 8px;border-bottom:1px solid #eef0ea;font-size:10.5px;color:#7a7f75;vertical-align:top;font-family:ui-monospace,monospace;">' + esc(l.sku || '') + '</td>' +
        '<td style="padding:9px 8px;border-bottom:1px solid #eef0ea;text-align:center;vertical-align:top;">' + (Number(l.quantity) || 0) + '</td>' +
        '<td style="padding:9px 8px;border-bottom:1px solid #eef0ea;text-align:right;vertical-align:top;">' + fmtMoney(l.rateMinor, '') + '</td>' +
        '<td style="padding:9px 8px;border-bottom:1px solid #eef0ea;text-align:right;vertical-align:top;font-weight:600;">' + fmtMoney(amt, '') + '</td></tr>';
      if (Number(l.tpFreightMinor) > 0) {
        body += '<tr><td style="padding:2px 8px 8px 20px;border-bottom:1px solid #eef0ea;font-size:11px;color:#5c6157;font-style:italic;">+ ' + esc(l.tpFreightLabel || 'Third-party freight') + '</td><td style="border-bottom:1px solid #eef0ea;"></td><td style="border-bottom:1px solid #eef0ea;"></td><td style="border-bottom:1px solid #eef0ea;"></td><td style="padding:2px 8px 8px;border-bottom:1px solid #eef0ea;text-align:right;font-size:11px;color:#5c6157;">' + fmtMoney(l.tpFreightMinor, '') + '</td></tr>';
      }
      var flags = [];
      if (l.returnable) flags.push('Returnable: ' + (l.returnable === 'YES' ? 'Yes' : 'No'));
      if (l.addlFreight) flags.push('Additional freight: ' + (l.addlFreight === 'YES' ? 'Yes' : 'No'));
      if (l.freightCalc) flags.push('Freight calculated: ' + (l.freightCalc === 'YES' ? 'Yes' : 'No'));
      if (flags.length) bottomNotes.push({ name: l.name, text: flags.join(' · ') });
    });
    body += subtotalRow();
    var bottomNotesHtml = bottomNotes.length ? '<div style="margin-top:22px;padding-top:12px;border-top:1px solid #e7e8e3;font-size:10.5px;color:#5c6157;line-height:1.6;"><div style="font-weight:600;color:#20241f;margin-bottom:4px;">Delivery, returns &amp; freight notes</div>' + bottomNotes.map(function (n) { return '<div><b style="font-weight:600;">' + esc(n.name) + ':</b> ' + esc(n.text) + '</div>'; }).join('') + '</div>' : '';
    var html =
      '<div id="propPrintArea" style="max-width:760px;margin:0 auto;background:#fff;padding:44px 48px;font-family:\'IBM Plex Sans\',sans-serif;color:#20241f;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid #3d4a55;padding-bottom:16px;margin-bottom:20px;">' +
          '<div style="display:flex;gap:12px;align-items:center;"><div class="login-logo" style="width:52px;height:52px;margin:0;"></div><div><div style="font-family:\'Newsreader\',serif;font-weight:600;font-size:19px;">Summit Sensory Gym</div><div style="font-size:11px;color:#8a8f85;line-height:1.5;margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111<br>(720) 457-5500 · Sales@SummitSensory.com</div></div></div>' +
          '<div style="text-align:right;"><div style="font-family:\'Newsreader\',serif;font-size:22px;font-weight:600;">Proposal</div><div style="font-size:11.5px;color:#5c6157;margin-top:4px;">' + esc(d.number || '') + '</div>' +
            '<div style="font-size:11px;color:#5c6157;margin-top:8px;line-height:1.7;">' +
              '<div>Proposal date: <b style="color:#20241f;">' + (m.proposalDate ? fmtDate(m.proposalDate) : fmtDate(new Date().toISOString())) + '</b></div>' +
              (m.expiration ? '<div>Expiration date: <b style="color:#20241f;">' + fmtDate(m.expiration) + '</b></div>' : '') +
              '<div>Total weight: <b style="color:#20241f;">' + (Number(t.weight) || 0).toLocaleString() + ' lbs</b></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:20px;font-size:12px;">' +
          '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a8f85;margin-bottom:4px;">Prepared for</div><div style="font-weight:600;">' + esc(d.orgName || '') + '</div><div style="color:#5c6157;white-space:pre-line;margin-top:2px;">' + esc(m.shipTo || '') + '</div></div>' +
          '<div style="text-align:right;color:#5c6157;">' + (m.showProjectId !== false && m.projectId ? '<div>Project ID: <b style="color:#20241f;">' + esc(m.projectId) + '</b></div>' : '') + '</div>' +
        '</div>' +
        '<div style="font-family:\'Newsreader\',serif;font-size:24px;font-weight:600;margin-bottom:14px;">' + esc(d.title || '') + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12.5px;"><thead><tr style="color:#8a8f85;font-size:10px;text-transform:uppercase;letter-spacing:.04em;"><th style="text-align:left;padding:6px 8px;border-bottom:2px solid #3d4a55;">Activity / Description</th><th style="text-align:left;padding:6px 8px;border-bottom:2px solid #3d4a55;width:90px;">SKU</th><th style="text-align:center;padding:6px 8px;border-bottom:2px solid #3d4a55;width:44px;">Qty</th><th style="text-align:right;padding:6px 8px;border-bottom:2px solid #3d4a55;width:84px;">Rate</th><th style="text-align:right;padding:6px 8px;border-bottom:2px solid #3d4a55;width:94px;">Amount</th></tr></thead><tbody>' + body + '</tbody></table>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:16px;"><div style="min-width:260px;">' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Subtotal</span><span>' + fmtMoney(t.subtotal, 'USD') + '</span></div>' +
          (t.discount ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;color:#9c3327;"><span>Discount (' + t.discountPct + '%)</span><span>− ' + fmtMoney(t.discount, 'USD') + '</span></div>' +
            '<div style="padding:0 8px 3px;font-size:10px;color:#8a8f85;text-align:right;">Discount expires ' + (m.expiration ? fmtDate(m.expiration) : 'with this proposal') + '</div>' : '') +
          (t.tpFreight ? '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Third-party freight</span><span>' + fmtMoney(t.tpFreight, 'USD') + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Tax</span><span>' + fmtMoney(t.tax, 'USD') + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Structure Crating &amp; Freight</span><span>' + fmtMoney(t.structureFreight, 'USD') + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:3px 8px;font-size:12.5px;"><span style="color:#5c6157;">Mats &amp; Padding Freight</span><span>' + fmtMoney(t.matsFreight, 'USD') + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:8px;margin-top:5px;border-top:2px solid #3d4a55;font-size:15px;font-weight:700;"><span>Total</span><span>' + fmtMoney(t.total, 'USD') + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:6px 8px 0;font-size:13px;color:#3d4a55;font-weight:700;"><span>Deposit due (50%)</span><span>' + fmtMoney(t.deposit, 'USD') + '</span></div>' +
        '</div></div>' + bottomNotesHtml +
        '<div style="display:flex;gap:40px;margin-top:40px;padding-top:14px;">' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Name</div></div>' +
          '<div style="flex:1;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Signer\'s Signature</div></div>' +
          '<div style="flex:0 0 150px;"><div style="border-bottom:1.5px solid #20241f;height:26px;"></div><div style="font-size:10.5px;color:#8a8f85;margin-top:5px;">Date</div></div>' +
        '</div>' +
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
    st.textContent = '@media print{body *{visibility:hidden!important;}#propPreviewOverlay,#propPreviewOverlay *{visibility:visible!important;}#propPreviewOverlay{position:absolute!important;inset:0!important;background:#fff!important;padding:0!important;overflow:visible!important;}#propPreviewOverlay .noprint{display:none!important;}}';
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
      brackets: false, bracketsQty: 4, swivel360: 4, forged: 12, swingHanger: 0, vRings: 0, carabiner: 0, webbingSling: 6,
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
              num('swingHanger', '# Swing Hanger w/ Bearing (×2)', 0, 12) +
              num('vRings', '# V-Rings (10-pack)', 0, 3) +
              '<div class="af"><label style="display:block;font-size:11px;color:#8a8f85;text-transform:uppercase;margin-bottom:4px;">Auto-Locking Carabiner (4pk)</label><input type="number" data-ak="carabiner" value="' + adv.carabiner + '" min="0" max="8" style="width:100%;padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:14px;"><span class="muted" style="font-size:11px;">Recommended: ' + carabRec + '</span></div>' +
              num('webbingSling', 'Multi-Pocket Webbing Sling (def = legs)', 0, 16) +
            '</div>'
          ) +
          '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid #e7e8e3;">' +
            '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#5c6157;"><input type="checkbox" id="advReplace"> Replace existing lines</label>' +
            '<button class="btn" id="advGen" style="width:auto;padding:11px 22px;">Generate proposal lines →</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    o.innerHTML = html;
    o.addEventListener('mousedown', function (e) { if (e.target === o) advClose(); });
    document.getElementById('advX').addEventListener('click', advClose);
    document.getElementById('advGen').addEventListener('click', function () { generateAdvLines(document.getElementById('advReplace').checked); });
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
  async function generateAdvLines(replace) {
    var btn = document.getElementById('advGen'); if (btn) { btn.disabled = true; btn.textContent = 'Pricing…'; }
    var answers = {
      length: Number(adv.length), width: Number(adv.width), config: adv.config, legs: Number(adv.legs), ladders: adv.ladders ? Number(adv.laddersQty) : 0,
      monkeyBars: !!adv.monkeyBars, monkeyBarsQty: Number(adv.monkeyBarsQty),
      interiorBeams: !!adv.interiorBeams, interiorBeamsQty: Number(adv.interiorBeamsQty),
      trolley: !!adv.trolley, trolleyType: adv.trolleyType, zipLine: !!adv.zipLine, zipLineQty: Number(adv.zipLineQty), ballRack: !!adv.ballRack,
      slide: !!adv.slide, slideGray: !!adv.slideGray, steamroller: !!adv.steamroller,
      climbFrame: !!adv.climbFrame, climbWall: !!adv.climbWall, climbShield: !!adv.climbShield, climbMat: !!adv.climbMat,
      matFloor: !!adv.matFloor, matColumn: !!adv.matColumn, uShaped: Number(adv.uShaped), completeWrap: Number(adv.completeWrap), matLadderLeg: !!adv.matLadderLeg, matCustom: !!adv.matCustom,
      brackets: !!adv.brackets, bracketsQty: Number(adv.bracketsQty), swivel360: Number(adv.swivel360), forged: Number(adv.forged), swingHanger: Number(adv.swingHanger), vRings: Number(adv.vRings), carabiner: Number(adv.carabiner), webbingSling: Number(adv.webbingSling),
    };
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
        rateMinor: l.rateMinor || 0, weightEach: l.weightEach || 0, optional: !!l.optional,
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
      '<div id="admList"><div class="muted" style="padding:24px;">Loading…</div></div>';
    document.getElementById('admNew').addEventListener('click', openUserForm);
    loadUsers();
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

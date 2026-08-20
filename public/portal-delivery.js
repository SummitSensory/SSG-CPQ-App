/* Portal delivery submissions — the operational panel.
 *
 * Loaded as its own file rather than folded into app.js. app.js is one 13,000-line
 * closure; a screen that lives beside it is easier to read, and it means the only
 * change to app.js is two lines that mount this.
 *
 * Everything here already existed as an endpoint. What was missing was somewhere to
 * see it: which confirmed addresses arrived, which are stuck and why, and a way to
 * link a parked one to its order without a console.
 *
 * It mounts ITSELF. The Integrations screen is rendered by app.js, which this file
 * cannot edit from here, and an edit to app.js is one more file that has to land in a
 * push to work — so instead this watches for that screen and appends the panel to it.
 * window.SSGPortalDelivery.mount(host, { authed }) still exists for an explicit mount.
 */
(function () {
  'use strict';

  /* monday's web UI, for the "open the row" link. The board id comes from the API so
   * a board rebuilt in monday needs no change here. */
  var MONDAY_HOST = 'https://summit-sensory-gym.monday.com';

  /* Anything not APPLIED needs a human eventually. Order matters: this is the order
   * rows are listed in, worst first. */
  var STUCK = ['FAILED', 'CONFLICT', 'PARKED', 'INCOMPLETE'];

  var DOT = {
    APPLIED: 'ok',
    PARKED: 'wait',
    CONFLICT: 'wait',
    INCOMPLETE: 'wait',
    FAILED: 'bad',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    );
  }

  /* ── Auth ───────────────────────────────────────────────────────────────────
   * app.js keeps its authed() inside a closure, so this cannot borrow it. Same
   * contract, same token keys (ssg_at / ssg_rt), same single transparent refresh on
   * a 401 — deliberately duplicated rather than shared, because the alternative is
   * this file depending on an edit to a 13,000-line one. */
  var AT = 'ssg_at',
    RT = 'ssg_rt';

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    var at = localStorage.getItem(AT);
    if (at) headers['Authorization'] = 'Bearer ' + at;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  async function refresh() {
    var rt = localStorage.getItem(RT);
    if (!rt) return false;
    var r = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!r.ok) return false;
    var d = await r.json();
    // Only ever writes the two keys it just received — never clears the session on
    // failure, because that is app.js's call to make, not this panel's.
    if (d.accessToken) localStorage.setItem(AT, d.accessToken);
    if (d.refreshToken) localStorage.setItem(RT, d.refreshToken);
    return true;
  }

  async function defaultAuthed(path, opts) {
    var r = await api(path, opts);
    if (r.status === 401 && (await refresh())) r = await api(path, opts);
    return r;
  }

  function mount(host, deps) {
    var authed = (deps && deps.authed) || defaultAuthed;
    var state = {
      rows: [],
      orders: [],
      boardId: '',
      configured: false,
      showApplied: false,
      busy: '',
    };

    host.innerHTML =
      '<div class="section-title">Portal delivery submissions</div>' +
      '<div class="card" id="pdCard"><div class="muted" style="font-size:13.5px;">Loading…</div></div>';
    var card = host.querySelector('#pdCard');

    load();

    async function load() {
      var s = await authed('/integrations/monday/status');
      if (s.ok) {
        var st = await s.json();
        state.configured = !!(st.portalDelivery && st.portalDelivery.configured);
        state.boardId = (st.portalDelivery && st.portalDelivery.boardId) || '';
      }
      var r = await authed('/integrations/monday/portal-delivery?limit=200');
      if (!r.ok) {
        card.innerHTML =
          '<div class="err" style="margin:0;">Could not read the submissions list (' +
          r.status +
          '). Your role may lack the integrations permission.</div>';
        return;
      }
      state.rows = (await r.json()) || [];
      var o = await authed('/orders');
      state.orders = o.ok ? await o.json() : [];
      render();
    }

    /* One address per row, and the reason it is where it is. The note is the whole
     * point of the screen, so it is never truncated. */
    function rowHtml(x) {
      var stuck = x.status !== 'APPLIED';
      var addr = x.address || '—';
      var poc = [x.pocName, x.pocPhone].filter(Boolean).join(' · ');
      var mondayUrl =
        state.boardId && x.mondayItemId
          ? MONDAY_HOST +
            '/boards/' +
            encodeURIComponent(state.boardId) +
            '/pulses/' +
            encodeURIComponent(x.mondayItemId)
          : '';

      return (
        '<div style="border-top:1px solid #eef0ea;padding:13px 0;">' +
        '<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;">' +
        '<div style="font-size:13px;font-weight:600;min-width:104px;">' +
        '<span class="dot ' +
        (DOT[x.status] || 'wait') +
        '"></span>' +
        esc(x.status) +
        '</div>' +
        '<div style="font-size:13.5px;font-weight:600;min-width:150px;">' +
        (x.order ? esc(x.order.number) : '<span class="muted">no order yet</span>') +
        '</div>' +
        '<div style="font-size:13.5px;flex:1 1 320px;min-width:240px;">' +
        esc(addr) +
        (x.addressParsedFromFormatted
          ? ' <span class="chip" style="background:#fdf3e3;color:#7a5c1a;font-size:11px;padding:2px 8px;" ' +
            'title="The street was read out of the portal&rsquo;s single formatted address line because the separate address fields were empty. Check it before a sheet goes out.">parsed</span>'
          : '') +
        (x.addressConfirmedByCustomer === false
          ? ' <span class="chip" style="background:#fbecea;color:#9c3327;font-size:11px;padding:2px 8px;" title="The customer changed the address that was on file.">changed</span>'
          : '') +
        (poc
          ? '<div class="muted" style="font-size:12px;margin-top:3px;">' + esc(poc) + '</div>'
          : '') +
        '</div>' +
        '<div class="muted" style="font-size:12px;min-width:118px;text-align:right;">' +
        esc(when(x.resolvedAt || x.receivedAt)) +
        (x.sectionsUpdated ? '<br>' + x.sectionsUpdated + ' section(s)' : '') +
        '</div>' +
        '</div>' +
        (x.note
          ? '<div class="muted" style="font-size:12.5px;line-height:1.5;margin-top:6px;">' +
            esc(x.note) +
            '</div>'
          : '') +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px;">' +
        (stuck
          ? '<button class="link-btn" data-act="retry" data-id="' +
            esc(x.id) +
            '" style="width:auto;padding:6px 12px;font-size:12.5px;white-space:nowrap;">Retry</button>' +
            '<select data-role="order" data-id="' +
            esc(x.id) +
            '" style="padding:6px 9px;border:1px solid #dcded7;border-radius:8px;font-size:12.5px;background:#fff;max-width:330px;">' +
            '<option value="">Link to an order…</option>' +
            state.orders
              .filter(function (o) {
                return o.status !== 'CANCELLED';
              })
              .map(function (o) {
                return (
                  '<option value="' +
                  esc(o.id) +
                  '">' +
                  esc(o.number) +
                  ' — ' +
                  esc(o.customer || '') +
                  '</option>'
                );
              })
              .join('') +
            '</select>' +
            '<button class="link-btn" data-act="link" data-id="' +
            esc(x.id) +
            '" style="width:auto;padding:6px 12px;font-size:12.5px;white-space:nowrap;">Link</button>'
          : '') +
        (mondayUrl
          ? '<a href="' +
            esc(mondayUrl) +
            '" target="_blank" rel="noopener" style="font-size:12.5px;">Open the monday row</a>'
          : '') +
        '</div>' +
        '</div>'
      );
    }

    function render() {
      var stuck = [];
      STUCK.forEach(function (s) {
        stuck = stuck.concat(
          state.rows.filter(function (x) {
            return x.status === s;
          }),
        );
      });
      var applied = state.rows.filter(function (x) {
        return x.status === 'APPLIED';
      });
      var emptyIncomplete = state.rows.filter(function (x) {
        return x.status === 'INCOMPLETE' && !x.address;
      }).length;

      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">' +
        '<div>' +
        '<div class="k">Customer portal → Bill of Materials</div>' +
        '<div style="font-size:13.5px;color:#82877d;line-height:1.6;max-width:640px;">' +
        (state.configured
          ? '<span class="dot ok"></span>Reading the Delivery &amp; Site Details Submissions board (' +
            esc(state.boardId) +
            ').'
          : '<span class="dot bad"></span>Not configured — MONDAY_API_TOKEN or the delivery board id is missing.') +
        '<br>A confirmed address lands on every vendor section of its order that has not been submitted yet. ' +
        'monday webhooks are not retroactive, so a row submitted before this board was subscribed only arrives via <b>Backfill</b>.' +
        '</div>' +
        '</div>' +
        '<div style="text-align:right;font-size:12.5px;color:#82877d;">' +
        '<div><b>' +
        applied.length +
        '</b> applied</div>' +
        (stuck.length
          ? '<div style="color:#9c3327;"><b>' + stuck.length + '</b> need attention</div>'
          : '') +
        '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">' +
        '<button class="link-btn" data-act="refresh" style="width:auto;padding:8px 14px;white-space:nowrap;">Refresh</button>' +
        '<button class="link-btn" data-act="backfill" style="width:auto;padding:8px 14px;white-space:nowrap;" title="Read the board directly and ingest every row that carries an address. Idempotent.">Backfill from board</button>' +
        '<button class="link-btn" data-act="retryPending" style="width:auto;padding:8px 14px;white-space:nowrap;" title="Re-run every submission that is parked, incomplete or failed.">Retry everything pending</button>' +
        (emptyIncomplete
          ? '<button class="link-btn" data-act="purge" style="width:auto;padding:8px 14px;white-space:nowrap;" title="Delete the stored rows that have no address at all — invite rows nobody filled in. They are re-read from monday on every sweep until removed.">Clear ' +
            emptyIncomplete +
            ' address-less row(s)</button>'
          : '') +
        (state.busy
          ? '<span class="muted" style="font-size:12.5px;align-self:center;">' +
            esc(state.busy) +
            '</span>'
          : '') +
        '</div>' +
        (stuck.length
          ? '<div class="section-title" style="margin:22px 0 2px;">Need attention</div>' +
            stuck.map(rowHtml).join('')
          : '<div class="muted" style="font-size:13px;margin-top:18px;">Nothing stuck. Every submission with an address is on its order.</div>') +
        (applied.length
          ? '<div class="section-title" style="margin:22px 0 2px;">Applied <span class="muted" style="font-weight:400;">(' +
            applied.length +
            ')</span> ' +
            '<button class="link-btn" data-act="toggleApplied" style="width:auto;padding:4px 10px;font-size:12px;margin-left:8px;white-space:nowrap;">' +
            (state.showApplied ? 'Hide' : 'Show') +
            '</button></div>' +
            (state.showApplied ? applied.map(rowHtml).join('') : '')
          : '');

      wire();
    }

    function wire() {
      card.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          act(b.getAttribute('data-act'), b);
        });
      });
    }

    async function act(kind, btn) {
      if (kind === 'toggleApplied') {
        state.showApplied = !state.showApplied;
        render();
        return;
      }
      if (kind === 'refresh') {
        state.busy = 'Reloading…';
        render();
        return load();
      }

      var id = btn.getAttribute('data-id');
      var call = null;
      var label = '';

      if (kind === 'backfill') {
        call = ['/integrations/monday/portal-delivery/backfill?max=200', { method: 'POST' }];
        label = 'Reading the board…';
      } else if (kind === 'retryPending') {
        call = ['/integrations/monday/portal-delivery/retry-pending?limit=100', { method: 'POST' }];
        label = 'Retrying…';
      } else if (kind === 'purge') {
        call = ['/integrations/monday/portal-delivery/incomplete', { method: 'DELETE' }];
        label = 'Clearing…';
      } else if (kind === 'retry') {
        call = ['/integrations/monday/portal-delivery/' + id + '/retry', { method: 'POST' }];
        label = 'Retrying…';
      } else if (kind === 'link') {
        var sel = card.querySelector('[data-role="order"][data-id="' + id + '"]');
        var orderId = sel && sel.value;
        if (!orderId) {
          flash('Pick an order first.', true);
          return;
        }
        call = [
          '/integrations/monday/portal-delivery/' + id + '/link',
          { method: 'POST', body: { orderId: orderId } },
        ];
        label = 'Linking…';
      }
      if (!call) return;

      state.busy = label;
      btn.disabled = true;
      render();
      var r = await authed(call[0], call[1]);
      var body = null;
      try {
        body = await r.json();
      } catch (e) {}
      state.busy = '';
      if (!r.ok) {
        flash(
          'That did not go through (' +
            r.status +
            (body && body.error ? ' ' + body.error : '') +
            ').',
          true,
        );
        return load();
      }
      flash(summarize(kind, body), false);
      return load();
    }

    /* Plain sentences rather than the raw JSON. What a person wants to know after
     * pressing a button is what changed, not the shape of the response. */
    function summarize(kind, body) {
      if (!body) return 'Done.';
      if (kind === 'backfill') {
        var res = body.results || {};
        var parts = Object.keys(res).map(function (k) {
          return res[k] + ' ' + k;
        });
        return (
          'Read ' +
          body.scanned +
          ' board row(s), skipped ' +
          body.skipped +
          ' with no address' +
          (parts.length ? ' — ' + parts.join(', ') : '') +
          '.'
        );
      }
      if (kind === 'retryPending') {
        var rr = body.results || {};
        var p = Object.keys(rr).map(function (k) {
          return rr[k] + ' ' + k;
        });
        return body.checked + ' pending' + (p.length ? ' — ' + p.join(', ') : '') + '.';
      }
      if (kind === 'purge') return 'Removed ' + (body.deleted || 0) + ' address-less row(s).';
      if (body.result === 'applied') return 'Applied to the order&rsquo;s vendor sections.';
      if (body.result === 'conflict')
        return 'Every section on that order is already submitted. The address is saved and the owner has been emailed.';
      if (body.result === 'parked') return 'Still parked — the note on the row says why.';
      if (body.result === 'incomplete') return 'The board row still has no usable address.';
      return 'Result: ' + esc(String(body.result || 'done')) + '.';
    }

    function flash(msg, bad) {
      var el = document.createElement('div');
      el.className = bad ? 'err' : '';
      el.style.cssText = bad
        ? 'margin:14px 0 0;'
        : 'margin:14px 0 0;background:#eef4ef;border:1px solid #cfe0d4;color:#2f6b4f;font-size:13px;padding:9px 12px;border-radius:9px;';
      el.innerHTML = msg;
      card.appendChild(el);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 9000);
    }
  }

  /* ── Self-mount ──────────────────────────────────────────────────────────────
   * app.js renders each screen by replacing #view's innerHTML and writing the screen
   * name into #viewTitle. So: whenever the DOM settles, if the current screen is
   * Integrations and the panel is not on it, append it.
   *
   * Re-mounts naturally. When app.js re-renders the screen it discards our container
   * along with everything else, and the flag we set goes with it, so the next
   * mutation puts a fresh panel back. If app.js has been edited to provide a
   * #portalDeliveryPanel div, that div is used as-is instead of a second one. */
  function onIntegrationsScreen() {
    var t = document.getElementById('viewTitle');
    return !!t && t.textContent.trim() === 'Integrations';
  }

  function tryMount() {
    if (!onIntegrationsScreen()) return;
    var view = document.getElementById('view');
    if (!view) return;
    var slot = document.getElementById('portalDeliveryPanel');
    if (slot && slot.getAttribute('data-pd-mounted') === '1') return;
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'portalDeliveryPanel';
      view.appendChild(slot);
    }
    slot.setAttribute('data-pd-mounted', '1');
    try {
      mount(slot, {});
    } catch (e) {
      slot.removeAttribute('data-pd-mounted');
      // A panel that fails must not take the Integrations screen with it.
      console.error('portal delivery panel failed to mount', e);
    }
  }

  var pending = null;
  function schedule() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      tryMount();
    }, 120);
  }

  function watch() {
    schedule();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }

  window.SSGPortalDelivery = { mount: mount };
})();

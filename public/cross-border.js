/* Cross-border administration — Canadian proposals.
 *
 * The engine, the routes and the proposal rail all shipped before this screen did,
 * which meant the whole feature was configurable only by SQL: the GST/HST
 * registration that every Canadian proposal waits on, the FX fallback, the broker's
 * fee tariff, and the queue of proposals sitting at REQUIRES_CUSTOMS_REVIEW.
 *
 * This is that screen. Five panels in the order the work happens:
 *
 *   1. Readiness   — what is stopping the feature from being switched on
 *   2. Settings    — the switch itself, and the defaults
 *   3. Registrations — GST/HST first, because one row unblocks every province
 *   4. Exchange rate — what the Bank published, and any manual override
 *   5. Brokerage + the customs review queue
 *
 * Loaded as its own file for the same reason portal-delivery.js is: app.js is one
 * 13,000-line closure, and a screen that lives beside it is one file to read and one
 * file to change. It self-mounts by watching for the Administration screen, so app.js
 * needs no edit at all.
 *
 * Every write here goes through a route that audits it. Nothing is computed locally
 * except display formatting — the readiness verdict, the effective-date arithmetic
 * and the fee estimate all come from the server, because a second implementation of
 * those rules in a browser is a second set of answers.
 */
(function () {
  'use strict';

  var AT = 'ssg_at',
    RT = 'ssg_rt';

  var PROVINCES = [
    ['AB', 'Alberta'],
    ['BC', 'British Columbia'],
    ['MB', 'Manitoba'],
    ['NB', 'New Brunswick'],
    ['NL', 'Newfoundland and Labrador'],
    ['NS', 'Nova Scotia'],
    ['NT', 'Northwest Territories'],
    ['NU', 'Nunavut'],
    ['ON', 'Ontario'],
    ['PE', 'Prince Edward Island'],
    ['QC', 'Quebec'],
    ['SK', 'Saskatchewan'],
    ['YT', 'Yukon'],
  ];

  var FALLBACK_LABEL = {
    LAST_CACHED: 'Use the last rate on file',
    MANUAL_RATE: 'Use the manual rate',
    BLOCK_FINALIZATION: 'Block the proposal — no CAD figures',
    DRAFT_WITH_REVIEW: 'Draft the CAD figures with a review warning',
  };

  var IOR_LABEL = {
    CUSTOMER: 'The customer',
    SUMMIT: 'Summit',
    THIRD_PARTY: 'A third party',
    TO_BE_DETERMINED: 'To be determined',
  };

  var FEE_TYPE_LABEL = {
    FLAT: 'Flat fee',
    PERCENTAGE: 'Percentage of entry value',
    TIERED: 'Tiered by entry value',
    PER_ENTRY: 'Per entry',
    PER_SHIPMENT: 'Per shipment',
    PER_LINE: 'Per line',
    MANUAL: 'Manual — quoted each time',
  };

  var IN =
    'padding:8px 10px;border:1px solid #dcded7;border-radius:8px;font-size:13px;background:#fff;font-family:inherit;';
  var BTN = 'width:auto;padding:8px 14px;white-space:nowrap;';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* Minor units in, a printable amount out. Never parseFloat on a stored figure —
   * the division is the only place a cent count becomes a decimal, and it happens
   * once, on the way to the screen. */
  function money(minor, currency) {
    if (minor == null) return '—';
    var neg = minor < 0;
    var abs = Math.abs(minor);
    var s = (abs / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return (neg ? '-' : '') + '$' + s + (currency ? ' ' + currency : '');
  }

  function day(iso) {
    if (!iso) return '—';
    return String(iso).slice(0, 10);
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ── Auth ──────────────────────────────────────────────────────────────────
   * Same contract as app.js: bearer token, one transparent refresh on a 401, and it
   * never clears the session itself — that is app.js's call. Duplicated rather than
   * shared, because sharing means depending on an edit to app.js. */
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
    var S = {
      settings: null,
      readiness: null,
      rates: [],
      fx: null,
      taxability: [],
      schedules: [],
      inForceId: null,
      queue: [],
      busy: '',
      open: 'readiness',
      denied: false,
    };

    host.innerHTML =
      '<div class="section-title" style="margin-top:26px;">Canadian proposals and cross-border charges</div>' +
      '<div class="card" id="cbCard"><div class="muted" style="font-size:13.5px;">Loading…</div></div>';
    var card = host.querySelector('#cbCard');

    load();

    async function load() {
      var s = await authed('/cross-border/settings');
      if (s.status === 403) {
        // Not an error to report loudly: most roles have no business here, and the
        // Administration screen should not grow a permission complaint.
        S.denied = true;
        host.innerHTML = '';
        return;
      }
      if (!s.ok) {
        card.innerHTML =
          '<div class="err" style="margin:0;">Could not read the cross-border settings (' +
          s.status +
          ').</div>';
        return;
      }
      var d = await s.json();
      S.settings = d.settings || {};
      S.readiness = d.readiness || {};

      var results = await Promise.all([
        authed('/cross-border/tax-rates'),
        authed('/cross-border/fx'),
        authed('/cross-border/broker-fees'),
        authed('/cross-border/customs-queue'),
        authed('/cross-border/taxability'),
      ]);
      S.rates = results[0].ok ? (await results[0].json()) || [] : [];
      S.fx = results[1].ok ? await results[1].json() : { observations: [], overrides: [] };
      if (results[2].ok) {
        var bf = await results[2].json();
        S.schedules = bf.schedules || [];
        S.inForceId = bf.inForceId || null;
      }
      S.queue = results[3].ok ? (await results[3].json()) || [] : [];
      S.taxability = results[4].ok ? (await results[4].json()) || [] : [];
      render();
    }

    /* ── Readiness ─────────────────────────────────────────────────────────── */

    function readinessHtml() {
      var r = S.readiness || {};
      var fed = r.federalRegistration;
      var on = !!(S.settings && S.settings.enabled);

      var checks = [
        {
          ok: !!fed,
          label: 'GST/HST registration on file',
          detail: fed
            ? 'Number ' +
              esc(fed.registrationNumber || 'not recorded') +
              ', in force from ' +
              day(fed.effectiveFrom) +
              (fed.registrationNumber
                ? ''
                : ' — the number itself is still blank, and it prints on the proposal.')
            : 'Required. Without it every Canadian proposal reports a tax review and cannot be released. One row with no province covers GST and HST in every province.',
        },
        {
          ok: (r.rateCount || 0) > 0,
          label: (r.rateCount || 0) + ' provincial tax rate(s) seeded',
          detail: r.unreviewedRateCount
            ? r.unreviewedRateCount +
              ' still marked for confirmation by an accountant. Nova Scotia’s 14% HST and Saskatchewan’s PST date are the two least certain.'
            : 'Every seeded rate has been confirmed.',
        },
        {
          ok: (S.fx && S.fx.observations && S.fx.observations.length) > 0,
          label: 'Bank of Canada rate on file',
          detail:
            S.fx && S.fx.observations && S.fx.observations.length
              ? 'Latest observation ' +
                day(S.fx.observations[0].observationDate) +
                ' at ' +
                esc(S.fx.observations[0].rate) +
                ' CAD per USD.'
              : 'None fetched yet. The first Canadian proposal fetches one; a fallback applies until then.',
        },
      ];

      return (
        '<div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start;">' +
        '<div><div class="k">Feature status</div>' +
        '<div style="font-size:13.5px;color:#82877d;line-height:1.6;max-width:660px;">' +
        (on
          ? '<span class="dot ok"></span>On. A proposal billed to a Canadian address is priced in USD and CAD, and cannot be released until its tax and customs figures are settled.'
          : '<span class="dot wait"></span>Off. Canadian proposals price exactly as they do today, and nothing on this screen affects a live quote.') +
        '</div></div>' +
        '<button class="link-btn" data-act="toggleFeature" style="' +
        BTN +
        '">' +
        (on ? 'Turn the feature off' : 'Turn the feature on') +
        '</button>' +
        '</div>' +
        checks
          .map(function (c) {
            return (
              '<div style="border-top:1px solid #eef0ea;padding:12px 0;display:flex;gap:12px;align-items:flex-start;">' +
              '<span class="dot ' +
              (c.ok ? 'ok' : 'bad') +
              '" style="margin-top:6px;flex:0 0 auto;"></span>' +
              '<div><div style="font-size:13.5px;font-weight:600;">' +
              esc(c.label) +
              '</div>' +
              '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-top:3px;">' +
              c.detail +
              '</div></div>' +
              '</div>'
            );
          })
          .join('')
      );
    }

    /* ── Settings ──────────────────────────────────────────────────────────── */

    function settingsHtml() {
      var s = S.settings || {};
      function row(label, control, note) {
        return (
          '<div style="border-top:1px solid #eef0ea;padding:12px 0;display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">' +
          '<div style="flex:1 1 260px;min-width:200px;"><div style="font-size:13.5px;font-weight:600;">' +
          esc(label) +
          '</div>' +
          (note
            ? '<div class="muted" style="font-size:12.5px;line-height:1.55;margin-top:3px;">' +
              note +
              '</div>'
            : '') +
          '</div><div style="flex:0 1 300px;">' +
          control +
          '</div></div>'
        );
      }
      function select(field, options, value) {
        return (
          '<select data-setting="' +
          field +
          '" style="' +
          IN +
          'width:100%;">' +
          options
            .map(function (o) {
              return (
                '<option value="' +
                esc(o[0]) +
                '"' +
                (o[0] === value ? ' selected' : '') +
                '>' +
                esc(o[1]) +
                '</option>'
              );
            })
            .join('') +
          '</select>'
        );
      }
      function check(field, value, label) {
        return (
          '<label style="display:flex;gap:9px;align-items:flex-start;font-size:13px;cursor:pointer;">' +
          '<input type="checkbox" data-setting="' +
          field +
          '"' +
          (value ? ' checked' : '') +
          ' style="margin-top:2px;">' +
          '<span>' +
          esc(label) +
          '</span></label>'
        );
      }

      return (
        row(
          'Importer of record, by default',
          select(
            'defaultImporterOfRecord',
            Object.keys(IOR_LABEL).map(function (k) {
              return [k, IOR_LABEL[k]];
            }),
            s.defaultImporterOfRecord,
          ),
          'Recorded on each proposal when its customs entry is created, so a later change here does not restate an old quote.',
        ) +
        row(
          'When the exchange rate cannot be fetched',
          select(
            'fxFallbackMode',
            Object.keys(FALLBACK_LABEL).map(function (k) {
              return [k, FALLBACK_LABEL[k]];
            }),
            s.fxFallbackMode,
          ),
          'The Bank does not publish on weekends or holidays, so this is the ordinary Monday-morning path, not an edge case.',
        ) +
        row(
          'Treat a rate as stale after',
          '<input type="number" min="1" max="90" data-setting="staleRateDays" value="' +
            esc(s.staleRateDays == null ? 5 : s.staleRateDays) +
            '" style="' +
            IN +
            'width:110px;"> <span class="muted" style="font-size:12.5px;">days</span>',
          'A proposal quoting a rate older than this carries a warning.',
        ) +
        row(
          'Proposal validity',
          '<input type="number" min="1" max="365" data-setting="proposalValidityDays" value="' +
            esc(s.proposalValidityDays == null ? 30 : s.proposalValidityDays) +
            '" style="' +
            IN +
            'width:110px;"> <span class="muted" style="font-size:12.5px;">days</span>',
          'Printed on the currency statement. The rate is re-locked on acceptance regardless.',
        ) +
        row(
          'Gates before release',
          check(
            'requireTaxReviewBeforeFinal',
            s.requireTaxReviewBeforeFinal,
            'Tax figures must be settled',
          ) +
            '<div style="height:8px;"></div>' +
            check(
              'requireCustomsReviewBeforeFinal',
              s.requireCustomsReviewBeforeFinal,
              'Customs figures must be approved',
            ) +
            '<div style="height:8px;"></div>' +
            check('allowCadPayment', s.allowCadPayment, 'Accept payment in CAD'),
          'Turning a gate off lets a Canadian proposal go out with unconfirmed border charges on it.',
        ) +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:16px;">' +
        '<button class="link-btn" data-act="saveSettings" style="' +
        BTN +
        '">Save settings</button>' +
        '</div>'
      );
    }

    /* ── Registrations ─────────────────────────────────────────────────────── */

    function registrationsHtml() {
      var fed = S.readiness && S.readiness.federalRegistration;
      var prov = (S.readiness && S.readiness.provincialRegistrations) || [];

      var rows = (fed ? [fed] : []).concat(prov);
      return (
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'GST and HST are one federal registration: a single row with no province satisfies both, in every province. ' +
        'PST, RST and QST are registered province by province, and a province with no row is a province Summit does not charge in. ' +
        'End dates are <b>exclusive</b> — a row runs up to but not including the date entered.' +
        '</div>' +
        (rows.length
          ? '<div style="margin-top:14px;">' +
            rows
              .map(function (x) {
                return (
                  '<div style="border-top:1px solid #eef0ea;padding:11px 0;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;">' +
                  '<div style="font-size:13.5px;font-weight:600;min-width:150px;">' +
                  '<span class="dot ' +
                  (x.status === 'REGISTERED' ? 'ok' : 'wait') +
                  '"></span>' +
                  esc(x.taxType) +
                  (x.province ? ' · ' + esc(x.province) : ' · federal') +
                  '</div>' +
                  '<div style="font-size:13.5px;flex:1 1 190px;font-variant-numeric:tabular-nums;">' +
                  esc(x.registrationNumber || '<no number recorded>') +
                  '</div>' +
                  '<div class="muted" style="font-size:12.5px;flex:1 1 200px;">' +
                  day(x.effectiveFrom) +
                  ' → ' +
                  (x.effectiveTo ? day(x.effectiveTo) : 'open') +
                  ' · ' +
                  esc(x.status.toLowerCase().replace('_', ' ')) +
                  '</div>' +
                  '<button class="link-btn" data-act="closeReg" data-id="' +
                  esc(x.id) +
                  '" style="width:auto;padding:5px 11px;font-size:12.5px;white-space:nowrap;">Correct</button>' +
                  '</div>' +
                  (x.notes
                    ? '<div class="muted" style="font-size:12.5px;line-height:1.5;padding-bottom:8px;">' +
                      esc(x.notes) +
                      '</div>'
                    : '')
                );
              })
              .join('') +
            '</div>'
          : '<div class="muted" style="font-size:13px;margin-top:14px;">No registrations on file. Enter the federal GST/HST number below.</div>') +
        '<div class="section-title" style="margin:24px 0 6px;">Add a registration</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
        '<label style="font-size:12.5px;color:#82877d;">Tax<br>' +
        '<select id="cbRegType" style="' +
        IN +
        'margin-top:4px;">' +
        ['GST', 'HST', 'PST', 'RST', 'QST']
          .map(function (t) {
            return '<option>' + t + '</option>';
          })
          .join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Province<br>' +
        '<select id="cbRegProv" style="' +
        IN +
        'margin-top:4px;"><option value="">federal — GST/HST</option>' +
        PROVINCES.map(function (p) {
          return '<option value="' + p[0] + '">' + esc(p[1]) + '</option>';
        }).join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Registration number<br>' +
        '<input id="cbRegNum" placeholder="123456789 RT0001" style="' +
        IN +
        'margin-top:4px;width:200px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">In force from<br>' +
        '<input id="cbRegFrom" type="date" value="' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;"></label>' +
        '<button class="link-btn" data-act="addReg" style="' +
        BTN +
        '">Add</button>' +
        '</div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:9px;">The federal number is fifteen characters: nine digits, then <b>RT</b> and a four-digit account.</div>'
      );
    }

    /* ── Tax rates ─────────────────────────────────────────────────────────── */

    /* A row is in force when it started on or before today and has not ended — and
     * `effectiveTo` is EXCLUSIVE, so a row ending today is already finished. The same
     * test the engine applies, because a screen that disagreed with the engine about
     * which rate is live would be worse than no screen. */
    function inForce(x) {
      var t = today();
      return day(x.effectiveFrom) <= t && (!x.effectiveTo || t < day(x.effectiveTo));
    }

    function ratesHtml() {
      var byProvince = {};
      S.rates.forEach(function (r) {
        (byProvince[r.province] = byProvince[r.province] || []).push(r);
      });

      var missing = PROVINCES.filter(function (p) {
        return !(byProvince[p[0]] || []).some(inForce);
      });

      return (
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'A province with no rate on file returns <b>no rate for province</b> and cannot be quoted at all — ' +
        'the engine will not guess one. Enter what the CRA or the province publishes, and record where it came from. ' +
        'A rate that genuinely <b>changed</b> is a new row with its own start date, which supersedes the old one; ' +
        'correcting a row in place restates what every proposal priced on it was quoted.' +
        '</div>' +
        (missing.length
          ? '<div style="margin-top:14px;background:#fbecea;border:1px solid #efd3ce;border-radius:9px;padding:11px 13px;font-size:13px;color:#9c3327;line-height:1.55;">' +
            '<b>' +
            missing.length +
            ' province(s) have no rate in force:</b> ' +
            esc(
              missing
                .map(function (p) {
                  return p[1];
                })
                .join(', '),
            ) +
            '.' +
            '<div style="margin-top:4px;font-size:12.5px;">A proposal billed to any of them is blocked until a rate is entered.</div></div>'
          : '<div style="margin-top:14px;background:#eef4ef;border:1px solid #cfe0d4;border-radius:9px;padding:11px 13px;font-size:13px;color:#2f6b4f;">Every province has a rate in force.</div>') +
        PROVINCES.map(function (p) {
          var rows = (byProvince[p[0]] || []).slice().sort(function (a, b) {
            return day(b.effectiveFrom) < day(a.effectiveFrom) ? -1 : 1;
          });
          if (!rows.length) return '';
          return (
            '<div style="border-top:1px solid #eef0ea;padding:12px 0;">' +
            '<div style="font-size:13.5px;font-weight:600;">' +
            esc(p[1]) +
            '</div>' +
            rows
              .map(function (x) {
                var live = inForce(x);
                return (
                  '<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin-top:7px;">' +
                  '<div style="font-size:13px;min-width:96px;">' +
                  '<span class="dot ' +
                  (live ? 'ok' : 'wait') +
                  '"></span>' +
                  esc(x.taxType) +
                  '</div>' +
                  '<div style="font-size:14px;font-weight:600;min-width:74px;font-variant-numeric:tabular-nums;">' +
                  esc(x.ratePercent) +
                  '%</div>' +
                  '<div class="muted" style="font-size:12.5px;min-width:180px;">' +
                  day(x.effectiveFrom) +
                  ' → ' +
                  (x.effectiveTo ? day(x.effectiveTo) : 'open') +
                  (live ? '' : ' · superseded') +
                  '</div>' +
                  '<div class="muted" style="font-size:12.5px;flex:1 1 220px;">' +
                  esc(x.source || 'no source recorded') +
                  '</div>' +
                  '<button class="link-btn" data-act="fixRate" data-id="' +
                  esc(x.id) +
                  '" style="width:auto;padding:5px 11px;font-size:12.5px;white-space:nowrap;">Correct</button>' +
                  '</div>'
                );
              })
              .join('') +
            '</div>'
          );
        }).join('') +
        '<div class="section-title" style="margin:24px 0 6px;">Add a rate</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
        '<label style="font-size:12.5px;color:#82877d;">Province<br>' +
        '<select id="cbRateProv" style="' +
        IN +
        'margin-top:4px;">' +
        PROVINCES.map(function (p) {
          return '<option value="' + p[0] + '">' + esc(p[1]) + '</option>';
        }).join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Tax<br>' +
        '<select id="cbRateType" style="' +
        IN +
        'margin-top:4px;">' +
        ['GST', 'HST', 'PST', 'RST', 'QST']
          .map(function (t) {
            return '<option>' + t + '</option>';
          })
          .join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Rate %<br>' +
        '<input id="cbRatePct" placeholder="9.975" style="' +
        IN +
        'margin-top:4px;width:96px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">In force from<br>' +
        '<input id="cbRateFrom" type="date" value="' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;flex:1 1 240px;min-width:200px;">Source<br>' +
        '<input id="cbRateSource" placeholder="CRA GST/HST rates page, checked ' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;width:100%;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;display:flex;gap:7px;align-items:center;padding-bottom:9px;">' +
        '<input type="checkbox" id="cbRateSupersede"> supersede the current row</label>' +
        '<button class="link-btn" data-act="addRate" style="' +
        BTN +
        '">Add</button>' +
        '</div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:9px;line-height:1.55;">' +
        'Superseding closes the row in force on the new start date, so the pair abuts exactly — the engine reads an end date as ' +
        '<b>exclusive</b>, and a gap or an overlap of one day misprices every proposal dated in it. ' +
        'HST replaces the provincial line rather than sitting beside it, and a province has one provincial sales tax, not two.' +
        '</div>' +
        taxabilityHtml()
      );
    }

    /* Whether a charge category is taxable. A rate with no rule beside it charges
     * nothing and blocks the proposal, so this belongs on the same screen. */
    function taxabilityHtml() {
      var CATEGORIES = [
        'EQUIPMENT',
        'PARTS',
        'FREIGHT',
        'INSTALLATION',
        'DESIGN',
        'TRAINING',
        'TRAVEL',
        'DISCOUNT',
        'OTHER',
      ];
      var live = S.taxability.filter(inForce);
      var covered = {};
      live.forEach(function (t) {
        covered[t.category] = covered[t.category] || {};
        covered[t.category][t.taxType] = t.taxable;
      });
      var uncovered = CATEGORIES.filter(function (c) {
        return !covered[c];
      });

      return (
        '<div class="section-title" style="margin:28px 0 6px;">What is taxable</div>' +
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'A charge category with no rule does not default to taxable or exempt — the proposal goes to review. ' +
        'That is deliberate: a freight line silently acquiring or losing 13% is the failure this avoids.' +
        '</div>' +
        (uncovered.length
          ? '<div style="margin-top:12px;background:#fdf3e3;border:1px solid #f0e0bc;border-radius:9px;padding:11px 13px;font-size:13px;color:#7a5c1a;line-height:1.55;">' +
            '<b>No rule for:</b> ' +
            esc(uncovered.join(', ').toLowerCase()) +
            '.' +
            '<div style="margin-top:4px;font-size:12.5px;">Installation into real property especially varies by province — it needs a ruling, not a guess.</div></div>'
          : '') +
        (live.length
          ? '<div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:7px;">' +
            live
              .map(function (t) {
                return (
                  '<div style="border:1px solid #eef0ea;border-radius:9px;padding:8px 11px;font-size:12.5px;">' +
                  '<b>' +
                  esc(t.category.toLowerCase()) +
                  '</b> · ' +
                  esc(t.taxType) +
                  (t.province ? ' · ' + esc(t.province) : '') +
                  '<div class="muted" style="margin-top:2px;">' +
                  (t.taxable ? 'taxable' : 'not taxable') +
                  ' from ' +
                  day(t.effectiveFrom) +
                  '</div></div>'
                );
              })
              .join('') +
            '</div>'
          : '') +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:14px;">' +
        '<label style="font-size:12.5px;color:#82877d;">Charge<br>' +
        '<select id="cbTbCat" style="' +
        IN +
        'margin-top:4px;">' +
        CATEGORIES.map(function (c) {
          return '<option value="' + c + '">' + esc(c.toLowerCase()) + '</option>';
        }).join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Tax<br>' +
        '<select id="cbTbType" style="' +
        IN +
        'margin-top:4px;">' +
        ['GST', 'HST', 'PST', 'RST', 'QST']
          .map(function (t) {
            return '<option>' + t + '</option>';
          })
          .join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Province<br>' +
        '<select id="cbTbProv" style="' +
        IN +
        'margin-top:4px;"><option value="">every province</option>' +
        PROVINCES.map(function (p) {
          return '<option value="' + p[0] + '">' + esc(p[1]) + '</option>';
        }).join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Treatment<br>' +
        '<select id="cbTbTaxable" style="' +
        IN +
        'margin-top:4px;"><option value="1">taxable</option><option value="0">not taxable</option></select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">From<br>' +
        '<input id="cbTbFrom" type="date" value="' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;flex:1 1 220px;min-width:180px;">Source<br>' +
        '<input id="cbTbSource" placeholder="Ruling from SSG’s tax adviser, Aug 2026" style="' +
        IN +
        'margin-top:4px;width:100%;"></label>' +
        '<button class="link-btn" data-act="addTaxability" style="' +
        BTN +
        '">Add</button>' +
        '</div>'
      );
    }

    /* ── Exchange rate ─────────────────────────────────────────────────────── */

    function fxHtml() {
      var obs = (S.fx && S.fx.observations) || [];
      var ovr = (S.fx && S.fx.overrides) || [];
      var live = ovr.filter(function (o) {
        return o.active !== false;
      });

      return (
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'USD/CAD from the Bank of Canada Valet API, in Canadian dollars per one US dollar. ' +
        'A proposal resolves the rate for its own date once and keeps it; acceptance re-locks a fresh one. ' +
        'A manual rate is never cached, so its warning cannot disappear on the next read.' +
        '</div>' +
        (live.length
          ? '<div style="margin-top:14px;background:#fdf3e3;border:1px solid #f0e0bc;border-radius:9px;padding:11px 13px;font-size:13px;color:#7a5c1a;line-height:1.55;">' +
            live
              .map(function (o) {
                return (
                  '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;">' +
                  '<b>Manual rate in force: ' +
                  esc(o.rate) +
                  '</b> from ' +
                  day(o.effectiveDate) +
                  '<span style="flex:1 1 auto;"></span>' +
                  '<button class="link-btn" data-act="dropOverride" data-id="' +
                  esc(o.id) +
                  '" style="width:auto;padding:4px 10px;font-size:12px;white-space:nowrap;">Withdraw</button>' +
                  '</div>' +
                  (o.reason
                    ? '<div style="font-size:12.5px;margin-top:3px;">' + esc(o.reason) + '</div>'
                    : '')
                );
              })
              .join('') +
            '</div>'
          : '') +
        (obs.length
          ? '<div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px;">' +
            obs
              .slice(0, 14)
              .map(function (o, i) {
                return (
                  '<div style="border:1px solid #eef0ea;border-radius:9px;padding:9px 11px;' +
                  (i === 0 ? 'background:#f7f9f6;' : '') +
                  '">' +
                  '<div class="muted" style="font-size:11.5px;">' +
                  day(o.observationDate) +
                  '</div>' +
                  '<div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;">' +
                  esc(o.rate) +
                  '</div></div>'
                );
              })
              .join('') +
            '</div>'
          : '<div class="muted" style="font-size:13px;margin-top:14px;">No observations fetched yet.</div>') +
        '<div class="section-title" style="margin:24px 0 6px;">Enter a manual rate</div>' +
        '<div class="muted" style="font-size:12.5px;margin-bottom:9px;max-width:660px;">Only for a Bank outage. It applies to proposals dated on or after the effective date, and every one of them prints a warning that the rate was set by hand.</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
        '<label style="font-size:12.5px;color:#82877d;">CAD per USD<br>' +
        '<input id="cbFxRate" placeholder="1.372900" style="' +
        IN +
        'margin-top:4px;width:130px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Effective from<br>' +
        '<input id="cbFxDate" type="date" value="' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;flex:1 1 260px;min-width:200px;">Reason<br>' +
        '<input id="cbFxReason" placeholder="Valet API unreachable — rate from the Bank’s daily page" style="' +
        IN +
        'margin-top:4px;width:100%;"></label>' +
        '<button class="link-btn" data-act="addOverride" style="' +
        BTN +
        '">Set the rate</button>' +
        '</div>'
      );
    }

    /* ── Brokerage ─────────────────────────────────────────────────────────── */

    function brokerHtml() {
      return (
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'Brokerage is the one border charge that can be computed in advance, because it comes off the broker’s own published tariff. ' +
        'It is still never applied on its own: the figure on a proposal is entered by a person and approved like every other customs number. ' +
        'This is what the arithmetic would say. A rate is a <b>percent</b> — 0.25 is a quarter of one percent.' +
        '</div>' +
        (S.schedules.length
          ? '<div style="margin-top:14px;">' + S.schedules.map(scheduleRow).join('') + '</div>'
          : '<div class="muted" style="font-size:13px;margin-top:14px;">No fee schedules on file. Until one exists, brokerage is typed in per proposal.</div>') +
        '<div class="section-title" style="margin:24px 0 6px;">Add a schedule</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">' +
        '<label style="font-size:12.5px;color:#82877d;flex:1 1 200px;">Name<br>' +
        '<input id="cbFeeName" placeholder="Willson International — 2026 tariff" style="' +
        IN +
        'margin-top:4px;width:100%;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Basis<br>' +
        '<select id="cbFeeType" style="' +
        IN +
        'margin-top:4px;">' +
        Object.keys(FEE_TYPE_LABEL)
          .map(function (k) {
            return '<option value="' + k + '">' + esc(FEE_TYPE_LABEL[k]) + '</option>';
          })
          .join('') +
        '</select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Amount<br>' +
        '<input id="cbFeeAmount" placeholder="0.00" style="' +
        IN +
        'margin-top:4px;width:110px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Rate %<br>' +
        '<input id="cbFeePercent" placeholder="0.25" style="' +
        IN +
        'margin-top:4px;width:90px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Minimum<br>' +
        '<input id="cbFeeMin" placeholder="0.00" style="' +
        IN +
        'margin-top:4px;width:110px;font-variant-numeric:tabular-nums;"></label>' +
        '<label style="font-size:12.5px;color:#82877d;">Currency<br>' +
        '<select id="cbFeeCurrency" style="' +
        IN +
        'margin-top:4px;"><option>CAD</option><option>USD</option></select></label>' +
        '<label style="font-size:12.5px;color:#82877d;">In force from<br>' +
        '<input id="cbFeeFrom" type="date" value="' +
        today() +
        '" style="' +
        IN +
        'margin-top:4px;"></label>' +
        '<button class="link-btn" data-act="addFee" style="' +
        BTN +
        '">Add</button>' +
        '</div>' +
        '<div class="muted" style="font-size:12.5px;margin-top:9px;">A tiered tariff needs its tier table entered by an administrator with database access for now — this form covers flat, percentage and per-unit schedules.</div>'
      );
    }

    function scheduleRow(x) {
      var inForce = x.id === S.inForceId;
      var basis = FEE_TYPE_LABEL[x.feeType] || x.feeType;
      var figure =
        x.feeType === 'PERCENTAGE'
          ? esc(x.percent) + '% of entry value'
          : x.feeType === 'TIERED'
            ? ((x.tiers && x.tiers.length) || 0) + ' tier(s)'
            : x.feeType === 'MANUAL'
              ? 'quoted each time'
              : money(x.amountMinor, x.currency);

      return (
        '<div style="border-top:1px solid #eef0ea;padding:12px 0;">' +
        '<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;">' +
        '<div style="font-size:13.5px;font-weight:600;flex:1 1 220px;min-width:180px;">' +
        '<span class="dot ' +
        (x.active ? (inForce ? 'ok' : 'wait') : 'bad') +
        '"></span>' +
        esc(x.name) +
        (inForce
          ? ' <span class="chip" style="background:#eef4ef;color:#2f6b4f;font-size:11px;padding:2px 8px;">in force</span>'
          : '') +
        (x.isDefault
          ? ' <span class="chip" style="font-size:11px;padding:2px 8px;">default</span>'
          : '') +
        (x.brokerName
          ? '<div class="muted" style="font-size:12px;font-weight:400;margin-top:2px;">' +
            esc(x.brokerName) +
            '</div>'
          : '') +
        '</div>' +
        '<div style="font-size:13px;flex:1 1 200px;">' +
        esc(basis) +
        '<div class="muted" style="font-size:12.5px;margin-top:2px;">' +
        figure +
        '</div></div>' +
        '<div class="muted" style="font-size:12.5px;flex:1 1 170px;">' +
        day(x.effectiveFrom) +
        ' → ' +
        (x.effectiveTo ? day(x.effectiveTo) : 'open') +
        (x.minMinor ? '<br>minimum ' + money(x.minMinor, x.currency) : '') +
        (x.customerPaysDirectly ? '<br>customer pays the broker' : '<br>collected by Summit') +
        '</div>' +
        '<div style="display:flex;gap:7px;align-items:center;">' +
        '<input data-role="feeValue" data-id="' +
        esc(x.id) +
        '" placeholder="entry value" style="' +
        IN +
        'width:104px;font-size:12.5px;font-variant-numeric:tabular-nums;">' +
        '<button class="link-btn" data-act="estimate" data-id="' +
        esc(x.id) +
        '" style="width:auto;padding:5px 11px;font-size:12.5px;white-space:nowrap;">What would it charge?</button>' +
        '<button class="link-btn" data-act="toggleFee" data-id="' +
        esc(x.id) +
        '" style="width:auto;padding:5px 11px;font-size:12.5px;white-space:nowrap;">' +
        (x.active ? 'Retire' : 'Reinstate') +
        '</button>' +
        '</div>' +
        '</div>' +
        '<div data-role="feeOut" data-id="' +
        esc(x.id) +
        '"></div>' +
        '</div>'
      );
    }

    /* ── Customs queue ─────────────────────────────────────────────────────── */

    function queueHtml() {
      if (!S.queue.length) {
        return '<div class="muted" style="font-size:13px;">Nothing waiting. Every Canadian proposal with a customs entry has been settled.</div>';
      }
      return (
        '<div class="muted" style="font-size:13px;line-height:1.6;max-width:680px;">' +
        'Oldest first. A proposal here cannot be released as a landed-cost quote. Open the proposal to enter or approve the figures — ' +
        'this list exists so the queue is visible from one place rather than one proposal at a time.' +
        '</div>' +
        '<div style="margin-top:14px;">' +
        S.queue
          .map(function (x) {
            var blocked = x.status === 'REQUIRES_CUSTOMS_REVIEW';
            var why = !x.hasAnyAmount
              ? 'No figures entered yet.'
              : x.missingSourceReference
                ? 'Figures entered, but no source recorded — a broker quote reference is required before approval.'
                : 'Figures entered and sourced. Waiting on an approval.';
            return (
              '<div style="border-top:1px solid #eef0ea;padding:12px 0;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;">' +
              '<div style="font-size:13px;font-weight:600;min-width:118px;">' +
              '<span class="dot ' +
              (blocked ? 'bad' : 'wait') +
              '"></span>' +
              esc(x.status === 'REQUIRES_CUSTOMS_REVIEW' ? 'review' : x.status.toLowerCase()) +
              '</div>' +
              '<div style="flex:1 1 240px;min-width:200px;">' +
              '<div style="font-size:13.5px;font-weight:600;">' +
              esc(x.proposalNumber || 'unnumbered') +
              (x.customer
                ? ' <span class="muted" style="font-weight:400;">' + esc(x.customer) + '</span>'
                : '') +
              '</div>' +
              '<div class="muted" style="font-size:12.5px;margin-top:2px;">' +
              esc(x.proposalTitle || '') +
              '</div></div>' +
              '<div class="muted" style="font-size:12.5px;flex:1 1 260px;line-height:1.55;">' +
              esc(why) +
              '</div>' +
              '<div class="muted" style="font-size:12px;min-width:96px;text-align:right;">' +
              esc(when(x.updatedAt)) +
              '</div>' +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      );
    }

    /* ── Frame ─────────────────────────────────────────────────────────────── */

    var PANELS = [
      ['readiness', 'Readiness', readinessHtml],
      ['settings', 'Settings', settingsHtml],
      ['registrations', 'Tax registrations', registrationsHtml],
      ['rates', 'Tax rates', ratesHtml],
      ['fx', 'Exchange rate', fxHtml],
      ['broker', 'Brokerage', brokerHtml],
      ['queue', 'Customs review queue', queueHtml],
    ];

    function render() {
      var queueCount = S.queue.length;
      card.innerHTML =
        '<div style="display:flex;gap:7px;flex-wrap:wrap;">' +
        PANELS.map(function (p) {
          var on = S.open === p[0];
          return (
            '<button class="link-btn" data-act="panel" data-panel="' +
            p[0] +
            '" style="width:auto;padding:7px 13px;font-size:12.5px;white-space:nowrap;' +
            (on ? 'background:#2f3a2f;color:#fff;border-color:#2f3a2f;' : '') +
            '">' +
            esc(p[1]) +
            (p[0] === 'queue' && queueCount ? ' (' + queueCount + ')' : '') +
            '</button>'
          );
        }).join('') +
        '</div>' +
        '<div style="margin-top:18px;">' +
        (PANELS.filter(function (p) {
          return p[0] === S.open;
        })[0] || PANELS[0])[2]() +
        '</div>' +
        (S.busy
          ? '<div class="muted" style="font-size:12.5px;margin-top:12px;">' + esc(S.busy) + '</div>'
          : '');

      card.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          act(b.getAttribute('data-act'), b);
        });
      });
    }

    function val(id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    }

    /* Dollars typed by a person into an integer cent count. Rounds rather than
     * truncates, so "12.345" does not quietly become 12.34. */
    function cents(text) {
      if (!text) return null;
      if (!/^\d+(\.\d{1,4})?$/.test(text)) return NaN;
      return Math.round(parseFloat(text) * 100);
    }

    async function act(kind, btn) {
      if (kind === 'panel') {
        S.open = btn.getAttribute('data-panel');
        render();
        return;
      }

      var id = btn.getAttribute('data-id');
      var call = null;

      if (kind === 'toggleFeature') {
        var turningOn = !(S.settings && S.settings.enabled);
        if (
          turningOn &&
          !confirm(
            'Turning this on changes how every Canadian-billed proposal prices, immediately. Continue?',
          )
        )
          return;
        call = ['/cross-border/settings', { method: 'PATCH', body: { enabled: turningOn } }];
      } else if (kind === 'saveSettings') {
        var body = {};
        card.querySelectorAll('[data-setting]').forEach(function (el) {
          var f = el.getAttribute('data-setting');
          if (el.type === 'checkbox') body[f] = el.checked;
          else if (el.type === 'number') body[f] = parseInt(el.value, 10);
          else body[f] = el.value;
        });
        call = ['/cross-border/settings', { method: 'PATCH', body: body }];
      } else if (kind === 'addReg') {
        var prov = val('cbRegProv');
        call = [
          '/cross-border/tax-registrations',
          {
            method: 'POST',
            body: {
              taxType: val('cbRegType'),
              province: prov || null,
              registrationNumber: val('cbRegNum') || null,
              status: 'REGISTERED',
              effectiveFrom: val('cbRegFrom'),
            },
          },
        ];
      } else if (kind === 'closeReg') {
        var to = prompt(
          'Close this registration on which date? The date is exclusive — the registration runs up to but not including it. Leave blank to reopen it.',
          today(),
        );
        if (to === null) return;
        call = [
          '/cross-border/tax-registrations/' + id,
          { method: 'PATCH', body: { effectiveTo: to || null } },
        ];
      } else if (kind === 'addRate') {
        var pct = val('cbRatePct');
        var src = val('cbRateSource');
        if (!pct || !src) {
          flash('A rate needs both the figure and where it came from.', true);
          return;
        }
        var sup = document.getElementById('cbRateSupersede');
        call = [
          '/cross-border/tax-rates',
          {
            method: 'POST',
            body: {
              province: val('cbRateProv'),
              taxType: val('cbRateType'),
              ratePercent: pct,
              effectiveFrom: val('cbRateFrom'),
              source: src,
              supersedePrevious: !!(sup && sup.checked),
            },
          },
        ];
      } else if (kind === 'fixRate') {
        var row =
          S.rates.filter(function (x) {
            return x.id === id;
          })[0] || {};
        var fixed = prompt(
          'Correct this rate in place. Use this only for a row entered wrongly — a rate that actually changed should be a new row, so the old proposals keep the rate they were quoted.\n\nRate %:',
          String(row.ratePercent == null ? '' : row.ratePercent),
        );
        if (fixed === null) return;
        var why = prompt('Where does the corrected figure come from?', row.source || '');
        if (why === null) return;
        call = [
          '/cross-border/tax-rates/' + id,
          {
            method: 'PATCH',
            body: {
              ratePercent: String(fixed).trim(),
              source: String(why).trim(),
            },
          },
        ];
      } else if (kind === 'addTaxability') {
        var tbSrc = val('cbTbSource');
        if (!tbSrc) {
          flash('Record the ruling or reference this treatment comes from.', true);
          return;
        }
        call = [
          '/cross-border/taxability',
          {
            method: 'POST',
            body: {
              category: val('cbTbCat'),
              taxType: val('cbTbType'),
              province: val('cbTbProv') || null,
              taxable: val('cbTbTaxable') === '1',
              effectiveFrom: val('cbTbFrom'),
              source: tbSrc,
            },
          },
        ];
      } else if (kind === 'addOverride') {
        if (!val('cbFxRate') || !val('cbFxReason')) {
          flash('A manual rate needs both the rate and the reason it is being set by hand.', true);
          return;
        }
        call = [
          '/cross-border/fx/override',
          {
            method: 'POST',
            body: {
              rate: val('cbFxRate'),
              effectiveDate: val('cbFxDate'),
              reason: val('cbFxReason'),
            },
          },
        ];
      } else if (kind === 'dropOverride') {
        call = ['/cross-border/fx/override/' + id + '/deactivate', { method: 'POST', body: {} }];
      } else if (kind === 'addFee') {
        var amount = cents(val('cbFeeAmount'));
        var min = cents(val('cbFeeMin'));
        if (isNaN(amount) || isNaN(min)) {
          flash('Enter amounts as plain dollars — 275 or 275.00.', true);
          return;
        }
        call = [
          '/cross-border/broker-fees',
          {
            method: 'POST',
            body: {
              name: val('cbFeeName'),
              feeType: val('cbFeeType'),
              currency: val('cbFeeCurrency'),
              amountMinor: amount,
              percent: val('cbFeePercent') || null,
              minMinor: min,
              effectiveFrom: val('cbFeeFrom'),
            },
          },
        ];
      } else if (kind === 'toggleFee') {
        var sched = S.schedules.filter(function (s) {
          return s.id === id;
        })[0];
        call = [
          '/cross-border/broker-fees/' + id,
          { method: 'PATCH', body: { active: !(sched && sched.active) } },
        ];
      } else if (kind === 'estimate') {
        return estimate(id);
      }

      if (!call) return;
      S.busy = 'Saving…';
      btn.disabled = true;
      var r = await authed(call[0], call[1]);
      var out = null;
      try {
        out = await r.json();
      } catch (e) {}
      S.busy = '';
      if (!r.ok) {
        // The routes refuse things for stated reasons — enabling with no GST/HST
        // registration, a percentage schedule with no rate — and the reason is the
        // useful part, so it is shown verbatim rather than as a status code.
        flash(
          (out && (out.message || out.error)) || 'That did not go through (' + r.status + ').',
          true,
        );
        render();
        return;
      }
      return load();
    }

    /* The itemized estimate, inline under its schedule. Read-only: nothing about a
     * proposal changes here, and the number still has to be typed on the proposal by
     * the person who will answer for it. */
    async function estimate(id) {
      var input = card.querySelector('[data-role="feeValue"][data-id="' + id + '"]');
      var out = card.querySelector('[data-role="feeOut"][data-id="' + id + '"]');
      if (!out) return;
      var v = cents(input ? input.value.trim() : '');
      if (v == null || isNaN(v)) {
        out.innerHTML =
          '<div class="muted" style="font-size:12.5px;margin-top:8px;">Enter the entry value first, in the schedule’s own currency.</div>';
        return;
      }
      out.innerHTML = '<div class="muted" style="font-size:12.5px;margin-top:8px;">Working…</div>';
      var r = await authed('/cross-border/broker-fees/' + id + '/estimate?valueMinor=' + v);
      if (!r.ok) {
        out.innerHTML =
          '<div class="err" style="margin:8px 0 0;">Could not estimate (' + r.status + ').</div>';
        return;
      }
      var e = await r.json();
      if (e.amountMinor == null) {
        out.innerHTML =
          '<div style="margin-top:8px;background:#fdf3e3;border:1px solid #f0e0bc;border-radius:9px;padding:9px 12px;font-size:12.5px;color:#7a5c1a;">' +
          esc(e.unavailableReason || 'No figure from this schedule.') +
          '</div>';
        return;
      }
      out.innerHTML =
        '<div style="margin-top:9px;background:#f7f9f6;border:1px solid #e6ebe4;border-radius:9px;padding:10px 13px;">' +
        e.components
          .map(function (c) {
            return (
              '<div style="display:flex;justify-content:space-between;gap:14px;font-size:12.5px;padding:2px 0;">' +
              '<span class="muted">' +
              esc(c.label) +
              '</span>' +
              '<span style="font-variant-numeric:tabular-nums;">' +
              money(c.amountMinor, '') +
              '</span></div>'
            );
          })
          .join('') +
        '<div style="display:flex;justify-content:space-between;gap:14px;font-size:13.5px;font-weight:600;border-top:1px solid #e6ebe4;margin-top:6px;padding-top:6px;">' +
        '<span>Brokerage</span><span style="font-variant-numeric:tabular-nums;">' +
        money(e.amountMinor, e.currency) +
        '</span></div>' +
        '<div class="muted" style="font-size:12px;margin-top:6px;line-height:1.5;">An estimate off the tariff. Enter it on the proposal and have it approved like any other customs figure.</div>' +
        '</div>';
    }

    function flash(msg, bad) {
      var el = document.createElement('div');
      el.className = bad ? 'err' : '';
      el.style.cssText = bad
        ? 'margin:14px 0 0;'
        : 'margin:14px 0 0;background:#eef4ef;border:1px solid #cfe0d4;color:#2f6b4f;font-size:13px;padding:9px 12px;border-radius:9px;';
      el.textContent = msg;
      card.appendChild(el);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 10000);
    }
  }

  /* ── Self-mount ──────────────────────────────────────────────────────────────
   * app.js renders each screen by replacing #view and writing the name into
   * #viewTitle, so: when the DOM settles on Administration and the panel is not
   * there, append it. It re-mounts naturally, because app.js discards our container
   * along with the rest of the screen. */
  function onAdminScreen() {
    var t = document.getElementById('viewTitle');
    return !!t && t.textContent.trim() === 'Administration';
  }

  function tryMount() {
    if (!onAdminScreen()) return;
    var view = document.getElementById('view');
    if (!view) return;
    var slot = document.getElementById('crossBorderPanel');
    if (slot && slot.getAttribute('data-cb-mounted') === '1') return;
    if (!slot) {
      slot = document.createElement('div');
      slot.id = 'crossBorderPanel';
      view.appendChild(slot);
    }
    slot.setAttribute('data-cb-mounted', '1');
    try {
      mount(slot, {});
    } catch (e) {
      slot.removeAttribute('data-cb-mounted');
      // A panel that fails must not take the Administration screen with it.
      console.error('cross-border panel failed to mount', e);
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

  window.SSGCrossBorder = { mount: mount };
})();

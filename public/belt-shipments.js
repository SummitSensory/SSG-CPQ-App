/*
 * Belt shipments.
 *
 * Answers two questions and nothing else:
 *
 *   1. Which customers are owed a belt, and which belt?
 *   2. What goes in the box, on a slip the customer can read?
 *
 * The list is read off each customer's bill of materials — belts are already on the
 * BOM as procurement lines, so nothing is typed twice and nothing can be missed
 * because someone forgot to add it here. Shipping a belt credits that BOM line and
 * takes it off the list; a partial shipment leaves the balance owed.
 *
 * Deliberately narrow: no freight, no prices, no proposal linkage. See
 * routes/beltShipments.ts for where the list comes from and what is stored.
 */
(function () {
  'use strict';

  var H = null;
  var data = null;
  /** lineId -> pieces going in this box. */
  var picked = {};
  var busy = false;

  var INK = '#20241f',
    NAVY = '#203060',
    MUTE = '#7b8190',
    LINE = '#dfe3ec',
    RED = '#d02030';
  var SERIF = "'Newsreader',Georgia,serif";
  var FIELD =
    'width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
    LINE +
    ';border-radius:7px;font-family:inherit;box-sizing:border-box;';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (p.length !== 3 || !mo[Number(p[1]) - 1]) return String(iso);
    return mo[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  /** A recorded moment, in the reader's own timezone. */
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return fmtDate(iso) + ' at ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /** Whole days since a date. Drives the ageing flag. */
  function daysSince(iso) {
    var t = Date.parse(String(iso) + 'T00:00:00');
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }

  /* ------------------------------------------------------------------- state */

  function load() {
    return H.authed('/belt-shipments')
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        data = d || { owed: [], slips: [] };
        data.owed = data.owed || [];
        data.slips = data.slips || [];
        return data;
      })
      .catch(function () {
        data = { owed: [], slips: [], failed: true };
        return data;
      });
  }

  /* -------------------------------------------------------------------- slip */

  /**
   * The document that goes in the box.
   *
   * One sheet, no prices, and it says what is enclosed and what is still to come — a
   * customer opening a short shipment should not have to phone to find out whether
   * the rest is coming.
   */
  function slipHtml(slip, outstanding) {
    var rows = slip.lines
      .map(function (l) {
        return (
          '<tr>' +
          '<td style="padding:9px 0;font-size:12.5px;color:' +
          INK +
          ';vertical-align:top;">' +
          esc(l.item) +
          '</td>' +
          '<td style="padding:9px 10px;font-size:11px;color:' +
          MUTE +
          ';white-space:nowrap;vertical-align:top;font-variant-numeric:tabular-nums;">' +
          esc(l.sku) +
          '</td>' +
          '<td style="padding:9px 0 9px 10px;font-size:14px;font-weight:700;text-align:right;color:' +
          INK +
          ';vertical-align:top;font-variant-numeric:tabular-nums;">' +
          l.qty +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    var pieces = slip.lines.reduce(function (a, l) {
      return a + l.qty;
    }, 0);

    return (
      '<div class="ssg-sheet" style="width:816px;height:1056px;box-sizing:border-box;padding:64px 72px;' +
      "background:#fff;margin:0 auto;position:relative;overflow:hidden;font-family:'IBM Plex Sans',sans-serif;color:" +
      INK +
      ';' +
      'border-bottom:10px solid ' +
      NAVY +
      ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">' +
      '<div style="display:flex;gap:14px;align-items:center;">' +
      '<img src="logo.png" alt="Summit Sensory Gym" style="width:58px;height:58px;display:block;flex:none;">' +
      '<div>' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:21px;font-weight:700;color:' +
      NAVY +
      ';letter-spacing:-.012em;">Summit Sensory Gym</div>' +
      '<div style="font-size:10px;color:' +
      MUTE +
      ';margin-top:2px;">6150 S Geneva Ct, Englewood, CO 80111 &middot; (720) 457-5500</div>' +
      '</div>' +
      '</div>' +
      '<div style="text-align:right;flex:none;">' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:22px;font-weight:700;color:' +
      NAVY +
      ';letter-spacing:-.015em;">Packing Slip</div>' +
      '<div style="font-size:11px;color:' +
      MUTE +
      ';margin-top:3px;font-variant-numeric:tabular-nums;">' +
      esc(slip.number) +
      '</div>' +
      (slip.proposalNumber
        ? '<div style="font-size:10.5px;color:' +
          MUTE +
          ';margin-top:6px;">Proposal ' +
          esc(slip.proposalNumber) +
          '</div>'
        : '') +
      '</div>' +
      '</div>' +
      '<div style="height:2px;background:' +
      NAVY +
      ';margin:26px 0 0;"></div>' +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:32px;padding:22px 0 24px;border-bottom:1px solid ' +
      LINE +
      ';">' +
      '<div>' +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.18em;color:' +
      MUTE +
      ';font-weight:700;">Shipped to</div>' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:19px;font-weight:600;margin-top:6px;line-height:1.35;">' +
      esc(slip.customer) +
      '</div>' +
      (slip.attention
        ? '<div style="font-size:12px;color:#4b5468;line-height:1.6;margin-top:4px;">Attn: ' +
          esc(slip.attention) +
          '</div>'
        : '') +
      (slip.address
        ? '<div style="font-size:12px;color:#4b5468;line-height:1.6;margin-top:' +
          (slip.attention ? '2' : '5') +
          'px;white-space:pre-line;">' +
          esc(slip.address) +
          '</div>'
        : '') +
      '</div>' +
      '<div style="text-align:right;">' +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.18em;color:' +
      MUTE +
      ';font-weight:700;">Date shipped</div>' +
      '<div style="font-size:14px;margin-top:6px;">' +
      esc(fmtDate(slip.date)) +
      '</div>' +
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.18em;color:' +
      MUTE +
      ';font-weight:700;margin-top:16px;">Pieces enclosed</div>' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:26px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums;">' +
      pieces +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.18em;color:' +
      NAVY +
      ';font-weight:700;margin:26px 0 4px;">Enclosed in this package</div>' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<thead><tr>' +
      '<th style="text-align:left;padding:8px 0;font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;color:' +
      MUTE +
      ';border-bottom:1px solid ' +
      LINE +
      ';font-weight:700;">Item</th>' +
      '<th style="text-align:left;padding:8px 10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;color:' +
      MUTE +
      ';border-bottom:1px solid ' +
      LINE +
      ';font-weight:700;">SKU</th>' +
      '<th style="text-align:right;padding:8px 0 8px 10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;color:' +
      MUTE +
      ';border-bottom:1px solid ' +
      LINE +
      ';font-weight:700;">Qty</th>' +
      '</tr></thead><tbody>' +
      rows +
      '</tbody>' +
      '</table>' +
      (outstanding && outstanding.length
        ? '<div style="margin-top:30px;padding:18px 20px;background:#fdf3f2;border-left:3px solid ' +
          RED +
          ';">' +
          '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.16em;font-weight:700;color:' +
          RED +
          ';">Still to come</div>' +
          '<div style="font-size:12px;color:' +
          INK +
          ';line-height:1.75;margin-top:7px;">' +
          outstanding
            .map(function (o) {
              return esc(o.item) + ' &mdash; ' + o.qty;
            })
            .join('<br>') +
          '</div>' +
          '<div style="font-size:11px;color:#8a5f5a;line-height:1.6;margin-top:9px;">These items are on order and will ship separately at no additional charge.</div>' +
          '</div>'
        : '') +
      (slip.note
        ? '<div style="margin-top:26px;padding-top:14px;border-top:1px solid ' +
          LINE +
          ';font-size:12px;color:#4b5468;line-height:1.7;white-space:pre-line;">' +
          esc(slip.note) +
          '</div>'
        : '') +
      (slip.shippedBy
        ? '<div style="margin-top:22px;font-size:11px;color:' +
          MUTE +
          ';">Packed by ' +
          esc(slip.shippedBy) +
          '</div>'
        : '') +
      '<div style="position:absolute;left:72px;right:72px;bottom:34px;display:flex;justify-content:space-between;' +
      'align-items:baseline;gap:20px;padding-top:10px;border-top:1px solid ' +
      LINE +
      ';font-size:9.5px;color:#9aa1b0;">' +
      '<span>Questions about this shipment? (720) 457-5500 &middot; Sales@SummitSensory.com</span>' +
      '<span>No prices are shown on this document.</span>' +
      '</div>' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------------ screen */

  /** Owed belts, grouped by customer — that is how a box gets packed. */
  function owedHtml() {
    var groups = {};
    (data.owed || []).forEach(function (o) {
      (groups[o.orgId] = groups[o.orgId] || { customer: o.customer, rows: [] }).rows.push(o);
    });
    var keys = Object.keys(groups).sort(function (a, b) {
      return groups[a].customer.localeCompare(groups[b].customer);
    });
    if (!keys.length) {
      return '<div class="muted" style="padding:22px 0;font-size:13px;">No belts are outstanding. Every belt on every bill of materials has shipped.</div>';
    }

    return keys
      .map(function (k) {
        var g = groups[k];
        var anyPicked = g.rows.some(function (r) {
          return picked[r.lineId];
        });
        var oldest = g.rows.reduce(function (a, r) {
          return Math.max(a, daysSince(r.orderedOn));
        }, 0);
        var refs = g.rows
          .map(function (r) {
            return r.proposalNumber || r.orderNumber;
          })
          .filter(function (v, i, arr) {
            return v && arr.indexOf(v) === i;
          });

        return (
          '<div style="border:1px solid ' +
          LINE +
          ';border-radius:9px;padding:13px 15px;margin-bottom:9px;background:#fff;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;">' +
          '<div style="min-width:0;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:600;">' +
          esc(g.customer) +
          '</div>' +
          '<div style="font-size:10.5px;color:' +
          MUTE +
          ';margin-top:2px;">' +
          esc(refs.join(' \u00b7 ')) +
          '</div>' +
          '</div>' +
          '<div style="display:flex;gap:12px;align-items:baseline;flex:none;">' +
          (oldest >= 30
            ? '<span style="font-size:10px;font-weight:700;color:' +
              RED +
              ';text-transform:uppercase;letter-spacing:.12em;">' +
              oldest +
              ' days</span>'
            : '') +
          '<button type="button" class="link-btn bsPickAll" data-org="' +
          esc(k) +
          '" style="width:auto;padding:4px 10px;font-size:11px;">' +
          (anyPicked ? 'Clear' : 'Select all') +
          '</button>' +
          '</div>' +
          '</div>' +
          g.rows
            .map(function (r) {
              var on = picked[r.lineId] != null;
              return (
                '<div style="display:flex;gap:11px;align-items:flex-start;padding:8px 0 0;">' +
                '<input type="checkbox" class="bsPick" data-id="' +
                esc(r.lineId) +
                '"' +
                (on ? ' checked' : '') +
                ' style="margin-top:3px;flex:none;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:12.5px;line-height:1.5;">' +
                esc(r.item) +
                (r.sku
                  ? ' <span style="color:' + MUTE + ';font-size:11px;">' + esc(r.sku) + '</span>'
                  : '') +
                '</div>' +
                '<div style="font-size:10.5px;color:#b0b6c2;margin-top:2px;">' +
                'Ordered ' +
                esc(fmtDate(r.orderedOn)) +
                (r.shipped ? ' \u00b7 ' + r.shipped + ' of ' + r.ordered + ' shipped' : '') +
                '</div>' +
                '</div>' +
                '<div style="flex:none;text-align:right;">' +
                (on
                  ? '<div style="display:flex;align-items:baseline;gap:6px;">' +
                    '<input type="number" class="bsQty" data-id="' +
                    esc(r.lineId) +
                    '" min="1" max="' +
                    r.remaining +
                    '" value="' +
                    picked[r.lineId] +
                    '" ' +
                    'style="width:56px;padding:4px 6px;font-size:13px;font-weight:700;text-align:right;border:1px solid ' +
                    NAVY +
                    ';border-radius:6px;font-family:inherit;">' +
                    '<span style="font-size:11px;color:' +
                    MUTE +
                    ';white-space:nowrap;">of ' +
                    r.remaining +
                    '</span>' +
                    '</div>'
                  : '<span style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;">' +
                    r.remaining +
                    '</span>') +
                '</div>' +
                '</div>'
              );
            })
            .join('') +
          '</div>'
        );
      })
      .join('');
  }

  /**
   * The shipping record: every slip, who printed it, when, and whether it was
   * withdrawn. Newest first, because the question is almost always "what just went
   * out" rather than "what went out in June".
   */
  function slipsHtml() {
    var all = (data.slips || []).slice().reverse();
    if (!all.length)
      return '<div class="muted" style="font-size:12.5px;padding:8px 0;">No slips yet.</div>';
    var recent = all.slice(0, 25);

    return (
      recent
        .map(function (s) {
          var pieces = s.lines.reduce(function (a, l) {
            return a + l.qty;
          }, 0);
          var dead = !!s.voidedAt;
          return (
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid #eef0f4;' +
            (dead ? 'opacity:.62;' : '') +
            '">' +
            '<div style="min-width:0;">' +
            '<div style="font-size:12.5px;' +
            (dead ? 'text-decoration:line-through;' : '') +
            '">' +
            esc(s.customer) +
            '</div>' +
            '<div style="font-size:10.5px;color:' +
            MUTE +
            ';margin-top:2px;font-variant-numeric:tabular-nums;">' +
            esc(s.number) +
            ' \u00b7 ' +
            pieces +
            ' pc' +
            (s.proposalNumber ? ' \u00b7 ' + esc(s.proposalNumber) : '') +
            '</div>' +
            '<div style="font-size:10.5px;color:#b0b6c2;margin-top:3px;">' +
            (s.shippedBy ? esc(s.shippedBy) + ' \u00b7 ' : '') +
            esc(fmtStamp(s.shippedAt) || fmtDate(s.date)) +
            '</div>' +
            (dead
              ? '<div style="font-size:10.5px;color:' +
                RED +
                ';margin-top:3px;font-weight:600;">Voided by ' +
                esc(s.voidedBy || 'unknown') +
                ' \u00b7 ' +
                esc(fmtStamp(s.voidedAt)) +
                '</div>'
              : '') +
            '</div>' +
            '<div style="display:flex;gap:6px;flex:none;">' +
            '<button type="button" class="link-btn bsReprint" data-id="' +
            esc(s.id) +
            '" style="width:auto;padding:4px 10px;font-size:11px;">Reprint</button>' +
            (dead
              ? ''
              : '<button type="button" class="link-btn bsVoid" data-id="' +
                esc(s.id) +
                '" title="Not shipped after all \u2014 put these belts back on the list" style="width:auto;padding:4px 10px;font-size:11px;color:' +
                RED +
                ';">Void</button>') +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      (all.length > recent.length
        ? '<div class="muted" style="font-size:11px;padding-top:9px;">Showing the ' +
          recent.length +
          ' most recent of ' +
          all.length +
          '.</div>'
        : '')
    );
  }

  /**
   * Who has shipped what, so the work can be managed rather than just recorded.
   * Voided slips are excluded — a withdrawn slip is not work done.
   */
  function activityHtml() {
    var live = (data.slips || []).filter(function (s) {
      return !s.voidedAt;
    });
    if (!live.length) return '';

    var since = Date.now() - 30 * 86400000;
    var by = {};
    live.forEach(function (s) {
      var t = Date.parse(s.shippedAt || s.date);
      if (isNaN(t) || t < since) return;
      var who = s.shippedBy || 'Unrecorded';
      var e = (by[who] = by[who] || { slips: 0, pieces: 0, last: 0 });
      e.slips += 1;
      e.pieces += s.lines.reduce(function (a, l) {
        return a + l.qty;
      }, 0);
      e.last = Math.max(e.last, t);
    });
    var names = Object.keys(by).sort(function (a, b) {
      return by[b].pieces - by[a].pieces;
    });
    if (!names.length) return '';

    return (
      '<div class="card" style="margin-bottom:14px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Who shipped what</div>' +
      '<div class="muted" style="font-size:11.5px;margin-bottom:8px;">Last 30 days. Voided slips excluded.</div>' +
      names
        .map(function (n) {
          var e = by[n];
          return (
            '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-top:1px solid #eef0f4;">' +
            '<div style="min-width:0;">' +
            '<div style="font-size:12.5px;">' +
            esc(n) +
            '</div>' +
            '<div style="font-size:10.5px;color:#b0b6c2;margin-top:2px;">Last ' +
            esc(fmtStamp(new Date(e.last).toISOString())) +
            '</div>' +
            '</div>' +
            '<div style="text-align:right;flex:none;font-variant-numeric:tabular-nums;">' +
            '<div style="font-size:15px;font-weight:700;">' +
            e.pieces +
            '</div>' +
            '<div style="font-size:10.5px;color:' +
            MUTE +
            ';">' +
            e.slips +
            ' slip' +
            (e.slips === 1 ? '' : 's') +
            '</div>' +
            '</div>' +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function paint() {
    var host = document.getElementById('view');
    if (!host) return;

    var rows = (data.owed || []).filter(function (o) {
      return picked[o.lineId] != null;
    });
    var orgs = {};
    rows.forEach(function (r) {
      orgs[r.orgId] = r;
    });
    var orgKeys = Object.keys(orgs);
    var one = orgKeys.length === 1 ? orgs[orgKeys[0]] : null;
    var short =
      one &&
      rows.some(function (r) {
        return picked[r.lineId] < r.remaining;
      });

    host.innerHTML =
      (data.failed
        ? '<div class="card" style="margin-bottom:14px;border-color:#f0c9c4;background:#fdf3f2;">' +
          '<div style="font-size:12.5px;color:#8a2f24;">The shipment list could not be loaded. Reload the page to try again.</div></div>'
        : '') +
      '<div style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.85fr);gap:18px;align-items:start;">' +
      '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:4px;">' +
      '<div class="section-title" style="margin:0;">Belts to ship</div>' +
      '<div class="muted" style="font-size:12px;">' +
      (data.owed || []).length +
      ' outstanding</div>' +
      '</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:12px;">Read from each customer&rsquo;s bill of materials. Tick what is going in the box, then print the slip.</div>' +
      owedHtml() +
      '</div>' +
      '<div>' +
      '<div class="card" style="margin-bottom:14px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Print a slip</div>' +
      (!rows.length
        ? '<div class="muted" style="font-size:12.5px;line-height:1.6;">Tick belts on the left to build a slip.</div>'
        : !one
          ? '<div style="font-size:12.5px;color:' +
            RED +
            ';line-height:1.6;">Belts for ' +
            orgKeys.length +
            ' customers are ticked. A slip goes in one box, so pick one customer at a time.</div>'
          : '<div class="muted" style="font-size:12px;margin-bottom:11px;">' +
            rows.reduce(function (a, r) {
              return a + picked[r.lineId];
            }, 0) +
            ' piece' +
            (rows.reduce(function (a, r) {
              return a + picked[r.lineId];
            }, 0) === 1
              ? ''
              : 's') +
            ' for <b style="color:' +
            INK +
            ';">' +
            esc(one.customer) +
            '</b></div>' +
            (short
              ? '<div style="font-size:11.5px;color:' +
                RED +
                ';line-height:1.55;margin-bottom:10px;">Shipping short &mdash; the balance stays on the list.</div>'
              : '') +
            // The proposal's own contact, or failing that the customer's first
            // contact on file — an older order may predate the snapshot that
            // carries the proposal's. Either way it stays editable.
            '<label style="display:block;margin-bottom:9px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Attention</span>' +
            '<input id="bsAttn" list="bsContacts" placeholder="Who should open it?" value="' +
            esc(one.contactName || (one.contacts || [])[0] || '') +
            '" style="' +
            FIELD +
            '"></label>' +
            '<div class="muted" style="font-size:11px;margin:-4px 0 9px;">' +
            (one.contactName
              ? 'The contact on proposal ' + esc(one.proposalNumber || '') + '.'
              : (one.contacts || [])[0]
                ? 'From the customer record \u2014 proposal ' +
                  esc(one.proposalNumber || '') +
                  ' has no contact on it.'
                : 'No contact on file. Type who should open the box.') +
            '</div>' +
            '<datalist id="bsContacts">' +
            (one.contacts || [])
              .map(function (c) {
                return '<option value="' + esc(c) + '">';
              })
              .join('') +
            '</datalist>' +
            '<label style="display:block;margin-bottom:9px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Ship-to address</span>' +
            '<textarea id="bsAddr" rows="3" placeholder="Street, city, state, ZIP" style="' +
            FIELD +
            'resize:vertical;">' +
            esc(one.address || '') +
            '</textarea></label>' +
            (one.address
              ? '<div class="muted" style="font-size:11px;margin:-4px 0 9px;">From the customer record. Edit if this box goes elsewhere.</div>'
              : '') +
            '<label style="display:block;margin-bottom:11px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Message on the slip (optional)</span>' +
            '<input id="bsSlipNote" placeholder="Thanks for your order&hellip;" style="' +
            FIELD +
            '"></label>' +
            '<button type="button" id="bsPrint" class="btn" style="width:100%;">Print the slip</button>') +
      '</div>' +
      activityHtml() +
      '<div class="card">' +
      '<div class="section-title" style="margin:0 0 6px;">Shipping record</div>' +
      slipsHtml() +
      '</div>' +
      '</div>' +
      '</div>';

    wire();
  }

  function wire() {
    var host = document.getElementById('view');
    if (!host) return;

    host.querySelectorAll('.bsPick').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-id');
        var row = (data.owed || []).filter(function (o) {
          return o.lineId === id;
        })[0];
        if (cb.checked && row) picked[id] = row.remaining;
        else delete picked[id];
        paint();
      });
    });

    host.querySelectorAll('.bsQty').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = inp.getAttribute('data-id');
        var row = (data.owed || []).filter(function (o) {
          return o.lineId === id;
        })[0];
        if (!row) return;
        picked[id] = Math.min(row.remaining, Math.max(1, Number(inp.value) || 1));
        paint();
      });
    });

    host.querySelectorAll('.bsPickAll').forEach(function (b) {
      b.addEventListener('click', function () {
        var org = b.getAttribute('data-org');
        var rows = (data.owed || []).filter(function (o) {
          return o.orgId === org;
        });
        var anyPicked = rows.some(function (r) {
          return picked[r.lineId] != null;
        });
        rows.forEach(function (r) {
          if (anyPicked) delete picked[r.lineId];
          else picked[r.lineId] = r.remaining;
        });
        paint();
      });
    });

    host.querySelectorAll('.bsReprint').forEach(function (b) {
      b.addEventListener('click', function () {
        var slip = (data.slips || []).filter(function (s) {
          return s.id === b.getAttribute('data-id');
        })[0];
        if (slip) openSlip(slip, []);
      });
    });

    host.querySelectorAll('.bsVoid').forEach(function (b) {
      b.addEventListener('click', function () {
        var slip = (data.slips || []).filter(function (s) {
          return s.id === b.getAttribute('data-id');
        })[0];
        if (!slip) return;
        if (
          !confirm(
            'Void ' +
              slip.number +
              '?\n\nUse this when the box did not go out. The belts return to Belts to ship, and the slip stays on the record marked voided against your name.',
          )
        )
          return;
        H.authed('/belt-shipments/void', { method: 'POST', body: { slipId: slip.id } })
          .then(function (r) {
            if (!r.ok) {
              alert('That slip could not be voided.');
              return;
            }
            picked = {};
            load().then(paint);
          })
          .catch(function () {
            alert('Could not reach the server.');
          });
      });
    });

    var print = host.querySelector('#bsPrint');
    if (print) print.addEventListener('click', ship);
  }

  /**
   * Record the shipment, then show the slip.
   *
   * The server credits the BOM lines and assigns the slip number, so two people
   * shipping at once cannot produce the same number or double-credit a line.
   */
  function ship() {
    if (busy) return;
    var host = document.getElementById('view');
    var rows = (data.owed || []).filter(function (o) {
      return picked[o.lineId] != null;
    });
    if (!rows.length) return;
    var orgId = rows[0].orgId;
    if (
      rows.some(function (r) {
        return r.orgId !== orgId;
      })
    )
      return;

    busy = true;
    var body = {
      slip: {
        orgId: orgId,
        customer: rows[0].customer,
        proposalNumber: rows[0].proposalNumber || '',
        attention: (host.querySelector('#bsAttn') || {}).value || '',
        date: todayISO(),
        address: (host.querySelector('#bsAddr') || {}).value || '',
        note: (host.querySelector('#bsSlipNote') || {}).value || '',
        lines: rows.map(function (r) {
          return { lineId: r.lineId, sku: r.sku, item: r.item, qty: picked[r.lineId] };
        }),
      },
    };

    H.authed('/belt-shipments/ship', { method: 'POST', body: body })
      .then(async function (r) {
        busy = false;
        if (!r.ok) {
          var d = null;
          try {
            d = await r.json();
          } catch (e) {
            /* no body */
          }
          alert((d && d.message) || 'That shipment could not be recorded.');
          return;
        }
        var slip = (await r.json()).slip;
        picked = {};
        // Reload before showing the slip so "Still to come" is the truth after this box.
        load().then(function () {
          var outstanding = (data.owed || [])
            .filter(function (o) {
              return o.orgId === orgId;
            })
            .map(function (o) {
              return { item: o.item, qty: o.remaining };
            });
          paint();
          openSlip(slip, outstanding);
        });
      })
      .catch(function () {
        busy = false;
        alert('Could not reach the server. Nothing was recorded.');
      });
  }

  /** Show one slip, ready to print. */
  function openSlip(slip, outstanding) {
    var prev = document.getElementById('bsSlipOverlay');
    if (prev) prev.remove();
    var ov = document.createElement('div');
    ov.id = 'bsSlipOverlay';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9000;background:#e8ebf2;overflow:auto;padding:26px 16px 60px;';
    ov.innerHTML =
      '<div style="display:flex;justify-content:center;gap:10px;margin-bottom:20px;" data-noprint>' +
      '<button type="button" id="bsSlipPrint" class="btn" style="width:auto;padding:10px 20px;">Print / Save PDF</button>' +
      '<button type="button" id="bsSlipClose" class="link-btn" style="width:auto;padding:10px 20px;">Close</button>' +
      '</div>' +
      slipHtml(slip, outstanding || []);
    document.body.appendChild(ov);
    ov.querySelector('#bsSlipClose').addEventListener('click', function () {
      ov.remove();
    });
    ov.querySelector('#bsSlipPrint').addEventListener('click', function () {
      // One fixed sheet, so this owns its own print rules rather than borrowing the
      // proposal's page-packing.
      var st = document.createElement('style');
      st.textContent =
        '@media print{@page{size:letter;margin:0;}' +
        'body>*{display:none!important;}' +
        '#bsSlipOverlay{display:block!important;position:static!important;padding:0!important;background:#fff!important;}' +
        '#bsSlipOverlay [data-noprint]{display:none!important;}' +
        '#bsSlipOverlay .ssg-sheet{width:8.5in!important;height:11in!important;margin:0!important;box-shadow:none!important;overflow:hidden!important;}}';
      document.head.appendChild(st);
      window.print();
      setTimeout(function () {
        st.remove();
      }, 400);
    });
  }

  window.SSGBeltShipments = {
    init: function (helpers) {
      H = helpers;
    },
    /** Render the screen into #view. */
    mount: function () {
      var host = document.getElementById('view');
      if (host) host.innerHTML = '<div class="muted" style="padding:18px;">Loading&hellip;</div>';
      picked = {};
      load().then(paint);
    },
  };
})();

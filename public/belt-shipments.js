/*
 * Belt shipments.
 *
 * Two jobs, and deliberately nothing else:
 *
 *   1. A list of belts owed to customers, so nothing is forgotten.
 *   2. A slip to put in the box telling the customer what is inside it.
 *
 * Scope is about ten belt SKUs shipped by hand from our own facility. This is not
 * order fulfilment: no freight, no BOM, no proposal linkage, no prices. A belt is
 * owed to a customer, then it ships, and the slip is the receipt in the box.
 *
 * State lives server-side (routes/beltShipments.ts) so the list is the same list for
 * everyone. The slip owns its own print rules — it is a single fixed Letter sheet, so
 * it needs none of the measuring and page-packing the proposal document requires.
 */
(function () {
  'use strict';

  var H = null;
  var state = null;
  /**
   * Rows ticked for the slip being built: owed-row id -> quantity going in this box.
   * Defaults to the whole amount owed; a smaller number ships part of the row and
   * leaves the rest on the list.
   */
  var picked = {};
  var busy = false;

  /**
   * The belts this screen ships. Seven sizes of one product, which is the entire
   * scope — anything beyond it can be added on the screen.
   */
  var DEFAULT_CATALOG = [
    { sku: 'FLEX-BELT-XXS', item: 'Flex Belt \u2014 XXS' },
    { sku: 'FLEX-BELT-XS', item: 'Flex Belt \u2014 XS' },
    { sku: 'FLEX-BELT-S', item: 'Flex Belt \u2014 S' },
    { sku: 'FLEX-BELT-M', item: 'Flex Belt \u2014 M' },
    { sku: 'FLEX-BELT-L', item: 'Flex Belt \u2014 L' },
    { sku: 'FLEX-BELT-XL', item: 'Flex Belt \u2014 XL' },
    { sku: 'FLEX-BELT-XXL', item: 'Flex Belt \u2014 XXL' },
  ];

  var INK = '#20241f',
    NAVY = '#203060',
    MUTE = '#7b8190',
    LINE = '#dfe3ec',
    RED = '#d02030';
  var SERIF = "'Newsreader',Georgia,serif";

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var p = String(iso).slice(0, 10).split('-');
    var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (p.length !== 3 || !mo[Number(p[1]) - 1]) return String(iso);
    return mo[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
  }

  /** Whole days since a row was added. Drives the ageing flag. */
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
        state = d || { catalog: null, owed: [], slips: [], seq: 0 };
        // A list that has never been saved starts with the seven Flex belts. An empty
        // saved list is left empty — that means someone deliberately cleared it.
        state.catalog = state.catalog || DEFAULT_CATALOG.slice();
        state.owed = state.owed || [];
        state.slips = state.slips || [];
        state.seq = state.seq || 0;
        return state;
      })
      .catch(function () {
        state = { catalog: DEFAULT_CATALOG.slice(), owed: [], slips: [], seq: 0 };
        return state;
      });
  }

  /** Persist, then repaint. The list is small, so the whole document goes each time. */
  function save() {
    if (busy) return Promise.resolve();
    busy = true;
    return H.authed('/belt-shipments', { method: 'PUT', body: state })
      .then(function (r) {
        busy = false;
        if (!r.ok) alert('That change could not be saved.');
        paint();
      })
      .catch(function () {
        busy = false;
        alert('Could not reach the server. That change was not saved.');
      });
  }

  /* -------------------------------------------------------------------- slip */

  /**
   * The document that goes in the box.
   *
   * One sheet, no prices, and it says what is enclosed and what is still to come —
   * a customer opening a short shipment should not have to phone to find out whether
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
      '</div>' +
      '</div>' +
      '<div style="height:2px;background:' +
      NAVY +
      ';margin:26px 0 0;"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;padding:22px 0 24px;border-bottom:1px solid ' +
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
      (slip.contact
        ? '<div style="font-size:12.5px;color:' +
          INK +
          ';line-height:1.5;margin-top:3px;">Attn: ' +
          esc(slip.contact) +
          '</div>'
        : '') +
      (slip.address
        ? '<div style="font-size:12px;color:#4b5468;line-height:1.6;margin-top:5px;white-space:pre-line;">' +
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
      '</tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody>' +
      '</table>' +
      // Anything still owed is stated on the slip, so a short shipment explains itself.
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

  function catalogOptions(sel) {
    return ['<option value="">Choose a belt…</option>']
      .concat(
        (state.catalog || []).map(function (c) {
          return (
            '<option value="' +
            esc(c.sku) +
            '"' +
            (sel === c.sku ? ' selected' : '') +
            '>' +
            esc(c.item) +
            (c.sku ? ' (' + esc(c.sku) + ')' : '') +
            '</option>'
          );
        }),
      )
      .join('');
  }

  /** The owed list, grouped by customer — that is how a shipment is packed. */
  function owedHtml() {
    var byCustomer = {};
    (state.owed || []).forEach(function (o) {
      (byCustomer[o.customer] = byCustomer[o.customer] || []).push(o);
    });
    var names = Object.keys(byCustomer).sort();
    if (!names.length) {
      return '<div class="muted" style="padding:22px 0;font-size:13px;">Nothing is waiting to ship.</div>';
    }
    return names
      .map(function (name) {
        var rows = byCustomer[name];
        var anyPicked = rows.some(function (r) {
          return picked[r.id];
        });
        var oldest = rows.reduce(function (a, r) {
          return Math.max(a, daysSince(r.added));
        }, 0);
        return (
          '<div style="border:1px solid ' +
          LINE +
          ';border-radius:9px;padding:13px 15px;margin-bottom:9px;background:#fff;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;">' +
          '<div style="font-family:' +
          SERIF +
          ';font-size:16px;font-weight:600;">' +
          esc(name) +
          '</div>' +
          '<div style="display:flex;gap:12px;align-items:baseline;flex:none;">' +
          (oldest >= 14
            ? '<span style="font-size:10px;font-weight:700;color:' +
              RED +
              ';text-transform:uppercase;letter-spacing:.12em;">' +
              oldest +
              ' days</span>'
            : '') +
          '<button type="button" class="link-btn bsPickAll" data-customer="' +
          esc(name) +
          '" style="width:auto;padding:4px 10px;font-size:11px;">' +
          (anyPicked ? 'Clear' : 'Select all') +
          '</button>' +
          '</div>' +
          '</div>' +
          rows
            .map(function (r) {
              var age = daysSince(r.added);
              return (
                '<div style="display:flex;gap:11px;align-items:flex-start;padding:8px 0 0;">' +
                '<input type="checkbox" class="bsPick" data-id="' +
                esc(r.id) +
                '"' +
                (picked[r.id] ? ' checked' : '') +
                ' style="margin-top:3px;flex:none;">' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:12.5px;line-height:1.5;">' +
                esc(r.item) +
                (r.sku
                  ? ' <span style="color:' + MUTE + ';font-size:11px;">' + esc(r.sku) + '</span>'
                  : '') +
                '</div>' +
                (r.note
                  ? '<div style="font-size:11px;color:' +
                    MUTE +
                    ';line-height:1.55;margin-top:2px;">' +
                    esc(r.note) +
                    '</div>'
                  : '') +
                '<div style="font-size:10.5px;color:#b0b6c2;margin-top:2px;">Added ' +
                esc(fmtDate(r.added)) +
                (age ? ' \u00b7 ' + age + 'd' : '') +
                '</div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;align-items:center;flex:none;">' +
                // Editable only once the row is ticked, so the list reads as quantities
                // owed until you are actually packing a box.
                (picked[r.id]
                  ? '<input type="number" class="bsQtyShip" data-id="' +
                    esc(r.id) +
                    '" min="1" max="' +
                    r.qty +
                    '" value="' +
                    picked[r.id] +
                    '" ' +
                    'style="width:54px;padding:4px 6px;font-size:13px;font-weight:700;text-align:right;font-family:inherit;' +
                    'border:1px solid ' +
                    NAVY +
                    ';border-radius:6px;font-variant-numeric:tabular-nums;">' +
                    '<span style="font-size:11px;color:' +
                    MUTE +
                    ';">of ' +
                    r.qty +
                    '</span>'
                  : '<span style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;">' +
                    r.qty +
                    '</span>') +
                '<button type="button" class="link-btn bsDrop" data-id="' +
                esc(r.id) +
                '" title="No longer owed" ' +
                'style="width:auto;padding:3px 8px;font-size:11px;color:' +
                RED +
                ';">Remove</button>' +
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

  function slipsHtml() {
    var recent = (state.slips || []).slice().reverse().slice(0, 12);
    if (!recent.length)
      return '<div class="muted" style="font-size:12.5px;padding:8px 0;">No slips yet.</div>';
    return recent
      .map(function (s) {
        var pieces = s.lines.reduce(function (a, l) {
          return a + l.qty;
        }, 0);
        return (
          '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:9px 0;border-top:1px solid #eef0f4;">' +
          '<div style="min-width:0;">' +
          '<div style="font-size:12.5px;">' +
          esc(s.customer) +
          '</div>' +
          '<div style="font-size:10.5px;color:' +
          MUTE +
          ';margin-top:2px;font-variant-numeric:tabular-nums;">' +
          esc(s.number) +
          ' \u00b7 ' +
          esc(fmtDate(s.date)) +
          ' \u00b7 ' +
          pieces +
          ' pc</div>' +
          '</div>' +
          '<button type="button" class="link-btn bsReprint" data-id="' +
          esc(s.id) +
          '" style="width:auto;padding:4px 11px;font-size:11px;flex:none;">Reprint</button>' +
          '</div>'
        );
      })
      .join('');
  }

  function paint() {
    var host = document.getElementById('view');
    if (!host) return;
    var pickedRows = (state.owed || []).filter(function (o) {
      return picked[o.id];
    });
    var pickedCustomers = {};
    pickedRows.forEach(function (r) {
      pickedCustomers[r.customer] = 1;
    });
    var customerNames = Object.keys(pickedCustomers);
    var oneCustomer = customerNames.length === 1;

    host.innerHTML =
      '<div style="display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,.85fr);gap:18px;align-items:start;">' +
      // Waiting to ship
      '<div>' +
      '<div class="card" style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:4px;">' +
      '<div class="section-title" style="margin:0;">Waiting to ship</div>' +
      '<div class="muted" style="font-size:12px;">' +
      (state.owed || []).length +
      ' item' +
      ((state.owed || []).length === 1 ? '' : 's') +
      '</div>' +
      '</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:12px;">Tick what is going in the box, then print the slip. Anything left ticked off stays on the list.</div>' +
      owedHtml() +
      '</div>' +
      // Add an item
      '<div class="card">' +
      '<div class="section-title" style="margin:0 0 10px;">Add an item</div>' +
      ((state.catalog || []).length
        ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;">' +
          '<label style="display:block;grid-column:1/-1;"><span style="font-size:11px;color:' +
          MUTE +
          ';">Customer</span>' +
          '<input id="bsCustomer" list="bsCustomers" placeholder="Who is it going to?" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
          LINE +
          ';border-radius:7px;font-family:inherit;box-sizing:border-box;"></label>' +
          '<datalist id="bsCustomers">' +
          Object.keys(
            (state.owed || []).reduce(function (a, o) {
              a[o.customer] = 1;
              return a;
            }, {}),
          )
            .concat(
              (state.slips || []).map(function (s) {
                return s.customer;
              }),
            )
            .filter(function (v, i, arr) {
              return arr.indexOf(v) === i;
            })
            .map(function (n) {
              return '<option value="' + esc(n) + '">';
            })
            .join('') +
          '</datalist>' +
          '<label style="display:block;"><span style="font-size:11px;color:' +
          MUTE +
          ';">Belt</span>' +
          '<select id="bsSku" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
          LINE +
          ';border-radius:7px;font-family:inherit;background:#fff;box-sizing:border-box;">' +
          catalogOptions('') +
          '</select></label>' +
          '<label style="display:block;"><span style="font-size:11px;color:' +
          MUTE +
          ';">Quantity</span>' +
          '<input id="bsQty" type="number" min="1" value="1" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
          LINE +
          ';border-radius:7px;font-family:inherit;box-sizing:border-box;"></label>' +
          '<label style="display:block;grid-column:1/-1;"><span style="font-size:11px;color:' +
          MUTE +
          ';">Note (optional)</span>' +
          '<input id="bsNote" placeholder="Warranty replacement, colour, who asked…" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
          LINE +
          ';border-radius:7px;font-family:inherit;box-sizing:border-box;"></label>' +
          '<button type="button" id="bsAdd" class="btn" style="grid-column:1/-1;margin-top:2px;">Add to the list</button>' +
          '</div>'
        : '<div class="muted" style="font-size:12.5px;line-height:1.6;">Add your belt SKUs first, on the right. Then items can be added to the list.</div>') +
      '</div>' +
      '</div>' +
      // Right column: build the slip, recent slips, the SKU list
      '<div>' +
      '<div class="card" style="margin-bottom:14px;">' +
      '<div class="section-title" style="margin:0 0 4px;">Print a slip</div>' +
      (pickedRows.length === 0
        ? '<div class="muted" style="font-size:12.5px;line-height:1.6;">Tick items on the left to build a slip.</div>'
        : !oneCustomer
          ? '<div style="font-size:12.5px;color:' +
            RED +
            ';line-height:1.6;">Items from ' +
            customerNames.length +
            ' customers are ticked. A slip goes in one box, so pick one customer at a time.</div>'
          : '<div class="muted" style="font-size:12px;margin-bottom:11px;">' +
            pickedRows.reduce(function (a, r) {
              return a + Math.min(r.qty, picked[r.id] || r.qty);
            }, 0) +
            ' piece' +
            (pickedRows.reduce(function (a, r) {
              return a + Math.min(r.qty, picked[r.id] || r.qty);
            }, 0) === 1
              ? ''
              : 's') +
            ' across ' +
            pickedRows.length +
            ' item' +
            (pickedRows.length === 1 ? '' : 's') +
            ' for <b style="color:' +
            INK +
            ';">' +
            esc(customerNames[0]) +
            '</b>' +
            (pickedRows.some(function (r) {
              return (picked[r.id] || r.qty) < r.qty;
            })
              ? '<br><span style="color:' +
                RED +
                ';">Shipping short — the balance stays on the list.</span>'
              : '') +
            '</div>' +
            '<label style="display:block;margin-bottom:9px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Attention</span>' +
            '<input id="bsContact" list="bsContacts" placeholder="Who should open the box?" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
            LINE +
            ';border-radius:7px;font-family:inherit;box-sizing:border-box;"></label>' +
            '<datalist id="bsContacts">' +
            (state.slips || [])
              .filter(function (sl) {
                return sl.customer === customerNames[0] && sl.contact;
              })
              .map(function (sl) {
                return sl.contact;
              })
              .filter(function (v, i, arr) {
                return arr.indexOf(v) === i;
              })
              .map(function (n) {
                return '<option value="' + esc(n) + '">';
              })
              .join('') +
            '</datalist>' +
            '<label style="display:block;margin-bottom:9px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Ship-to address</span>' +
            '<textarea id="bsAddr" rows="3" placeholder="Street, city, state, ZIP" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
            LINE +
            ';border-radius:7px;font-family:inherit;box-sizing:border-box;resize:vertical;"></textarea></label>' +
            '<label style="display:block;margin-bottom:11px;"><span style="font-size:11px;color:' +
            MUTE +
            ';">Message on the slip (optional)</span>' +
            '<input id="bsSlipNote" placeholder="Thanks for your order…" style="width:100%;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid ' +
            LINE +
            ';border-radius:7px;font-family:inherit;box-sizing:border-box;"></label>' +
            '<button type="button" id="bsPrint" class="btn">Print the slip &amp; clear these items</button>') +
      '</div>' +
      '<div class="card" style="margin-bottom:14px;">' +
      '<div class="section-title" style="margin:0 0 6px;">Recent slips</div>' +
      slipsHtml() +
      '</div>' +
      '<div class="card">' +
      '<div class="section-title" style="margin:0 0 4px;">Belt SKUs</div>' +
      '<div class="muted" style="font-size:11.5px;margin-bottom:10px;">The belts offered in the picker.</div>' +
      ((state.catalog || []).length
        ? (state.catalog || [])
            .map(function (c, i) {
              return (
                '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:6px 0;border-top:1px solid #eef0f4;">' +
                '<div style="min-width:0;font-size:12px;">' +
                esc(c.item) +
                (c.sku
                  ? '<span style="color:' +
                    MUTE +
                    ';font-size:11px;"> &middot; ' +
                    esc(c.sku) +
                    '</span>'
                  : '') +
                '</div>' +
                '<button type="button" class="link-btn bsCatDrop" data-i="' +
                i +
                '" style="width:auto;padding:2px 8px;font-size:11px;color:' +
                RED +
                ';flex:none;">Remove</button>' +
                '</div>'
              );
            })
            .join('')
        : '') +
      '<div style="display:grid;grid-template-columns:1fr 96px;gap:7px;margin-top:10px;">' +
      '<input id="bsCatItem" placeholder="Belt name, e.g. Flex Belt &mdash; XL" style="padding:8px 10px;font-size:12px;border:1px solid ' +
      LINE +
      ';border-radius:7px;font-family:inherit;box-sizing:border-box;">' +
      '<input id="bsCatSku" placeholder="SKU" style="padding:8px 10px;font-size:12px;border:1px solid ' +
      LINE +
      ';border-radius:7px;font-family:inherit;box-sizing:border-box;">' +
      '<button type="button" id="bsCatAdd" class="link-btn" style="grid-column:1/-1;width:auto;padding:7px 12px;font-size:12px;">Add this belt</button>' +
      '</div>' +
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
        if (cb.checked) {
          var row = (state.owed || []).filter(function (o) {
            return o.id === id;
          })[0];
          picked[id] = row ? row.qty : 1;
        } else {
          delete picked[id];
        }
        paint();
      });
    });

    // Repaint on change, not on input: the quantity feeds the "N items" summary and
    // the still-to-come block, and repainting mid-keystroke would take the focus away.
    host.querySelectorAll('.bsQtyShip').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = inp.getAttribute('data-id');
        var row = (state.owed || []).filter(function (o) {
          return o.id === id;
        })[0];
        if (!row) return;
        picked[id] = Math.min(row.qty, Math.max(1, Number(inp.value) || 1));
        paint();
      });
    });

    host.querySelectorAll('.bsPickAll').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.getAttribute('data-customer');
        var rows = (state.owed || []).filter(function (o) {
          return o.customer === name;
        });
        var anyPicked = rows.some(function (r) {
          return picked[r.id];
        });
        rows.forEach(function (r) {
          if (anyPicked) delete picked[r.id];
          else picked[r.id] = r.qty;
        });
        paint();
      });
    });

    host.querySelectorAll('.bsDrop').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var row = (state.owed || []).filter(function (o) {
          return o.id === id;
        })[0];
        if (!row) return;
        if (!confirm('Remove ' + row.item + ' for ' + row.customer + ' from the list?')) return;
        state.owed = state.owed.filter(function (o) {
          return o.id !== id;
        });
        delete picked[id];
        save();
      });
    });

    var add = host.querySelector('#bsAdd');
    if (add) {
      add.addEventListener('click', function () {
        var customer = (host.querySelector('#bsCustomer').value || '').trim();
        var sku = host.querySelector('#bsSku').value;
        var qty = Math.max(1, Number(host.querySelector('#bsQty').value) || 1);
        var note = (host.querySelector('#bsNote').value || '').trim();
        var belt = (state.catalog || []).filter(function (c) {
          return c.sku === sku;
        })[0];
        if (!customer) {
          alert('Who is it going to?');
          return;
        }
        if (!belt) {
          alert('Choose a belt.');
          return;
        }
        state.owed.push({
          id: uid(),
          customer: customer,
          sku: belt.sku,
          item: belt.item,
          qty: qty,
          note: note,
          added: todayISO(),
        });
        save();
      });
    }

    var catAdd = host.querySelector('#bsCatAdd');
    if (catAdd) {
      catAdd.addEventListener('click', function () {
        var item = (host.querySelector('#bsCatItem').value || '').trim();
        var sku = (host.querySelector('#bsCatSku').value || '').trim();
        if (!item) {
          alert('Give the belt a name.');
          return;
        }
        state.catalog.push({ sku: sku, item: item });
        save();
      });
    }

    host.querySelectorAll('.bsCatDrop').forEach(function (b) {
      b.addEventListener('click', function () {
        state.catalog.splice(Number(b.getAttribute('data-i')), 1);
        save();
      });
    });

    host.querySelectorAll('.bsReprint').forEach(function (b) {
      b.addEventListener('click', function () {
        var slip = (state.slips || []).filter(function (s) {
          return s.id === b.getAttribute('data-id');
        })[0];
        if (slip) openSlip(slip, []);
      });
    });

    var print = host.querySelector('#bsPrint');
    if (print) print.addEventListener('click', shipPicked);
  }

  /**
   * Print a slip for the ticked items and take them off the list.
   *
   * Order matters: the slip is shown first and the list is only cleared once it has
   * been recorded, so a failed save leaves the work still to do rather than losing it.
   */
  function shipPicked() {
    var host = document.getElementById('view');
    var rows = (state.owed || []).filter(function (o) {
      return picked[o.id];
    });
    if (!rows.length) return;
    var customer = rows[0].customer;
    if (
      rows.some(function (r) {
        return r.customer !== customer;
      })
    )
      return;

    state.seq = (state.seq || 0) + 1;
    var slip = {
      id: uid(),
      number: 'PS-' + String(state.seq).padStart(4, '0'),
      customer: customer,
      date: todayISO(),
      contact: ((host.querySelector('#bsContact') || {}).value || '').trim(),
      address: (host.querySelector('#bsAddr') || {}).value || '',
      note: (host.querySelector('#bsSlipNote') || {}).value || '',
      // What is actually going in this box, which may be fewer than the amount owed.
      lines: rows.map(function (r) {
        return { sku: r.sku, item: r.item, qty: Math.min(r.qty, picked[r.id] || r.qty) };
      }),
    };

    // Take the shipped quantity off each ticked row. A row shipped short survives with
    // the balance and its original added date, so a partial shipment does not reset
    // how long the customer has been waiting.
    var shipping = {};
    rows.forEach(function (r) {
      shipping[r.id] = Math.min(r.qty, picked[r.id] || r.qty);
    });
    state.owed = (state.owed || [])
      .map(function (o) {
        if (!shipping[o.id]) return o;
        var left = o.qty - shipping[o.id];
        return left > 0 ? Object.assign({}, o, { qty: left }) : null;
      })
      .filter(Boolean);

    // Everything this customer is still owed once the box is closed — including the
    // balance of any row that shipped short. Stated on the slip.
    var outstanding = (state.owed || []).filter(function (o) {
      return o.customer === customer;
    });

    state.slips.push(slip);
    picked = {};
    save().then(function () {
      openSlip(slip, outstanding);
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
      var st = document.createElement('style');
      st.id = 'bsPrintCss';
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

  /* -------------------------------------------------------------------- boot */

  window.SSGBeltShipments = {
    init: function (helpers) {
      H = helpers;
    },
    /** Render the screen into #view. */
    mount: function () {
      var host = document.getElementById('view');
      if (host) host.innerHTML = '<div class="muted" style="padding:18px;">Loading…</div>';
      picked = {};
      load().then(paint);
    },
  };
})();

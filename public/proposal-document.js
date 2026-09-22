/*
 * The customer proposal document.
 *
 * The HTML of the thing a customer reads and signs: cover block, itemized tiers,
 * totals, the cross-border figures on a Canadian proposal, the signature area and the
 * terms beneath it. Preview, print and the server-rendered PDF all use this one
 * function, so what is on screen is what gets signed.
 *
 * Lifted out of public/app.js, where it sat in the middle of a 16,500-line file that
 * also holds the CRM, the catalog, orders and administration. That file has no module
 * boundaries, so a syntax error anywhere in it blanks the entire workspace — which
 * happened — and this renderer is the part changed most often. It is now the only
 * thing that can break when the document changes.
 *
 * Two kinds of dependency, handled two different ways:
 *
 *   Formatting primitives — escaping and money. Pure, small, and copied in below.
 *   That is the convention the other extracted screens already follow, and a copy of a
 *   pure function cannot drift in a way that reaches a customer.
 *
 *   Dates were on that list and have been taken off it. A copy of a pure function
 *   cannot drift, but it can be wrong, and this one was: the copies read
 *   `new Date('2026-08-04')` and `toISOString()`, both of which answer in UTC. Anywhere
 *   west of Greenwich, for the last hours of every working day, that printed yesterday
 *   on the document — which is the defect the shell had already fixed and this file had
 *   not. Dates are injected now, for the same reason the deposit rule is: there is one
 *   correct answer and the printed page must not have its own.
 *
 *   Business rules — the deposit percentage, the discount label, whether a line prints
 *   freight as TBD, the model code. These are PASSED IN, never copied. They are shared
 *   with the proposal builder, and two implementations of a deposit rule is exactly the
 *   drift that puts a wrong number on a signed document.
 *
 * Registers window.SSGProposalDocument. No dependencies of its own, so it can load
 * before or after app.js.
 */
(function () {
  'use strict';

  /* ---- formatting primitives, copied from the shell ----
   *
   * Copied rather than injected because they appear on nearly every line below, and
   * threading six of them through every call would bury the document-building code
   * this file exists to make readable.
   */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** The saved size for a signature/date box id, or '' when there is none — see
   *  public/signature-field-layout.js. Spliced into the OUTER, line-owning box's own
   *  inline style, stacked on top of its own position:relative. */
  function sigSize(id) {
    return window.SSGSignatureFieldLayout ? window.SSGSignatureFieldLayout.styleFor(id) : '';
  }

  /** The saved position nudge for a signature/date box id, or '' when there is none.
   *  Spliced into the INNER box's own inline style, stacked on top of its own
   *  position:absolute;top:0;left:0 — never onto the outer box, so a nudge here can
   *  never move the border-bottom line the outer box owns. */
  function sigPosition(id) {
    return window.SSGSignatureFieldLayout ? window.SSGSignatureFieldLayout.offsetStyleFor(id) : '';
  }

  /** Minor units to "1,234.56" — no symbol; callers add one. */
  function money(minor) {
    var n = (Number(minor) || 0) / 100;
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtMoney(minor) {
    return '$' + money(minor);
  }

  /** Explicitly USD, for a document that also states CAD. */
  function fmtUsd(minor) {
    // Nowrap, like every other money span here (the CAD estimate, the inline CAD
    // parenthetical, the group subtotal): at narrow print widths the bare text wrapped
    // between "USD" and the figure, splitting the amount across two lines.
    return '<span style="white-space:nowrap;">USD $' + money(minor) + '</span>';
  }

  /** Title-case a heading. Pure, and copied for the same reason as the rest. */
  function tc(s) {
    return String(s || '').replace(/\b([a-z])/g, function (m0, c) {
      return c.toUpperCase();
    });
  }

  /** Bundle components are the '— ' rows that must stay under their parent line. */
  function isBundleChild(l) {
    return !!l && l.lineType === 'PRODUCT' && /^—\s/.test(String(l.name || ''));
  }

  /**
   * Extended revenue per line, with a bundle counted ONCE.
   *
   * A bundle is one priced line followed by its component rows, written zero-rate
   * on purpose — the customer sees only the parent's price. When a rate lands on a
   * component too, summing every row's own amount double-counted the bundle in the
   * printed section subtotal, even after the same fix landed in the totals panel
   * and the price snapshot.
   *
   * Mirrors countedRevenueByIndex in public/app.js and countedRevenueMinor in
   * src/proposals/analytics.ts. All three must agree, or this document disagrees
   * with the totals panel about the same bundle.
   */
  function countedRevenueByIndex(lines) {
    lines = lines || [];
    var ext = function (l) {
      return Math.round((Number(l.quantity) || 0) * (Number(l.rateMinor) || 0));
    };
    var out = lines.map(function () {
      return 0;
    });
    var i = 0;
    while (i < lines.length) {
      var l = lines[i];
      if (!l || (l.lineType || 'PRODUCT') !== 'PRODUCT') {
        i++;
        continue;
      }
      if (isBundleChild(l)) {
        out[i] = ext(l);
        i++;
        continue;
      }
      var parentAmt = ext(l);
      var kids = [];
      var j = i + 1;
      while (j < lines.length && isBundleChild(lines[j])) {
        kids.push(j);
        j++;
      }
      if (!kids.length) {
        out[i] = parentAmt;
        i = j;
        continue;
      }
      if (parentAmt !== 0) out[i] = parentAmt;
      else
        kids.forEach(function (k) {
          out[k] = ext(lines[k]);
        });
      i = j;
    }
    return out;
  }

  /* ---- business rules, supplied by the caller ----
   *
   * Set once by app.js on load, and deliberately not defaulted: a missing rule should
   * be a loud failure the first time the document is opened in development, not a
   * document that quietly prints the wrong deposit.
   */

  var rules = {
    overrideMinor: null,
    depositOf: null,
    depositPct: null,
    stripOptional: null,
    showsFreightTbd: null,
    proposalModelCode: null,
    discountLabel: null,

    /*
     * Three more that are NOT formatting, despite looking like it.
     *
     * rt renders the note markup — bold, italics, paragraph breaks. It is shared with
     * the proposal builder, which shows the rep the same note as they type it. Two
     * implementations and the preview stops matching the printed page, which is the
     * one thing a note editor must never do.
     *
     * freightTbdNote is a sentence that PRINTS ON THE DOCUMENT a customer signs. A
     * second copy of a legal sentence is not a formatting concern.
     *
     * documentUser resolves whose name and signature the document carries, from live
     * shell state (the open proposal's rep, falling back to the signed-in user). It
     * cannot be copied at all — it is a value that changes while the app is running.
     */
    rt: null,
    freightTbdNote: null,
    documentUser: null,

    /*
     * And the dates, moved here from the copied block above.
     *
     * fmtDate has to read a bare YYYY-MM-DD as a calendar date rather than as an
     * instant, and todayISO has to answer in the reader's own timezone. Both are one
     * line to get wrong and neither is visibly wrong when it is: the document simply
     * states a date one day early, on the page someone signs.
     */
    fmtDate: null,
    todayISO: null,
  };

  function overrideMinor(v) {
    return rules.overrideMinor(v);
  }
  function depositOf(t, m) {
    return rules.depositOf(t, m);
  }
  function depositPct(m) {
    return rules.depositPct(m);
  }
  function stripOptional(n) {
    return rules.stripOptional(n);
  }
  function showsFreightTbd(l) {
    return rules.showsFreightTbd(l);
  }
  function proposalModelCode(d) {
    return rules.proposalModelCode(d);
  }
  function discountLabel(m) {
    return rules.discountLabel(m);
  }
  function rt(s) {
    return rules.rt(s);
  }
  function fmtDate(v) {
    return rules.fmtDate(v);
  }
  function todayISO() {
    return rules.todayISO();
  }

  /* ---- the override parser ----
   *
   * A TBD box takes wording, but people type figures into it. A plain number there is
   * money; anything else is wording and contributes nothing.
   */

  function isNumericOverride(text) {
    if (text == null) return false;
    var s = String(text).trim().replace(/^\$/, '').replace(/,/g, '');
    return !!s && /^-?\d+(?:\.\d+)?$/.test(s);
  }

  /* ---- cross-border: reached only on a Canadian proposal ---- */

  /**
   * Is this a Canadian proposal at all? Governs the STRUCTURE — the border-charge
   * block and the cross-border clauses.
   */
  function cbIsCanadian(d) {
    var cb = d && d.crossBorder;
    return !!(cb && cb.applicable);
  }

  /**
   * Can CAD figures be printed? Governs only the CAD amounts.
   *
   * Kept separate from cbIsCanadian on purpose. When no Bank of Canada rate could be
   * resolved there are no CAD figures, but the duties, the brokerage and the legal
   * terms all still apply — folding the two together hid a real border charge from a
   * customer's document because an exchange-rate lookup had failed.
   */
  function cbApplies(d) {
    var cb = d && d.crossBorder;
    return !!(cb && cb.applicable && cb.fx && cb.fx.rate);
  }

  /** USD minor → CAD minor at the document's rate. Mirrors convertUsdMinorToCad. */
  function cbCad(usdMinor, rate) {
    if (usdMinor == null || !rate) return null;
    var parts = String(rate).split('.');
    var scale = parts.length > 1 ? parts[1].length : 0;
    var digits = Number(parts.join(''));
    var divisor = Math.pow(10, scale);
    var neg = usdMinor < 0;
    var abs = Math.abs(usdMinor) * digits;
    // Half up, away from zero — matching the server so the printed figure and the
    // stored snapshot agree to the cent.
    var rounded = Math.floor((abs * 2 + divisor) / (divisor * 2));
    return neg ? -rounded : rounded;
  }

  /** "USD 1,234.56" with "CAD 1,543.20 est." beneath it. Never a bare $. */
  function cbDocAmount(usdMinor, rate) {
    // A null rate prints USD alone: cbCad returns null, so the document degrades to
    // USD rather than breaking.
    var cad = cbCad(usdMinor, rate);
    return (
      fmtUsd(usdMinor) +
      (cad == null
        ? ''
        : '<span style="display:block;font-size:11.5px;color:#3f5fa8;font-weight:500;white-space:nowrap;">CAD ' +
          (cad / 100).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }) +
          ' est.</span>')
    );
  }

  /**
   * When the rate was taken, in words, for printing beside the CAD total.
   *
   * The observation date and the retrieval instant are different facts and the customer
   * is owed both: the Bank of Canada does not publish at weekends, so a Monday proposal
   * carries Friday's rate, and the gap between the two is the customer's exposure. Said
   * plainly rather than left to be inferred from a single date.
   */
  function cbRateStamp(d) {
    var fx = (d && d.crossBorder && d.crossBorder.fx) || {};
    if (!fx.rate) return '';
    var got = fx.retrievedAt ? new Date(fx.retrievedAt) : null;
    var source =
      fx.source === 'MANUAL' ? 'entered by Summit Sensory Gym' : 'Bank of Canada daily average';
    return (
      '<div style="margin-top:6px;padding-top:6px;border-top:1px dotted #ccd2dd;font-size:9.5px;color:#7b8190;line-height:1.55;text-align:right;">' +
      '1 USD = ' +
      esc(fx.rate) +
      ' CAD · ' +
      esc(source) +
      (fx.observationDate ? '<br>Rate published for ' + esc(fmtDate(fx.observationDate)) : '') +
      (got
        ? '<br>Retrieved ' +
          esc(got.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
        : '') +
      '<br>CAD amounts are estimates and will change with the rate on the date of acceptance.' +
      '</div>'
    );
  }

  /**
   * The printed value for one Section C "BOUND" row — see src/crossborder/sectionC.ts.
   * A row's label, presence and order are fully admin/per-proposal editable
   * (d.crossBorder.sectionCItems), but this switch is the one place a bound field's
   * VALUE is resolved, always from the real structured data, never hand-typed or
   * frozen into the row itself.
   */
  function cbSectionCBoundValue(d, field) {
    var cb = (d && d.crossBorder) || {};
    var NOT_YET = '<span style="color:#8a8f85;">Not yet determined</span>';
    switch (field) {
      case 'importerOfRecord': {
        var IOR = {
          CUSTOMER: 'The customer',
          SUMMIT: 'Summit Sensory Gym',
          THIRD_PARTY: 'A third party',
          TO_BE_DETERMINED: 'To be determined',
        };
        return cb.importerOfRecord && IOR[cb.importerOfRecord]
          ? esc(IOR[cb.importerOfRecord])
          : NOT_YET;
      }
      case 'customsBroker': {
        var parts = [cb.customsBrokerName, cb.customsBrokerAddress].filter(Boolean);
        return parts.length ? esc(parts.join(', ')) : NOT_YET;
      }
      case 'countryOfOrigin':
        return cb.countryOfOrigin ? esc(cb.countryOfOrigin) : NOT_YET;
      case 'tariffClassificationCode':
        return cb.tariffClassificationCode ? esc(cb.tariffClassificationCode) : NOT_YET;
      case 'tariff9979Claimed':
        return cb.tariff9979Claimed === true
          ? 'Claimed'
          : cb.tariff9979Claimed === false
            ? 'Not claimed'
            : NOT_YET;
      case 'gstHstTreatment':
        return cb.gstHstTreatment === 'STANDARD_RATE'
          ? 'Standard rate applies'
          : cb.gstHstTreatment === 'MEDICAL_DEVICE_RELIEF_CLAIMED'
            ? 'Relief claimed as medical/assistive device'
            : NOT_YET;
      case 'dutiesEstimate': {
        // Sums the SAME per-line figures cbSellerLines/cbBorderBlock already compute
        // and print elsewhere on this page — no new arithmetic — but only the duty,
        // surtax and brokerage categories. cbSellerAddMinor(d) is deliberately NOT
        // reused here: it totals every seller-collected line regardless of category,
        // which would fold the separate GST/HST sales-tax line into a row labeled
        // "Duties, surtax and brokerage" and overstate it.
        var res = cb.result;
        if (!res) return NOT_YET;
        var DUTY_CATEGORIES = {
          CUSTOMS_DUTY: true,
          TARIFF_SURTAX: true,
          SIMA: true,
          BROKERAGE: true,
          BROKER_DISBURSEMENT: true,
          IMPORT_TAX: true,
        };
        var dutyLines = (res.lines || []).filter(function (l) {
          return DUTY_CATEGORIES[l.category] && l.status !== 'NOT_APPLICABLE';
        });
        if (!dutyLines.length) return NOT_YET;
        var anyPriced = dutyLines.some(function (l) {
          return l.usdMinor != null;
        });
        if (!anyPriced) return '<span style="color:#8a8f85;">To be confirmed</span>';
        var rate = (cb.fx || {}).rate || null;
        var totalMinor = dutyLines.reduce(function (a, l) {
          return a + (l.usdMinor != null ? Number(l.usdMinor) : 0);
        }, 0);
        return cbDocAmount(totalMinor, rate);
      }
      case 'hostSystemModel':
        return cb.hostSystemModel ? esc(cb.hostSystemModel) : 'New complete system';
      default:
        return NOT_YET;
    }
  }

  /**
   * Section C — "Canadian Import Terms." A fully data-driven, ordered, admin- and
   * per-proposal-editable list, not a fixed table — see src/crossborder/sectionC.ts
   * for why. `d.crossBorder.sectionCItems` already arrives resolved and order-sorted
   * (this proposal's own list, or Summit's live standard list). This function knows
   * how to print a row; it does not know, and never hardcodes, what the rows are.
   */
  /**
   * A row/section's optional clarifying subtext, via rt() — the same bold/italic
   * markup convention (double asterisks for bold, single for italic) every other
   * note field in this app uses, sized 7-12pt (clamped here too, defensively, even
   * though the server already clamps on save). Never printed as an empty block;
   * never part of the Section A/C completion gate — see
   * requireSectionCCompleteBeforeFinal's own comment.
   */
  function cbSubtextHtml(subtext, sizePt) {
    if (!subtext || !String(subtext).trim()) return '';
    var size = Number(sizePt);
    if (!size || isNaN(size)) size = 9;
    size = Math.min(12, Math.max(7, size));
    // data-role, not a class the print stylesheet uses for anything — a stable hook
    // so a test (or a future reader) can find this block without depending on the
    // exact inline CSS, which is free to change for cosmetic reasons.
    return (
      '<div data-role="cb-subtext" style="margin-top:3px;font-size:' +
      size +
      'px;color:#5c6157;line-height:1.5;">' +
      rt(subtext) +
      '</div>'
    );
  }

  function cbSectionCTable(d) {
    if (!cbIsCanadian(d)) return '';
    var items = (d.crossBorder && d.crossBorder.sectionCItems) || [];
    if (!items.length) return '';
    var rows = items
      .map(function (item) {
        var value =
          item.kind === 'TEXT'
            ? item.text && String(item.text).trim()
              ? esc(item.text)
              : null
            : cbSectionCBoundValue(d, item.boundField);
        // A blank TEXT row is skipped, not printed with an empty value — same "never
        // print an empty block" rule the rest of this module follows.
        if (value == null) return '';
        return (
          '<div style="padding:5px 8px;border-bottom:1px dotted #ece7d8;">' +
          '<div style="display:flex;gap:14px;font-size:11px;line-height:1.5;">' +
          '<span style="font-weight:700;color:#3d4a55;flex:0 0 170px;">' +
          esc(tc(item.label || '')) +
          '</span><span style="color:#20241f;flex:1;min-width:0;">' +
          value +
          '</span></div>' +
          cbSubtextHtml(item.subtext, item.subtextSizePt) +
          '</div>'
        );
      })
      .join('');
    if (!rows) return '';
    return (
      '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #d5d8d2;break-inside:avoid;">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#3d4a55;padding:0 8px 6px;">Section C — Canadian Import Terms</div>' +
      rows +
      '</div>'
    );
  }

  /**
   * A plain "Section A" / "Section B" heading, Canadian proposals only, matching the
   * reference template's labeled structure. Purely a printed label around content
   * that already exists and already renders the same way — it changes no column, no
   * break rule, no subtotal math, and nothing about a domestic proposal.
   */
  function cbSectionLabel(d, text) {
    if (!cbIsCanadian(d)) return '';
    return (
      '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#3d4a55;margin:14px 0 6px;">' +
      esc(text) +
      '</div>'
    );
  }

  /**
   * Section B's clarifying notes — d.crossBorder.sectionBItems already arrives
   * resolved and order-sorted from crossBorderStateFor() (this proposal's own list
   * if it has one, otherwise Summit's live standard list — see
   * src/crossborder/sectionB.ts). Each item is a title-cased (tc()) label followed by
   * its rt()-rendered, sized body — the same bold-label-then-body shape the NOTE
   * line type already uses elsewhere in this file, not Section C's inline
   * label/value row, since these read as notes rather than short facts. A blank list
   * prints nothing. Never part of the completion gate — clarifying text is optional
   * by design.
   */
  function cbSectionBItems(d) {
    if (!cbIsCanadian(d)) return '';
    var items = (d.crossBorder && d.crossBorder.sectionBItems) || [];
    if (!items.length) return '';
    return items
      .map(function (item) {
        if (!item.text || !String(item.text).trim()) return '';
        var size = Number(item.sizePt);
        if (!size || isNaN(size)) size = 9;
        size = Math.min(12, Math.max(7, size));
        // data-role, not a class the print stylesheet uses for anything — a stable
        // hook so a test (or a future reader) can find this block without depending
        // on the exact inline CSS or fixture text, same convention cbSubtextHtml
        // already uses for Section C's row subtext.
        return (
          '<div data-role="cb-section-b-item" style="margin-top:6px;">' +
          '<b style="font-size:11px;color:#20241f;">' +
          esc(tc(item.label || '')) +
          '</b>' +
          '<div style="margin-top:2px;font-size:' +
          size +
          'px;color:#5c6157;line-height:1.5;">' +
          rt(item.text) +
          '</div></div>'
        );
      })
      .join('');
  }

  function cbFxBanner(d) {
    if (!cbIsCanadian(d)) return '';
    var fx = d.crossBorder.fx || {};
    var body = fx.rate
      ? 'Estimated Canadian-dollar amounts are shown for reference only, calculated using the Bank of Canada daily average USD/CAD exchange rate published for ' +
        esc(fx.observationDate || 'the proposal date') +
        ', at a rate of <b>1 USD = ' +
        esc(fx.rate) +
        ' CAD</b>.'
      : 'Canadian-dollar reference amounts are not shown on this proposal.';
    return (
      '<div style="margin:0 0 14px;padding:8px 10px;background:#fbfaf6;border:1px solid #203060;border-radius:6px;font-size:10.5px;line-height:1.6;color:#000;break-inside:avoid;">' +
      'All prices are in <b>United States dollars (USD)</b>. ' +
      body +
      '</div>'
    );
  }

  /**
   * The Canadian charges Summit is collecting, as totals-block rows.
   *
   * Tariff, brokerage and Canadian tax are entered per proposal (Customs and duties)
   * and each carries a flag for who collects it. Where SSG is collecting, the charge is
   * part of what the customer owes SSG — so it belongs in the totals block, above the
   * Total and inside it. Printing it only in the border block BELOW the total, which is
   * what happened before, understated what the customer is being asked to pay and made
   * entering the rates pointless.
   *
   * The border block still prints the charges SSG is not collecting, marked as payable
   * at import. The two sets never overlap — one flag decides which.
   */
  function cbSellerLines(d) {
    if (!cbIsCanadian(d) || !d.crossBorder.result) return [];
    return (d.crossBorder.result.lines || []).filter(function (l) {
      return l.includedInSellerTotal && l.status !== 'NOT_APPLICABLE' && l.usdMinor != null;
    });
  }

  /** What those charges add to the amount payable to Summit. */
  function cbSellerAddMinor(d) {
    return cbSellerLines(d).reduce(function (a, l) {
      return a + (Number(l.usdMinor) || 0);
    }, 0);
  }
  /**
   * Charges the customer pays at the border. Only the ones NOT in the Summit total.
   * An unquoted charge prints its status rather than a figure — a blank duty must
   * not read as no duty.
   */
  function cbBorderBlock(d) {
    if (!cbIsCanadian(d) || !d.crossBorder.result) return '';
    var rate = (d.crossBorder.fx || {}).rate || null;
    var lines = (d.crossBorder.result.lines || []).filter(function (l) {
      return (
        !l.includedInSellerTotal && l.category !== 'SALES_TAX' && l.status !== 'NOT_APPLICABLE'
      );
    });
    if (!lines.length) return '';
    var sep = d.crossBorder.result.separatelyPayable || { usdMinor: 0 };
    var landed = d.crossBorder.result.estimatedLandedCost || { usdMinor: 0 };
    var status = {
      TO_BE_CONFIRMED: 'To be confirmed',
      REQUIRES_CUSTOMS_REVIEW: 'To be confirmed',
      ESTIMATED: '',
      CONFIRMED: '',
    };

    var rows = lines
      .map(function (l) {
        var right =
          l.usdMinor == null
            ? '<span style="color:#8a8f85;">' +
              esc(status[l.status] || 'To be confirmed') +
              '</span>'
            : cbDocAmount(l.usdMinor, rate);
        return (
          '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 8px;font-size:11.5px;"><span style="color:#5c6157;">' +
          esc(l.label) +
          '</span><span style="text-align:right;">' +
          right +
          '</span></div>'
        );
      })
      .join('');

    return (
      '<div style="margin-top:18px;padding:10px 0 0;border-top:1px solid #d5d8d2;break-inside:avoid;">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#3d4a55;padding:0 8px 4px;">Estimated charges payable at import</div>' +
      '<div style="padding:0 8px 6px;font-size:10px;color:#8a8f85;line-height:1.55;">Not payable to Summit Sensory Gym. These are estimates, assessed and collected by the Canada Border Services Agency, the customs broker or the carrier.</div>' +
      rows +
      (sep.usdMinor
        ? '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 8px 3px;margin-top:4px;border-top:1px solid #ece7d8;font-size:11.5px;font-weight:700;"><span>Estimated charges payable at import</span><span style="text-align:right;">' +
          cbDocAmount(sep.usdMinor, rate) +
          '</span></div>'
        : '') +
      (sep.usdMinor
        ? '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 8px;font-size:11.5px;font-weight:700;"><span>Estimated total landed cost</span><span style="text-align:right;">' +
          cbDocAmount(landed.usdMinor, rate) +
          '</span></div>'
        : '') +
      '</div>'
    );
  }

  /**
   * The Canadian clauses. Wording is fixed here for now; the requirement is for
   * administrator-editable templates, which is a later slice — so the text lives in
   * one place rather than being scattered through the markup.
   */
  function cbClauses(d) {
    if (!cbIsCanadian(d)) return '';
    var cb = d.crossBorder;
    var fx = cb.fx || {};

    var para = function (title, text) {
      return '<div style="margin-bottom:6px;"><b>' + esc(title) + '</b> ' + text + '</div>';
    };

    /**
     * GST/HST relief status, tariff 9979.00.00 claim status and host-system
     * identification are all human-entered STATUSES on ProposalCustomsEntry, never
     * computed or inferred. Each one always prints something on a Canadian proposal
     * (including an honest "not yet determined" sentence when null) so the document
     * never silently omits a required disclosure just because nobody has answered yet.
     */
    var gstHstText =
      cb.gstHstTreatment === 'STANDARD_RATE'
        ? 'Standard rate applies.'
        : cb.gstHstTreatment === 'MEDICAL_DEVICE_RELIEF_CLAIMED'
          ? 'Goods qualify for relief as medical and assistive devices — confirm with broker.'
          : 'Whether these goods qualify for GST/HST relief as medical and assistive devices has not yet been determined for this proposal. Standard tax treatment is assumed on this estimate until confirmed otherwise; confirm the applicable treatment with your customs broker or tax advisor before relying on this proposal for tax planning.';

    var tariff9979Title = 'Tariff Item 9979.00.00 (Goods for Persons with Disabilities).';
    var tariff9979Text =
      cb.tariff9979Claimed === true
        ? 'Summit Sensory Gym has identified the goods on this proposal as eligible for classification under tariff item 9979.00.00 of the Canadian Customs Tariff, which provides relief from customs duty for goods designed to assist persons with disabilities. This classification is subject to review and final determination by the Canada Border Services Agency at the time of importation.'
        : cb.tariff9979Claimed === false
          ? 'The goods on this proposal are not being entered under tariff item 9979.00.00 of the Canadian Customs Tariff. Standard customs duty treatment applies, subject to the classification determined by the Canada Border Services Agency at the time of importation.'
          : 'Whether the goods on this proposal will be entered under tariff item 9979.00.00 of the Canadian Customs Tariff has not yet been determined. This proposal does not assume relief under that item; confirm eligibility and classification with your customs broker before relying on it.';

    var hostSystemBaseText =
      'Where any component on this proposal is a replacement or expansion part for an existing Summit Sensory Gym system rather than part of a new, complete system, it is identified to the host system it belongs to, consistent with the Canada Border Services Agency’s treatment of parts for equipment previously qualifying under tariff item 9979.00.00.';
    var hostSystemText =
      hostSystemBaseText +
      (cb.hostSystemModel
        ? ' This proposal is for replacement or expansion components for the customer’s existing system: ' +
          esc(cb.hostSystemModel) +
          '.'
        : '');

    var out = [
      para(
        'Currency and Exchange Rate.',
        'All quoted prices and contractual payment obligations are denominated in United States dollars (USD). Canadian-dollar (CAD) amounts are provided for reference and budgeting convenience only. ' +
          (fx.rate
            ? 'Estimated CAD amounts are calculated using the Bank of Canada daily average USD/CAD exchange rate published for ' +
              esc(fx.observationDate || 'the proposal date') +
              ', at a rate of 1 USD = ' +
              esc(fx.rate) +
              ' CAD. '
            : 'No CAD reference amounts are shown on this proposal. ') +
          'If this proposal is accepted, the CAD reference amounts will be recalculated and locked using the most recently published Bank of Canada daily average rate on or before the date of acceptance. Payment remains due in USD unless Summit Sensory Gym expressly agrees in writing to accept payment in CAD. In the event of any discrepancy, the USD amounts control. The exchange rate shown may differ from the rate offered by the customer\u2019s bank or payment provider.',
      ),
      para(
        'Bank and Payment Fees.',
        'The customer is responsible for any wire-transfer fees, intermediary-bank fees, credit-card fees where permitted, foreign-exchange charges, or other payment-processing costs imposed by the customer\u2019s financial institution or payment provider. Summit Sensory Gym must receive the full invoiced amount.',
      ),
      para(
        'Canadian Sales Taxes.',
        'Applicable GST, HST, PST, RST, or QST will be determined based on the ship-to location, the nature of the goods and services supplied, Summit Sensory Gym\u2019s applicable registration obligations, the customer\u2019s documented tax status, and the laws and rates in effect at the time of invoicing or shipment. Tax amounts shown on this proposal are estimates and may be revised on the final invoice if the delivery location, applicable rate, taxability, exemption status, transaction structure, or governing law changes. Any valid exemption documentation must be provided and approved before the final invoice is issued.',
      ),
      para('GST/HST Treatment.', gstHstText),
      para(
        'Basis of the Estimates.',
        'The tariff and tax rates applied on this proposal were entered by Summit Sensory Gym based on the information available for goods of this kind. They are not derived from a tariff classification ruling, a country-of-origin determination or an advance ruling from the Canada Border Services Agency, and they do not constitute customs, tax or legal advice. The customer is encouraged to confirm the applicable rates with their own customs broker before relying on these figures for budgeting.',
      ),
      para(
        'Customs Duties and Tariffs.',
        'Customs duties, counter-tariffs, surtaxes, safeguard measures, anti-dumping duties, countervailing duties, and other border assessments shown in this proposal are estimates based on the product information, tariff classification, country of origin, customs value, trade-agreement eligibility, exchange-rate information, and government rules available on the proposal date. Final amounts are determined by the Canada Border Services Agency or the authorized customs broker under the laws and rates in effect when the goods are imported. Unless expressly identified as fixed and included, any difference between estimated and actual border assessments is the customer\u2019s responsibility.',
      ),
      para(
        'Estimated Tariffs Are Dated to This Proposal.',
        'Any tariff, duty, surtax or brokerage figure shown on this proposal is an estimate calculated on the proposal date, using the rates in effect and the information available on that date. Tariff rates, surtax orders and remission orders are set by government and change without notice, sometimes between the date a proposal is issued and the date the goods cross the border. The figures shown are not a quotation of, or a cap on, the amounts that will ultimately be assessed, and they may increase or decrease.',
      ),
      para(tariff9979Title, tariff9979Text),
    ];

    if (cb.tariff9979Claimed === true) {
      out.push(
        para(
          'Diversion of Goods Entered Under Tariff Item 9979.00.00.',
          'If any good entered into Canada under tariff item 9979.00.00 of the Canadian Customs Tariff is later sold, leased, or otherwise diverted to a use that does not qualify for that tariff item, the party responsible for the customs accounting on this shipment must correct that accounting and pay any customs duty and other charges that become owing as a result, in accordance with the Canadian Customs Tariff and the Accounting for Imported Goods and Payment of Duties Regulations.',
        ),
      );
    }

    out.push(
      para(
        'Design and Engineering Documentation.',
        'Summit Sensory Gym maintains design, engineering and clinical documentation supporting the intended use of this equipment by persons with disabilities. That documentation is available on request to whoever is handling customs clearance for this shipment, or directly to the Canada Border Services Agency.',
      ),
    );
    out.push(para('Host System Identification.', hostSystemText));

    out.push(
      para(
        'Responsibility for Border Charges.',
        'Except for any amount expressly identified on this proposal as fixed and included in the total payable to Summit Sensory Gym, the customer is responsible for all customs duties, tariffs, surtaxes, safeguard and anti-dumping measures, import taxes, brokerage charges, storage, demurrage, examination and inspection fees, disbursements and penalties assessed on the importation of the goods, together with any increase in those amounts arising after the proposal date. Summit Sensory Gym has no control over the classification, valuation or rate applied by the Canada Border Services Agency or by the customs broker and is not liable for any such charge, for any increase in one, or for delay, storage or additional cost arising from a customs examination, a re-determination of classification or origin, or a change in law. Where Summit Sensory Gym advances any such amount on the customer\u2019s behalf, it is reimbursable in full.',
      ),
    );
    out.push(
      para(
        'CUSMA Treatment.',
        'Preferential tariff treatment under the Canada\u2013United States\u2013Mexico Agreement applies only when the goods satisfy the applicable rules of origin and the required origin documentation is available and accepted. Shipment from the United States does not, by itself, establish eligibility for preferential tariff treatment.',
      ),
    );

    out.push(
      para(
        'Customs Brokerage.',
        'Additional disbursement, advancement, bond, inspection, storage, carrier, port, redelivery, or other accessorial charges may apply. Unless expressly included as a fixed charge, these additional third-party costs are the customer\u2019s responsibility.',
      ),
    );
    out.push(
      para(
        'Changes in Government Charges.',
        'Taxes, duties, tariffs, surtaxes, trade remedies, customs requirements, and government fees are subject to change. Any new or increased governmental charge that becomes applicable after the proposal date and before importation, delivery, or invoicing may be added to the final amount payable, unless Summit Sensory Gym has expressly agreed in writing to absorb that charge.',
      ),
    );
    out.push(
      para(
        'Canadian Delivery Charges.',
        'Freight is based on the delivery conditions and information available on the proposal date. Additional charges may apply for limited-access locations, appointment delivery, liftgate service, inside delivery, remote-area service, construction delays, storage, redelivery, address changes, border delays, or other services not included in the original freight quotation.',
      ),
    );
    out.push(
      para(
        'Customer Tax Rebates.',
        'The customer may be eligible to apply for a tax rebate or recovery based on its own legal or organizational status. Any such rebate is the customer\u2019s responsibility and does not reduce the tax charged by Summit Sensory Gym unless a valid point-of-sale exemption applies and the required documentation has been received and approved.',
      ),
    );
    // Bryan's own tariff-audit wording \u2014 never hardcoded here. `cb.auditLanguageText`
    // already arrives resolved server-side (this proposal's own override, or Summit's
    // current admin default). A blank/unset default prints no clause at all, rather
    // than an empty heading.
    if (cb.auditLanguageText && String(cb.auditLanguageText).trim()) {
      out.push(para('In the Event of a CBSA Reassessment.', esc(cb.auditLanguageText)));
    }

    return (
      '<div style="margin-top:14px;padding-top:8px;border-top:1px solid #d5d8d2;font-size:9.5px;line-height:1.6;color:#5c6157;">' +
      '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#3d4a55;margin-bottom:5px;">Cross-border terms</div>' +
      out.join('') +
      '</div>'
    );
  }

  /**
   * `{{customer}}` and `{{amount}}` merge tokens in Media Program prose.
   * `{{customer}}` is the same token, same bracket placeholder fallback when the
   * proposal has no organization/contact yet, as `{{customer}}` in the release and
   * terms (public/contract-pages.js's `fill()`/`TOKEN_LABELS`). `{{amount}}` prints
   * the resolved rebate amount (per-proposal override, or the Administration
   * default) IN BOLD — the dollar figure called out inline in the paragraph itself,
   * not only in the "Rebate Available" line above it. Both are applied AFTER
   * escaping, same order as contract-pages.js, so a customer name typed into the
   * token cannot inject markup through the escaper.
   */
  function fillMediaTokens(escapedHtml, tokens) {
    return escapedHtml
      .replace(/\{\{\s*customer\s*\}\}/g, function () {
        return tokens.customer
          ? esc(tokens.customer)
          : '<span style="color:#8a91a0;">[customer]</span>';
      })
      .replace(/\{\{\s*amount\s*\}\}/g, function () {
        return '<b>' + fmtUsd(tokens.amountMinor) + '</b>';
      });
  }

  /**
   * The rebate amount that actually applies to this proposal: a per-proposal
   * override (`meta.mediaRebate.amountOverrideMinor`, set in the builder's
   * mediaRebateCard()) when one is set, otherwise the Administration default. The
   * override lives on the proposal's own meta — like `offered`/`participate` — so it
   * freezes with the rest of the version at release with no separate snapshot needed.
   */
  function mediaAmountMinor(mr, program) {
    var override = mr && mr.amountOverrideMinor;
    if (typeof override === 'number' && isFinite(override) && override >= 0) return override;
    return (program && program.rebateAmountMinor) || 25000;
  }

  /**
   * Typeface and layout for the Media Program page — the identical closed set, same
   * clamps, as public/contract-pages.js's styleOf()/bodyCss(), read from
   * `program.content.style` (`MediaProgramStyle` in src/mediaRebate/defaults.ts)
   * instead of a legal document's `style`. Copied rather than shared, per this file's
   * own header comment on formatting primitives.
   */
  var MEDIA_FONTS = {
    aptos: "Aptos,'Segoe UI',Calibri,system-ui,sans-serif",
    plex: "'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif",
    georgia: "Georgia,'Times New Roman',Times,serif",
  };

  function mediaStyleOf(style) {
    var s = style || {};
    var n = function (v, d, lo, hi) {
      var x = parseFloat(v);
      return isFinite(x) && x >= lo && x <= hi ? x : d;
    };
    return {
      family: MEDIA_FONTS[s.font] || MEDIA_FONTS.plex,
      sizePt: n(s.sizePt, 9, 7, 12),
      lineHeight: n(s.lineHeight, 1.35, 1.1, 1.9),
      align: s.align === 'left' ? 'left' : 'justify',
      titlePt: n(s.titlePt, 15, 11, 22),
    };
  }

  function mediaBodyCss(st) {
    return (
      'font-family:' +
      st.family +
      ';font-size:' +
      st.sizePt +
      'pt;line-height:' +
      st.lineHeight +
      ';color:#20241f;'
    );
  }

  /**
   * Text → paragraphs/bullets for the Media Program's admin-edited prose. Mirrors
   * the plain blank-line-paragraph / one-bullet-per-line convention
   * src/mediaRebate/defaults.ts ships, so an admin typing into a plain textarea in
   * Administration does not need to learn any markup beyond the {{customer}} token.
   */
  function mediaProgramTextHtml(text, tokens, align) {
    var blocks = String(text || '')
      .split(/\n\n+/)
      .filter(function (b) {
        return b.trim();
      });
    return blocks
      .map(function (b) {
        var lines = b.split('\n').filter(function (l) {
          return l.trim();
        });
        if (
          lines.length > 1 &&
          lines.every(function (l) {
            return /^•/.test(l.trim());
          })
        ) {
          return (
            '<ul style="margin:2px 0 8px 18px;padding:0;">' +
            lines
              .map(function (l) {
                return (
                  '<li style="margin-bottom:2px;">' +
                  fillMediaTokens(esc(l.trim().replace(/^•\s*/, '')), tokens) +
                  '</li>'
                );
              })
              .join('') +
            '</ul>'
          );
        }
        return (
          '<p style="margin:0 0 8px;text-align:' +
          (align || 'justify') +
          ';text-wrap:pretty;">' +
          fillMediaTokens(esc(b), tokens) +
          '</p>'
        );
      })
      .join('');
  }

  /**
   * The one sentence added to the acceptance acknowledgment when Summit offered the
   * Media Program on this proposal — see spec section 7. The existing single
   * signature already covers it; no second signature field is added.
   */
  function mediaRebateAcknowledgmentHtml(d) {
    var mr = (d.meta || {}).mediaRebate;
    if (!mr || !mr.offered) return '';
    var m = d.meta || {};
    var program = (window.SSGMediaRebateProgram && window.SSGMediaRebateProgram.current()) || null;
    var tokens = {
      customer: d.orgName || m.contactName || '',
      amountMinor: mediaAmountMinor(mr, program),
    };
    var text =
      (program && program.content && program.content.signatureAcknowledgment) ||
      'By signing this Proposal, {{customer}} agrees to all selected options, programs, terms, and conditions contained in this Proposal, including the Customer Project Media Rebate Program where elected above.';
    return (
      '<div style="font-size:10.5px;color:#5b6478;line-height:1.55;margin-top:8px;">' +
      fillMediaTokens(esc(text), tokens) +
      '</div>'
    );
  }

  /**
   * Canadian Acceptance-page addendum — Bryan's own text, never hardcoded here.
   * `d.crossBorder.acceptanceText` already arrives resolved server-side (this
   * proposal's own override if it set one, otherwise Summit's current admin default
   * — see CrossBorderState.acceptanceText in src/crossborder/snapshot.ts). Printed in
   * the identical slot and style mediaRebateAcknowledgmentHtml uses right above it, so
   * the Acceptance page's format is unchanged by this addition.
   */
  function cbAcceptanceTextHtml(d) {
    var text = d && d.crossBorder && d.crossBorder.acceptanceText;
    if (!text || !String(text).trim()) return '';
    return (
      '<div style="font-size:10.5px;color:#5b6478;line-height:1.55;margin-top:8px;">' +
      esc(text) +
      '</div>'
    );
  }

  /**
   * One signature line: a label, a ruled box, and — for the two that carry an
   * `id` — the empty, position:relative anchor `injectSignatureFields` (assembly.ts)
   * fills with a real DocuSeal field at send time. Byte-for-byte the same shape as
   * contract-pages.js's `sigBlock`'s inner `line()`, copied rather than shared per
   * this file's own convention on formatting primitives — see that function's own
   * comment for why depth/id are handled the way they are.
   */
  function mediaSigLine(label, value, depth, id) {
    return (
      '<div style="display:flex;gap:6px;align-items:baseline;margin-top:9px;">' +
      '<div style="flex:none;">' +
      label +
      '</div>' +
      '<div style="flex:1;border-bottom:1px solid #20241f;' +
      (depth
        ? 'height:' + depth + 'px;display:flex;align-items:flex-end;'
        : id
          ? 'height:20px;display:flex;align-items:flex-end;'
          : 'padding-bottom:1px;') +
      (id
        ? 'position:relative;' +
          (window.SSGSignatureFieldLayout ? window.SSGSignatureFieldLayout.styleFor(id) : '')
        : '') +
      '">' +
      (value ? esc(value) : '') +
      (id
        ? '<div id="' +
          id +
          '" style="position:absolute;top:0;left:0;' +
          (window.SSGSignatureFieldLayout
            ? window.SSGSignatureFieldLayout.offsetStyleFor(id)
            : '') +
          '"></div>'
        : '') +
      '</div></div>'
    );
  }

  /**
   * The Media Rebate signature block — Customer only, called once. `idPrefix +
   * 'Signature'/'Date'` must match the slot pair registered in
   * src/integrations/docuseal/assembly.ts's CUSTOMER_SLOTS (`ssgSigMediaCustomer*`),
   * or DocuSeal never places a real field behind the printed blank line — a printed
   * line with no field behind it is worse than no line at all (assembly.ts's own
   * header comment).
   */
  function mediaSigBlock(role, name, entity, idPrefix) {
    return (
      '<div>' +
      '<div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.09em;color:#5b6478;margin-bottom:5px;">' +
      esc(role) +
      '</div>' +
      '<div style="font-weight:700;">' +
      (entity ? esc(entity) : '&nbsp;') +
      '</div>' +
      mediaSigLine('By:', '', 46, idPrefix + 'Signature') +
      mediaSigLine('Name:', name) +
      mediaSigLine('Date:', '', null, idPrefix + 'Date') +
      '</div>'
    );
  }

  /**
   * Why this page needs its own signature at all: the main Acceptance page carries
   * one sentence folding the Media Rebate election into the general proposal
   * signature (mediaRebateAcknowledgmentHtml above) — but the Product Use, Safety &
   * Responsibility Acknowledgment gets its OWN dedicated signature too, despite
   * being referenced the same way by that same sentence, because a program with its
   * own obligations (Customer submits media and grants usage rights) is its own act
   * of consent, not a footnote on a different one.
   *
   * Customer only, unlike the Acknowledgment's dual blocks: Customer is the one
   * agreeing to the program's terms here; Summit has no separate act of consent to
   * countersign on this page. Same "IN WITNESS WHEREOF" convention as the
   * Acknowledgment (contract-pages.js's articlesDocHtml) otherwise, and the same
   * "Customer" defined-term wording that line uses rather than the company's actual
   * name — the signature block right below it is what names the actual signer.
   */
  function mediaSignatureHtml(d, name) {
    var m = d.meta || {};
    var company = d.orgName || m.contactName || '';
    return (
      '<div style="margin-top:16px;padding-top:9px;border-top:1px solid #20241f;break-inside:avoid;">' +
      'IN WITNESS WHEREOF, Customer has executed this ' +
      esc(name) +
      ' election as of the date written below.' +
      '</div>' +
      '<div style="margin-top:12px;max-width:320px;break-inside:avoid;page-break-inside:avoid;">' +
      mediaSigBlock('Customer', m.contactName || '', company, 'ssgSigMediaCustomer') +
      '</div>'
    );
  }

  /**
   * The full Customer Project Media Rebate section: requirements, acceptance
   * standards, usage rights, privacy, payment terms, the customer's
   * (pre-determined) election, and a dedicated signature block — printed as its own
   * page, alongside the legal documents, when Summit offered the program on this
   * proposal. Empty string otherwise, so a proposal that never touches this feature
   * renders byte-identical to before this feature existed.
   *
   * Laid out the same way the release and terms are (public/contract-pages.js): a
   * running header naming the customer, a centered uppercase heading under a rule,
   * and numbered clauses with the numeral hanging in the margin — not because this
   * is a legal document (LegalDocument's draft/publish/versioning does not apply
   * here; see src/mediaRebate/service.ts's own note on why a mutable settings row
   * plus a snapshot is the right shape for THIS content), but because a customer
   * reading five printed pages in a row should not be able to tell, by look alone,
   * which one is "the real contract" and which is not.
   *
   * Always the LIVE program (window.SSGMediaRebateProgram), never a pinned snapshot —
   * same as the legal documents above. The pinned, audit-truth answer for a released
   * version lives server-side (src/mediaRebate/service.ts, GET
   * /proposals/versions/:id/media-rebate); the real immutability guarantee for
   * anything actually signed comes from the e-sign PDF freeze, not from re-rendering
   * this page from a snapshot.
   */
  function mediaRebateSectionHtml(d) {
    var mr = (d.meta || {}).mediaRebate;
    if (!mr || !mr.offered) return '';
    var m = d.meta || {};
    var customer = d.orgName || m.contactName || '';
    var program = (window.SSGMediaRebateProgram && window.SSGMediaRebateProgram.current()) || null;
    var name = (program && program.customerFacingName) || 'Customer Project Media Rebate';
    var content = (program && program.content) || {};
    var st = mediaStyleOf(content.style);
    var BODY = mediaBodyCss(st);
    var tokens = { customer: customer, amountMinor: mediaAmountMinor(mr, program) };

    // Numbered clauses, same shape as contract-pages.js's numberedDocHtml — the
    // numeral IS the position, so a clause with no text (an admin left a box blank)
    // is skipped rather than printing an empty numbered heading.
    var clauses = [
      ['Media Requirements', content.mediaRequirements],
      ['Media Acceptance Standards', content.acceptanceStandards],
      ['Media Usage Rights', content.usageRights],
      ['Privacy / Identifiable Individuals', content.privacyRestrictions],
      ['Rebate Payment Terms', content.paymentTerms],
    ].filter(function (c) {
      return !!c[1];
    });
    var clausesHtml = clauses
      .map(function (c, i) {
        return (
          '<div style="display:flex;gap:10px;margin-top:' +
          (i ? 10 : 14) +
          'px;">' +
          '<div style="flex:none;width:22px;font-weight:700;">' +
          (i + 1) +
          '.</div>' +
          '<div style="flex:1;">' +
          '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' +
          esc(c[0]) +
          '</div>' +
          mediaProgramTextHtml(c[1], tokens, st.align) +
          '</div></div>'
        );
      })
      .join('');

    return (
      '<div data-page-break="media-rebate" style="break-before:page;page-break-before:always;' +
      BODY +
      '">' +
      // Running header — same convention as contract-pages.js's numberedDocHtml.
      '<div style="text-align:right;font-size:9pt;line-height:1.5;font-weight:700;">' +
      esc(customer) +
      '</div>' +
      // Centered, uppercase, letter-spaced heading under a rule — contract-pages.js's
      // heading(), copied rather than shared.
      '<div style="text-align:center;margin-top:18px;">' +
      '<div style="font-size:' +
      st.titlePt +
      'pt;font-weight:700;text-transform:uppercase;letter-spacing:.1em;">' +
      esc(name) +
      '</div>' +
      '<div style="width:88px;height:1px;background:#20241f;margin:7px auto 0;"></div>' +
      '</div>' +
      '<div style="font-size:11.5px;color:#5b6478;line-height:1.6;margin:10px 0 14px;text-align:center;">Rebate Available: <b>' +
      fmtUsd(tokens.amountMinor) +
      '</b> — does not reduce the Project Price or any amount due before shipment.</div>' +
      // Unnumbered preamble — contract-pages.js's preambleHtml convention.
      mediaProgramTextHtml(content.introduction, tokens, st.align) +
      clausesHtml +
      '<div style="margin-top:16px;padding-top:10px;border-top:1px solid #d5d8d2;">' +
      '<label style="display:flex;gap:9px;align-items:flex-start;font-size:11.5px;line-height:1.55;">' +
      '<span style="display:inline-block;width:13px;height:13px;border:1px solid #20241f;flex:none;margin-top:1px;text-align:center;line-height:12px;font-size:11px;">' +
      (mr.participate ? '✓' : '') +
      '</span>' +
      '<span>' +
      fillMediaTokens(
        esc(
          content.participationLanguage ||
            'Yes, we elect to participate in Summit Sensory Gym’s Customer Project Media Rebate Program and agree to the Media Program terms contained in this Proposal.',
        ),
        tokens,
      ) +
      '</span>' +
      '</label>' +
      '</div>' +
      mediaSignatureHtml(d, name) +
      '</div>'
    );
  }

  /* ---- the document ---- */

  function proposalDocHtml(doc) {
    var d = doc,
      m = d.meta || {},
      t = d.totals || {};
    // On a US proposal this IS fmtUsd, so the document stays byte-identical to what
    // it has always been. CAD only ever appears as an extra line underneath.
    /**
     * Money on the customer document.
     *
     * A domestic proposal prints plain dollars: the customer is in the United States,
     * every figure is USD, and prefixing forty of them states the obvious loudly. On a
     * cross-border proposal the currency IS the question, so USD stays on every figure
     * and the CAD conversion prints beneath it.
     */
    var money =
      cbApplies(d) || cbIsCanadian(d)
        ? fmtUsd
        : function (v) {
            return fmtMoney(v, '');
          };
    var cbAmt = cbApplies(d)
      ? function (v) {
          return cbDocAmount(v, d.crossBorder.fx.rate);
        }
      : money;
    /**
     * The same pair, inside a sentence.
     *
     * cbDocAmount prints CAD as a block, which is right in a totals column and wrong in
     * prose: on the acceptance line it broke one sentence into three, with the CAD
     * figure sitting between the total and the words that follow it. Inline, in the
     * sentence's own size and colour, because it is being read as part of the sentence.
     */
    var cbInline = cbApplies(d)
      ? function (v) {
          var cad = cbCad(v, d.crossBorder.fx.rate);
          return (
            fmtUsd(v) +
            (cad == null
              ? ''
              : ' <span style="white-space:nowrap;">(CAD ' +
                (cad / 100).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }) +
                ' est.)</span>')
          );
        }
      : money;
    // Tax and freight are frequently unknown when a proposal goes out. An untouched
    // figure prints TBD, because a hard $0.00 there reads as "included" — the one
    // wrong answer to give a customer about freight.
    var TBD = '<span style="color:#8a8f85;font-weight:600;">TBD</span>';
    var anyTbd = false;
    /**
     * A money row on the totals block.
     *
     * The override box beside each figure in the builder decides what a zero means.
     * Left empty, a zero is "not answered yet" and prints TBD. Type a number into the
     * box — INCLUDING 0 — and that figure prints: "USD $0.00" is then a statement that
     * this job carries no tax, or no mats freight, which is a different claim and a
     * legitimate one. Any other wording in the box prints as written.
     *
     * A typed 0 has to be distinguished from unparseable text, and `overrideMinor`
     * returns 0 for both, so the numeric test is made separately.
     */
    function amountCell(value, override) {
      // cbAmt, not money: a freight figure on a Canadian proposal gets the same CAD
      // estimate as every other figure in the block. Printing one line in USD alone
      // left the reader converting it themselves.
      if (value) return cbAmt(value);
      if (isNumericOverride(override)) return cbAmt(overrideMinor(override));
      if (override) return '<span style="color:#5c6157;">' + esc(override) + '</span>';
      anyTbd = true;
      return TBD;
    }
    /**
     * The document's own total, with the Canadian charges Summit collects added in.
     *
     * Built from the document's own figures rather than the engine's payableToSummit,
     * so the block always adds up to exactly what it lists: a TBD freight line is TBD in
     * both places, and the deposit is a percentage of the number the customer signs
     * against. Zero charges means docTotal is t.total to the cent, so a US proposal is
     * byte-for-byte what it was.
     */
    var docCbAdd = cbSellerAddMinor(d);
    var docTotal = t.total + docCbAdd;
    var docDeposit = docCbAdd ? depositOf(docTotal) : t.deposit;

    var cellTax = amountCell(t.tax, m.tbdTax);
    var cellStructureFreight = amountCell(t.structureFreight, m.tbdStructureFreight);
    var cellMatsFreight = amountCell(t.matsFreight, m.tbdMatsFreight);
    var body = '';
    var tbodyOpen = false;
    /**
     * Open a section. Each group is its own <tbody data-group> carrying
     * break-inside:avoid, which keeps a heading, its lines and its subtotal together
     * on one sheet rather than splitting a section across the fold.
     */
    function openSection() {
      var s =
        (tbodyOpen ? '</tbody>' : '') +
        '<tbody data-group style="break-inside:avoid;page-break-inside:avoid;">';
      tbodyOpen = true;
      return s;
    }
    var groupOpenSub = null;
    // Indent depth: top-level group flush, sub-heading indented, line items
    // indented one step further than whichever heading they sit under.
    var inSub = false;
    var bottomNotes = [];
    // A vendor-sourced part is often returnable, just on the vendor's own terms
    // rather than Summit's — the one place that maps the builder's returnable
    // select (public/app.js, returnableSelect()) to what prints here, so the two
    // can't drift into disagreement.
    var RETURNABLE_LABEL = {
      YES: 'Yes',
      NO: 'No',
      VENDOR_POLICY: "Yes, per the vendor's return policy",
    };
    /**
     * Left edge by tier. A section heading sits flush, a sub-heading steps in once,
     * and a product hangs off whichever heading it belongs to — so the tier of any
     * line can be read from its indent alone.
     */
    function lineIndent() {
      return inSub ? 48 : 28;
    }
    function subtotalRow() {
      if (groupOpenSub == null) return '';
      // Plain "$X,XXX.XX", like every line item above it — never the cross-border
      // "USD $X" (`money`, on a Canadian proposal). "USD" earns its place on the
      // bottom totals block because a CAD estimate sits right beneath it there; a
      // group subtotal carries no such estimate, so the prefix was pure width with
      // no figure to disambiguate. That width is what pushed the number past the
      // fixed 78px Amount column — table-layout:fixed does not grow the column to
      // fit, so the wider "USD $" text overflowed the cell by a different amount on
      // every group (however many digits happened to follow), landing each
      // subtotal's right edge somewhere different and out of line with the
      // Amount column above it.
      var r =
        '<tr style="break-inside:avoid;">' +
        '<td colspan="4" style="padding:5px 10px 7px 0;font-size:11px;text-align:right;color:#7b8190;">Subtotal</td>' +
        '<td style="padding:5px 0 7px 10px;font-size:11px;text-align:right;font-weight:700;white-space:nowrap;">' +
        fmtMoney(groupOpenSub) +
        '</td></tr>';
      groupOpenSub = null;
      return r;
    }
    var counted = countedRevenueByIndex(d.lines || []);
    // Printed once per GROUP section (reset in the GROUP branch below), the first
    // time that section reaches a bundle-child ("Included") row, on a Canadian
    // proposal — labels the rows that already render this way as the reference
    // template's "Configuration Schedule -- components of the system above." A
    // proposal with two separately bundled systems gets one heading per system, not
    // one for the whole document. Purely an inserted heading row; changes nothing
    // about which rows print "Included" or how the subtotal is computed.
    var configScheduleHeadingPrinted = false;
    (d.lines || []).forEach(function (l, idx) {
      var lt = l.lineType || 'PRODUCT';
      if (lt === 'GROUP') {
        body += subtotalRow();
        body += openSection();
        groupOpenSub = 0;
        inSub = false;
        // Reset per GROUP, not once for the whole document: a proposal with two
        // separately bundled systems (two GROUP sections each with their own
        // "Included" bundle-child rows) gets its own Configuration Schedule heading
        // above each one, rather than only the first.
        configScheduleHeadingPrinted = false;
        // The section note (frame dimensions and the like) sits in the SKU column
        // rather than trailing the heading, so it lines up with the specification
        // columns beneath it instead of colliding with a long section name.
        // The heading and its "· OPTIONAL" tag print as one line, never two: the tag is
        // part of the tier name, and wrapped below it read as a second heading. The name
        // column is a fixed width, so a long name steps the type down a size instead.
        // A Canadian proposal drops the tag entirely — Summit does not present the
        // customer a configuration choice on those documents. `l.optional` itself is
        // untouched; only the printed tag is suppressed.
        var showOptional = l.optional && !cbIsCanadian(d);
        var headLen = (tc(stripOptional(l.name)) + (showOptional ? ' · OPTIONAL' : '')).length;
        var headFs = headLen > 46 ? '10px' : headLen > 40 ? '11px' : '12px';
        var headLs = headLen > 40 ? '.06em' : '.1em';
        body +=
          '<tr data-brk="head" style="break-inside:avoid;break-after:avoid;">' +
          '<td style="padding:7px 0 4px;font-weight:700;font-size:' +
          headFs +
          ';letter-spacing:' +
          headLs +
          ';text-transform:uppercase;color:#203060;white-space:nowrap;">' +
          esc(tc(stripOptional(l.name))) +
          (showOptional ? ' <span style="font-weight:400;color:#9aa1b0;">· OPTIONAL</span>' : '') +
          '</td>' +
          '<td colspan="4" style="padding:7px 10px 4px;font-size:11px;color:#5b6478;vertical-align:bottom;">' +
          (l.description ? esc(l.description) : '') +
          '</td></tr>';
        return;
      }
      if (lt === 'SUBGROUP') {
        inSub = true;
        var subNote = String(l.description || '').trim();
        body +=
          '<tr data-brk="head" style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:2px 0 2px 14px;font-weight:600;font-size:11px;color:#5b6478;letter-spacing:.03em;">' +
          esc(tc(l.name)) +
          (subNote
            ? '<div style="font-weight:400;font-size:10.5px;color:#5b6478;margin-top:2px;line-height:1.5;">' +
              rt(subNote) +
              '</div>'
            : '') +
          '</td></tr>';
        return;
      }
      // A note reads as belonging to the section it was added under, so it takes the
      // same indent as the lines around it rather than sitting flush left where it
      // looked like a statement about the whole proposal.
      if (lt === 'NOTE') {
        // An emphasised note is boxed and ruled, so the paragraph that has to be read
        // — the engineer-of-record wording, a lead time — is not skimmed past as
        // boilerplate. Everything else keeps the quiet cream background.
        var noteBox = l.emphasis
          ? 'background:#f3f6fb;border:1px solid #203060;border-radius:9px;padding:9px 12px;'
          : 'background:#f7f9fc;border-radius:7px;padding:7px 10px;';
        body +=
          '<tr style="break-inside:avoid;"><td colspan="5" style="padding:3px 0 3px ' +
          lineIndent() +
          'px;font-size:10.5px;color:#20241f;line-height:1.45;">' +
          '<div style="' +
          noteBox +
          '">' +
          '<b style="display:block;margin-bottom:3px;' +
          (l.emphasis
            ? 'font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:#203060;'
            : 'color:#20241f;') +
          '">' +
          esc(tc(l.name)) +
          '</b>' +
          rt(l.description) +
          '</div></td></tr>';
        return;
      }
      var amt = (Number(l.quantity) || 0) * (Number(l.rateMinor) || 0);
      // On a Canadian proposal a bundle-child row (the '— ' component lines under a
      // priced parent, see isBundleChild) prints "Included" instead of its own
      // Rate/Amount figures, mirroring the reference template's Configuration
      // Schedule. The parent's own priced line, and the group subtotal, are
      // untouched — only the bundle's zero-rated component rows change how they
      // print, not what they're worth.
      var isIncluded = cbIsCanadian(d) && isBundleChild(l);
      if (isIncluded && !configScheduleHeadingPrinted) {
        configScheduleHeadingPrinted = true;
        body +=
          '<tr data-brk="head" style="break-inside:avoid;break-after:avoid;"><td colspan="5" style="padding:6px 0 3px ' +
          lineIndent() +
          'px;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#3d4a55;">' +
          'Configuration Schedule — Components of the System Above' +
          '</td></tr>';
      }
      var indent = lineIndent();
      // The freight-undetermined note is a sentence, not a product description, so it
      // runs the width of the specification columns instead of wrapping three times
      // inside the narrow name column. It carries the row's rule, and the line above
      // it gives its rule up, so the note reads as part of that line.
      var freightNote = showsFreightTbd(l);
      var rowRule = freightNote ? '' : 'border-bottom:1px solid #eceef4;';
      if (groupOpenSub != null) groupOpenSub += counted[idx] + (Number(l.tpFreightMinor) || 0);
      body +=
        '<tr style="break-inside:avoid;"><td style="padding:2px 0 2px ' +
        indent +
        'px;font-size:11px;line-height:1.25;' +
        rowRule +
        'vertical-align:top;">' +
        esc(tc(l.name)) +
        '</td>' +
        '<td style="padding:2px 10px;' +
        rowRule +
        'font-size:11px;color:#7b8190;vertical-align:top;font-family:ui-monospace,monospace;overflow-wrap:anywhere;">' +
        esc(l.sku || '') +
        '</td>' +
        '<td style="padding:2px 10px;' +
        rowRule +
        'font-size:11px;text-align:right;vertical-align:top;">' +
        (Number(l.quantity) || 0) +
        '</td>' +
        '<td style="padding:2px 10px;' +
        rowRule +
        'font-size:11px;text-align:right;vertical-align:top;">' +
        (isIncluded ? '' : fmtMoney(l.rateMinor, '')) +
        '</td>' +
        '<td style="padding:2px 0 2px 10px;' +
        rowRule +
        'font-size:11px;text-align:right;vertical-align:top;font-weight:700;color:#203060;">' +
        (isIncluded ? 'Included' : fmtMoney(amt, '')) +
        '</td></tr>';
      // Prose belongs to the whole row, not to the name column: a description or a
      // freight sentence runs the full width of the table rather than wrapping three
      // times inside a 430px column while the numeric columns sit empty beside it.
      var prose = '';
      if (l.description)
        prose +=
          '<div style="font-size:10.5px;color:#5b6478;line-height:1.45;">' +
          esc(l.description) +
          '</div>';
      if (l.delivery)
        prose +=
          '<div style="font-size:10px;color:#7b8190;margin-top:2px;">Delivery: ' +
          esc(l.delivery) +
          '</div>';
      if (freightNote)
        prose +=
          '<div style="font-size:10px;color:#5b6478;line-height:1.5;font-style:italic;' +
          (prose ? 'margin-top:2px;' : '') +
          '">' +
          esc(rules.freightTbdNote) +
          '</div>';
      if (prose) {
        body +=
          '<tr style="break-inside:avoid;"><td colspan="5" style="padding:0 0 5px ' +
          indent +
          'px;border-bottom:1px solid #eceef4;">' +
          prose +
          '</td></tr>';
      }
      if (Number(l.tpFreightMinor) > 0) {
        body +=
          '<tr style="break-inside:avoid;"><td style="padding:2px 0 6px 20px;border-bottom:1px solid #eceef4;font-size:10.5px;color:#5b6478;font-style:italic;">+ ' +
          esc(tc(l.tpFreightLabel || 'Third-Party Freight')) +
          '</td><td style="border-bottom:1px solid #eceef4;"></td><td style="border-bottom:1px solid #eceef4;"></td><td style="border-bottom:1px solid #eceef4;"></td><td style="padding:2px 0 6px 10px;border-bottom:1px solid #eceef4;text-align:right;font-size:10.5px;color:#5b6478;">' +
          fmtMoney(l.tpFreightMinor, '') +
          '</td></tr>';
      }
      // Raw flag values per item, keyed the same way the grid columns are — a
      // column only exists if at least one item in the proposal sets that flag
      // (checked below via bottomFlagCols), so a blank cell here just means this
      // particular item didn't set a flag that some other item did.
      var itemFlags = {};
      var hasAnyFlag = false;
      if (l.returnable) {
        itemFlags.returnable = RETURNABLE_LABEL[l.returnable] || l.returnable;
        hasAnyFlag = true;
      }
      if (l.addlFreight) {
        itemFlags.addlFreight = l.addlFreight === 'YES' ? 'Yes' : 'No';
        hasAnyFlag = true;
      }
      if (l.freightCalc) {
        itemFlags.freightCalc = l.freightCalc === 'YES' ? 'Yes' : 'No';
        hasAnyFlag = true;
      }
      if (hasAnyFlag) bottomNotes.push({ name: l.name, flags: itemFlags });
    });
    body += subtotalRow();
    if (tbodyOpen) body += '</tbody>';
    // Columns for the flag grid below: a column only prints if at least one line
    // item actually set that flag, same condition the code used per-item before
    // this became a grid (`if (l.returnable)` / `if (l.addlFreight)` /
    // `if (l.freightCalc)`).
    var bottomFlagCols = [
      { key: 'returnable', label: tc('Returnable') },
      { key: 'addlFreight', label: tc('Additional Freight') },
      { key: 'freightCalc', label: tc('Freight Calculated') },
    ].filter(function (c) {
      return bottomNotes.some(function (n) {
        return Object.prototype.hasOwnProperty.call(n.flags, c.key);
      });
    });
    // Plain HTML table, matching the same fixed/border-collapse technique the
    // line-items table above uses — this file builds print/PDF-safe HTML for a
    // headless-Chromium renderer, so the grid sticks with a layout mechanism
    // that renderer already handles rather than reaching for CSS Grid. No cell
    // or row borders anywhere in it, per Bryan's request.
    var bottomGridHtml = bottomNotes.length
      ? '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' +
        '<thead><tr>' +
        '<th style="text-align:left;padding:0 10px 4px 0;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8190;font-weight:700;">Item</th>' +
        bottomFlagCols
          .map(function (c) {
            return (
              '<th style="text-align:left;padding:0 10px 4px;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#7b8190;font-weight:700;">' +
              esc(c.label) +
              '</th>'
            );
          })
          .join('') +
        '</tr></thead><tbody>' +
        bottomNotes
          .map(function (n) {
            return (
              '<tr><td style="padding:2px 10px 2px 0;font-size:10.5px;color:#20241f;">' +
              esc(tc(n.name)) +
              '</td>' +
              bottomFlagCols
                .map(function (c) {
                  return (
                    '<td style="padding:2px 10px;font-size:10.5px;color:#5b6478;">' +
                    esc(n.flags[c.key] || '') +
                    '</td>'
                  );
                })
                .join('') +
              '</tr>'
            );
          })
          .join('') +
        '</tbody></table>'
      : '';
    var bottomNotesHtml = bottomGridHtml
      ? '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eceef4;font-size:10.5px;color:#5b6478;line-height:1.6;break-inside:avoid;">' +
        '<div style="font-family:\'Newsreader\',Georgia,serif;font-size:15px;font-weight:700;color:#203060;letter-spacing:-.015em;margin-bottom:5px;">Delivery, Returns &amp; Freight Notes</div>' +
        bottomGridHtml +
        '</div>'
      : '';
    var u = rules.documentUser();
    var preparerLine2 = [u.title, u.phone].filter(Boolean).join(' · ');
    // Notes that print beneath the signature lines (terms, acceptance language).
    var footerNotes = (m.footerNotes || []).filter(function (fn) {
      return fn && (fn.title || fn.body);
    });
    var footerNotesHtml = footerNotes.length
      ? '<div style="margin-top:14px;break-inside:avoid;">' +
        footerNotes
          .map(function (fn) {
            return (
              '<div style="margin-bottom:7px;font-size:11.5px;line-height:1.35;color:#20241f;text-wrap:pretty;">' +
              (fn.title
                ? '<div style="font-family:\'Newsreader\',Georgia,serif;font-size:15px;font-weight:700;color:#203060;letter-spacing:-.015em;margin-bottom:4px;">' +
                  esc(fn.title) +
                  '</div>'
                : '') +
              rt(fn.body) +
              '</div>'
            );
          })
          .join('') +
        '</div>'
      : '';
    // Not escaped here — its only use (below) wraps it in a larger string that gets
    // escaped as a whole; escaping twice turned a literal "&" in a proposal number
    // into "&amp;amp;" on the printed footer.
    var docIdent = [
      d.number || '',
      (Number(d.version) || 1) > 1 ? 'Revision ' + (Number(d.version) - 1) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    var preparedBy =
      // Line rhythm matches the "Prepared For" block below it — same 12px size and
      // the same 1px / 2px steps between lines, so the two read as one system.
      '<div style="margin-top:29px;">' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;">Proposal Prepared By</div>' +
      '<div style="font-size:12.5px;font-weight:700;color:#20241f;line-height:1.2;margin-top:3px;">' +
      esc(u.name || u.email || '') +
      '</div>' +
      (preparerLine2
        ? '<div style="font-size:12px;color:#5b6478;line-height:1.2;">' +
          esc(preparerLine2) +
          '</div>'
        : '') +
      (u.email
        ? '<div style="font-size:12px;color:#5b6478;line-height:1.2;">' + esc(u.email) + '</div>'
        : '') +
      '</div>';
    // The introduction prints ahead of the pricing document and is part of the same
    // string, so preview, print, the PDF render and the e-sign packet all carry it
    // without any of them having to know it exists. The scope — introduction, proposal
    // or both — is a live choice rather than a saved field, so it works on any version
    // at any time; see proposal-front-matter.js.
    var scope = window.SSGFrontMatter ? window.SSGFrontMatter.scope() : 'BOTH';
    var frontMatter =
      scope !== 'PROPOSAL' && window.SSGFrontMatter && window.SSGFrontMatter.applies(d)
        ? window.SSGFrontMatter.introHtml(d, { user: u, depositPct: depositPct() })
        : '';
    if (scope === 'INTRO' && frontMatter) return frontMatter;
    var html =
      frontMatter +
      '<div id="propPrintArea" data-foot-left="' +
      esc('Summit Sensory Gym · ' + docIdent) +
      '" data-foot-right="' +
      esc(d.orgName || '') +
      '" ' +
      'style="max-width:816px;margin:0 auto;background:#fff;padding:46px 44px 40px;box-sizing:border-box;font-family:\'IBM Plex Sans\',sans-serif;color:#20241f;">' +
      '<div style="border-bottom:2px solid #203060;padding-bottom:15px;margin-bottom:13px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:30px;">' +
      '<div style="display:flex;flex-direction:column;">' +
      '<div style="display:flex;gap:14px;align-items:flex-start;"><img src="logo.png" alt="Summit Sensory Gym" width="74" height="74" style="width:74px;height:74px;display:block;flex:none;"><div><div style="font-family:\'Newsreader\',serif;font-weight:700;font-size:23px;letter-spacing:-.015em;line-height:1.15;">Summit Sensory Gym</div><div style="font-size:11.5px;color:#5b6478;line-height:1.35;margin-top:1px;">6150 S Geneva Ct, Englewood, CO 80111<br>(720) 457-5500 · Sales@SummitSensory.com</div></div></div>' +
      preparedBy +
      '</div>' +
      '<div style="text-align:right;flex:none;"><div style="font-family:\'Newsreader\',serif;font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1.1;">Proposal</div><div style="font-size:11.5px;color:#5b6478;margin-top:5px;">' +
      esc(d.number || '') +
      // The number stays constant across revisions so both sides can say "P-2026-000021"
      // and mean the project. The revision is what distinguishes the documents, so it
      // prints beside it — and only from v2, because a first proposal is not a revision
      // of anything and "Revision 1" on it just invites the question.
      ((Number(d.version) || 1) > 1 ? ' · Revision ' + (Number(d.version) - 1) : '') +
      '</div>' +
      '<div style="font-size:11.5px;color:#5b6478;margin-top:7px;line-height:1.75;">' +
      '<div>Proposal Date: <b style="color:#20241f;">' +
      (m.proposalDate ? fmtDate(m.proposalDate) : fmtDate(todayISO())) +
      '</b></div>' +
      (m.expiration
        ? '<div>Expiration Date: <b style="color:#20241f;">' + fmtDate(m.expiration) + '</b></div>'
        : '') +
      (function () {
        var model = proposalModelCode(d.lines);
        return model ? '<div>Model: <b style="color:#20241f;">' + esc(model) + '</b></div>' : '';
      })() +
      (m.showProjectId !== false && m.projectId
        ? '<div>Project ID: <b style="color:#20241f;">' + esc(m.projectId) + '</b></div>'
        : '') +
      // Weight is not shown to a Canadian customer (a pure presentation
      // suppression — internal/BOM/freight weight data is untouched). The same
      // header slot instead prints the human-entered tariff classification code,
      // when one has been entered — see tariffClassificationCode on
      // ProposalCustomsEntry / CrossBorderState. Never inferred or computed here.
      (cbIsCanadian(d)
        ? d.crossBorder.tariffClassificationCode
          ? '<div>Tariff Classification: <b style="color:#20241f;">' +
            esc(d.crossBorder.tariffClassificationCode) +
            '</b></div>'
          : ''
        : '<div>Total Weight: <b style="color:#20241f;">' +
          (Number(t.weight) || 0).toLocaleString() +
          ' lbs</b></div>') +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div style="display:flex;gap:36px;margin-bottom:14px;">' +
      '<div style="flex:1;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;">Prepared For</div><div style="font-size:12.5px;font-weight:700;color:#20241f;line-height:1.2;margin-top:4px;">' +
      esc(d.orgName || '') +
      '</div>' +
      (m.contactName
        ? '<div style="font-size:12px;color:#20241f;line-height:1.2;">' +
          esc(m.contactName) +
          '</div>'
        : '') +
      (m.billTo
        ? '<div style="font-size:12px;color:#20241f;line-height:1.2;white-space:pre-line;">' +
          esc(m.billTo) +
          '</div>'
        : '') +
      '</div>' +
      (m.shipTo
        ? '<div style="flex:1;"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;">Ship To</div><div style="font-size:12px;color:#20241f;line-height:1.2;margin-top:4px;white-space:pre-line;">' +
          esc(m.shipTo) +
          '</div></div>'
        : '') +
      '</div>' +
      (m.showTitle !== false && d.title
        ? '<div data-fit-one-line style="font-family:\'Newsreader\',serif;font-size:23px;font-weight:700;color:#203060;letter-spacing:-.015em;margin:0;padding:0 0 28px;white-space:nowrap;">' +
          esc(d.title) +
          '</div>'
        : '') +
      cbFxBanner(d) +
      cbSectionLabel(d, 'Section A — Therapeutic Apparatus') +
      // Fixed layout with an explicit colgroup: the description column keeps the
      // width it was designed at, so a product name stays on one line and every row
      // is the same height. Left to itself the table would rebalance the columns
      // around the widest spanning cell — a section note or a freight sentence —
      // and squeeze the names into wrapping.
      '<table style="width:100%;table-layout:fixed;border-collapse:collapse;">' +
      '<colgroup><col style="width:430px;"><col style="width:100px;"><col style="width:40px;"><col style="width:80px;"><col style="width:78px;"></colgroup>' +
      '<thead><tr style="color:#7b8190;font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;font-weight:700;"><th style="text-align:left;padding:0 0 6px;border-bottom:1.5px solid #203060;font-weight:700;">Activity / Description</th><th style="text-align:left;padding:0 10px 6px;border-bottom:1.5px solid #203060;font-weight:700;">SKU</th><th style="text-align:right;padding:0 10px 6px;border-bottom:1.5px solid #203060;font-weight:700;">Qty</th><th style="text-align:right;padding:0 10px 6px;border-bottom:1.5px solid #203060;font-weight:700;">Rate</th><th style="text-align:right;padding:0 0 6px 10px;border-bottom:1.5px solid #203060;font-weight:700;">Amount</th></tr></thead>' +
      (body.indexOf('<tbody') === 0 ? '' : '<tbody>') +
      body +
      (body.indexOf('<tbody') === 0 ? '' : '</tbody>') +
      '</table>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:18px;break-inside:avoid;"><div style="min-width:' +
      (cbApplies(d) ? '340px' : '300px') +
      ';">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px;"><span style="font-weight:700;color:#20241f;">Subtotal</span><span style="text-align:right;">' +
      cbAmt(t.subtotal) +
      '</span></div>' +
      // Red and bold on purpose: the one line on the totals block the customer is
      // most likely to be looking for, and the only one that moves in their favour.
      (t.discount
        ? '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px;"><span style="font-weight:700;color:#20241f;">' +
          discountLabel(t) +
          '</span><span style="text-align:right;color:#d02030;font-weight:700;">− ' +
          cbAmt(t.discount) +
          '</span></div>' +
          '<div style="font-size:10.5px;color:#9aa1b0;text-align:right;">Discount expires ' +
          (m.expiration ? fmtDate(m.expiration) : 'with this proposal') +
          '</div>'
        : '') +
      cbSectionLabel(d, 'Section B — Delivery and Post-Importation Services') +
      (t.tpFreight
        ? '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px;"><span style="font-weight:700;color:#20241f;">Third-Party Freight</span><span style="text-align:right;">' +
          cbAmt(t.tpFreight) +
          '</span></div>'
        : '') +
      '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span style="font-weight:700;color:#20241f;">Mat Freight Tax Pass-Through</span><span style="text-align:right;">' +
      cellTax +
      '</span></div>' +
      '<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12px;"><span style="font-weight:700;color:#20241f;">Structure Crating &amp; Freight</span><span style="text-align:right;">' +
      cellStructureFreight +
      '</span></div>' +
      '<div style="display:flex;justify-content:space-between;padding:2px 0 7px;font-size:12px;"><span style="font-weight:700;color:#20241f;">Mats &amp; Padding Freight</span><span style="text-align:right;">' +
      cellMatsFreight +
      '</span></div>' +
      // Standard Freight is opt-in: unticked, the customer never sees the line.
      (m.stdFreightOn
        ? '<div style="display:flex;justify-content:space-between;padding:2px 0 7px;font-size:12px;"><span style="font-weight:700;color:#20241f;">Standard Freight</span><span style="text-align:right;">' +
          amountCell(t.stdFreight, '') +
          '</span></div>'
        : '') +
      cbSectionBItems(d) +
      // Tariff, brokerage and Canadian tax, where Summit is collecting them. The
      // rate prints beside the label where the engine has one, so the figure can be
      // checked against it.
      cbSellerLines(d)
        .map(function (l) {
          return (
            '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px;">' +
            '<span style="font-weight:700;color:#20241f;">' +
            esc(l.label) +
            (l.percent
              ? ' <span style="font-weight:400;color:#7b8190;">' + esc(l.percent) + '%</span>'
              : '') +
            '</span><span style="text-align:right;">' +
            cbAmt(l.usdMinor) +
            '</span></div>'
          );
        })
        .join('') +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-top:7px;border-top:1.5px solid #203060;"><span style="font-family:\'Newsreader\',serif;font-size:18px;font-weight:700;color:#203060;">' +
      (cbIsCanadian(d) ? 'Total payable to Summit' : 'Total') +
      '</span><span style="font-size:17px;font-weight:700;color:#203060;letter-spacing:-.01em;text-align:right;">' +
      cbAmt(docTotal) +
      '</span></div>' +
      (anyTbd
        ? '<div style="padding-top:3px;font-size:10.5px;color:#9aa1b0;text-align:right;line-height:1.5;">Total excludes items marked TBD.</div>'
        : '') +
      (m.showDeposit !== false
        ? '<div style="display:flex;justify-content:space-between;padding-top:3px;font-size:11.5px;font-weight:700;"><span style="color:#7b8190;">Deposit Due (' +
          depositPct() +
          '%)</span><span style="text-align:right;">' +
          cbAmt(docDeposit) +
          '</span></div>'
        : '') +
      cbBorderBlock(d) +
      cbRateStamp(d) +
      cbSectionCTable(d) +
      '</div></div>' +
      bottomNotesHtml +
      // Acceptance and the terms always begin a fresh sheet, whatever the line count.
      // Signing is the act the document exists for, so the page a customer signs is
      // never a page that happens to have room left at the bottom of the pricing —
      // and it can be printed, signed and returned on its own.
      '<div data-page-break="acceptance" style="break-before:page;page-break-before:always;">' +
      // A short masthead reidentifies the sheet once it is separated from page one.
      '<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:2px solid #203060;">' +
      '<div style="display:flex;gap:11px;align-items:center;">' +
      '<img src="logo.png" alt="Summit Sensory Gym" width="34" height="34" style="width:34px;height:34px;display:block;flex:none;">' +
      '<div style="font-family:\'Newsreader\',serif;font-size:15px;font-weight:700;color:#20241f;">Summit Sensory Gym</div>' +
      '</div>' +
      '<div style="font-size:10.5px;color:#7b8190;">' +
      [
        esc(d.number || ''),
        (Number(d.version) || 1) > 1 ? 'Revision ' + (Number(d.version) - 1) : '',
        esc(d.orgName || ''),
      ]
        .filter(Boolean)
        .join(' · ') +
      '</div>' +
      '</div>' +
      '<div style="margin-top:26px;break-inside:avoid;">' +
      '<div style="font-family:\'Newsreader\',serif;font-size:15px;font-weight:700;color:#203060;letter-spacing:-.015em;">Acceptance</div>' +
      '<div style="font-size:11.5px;color:#5b6478;line-height:1.6;margin-top:5px;font-weight:700;">Sign below to accept this proposal at a total of ' +
      cbInline(docTotal) +
      (m.showDeposit !== false
        ? ', with a deposit of ' + money(docDeposit) + ' due to initiate production'
        : '') +
      '.</div>' +
      mediaRebateAcknowledgmentHtml(d) +
      cbAcceptanceTextHtml(d) +
      '<div style="display:flex;gap:26px;margin-top:24px;">' +
      // The customer's name prints on the signer line itself. It is the one field on
      // this page the document already knows, and printing it removes the most common
      // reason a signed sheet comes back unusable: the wrong name, or none at all.
      // Sized larger and bold, like the "Proposal Prepared By" name elsewhere on this
      // document, so the printed name reads as a name on a signature line rather than
      // blending into the surrounding prose (it was 11.5px/normal-weight, sized to
      // match the acceptance/terms prose instead). Blank when no contact is on the
      // proposal, which leaves the line exactly as it printed before.
      '<div style="flex:1.35;"><div style="border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"><span style="font-size:14px;font-weight:600;line-height:1.3;color:#20241f;">' +
      esc(m.contactName || '') +
      '</span></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Authorized Signer\'s Name</div></div>' +
      // These two ids are where the e-sign package places the customer's actual
      // signature/date fields (see injectSignatureFields in
      // src/integrations/docuseal/assembly.ts) — empty here for print, screen
      // and email, exactly as they always were. flex/align-items/padding-bottom
      // match the name box above: without it, DocuSeal draws the signature
      // image at the top of this box's own line-height rather than resting on
      // the rule at the bottom, floating it above the line instead of on it.
      //
      // position:relative, not overflow:hidden. A prior fix put overflow:hidden
      // (plus min-width:0 on the flex wrapper) directly on this box, reasoning
      // that it would stop the box from growing to fit the raw DocuSeal tag
      // text ("{{Customer Date;role=Customer;type=datenow;valign=bottom}}")
      // that briefly sits here before DocuSeal ever sees this page. It did stop
      // the box from growing — but overflow:hidden clips the tag's own text
      // along with it, before DocuSeal ever reads it, and a tag DocuSeal
      // receives without its closing "}}" is not a tag it can recognize at
      // all. That is a worse failure than the one it replaced: no field is
      // created, and the clipped, literal tag text is what a customer actually
      // sees and is asked to sign around instead of a real signature box —
      // exactly what reached P-2026-000110's customer. See invisibleTag() in
      // assembly.ts for the actual fix: the tag now renders as absolutely
      // positioned, invisible text, so it can never grow this box or get
      // clipped by anything, and DocuSeal receives it complete.
      //
      // Two nested boxes, not one: the OUTER box owns the border-bottom line and the
      // saved SIZE — it never moves. The INNER box (the actual "ssgSig..." id
      // injectSignatureFields matches) owns only the saved POSITION nudge, absolutely
      // positioned within the outer box. A saved nudge used to be applied to this same
      // single box, which moved the line right along with the field — see
      // public/signature-field-layout.js's own comment for the real proposal that
      // exposed it.
      '<div style="flex:1.35;"><div style="position:relative;border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;' +
      sigSize('ssgSigAcceptanceSignature') +
      '"><div id="ssgSigAcceptanceSignature" style="position:absolute;top:0;left:0;' +
      sigPosition('ssgSigAcceptanceSignature') +
      '"></div></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Signature</div></div>' +
      // flex:1.35, matching Name and Signature — this used to be flex:1 (a plain 1/3.7
      // share against the other two columns' 1.35 each), which made the Date line
      // visibly shorter than the other two on a printed/signed proposal. All three
      // are equal-length now.
      '<div style="flex:1.35;"><div style="position:relative;border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;' +
      sigSize('ssgSigAcceptanceDate') +
      '"><div id="ssgSigAcceptanceDate" style="position:absolute;top:0;left:0;' +
      sigPosition('ssgSigAcceptanceDate') +
      '"></div></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Date</div></div>' +
      '</div>' +
      '</div>' +
      footerNotesHtml +
      cbClauses(d) +
      '</div>' +
      // The general release and the standard terms, after the acceptance page. Every
      // template carries them except the cover-only one — see contract-pages.js.
      (window.SSGContractPages && window.SSGContractPages.applies(d)
        ? window.SSGContractPages.html(d, { esc: esc, user: u })
        : '') +
      // The Customer Project Media Rebate program, when Summit offered it on this
      // proposal — see mediaRebateSectionHtml(). Empty string when not offered, so
      // this is fully inert for the vast majority of proposals.
      mediaRebateSectionHtml(d) +
      '</div>';
    return html;
  }

  window.SSGProposalDocument = {
    /**
     * Supply the shared business rules. Called once by app.js as it loads.
     *
     * Throws on a missing one rather than falling back, for the reason above.
     */
    useRules: function (supplied) {
      var given = supplied || {};
      var names = Object.keys(rules);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        // freightTbdNote is a string; everything else is a function.
        var ok =
          name === 'freightTbdNote'
            ? typeof given[name] === 'string' && given[name].length > 0
            : typeof given[name] === 'function';
        if (!ok) throw new Error('SSGProposalDocument.useRules: missing or wrong type — ' + name);
        rules[name] = given[name];
      }
    },

    /** The document, as HTML. `doc` is the model app.js assembles. */
    html: function (doc) {
      return proposalDocHtml(doc);
    },
  };
})();

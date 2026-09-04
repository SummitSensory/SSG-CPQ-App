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
    var res = cb.result;
    var ior = ((res && res.lines) || []).some(function (l) {
      return l.payableTo === 'CUSTOMS_OR_BROKER';
    });

    var para = function (title, text) {
      return '<div style="margin-bottom:6px;"><b>' + esc(title) + '</b> ' + text + '</div>';
    };

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
      para(
        'Responsibility for Border Charges.',
        'Except for any amount expressly identified on this proposal as fixed and included in the total payable to Summit Sensory Gym, the customer is responsible for all customs duties, tariffs, surtaxes, safeguard and anti-dumping measures, import taxes, brokerage charges, storage, demurrage, examination and inspection fees, disbursements and penalties assessed on the importation of the goods, together with any increase in those amounts arising after the proposal date. Summit Sensory Gym has no control over the classification, valuation or rate applied by the Canada Border Services Agency or by the customs broker, does not act as the importer of record unless this proposal expressly states otherwise, and is not liable for any such charge, for any increase in one, or for delay, storage or additional cost arising from a customs examination, a re-determination of classification or origin, or a change in law. Where Summit Sensory Gym advances any such amount on the customer\u2019s behalf, it is reimbursable in full.',
      ),
      para(
        'CUSMA Treatment.',
        'Preferential tariff treatment under the Canada\u2013United States\u2013Mexico Agreement applies only when the goods satisfy the applicable rules of origin and the required origin documentation is available and accepted. Shipment from the United States does not, by itself, establish eligibility for preferential tariff treatment.',
      ),
    ];

    if (ior) {
      out.push(
        para(
          'Importer of Record.',
          'Unless otherwise stated in this proposal, the customer will serve as the importer of record and will be responsible for customs clearance, importer registration, permits, duties, tariffs, import taxes, brokerage, disbursement fees, bond charges, inspections, storage, and other charges associated with importing the goods into Canada. Any such amounts shown in this proposal are estimates and are not included in the amount payable to Summit Sensory Gym unless expressly stated.',
        ),
      );
      out.push(
        para(
          'Estimated Import Taxes.',
          'Any import GST, provincial tax, harmonized tax, or other import tax identified in this proposal is an estimate for budgeting purposes and is not collected by Summit Sensory Gym unless expressly stated otherwise. Final import taxes may be assessed and collected by the Canada Border Services Agency, the customs broker, the carrier, or another governmental authority. The customer is responsible for the final assessed amount.',
        ),
      );
    } else {
      out.push(
        para(
          'Importer of Record and Reconciliation.',
          'Summit Sensory Gym will serve as the importer of record only where expressly stated in this proposal. Estimated customs duties, tariffs, import taxes, and brokerage charges are based on information available on the proposal date. These amounts may be reconciled to the actual amounts assessed at importation. Any additional amount or credit resulting from that reconciliation will be reflected on a supplemental invoice or credit, subject to the terms of this proposal.',
        ),
      );
    }

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

    return (
      '<div style="margin-top:14px;padding-top:8px;border-top:1px solid #d5d8d2;font-size:9.5px;line-height:1.6;color:#5c6157;">' +
      '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#3d4a55;margin-bottom:5px;">Cross-border terms</div>' +
      out.join('') +
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
      var r =
        '<tr style="break-inside:avoid;">' +
        '<td colspan="4" style="padding:5px 10px 7px 0;font-size:11px;text-align:right;color:#7b8190;">Subtotal</td>' +
        '<td style="padding:5px 0 7px 10px;font-size:11px;text-align:right;font-weight:700;white-space:nowrap;">' +
        money(groupOpenSub) +
        '</td></tr>';
      groupOpenSub = null;
      return r;
    }
    var counted = countedRevenueByIndex(d.lines || []);
    (d.lines || []).forEach(function (l, idx) {
      var lt = l.lineType || 'PRODUCT';
      if (lt === 'GROUP') {
        body += subtotalRow();
        body += openSection();
        groupOpenSub = 0;
        inSub = false;
        // The section note (frame dimensions and the like) sits in the SKU column
        // rather than trailing the heading, so it lines up with the specification
        // columns beneath it instead of colliding with a long section name.
        // The heading and its "· OPTIONAL" tag print as one line, never two: the tag is
        // part of the tier name, and wrapped below it read as a second heading. The name
        // column is a fixed width, so a long name steps the type down a size instead.
        var headLen = (tc(stripOptional(l.name)) + (l.optional ? ' · OPTIONAL' : '')).length;
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
          (l.optional ? ' <span style="font-weight:400;color:#9aa1b0;">· OPTIONAL</span>' : '') +
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
        fmtMoney(l.rateMinor, '') +
        '</td>' +
        '<td style="padding:2px 0 2px 10px;' +
        rowRule +
        'font-size:11px;text-align:right;vertical-align:top;font-weight:700;color:#203060;">' +
        fmtMoney(amt, '') +
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
      var flags = [];
      if (l.returnable) flags.push('Returnable: ' + (l.returnable === 'YES' ? 'Yes' : 'No'));
      if (l.addlFreight)
        flags.push('Additional freight: ' + (l.addlFreight === 'YES' ? 'Yes' : 'No'));
      if (l.freightCalc)
        flags.push('Freight calculated: ' + (l.freightCalc === 'YES' ? 'Yes' : 'No'));
      if (flags.length) bottomNotes.push({ name: l.name, text: flags.join(' · ') });
    });
    body += subtotalRow();
    if (tbodyOpen) body += '</tbody>';
    var bottomNotesHtml = bottomNotes.length
      ? '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eceef4;font-size:10.5px;color:#5b6478;line-height:1.6;break-inside:avoid;"><div style="font-family:\'Newsreader\',Georgia,serif;font-size:15px;font-weight:700;color:#203060;letter-spacing:-.015em;margin-bottom:5px;">Delivery, Returns &amp; Freight Notes</div>' +
        bottomNotes
          .map(function (n) {
            return (
              '<div><b style="font-weight:600;">' +
              esc(tc(n.name)) +
              ':</b> ' +
              esc(n.text) +
              '</div>'
            );
          })
          .join('') +
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
    var docIdent = [
      esc(d.number || ''),
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
      '<div>Total Weight: <b style="color:#20241f;">' +
      (Number(t.weight) || 0).toLocaleString() +
      ' lbs</b></div>' +
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
      '<div style="display:flex;gap:26px;margin-top:24px;">' +
      // The customer's name prints on the signer line itself. It is the one field on
      // this page the document already knows, and printing it removes the most common
      // reason a signed sheet comes back unusable: the wrong name, or none at all.
      // Sized to match the acceptance and terms prose (11.5px) rather than the small
      // caps label beneath it. Blank when no contact is on the proposal, which leaves
      // the line exactly as it printed before.
      '<div style="flex:1.35;"><div style="border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"><span style="font-size:11.5px;line-height:1.35;color:#20241f;">' +
      esc(m.contactName || '') +
      '</span></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Authorized Signer\'s Name</div></div>' +
      // These two ids are where the e-sign package places the customer's actual
      // signature/date fields (see injectSignatureFields in
      // src/integrations/docuseal/assembly.ts) — empty here for print, screen
      // and email, exactly as they always were. flex/align-items/padding-bottom
      // match the name box above: without it, DocuSeal draws the signature
      // image at the top of this box's own line-height rather than resting on
      // the rule at the bottom, floating it above the line instead of on it.
      '<div style="flex:1.35;"><div id="ssgSigAcceptanceSignature" style="border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Signature</div></div>' +
      '<div style="flex:1;"><div id="ssgSigAcceptanceDate" style="border-bottom:1px solid #20241f;height:40px;display:flex;align-items:flex-end;padding-bottom:3px;"></div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#7b8190;font-weight:700;margin-top:5px;">Date</div></div>' +
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

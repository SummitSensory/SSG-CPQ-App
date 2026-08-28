/**
 * The two contract documents that close a proposal: the release and the standard terms.
 *
 * Kept out of app.js because they are the legal text verbatim and are edited as text,
 * not as code — a lawyer's redline should touch one file and nothing else. Both print
 * after the acceptance page on every proposal that carries an introduction, and neither
 * prints on the cover-page-only template, which exists to be a cover and nothing more.
 *
 * Registers itself on window.SSGContractPages, read by app.js when it builds the
 * document. No dependencies, so it can be loaded before or after app.js.
 */
(function () {
  'use strict';

  var SUMMIT_ADDRESS = '6150 S Geneva Court, Englewood, CO 80111';

  /**
   * The release's own header.
   *
   * No logo and no Summit name: a release is an instrument between two parties, and a
   * letterhead makes it read as correspondence from one of them. The identification it
   * does need — whose release this is and which proposal it belongs to — sits in the
   * top right where a filed document carries its reference.
   */
  function releaseHeader(d, esc) {
    var m = (d && d.meta) || {};
    // The customer alone. A proposal number turns an instrument between two parties
    // into an attachment to a quote, which is not what is being signed.
    var who = d.orgName || m.contactName || '';
    return (
      '<div style="text-align:right;font-size:9pt;line-height:1.5;color:#20241f;font-weight:700;">' +
      esc(who) +
      '</div>'
    );
  }

  function releaseHtml(d, opts) {
    var esc = opts.esc;
    var m = d.meta || {};
    var u = opts.user || {};
    var company = d.orgName || m.contactName || '';

    // The billing address as entered, flattened to one line: the release reads as a
    // sentence, not as an address block.
    //
    // Reps routinely start that block with the company name, and the sentence already
    // names the company. A leading line matching the company is dropped, compared
    // loosely so "Wonderfully Made Therapy Group, LLC." and "wonderfully made therapy
    // group" both count. An attention line belongs on an envelope, not mid-sentence.
    var loose = function (v) {
      return String(v || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    };
    var addressLines = String(m.billTo || m.shipTo || '')
      .split(/\n+/)
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean);
    if (addressLines.length > 1 && company) {
      var head = loose(addressLines[0]);
      var org = loose(company);
      if (head && org && (head === org || head.indexOf(org) === 0 || org.indexOf(head) === 0)) {
        addressLines.shift();
      }
    }
    addressLines = addressLines.filter(function (l) {
      return !/^(attn|attention|c\/o)\b[:.]?/i.test(l);
    });
    var address = addressLines.join(', ');

    // Aptos at 9pt throughout, set once on the wrapper. Everything inside inherits it,
    // so the document cannot drift from the proposal's body face in one clause.
    var BODY =
      "font-family:Aptos,'Segoe UI',Calibri,system-ui,sans-serif;font-size:9pt;line-height:1.35;color:#20241f;";
    var blank = function (label) {
      return '<span style="color:#8a91a0;">[' + label + ']</span>';
    };

    /** A numbered article: the numeral hangs in the margin beside its text. */
    var article = function (numeral, heading, inner) {
      return (
        '<div style="display:flex;gap:10px;margin-top:10px;break-inside:avoid;page-break-inside:avoid;">' +
        '<div style="flex:none;width:30px;font-weight:700;">' +
        numeral +
        '.</div>' +
        '<div style="flex:1;">' +
        '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' +
        heading +
        '</div>' +
        inner +
        '</div></div>'
      );
    };
    var p = function (html, first) {
      return (
        '<p style="margin:' +
        (first ? '0' : '5px') +
        ' 0 0;text-align:justify;text-wrap:pretty;">' +
        html +
        '</p>'
      );
    };
    /** A lettered sub-paragraph, for the two parties under Article I. */
    var sub = function (numeral, html) {
      return (
        '<div style="display:flex;gap:8px;margin-top:4px;">' +
        '<div style="flex:none;width:24px;">' +
        numeral +
        '.</div>' +
        '<div style="flex:1;text-align:justify;text-wrap:pretty;">' +
        html +
        '</div></div>'
      );
    };

    /**
     * The two signature blocks name different people on purpose.
     *
     * The Releasor is the contact the proposal is addressed to — the person who signs
     * it. The Releasee is whoever generated the proposal, not a fixed name: a release
     * that always said one person's name would be wrong the first time anyone else
     * sent one.
     */
    /**
     * A signature block in the conventional form.
     *
     * The entity signs; a person signs FOR it. So the party's name stands alone at the
     * top, then By: with a rule to sign on, then the printed name, then the date.
     *
     * Name is prefilled and Date is left blank on purpose. Who is signing is known when
     * the proposal is written; WHEN they sign is not, and printing a date beside an
     * unsigned rule would state something that has not happened yet.
     */
    var sigBlock = function (role, name, entity) {
      var line = function (label, value, depth) {
        return (
          '<div style="display:flex;gap:6px;align-items:baseline;margin-top:9px;">' +
          '<div style="flex:none;">' +
          label +
          '</div>' +
          '<div style="flex:1;border-bottom:1px solid #20241f;' +
          (depth ? 'height:' + depth + 'px;' : 'padding-bottom:1px;') +
          '">' +
          (value ? esc(value) : '') +
          '</div></div>'
        );
      };
      return (
        '<div style="flex:1;">' +
        '<div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.09em;color:#5b6478;margin-bottom:5px;">' +
        role +
        '</div>' +
        '<div style="font-weight:700;">' +
        (entity ? esc(entity) : '&nbsp;') +
        '</div>' +
        line('By:', '', 46) +
        line('Name:', name) +
        line('Date:', '') +
        '</div>'
      );
    };

    return (
      '<div data-page-break="release" style="break-before:page;page-break-before:always;' +
      BODY +
      '">' +
      releaseHeader(d, esc) +
      '<div style="text-align:center;margin-top:18px;">' +
      '<div style="font-size:15pt;font-weight:700;text-transform:uppercase;letter-spacing:.1em;">General Release of Liability</div>' +
      '<div style="width:88px;height:1px;background:#20241f;margin:7px auto 0;"></div>' +
      '</div>' +
      article(
        'I',
        'The Parties',
        p(
          'This General Release of Liability (\u201cRelease\u201d) is made and entered into as of the date indicated below between:',
          true,
        ) +
          sub(
            'i',
            '<b>RELEASOR:</b> ' +
              (company ? esc(company) : blank('customer')) +
              ' with a mailing address of ' +
              (address ? esc(address) : blank('billing address')) +
              ' (\u201cReleasor\u201d), and;',
          ) +
          sub(
            'ii',
            '<b>RELEASEE:</b> Summit Sensory Gym with a mailing address of ' +
              SUMMIT_ADDRESS +
              '. (\u201cReleasee\u201d).',
          ),
      ) +
      article(
        'II',
        'Liability Event',
        p(
          'Under the terms of this Release and sufficiency of which is hereby acknowledged, the Releasor hereby releases and forever discharges the Releasee of all Summit Sensory Gym structure designs and equipment (\u201cLiability\u201d).',
          true,
        ) +
          p(
            'THEREFORE under the terms of this Agreement and sufficiency of which is hereby acknowledged, do hereby release and forever discharge the Releasee including their agents, employees, successors and assigns, and their respective heirs, personal representatives, affiliates, successors and assigns, and any and all persons, firms or corporations liable or who might be claimed to be liable, whether or not herein named, none of whom admit any liability to the undersigned, but all expressly denying liability, from any and all claims, demands, damages, actions, causes of action or suits of any kind or nature whatsoever, which now have or may hereafter have, arising out of or in any way relating to any and all injuries and damages of any and every kind, to both person and property, and also any and all injuries and damages that may develop in the future, as a result of or in any way relating to the Liability.',
          ) +
          p(
            'As part of this Release, the Parties agree that no payment will be made by the Releasee to the Releasor.',
          ) +
          p(
            'It is understood and agreed that this Release is made and received in full and complete settlement and satisfaction the causes of action, claims and demands mentioned herein; that this Release contains the entire agreement between the Releasor and Releasee; and that the terms of this Release are contractual and not merely a recital.',
          ),
      ) +
      article(
        'III',
        'Binding Effect',
        p(
          'This Release shall be binding upon the undersigned, and his respective heirs, executors, administrators, personal representatives, successors, and assigns.',
          true,
        ),
      ) +
      '<div style="margin-top:16px;padding-top:9px;border-top:1px solid #20241f;text-align:justify;break-inside:avoid;">' +
      'IN WITNESS WHEREOF, the Parties have executed this Release as of the dates written below.' +
      '</div>' +
      '<div style="display:flex;gap:44px;margin-top:12px;break-inside:avoid;page-break-inside:avoid;">' +
      // 46px of clear height above the By: rule, not 26. A wet signature is written
      // large and lands ON the rule rather than between the lines, so at 26px the entity
      // name above it was being written through.
      sigBlock('Releasor', m.contactName || '', company) +
      sigBlock('Releasee', u.name || '', 'Summit Sensory Gym') +
      '</div>' +
      '</div>'
    );
  }

  /** The standard terms, verbatim. */
  var TERMS = [
    {
      t: 'Order Acceptance',
      b: 'A Customer accepts these Terms when the Customer signs or electronically accepts a Summit proposal or agreement, issues a purchase order referencing a Summit proposal, makes a payment or deposit, authorizes Summit to begin work, or accepts delivery of Products or Services. Any additional or conflicting terms contained in a Customer purchase order or other document will not apply unless Summit expressly agrees to them in writing.',
    },
    {
      t: 'Pricing & Payment',
      b: 'Payment is due according to the schedule stated in the applicable proposal or invoice. Unless otherwise stated in writing, a 50% deposit is required to initiate production and the remaining balance is due before shipment. Payment is considered received only when funds have successfully cleared.\n\nPast-due balances may accrue a late charge of 1.5% per month (18% annually), or the maximum amount permitted by applicable law, whichever is less. Customer is responsible for reasonable collection costs, court costs, and attorneys’ fees incurred by Summit in collecting past-due amounts, to the extent permitted by law.\n\nAny good-faith dispute regarding an invoice must be submitted to Summit in writing within 15 days of the invoice date and must identify the specific amount and basis for the dispute. A dispute regarding one portion of an invoice does not relieve Customer of the obligation to timely pay all undisputed amounts. Summit may suspend production, shipment, installation, service, or other performance while required payments remain past due.',
    },
    {
      t: 'Taxes & Governmental Charges',
      b: 'Unless expressly stated otherwise, quoted prices do not include applicable sales, use, excise, value-added, duties, tariffs, levies, or other governmental taxes or charges. Customer is responsible for such amounts, except taxes imposed directly on Summit’s net income. A valid exemption or resale certificate must be provided before the applicable invoice is issued. If applicable governmental charges change after a proposal is issued but before shipment or invoicing, Summit may adjust the applicable amount to reflect the actual charge imposed.',
    },
    {
      t: 'Changes, Cancellations & Returns',
      b: 'Custom Products are non-returnable and non-refundable. No Product may be returned without Summit’s prior written authorization. Customer-requested cancellations or changes are subject to Summit’s written approval. If approved, Customer remains responsible for work completed, work in progress, materials ordered or committed, non-cancellable supplier costs, and any applicable cancellation or restocking charges. Deposits and advance payments become non-refundable once Summit begins design, engineering, procurement, fabrication, customization, or other work specifically associated with the order, except as otherwise agreed by Summit in writing.',
    },
    {
      t: 'Shipping & Delivery',
      b: 'Unless otherwise stated in writing, delivery is F.O.B. Shipping Point and risk of loss or damage passes to Customer when the carrier takes possession of the shipment. Delivery dates are estimates, not guarantees. Summit is not responsible for delays caused by carriers, security requirements, weather, labor shortages, government action, supply constraints, acts of God, or other circumstances beyond Summit’s reasonable control.\n\nCustomer is responsible for accurately disclosing delivery-site requirements before shipment. Additional carrier charges arising from undisclosed or unexpected conditions—including liftgate service, inside delivery, residential delivery, limited-access locations, appointment requirements, re-delivery, storage, or similar accessorial services—may be billed to Customer.',
    },
    {
      t: 'Inspection, Shortages & Delivery Claims',
      b: 'Customer should inspect Products promptly upon delivery. Claims for shortages, shipping errors, or visibly damaged Products must be reported to Summit in writing within 30 days after delivery. Customer should also note visible freight damage on the carrier’s delivery receipt and retain all packaging and supporting documentation needed for a freight claim.',
    },
    {
      t: 'Limited Warranty',
      b: 'Summit warrants its Products against defects in materials and workmanship for one (1) year from the date of shipment when used and installed as intended. This warranty does not cover normal wear, misuse, abuse, impact beyond the Product’s designated working load, improper installation, unauthorized modification, use of incompatible or substandard components, or failure to follow Summit instructions or Product literature.\n\nFor a covered claim, Summit will, at its option, repair or replace the affected Product or component. Transportation, removal, reinstallation, travel, and other on-site costs are not included unless Summit expressly approves them in writing. To the fullest extent permitted by law, this limited warranty is the exclusive Product warranty and Summit disclaims other express or implied warranties, including merchantability and fitness for a particular purpose. Summit is not liable for incidental, special, indirect, or consequential damages to the extent permitted by law.',
    },
    {
      t: 'Security Interest',
      b: 'Until all amounts due are paid in full, Summit retains a purchase-money security interest in unpaid Products to the extent permitted by law. Customer authorizes Summit to file financing statements or other documents reasonably necessary to evidence or protect that interest.',
    },
    {
      t: 'Customer Responsibility & Indemnification',
      b: 'Customer is responsible for the safe operation, supervision, inspection, and maintenance of Products after delivery and for ensuring that Products are used in accordance with Summit instructions and applicable facility policies. Customer agrees to defend, indemnify, and hold Summit harmless from third-party claims, liabilities, costs, and expenses arising from the negligence, misuse, or lack of care of Customer or Customer’s employees, agents, customers, invitees, or other users, except to the extent caused by Summit’s negligence or willful misconduct.',
    },
    {
      t: 'Default & Summit Remedies',
      b: 'If Customer fails to make a required payment or otherwise materially breaches an agreement with Summit, Summit may suspend performance, place orders on hold, cancel outstanding orders, declare amounts then due immediately payable, and exercise any other remedies available under the agreement or applicable law. Customer is responsible for Summit’s reasonable costs of exercising those remedies, including collection costs and attorneys’ fees, to the extent permitted by law.',
    },
    {
      t: 'Governing Law & Venue',
      b: 'These Terms and any transaction between Summit and Customer are governed by the laws of the State of Colorado, without regard to conflict-of-laws principles. Unless the parties expressly agree otherwise in a separately signed writing, the state and federal courts located in Arapahoe County, Colorado will have exclusive jurisdiction and venue over disputes arising from the transaction.',
    },
    {
      t: 'General Terms',
      b: 'These Terms, together with the accepted Summit proposal, applicable invoice, and any separately signed agreement, constitute the parties’ agreement regarding the transaction. If there is a conflict, a separately signed agreement controls, followed by the accepted Summit proposal, these Terms, and then the invoice. Customer purchase-order terms do not modify Summit’s terms unless expressly accepted by Summit in a writing signed by an authorized representative.\n\nSummit’s failure or delay in enforcing a right does not waive that right or any later enforcement. If any provision is found unenforceable, the remaining provisions remain in effect and the affected provision will be enforced to the maximum extent permitted by law. Electronic signatures, electronic acceptance, and electronically transmitted copies have the same force and effect as originals. The version of these Terms provided with or incorporated into the accepted proposal or order governs that transaction.',
    },
  ];

  /**
   * The terms, set as the release is: Aptos 9pt, no letterhead.
   *
   * Unlike the release these run past one sheet, so the running identification repeats
   * — a page of terms that has come loose from the rest should still say what it is and
   * whose transaction it belongs to.
   */
  function termsHtml(d, opts) {
    var esc = opts.esc;
    var m = (d && d.meta) || {};
    var BODY =
      "font-family:Aptos,'Segoe UI',Calibri,system-ui,sans-serif;font-size:9pt;line-height:1.35;color:#20241f;";
    var who = d.orgName || m.contactName || '';

    return (
      '<div data-page-break="terms" style="break-before:page;page-break-before:always;' +
      BODY +
      '">' +
      '<div style="text-align:right;font-size:9pt;line-height:1.5;font-weight:700;">' +
      esc(who) +
      '</div>' +
      '<div style="text-align:center;margin-top:18px;">' +
      '<div style="font-size:15pt;font-weight:700;text-transform:uppercase;letter-spacing:.1em;">Standard Terms &amp; Conditions of Sale</div>' +
      '<div style="width:88px;height:1px;background:#20241f;margin:7px auto 0;"></div>' +
      '</div>' +
      TERMS.map(function (sec, i) {
        return (
          // Short clauses stay whole. The longest are allowed to break, because forcing
          // them onto a fresh sheet would leave a third of a page empty ahead of them.
          '<div style="display:flex;gap:10px;margin-top:' +
          (i ? 10 : 14) +
          'px;' +
          (sec.b.length < 700 ? 'break-inside:avoid;page-break-inside:avoid;' : '') +
          '">' +
          '<div style="flex:none;width:22px;font-weight:700;">' +
          (i + 1) +
          '.</div>' +
          '<div style="flex:1;">' +
          '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' +
          esc(sec.t) +
          '</div>' +
          sec.b
            .split(/\n\s*\n/)
            .map(function (para, j) {
              return (
                '<p style="margin:' +
                (j ? '5px' : '0') +
                ' 0 0;text-align:justify;text-wrap:pretty;">' +
                esc(para) +
                '</p>'
              );
            })
            .join('') +
          '</div></div>'
        );
      }).join('') +
      '</div>'
    );
  }

  window.SSGContractPages = {
    /**
     * True when these pages belong on this document.
     *
     * The cover-only template is the single exception: it exists to be a cover, and a
     * cover followed by six pages of terms is not a cover. A proposal with no
     * introduction at all still gets them — the contract does not depend on the
     * marketing pages in front of it.
     */
    applies: function (doc) {
      var chosen = doc && doc.meta && doc.meta.introTemplate;
      return chosen !== 'COVER';
    },
    /**
     * Both documents unless the proposal turned one off.
     *
     * Absent means included: a proposal saved before this existed carries no flag, and
     * the contract it went out under had both. Only an explicit `false` drops one.
     */
    html: function (doc, opts) {
      opts = opts || {};
      if (!opts.esc)
        opts.esc = function (s) {
          return String(s == null ? '' : s);
        };
      var m = (doc && doc.meta) || {};
      // The order is fixed: the release names the parties the terms then rely on.
      return (
        (m.includeRelease === false ? '' : releaseHtml(doc, opts)) +
        (m.includeTerms === false ? '' : termsHtml(doc, opts))
      );
    },
  };
})();

/**
 * The two contract documents that close a proposal: the release and the standard terms.
 *
 * The TEXT now lives in the database, editable under Administration -> Proposal content,
 * and is fetched once at sign-in. It used to be string literals in this file, which meant
 * a comma in the terms needed a developer and a deploy.
 *
 * The LAYOUT still lives here, unchanged: Aptos 9pt, no letterhead, hanging numerals,
 * the page-break rules that keep short clauses whole and let long ones split, and the two
 * signature blocks. Those are typesetting decisions, not wording, and an administrator
 * editing a clause should not be able to break the printed page.
 *
 * DEFAULTS below is the wording this release was built with. It is the fallback when the
 * fetch has not finished or fails, because a proposal that goes out with no terms
 * attached is far worse than one that goes out with last month's wording. It is also what
 * "restore the shipped wording" restores to, server-side, from src/legal/defaults.ts —
 * the same text, generated from the same source.
 *
 * Registers itself on window.SSGContractPages. app.js calls init({ authed }) alongside
 * the other modules; without that call the defaults print and nothing breaks.
 */
(function () {
  'use strict';

  var SUMMIT_ADDRESS = '6150 S Geneva Court, Englewood, CO 80111';

  /** The wording as shipped. Replaced in memory once the API answers. */
  var DEFAULTS = {
    RELEASE: {
      key: 'RELEASE',
      title: 'General Release of Liability',
      kind: 'ARTICLES',
      articles: [
        {
          numeral: 'I',
          title: 'The Parties',
          paragraphs: [
            'This General Release of Liability (“Release”) is made and entered into as of the date indicated below between:',
          ],
          subs: [
            {
              numeral: 'i',
              text: '**RELEASOR:** {{customer}} with a mailing address of {{billingAddress}} (“Releasor”), and;',
            },
            {
              numeral: 'ii',
              text: '**RELEASEE:** Summit Sensory Gym with a mailing address of {{summitAddress}}. (“Releasee”).',
            },
          ],
        },
        {
          numeral: 'II',
          title: 'Liability Event',
          paragraphs: [
            'Under the terms of this Release and sufficiency of which is hereby acknowledged, the Releasor hereby releases and forever discharges the Releasee of all Summit Sensory Gym structure designs and equipment (“Liability”).',
            'THEREFORE under the terms of this Agreement and sufficiency of which is hereby acknowledged, do hereby release and forever discharge the Releasee including their agents, employees, successors and assigns, and their respective heirs, personal representatives, affiliates, successors and assigns, and any and all persons, firms or corporations liable or who might be claimed to be liable, whether or not herein named, none of whom admit any liability to the undersigned, but all expressly denying liability, from any and all claims, demands, damages, actions, causes of action or suits of any kind or nature whatsoever, which now have or may hereafter have, arising out of or in any way relating to any and all injuries and damages of any and every kind, to both person and property, and also any and all injuries and damages that may develop in the future, as a result of or in any way relating to the Liability.',
            'As part of this Release, the Parties agree that no payment will be made by the Releasee to the Releasor.',
            'It is understood and agreed that this Release is made and received in full and complete settlement and satisfaction the causes of action, claims and demands mentioned herein; that this Release contains the entire agreement between the Releasor and Releasee; and that the terms of this Release are contractual and not merely a recital.',
          ],
          subs: [],
        },
        {
          numeral: 'III',
          title: 'Binding Effect',
          paragraphs: [
            'This Release shall be binding upon the undersigned, and his respective heirs, executors, administrators, personal representatives, successors, and assigns.',
          ],
          subs: [],
        },
      ],
      closing:
        'IN WITNESS WHEREOF, the Parties have executed this Release as of the dates written below.',
    },
    TERMS: {
      key: 'TERMS',
      title: 'Standard Terms & Conditions of Sale',
      kind: 'NUMBERED',
      sections: [
        {
          title: 'Order Acceptance',
          body: 'A Customer accepts these Terms when the Customer signs or electronically accepts a Summit proposal or agreement, issues a purchase order referencing a Summit proposal, makes a payment or deposit, authorizes Summit to begin work, or accepts delivery of Products or Services. Any additional or conflicting terms contained in a Customer purchase order or other document will not apply unless Summit expressly agrees to them in writing.',
        },
        {
          title: 'Pricing & Payment',
          body: 'Payment is due according to the schedule stated in the applicable proposal or invoice. Unless otherwise stated in writing, a 50% deposit is required to initiate production and the remaining balance is due before shipment. Payment is considered received only when funds have successfully cleared.\n\nPast-due balances may accrue a late charge of 1.5% per month (18% annually), or the maximum amount permitted by applicable law, whichever is less. Customer is responsible for reasonable collection costs, court costs, and attorneys’ fees incurred by Summit in collecting past-due amounts, to the extent permitted by law.\n\nAny good-faith dispute regarding an invoice must be submitted to Summit in writing within 15 days of the invoice date and must identify the specific amount and basis for the dispute. A dispute regarding one portion of an invoice does not relieve Customer of the obligation to timely pay all undisputed amounts. Summit may suspend production, shipment, installation, service, or other performance while required payments remain past due.',
        },
        {
          title: 'Taxes & Governmental Charges',
          body: 'Unless expressly stated otherwise, quoted prices do not include applicable sales, use, excise, value-added, duties, tariffs, levies, or other governmental taxes or charges. Customer is responsible for such amounts, except taxes imposed directly on Summit’s net income. A valid exemption or resale certificate must be provided before the applicable invoice is issued. If applicable governmental charges change after a proposal is issued but before shipment or invoicing, Summit may adjust the applicable amount to reflect the actual charge imposed.',
        },
        {
          title: 'Changes, Cancellations & Returns',
          body: 'Custom Products are non-returnable and non-refundable. No Product may be returned without Summit’s prior written authorization. Customer-requested cancellations or changes are subject to Summit’s written approval. If approved, Customer remains responsible for work completed, work in progress, materials ordered or committed, non-cancellable supplier costs, and any applicable cancellation or restocking charges. Deposits and advance payments become non-refundable once Summit begins design, engineering, procurement, fabrication, customization, or other work specifically associated with the order, except as otherwise agreed by Summit in writing.',
        },
        {
          title: 'Shipping & Delivery',
          body: 'Unless otherwise stated in writing, delivery is F.O.B. Shipping Point and risk of loss or damage passes to Customer when the carrier takes possession of the shipment. Delivery dates are estimates, not guarantees. Summit is not responsible for delays caused by carriers, security requirements, weather, labor shortages, government action, supply constraints, acts of God, or other circumstances beyond Summit’s reasonable control.\n\nCustomer is responsible for accurately disclosing delivery-site requirements before shipment. Additional carrier charges arising from undisclosed or unexpected conditions—including liftgate service, inside delivery, residential delivery, limited-access locations, appointment requirements, re-delivery, storage, or similar accessorial services—may be billed to Customer.',
        },
        {
          title: 'Inspection, Shortages & Delivery Claims',
          body: 'Customer should inspect Products promptly upon delivery. Claims for shortages, shipping errors, or visibly damaged Products must be reported to Summit in writing within 30 days after delivery. Customer should also note visible freight damage on the carrier’s delivery receipt and retain all packaging and supporting documentation needed for a freight claim.',
        },
        {
          title: 'Limited Warranty',
          body: 'Summit warrants its Products against defects in materials and workmanship for one (1) year from the date of shipment when used and installed as intended. This warranty does not cover normal wear, misuse, abuse, impact beyond the Product’s designated working load, improper installation, unauthorized modification, use of incompatible or substandard components, or failure to follow Summit instructions or Product literature.\n\nFor a covered claim, Summit will, at its option, repair or replace the affected Product or component. Transportation, removal, reinstallation, travel, and other on-site costs are not included unless Summit expressly approves them in writing. To the fullest extent permitted by law, this limited warranty is the exclusive Product warranty and Summit disclaims other express or implied warranties, including merchantability and fitness for a particular purpose. Summit is not liable for incidental, special, indirect, or consequential damages to the extent permitted by law.',
        },
        {
          title: 'Security Interest',
          body: 'Until all amounts due are paid in full, Summit retains a purchase-money security interest in unpaid Products to the extent permitted by law. Customer authorizes Summit to file financing statements or other documents reasonably necessary to evidence or protect that interest.',
        },
        {
          title: 'Customer Responsibility & Indemnification',
          body: 'Customer is responsible for the safe operation, supervision, inspection, and maintenance of Products after delivery and for ensuring that Products are used in accordance with Summit instructions and applicable facility policies. Customer agrees to defend, indemnify, and hold Summit harmless from third-party claims, liabilities, costs, and expenses arising from the negligence, misuse, or lack of care of Customer or Customer’s employees, agents, customers, invitees, or other users, except to the extent caused by Summit’s negligence or willful misconduct.',
        },
        {
          title: 'Default & Summit Remedies',
          body: 'If Customer fails to make a required payment or otherwise materially breaches an agreement with Summit, Summit may suspend performance, place orders on hold, cancel outstanding orders, declare amounts then due immediately payable, and exercise any other remedies available under the agreement or applicable law. Customer is responsible for Summit’s reasonable costs of exercising those remedies, including collection costs and attorneys’ fees, to the extent permitted by law.',
        },
        {
          title: 'Governing Law & Venue',
          body: 'These Terms and any transaction between Summit and Customer are governed by the laws of the State of Colorado, without regard to conflict-of-laws principles. Unless the parties expressly agree otherwise in a separately signed writing, the state and federal courts located in Arapahoe County, Colorado will have exclusive jurisdiction and venue over disputes arising from the transaction.',
        },
        {
          title: 'General Terms',
          body: 'These Terms, together with the accepted Summit proposal, applicable invoice, and any separately signed agreement, constitute the parties’ agreement regarding the transaction. If there is a conflict, a separately signed agreement controls, followed by the accepted Summit proposal, these Terms, and then the invoice. Customer purchase-order terms do not modify Summit’s terms unless expressly accepted by Summit in a writing signed by an authorized representative.\n\nSummit’s failure or delay in enforcing a right does not waive that right or any later enforcement. If any provision is found unenforceable, the remaining provisions remain in effect and the affected provision will be enforced to the maximum extent permitted by law. Electronic signatures, electronic acceptance, and electronically transmitted copies have the same force and effect as originals. The version of these Terms provided with or incorporated into the accepted proposal or order governs that transaction.',
        },
      ],
    },
  };

  /** Loaded text, by key. Null until the fetch resolves. */
  var LOADED = null;
  var loading = null;
  var H = null;

  function contentFor(key) {
    return (LOADED && LOADED[key]) || DEFAULTS[key];
  }

  /**
   * Fetch the published wording.
   *
   * Fire-and-forget by design: `html()` is called synchronously deep inside the document
   * builder and cannot await anything. In practice the fetch resolves at sign-in, long
   * before anyone opens a proposal. If it has not, or it fails, the shipped text prints.
   */
  function load() {
    if (!H || !H.authed) return Promise.resolve(false);
    if (loading) return loading;
    loading = H.authed('/legal-documents/effective')
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (d) {
        var docs = (d && d.documents) || [];
        if (!docs.length) return false;
        var next = {};
        docs.forEach(function (x) {
          if (x && x.key && x.content) next[x.key] = x.content;
        });
        LOADED = next;
        return true;
      })
      .catch(function () {
        return false;
      });
    return loading;
  }

  /**
   * Fill merge tokens and the one piece of markup.
   *
   * An UNKNOWN token renders as a bracketed grey label, not as literal braces. The save
   * path refuses unknown tokens, so this only fires for text published before a token was
   * renamed — and a visible gap on a legal instrument is something a person notices and
   * fixes, where `{{custmer}}` reads as a system fault nobody can act on.
   *
   * Order matters: escape first, then substitute markup. Doing it the other way round
   * would let an edited clause inject markup through the escaper.
   */
  /**
   * Human labels for the gap a missing value leaves.
   *
   * `[billing address]`, not `[billingAddress]` — the placeholder is read by whoever is
   * about to send the document, and it names the thing they have to go and fill in.
   */
  var TOKEN_LABELS = {
    customer: 'customer',
    billingAddress: 'billing address',
    summitAddress: 'Summit address',
    contactName: 'contact name',
  };

  function fill(text, tokens, esc) {
    var escaped = esc(String(text == null ? '' : text));
    // Tokens survive escaping (braces are not escaped), so they are substituted after,
    // with each VALUE escaped as it goes in.
    escaped = escaped.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (_m, name) {
      var label = TOKEN_LABELS[name] || name;
      if (Object.prototype.hasOwnProperty.call(tokens, name)) {
        var v = tokens[name];
        return v ? esc(v) : '<span style="color:#8a91a0;">[' + esc(label) + ']</span>';
      }
      return '<span style="color:#8a91a0;">[' + esc(label) + ']</span>';
    });
    // **bold** only. The release needs RELEASOR and RELEASEE emphasised; a richer editor
    // would let pasted formatting break the 9pt Aptos the document is set in.
    return escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  /**
   * The release's own header.
   *
   * No logo and no Summit name: a release is an instrument between two parties, and a
   * letterhead makes it read as correspondence from one of them.
   */
  function releaseHeader(d, esc) {
    var m = (d && d.meta) || {};
    var who = d.orgName || m.contactName || '';
    return (
      '<div style="text-align:right;font-size:9pt;line-height:1.5;color:#20241f;font-weight:700;">' +
      esc(who) +
      '</div>'
    );
  }

  /**
   * The customer's billing address, flattened to one line.
   *
   * Reps routinely start that block with the company name, and the sentence already names
   * the company. A leading line matching the company is dropped, compared loosely so
   * "Wonderfully Made Therapy Group, LLC." and "wonderfully made therapy group" both
   * count. An attention line belongs on an envelope, not mid-sentence.
   */
  function flatAddress(m, company) {
    var loose = function (v) {
      return String(v || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    };
    var lines = String(m.billTo || m.shipTo || '')
      .split(/\n+/)
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean);
    if (lines.length > 1 && company) {
      var head = loose(lines[0]);
      var org = loose(company);
      if (head && org && (head === org || head.indexOf(org) === 0 || org.indexOf(head) === 0)) {
        lines.shift();
      }
    }
    return lines
      .filter(function (l) {
        return !/^(attn|attention|c\/o)\b[:.]?/i.test(l);
      })
      .join(', ');
  }

  /*
   * Typeface and layout, as a closed set of choices.
   *
   * Not free-form CSS. These documents are signed instruments printed onto a fixed
   * 816x1056 sheet by the proposal paginator, and a stylesheet field would let one
   * setting push a signature block off the bottom of a page with nothing to catch it.
   * Each option below is one that has been laid out and fits.
   *
   * The defaults reproduce exactly what printed before this was configurable, so a
   * document that has never been styled is unchanged.
   */
  var FONTS = {
    aptos: "Aptos,'Segoe UI',Calibri,system-ui,sans-serif",
    plex: "'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif",
    georgia: "Georgia,'Times New Roman',Times,serif",
  };

  var STYLE_DEFAULTS = {
    /*
     * IBM Plex Sans — what the rest of the application is set in: the shell, the proposal
     * sheets the paginator builds, and the proposal document itself.
     *
     * This was Aptos. Aptos is Microsoft's newer default, so it renders on a Windows
     * machine and almost certainly NOT on the render container, which falls through to
     * 'Segoe UI', then Calibri, then whatever the platform calls sans-serif. The PDF a
     * customer received was therefore already not in Aptos, and not reliably in anything
     * in particular. Plex is loaded for the proposal, so it is the one face guaranteed to
     * be present in the render.
     */
    font: 'plex',
    sizePt: 9,
    lineHeight: 1.35,
    align: 'justify',
    titlePt: 15,
  };

  function styleOf(doc) {
    var s = (doc && doc.style) || {};
    var n = function (v, d, lo, hi) {
      var x = parseFloat(v);
      return isFinite(x) && x >= lo && x <= hi ? x : d;
    };
    return {
      family: FONTS[s.font] || FONTS[STYLE_DEFAULTS.font],
      sizePt: n(s.sizePt, STYLE_DEFAULTS.sizePt, 7, 12),
      lineHeight: n(s.lineHeight, STYLE_DEFAULTS.lineHeight, 1.1, 1.9),
      // Anything but 'left' is justified, so an unrecognised stored value falls back to
      // the setting these documents have always printed with.
      align: s.align === 'left' ? 'left' : 'justify',
      titlePt: n(s.titlePt, STYLE_DEFAULTS.titlePt, 11, 22),
    };
  }

  function bodyCss(st) {
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

  /*
   * Who signs, in the document's own words.
   *
   * These were the literals 'Releasor' and 'Releasee', which are the right words for a
   * release and the wrong words for everything else — an acknowledgment has a Customer
   * and a supplier, not a releasor. The labels are now the document's to set.
   *
   * The shipped default is deliberately neutral rather than 'Releasor': a party label
   * should describe the party, and 'Customer' is true of both a release and an
   * acknowledgment.
   *
   * `title: true` adds the Title line the signing convention expects for an entity —
   * a person signs FOR an organisation, and their authority to do so is their title.
   */
  var SIGNATURE_DEFAULTS = {
    leftRole: 'Customer',
    rightRole: 'Summit Sensory Gym',
    title: false,
  };

  function signatureOf(doc) {
    var s = (doc && doc.signature) || {};
    return {
      leftRole: s.leftRole || SIGNATURE_DEFAULTS.leftRole,
      rightRole: s.rightRole || SIGNATURE_DEFAULTS.rightRole,
      title: s.title === true,
    };
  }

  /*
   * The three block shapes a clause is built from.
   *
   * Module level, and shared, because the two documents are no longer different kinds of
   * thing. They were: an "article" had sub-paragraphs and a "numbered clause" was a title
   * and a run of prose, and the code said so by defining these inside the article renderer
   * where nothing else could reach them. Terms and conditions now take sub-sections and
   * trailing text on the same terms, so a second copy of each helper would be two sets of
   * indents and margins to drift apart.
   *
   * `align` is passed rather than closed over, which is the only reason these could move
   * out at all.
   */
  function pTag(html, first, align) {
    return (
      '<p style="margin:' +
      (first ? '0' : '5px') +
      ' 0 0;text-align:' +
      align +
      ';text-wrap:pretty;">' +
      html +
      '</p>'
    );
  }

  /** A numbered sub-paragraph: the parties, or an enumerated list of claims. */
  function subTag(numeral, html, align) {
    return (
      '<div style="display:flex;gap:8px;margin-top:4px;">' +
      '<div style="flex:none;width:24px;">' +
      numeral +
      '.</div>' +
      '<div style="flex:1;text-align:' +
      align +
      ';text-wrap:pretty;">' +
      html +
      '</div></div>'
    );
  }

  /**
   * A lettered sub-section: a heading of its own, then its own paragraphs.
   *
   * NOT wrapped in break-inside:avoid. One can legitimately run half a page, and forcing
   * it whole would push it to a fresh sheet and leave the previous one short.
   */
  function subsectionTag(letter, heading, inner) {
    return (
      '<div style="display:flex;gap:9px;margin-top:11px;">' +
      '<div style="flex:none;width:20px;font-weight:700;">' +
      letter +
      '.</div>' +
      '<div style="flex:1;">' +
      '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px;">' +
      heading +
      '</div>' +
      inner +
      '</div></div>'
    );
  }

  /**
   * Everything under a clause heading, in one fixed order.
   *
   * paragraphs, then the numbered list, then lettered sub-sections, then trailing prose.
   * Shared by both documents so a clause cannot be laid out one way in the acknowledgment
   * and another in the terms.
   *
   * That last pass is the one that was impossible: a qualification such as "Nothing herein
   * releases Summit from..." has to follow the list it qualifies, and with nowhere to put
   * it, it had to be appended to the final list item where it read as part of that item.
   */
  function clauseBody(block, st, tokens, esc, fillFn) {
    var out = (block.paragraphs || [])
      .map(function (text, i) {
        return pTag(fillFn(text, tokens, esc), i === 0, st.align);
      })
      .join('');
    out += (block.subs || [])
      .map(function (s) {
        return subTag(esc(s.numeral), fillFn(s.text, tokens, esc), st.align);
      })
      .join('');
    out += (block.subsections || [])
      .map(function (ss) {
        var inner = (ss.paragraphs || [])
          .map(function (text, i) {
            return pTag(fillFn(text, tokens, esc), i === 0, st.align);
          })
          .join('');
        return subsectionTag(esc(ss.letter), esc(ss.title), inner);
      })
      .join('');
    out += (block.trailing || [])
      .map(function (text) {
        return pTag(fillFn(text, tokens, esc), false, st.align);
      })
      .join('');
    return out;
  }

  /**
   * Unnumbered prose between the document title and the first clause.
   *
   * There was nowhere to put this. Everything under a title belonged to a numbered clause,
   * so an opening line like "This Agreement is entered into between the parties named
   * below" had to become clause 1 — which numbers a sentence that is not a term of the
   * agreement, and pushes every real clause down by one.
   *
   * Full measure, no hanging indent: it is not a list item, so it should not be set like
   * one. The clause list's own top margin follows it, so no bottom spacing is added here.
   */
  function preambleHtml(doc, st, tokens, esc, fillFn) {
    var list = (doc && doc.preamble) || [];
    if (!list.length) return '';
    return (
      '<div style="margin-top:12px;">' +
      list
        .map(function (text, i) {
          return pTag(fillFn(text, tokens, esc), i === 0, st.align);
        })
        .join('') +
      '</div>'
    );
  }

  /** The centred document heading and its rule. Editable text, fixed typesetting. */
  function heading(title, esc, titlePt) {
    return (
      '<div style="text-align:center;margin-top:18px;">' +
      '<div style="font-size:' +
      (titlePt || 15) +
      'pt;font-weight:700;text-transform:uppercase;letter-spacing:.1em;">' +
      esc(title) +
      '</div>' +
      '<div style="width:88px;height:1px;background:#20241f;margin:7px auto 0;"></div>' +
      '</div>'
    );
  }

  function releaseHtml(d, opts) {
    var esc = opts.esc;
    var m = d.meta || {};
    var u = opts.user || {};
    var company = d.orgName || m.contactName || '';
    var doc = contentFor('RELEASE');
    var tokens = {
      customer: company,
      billingAddress: flatAddress(m, company),
      summitAddress: SUMMIT_ADDRESS,
      contactName: m.contactName || '',
    };

    var st = styleOf(doc);
    var sig = signatureOf(doc);
    var BODY = bodyCss(st);
    // `blank` used to live here, rendering the grey [customer] gap when the proposal had
    // no organisation on it. That is now `fill`'s job, because a gap can appear for any
    // merge field rather than only the two the old hard-coded sentence knew about.

    /**
     * A numbered article: the numeral hangs in the margin beside its text.
     *
     * `keepWhole` is the caller's judgement, not a fixed rule. A short article is held
     * together, because an article split across a page boundary reads as two fragments.
     * One carrying sub-sections routinely runs longer than a page, and holding THAT
     * together is impossible — the browser honours it by pushing the whole block to a
     * fresh sheet, leaving the previous page two thirds empty and the article still
     * overflowing.
     */
    var article = function (numeral, heading, inner, keepWhole) {
      return (
        '<div style="display:flex;gap:10px;margin-top:10px;' +
        (keepWhole === false ? '' : 'break-inside:avoid;page-break-inside:avoid;') +
        '">' +
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
    // Thin wrappers over the shared helpers, so this renderer reads as it did while the
    // indents and margins live in exactly one place.
    var p = function (html, first) {
      return pTag(html, first, st.align);
    };
    var sub = function (numeral, html) {
      return subTag(numeral, html, st.align);
    };
    var subsection = function (letter, headingText, inner) {
      return subsectionTag(letter, headingText, inner);
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
    var sigBlock = function (role, name, entity, wantTitle) {
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
        // A person signs FOR an organisation, and their authority to do so is their
        // title. Off by default because the wording that has always printed omitted it.
        (wantTitle ? line('Title:', '') : '') +
        line('Date:', '') +
        '</div>'
      );
    };

    /*
     * An article renders in four passes, in this order:
     *
     *   paragraphs   the opening prose
     *   subs         a numbered list (i, ii, iii) — the parties, released claims
     *   subsections  lettered blocks with headings of their own (A, B, C)
     *   trailing     prose AFTER the list, which is the part that used to be impossible
     *
     * That last one is not a nicety. "This Acknowledgment is incorporated into the
     * agreement..." follows the list naming the parties, and "Nothing herein releases
     * Summit from..." follows the list of released claims — a qualification that has to
     * come after the thing it qualifies. Without it those sentences had to be jammed into
     * the final list item, where they read as part of item xii rather than as applying to
     * all twelve.
     *
     * Every one of the four is optional and absent means absent, so a document written
     * before the last two existed renders exactly as it did.
     */
    var articles = (doc.articles || [])
      .map(function (a) {
        var inner = clauseBody(a, st, tokens, esc, fill);
        // A sub-section carries its own heading and paragraphs, so an article holding any
        // is long by construction and must be allowed to break across pages.
        return article(esc(a.numeral), esc(a.title), inner, !(a.subsections || []).length);
      })
      .join('');

    return (
      '<div data-page-break="release" style="break-before:page;page-break-before:always;' +
      BODY +
      '">' +
      releaseHeader(d, esc) +
      heading(doc.title, esc, st.titlePt) +
      preambleHtml(doc, st, tokens, esc, fill) +
      articles +
      (doc.closing
        ? '<div style="margin-top:16px;padding-top:9px;border-top:1px solid #20241f;text-align:' +
          st.align +
          ';break-inside:avoid;">' +
          fill(doc.closing, tokens, esc) +
          '</div>'
        : '') +
      '<div style="display:flex;gap:44px;margin-top:12px;break-inside:avoid;page-break-inside:avoid;">' +
      sigBlock(esc(sig.leftRole), m.contactName || '', company, sig.title) +
      sigBlock(esc(sig.rightRole), u.name || '', 'Summit Sensory Gym', sig.title) +
      '</div>' +
      '</div>'
    );
  }

  /**
   * The terms, set as the release is: Aptos 9pt, no letterhead.
   *
   * Unlike the release these run past one sheet, so the running identification repeats —
   * a page of terms that has come loose from the rest should still say what it is and
   * whose transaction it belongs to.
   */
  function termsHtml(d, opts) {
    var esc = opts.esc;
    var m = (d && d.meta) || {};
    var who = d.orgName || m.contactName || '';
    var doc = contentFor('TERMS');
    var st = styleOf(doc);
    var BODY = bodyCss(st);
    var tokens = {
      customer: who,
      billingAddress: flatAddress(m, who),
      summitAddress: SUMMIT_ADDRESS,
      contactName: m.contactName || '',
    };

    return (
      '<div data-page-break="terms" style="break-before:page;page-break-before:always;' +
      BODY +
      '">' +
      '<div style="text-align:right;font-size:9pt;line-height:1.5;font-weight:700;">' +
      esc(who) +
      '</div>' +
      heading(doc.title, esc, st.titlePt) +
      preambleHtml(doc, st, tokens, esc, fill) +
      (doc.sections || [])
        .map(function (sec, i) {
          /*
           * A clause's prose, from either shape.
           *
           * A numbered clause has always stored one `body` string split on blank lines.
           * Now that these documents take sub-sections and trailing text the editor writes
           * `paragraphs` — but only for a clause somebody has actually touched, and the two
           * produce identical output, so an untouched terms document renders as it did.
           */
          var paragraphs = (sec.paragraphs || []).length
            ? sec.paragraphs
            : String(sec.body == null ? '' : sec.body).split(/\n\s*\n/);
          var block = {
            paragraphs: paragraphs,
            subs: sec.subs || [],
            subsections: sec.subsections || [],
            trailing: sec.trailing || [],
          };
          var bulk = paragraphs.join('\n\n').length;
          var hasParts = !!(block.subs.length || block.subsections.length || block.trailing.length);
          return (
            // Short clauses stay whole. The longest are allowed to break, because forcing
            // them onto a fresh sheet would leave a third of a page empty ahead of them —
            // and a clause carrying sub-sections is long by construction.
            '<div style="display:flex;gap:10px;margin-top:' +
            (i ? 10 : 14) +
            'px;' +
            (bulk < 700 && !hasParts ? 'break-inside:avoid;page-break-inside:avoid;' : '') +
            '">' +
            '<div style="flex:none;width:22px;font-weight:700;">' +
            // Positional, not stored: the number IS the position, so reordering clauses
            // renumbers them instead of leaving "7." sitting third in the list.
            (i + 1) +
            '.</div>' +
            '<div style="flex:1;">' +
            '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' +
            esc(sec.title) +
            '</div>' +
            clauseBody(block, st, tokens, esc, fill) +
            '</div></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  window.SSGContractPages = {
    /** Borrow authed from the shell, as the other modules do, and start the fetch. */
    init: function (helpers) {
      H = helpers;
      load();
    },
    load: load,
    /** The shipped wording, for the admin screen's "restore" preview. */
    defaults: function () {
      return JSON.parse(JSON.stringify(DEFAULTS));
    },
    /**
     * Render a specific wording rather than the current one.
     *
     * Used by the admin editor to preview a draft, and by a released proposal to print
     * the text it was pinned to.
     */
    withContent: function (content, doc, opts) {
      var keep = LOADED;
      LOADED = content || null;
      try {
        return this.html(doc, opts);
      } finally {
        LOADED = keep;
      }
    },
    /**
     * Both documents print on every template except the cover-only one, which exists to
     * be a cover and nothing more. A proposal with no introduction at all still gets
     * them — the contract does not depend on the marketing pages in front of it.
     */
    applies: function (doc) {
      var chosen = doc && doc.meta && doc.meta.introTemplate;
      return chosen !== 'COVER';
    },
    /**
     * Both documents unless the proposal turned one off.
     *
     * Absent means included: a proposal saved before that flag existed carries no value,
     * and the contract it went out under had both. Only an explicit `false` drops one.
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

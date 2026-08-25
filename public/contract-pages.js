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

  var SERIF = "'Newsreader',Georgia,serif";
  var SUMMIT_ADDRESS = '6150 S Geneva Court, Englewood, CO 80111';

  /** Escaped, with paragraph breaks preserved. */
  function paras(text, esc) {
    return String(text)
      .split(/\n\s*\n/)
      .map(function (p) {
        return (
          '<p style="margin:0 0 8px;font-size:10.5px;line-height:1.62;color:#20241f;text-wrap:pretty;">' +
          esc(p.trim()).replace(/\n/g, '<br>') +
          '</p>'
        );
      })
      .join('');
  }

  /** The masthead that reidentifies a sheet once it is separated from page one. */
  function masthead(d, esc) {
    return (
      '<div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:2px solid #203060;">' +
      '<div style="display:flex;gap:11px;align-items:center;">' +
      '<img src="logo.png" alt="Summit Sensory Gym" width="34" height="34" style="width:34px;height:34px;display:block;flex:none;">' +
      '<div style="font-family:' +
      SERIF +
      ';font-size:15px;font-weight:700;color:#20241f;">Summit Sensory Gym</div>' +
      '</div>' +
      '<div style="font-size:10.5px;color:#7b8190;">' +
      [
        esc(d.number || ''),
        (Number(d.version) || 1) > 1 ? 'Revision ' + (Number(d.version) - 1) : '',
        esc(d.orgName || ''),
      ]
        .filter(Boolean)
        .join(' \u00b7 ') +
      '</div></div>'
    );
  }

  /**
   * The general release.
   *
   * The Releasor is the customer: their company name and the billing address already on
   * the proposal, so nobody retypes an address that is two inches further up the same
   * document. The Releasee is Summit.
   *
   * The two signature blocks name different people on purpose. The Releasor line is the
   * contact the proposal is addressed to — the person who will sign it. The Releasee
   * line is whoever generated the proposal, not a fixed name: a release that always
   * said "Bryan Shepherd" would be wrong the first time anyone else sent one.
   */
  function releaseHtml(d, opts) {
    var esc = opts.esc;
    var m = d.meta || {};
    var u = opts.user || {};
    var company = d.orgName || m.contactName || '';
    // The billing address as entered, flattened to one line: the release reads as a
    // sentence, not as an address block.
    //
    // Reps routinely start that block with the company name, and the sentence already
    // names the company — "Wonderfully Made Therapy Group with a mailing address of
    // Wonderfully Made Therapy Group, 1420 Larimer Street" is what came out. A leading
    // line matching the company is dropped, compared loosely so "Wonderfully Made
    // Therapy Group, LLC." and "wonderfully made therapy group" both count.
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
      // One contains the other: catches a trailing ", LLC" on either side.
      if (head && org && (head === org || head.indexOf(org) === 0 || org.indexOf(head) === 0)) {
        addressLines.shift();
      }
    }
    // An attention line belongs on an envelope, not mid-sentence in a release.
    addressLines = addressLines.filter(function (l) {
      return !/^(attn|attention|c\/o)\b[:.]?/i.test(l);
    });
    var address = addressLines.join(', ');

    var num = function (n) {
      return (
        '<span style="font-size:10.5px;font-weight:700;color:#203060;flex:none;width:26px;">' +
        n +
        '</span>'
      );
    };
    var item = function (n, html) {
      return (
        '<div style="display:flex;gap:4px;margin-top:9px;">' +
        num(n) +
        '<div style="flex:1;">' +
        html +
        '</div></div>'
      );
    };
    var lead = function (label, rest) {
      return (
        '<p style="margin:0 0 8px;font-size:10.5px;line-height:1.62;color:#20241f;text-wrap:pretty;"><b style="font-weight:700;">' +
        label +
        '</b> ' +
        rest +
        '</p>'
      );
    };
    var sigBlock = function (role, name, sub) {
      return (
        '<div style="flex:1;">' +
        '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;color:#20241f;font-weight:700;border-bottom:1px solid #20241f;padding-bottom:3px;">' +
        role +
        '</div>' +
        '<div style="border-bottom:1px solid #20241f;height:46px;"></div>' +
        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#7b8190;font-weight:700;margin-top:4px;">Signature</div>' +
        '<div style="border-bottom:1px solid #20241f;height:26px;margin-top:14px;"></div>' +
        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#7b8190;font-weight:700;margin-top:4px;">Date</div>' +
        '<div style="font-size:11px;color:#20241f;line-height:1.45;margin-top:12px;">' +
        (name
          ? '<div style="font-weight:600;">' + esc(name) + '</div>'
          : '<div style="height:15px;"></div>') +
        (sub ? '<div>' + esc(sub) + '</div>' : '') +
        '</div></div>'
      );
    };

    return (
      '<div data-page-break="release" style="break-before:page;page-break-before:always;">' +
      masthead(d, esc) +
      '<div style="text-align:center;font-family:' +
      SERIF +
      ';font-size:16px;font-weight:700;color:#203060;letter-spacing:-.01em;margin-top:26px;text-transform:uppercase;">General Release of Liability</div>' +
      '<div style="margin-top:18px;border:1px solid #dfe3ec;border-radius:6px;padding:16px 18px;">' +
      item(
        'I.',
        lead(
          'THE PARTIES.',
          'This General Release of Liability (\u201cRelease\u201d) is made and entered into as of the date indicated below between:',
        ) +
          '<div style="display:flex;gap:4px;margin-top:6px;"><span style="font-size:10.5px;font-weight:700;color:#203060;flex:none;width:24px;">I.</span>' +
          '<div style="flex:1;"><p style="margin:0 0 6px;font-size:10.5px;line-height:1.62;"><b style="font-weight:700;">RELEASOR:</b> ' +
          (company ? esc(company) : '<span style="color:#9aa1b0;">[customer]</span>') +
          ' with a mailing address of ' +
          (address ? esc(address) : '<span style="color:#9aa1b0;">[billing address]</span>') +
          ' (\u201cReleasor\u201d), and;</p></div></div>' +
          '<div style="display:flex;gap:4px;"><span style="font-size:10.5px;font-weight:700;color:#203060;flex:none;width:24px;">II.</span>' +
          '<div style="flex:1;"><p style="margin:0;font-size:10.5px;line-height:1.62;"><b style="font-weight:700;">RELEASEE:</b> Summit Sensory Gym with a mailing address of ' +
          SUMMIT_ADDRESS +
          '. (\u201cReleasee\u201d).</p></div></div>',
      ) +
      item(
        'II.',
        lead(
          'LIABILITY EVENT.',
          'Under the terms of this Release and sufficiency of which is hereby acknowledged, the Releasor hereby releases and forever discharges the Releasee of all Summit Sensory Gym structure designs and equipment (\u201cLiability\u201d).',
        ) +
          '<p style="margin:8px 0;font-size:10.5px;line-height:1.62;text-wrap:pretty;">THEREFORE under the terms of this Agreement and sufficiency of which is hereby acknowledged, do hereby release and forever discharge the Releasee including their agents, employees, successors and assigns, and their respective heirs, personal representatives, affiliates, successors and assigns, and any and all persons, firms or corporations liable or who might be claimed to be liable, whether or not herein named, none of whom admit any liability to the undersigned, but all expressly denying liability, from any and all claims, demands, damages, actions, causes of action or suits of any kind or nature whatsoever, which now have or may hereafter have, arising out of or in any way relating to any and all injuries and damages of any and every kind, to both person and property, and also any and all injuries and damages that may develop in the future, as a result of or in any way relating to the Liability.</p>' +
          '<p style="margin:8px 0;font-size:10.5px;line-height:1.62;">As part of this Release, the Parties agree that no payment will be made by the Releasee to the Releasor.</p>' +
          '<p style="margin:8px 0 0;font-size:10.5px;line-height:1.62;text-wrap:pretty;">It is understood and agreed that this Release is made and received in full and complete settlement and satisfaction the causes of action, claims and demands mentioned herein; that this Release contains the entire agreement between the Releasor and Releasee; and that the terms of this Release are contractual and not merely a recital.</p>',
      ) +
      item(
        'III.',
        lead(
          'BINDING EFFECT.',
          'This Release shall be binding upon the undersigned, and his respective heirs, executors, administrators, personal representatives, successors, and assigns.',
        ),
      ) +
      '</div>' +
      '<div style="display:flex;gap:40px;margin-top:26px;break-inside:avoid;">' +
      sigBlock('Releasor', m.contactName || '', company) +
      sigBlock('Releasee', u.name || '', 'Summit Sensory Gym') +
      '</div>' +
      '</div>'
    );
  }

  /** The standard terms, verbatim. */
  var TERMS = [
    {
      t: 'Offer to Sell',
      b: 'Summit Sensory Gym (collectively referred to herein as “Summit” or the “Company”) and operating, hereby offers to sell the products described in this Standard Terms and Conditions of Sale (the “Products”), but only on the specific terms and conditions described herein. If Buyer submits to Company a purchase order or other documentation with terms and conditions other than the terms and conditions described in this Standard Terms and Conditions of Sale, Company hereby objects to those terms and does not assent to them. No such term shall be a part of any contract between the parties. The terms of the Company’s Standard Terms and Conditions of Sale, except for these Conditions of Sale, are not binding, and do not constitute an offer. Moreover, these Terms and Conditions of Sale are subject to change without notice at any time and from time to time.',
    },
    {
      t: 'Payment Terms',
      b: 'Terms of sale, including terms of payment and charges, for each purchase are agreed to be those specified on the face of each invoice. Invoices will be sent at the time of shipment. Payment terms for customers with approved credit are determined by the Company. Any payments not received within the terms of the invoice shall be subject to a late payment charge of 1% per month on the unpaid balance of any overdue amount. Should credit availability be granted by the Company, all decisions with respect to the extension or continuation shall be in the sole discretion of the Company. The Company may terminate any credit availability within its sole discretion at any time.',
    },
    {
      t: 'Taxes',
      b: 'The quoted purchase price may be increased to the extent that Company’s cost of the Products may be increased as a result of (1) any agreements, codes, or legislative enactments made or enacted pursuant to federal, state or municipal legislation; and (2) increase in the cost of labor or raw materials. In addition to paying the quoted purchase price, Buyer is solely liable for any excises, levies or taxes which Company may be required to pay or collect, under any existing or future law, upon or with respect to the sale, purchase, delivery, storage, processing, use, consumption or transportation of any of the Products, and Buyer agrees to pay the amount thereof on the same terms as it shall pay the quoted purchase price. All sales of Products or Services may be subject to sales or use tax unless a valid Exempt Purchase Certificate or Resale Certificate is provided prior to the invoice date.',
    },
    {
      t: 'Return Material Authorization',
      b: 'No Products shall be returned for credit without first obtaining written consent from an officer of the Company. Custom orders are non-returnable and nonrefundable.',
    },
    {
      t: 'Claims and Shortages',
      b: 'Claims by Buyer for shortages or errors in delivery must be made within thirty (30) days after the delivery of the Products.',
    },
    {
      t: 'Cancellation',
      b: 'Orders accepted by the Company are subject to cancellation by the Buyer only upon the express written consent of the Company. Upon such cancellation and consent, Company shall cease work and hold for Buyer all completed and partially completed articles and work in progress as well as remaining inventory and Buyer shall pay Company for all work and materials that have been committed to and/or identified with respect to Buyer’s order plus a cancellation charge as prescribed by Company either in the purchase order or as subsequently determined by the Company upon receipt of the Buyer’s cancellation.',
    },
    {
      t: 'Warranty',
      b: 'Company Limited warrants its products to be free from defects in materials or workmanship for a period of (1) one year from the date of shipment during normal use and installation. This warranty does not cover failures resulting from impact greater than the designated working load of the Product, misuse, or alterations of Products, substandard interface components or failure to follow proper procedures to assure maximum product strength. Installation of the Product for use other than that as outlined in provided instructions or Product literature will void this warranty, as will Product alterations, modifications, or substitution of components without the Company’s prior written authorization. This Warranty covers either replacement or repair, at Company’s discretion. Transportation and installation or other on-site costs, are not covered by this warranty, except where specific arrangements are made with prior written approval from Company.\n\nTHERE ARE NO OTHER EXPRESS OR IMPLIED WARRANTIES, INCLUDING THE WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE, AND THE WARRANTY INCLUDED ABOVE IN THIS SECTION 6 IS SPECIFICALLY LIMITED TO TWELVE MONTHS FROM THE DATE OF PURCHASE AND TO THE EXTENT PERMITTED BY LAW, ANY AND ALL IMPLIED WARRANTIES ARE SPECIFICALLY EXCLUDED. THE WARRANTY IN THIS SECTION 7 IS THE EXCLUSIVE REMEDY AND LIABILITY FOR CONSEQUENTIAL AND INCIDENTAL DAMAGES UNDER ANY AND ALL WARRANTIES ARE EXCLUDED TO THE EXTENT EXCLUSION IS PERMITTED BY LAW.',
    },
    {
      t: 'Shipment',
      b: 'Delivery terms are F.O.B. Shipping Point. The buyer shall assume all risk of loss or damage upon pickup by the carrier at the point of shipment. Scheduled dates of delivery are determined from the date of Company’s acceptance of any order or orders placed by Buyer, and are estimates of approximate dates of delivery, not a guaranty of a particular date of delivery. The company is not responsible for any delivery delay due to security clearance issues or any other form of driver delay that is outside of the Company’s control. Company shall not be liable for any damages caused by failure or delay in shipping the Products, if such failure or delay is due to any war, embargo, riot, fire, flood, accident, mill condition, strike or other labor difficulty, an act of Buyer, an act of God, an act of a governmental authority, transportation shortage or failure, inability to obtain sufficient fuel, labor, materials or manufacturing facilities, or any other cause beyond the reasonable control of Company. For shipments being billed to ship Prepaid to the Buyer, all reasonable efforts must and shall be made by the Buyer to declare, disclose, or understand any and all accessorial charges, special circumstances and requirements or lack thereof for successful delivery ahead of time of shipment. The company is not liable for additional shipping charges incurred from accessorial charges billed to the Company after delivery, unless otherwise known ahead of time and approved and paid for by the Company. Any such additional undeclared accessorial charges shall be billed back to the Buyer accordingly. Accessorial include, but are not limited to- Lift Gate Delivery, Inside Delivery, Arrival Notifications, Residential Delivery, and Limited Access Sites. Limited Access Sites are defined as: Commercial establishments not open to general public during normal business hours, Construction Sites, Fairs/Carnivals, Military Bases, Prisons, Schools, Churches, Piers/Wharfs, Convention/Expo Centers, Airports, Sites with extensive security processes, Hospitals, Casinos, Power/Nuclear and Water Treatment Plants, Resorts, Golf Course/ Country Clubs, Funeral Homes, Utility Sites, Ports, Amusement Parks/Zoos, Marinas & State/National Parks.',
    },
    {
      t: 'Security Interest',
      b: 'Shipments, deliveries, and performance of work by Company shall at all times be subject to the approval of and requirements of the credit department of Company, including the requirement that Buyer pay part or all of the purchase price in advance. Company shall at times retain a purchase money security interest in all Products not paid for in full, notwithstanding that the Products have been delivered to Buyer, and Buyer hereby authorizes Seller to execute and file financing statements describing the Products, and other document which may be requested by Company to evidence its continuing purchase money security interest.',
    },
    {
      t: 'Indemnification',
      b: 'In addition to the foregoing, Buyer agrees to save and hold Company harmless from any claims, demands, liabilities, costs, expenses, or judgments arising in whole or in part, directly or indirectly, out of the negligence or lack of care by Buyer or Buyer’s customers, agents, employees, or invitees involving the use of the Products supplied by Company. This indemnification shall include all costs, attorney’s’ fees and other expenses paid or incurred by or imposed upon Company in connection with the defense of any such claim.',
    },
    {
      t: 'Governing Law',
      b: 'Any agreement arising out of this transaction shall be deemed to have been made in the State of Colorado. The parties agree that the validity, interpretation, and performance of any agreement arising out of this transaction shall be governed by the laws of the State of Colorado without regard to any rules or principles conflicts of interest laws. Buyer and Company hereby submit to the exclusive jurisdiction for the resolution of any disputes hereunder, to the federal and state courts in Colorado and specifically those federal and state courts located in Arapahoe County, Colorado. This shall be the sole and exclusive jurisdiction and venue for the purpose of adjudication of any rights and liabilities hereunder.',
    },
    {
      t: 'Default',
      b: 'In the case of default or breach by Buyer in the performance of any or all of the provisions of this agreement, Company may cancel any outstanding purchase order from Buyer and declare all obligations immediately due and payable and shall in addition have all remedies afforded by any applicable law. Buyer shall in addition, be liable for Company’s expenses incurred in exercising any remedies available to it, including reasonable attorney’s’ fees, costs of collection and other expenses.',
    },
    {
      t: 'Company Compliance to CA Proposition 65',
      b: 'Company products, materials and processes are compliant with California Proposition 65, Health Hazzard Assessment Code. The company considers the safety of its products to be foremost in respect to function and safe handling.',
    },
  ];

  function termsHtml(d, opts) {
    var esc = opts.esc;
    return (
      '<div data-page-break="terms" style="break-before:page;page-break-before:always;">' +
      masthead(d, esc) +
      '<div style="text-align:center;font-family:' +
      SERIF +
      ';font-size:16px;font-weight:700;color:#203060;letter-spacing:-.01em;margin-top:26px;text-transform:uppercase;">Standard Terms &amp; Conditions of Sale</div>' +
      '<div style="margin-top:18px;">' +
      TERMS.map(function (s, i) {
        return (
          // Each clause avoids breaking across a sheet where it can. The longest two —
          // Warranty and Shipment — are allowed to break, because forcing them whole
          // would leave a third of a page empty ahead of them.
          '<div style="margin-top:' +
          (i ? 13 : 0) +
          'px;' +
          (s.b.length < 900 ? 'break-inside:avoid;page-break-inside:avoid;' : '') +
          '">' +
          '<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px;">' +
          '<span style="font-size:10px;font-weight:700;color:#d02030;flex:none;">' +
          (i + 1) +
          '.</span>' +
          '<span style="font-family:' +
          SERIF +
          ';font-size:12px;font-weight:700;color:#203060;">' +
          esc(s.t) +
          '</span>' +
          '</div>' +
          '<div style="padding-left:18px;">' +
          paras(s.b, esc) +
          '</div>' +
          '</div>'
        );
      }).join('') +
      '</div></div>'
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

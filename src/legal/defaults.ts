/**
 * The legal text as it ships, and the shape every stored version must take.
 *
 * These two documents used to live only in `public/contract-pages.js` as string
 * literals, which meant a comma in the terms needed a developer and a deploy. They are
 * now editable in Administration, and this file is what a fresh database starts from —
 * the defaults, not the truth. Once a document has been published from the admin screen
 * the stored copy wins and this file is only a fallback.
 *
 * IT IS ALSO THE FALLBACK THAT MATTERS. If the database has no row for a document — a
 * fresh environment, a failed seed — the renderer prints this instead of printing
 * nothing. A proposal that silently goes out with no terms attached is far worse than
 * one that goes out with last month's wording.
 *
 * The text was lifted programmatically out of `contract-pages.js` rather than retyped,
 * and every release paragraph was verified against the source by its opening words. Do
 * not hand-edit the strings here to make a wording change — edit the document in
 * Administration, where the change is versioned, attributed and snapshotted.
 *
 * Merge tokens
 * ------------
 * The release names the parties, so its text carries placeholders the renderer fills:
 *
 *   {{customer}}        the organisation name, or the contact if there is no org
 *   {{billingAddress}}  the billing address, flattened to one line
 *   {{summitAddress}}   Summit's own address
 *   {{contactName}}     the proposal contact
 *
 * An unknown token renders as a blank underline rather than the literal braces, so a
 * typo in an edited document looks like a gap to fill in — which is what it is — instead
 * of leaking `{{custmer}}` onto a signed instrument.
 *
 * `**bold**` is the only markup. The release needs RELEASOR and RELEASEE emphasised and
 * nothing else, and a richer editor would let pasted formatting break the 9pt Aptos the
 * whole document is set in.
 */

/** A lettered sub-paragraph, as under Article I of the release. */
export interface LegalSub {
  numeral: string;
  text: string;
}

/** A numbered article, as the release is built from. */
export interface LegalArticle {
  numeral: string;
  title: string;
  paragraphs: string[];
  subs: LegalSub[];
}

/** A numbered clause, as the terms are built from. Blank lines split paragraphs. */
export interface LegalSection {
  title: string;
  body: string;
}

export interface LegalDocumentContent {
  /** The printed heading. Editable — which is why nothing keys off it. */
  title: string;
  kind: 'ARTICLES' | 'NUMBERED';
  articles?: LegalArticle[];
  /** Trailing line above the signature blocks. ARTICLES only. */
  closing?: string;
  sections?: LegalSection[];
}

/**
 * The documents this application knows how to print.
 *
 * A closed set on purpose. Both are positioned by the renderer — the release before the
 * terms, because the release names the parties the terms then rely on — and a
 * user-created third document would have no defined place in that order. Editing the two
 * is what was asked for; inventing new legal instruments in a CPQ screen is not.
 */
export const LEGAL_KEYS = ['RELEASE', 'TERMS'] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];

export const LEGAL_DEFAULTS: Record<LegalKey, LegalDocumentContent> = {
  RELEASE: {
    title: 'General Release of Liability',
    kind: 'ARTICLES',
    closing:
      'IN WITNESS WHEREOF, the Parties have executed this Release as of the dates written below.',
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
  },
  TERMS: {
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

/** Defensive copy — callers edit drafts, and a shared default must not be mutated. */
export function defaultContent(key: LegalKey): LegalDocumentContent {
  return JSON.parse(JSON.stringify(LEGAL_DEFAULTS[key])) as LegalDocumentContent;
}

/**
 * The Customer Project Media Rebate program text as it ships, and the shape a stored
 * `MediaPartnershipProgram.content` row must take.
 *
 * Same role as `src/legal/defaults.ts` for the two legal documents: this is what a
 * proposal shows before anyone in Administration has ever saved the program, and it is
 * the fallback when the settings row does not exist (a fresh environment, or a
 * database predating this feature). No stored row does NOT mean "print nothing" for a
 * proposal that offers the program — the program is `active: false` by default, so a
 * fresh environment simply cannot offer it yet, which is the required starting state.
 *
 * Editing a wording change belongs in Administration, where it is versioned and
 * attributed. This file is the shipped starting point, not the place to hand-edit
 * live copy.
 *
 * Money: `rebateAmountMinor` on `MediaPartnershipProgram` is integer minor units
 * (cents), matching `Sku.unitPriceMinor`'s existing convention — never a float.
 *
 * Future extension point (spec section 18): a downloadable "Customer Media Capture
 * Guide" is not built in this release. If it is added later, the natural home is an
 * additional nullable field here (e.g. a guide asset id/url) plus a matching column on
 * `MediaPartnershipProgram` — deliberately left out now rather than forced in.
 */

export interface MediaProgramTimeframes {
  /** Calendar days after installation completes that Customer has to submit media. */
  submissionDays: number;
  /** Business days Summit has to review a submission after receipt. */
  reviewBusinessDays: number;
  /** Calendar days Customer has to provide a requested corrected/replacement submission. */
  correctionDays: number;
  /** Calendar days after acceptance that Summit will issue the earned rebate. */
  paymentDays: number;
}

export interface MediaProgramContent {
  introduction: string;
  mediaRequirements: string;
  acceptanceStandards: string;
  usageRights: string;
  privacyRestrictions: string;
  paymentTerms: string;
  /** The customer-facing participation election checkbox label. */
  participationLanguage: string;
  /** Appended near/within the normal proposal signature acknowledgment. */
  signatureAcknowledgment: string;
  timeframes: MediaProgramTimeframes;
}

export const DEFAULT_MEDIA_PROGRAM_TIMEFRAMES: MediaProgramTimeframes = {
  submissionDays: 30,
  reviewBusinessDays: 10,
  correctionDays: 15,
  paymentDays: 30,
};

export const DEFAULT_MEDIA_PROGRAM_CONTENT: MediaProgramContent = {
  introduction:
    'Customer has the opportunity to receive a $250 Customer Project Media Rebate by participating in Summit Sensory Gym’s post-installation media program.\n\nThe Media Rebate is separate from the Project Price and does not reduce Customer’s deposit, final payment, or any other amount due under this Proposal.\n\nCustomer remains responsible for payment of the full Project Price in accordance with Summit Sensory Gym’s standard payment terms.',
  mediaRequirements:
    'Within thirty (30) calendar days following completion of installation, Customer will provide Summit Sensory Gym with photographs and video documenting the completed sensory therapy gym.\n\nUnless otherwise stated in this Proposal, Customer will provide:\n\n• A minimum of ten (10) high-resolution photographs showing the completed sensory therapy gym from multiple perspectives;\n• Overall photographs showing the completed sensory therapy environment;\n• Closer photographs showing important Summit equipment or design details;\n• A reasonable combination of horizontal and vertical photographs;\n• A minimum of four (4) short video clips showing the completed sensory therapy gym and surrounding environment; and\n• Original or highest reasonably available resolution files without filters, watermarks, graphics, music, or other material modifications.\n\nCustomer agrees to make reasonable efforts to have the room clean, uncluttered, appropriately illuminated, free of installation materials, boxes, tools, and unnecessary visual obstruction, and presentation-ready at the time the media is captured.\n\nMedia should reasonably follow Summit Sensory Gym’s Customer Media Capture Guide. Photographs and video must be reasonably clear, in focus, adequately illuminated, and provide sufficient visual coverage of the completed Summit Sensory Gym installation.',
  acceptanceStandards:
    'Summit Sensory Gym will review the submitted media within ten (10) business days following receipt. Media will be considered acceptable when it substantially satisfies the program requirements and provides reasonably usable documentation of the completed Summit Sensory Gym installation.\n\nExamples of material deficiencies may include significant blurring; substantially inadequate lighting; materially insufficient resolution; major obstruction of the sensory gym; excessive visual clutter that prevents reasonable use; incomplete required room coverage; missing required photographs; missing required videos; or inability to reasonably see the Summit equipment.\n\nSummit may request one reasonable corrected or replacement submission. Customer will have fifteen (15) calendar days following Summit’s notice to provide the requested replacement media.',
  usageRights:
    'Customer grants Summit Sensory Gym a perpetual, worldwide, royalty-free, non-exclusive license to edit, crop, resize, reproduce, publish, display, distribute, and otherwise use media submitted under this program for Summit Sensory Gym’s legitimate website, social media, proposals, sales presentations, advertising, trade-show materials, portfolio, educational materials, public-relations materials, and marketing and promotional purposes.\n\nCustomer retains any ownership rights it otherwise holds in the original media. Customer represents that it has authority to provide the submitted media and grant these rights.',
  privacyRestrictions:
    'Unless separately authorized by Summit Sensory Gym and supported by any necessary permissions, authorizations, or releases, media submitted under this program should not contain identifiable patients, students, clients, minors, protected health information, confidential information, education-record information, or other protected personal information.\n\nSummit Sensory Gym may decline media containing identifiable individuals when appropriate permissions or releases have not been established.',
  paymentTerms:
    'The Customer Project Media Rebate is earned only after Customer (1) submits the required media within the applicable submission period, and (2) Summit Sensory Gym determines that the media substantially satisfies the Media Program requirements contained in this Proposal.\n\nThe Customer Project Media Rebate does not reduce the Project Price, Customer’s outstanding balance, or any amount due to Summit Sensory Gym prior to shipment, delivery, or installation. Customer must satisfy all normal payment obligations under the Proposal regardless of participation in the Media Program.\n\nFollowing Summit Sensory Gym’s acceptance of the submitted media, Summit Sensory Gym will issue the earned rebate within thirty (30) calendar days. The rebate will be issued to the customer or business entity that paid the applicable Summit Sensory Gym project invoice. Summit Sensory Gym may issue the rebate through ACH, check, refund to the original payment method where reasonably available, or another commercially reasonable payment method selected by Summit Sensory Gym.\n\nIf Customer does not submit the required media within the applicable submission period, including any applicable correction period, the rebate will not be earned and Summit Sensory Gym will have no obligation to issue the rebate.\n\nParticipation in the program does not require Customer to provide a positive review, testimonial, recommendation, or endorsement.',
  participationLanguage:
    'Yes, we elect to participate in Summit Sensory Gym’s Customer Project Media Rebate Program and agree to the Media Program terms contained in this Proposal.',
  signatureAcknowledgment:
    'By signing this Proposal, Customer agrees to all selected options, programs, terms, and conditions contained in this Proposal, including the Customer Project Media Rebate Program where elected above.',
  timeframes: DEFAULT_MEDIA_PROGRAM_TIMEFRAMES,
};

/** Defensive copy — callers may edit drafts, and the shared default must not be mutated. */
export function defaultMediaProgramContent(): MediaProgramContent {
  return JSON.parse(JSON.stringify(DEFAULT_MEDIA_PROGRAM_CONTENT)) as MediaProgramContent;
}

/**
 * What the customer told us about taking delivery, as the Bill of Materials prints it.
 *
 * The customer portal's Delivery & Site Details form (see portalDelivery.ts) is the
 * only source of the ship-to point(s) of contact and the special instructions — the
 * CRM has nowhere else that holds them — so they are read off the order's latest
 * submission (`latestDeliveryForOrder`, which callers pass in; this module stays pure
 * so the rule below is testable without a database). The three answers the webhook also copies onto each vendor section
 * (loading dock, timing, preferred date) are read from the SECTION first: that copy is
 * what someone may have corrected by hand, and a submitted section deliberately keeps
 * the answers it was sent with. The submission is only the fallback, which is also
 * what the all-vendors sheet (no section of its own) prints.
 *
 * Everything is plain text here; phone formatting is a rendering concern, applied by
 * `bomPhone` wherever a number is printed.
 */

export interface BomPoc {
  name: string;
  phone: string;
  email: string;
  preferredComm: string;
  textNumber: string;
}

export interface BomDelivery {
  /** The loading-dock answer, e.g. "No, I need liftgate delivery". Prints as "Delivery Type". */
  deliveryType: string;
  /** YYYY-MM-DD. Blank when unanswered. (Submission Date prints MM/DD/YYYY; this row does not.) */
  preferredDeliveryDate: string;
  deliveryTiming: string;
  specialInstructions: string;
  primary: BomPoc;
  secondary: BomPoc;
}

/** The answers a vendor section carries, or null for the all-vendors sheet. */
export interface SectionDeliveryAnswers {
  loadingDock: string | null;
  deliveryTiming: string | null;
  preferredDeliveryDate: Date | null;
}

/** The fields of a PortalDeliverySubmission the sheet prints. */
export interface SubmissionDeliveryAnswers {
  pocName: string | null;
  pocPhone: string | null;
  pocEmail: string | null;
  preferredComm: string | null;
  textNumber: string | null;
  secondaryPocName: string | null;
  secondaryPocPhone: string | null;
  secondaryPocEmail: string | null;
  secondaryPreferredComm: string | null;
  secondaryMobile: string | null;
  loadingDock: string | null;
  deliveryTiming: string | null;
  preferredDeliveryDate: Date | null;
  specialInstructions: string | null;
}

const t = (v: string | null | undefined): string => (v ?? '').trim();
const day = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : '');

/**
 * Resolve the delivery block from a section's own answers and the latest submission.
 * Pure, so the precedence rule is testable without a database.
 */
export function deliveryDetails(
  section: SectionDeliveryAnswers | null,
  sub: SubmissionDeliveryAnswers | null,
): BomDelivery {
  return {
    // `||` rather than `??`: a section cleared to an empty string has no answer of its
    // own, and the customer's is better than a blank.
    deliveryType: t(section?.loadingDock) || t(sub?.loadingDock),
    preferredDeliveryDate:
      day(section?.preferredDeliveryDate) || day(sub?.preferredDeliveryDate ?? null),
    deliveryTiming: t(section?.deliveryTiming) || t(sub?.deliveryTiming),
    specialInstructions: t(sub?.specialInstructions),
    primary: {
      name: t(sub?.pocName),
      phone: t(sub?.pocPhone),
      email: t(sub?.pocEmail),
      preferredComm: t(sub?.preferredComm),
      textNumber: t(sub?.textNumber),
    },
    secondary: {
      name: t(sub?.secondaryPocName),
      phone: t(sub?.secondaryPocPhone),
      email: t(sub?.secondaryPocEmail),
      preferredComm: t(sub?.secondaryPreferredComm),
      // The portal's secondary "text #" is its Mobile column — the primary has a
      // dedicated text-number question, the secondary only a mobile.
      textNumber: t(sub?.secondaryMobile),
    },
  };
}

/**
 * Excel number format for a 10-digit phone: "(303) 748-8082", and a 7-digit local
 * number as "748-8082". Matches the template Bryan built the sheet from.
 */
export const PHONE_NUMFMT = '[<=9999999]###-####;(###) ###-####';

/**
 * One phone number, as every BOM format prints it.
 *
 * Strip to digits; an 11-digit number with the US country code drops the leading 1;
 * exactly ten digits is a North American number, printed "(303) 748-8082" and written
 * to Excel as a real number under PHONE_NUMFMT. Anything else — international, an
 * extension, a word ("cell", "ext") — is not safe to reformat and prints exactly as the
 * customer typed it: a number reshaped into the wrong digits is worse than an ugly one.
 */
export function bomPhone(raw: string | null | undefined): { text: string; numeric: number | null } {
  const text = (raw ?? '').trim();
  if (!text) return { text: '', numeric: null };
  // Letters, an "x" extension, a comma-separated second number: leave it alone.
  if (/[^\d\s().+\-]/.test(text)) return { text, numeric: null };
  let digits = text.replace(/\D/g, '');
  // A "+" with any country code but 1 is international however many digits follow.
  if (text.startsWith('+') && !digits.startsWith('1')) return { text, numeric: null };
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return { text, numeric: null };
  return {
    text: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
    numeric: Number(digits),
  };
}

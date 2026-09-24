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
  /**
   * Prints as "Delivery Type": "Loading Dock" or "Lift Gate", from monday's
   * formula_mm7fhgy9 — blank when the customer has not answered. See bomDeliveryType.
   */
  deliveryType: string;
  /** YYYY-MM-DD as stored; every format prints it MM/DD/YYYY (usDate). Blank when unanswered. */
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
  /** Every monday column on the submissions row, id → text, as stored at ingest. */
  raw?: unknown;
}

const t = (v: string | null | undefined): string => (v ?? '').trim();

/**
 * "Loading Dock/Lift Gate" — a monday FORMULA column on the Delivery & Site Details
 * Submissions board that reduces the customer's loading-dock answer (text_mm5712dx)
 * to the two words a carrier books against:
 *
 *   if({text_mm5712dx} = "Yes, No need for lift gate delivery", "Loading Dock", "Lift Gate")
 *
 * It is what the sheet's Delivery Type row prints (see bomDeliveryType).
 */
export const LOADING_DOCK_TYPE_COL = 'formula_mm7fhgy9';

/** One column's stored text off a submission's `raw`, or ''. */
function rawText(raw: unknown, col: string): string {
  if (!raw || typeof raw !== 'object') return '';
  const v = (raw as Record<string, unknown>)[col];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The Delivery Type row: monday's Loading Dock/Lift Gate formula value.
 *
 * - The customer has not answered the loading-dock question → BLANK. The formula
 *   says "Lift Gate" for anything but the one "Yes" answer, blank included, and a
 *   vendor must never book a liftgate nobody asked for.
 * - Staff corrected the answer on this vendor's section (it differs from what the
 *   customer submitted) → the corrected text. The formula only ever saw the
 *   customer's original answer, so printing it would undo the correction.
 * - The formula has not been read for this submission yet (stored before the column
 *   existed, refreshed on the next portal sync) → the answer's own text, as before.
 */
export function bomDeliveryType(
  answerInEffect: string,
  customerAnswer: string,
  formula: string,
): string {
  if (!answerInEffect) return '';
  if (answerInEffect !== customerAnswer) return answerInEffect;
  if (!formula) return answerInEffect;
  // Trusted only when it agrees with the answer. The formula is an exact, case-
  // sensitive match on one sentence, so a reworded or re-spaced "Yes" in the portal
  // would come back "Lift Gate" and a vendor would book a liftgate for a customer
  // with a dock. When the two disagree, the customer's own words print instead.
  const said = answerInEffect.toLowerCase();
  const agrees =
    (formula === 'Loading Dock' && said.startsWith('yes')) ||
    (formula === 'Lift Gate' && said.startsWith('no'));
  return agrees ? formula : answerInEffect;
}

/**
 * Summit's own time zone (Englewood, CO). "Today" on a sheet is Summit's today: in UTC
 * an export made after about 6 pm Mountain was dated the next day.
 */
export const BOM_TIME_ZONE = 'America/Denver';

/** Today's date in Summit's time zone, as YYYY-MM-DD. */
export function bomToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BOM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * A calendar day (YYYY-MM-DD) as the instant to STORE for it: 18:00 UTC, which is
 * midday in Denver (11:00 MST / 12:00 MDT) and still the same day in UTC. Every
 * reader takes `toISOString().slice(0, 10)`, so a day stored this way reads back as
 * itself — the same convention as the section editor, which saves local noon.
 */
export function bomDateStamp(day: string): Date {
  return new Date(`${day}T18:00:00.000Z`);
}

/** "2026-09-22" → "09/22/2026", how every date on a BOM prints. Anything else as-is. */
export function usDate(iso: string | null | undefined): string {
  const v = t(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : v;
}

/**
 * Every YYYY-MM-DD inside free text as MM/DD/YYYY — the portal writes its timing
 * answer as "Schedule delivery on or after 2026-11-06", which would otherwise print a
 * second date format on the same sheet.
 *
 * Only a real calendar date standing on its own is touched: the month must be 01–12
 * and the day 01–31, and it may not touch a letter, digit, underscore or hyphen on
 * either side. So "Part 1234-56-78", "Suite 2026-01-15B", "SO-2026-000036" and a
 * timestamp like "2026-11-06T10:00" are all left exactly as written.
 */
export function usDatesInText(text: string | null | undefined): string {
  return t(text).replace(
    /(?<![\w-])(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\w-])/g,
    '$2/$3/$1',
  );
}

/**
 * A person's name as the sheet prints it. A name typed entirely in lowercase
 * ("kamilla eliezer") is capitalised word by word, including after a hyphen or an
 * apostrophe ("o'neil-smith" → "O'Neil-Smith"). A name with ANY capital letter is left
 * exactly as typed: "McDonald", "DeAndre" or "van der Berg" are the customer's own
 * spelling, and guessing at them would be worse than lowercase.
 */
export function personName(raw: string | null | undefined): string {
  const v = t(raw);
  // Unicode-aware, so "élodie ñuñez" becomes "Élodie Ñuñez", and a name holding any
  // capital — "Á" included — is the customer's own spelling and left alone.
  // Not a name at all — an email, "n/a", a phone typed into the name box: as typed.
  if (!v || /\p{Lu}/u.test(v) || /[@/\d]/.test(v)) return v;
  return v.replace(/(^|[\s\-'’.])(\p{Ll})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}
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
    deliveryType: bomDeliveryType(
      t(section?.loadingDock) || t(sub?.loadingDock),
      t(sub?.loadingDock),
      rawText(sub?.raw, LOADING_DOCK_TYPE_COL),
    ),
    preferredDeliveryDate:
      day(section?.preferredDeliveryDate) || day(sub?.preferredDeliveryDate ?? null),
    deliveryTiming: t(section?.deliveryTiming) || t(sub?.deliveryTiming),
    specialInstructions: t(sub?.specialInstructions),
    primary: {
      name: personName(sub?.pocName),
      phone: t(sub?.pocPhone),
      email: t(sub?.pocEmail),
      preferredComm: t(sub?.preferredComm),
      textNumber: t(sub?.textNumber),
    },
    secondary: {
      name: personName(sub?.secondaryPocName),
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

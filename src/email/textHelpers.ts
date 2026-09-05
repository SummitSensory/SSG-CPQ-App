/**
 * Shared by every email-template renderer in this directory (follow-ups,
 * e-sign, payment letters) — the same escaping and name-splitting logic was
 * defined three times over before this, byte-identical in two of them.
 */

export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Falls back to "there" rather than printing a blank when a name is missing. */
export const firstNameOf = (name: string | null | undefined): string =>
  String(name ?? '')
    .trim()
    .split(/\s+/)[0] || 'there';

/**
 * Everything after the first word — "" for a single-word or empty name,
 * never a fallback placeholder: unlike a missing first name, a missing last
 * name has no natural stand-in word, so a template author sees a blank
 * rather than something that reads as intentional.
 */
export const lastNameOf = (name: string | null | undefined): string =>
  String(name ?? '')
    .trim()
    .split(/\s+/)
    .slice(1)
    .join(' ');

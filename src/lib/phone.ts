/**
 * A North American phone number as xxx-xxx-xxxx, for printed documents.
 *
 * Ten digits, or eleven with a leading country code 1, are reformatted; an extension
 * ("x204", "ext. 204") is kept after the number. Anything else — an international
 * number, a typo, words — comes back exactly as given rather than being mangled into
 * something that looks like a real number and is not.
 */
export function formatUsPhone(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const ext = /\s*(?:ext\.?|x|#)\s*(\d{1,6})\s*$/i.exec(s);
  const main = ext ? s.slice(0, ext.index) : s;
  if (/[a-z]/i.test(main)) return s;
  let digits = main.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return s;
  const formatted = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return ext ? `${formatted} x${ext[1]}` : formatted;
}

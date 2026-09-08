import { renderPdf } from '../../render/pdf.js';
import { logger } from '../../lib/logger.js';
import { CERTIFICATE_BACKGROUND_DATA_URI } from './certificateBackground.js';

/**
 * A branded "Certificate of Signature" summary page, appended after the plain
 * signed pages (see fetchCompletedPdf in client.ts) as this app's one audit/
 * certificate record for the executed document — not alongside DocuSeal's own
 * combined document, which also carries its own audit log. Stacking both
 * produced two audit-log-shaped pages in a customer's copy, which is worse
 * than the small risk this page alone accepts: it is drawn from data this app
 * already owns and trusts (EsignSigner's own status/timestamp columns, plus
 * the signer's IP/location/drawn-signature pulled fresh from DocuSeal's own
 * API at render time — see service.ts's storeSignedCopy), which depends on
 * every relevant webhook having actually landed. DocuSeal's own audit log
 * remains viewable in DocuSeal's own dashboard/API for the full forensic
 * trail if that's ever needed.
 */

export interface CertificateSigner {
  role: string;
  name: string | null;
  email: string;
  viewOnly: boolean;
  status: string;
  /** When this app emailed this signer their turn — the certificate's "Sent". */
  emailedAt: Date | null;
  /** Doubles as "Email verified": opening the emailed link is the proof this
   *  signer controls that inbox — DocuSeal has no separate verification step
   *  unless a template explicitly adds one. */
  viewedAt: Date | null;
  completedAt: Date | null;
  declineReason: string | null;
  /** Fetched fresh from DocuSeal at certificate-render time — not persisted,
   *  and never used for anything but display here. */
  ipAddress?: string | null;
  /** "City, Country" from geolocation.ts, or null if unconfigured/unavailable. */
  location?: string | null;
  /** A data: URI of this signer's drawn signature, if DocuSeal returned one and
   *  it could be fetched and inlined — null falls back to a plain text line. */
  signatureDataUri?: string | null;
}

export interface CertificateInput {
  envelopeId: string;
  proposalNumber: string;
  proposalTitle?: string | null;
  customerName?: string | null;
  sentAt: Date | null;
  completedAt: Date | null;
  signers: CertificateSigner[];
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "05 SEP 2026 12:53:04 UTC" — UTC throughout, matching the timestamps
 *  DocuSeal's own certificate reports in. */
function fmt(d: Date | null): string {
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month').toUpperCase()} ${get('year')} ${get('hour')}:${get('minute')}:${get('second')} UTC`;
}

function timestampLines(s: CertificateSigner): string {
  const rows: Array<[string, Date | null]> = [
    ['Sent', s.emailedAt],
    ['Viewed', s.viewedAt],
    [s.status === 'DECLINED' ? 'Declined' : 'Signed', s.completedAt],
  ];
  return rows
    .filter(([, d]) => d !== null)
    .map(
      ([label, d]) =>
        `<div class="ts-row"><span class="ts-label">${esc(label)}</span>${fmt(d)}</div>`,
    )
    .join('');
}

function signatureBox(s: CertificateSigner): string {
  if (s.status !== 'COMPLETED') {
    return `<div class="sig-box sig-pending">${s.status === 'DECLINED' ? 'Declined' : 'Not yet signed'}</div>`;
  }
  if (s.signatureDataUri) {
    return `<div class="sig-box"><img src="${esc(s.signatureDataUri)}" alt="${esc(s.name ?? s.email)}'s signature"></div>`;
  }
  // No image could be fetched — the printed name in a script-like face reads as
  // a signature line rather than leaving the box looking broken or empty.
  return `<div class="sig-box sig-fallback">${esc(s.name || s.email)}</div>`;
}

function signerBlock(s: CertificateSigner): string {
  const label = s.name ? esc(s.name) : esc(s.email);
  if (s.viewOnly) {
    return `
    <div class="signer">
      <div class="signer-grid">
        <div>
          <div class="signer-name">${label}</div>
          <div class="signer-email">${esc(s.email)}</div>
          <div class="role-tag">${esc(s.role)}</div>
        </div>
        <div class="viewer-note">Copied for reference — not required to sign.</div>
        <div></div>
      </div>
    </div>`;
  }
  const emailVerified = s.viewedAt
    ? `<div class="verify"><div class="verify-title">Recipient verification</div><div class="ts-row"><span class="ts-label">Email verified</span>${fmt(s.viewedAt)}</div></div>`
    : '';
  const ipLocation =
    s.ipAddress || s.location
      ? `<div class="ip-block">${s.ipAddress ? `<div class="ip-label">IP address</div><div>${esc(s.ipAddress)}</div>` : ''}${
          s.location
            ? `<div class="ip-label" style="margin-top:6pt;">Location</div><div>${esc(s.location)}</div>`
            : ''
        }</div>`
      : '';
  return `
    <div class="signer">
      <div class="signer-grid">
        <div>
          <div class="signer-name">${label}</div>
          <div class="signer-email">${esc(s.email)}</div>
          <div class="role-tag">${esc(s.role)}</div>
        </div>
        <div class="timestamps">${timestampLines(s)}</div>
        <div>
          ${signatureBox(s)}
          ${ipLocation}
        </div>
      </div>
      ${emailVerified}
    </div>`;
}

/** Exported for tests — the HTML this renders to PDF, checkable without a
 *  headless browser, same pattern as assembly.ts's buildPackage. */
export function buildCertificateHtml(input: CertificateInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 8.5in;
    height: 11in;
    background-image: url('${CERTIFICATE_BACKGROUND_DATA_URI}');
    background-size: 100% 100%;
    background-repeat: no-repeat;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    font-family: Georgia, 'Times New Roman', serif;
    /* Every color below is solid black, deliberately, with exactly one named
       exception: the "Certificate of Signature" title. This certificate is a
       legal/compliance record, not a marketing page — a lighter gray reads as
       "design polish" in a browser and as "hard to read" once actually
       printed or scanned, which is what this page is for. */
    color: #000;
  }
  .content { padding: 0.85in 0.8in 0.7in; box-sizing: border-box; }
  h1 {
    text-align: center;
    font-size: 22pt;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #2c3e50;
    margin: 0 0 2pt;
  }
  h1 em { font-style: italic; text-transform: lowercase; font-weight: 400; letter-spacing: 0; }
  .subtitle { text-align: center; font-size: 9.5pt; color: #000; margin-bottom: 20pt; }
  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24pt;
    font-size: 8.5pt;
    line-height: 1.6;
    color: #000;
    border-bottom: 1px solid #b9c2cf;
    padding-bottom: 10pt;
    margin-bottom: 6pt;
  }
  .meta-label { text-transform: uppercase; letter-spacing: 0.05em; font-size: 7.5pt; color: #000; }
  .meta-row b { color: #000; font-size: 10pt; letter-spacing: 0.02em; }
  .meta-row > div:last-child { text-align: right; }
  .signer { border-bottom: 1px solid #e4e8ee; padding: 14pt 0; }
  .signer:last-of-type { border-bottom: none; }
  .signer-grid { display: grid; grid-template-columns: 1.5fr 1.2fr 1.3fr; gap: 16pt; align-items: start; }
  .signer-name { font-size: 13pt; font-weight: 700; color: #000; }
  .signer-email { font-size: 9pt; color: #000; margin-top: 1pt; }
  .role-tag {
    display: inline-block;
    margin-top: 5pt;
    font-size: 7pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #000;
    background: #eef1f6;
    border-radius: 3pt;
    padding: 2pt 6pt;
  }
  .viewer-note { font-size: 9pt; color: #000; font-style: italic; align-self: center; }
  .timestamps { font-size: 8.5pt; color: #000; }
  .ts-row { margin-bottom: 5pt; }
  .ts-label {
    display: block;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 7pt;
    color: #000;
  }
  .sig-box {
    border: 1px solid #b9c2cf;
    border-radius: 3pt;
    min-height: 34pt;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4pt 8pt;
    background: rgba(255, 255, 255, 0.55);
  }
  .sig-box img { max-height: 32pt; max-width: 100%; }
  .sig-fallback { font-family: 'Segoe Script', Georgia, cursive; font-size: 14pt; color: #000; }
  .sig-pending { font-size: 8.5pt; color: #000; font-style: italic; }
  .ip-block { margin-top: 8pt; font-size: 8.5pt; }
  .ip-label { text-transform: uppercase; letter-spacing: 0.05em; font-size: 7pt; color: #000; }
  .verify { margin-top: 10pt; }
  .verify-title {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 7.5pt;
    color: #000;
    margin-bottom: 4pt;
  }
  .footer {
    margin-top: 22pt;
    font-size: 8pt;
    color: #000;
    line-height: 1.55;
    text-align: center;
    max-width: 5.8in;
    margin-left: auto;
    margin-right: auto;
  }
</style>
</head>
<body>
  <div class="content">
    <h1>Certificate <em>of</em> Signature</h1>
    <div class="subtitle">Summit Sensory Gym</div>
    <div class="meta-row">
      <div>
        <div class="meta-label">Ref. number</div>
        <b>${esc(input.envelopeId)}</b><br>
        <span style="font-size:8.5pt;">${esc(input.proposalNumber)}${input.proposalTitle ? ' — ' + esc(input.proposalTitle) : ''}${input.customerName ? ' · ' + esc(input.customerName) : ''}</span>
      </div>
      <div>
        <div class="meta-label">Document completed by all parties on</div>
        <b>${fmt(input.completedAt)}</b>
      </div>
    </div>
    ${input.signers.map(signerBlock).join('')}
    <div class="footer">
      This certificate summarizes the signing record for this document, collected via DocuSeal,
      the electronic signature service used to gather these signatures. The complete technical
      audit trail — IP addresses, device information, and identity verification for each
      event — remains on file with DocuSeal and is available on request.
    </div>
  </div>
</body>
</html>`;
}

/** Fetch a remote image and inline it as a data: URI — the same rule every
 *  other document rendered through render/pdf.ts follows (no network access
 *  once Chromium has the HTML), applied here to a signer's drawn-signature
 *  image, which only exists as a DocuSeal-hosted URL until this point.
 *  Best-effort: a failed fetch just means this signer's box falls back to a
 *  printed name instead of an image. */
export async function imageUrlToDataUri(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/png';
    if (!contentType.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch (err) {
    logger.warn({ err, url }, 'certificate: could not fetch a signature image');
    return null;
  }
}

export async function renderCertificatePdf(input: CertificateInput): Promise<Buffer> {
  return renderPdf(buildCertificateHtml(input), { format: 'Letter', edgeToEdge: true });
}

import { renderPdf } from '../../render/pdf.js';
import { CERTIFICATE_BACKGROUND_DATA_URI } from './certificateBackground.js';

/**
 * A branded "Certificate of Signature" summary page, appended after DocuSeal's
 * own combined document (signed pages + DocuSeal's own audit log) — not in
 * place of it. DocuSeal's certificate is the authoritative E-SIGN Act/UETA
 * compliance record (IP addresses, device info, identity verification per
 * event); this page is deliberately a simpler, on-brand summary drawn from
 * data this app already owns and trusts (EsignSigner's own status/timestamp
 * columns, not a reconstruction from webhook payloads), pointing the reader
 * at DocuSeal's pages for the full forensic trail. Replacing DocuSeal's
 * certificate with a reconstruction of our own would be a real compliance
 * regression if a webhook were ever missed; appending ours alongside it
 * cannot be.
 */

export interface CertificateSigner {
  role: string;
  name: string | null;
  email: string;
  viewOnly: boolean;
  status: string;
  viewedAt: Date | null;
  completedAt: Date | null;
  declineReason: string | null;
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

/** UTC, matching the timestamps DocuSeal's own certificate reports in. */
function fmt(d: Date | null): string {
  if (!d) return '—';
  return (
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }) + ' UTC'
  );
}

function signerRow(s: CertificateSigner): string {
  const label = s.name ? `${esc(s.name)} — ${esc(s.email)}` : esc(s.email);
  if (s.viewOnly) {
    return `<tr>
      <td><div class="role">${esc(s.role)}</div><div class="who">${label}</div></td>
      <td class="viewer">Copied for reference, not required to sign</td>
      <td>—</td>
      <td>—</td>
    </tr>`;
  }
  const status =
    s.status === 'COMPLETED'
      ? { cls: 'status-completed', label: 'Signed' }
      : s.status === 'DECLINED'
        ? { cls: 'status-declined', label: 'Declined' }
        : s.status === 'VIEWED'
          ? { cls: 'status-pending', label: 'Viewed, not yet signed' }
          : { cls: 'status-pending', label: 'Pending' };
  return `<tr>
    <td><div class="role">${esc(s.role)}</div><div class="who">${label}</div></td>
    <td class="${status.cls}">${status.label}${
      s.status === 'DECLINED' && s.declineReason
        ? `<div class="reason">${esc(s.declineReason)}</div>`
        : ''
    }</td>
    <td>${fmt(s.viewedAt)}</td>
    <td>${fmt(s.completedAt)}</td>
  </tr>`;
}

function buildCertificateHtml(input: CertificateInput): string {
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
    color: #1a1a1a;
  }
  .content { padding: 1.2in 1.05in 1in; box-sizing: border-box; }
  h1 {
    text-align: center;
    font-size: 21pt;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #2c3e50;
    margin: 0 0 4pt;
  }
  .subtitle { text-align: center; font-size: 10pt; color: #5b6478; margin-bottom: 24pt; }
  .meta-row {
    display: flex;
    justify-content: space-between;
    gap: 24pt;
    font-size: 9.5pt;
    line-height: 1.6;
    color: #5b6478;
    border-bottom: 1px solid #b9c2cf;
    padding-bottom: 10pt;
    margin-bottom: 20pt;
  }
  .meta-row b { color: #1a1a1a; }
  .meta-row > div:last-child { white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th {
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 8.5pt;
    color: #5b6478;
    border-bottom: 1px solid #b9c2cf;
    padding: 0 8pt 6pt 0;
  }
  td { padding: 9pt 8pt 9pt 0; vertical-align: top; border-bottom: 1px solid #e4e8ee; }
  .role { font-weight: 700; }
  .who { color: #5b6478; font-size: 9pt; margin-top: 1pt; }
  .status-completed { color: #1f7a55; font-weight: 700; }
  .status-declined { color: #9c3327; font-weight: 700; }
  .status-pending { color: #8a8f8f; }
  .viewer { color: #8a8f8f; font-style: italic; font-size: 9pt; }
  .reason { font-weight: 400; font-size: 8.5pt; color: #5b6478; margin-top: 2pt; }
  .footer {
    margin-top: 30pt;
    font-size: 8.5pt;
    color: #5b6478;
    line-height: 1.55;
    text-align: center;
    max-width: 5.6in;
    margin-left: auto;
    margin-right: auto;
  }
</style>
</head>
<body>
  <div class="content">
    <h1>Certificate of Signature</h1>
    <div class="subtitle">Summit Sensory Gym</div>
    <div class="meta-row">
      <div>
        <b>Envelope</b> ${esc(input.envelopeId)}<br>
        <b>Proposal</b> ${esc(input.proposalNumber)}${input.proposalTitle ? ' — ' + esc(input.proposalTitle) : ''}
        ${input.customerName ? `<br><b>Client</b> ${esc(input.customerName)}` : ''}
      </div>
      <div style="text-align:right;">
        <b>Sent</b> ${fmt(input.sentAt)}<br>
        <b>Completed</b> ${fmt(input.completedAt)}
      </div>
    </div>
    <table>
      <thead><tr><th>Party</th><th>Status</th><th>Viewed</th><th>Signed</th></tr></thead>
      <tbody>${input.signers.map(signerRow).join('')}</tbody>
    </table>
    <div class="footer">
      This certificate summarizes the signing record for this document. The complete technical
      audit trail — IP addresses, device information, and identity verification for each
      event — is provided by DocuSeal, the electronic signature service used to collect these
      signatures, on the accompanying Certificate of Signature (Audit Log) pages.
    </div>
  </div>
</body>
</html>`;
}

export async function renderCertificatePdf(input: CertificateInput): Promise<Buffer> {
  return renderPdf(buildCertificateHtml(input), { format: 'Letter', edgeToEdge: true });
}

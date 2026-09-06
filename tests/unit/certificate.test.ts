import { describe, it, expect } from 'vitest';
import {
  buildCertificateHtml,
  imageUrlToDataUri,
  type CertificateInput,
} from '../../src/integrations/docuseal/certificate.js';

function base(overrides: Partial<CertificateInput> = {}): CertificateInput {
  return {
    envelopeId: 'env_123',
    proposalNumber: 'P-2026-000125',
    proposalTitle: 'Maurer Therapy Test',
    customerName: 'Maurer Therapy Test',
    sentAt: new Date('2026-09-05T18:52:00Z'),
    completedAt: new Date('2026-09-05T18:53:04Z'),
    signers: [],
    ...overrides,
  };
}

describe('buildCertificateHtml', () => {
  it('titles the page Certificate of Signature and prints the envelope as the ref number', () => {
    const html = buildCertificateHtml(base());
    expect(html).toContain('Certificate <em>of</em> Signature');
    expect(html).toContain('env_123');
    expect(html).toContain('P-2026-000125');
  });

  it('prints sent/viewed/signed timestamps a signer actually has, and omits ones it does not', () => {
    const html = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: 'Dick Head',
            email: 'dick@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date('2026-09-05T18:49:12Z'),
            viewedAt: new Date('2026-09-05T18:52:00Z'),
            completedAt: new Date('2026-09-05T18:53:04Z'),
            declineReason: null,
          },
        ],
      }),
    );
    expect(html).toContain('Dick Head');
    expect(html).toContain('dick@example.com');
    expect(html).toContain('Sent');
    expect(html).toContain('Viewed');
    expect(html).toContain('Signed');
    // Email verified reuses the viewedAt timestamp, not a separate fabricated one.
    expect(html).toContain('Email verified');
  });

  it('omits Sent/Viewed/Signed rows a signer never reached', () => {
    const html = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Summit',
            name: 'Bryan Shepherd',
            email: 'bryan@summitsensory.com',
            viewOnly: false,
            status: 'PENDING',
            emailedAt: new Date('2026-09-05T18:49:12Z'),
            viewedAt: null,
            completedAt: null,
            declineReason: null,
          },
        ],
      }),
    );
    expect(html).toContain('Sent');
    expect(html).not.toContain('Viewed');
    expect(html).not.toContain('Signed');
    expect(html).not.toContain('Email verified');
    expect(html).toContain('Not yet signed');
  });

  it('shows a signature image when one was fetched, and a printed-name fallback otherwise', () => {
    const withImage = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: 'Dick Head',
            email: 'dick@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date(),
            viewedAt: new Date(),
            completedAt: new Date(),
            declineReason: null,
            signatureDataUri: 'data:image/png;base64,AAAA',
          },
        ],
      }),
    );
    expect(withImage).toContain('<img src="data:image/png;base64,AAAA"');

    const withoutImage = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: 'Dick Head',
            email: 'dick@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date(),
            viewedAt: new Date(),
            completedAt: new Date(),
            declineReason: null,
          },
        ],
      }),
    );
    expect(withoutImage).not.toContain('<img');
    expect(withoutImage).toContain('sig-fallback');
    expect(withoutImage).toContain('Dick Head');
  });

  it('prints IP address and location only when present', () => {
    const withBoth = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: 'Dick Head',
            email: 'dick@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date(),
            viewedAt: new Date(),
            completedAt: new Date(),
            declineReason: null,
            ipAddress: '24.9.44.164',
            location: 'Castle Rock, United States',
          },
        ],
      }),
    );
    expect(withBoth).toContain('24.9.44.164');
    expect(withBoth).toContain('Castle Rock, United States');

    const withNeither = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: 'Dick Head',
            email: 'dick@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date(),
            viewedAt: new Date(),
            completedAt: new Date(),
            declineReason: null,
          },
        ],
      }),
    );
    // Not the bare words — the footer's own disclaimer text mentions "IP
    // addresses" unconditionally, so check for the actual rendered block.
    expect(withNeither).not.toContain('class="ip-block"');
    expect(withNeither).not.toContain('IP address</div>');
  });

  it('shows a CC recipient as copied for reference, with no timestamps or signature box', () => {
    const html = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'CC',
            name: 'Ops',
            email: 'ops@example.com',
            viewOnly: true,
            status: 'PENDING',
            emailedAt: new Date(),
            viewedAt: null,
            completedAt: null,
            declineReason: null,
          },
        ],
      }),
    );
    expect(html).toContain('Copied for reference');
    // The style block always defines .sig-box as a CSS rule; only actual usage
    // (class="sig-box) would mean a viewer got a signature box rendered.
    expect(html).not.toContain('class="sig-box');
  });

  it('escapes signer-supplied text so it cannot break out of the markup', () => {
    const html = buildCertificateHtml(
      base({
        signers: [
          {
            role: 'Customer',
            name: '<script>alert(1)</script>',
            email: 'x@example.com',
            viewOnly: false,
            status: 'COMPLETED',
            emailedAt: new Date(),
            viewedAt: new Date(),
            completedAt: new Date(),
            declineReason: null,
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('imageUrlToDataUri', () => {
  it('inlines a successful image fetch as a data: URI', async () => {
    const fakeFetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as typeof fetch;
    const uri = await imageUrlToDataUri('https://docuseal.example/sig.png', fakeFetch);
    expect(uri).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });

  it('returns null on a failed fetch rather than throwing', async () => {
    const fakeFetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const uri = await imageUrlToDataUri('https://docuseal.example/missing.png', fakeFetch);
    expect(uri).toBeNull();
  });

  it('returns null for a non-image response', async () => {
    const fakeFetch = (async () =>
      new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const uri = await imageUrlToDataUri('https://docuseal.example/sig.txt', fakeFetch);
    expect(uri).toBeNull();
  });

  it('returns null when the fetch itself throws', async () => {
    const fakeFetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const uri = await imageUrlToDataUri('https://docuseal.example/sig.png', fakeFetch);
    expect(uri).toBeNull();
  });
});

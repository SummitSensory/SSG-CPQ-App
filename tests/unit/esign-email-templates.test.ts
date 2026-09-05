import { describe, it, expect } from 'vitest';
import {
  renderEsignEmail,
  lastNameOf,
  type EsignEmailContext,
} from '../../src/email/esignEmailTemplates.js';

const BASE_CTX: EsignEmailContext = {
  firstName: 'Mary',
  lastName: 'Loughney',
  senderFirstName: 'Bryan',
  senderName: 'Bryan Shepherd',
  customerName: 'Katonah-Lewisboro School District',
  proposalNumber: 'P-2026-000063',
  proposalTitle: 'KLSD Sensory Therapy Room',
  proposalVersionLabel: 'V2',
  proposalDateLabel: 'September 4, 2026',
  proposalExpirationLabel: 'October 4, 2026',
  productName: 'Summit Soar S1',
  signingLink: 'https://docuseal.com/s/sample',
};

describe('lastNameOf', () => {
  it('returns everything after the first word', () => {
    expect(lastNameOf('Mary Loughney')).toBe('Loughney');
    expect(lastNameOf('Mary Jane Loughney')).toBe('Jane Loughney');
  });
  it('returns "" rather than a fallback word, unlike firstNameOf', () => {
    expect(lastNameOf('Mary')).toBe('');
    expect(lastNameOf(null)).toBe('');
    expect(lastNameOf(undefined)).toBe('');
  });
});

describe('renderEsignEmail — {{PascalCase}} placeholders', () => {
  const template = {
    key: 't1',
    name: 'Test',
    subject: 'Please sign {{ProjectName}}',
    bodyHtml:
      '<p>Hi {{FirstName}} {{LastName}},</p>' +
      '<p>{{OrganizationName}} — {{ProductName}} — {{ProposalNumber}} {{ProposalVersion}}</p>' +
      '<p>Dated {{ProposalDate}}, valid through {{ProposalExpirationDate}}.</p>',
  };

  it('substitutes every new token', () => {
    const { subject, html } = renderEsignEmail(template, BASE_CTX);
    expect(subject).toBe('Please sign KLSD Sensory Therapy Room');
    expect(html).toContain('Hi Mary Loughney,');
    expect(html).toContain('Katonah-Lewisboro School District — Summit Soar S1 — P-2026-000063 V2');
    expect(html).toContain('Dated September 4, 2026, valid through October 4, 2026.');
  });

  it('leaves a missing optional field blank rather than printing "undefined"', () => {
    const sparse: EsignEmailContext = {
      firstName: 'Mary',
      senderFirstName: 'Bryan',
      signingLink: 'https://docuseal.com/s/sample',
    };
    const { html } = renderEsignEmail(template, sparse);
    expect(html).not.toContain('undefined');
    expect(html).toContain('Hi Mary ,'); // lastName blank
  });

  it('still substitutes the original [Bracket] tokens alongside the new ones in the same template', () => {
    const mixed = {
      key: 't2',
      name: 'Mixed',
      subject: '[Proposal Number] / {{ProposalNumber}}',
      bodyHtml: '<p>[First Name] and {{FirstName}} are the same person.</p>',
    };
    const { subject, html } = renderEsignEmail(mixed, BASE_CTX);
    expect(subject).toBe('P-2026-000063 / P-2026-000063');
    expect(html).toBe('<p>Mary and Mary are the same person.</p>');
  });

  it('HTML-escapes a value that contains markup-sensitive characters', () => {
    const ctx: EsignEmailContext = {
      ...BASE_CTX,
      customerName: 'Smith & Sons <School>',
    };
    const { html } = renderEsignEmail(
      { key: 't3', name: 'Esc', subject: '', bodyHtml: '{{OrganizationName}}' },
      ctx,
    );
    expect(html).toBe('Smith &amp; Sons &lt;School&gt;');
  });
});

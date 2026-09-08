import { describe, it, expect } from 'vitest';
import { resolveSignerRow, type SignerRowRef } from '../../src/integrations/docuseal/service.js';

/**
 * The exact incident this guards: a Customer and a Summit signer sharing one email
 * address (someone testing both roles themselves, or two roles at one company) sent
 * both DocuSeal submitters to the same local row, because the old matching fell
 * back to email alone — whichever submitter this loop reached second overwrote the
 * first one's status, permanently stranding the other row and an envelope that
 * could never reach COMPLETED. See applyStatus's own comment in service.ts.
 */
describe('resolveSignerRow', () => {
  const customer: SignerRowRef = {
    id: 'row-customer',
    role: 'Customer',
    email: 'bryan@summitsensory.com',
    docusealSubmitterId: null,
  };
  const summit: SignerRowRef = {
    id: 'row-summit',
    role: 'Summit',
    email: 'bryan@summitsensory.com',
    docusealSubmitterId: null,
  };
  const rows = [customer, summit];

  it('matches two submitters sharing one email to two different rows, by role', () => {
    const claimed = new Set<string>();

    const first = resolveSignerRow(rows, claimed, {
      id: 111,
      role: 'Customer',
      email: 'bryan@summitsensory.com',
    });
    expect(first?.id).toBe('row-customer');
    claimed.add(first!.id);

    const second = resolveSignerRow(rows, claimed, {
      id: 222,
      role: 'Summit',
      email: 'bryan@summitsensory.com',
    });
    expect(second?.id).toBe('row-summit');
  });

  it('never returns a row already claimed in this pass, even if it is the only email match', () => {
    const claimed = new Set<string>(['row-customer']);
    // No role given (DocuSeal did not report one) — email is the only signal, and
    // the one candidate row for that email is already claimed.
    const match = resolveSignerRow([customer], claimed, {
      id: 333,
      role: null,
      email: 'bryan@summitsensory.com',
    });
    expect(match).toBeUndefined();
  });

  it('prefers an exact docusealSubmitterId match over role or email', () => {
    const rowsWithId: SignerRowRef[] = [
      { ...customer, docusealSubmitterId: '999' },
      { ...summit, docusealSubmitterId: null },
    ];
    // Role says Summit, but the id says this is really the Customer row (e.g. a
    // rep renamed roles after the fact) — the id must win.
    const match = resolveSignerRow(rowsWithId, new Set(), {
      id: 999,
      role: 'Summit',
      email: 'someone-else@example.com',
    });
    expect(match?.id).toBe('row-customer');
  });

  it('returns undefined when nothing matches by id, role, or email', () => {
    const match = resolveSignerRow(rows, new Set(), {
      id: 444,
      role: 'Witness',
      email: 'nobody@example.com',
    });
    expect(match).toBeUndefined();
  });
});

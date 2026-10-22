import { describe, it, expect } from 'vitest';
import { proposalPdfFileName } from '../../src/proposals/pdfFileName.js';
import { computeAdventureProposal } from '../../src/proposals/adventureSeries.js';

/**
 * The proposal PDF name: Customer-Frame Code-Proposal#[-RevN]-MMDDYYYY, the dimensions
 * once. The server copy of public/app.js proposalFileName(), used where the browser
 * did not send a name.
 */

const now = new Date(2026, 9, 6); // 10/06/2026
const heading = (name: string, description = '') => ({ lineType: 'GROUP', name, description });

describe('proposalPdfFileName', () => {
  it('a current frame code carries its own dimensions — never repeated', () => {
    expect(
      proposalPdfFileName({
        orgName: 'Soar Autism Center - Goodyear',
        number: 'P-2026-000194',
        version: 1,
        lines: [heading('SQ-H2MBL2T2-10x10 — Itemized', "Frame Dimensions: 10' × 10'")],
        now,
      }),
    ).toBe('Soar Autism Center - Goodyear-SQ-H2MBL2T2-10x10-P-2026-000194-10062026');
  });

  it('a legacy code gets its dimensions from the heading note, once', () => {
    expect(
      proposalPdfFileName({
        orgName: 'Soar Autism Center - Goodyear',
        number: 'P-2026-000194',
        version: 1,
        lines: [heading('SQ-2MBL2T — Itemized', "Frame Dimensions: 10' × 10'")],
        now,
      }),
    ).toBe('Soar Autism Center - Goodyear-SQ-2MBL2T-10x10-P-2026-000194-10062026');
  });

  it('dimensions in the middle of the code are recognised too', () => {
    const name = proposalPdfFileName({
      orgName: 'Org',
      number: 'P-1',
      lines: [heading('SQ-10x10-H2MBL2T2 — Itemized', "Frame Dimensions: 10' × 10'")],
      now,
    });
    expect(name).toBe('Org-SQ-10x10-H2MBL2T2-P-1-10062026');
  });

  it('keeps the revision marker', () => {
    expect(
      proposalPdfFileName({
        orgName: 'Org',
        number: 'P-1',
        version: 2,
        lines: [heading('R-H1L1Z-10x8 — Itemized', "Frame Dimensions: 10' × 8'")],
        now,
      }),
    ).toBe('Org-R-H1L1Z-10x8-P-1-Rev1-10062026');
  });

  it('a non-Adventure proposal is named after its first section, as before', () => {
    expect(
      proposalPdfFileName({
        orgName: 'Org',
        number: 'P-2',
        lines: [heading('SUMMIT SOAR SERIES', 'K-4000 · Project Scope')],
        now,
      }),
    ).toBe('Org-Summit Soar Series-P-2-10062026');
  });

  it('names what the engine actually generates', () => {
    const { lines } = computeAdventureProposal({
      length: 12,
      width: 10,
      config: 'Rectangle',
      legs: 6,
      ladders: 2,
      monkeyBars: true,
      trolley: true,
      trolleyType: 'Dual',
    });
    expect(proposalPdfFileName({ orgName: 'Org', number: 'P-3', lines, now })).toBe(
      'Org-R-H1MBL2T2-12x10-P-3-10062026',
    );
  });
});

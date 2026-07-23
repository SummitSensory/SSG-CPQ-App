import { describe, it, expect } from 'vitest';
import { decideInbound, sourceOfTruth } from '../../src/integrations/monday/conflict.js';

describe('monday conflict rules & source of truth', () => {
  it('refuses inbound writes to CPQ-authoritative fields', () => {
    for (const field of ['opportunity.amount', 'opportunity.owner', 'opportunity.closeDate', 'contact.email', 'shipping', 'installation', 'files']) {
      const d = decideInbound(field);
      expect(d.allowed, field).toBe(false);
    }
  });

  it('allows inbound stage change (approved shared rule)', () => {
    const d = decideInbound('opportunity.stage');
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.rule.field).toBe('opportunity.stage');
  });

  it('allows inbound project status (monday-authoritative)', () => {
    expect(decideInbound('project.status').allowed).toBe(true);
  });

  it('refuses unknown fields', () => {
    const d = decideInbound('opportunity.secretField');
    expect(d.allowed).toBe(false);
  });

  it('reports the source of truth for each field', () => {
    expect(sourceOfTruth('opportunity.amount')).toBe('CPQ');
    expect(sourceOfTruth('opportunity.stage')).toBe('SHARED');
    expect(sourceOfTruth('project.status')).toBe('MONDAY');
    expect(sourceOfTruth('nope')).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { OrganizationInput, ContactInput, RoomInput, OpportunityInput } from '../../src/crm/validation.js';

describe('crm validation', () => {
  it('accepts a valid organization', () => {
    expect(OrganizationInput.safeParse({ name: 'Summit Sensory' }).success).toBe(true);
  });
  it('rejects a too-short org name', () => {
    expect(OrganizationInput.safeParse({ name: 'A' }).success).toBe(false);
  });
  it('rejects an invalid contact email', () => {
    const r = ContactInput.safeParse({ organizationId: 'o1', firstName: 'A', lastName: 'B', email: 'nope' });
    expect(r.success).toBe(false);
  });
  it('rejects negative room dimensions', () => {
    const r = RoomInput.safeParse({ facilityId: 'f1', name: 'Gym', lengthIn: -5 });
    expect(r.success).toBe(false);
  });
  it('requires currency when budget amount is set', () => {
    const r = OpportunityInput.safeParse({ organizationId: 'o1', name: 'Deal', budgetAmount: '1000.00' });
    expect(r.success).toBe(false);
  });
  it('rejects non-decimal budget (no floats-as-scientific etc.)', () => {
    const r = OpportunityInput.safeParse({ organizationId: 'o1', name: 'Deal', budgetAmount: '1e5', budgetCurrency: 'USD' });
    expect(r.success).toBe(false);
  });
});

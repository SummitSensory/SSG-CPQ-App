import { describe, it, expect } from 'vitest';
import {
  OrganizationInput,
  ContactInput,
  ContactUpdateInput,
  RoomInput,
  OpportunityInput,
} from '../../src/crm/validation.js';

describe('crm validation', () => {
  it('accepts a valid organization', () => {
    expect(OrganizationInput.safeParse({ name: 'Summit Sensory' }).success).toBe(true);
  });
  it('rejects a too-short org name', () => {
    expect(OrganizationInput.safeParse({ name: 'A' }).success).toBe(false);
  });
  it('rejects an invalid contact email', () => {
    const r = ContactInput.safeParse({
      organizationId: 'o1',
      firstName: 'A',
      lastName: 'B',
      email: 'nope',
    });
    expect(r.success).toBe(false);
  });
  it('rejects negative room dimensions', () => {
    const r = RoomInput.safeParse({ facilityId: 'f1', name: 'Gym', lengthIn: -5 });
    expect(r.success).toBe(false);
  });
  it('requires currency when budget amount is set', () => {
    const r = OpportunityInput.safeParse({
      organizationId: 'o1',
      name: 'Deal',
      budgetAmount: '1000.00',
    });
    expect(r.success).toBe(false);
  });
  it('rejects non-decimal budget (no floats-as-scientific etc.)', () => {
    const r = OpportunityInput.safeParse({
      organizationId: 'o1',
      name: 'Deal',
      budgetAmount: '1e5',
      budgetCurrency: 'USD',
    });
    expect(r.success).toBe(false);
  });

  describe('ContactUpdateInput', () => {
    it('accepts a partial update touching only one field', () => {
      expect(ContactUpdateInput.safeParse({ isDecisionMaker: true }).success).toBe(true);
    });
    it('lowercases and trims a valid email', () => {
      const r = ContactUpdateInput.safeParse({ email: '  Person@Example.COM  ' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe('person@example.com');
    });
    it('rejects an invalid email', () => {
      expect(ContactUpdateInput.safeParse({ email: 'nope' }).success).toBe(false);
    });
    it('treats an empty-string email as an explicit clear, not a validation error', () => {
      const r = ContactUpdateInput.safeParse({ email: '' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBeNull();
    });
    it('treats an empty-string phone/title/notes as an explicit clear', () => {
      const r = ContactUpdateInput.safeParse({ phone: '', title: '', notes: '' });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.phone).toBeNull();
        expect(r.data.title).toBeNull();
        expect(r.data.notes).toBeNull();
      }
    });
    it('rejects a blank first name', () => {
      expect(ContactUpdateInput.safeParse({ firstName: '  ' }).success).toBe(false);
    });
  });
});

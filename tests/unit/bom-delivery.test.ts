import { describe, it, expect } from 'vitest';
import { bomPhone, deliveryDetails, PHONE_NUMFMT } from '../../src/handoff/bomDelivery.js';

/**
 * The delivery block on the Bill of Materials: the phone rule Bryan approved, and
 * which answer wins when a vendor section and the customer's portal submission both
 * carry one.
 */
describe('bomPhone', () => {
  it('formats a plain 10-digit number and makes it numeric', () => {
    expect(bomPhone('303-748-8082')).toEqual({ text: '(303) 748-8082', numeric: 3037488082 });
    expect(bomPhone('(303) 748 8082')).toEqual({ text: '(303) 748-8082', numeric: 3037488082 });
    expect(bomPhone('303.748.8082')).toEqual({ text: '(303) 748-8082', numeric: 3037488082 });
  });

  it('drops a leading US 1 from an 11-digit number', () => {
    expect(bomPhone('1-303-748-8082')).toEqual({ text: '(303) 748-8082', numeric: 3037488082 });
    expect(bomPhone('+1 (303) 748-8082')).toEqual({
      text: '(303) 748-8082',
      numeric: 3037488082,
    });
  });

  it('leaves international numbers, extensions and words exactly as typed', () => {
    expect(bomPhone('+44 20 7946 0958')).toEqual({ text: '+44 20 7946 0958', numeric: null });
    // Ten digits, but not a North American number.
    expect(bomPhone('+86 1012345678')).toEqual({ text: '+86 1012345678', numeric: null });
    expect(bomPhone('303-748-8082 x12')).toEqual({ text: '303-748-8082 x12', numeric: null });
    expect(bomPhone('303-748-8082 cell')).toEqual({ text: '303-748-8082 cell', numeric: null });
    expect(bomPhone('748-8082')).toEqual({ text: '748-8082', numeric: null });
    expect(bomPhone('2-303-748-8082')).toEqual({ text: '2-303-748-8082', numeric: null });
  });

  it('is blank for nothing', () => {
    expect(bomPhone(null)).toEqual({ text: '', numeric: null });
    expect(bomPhone('   ')).toEqual({ text: '', numeric: null });
  });

  it('uses the template’s phone number format', () => {
    expect(PHONE_NUMFMT).toBe('[<=9999999]###-####;(###) ###-####');
  });
});

describe('deliveryDetails', () => {
  const sub = {
    pocName: 'Jennifer Fattal',
    pocPhone: '3037488082',
    pocEmail: 'jenny@example.com',
    preferredComm: 'Email',
    textNumber: '303 555 1212',
    secondaryPocName: 'Sam Second',
    secondaryPocPhone: '720-555-0000',
    secondaryPocEmail: 'sam@example.com',
    secondaryPreferredComm: 'Text',
    secondaryMobile: '720-555-0001',
    loadingDock: 'No, I need liftgate delivery',
    deliveryTiming: 'Mornings',
    preferredDeliveryDate: new Date('2026-10-05T00:00:00Z'),
    specialInstructions: 'Call ahead.\nGate code 1234.',
  };

  it('prefers the section’s own answers, falling back to the submission', () => {
    const d = deliveryDetails(
      {
        loadingDock: 'Yes, we have a dock',
        deliveryTiming: '',
        preferredDeliveryDate: new Date('2026-11-01T00:00:00Z'),
      },
      sub,
    );
    expect(d.deliveryType).toBe('Yes, we have a dock');
    expect(d.deliveryTiming).toBe('Mornings'); // blank on the section → the customer's
    expect(d.preferredDeliveryDate).toBe('2026-11-01');
    expect(d.specialInstructions).toBe('Call ahead.\nGate code 1234.');
  });

  it('maps the primary and secondary points of contact', () => {
    const d = deliveryDetails(null, sub);
    expect(d.deliveryType).toBe('No, I need liftgate delivery');
    expect(d.preferredDeliveryDate).toBe('2026-10-05');
    expect(d.primary).toEqual({
      name: 'Jennifer Fattal',
      phone: '3037488082',
      email: 'jenny@example.com',
      preferredComm: 'Email',
      textNumber: '303 555 1212',
    });
    // The secondary's "Text #" is the portal's secondary mobile.
    expect(d.secondary.textNumber).toBe('720-555-0001');
    expect(d.secondary.preferredComm).toBe('Text');
  });

  it('is all blanks with no submission and no section answers', () => {
    const d = deliveryDetails(null, null);
    expect(d.deliveryType).toBe('');
    expect(d.preferredDeliveryDate).toBe('');
    expect(d.primary.name).toBe('');
    expect(d.secondary.phone).toBe('');
  });
});

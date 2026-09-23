import { describe, it, expect } from 'vitest';
import {
  bomDateStamp,
  bomToday,
  deliveryDetails,
  personName,
  usDate,
  usDatesInText,
} from '../../src/handoff/bomDelivery.js';
import { shipToPrintLines } from '../../src/handoff/bom.js';

/**
 * How the Bill of Materials prints dates, names and the ship-to block — the rules
 * every format (Excel, PDF, CSV, the browser's print fallback) shares.
 */

describe('usDate / usDatesInText', () => {
  it('prints a YYYY-MM-DD date as MM/DD/YYYY', () => {
    expect(usDate('2026-09-22')).toBe('09/22/2026');
    expect(usDate('2026-11-06')).toBe('11/06/2026');
  });

  it('leaves a blank, or anything that is not a bare date, as it is', () => {
    expect(usDate('')).toBe('');
    expect(usDate(null)).toBe('');
    expect(usDate('TBD')).toBe('TBD');
    expect(usDate('2026-09-22T12:00:00Z')).toBe('2026-09-22T12:00:00Z');
  });

  it('rewrites every date inside free text, and only dates', () => {
    expect(usDatesInText('Schedule delivery on or after 2026-11-06')).toBe(
      'Schedule delivery on or after 11/06/2026',
    );
    expect(usDatesInText('Between 2026-11-06 and 2026-11-13')).toBe(
      'Between 11/06/2026 and 11/13/2026',
    );
    expect(usDatesInText('Weekday mornings')).toBe('Weekday mornings');
    // A longer digit run is not a date and must not be clipped into one.
    expect(usDatesInText('PO 12026-11-061')).toBe('PO 12026-11-061');
  });

  it('never rewrites a part number, suite, order number or timestamp', () => {
    for (const v of [
      'Part 1234-56-78',
      'Suite 2026-01-15B',
      'SO-2026-000036',
      'Deliver 2026-11-06T10:00',
      'Code 2026-13-45',
      'Ref A2026-11-06',
      'Lot 2026-11-06-3',
      'Bin 2026-11-06_A',
      '2026-1-6',
    ])
      expect(usDatesInText(v), v).toBe(v);
    expect(usDatesInText('(2026-11-06), then 2026-11-13.')).toBe('(11/06/2026), then 11/13/2026.');
  });
});

describe('bomDateStamp', () => {
  it('stores a day at midday so every reader gets the same day back', () => {
    const d = bomDateStamp('2026-09-23');
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-23');
    expect(bomToday(d)).toBe('2026-09-23');
    // Standard time too.
    expect(bomToday(bomDateStamp('2026-12-01'))).toBe('2026-12-01');
  });

  it('confirming at 8:30 pm Mountain stamps TODAY, not tomorrow', () => {
    const evening = new Date('2026-09-24T02:30:00Z'); // 8:30 pm MDT, Sep 23
    expect(bomDateStamp(bomToday(evening)).toISOString().slice(0, 10)).toBe('2026-09-23');
  });
});

describe('bomToday', () => {
  it('is Summit’s (Mountain) date, not UTC’s', () => {
    // 8:30 pm MDT on Sep 23 is already Sep 24 in UTC.
    expect(bomToday(new Date('2026-09-24T02:30:00Z'))).toBe('2026-09-23');
    // 8:30 pm MST on Dec 1 (standard time, UTC-7).
    expect(bomToday(new Date('2026-12-02T03:30:00Z'))).toBe('2026-12-01');
    expect(bomToday(new Date('2026-09-23T18:00:00Z'))).toBe('2026-09-23');
  });
});

describe('personName', () => {
  it('capitalises a name typed entirely in lowercase', () => {
    expect(personName('kamilla eliezer')).toBe('Kamilla Eliezer');
    expect(personName("o'neil-smith")).toBe("O'Neil-Smith");
    expect(personName('  milton  ')).toBe('Milton');
    expect(personName('élodie ñuñez')).toBe('Élodie Ñuñez');
    expect(personName('josé garcía')).toBe('José García');
    expect(personName('łukasz')).toBe('Łukasz');
  });

  it('leaves an email, a placeholder or a number in the name box as typed', () => {
    expect(personName('kamilla@gmail.com')).toBe('kamilla@gmail.com');
    expect(personName('n/a')).toBe('n/a');
    expect(personName('call 303 555 1212')).toBe('call 303 555 1212');
  });

  it('leaves a lowercase name holding an accented capital as typed', () => {
    expect(personName('Álvaro díaz')).toBe('Álvaro díaz');
  });

  it('leaves any name with a capital letter exactly as typed', () => {
    expect(personName('McDonald')).toBe('McDonald');
    expect(personName('DeAndre jones')).toBe('DeAndre jones');
    expect(personName('KAMILLA')).toBe('KAMILLA');
    expect(personName('Jennifer Fattal')).toBe('Jennifer Fattal');
  });

  it('is applied to both points of contact on the sheet', () => {
    const d = deliveryDetails(null, {
      pocName: 'kamilla eliezer',
      pocPhone: null,
      pocEmail: null,
      preferredComm: null,
      textNumber: null,
      secondaryPocName: 'milton',
      secondaryPocPhone: null,
      secondaryPocEmail: null,
      secondaryPreferredComm: null,
      secondaryMobile: null,
      loadingDock: null,
      deliveryTiming: null,
      preferredDeliveryDate: null,
      specialInstructions: null,
    });
    expect(d.primary.name).toBe('Kamilla Eliezer');
    expect(d.secondary.name).toBe('Milton');
  });
});

describe('shipToPrintLines', () => {
  const site = {
    customerSite: true,
    lines: ['17233 Ventura Blvd', 'Encino, CA 91316'],
    contactName: 'Kamilla Eliezer',
    phone: '17708519515',
    email: 'studio@kamillaeliezer.com',
  };

  it('lays a customer site out as ATTN, street, city, PH — no email', () => {
    expect(shipToPrintLines(site)).toEqual([
      'ATTN: Kamilla Eliezer',
      '17233 Ventura Blvd',
      'Encino, CA 91316',
      'PH: (770) 851-9515',
    ]);
  });

  it('keeps every row in place when the contact or the address is blank', () => {
    expect(shipToPrintLines({ ...site, contactName: '', phone: '', lines: ['', ''] })).toEqual([
      '',
      '',
      '',
      '',
    ]);
  });

  it('prints a phone it cannot safely reformat exactly as typed', () => {
    expect(shipToPrintLines({ ...site, phone: '+44 20 7946 0958' })[3]).toBe(
      'PH: +44 20 7946 0958',
    );
    expect(shipToPrintLines({ ...site, phone: '303-748-8082 ext 12' })[3]).toBe(
      'PH: 303-748-8082 ext 12',
    );
  });

  it('keeps the email for a ship-to that is not the customer’s site', () => {
    expect(
      shipToPrintLines({
        customerSite: false,
        lines: ['6150 S Geneva Court', 'Englewood, CO 80111'],
        contactName: 'Bryan Shepherd',
        phone: '720-457-5500',
        email: 'Orders@SummitSensory.com',
      }),
    ).toEqual([
      'ATTN: Bryan Shepherd',
      '6150 S Geneva Court',
      'Englewood, CO 80111',
      'PH: (720) 457-5500',
      'Orders@SummitSensory.com',
    ]);
  });
});

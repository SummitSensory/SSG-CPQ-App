import { BOM_TIME_ZONE } from '../handoff/bomDelivery.js';

/**
 * Summit's business day.
 *
 * Summit works in Englewood, CO, so "which month was this deal signed in", "is this
 * invoice late yet" and "is this follow-up due today" are all questions about the
 * America/Denver calendar — the same zone the BOM already dates its sheets in
 * (BOM_TIME_ZONE). Answering them from the UTC calendar moved everything after about
 * 6 pm Mountain into the next day: October's last-evening signings were reported as
 * November, and an invoice showed overdue on the evening of its due date.
 *
 * Calendar dates (due dates, goal period starts, report from/to) are stored as UTC
 * midnight of that date and compared as YYYY-MM-DD strings; instants (acceptedAt,
 * createdAt, now) are converted to the Denver calendar day before comparing.
 */
export const BUSINESS_TIME_ZONE = BOM_TIME_ZONE;

const DAY_MS = 86_400_000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function wallClock(instant: Date): {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour') % 24,
    mi: get('minute'),
    s: get('second'),
  };
}

/** The Denver calendar day an instant falls on, as YYYY-MM-DD. */
export function businessDay(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return '';
  const w = wallClock(d);
  return `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** Today in Denver, as YYYY-MM-DD. */
export function businessToday(now: Date = new Date()): string {
  return businessDay(now);
}

/** Offset (local wall clock minus UTC) in ms at an instant. */
function offsetMs(instant: Date): number {
  const w = wallClock(instant);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant Denver's day `day` (YYYY-MM-DD) begins. */
export function startOfBusinessDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle the DST transitions: the offset at local midnight, not at UTC
  // midnight, is the one that applies.
  let t = guess - offsetMs(new Date(guess));
  t = guess - offsetMs(new Date(t));
  return new Date(t);
}

/** A YYYY-MM-DD plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole calendar days from day `a` to day `b` (YYYY-MM-DD), b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b.slice(0, 10)}T00:00:00.000Z`) -
      Date.parse(`${a.slice(0, 10)}T00:00:00.000Z`)) /
      DAY_MS,
  );
}

import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * The colours of the freight alert banner.
 *
 * The banner sits above every screen for as long as an invoice is short of freight,
 * which makes it the most-seen element in the application and the one most likely to
 * be wrong for a given office. A full-strength red reads as a system failure; too
 * pale and it stops being an alert. Where that line falls is a judgement about the
 * room, the monitors and the people, so it belongs to whoever runs the place rather
 * than to whoever wrote the CSS.
 *
 * Two states, each with its own pair, because they mean different things:
 *
 *   BILLED_SHORT    — the freight is known and the invoice does not have it. Money
 *                     Summit decided to charge and then did not.
 *   WILL_BILL_SHORT — an invoice is out and a bucket is still unanswered.
 *
 * Stored as text in UiSetting. Validated to a hex colour on the way in, because this
 * value is interpolated straight into a style attribute: anything else is either a
 * broken banner or an injection.
 */

export interface BannerTheme {
  /** Freight known and unbilled — the loud state. */
  shortBg: string;
  shortText: string;
  /** Invoice out, freight still outstanding. */
  pendingBg: string;
  pendingText: string;
}

export const BANNER_DEFAULTS: BannerTheme = {
  shortBg: '#fdecea',
  shortText: '#8c2b20',
  pendingBg: '#fdf6e6',
  pendingText: '#7a6318',
};

const KEYS: Record<keyof BannerTheme, string> = {
  shortBg: 'freight.banner.shortBg',
  shortText: 'freight.banner.shortText',
  pendingBg: 'freight.banner.pendingBg',
  pendingText: 'freight.banner.pendingText',
};

/**
 * Presets, so the common answer is one click rather than four hex codes.
 *
 * Deliberately few and deliberately named for what they are. A free colour picker on
 * an alert banner invites a pale yellow on white that nobody can read.
 */
export const BANNER_PRESETS: Array<{ id: string; label: string; theme: BannerTheme }> = [
  {
    id: 'light',
    label: 'Light red',
    theme: BANNER_DEFAULTS,
  },
  {
    id: 'bold',
    label: 'Solid red',
    theme: {
      shortBg: '#8c2b20',
      shortText: '#ffffff',
      pendingBg: '#7a6318',
      pendingText: '#ffffff',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    theme: {
      shortBg: '#eceff1',
      shortText: '#37474f',
      pendingBg: '#f5f2e8',
      pendingText: '#5d5335',
    },
  },
  {
    id: 'amber',
    label: 'Amber',
    theme: {
      shortBg: '#fff4e0',
      shortText: '#8a5300',
      pendingBg: '#fdf6e6',
      pendingText: '#7a6318',
    },
  },
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function assertHex(value: unknown, what: string): string {
  const text = String(value ?? '').trim();
  if (!HEX.test(text)) {
    throw new ValidationError(
      `${what} must be a hex colour like #fdecea. "${text}" is not one, and this value is written straight into the page.`,
    );
  }
  return text.toLowerCase();
}

/** The banner's colours, falling back per field so a half-set row still works. */
export async function loadBannerTheme(): Promise<BannerTheme> {
  const rows = await prisma.uiSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...BANNER_DEFAULTS };
  for (const field of Object.keys(KEYS) as Array<keyof BannerTheme>) {
    const held = byKey.get(KEYS[field]);
    if (held && HEX.test(held)) out[field] = held;
  }
  return out;
}

/**
 * Save whichever fields were sent.
 *
 * A patch rather than a replace: the admin form sends one pair at a time when
 * somebody is adjusting only the loud state, and overwriting the other pair with
 * defaults would be a surprise.
 */
export async function saveBannerTheme(
  patch: Partial<BannerTheme>,
  actorId: string,
): Promise<BannerTheme> {
  const writes: Array<{ key: string; value: string }> = [];
  for (const field of Object.keys(KEYS) as Array<keyof BannerTheme>) {
    if (patch[field] === undefined) continue;
    writes.push({ key: KEYS[field], value: assertHex(patch[field], field) });
  }
  if (!writes.length) throw new ValidationError('Nothing to save — no colours were sent.');

  await prisma.$transaction(
    writes.map((w) =>
      prisma.uiSetting.upsert({
        where: { key: w.key },
        create: { key: w.key, value: w.value, updatedById: actorId },
        update: { value: w.value, updatedById: actorId, updatedAt: new Date() },
      }),
    ),
  );
  await recordAudit({
    actorId,
    action: 'freight.banner.theme',
    entity: 'UiSetting',
    entityId: 'freight.banner',
    details: Object.fromEntries(writes.map((w) => [w.key, w.value])),
  });
  return loadBannerTheme();
}

/** Put it back to what shipped. */
export async function resetBannerTheme(actorId: string): Promise<BannerTheme> {
  await prisma.uiSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
  await recordAudit({
    actorId,
    action: 'freight.banner.theme.reset',
    entity: 'UiSetting',
    entityId: 'freight.banner',
    details: {},
  });
  return BANNER_DEFAULTS;
}

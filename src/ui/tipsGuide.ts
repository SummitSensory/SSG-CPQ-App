import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * The Tips & Tricks guide — the name, title and photo shown on the page-by-page
 * help bubble (public/tips-and-tricks.js).
 *
 * Deliberately swappable without a deploy: the person in the photo today may not
 * be the person doing this job in a year, and re-shipping code to change a JPEG
 * would be a strange reason to touch the application. Stored in UiSetting, the
 * same table and the same read-with-fallback / patch-only-what-changed shape as
 * src/ui/bannerTheme.ts.
 *
 * The photo is a data URI rather than an uploaded file with a URL, matching
 * User.signatureImage rather than the Vercel Blob file store: a few hundred KB
 * of headshot does not justify a second storage dependency when the row already
 * has to hold text.
 */

export interface TipsGuideProfile {
  name: string;
  title: string;
  /** PNG/JPEG data URI, or null if nobody has set one yet — the widget falls
   *  back to the guide's initials, the same fallback the sidebar avatar uses. */
  avatarImage: string | null;
}

export const TIPS_GUIDE_DEFAULTS: TipsGuideProfile = {
  name: 'Bryan',
  title: 'Founder',
  avatarImage: null,
};

const KEYS: Record<keyof TipsGuideProfile, string> = {
  name: 'tips.guide.name',
  title: 'tips.guide.title',
  avatarImage: 'tips.guide.avatar',
};

/**
 * 400 KB encoded, the same cap as User.signatureImage. A photo compressed to the
 * ~480px this renders at comfortably clears this with room to spare; the cap
 * exists so a full-resolution phone photo pasted in by mistake fails loudly
 * instead of bloating the row.
 */
const AVATAR_MAX_CHARS = 400_000;
const AvatarImage = z
  .string()
  .trim()
  .max(AVATAR_MAX_CHARS, 'That image is too large — use one under about 300 KB.')
  .refine(
    (v) => /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v),
    'The photo must be a PNG or JPEG image.',
  );

const NAME_MAX = 80;
const TITLE_MAX = 80;

export const TipsGuidePatch = z.object({
  name: z.string().trim().min(1).max(NAME_MAX).optional(),
  title: z.string().trim().max(TITLE_MAX).optional(),
  /** A data URI to set it, an empty string or null to remove it. */
  avatarImage: z.union([AvatarImage, z.literal(''), z.null()]).optional(),
});
export type TipsGuidePatchInput = z.infer<typeof TipsGuidePatch>;

/** The guide's profile, falling back per field so a half-set row still works. */
export async function loadTipsGuideProfile(): Promise<TipsGuideProfile> {
  const rows = await prisma.uiSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: TipsGuideProfile = { ...TIPS_GUIDE_DEFAULTS };
  const name = byKey.get(KEYS.name);
  if (name) out.name = name;
  const title = byKey.get(KEYS.title);
  if (title !== undefined) out.title = title;
  const avatar = byKey.get(KEYS.avatarImage);
  if (avatar) out.avatarImage = avatar;
  return out;
}

/** Save whichever fields were sent — a patch, not a replace, same reasoning as
 *  saveBannerTheme: changing the photo should never blank out the title. */
export async function saveTipsGuideProfile(
  patch: TipsGuidePatchInput,
  actorId: string,
): Promise<TipsGuideProfile> {
  const writes: Array<{ key: string; value: string }> = [];
  if (patch.name !== undefined) writes.push({ key: KEYS.name, value: patch.name });
  if (patch.title !== undefined) writes.push({ key: KEYS.title, value: patch.title });
  if (patch.avatarImage !== undefined) {
    writes.push({ key: KEYS.avatarImage, value: patch.avatarImage || '' });
  }
  if (!writes.length) throw new ValidationError('Nothing to save.');

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
    action: 'tips.guide',
    entity: 'UiSetting',
    entityId: 'tips.guide',
    details: Object.fromEntries(
      writes.map((w) => [w.key, w.key === KEYS.avatarImage ? '(image)' : w.value]),
    ),
  });
  return loadTipsGuideProfile();
}

/** Put it back to what shipped. */
export async function resetTipsGuideProfile(actorId: string): Promise<TipsGuideProfile> {
  await prisma.uiSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
  await recordAudit({
    actorId,
    action: 'tips.guide.reset',
    entity: 'UiSetting',
    entityId: 'tips.guide',
    details: {},
  });
  return TIPS_GUIDE_DEFAULTS;
}

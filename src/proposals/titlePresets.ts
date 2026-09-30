import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ConflictError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';

/**
 * Prebuilt proposal titles — the dropdown on the New proposal form.
 *
 * Edited under Administration → Proposal content → Proposal titles, not in code: the
 * titles a team writes change as the product lines do, and shipping a deploy to add
 * one is the wrong reason to touch the application. A rep can always type their own
 * instead; the list only saves them retyping the common ones.
 *
 * One UiSetting JSON document, the same storage as the order-locked recipients and
 * the banner theme: a short ordered list nothing queries across, so no migration.
 * The array order is the order the dropdown shows. A retired title is kept, marked
 * inactive, rather than deleted, so re-enabling it is one click; deleting is still
 * possible for a typo.
 */
export const TITLE_PRESETS_KEY = 'proposal.titlePresets';

export const TitlePreset = z.object({
  id: z.string().trim().min(1).max(40),
  title: z
    .string()
    .trim()
    .min(2, 'A proposal title needs at least 2 characters.')
    .max(200, 'Keep a proposal title under 200 characters.'),
  active: z.boolean().default(true),
});
export type TitlePresetT = z.infer<typeof TitlePreset>;

const Stored = z.object({ titles: z.array(TitlePreset).max(500).default([]) });

export interface TitlePresetList {
  titles: TitlePresetT[];
  /** The stored row's updatedAt, echoed back on save so a stale editor is refused. */
  version: string | null;
}

export async function loadTitlePresets(): Promise<TitlePresetList> {
  const row = await prisma.uiSetting.findUnique({ where: { key: TITLE_PRESETS_KEY } });
  if (!row) return { titles: [], version: null };
  try {
    return {
      titles: Stored.parse(JSON.parse(row.value)).titles,
      version: row.updatedAt.toISOString(),
    };
  } catch {
    // A malformed document must not take the New proposal form down with it.
    return { titles: [], version: row.updatedAt.toISOString() };
  }
}

export const TitlePresetSave = z.object({
  titles: z.array(TitlePreset).max(500),
  version: z.string().nullable(),
});

/**
 * Replace the whole list, claimed on the version the editor loaded — two
 * administrators editing at once must not silently erase each other's titles.
 * Duplicate titles (ignoring case and spacing) are dropped, keeping the first.
 */
export async function saveTitlePresets(
  input: z.infer<typeof TitlePresetSave>,
  actorId: string,
): Promise<TitlePresetList> {
  const seen = new Set<string>();
  const ids = new Set<string>();
  const titles = input.titles.filter((t) => {
    const key = t.title.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key) || ids.has(t.id)) return false;
    seen.add(key);
    ids.add(t.id);
    return true;
  });
  const value = JSON.stringify(Stored.parse({ titles }));
  const stale = () =>
    new ConflictError('Someone else just changed the proposal titles. Reload and try again.');

  if (input.version === null) {
    try {
      await prisma.uiSetting.create({
        data: { key: TITLE_PRESETS_KEY, value, updatedById: actorId },
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') throw stale();
      throw err;
    }
  } else {
    const claim = await prisma.uiSetting.updateMany({
      where: { key: TITLE_PRESETS_KEY, updatedAt: new Date(input.version) },
      data: { value, updatedById: actorId },
    });
    if (claim.count !== 1) throw stale();
  }

  await recordAudit({
    actorId,
    action: 'proposal.titlePresets.save',
    entity: 'UiSetting',
    entityId: TITLE_PRESETS_KEY,
    details: { count: titles.length, active: titles.filter((t) => t.active).length },
  });
  return loadTitlePresets();
}

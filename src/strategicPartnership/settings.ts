/**
 * The Strategic Partnership settings row: which Canva brand template is the master,
 * and the copy its text fields are filled with. Unsaved means the shipped defaults.
 */
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { MAX_CENTERS_PER_YEAR } from './calculate.js';
import { type PartnershipContent, defaultContent, unknownTokens } from './copy.js';

export interface PartnershipSettings {
  brandTemplateId: string | null;
  content: PartnershipContent;
  version: number;
  updatedAt: string | null;
  /** True while nothing has been saved and the defaults are in force. */
  isDefault: boolean;
}

/** Canva data field names are author-chosen; keep them to a printable, bounded set. */
const FIELD_NAME = /^[A-Za-z0-9_\- ]{1,100}$/;

export const ContentSchema = z.object({
  titleTemplate: z.string().trim().min(1).max(300),
  scaleCenters: z.array(z.number().int().min(1).max(MAX_CENTERS_PER_YEAR)).min(1).max(8),
  chartField: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => (v ? v : null)),
  fields: z
    .array(
      z.object({
        field: z
          .string()
          .trim()
          .regex(FIELD_NAME, 'A field name is letters, digits, _, - or spaces.'),
        template: z.string().max(5000),
      }),
    )
    .max(200),
});

export const SettingsBody = z.object({
  brandTemplateId: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => (v ? v : null)),
  content: ContentSchema,
});

/** Parse and check stored or submitted content. Throws ValidationError. */
export function validateContent(raw: unknown): PartnershipContent {
  const parsed = ContentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'These settings are not valid.');
  }
  const c = parsed.data;
  const templates = [c.titleTemplate, ...c.fields.map((f) => f.template)];
  const bad = [...new Set(templates.flatMap(unknownTokens))];
  if (bad.length) {
    throw new ValidationError(
      `Unknown placeholder${bad.length > 1 ? 's' : ''}: ${bad.map((b) => `{{${b}}}`).join(', ')}.`,
    );
  }
  const names = c.fields.map((f) => f.field);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new ValidationError(`The field ${dup} is listed twice.`);
  return {
    titleTemplate: c.titleTemplate,
    scaleCenters: c.scaleCenters,
    chartField: c.chartField,
    fields: c.fields,
  };
}

export async function getPartnershipSettings(): Promise<PartnershipSettings> {
  const row = await prisma.strategicPartnershipSettings.findUnique({ where: { key: 'default' } });
  if (!row) {
    return {
      brandTemplateId: null,
      content: defaultContent(),
      version: 0,
      updatedAt: null,
      isDefault: true,
    };
  }
  let content: PartnershipContent;
  try {
    content = validateContent(row.content);
  } catch {
    // A row that no longer validates (hand-edited, or a token since removed) must not
    // take the screen down; fall back to the defaults and let the editor show it.
    content = defaultContent();
  }
  return {
    brandTemplateId: row.brandTemplateId,
    content,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    isDefault: false,
  };
}

export async function savePartnershipSettings(
  raw: unknown,
  actorId: string,
): Promise<PartnershipSettings> {
  const parsed = SettingsBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'These settings are not valid.');
  }
  const content = validateContent(parsed.data.content);
  const before = await prisma.strategicPartnershipSettings.findUnique({
    where: { key: 'default' },
  });
  const json = content as unknown as Prisma.InputJsonValue;
  await prisma.strategicPartnershipSettings.upsert({
    where: { key: 'default' },
    create: {
      key: 'default',
      brandTemplateId: parsed.data.brandTemplateId,
      content: json,
      version: 1,
      updatedById: actorId,
    },
    update: {
      brandTemplateId: parsed.data.brandTemplateId,
      content: json,
      version: (before?.version ?? 0) + 1,
      updatedById: actorId,
    },
  });
  return getPartnershipSettings();
}

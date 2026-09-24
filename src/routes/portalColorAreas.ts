import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { ValidationError } from '../lib/errors.js';
import { AREA_KEY_RE } from '../portal/colorAreas.js';
import { listColorAreas, saveColorArea } from '../portal/colorAreaMapping.js';

/**
 * Administration → Orders → Portal colour areas.
 *
 * Which catalog parts each portal colour area paints — what turns a customer's
 * "legs: Cardinal T009-BL01" into a colour on the right Bill of Materials lines when
 * staff mark the colour step reviewed.
 *
 * PRODUCTS_ADMIN, both ways: this is a statement about the catalog (which parts
 * make up the legs), maintained by whoever maintains the catalog and the vendor
 * colour charts — the same permission as Administration → Manufacturers → Colours
 * and the powder brand list. Reading is held as tightly as writing because the
 * screen shows customers' answers across every order, which nothing outside
 * Administration needs.
 */

// `parts` carries an optional piece per part; `skus` (bare part numbers) is still
// accepted from an older screen.
const PartBody = z.object({
  sku: z.string().trim().min(1).max(80),
  piece: z.number().int().min(1).max(20).nullable().optional(),
});
const SaveBody = z
  .object({
    parts: z.array(PartBody).max(500).optional(),
    skus: z.array(z.string().trim().max(80)).max(500).optional(),
  })
  .refine((b) => b.parts !== undefined || b.skus !== undefined, 'parts is required');

const Params = z.object({
  areaKey: z
    .string()
    .trim()
    .max(160)
    .regex(AREA_KEY_RE, 'Area keys look like structure_frame_paint.legs'),
});

export function registerPortalColorAreaRoutes(app: FastifyInstance): void {
  const admin = { preHandler: requirePermission(Permission.PRODUCTS_ADMIN) };

  app.get('/admin/portal-color-areas', admin, async () => ({ areas: await listColorAreas() }));

  app.put('/admin/portal-color-areas/:areaKey', admin, async (req) => {
    const params = Params.safeParse(req.params);
    if (!params.success)
      throw new ValidationError(params.error.issues[0]?.message ?? 'Invalid area');
    const body = SaveBody.safeParse(req.body);
    if (!body.success)
      throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid part list');
    return saveColorArea(
      params.data.areaKey,
      body.data.parts ?? body.data.skus ?? [],
      req.user!.sub,
    );
  });
}

/**
 * Every colour area the Customer-Portal can write, frozen from its source
 * (Customer-Portal lib/colorRequirements.js allKnownInputParts() and ALLOWED_BRANDS),
 * plus the vinyl names it offers (lib/data/vinylColors.json — the vinyl "code" IS
 * the name).
 *
 * The CRM does not need this list to work — Administration → Portal colour areas
 * builds its list from the answers on record — so it is used only to CHECK: the
 * colour-ingestion audit test cross-checks it against a local portal checkout, and
 * `pnpm db:report:color-coverage` reports which of these areas have no parts mapped.
 * ball_pit_balls has no parts (no picker yet) so it can never appear in an answer.
 */
export const KNOWN_PORTAL_AREAS: Readonly<Record<string, { brands: string[]; parts: string[] }>> = {
  structure_frame_paint: {
    brands: ['cardinal', 'prismatic'],
    parts: ['legs', 'horizontal_beams', 'ladder_rungs_and_leg', 'soar_frame', 'flex_frame'],
  },
  climbing_wall_color: { brands: ['cardinal', 'prismatic'], parts: ['climbing_wall'] },
  mat_pad_color: { brands: ['vinyl'], parts: ['mat_pad'] },
  adventure_mat: { brands: ['vinyl'], parts: ['adventure_mat_system', 'zip_line'] },
  wall_padding_mat: { brands: ['vinyl'], parts: ['column_wraps_pads'] },
  climbing_wall_mat: { brands: ['vinyl'], parts: ['climbing_wall_mat'] },
  soar_mat: { brands: ['vinyl'], parts: ['column_wraps', 'floor_padding'] },
  flex_mat: { brands: ['vinyl'], parts: ['floor_pad'] },
  palisades_mat: {
    brands: ['vinyl'],
    parts: [1, 2, 3, 4, 5, 6, 7].map((n) => `palisades_mat_${n}`),
  },
  ball_pit: {
    brands: ['vinyl'],
    parts: ['ball_pit_vinyl', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `mat_section_${n}`)],
  },
  slide_platform_paint: { brands: ['cardinal', 'prismatic'], parts: ['slide_platform'] },
  slide: { brands: ['plastic'], parts: ['slide_color', 'slide_platform'] },
  climb_slide_mat: {
    brands: ['vinyl'],
    parts: ['climb_slide_piece_1', 'climb_slide_piece_2', 'climb_slide_piece_3'],
  },
  soft_steps_2_mat: { brands: ['vinyl'], parts: ['soft_steps_2', 'soft_steps_2_piece_2'] },
  soft_steps_3_mat: { brands: ['vinyl'], parts: ['soft_steps_3', 'soft_steps_3_piece_2'] },
  foundation_mat: { brands: ['foundation'], parts: ['foundation_mat'] },
};

/**
 * Areas the portal no longer asks for — Customer-Portal lib/colorRequirements.js
 * RETIRED_PARTS, from the 2026-09-23 layout change (Zip Line → Adventure Mat System,
 * plastic slide platform → painted slide_platform_paint.slide_platform, 7 Ball Pit
 * mat sections → ball_pit.ball_pit_vinyl). Still in KNOWN_PORTAL_AREAS because a
 * customer's earlier picks under them are kept, but nothing needs mapping for them.
 */
export const RETIRED_PORTAL_AREAS: ReadonlySet<string> = new Set([
  'adventure_mat.zip_line',
  'slide.slide_platform',
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => `ball_pit.mat_section_${n}`),
]);

/** Every "<group>.<area>" key in KNOWN_PORTAL_AREAS (40 of them). */
export function knownAreaKeys(): string[] {
  return Object.entries(KNOWN_PORTAL_AREAS).flatMap(([input, { parts }]) =>
    parts.map((p) => `${input}.${p}`),
  );
}

/** The 14 vinyl names the portal offers. */
export const PORTAL_VINYL_NAMES: readonly string[] = [
  'Black',
  'Charcoal',
  'Kelly Green',
  'Light Gray',
  'Lime',
  'Navy',
  'Orange',
  'Pink',
  'Purple',
  'Red',
  'Royal Blue',
  'Tan',
  'White',
  'Yellow',
];

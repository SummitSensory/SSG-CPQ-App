/**
 * Dimension line formatting for proposal output.
 *
 * Order is always L x W x H x T. Inch marks precede the axis letter
 * ( `72"L` ), null axes are skipped entirely, and trailing zeros are
 * trimmed so 72.0 renders as 72. Products whose dimension line cannot be
 * expressed as four axes (U-profile mats needing five values, radii, etc.)
 * carry a free-text `dimensionsOverride` which wins outright.
 */

export type DimensionAxis = 'L' | 'W' | 'H' | 'T';

export interface DimensionInput {
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  thicknessIn?: number | null;
  dimensionsOverride?: string | null;
  showDimensions?: boolean | null;
}

const AXIS_ORDER: ReadonlyArray<[DimensionAxis, keyof DimensionInput]> = [
  ['L', 'lengthIn'],
  ['W', 'widthIn'],
  ['H', 'heightIn'],
  ['T', 'thicknessIn'],
];

/** Trim trailing zeros: 72 -> "72", 1.50 -> "1.5", 0.125 -> "0.125". */
export function formatMeasure(value: number): string {
  if (!Number.isFinite(value)) return '';
  // toFixed(3) then strip so floats never render as 1.4999999999999998.
  const fixed = value.toFixed(3);
  return fixed.replace(/\.?0+$/, '');
}

/** One axis segment, e.g. `72"L`. Returns null for absent/invalid values. */
export function formatAxis(value: number | null | undefined, axis: DimensionAxis): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  const measure = formatMeasure(value);
  if (measure === '' || measure === '0') return null;
  return `${measure}"${axis}`;
}

/**
 * Build the dimension line for a product.
 * Returns null when there is nothing to show — callers should omit the line
 * entirely rather than printing an empty string.
 */
export function formatDimensions(input: DimensionInput): string | null {
  if (input.showDimensions === false) return null;

  const override = input.dimensionsOverride?.trim();
  if (override) return override;

  const segments: string[] = [];
  for (const [axis, key] of AXIS_ORDER) {
    const seg = formatAxis(input[key] as number | null | undefined, axis);
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join(' x ');
}

/**
 * Whether a product has any dimension data at all — used by the admin UI to
 * decide if the `showDimensions` toggle is meaningful.
 */
export function hasDimensions(input: DimensionInput): boolean {
  if (input.dimensionsOverride?.trim()) return true;
  return AXIS_ORDER.some(([axis, key]) => formatAxis(input[key] as number | null | undefined, axis) !== null);
}

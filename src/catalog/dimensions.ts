/**
 * Shared dimension-string formatting for products, used by both the API
 * (product-line tree endpoint) and reused verbatim by the UI, which only
 * displays the string the API already computed.
 */

type Axis = number | string | { toString(): string } | null | undefined;

export interface DimensionInput {
  lengthIn?: Axis;
  widthIn?: Axis;
  heightIn?: Axis;
  thicknessIn?: Axis;
  dimensionsOverride?: string | null;
}

type AxisKey = 'lengthIn' | 'widthIn' | 'heightIn' | 'thicknessIn';

// Build order: Length, Width, Height, Thickness. Only mats carry thickness —
// every other product simply has no T term and no trailing separator.
const AXES: Array<{ key: AxisKey; suffix: string }> = [
  { key: 'lengthIn', suffix: 'L' },
  { key: 'widthIn', suffix: 'W' },
  { key: 'heightIn', suffix: 'H' },
  { key: 'thicknessIn', suffix: 'T' },
];

/** "48.000" -> "48", "3.50" -> "3.5", "4.875" -> "4.875". */
function trimTrailingZeros(value: number | string): string {
  const s = typeof value === 'number' ? value.toString() : value;
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Formats a product's dimensions as "3.5"L × 4.875"W × 67"H × 1.375"T",
 * skipping any null axis and its separator. If dimensionsOverride is set and
 * non-empty, that verbatim string is returned instead (covers shapes the
 * L/W/H/T formula can't express, e.g. five-value U-profile mats).
 */
export function formatDimensions(input: DimensionInput): string {
  if (input.dimensionsOverride && input.dimensionsOverride.trim() !== '') {
    return input.dimensionsOverride;
  }
  const parts: string[] = [];
  for (const axis of AXES) {
    const raw = input[axis.key];
    if (raw == null) continue;
    const num = typeof raw === 'number' || typeof raw === 'string' ? raw : raw.toString();
    parts.push(`${trimTrailingZeros(num)}"${axis.suffix}`);
  }
  return parts.join(' × ');
}

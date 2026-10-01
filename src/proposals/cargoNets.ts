/**
 * Which climbing cargo net a Summit Adventure frame takes.
 *
 * Its own module because both the proposal engine (adventureSeries.ts) and the frame
 * formula rules (frameRules.ts) need it, and adventureSeries already imports
 * frameRules.
 */

export const CARGO_NET_10X8_PART = 'B07V3J9S2R';
export const CARGO_NET_8X8_PART = 'B09NNFJLGY';
export const CARGO_NET_8X6_PART = 'B07TSDMPNQ';
/** Every net the builder can propose, largest first. */
export const CARGO_NET_PARTS = [CARGO_NET_10X8_PART, CARGO_NET_8X8_PART, CARGO_NET_8X6_PART];

/** The answers the net depends on. */
export interface CargoNetAnswers {
  width?: number;
  ladders?: number;
  cargoNet?: boolean;
  /** How many nets. Present on every proposal built since the frame rule. */
  cargoNetQty?: number;
  /** The rep's pick, used only where no rule covers the frame (wider than 10'). */
  cargoNetPart?: string;
  /** Answers from before the rule, when the rep ticked a size by hand. */
  cargoNet10x8?: boolean;
  cargoNet10x8Qty?: number;
  cargoNet8x6?: boolean;
  cargoNet8x6Qty?: number;
}

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * The cargo net that fits the frame, by its width (the short side) and whether it
 * has a ladder. A ladder takes up part of the bay the net hangs in, so a frame with
 * one takes the next net down:
 *
 *   width 9' or 10', no ladder   → B07V3J9S2R (10' x 8')
 *   width 9' or 10', ladder(s)   → B09NNFJLGY (8' x 8')
 *   width 8' or less, no ladder  → B09NNFJLGY (8' x 8')
 *   width 8' or less, ladder(s)  → B07TSDMPNQ (8' x 6')
 *
 * Null for a frame wider than 10': no rule covers it, and the rep picks the net.
 */
export function cargoNetForFrame(
  width: number | undefined,
  ladders: number | undefined,
): string | null {
  const w = num(width);
  const hasLadder = num(ladders) >= 1;
  if (w <= 0 || w > 10) return null;
  if (w > 8) return hasLadder ? CARGO_NET_8X8_PART : CARGO_NET_10X8_PART;
  return hasLadder ? CARGO_NET_8X6_PART : CARGO_NET_8X8_PART;
}

/**
 * A proposal saved before the frame rule carries the hand-ticked sizes and no
 * `cargoNetQty`. It is priced exactly as it was quoted.
 */
export function isLegacyCargoNet(a: CargoNetAnswers): boolean {
  return a.cargoNetQty === undefined && !!(a.cargoNet10x8 || a.cargoNet8x6);
}

/** The net the job takes: the frame's, else the rep's pick for a frame no rule covers. */
export function cargoNetPartFor(a: CargoNetAnswers): string | null {
  const ruled = cargoNetForFrame(a.width, a.ladders);
  if (ruled) return ruled;
  return a.cargoNetPart && CARGO_NET_PARTS.includes(a.cargoNetPart) ? a.cargoNetPart : null;
}

/** Every cargo-net line on the job, with its quantity. */
export function cargoNetLines(a: CargoNetAnswers): Array<{ part: string; qty: number }> {
  if (!a.cargoNet) return [];
  if (isLegacyCargoNet(a)) {
    const out: Array<{ part: string; qty: number }> = [];
    if (a.cargoNet10x8)
      out.push({ part: CARGO_NET_10X8_PART, qty: Math.max(1, num(a.cargoNet10x8Qty) || 1) });
    if (a.cargoNet8x6)
      out.push({ part: CARGO_NET_8X6_PART, qty: Math.max(1, num(a.cargoNet8x6Qty) || 1) });
    return out;
  }
  const part = cargoNetPartFor(a);
  if (!part) return [];
  return [{ part, qty: Math.max(1, Math.floor(num(a.cargoNetQty)) || 1) }];
}

/** Quantity of one net part on the job (0 when it is not the one). */
export function cargoNetQtyOf(a: CargoNetAnswers, part: string): number {
  return cargoNetLines(a)
    .filter((l) => l.part === part)
    .reduce((s, l) => s + l.qty, 0);
}

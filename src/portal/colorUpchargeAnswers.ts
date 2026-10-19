/**
 * The Prismatic upcharge the customer agreed to, read out of the portal's colour
 * answers. Pure and dependency-free so the portal refresh (orderPortal.ts) and the
 * QuickBooks side (integrations/quickbooks/colorUpcharge.ts) read it the same way
 * without one importing the other.
 *
 * The portal stores `{ selections, totalUpcharge, confirmedAt }` in the Manufacturing
 * board's "Portal: Color Selection Answers (JSON)" column, totalUpcharge in dollars
 * ($500 for the first Prismatic colour, $300 for each further one).
 */

export interface PortalUpcharge {
  /** The customer pressed Confirm in the portal (drafts are never billed). */
  confirmed: boolean;
  confirmedAt: string | null;
  /** Null when there is no readable figure. */
  totalMinor: bigint | null;
  /** Distinct Prismatic colours picked — printed on the invoice row. */
  prismaticColors: number;
}

/** The largest upcharge treated as real; anything above is a bad read, not a price. */
const MAX_UPCHARGE_MINOR = 10_000_000n; // $100,000

export function upchargeFromAnswers(answers: unknown): PortalUpcharge {
  const none: PortalUpcharge = {
    confirmed: false,
    confirmedAt: null,
    totalMinor: null,
    prismaticColors: 0,
  };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return none;
  const a = answers as { totalUpcharge?: unknown; confirmedAt?: unknown; selections?: unknown };
  const confirmedAt =
    typeof a.confirmedAt === 'string' && a.confirmedAt.trim() ? a.confirmedAt : null;

  let totalMinor: bigint | null = null;
  if (
    typeof a.totalUpcharge === 'number' &&
    Number.isFinite(a.totalUpcharge) &&
    a.totalUpcharge >= 0
  ) {
    const minor = BigInt(Math.round(a.totalUpcharge * 100));
    if (minor <= MAX_UPCHARGE_MINOR) totalMinor = minor;
  }

  const codes = new Set<string>();
  if (a.selections && typeof a.selections === 'object') {
    for (const parts of Object.values(a.selections as Record<string, unknown>)) {
      if (!parts || typeof parts !== 'object') continue;
      for (const pick of Object.values(parts as Record<string, unknown>)) {
        const p = pick as { brand?: unknown; code?: unknown } | null;
        if (p && p.brand === 'prismatic' && typeof p.code === 'string') codes.add(p.code);
      }
    }
  }
  return { confirmed: !!confirmedAt, confirmedAt, totalMinor, prismaticColors: codes.size };
}

/** A confirmed upcharge on a monday row the CRM could not match to an order. */
export interface UnlinkedUpcharge {
  mondayItemId: string;
  name: string;
  totalMinor: string;
  confirmedAt: string | null;
}

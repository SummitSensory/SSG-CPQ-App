import type { OpportunityStage } from '@prisma/client';

/**
 * Column-id mapping for the monday "deal tracking" board. monday column ids are
 * board-specific; override via env if they differ from these defaults.
 */
export const COLUMN = {
  stage: 'status',
  fundingStatus: 'status_1',
  budget: 'numbers',
  organization: 'text',
} as const;

/** Local stage → monday status label. */
export const STAGE_TO_STATUS: Record<OpportunityStage, string> = {
  PROSPECT: 'Prospect',
  QUALIFICATION: 'Qualification',
  NEEDS_ANALYSIS: 'Needs Analysis',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  CLOSED_WON: 'Won',
  CLOSED_LOST: 'Lost',
};

export const STATUS_TO_STAGE: Record<string, OpportunityStage> = Object.fromEntries(
  Object.entries(STAGE_TO_STATUS).map(([k, v]) => [v, k as OpportunityStage]),
) as Record<string, OpportunityStage>;

export interface SyncableOpportunity {
  name: string;
  stage: OpportunityStage;
  fundingStatus: string;
  budgetAmountMinor: bigint | null;
  budgetCurrency: string | null;
}

/** Build monday column values from a local opportunity. Money is dollars from integer minor units — no float math on storage. */
export function toColumnValues(opp: SyncableOpportunity): Record<string, unknown> {
  const cols: Record<string, unknown> = {
    [COLUMN.stage]: { label: STAGE_TO_STATUS[opp.stage] },
    [COLUMN.fundingStatus]: { label: opp.fundingStatus },
  };
  if (opp.budgetAmountMinor != null) {
    // Present as a decimal string built from integer minor units.
    const minor = opp.budgetAmountMinor;
    const whole = minor / 100n;
    const frac = (minor % 100n).toString().padStart(2, '0');
    cols[COLUMN.budget] = `${whole}.${frac}`;
  }
  return cols;
}

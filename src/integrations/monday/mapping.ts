import type { OpportunityStage } from '@prisma/client';
import { DEAL_COL } from './crmMapping.js';

/**
 * Column-id mapping for the monday "Deal Tracking" board (6527740233).
 *
 * `stage` is sourced from crmMapping.ts's `DEAL_COL`, whose ids were read off the
 * live board rather than assumed (see that file's own header comment) — this file
 * used to hardcode its own, different value ('status') here, which disagreed with
 * DEAL_COL.stage ('deal_stage') and, being unverified, was very likely wrong.
 *
 * `fundingStatus` and `budget` have no verified equivalent in DEAL_COL and could
 * not be confirmed against the live board from code alone (no MONDAY_API_TOKEN in
 * this environment) — left as originally scaffolded rather than guessed at a
 * different id, which risks silently writing to an unrelated real column. Confirm
 * both against the live board (GET /integrations/monday/boards/6527740233) before
 * relying on them.
 */
export const COLUMN = {
  stage: DEAL_COL.stage,
  fundingStatus: 'status_1',
  budget: 'numbers',
} as const;

/**
 * Local stage → monday status label.
 *
 * UNVERIFIED against the live board: crmMapping.ts's own `toStage()` (the inbound
 * counterpart of this same Deal Phase column) matches on free-form keywords rather
 * than an exact label list, with the comment "Deal Phase is a free-form status
 * column that changes as the sales process changes" — meaning the board's real
 * labels likely do not exactly match these 7 fixed strings. An outbound write here
 * (STAGE_TO_STATUS[stage]) can silently fail to match any real option, and an
 * inbound label (STATUS_TO_STAGE[label]) can silently fail to match any of these
 * keys. Confirm the board's actual Deal Phase options before trusting this table.
 */
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

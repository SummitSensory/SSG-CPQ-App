/**
 * When a proposal was decided — ONE rule, shared by the Reports screen
 * (GET /reports/proposals, proposals/analytics.ts) and the Insights report builder
 * (reporting/dataset.ts, "Decision" date basis).
 *
 * The two used to disagree: Reports took the latest decision on the CURRENT version,
 * Insights the earliest decision on ANY version. A proposal rejected, revised and
 * then won was dated by its rejection in Insights and by its win in Reports, so the
 * same month showed different won/lost figures on the two screens.
 *
 * The rule: the decision date is the most recent move to ACCEPTED, REJECTED or
 * EXPIRED in the current (latest) version's history. It is the decision behind the
 * status the proposal shows today, which is the status every won/lost/win-rate figure
 * is computed from. A current version that has not been decided has no decision
 * date, even if an earlier version was decided — that earlier outcome was superseded.
 *
 * (Acceptance is a different question — "when did we first win this" — and keeps its
 * own rule in dataset.ts: the earliest ACCEPTED on any version.)
 */
export const DECISION_STATUSES: readonly string[] = ['ACCEPTED', 'REJECTED', 'EXPIRED'];

export function decisionDate(
  currentVersionHistory: ReadonlyArray<{ toStatus: string; createdAt: Date }>,
): Date | null {
  let latest: Date | null = null;
  for (const e of currentVersionHistory) {
    if (!DECISION_STATUSES.includes(String(e.toStatus))) continue;
    if (!latest || e.createdAt.getTime() > latest.getTime()) latest = e.createdAt;
  }
  return latest;
}

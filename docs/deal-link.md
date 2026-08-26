# Deal link, recorded at accept time

## The column ids being read

Deal Tracking board `6527740233`, defined in `DEAL_COL` in
`src/integrations/monday/crmMapping.ts`:

| Figure            | Column id       | Type                                                             |
| ----------------- | --------------- | ---------------------------------------------------------------- |
| Structure freight | `lookup5__1`    | lookup/mirror — the value arrives as `display_value`, not `text` |
| Mats freight      | `text_mkzdpjf2` | text                                                             |
| Estimated tax     | `text_mkzd8x9t` | text                                                             |

Structure freight populating itself while mats freight stays blank is expected: one is a
lookup, the other is typed by hand on the board.

## Files

| File                                      | Role                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `src/integrations/monday/dealLink.ts`     | **New.** The one rule for finding a customer's deal          |
| `src/handoff/service.ts`                  | **Replace.** Records the deal on the order at accept time    |
| `src/integrations/monday/proposalPush.ts` | **Replace.** Uses the shared rule                            |
| `src/handoff/dealFigures.ts`              | **Replace.** Repair path for older orders, via the same rule |

```
copy /Y fixes\src\integrations\monday\dealLink.ts src\integrations\monday\dealLink.ts
copy /Y fixes\src\integrations\monday\proposalPush.ts src\integrations\monday\proposalPush.ts
copy /Y fixes\src\handoff\service.ts src\handoff\service.ts
copy /Y fixes\src\handoff\dealFigures.ts src\handoff\dealFigures.ts
pnpm typecheck
```

No schema change — `mondayProjectId` and `opportunityId` both already exist on
`AcceptedOrder`. They were simply never written.

## What changed

**The link is now recorded when a proposal is accepted**, alongside the price snapshot and
the integrity hash, which is where a fact about the accept belongs. Both halves are set:
`mondayProjectId` and `opportunityId` — the second was never written either, which is why
an order could not name its own deal even for a customer that had one.

**One rule, three callers.** `dealItemIdFor` already existed inside `proposalPush.ts`, and
my repair last turn had written a second, weaker copy of it in `dealFigures.ts` that missed
the `ExternalLink` fallback. It now lives in `integrations/monday/dealLink.ts` and all
three callers — proposal release, accept, and the BOM freight pull — get the same answer.
It also returns which opportunity the id came from, which is what makes recording the link
properly possible.

**A missing deal never blocks an acceptance.** The lookup is caught, the reason is logged,
and the order is created with a null link. Recording that a customer has accepted a
proposal cannot be allowed to depend on monday being reachable.

## Why the repair path stays

Orders accepted before today still have null columns, so `dealFigures.ts` keeps resolving
and storing on first use. It now says so plainly when it fires: _"This order predates the
deal link, so it was matched to this customer's most recent monday deal. Check the figures
are from the right job."_

That caveat is honest rather than decorative — a proposal is filed against an
**organization**, not against a deal (there is no `Proposal.opportunityId`), so for a
customer with two live opportunities the most recently updated one is a well-founded guess
and nothing more. New orders do not rely on it: they capture the link at the moment of
acceptance, when the answer is not yet ambiguous.

If you want that ambiguity removed altogether, the fix is a deal picker on the proposal —
choose the opportunity when the proposal is created, and every downstream question stops
being a guess. Worth doing if a customer with several concurrent projects is common for
you.

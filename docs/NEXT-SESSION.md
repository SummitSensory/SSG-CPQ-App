# Session 2 — after AUD-003 step 1

Written 2026-08-28. Read `SOFTWARE_AUDIT.md` for the full history; this is only what
changed after step 1 landed and what to do next.

## The blocker

**Nothing else should land until step 1 is retested in a browser.** It touched `esc`
(780 references) and `td` (301) across every screen in the app. Piling the Catalog
extraction — 2,559 lines — on an unverified foundation is how a bad afternoon becomes a
bad week.

The retest needs a person and a browser. It is in `docs/AUD-003-STEP-1.md` under
"In the browser", and it is deliberately long.

**Paste `scripts/ssg-ui-selfcheck.js` into the console first.** 94 assertions that the
primitives loaded and still return what they returned inside `app.js` — five seconds,
and it clears the catastrophic class (a missing member, a typo'd alias, a body that
changed on the way across) before you spend thirty minutes clicking. Proven to catch a
narrowed `esc`, a reverted `todayISO`, a changed `td`, a deleted member and a wrong
script order, with no false positives on the real module.

It cannot tell you whether a screen renders. Nothing can except looking.

## What was done in this session, after step 1

### AUD-017 portal token replay — closed by inspection, clean

The last open security item. Reviewed the same way AUD-010 was, by reading the code
rather than probing a running system.

The token is `randomBytes(32).toString('base64url')` — 256 bits — stored only as sha256
hex in a unique `tokenHash` column, looked up by it, and both routes are IP rate-limited
before the lookup. A plain digest rather than a slow KDF is right here: the secret has
full entropy, so there is no dictionary to slow down.

Altering one character misses the unique index and 404s. Resubmitting the same token is
**accepted and overwrites** — deliberately, and the code says why: a customer part-way
through their choices has to be able to come back and save. The write is terminal once
the status reaches APPLIED. So replay is a feature with a stop, not a hole.

### AUD-022 — the defect that review actually found

`applySelection` in `src/portal/colorSelection.ts` raced the customer, and lost
silently. It read the picks, checked the status, then made four more awaits — including
a palette read — before setting the status to APPLIED. `submitSelection` refuses only
once the status _is_ APPLIED. So the entire apply path was an open window, with no
transaction, no lock and no version check.

The damage was worse than a lost update. The closing write set `status`, `appliedAt` and
`appliedById` but **never re-wrote `picks`** — so a customer changing a colour mid-apply
left the selection row holding their new choice while the procurement lines the shop
reads held the old one. Two records disagreeing permanently, and nothing to arbitrate:
the order event stored only line names.

Fixed by **claiming the row before writing anything**, inside `prisma.$transaction`,
with the claim filtered on both `status: { not: 'APPLIED' }` and the `submittedAt` the
call reviewed. `updateMany` rather than `update` because it reports a match count, which
is the only way to ask "is this still the version I read?" and act on the answer. A
`count !== 1` throws and rolls back, so the refusal path writes nothing at all.

The order event now also records the actual colour applied per line. `picks` can still
be overwritten afterwards; the event cannot.

`tests/unit/portal-color-apply.test.ts` — 6 cases. The race is made deterministic by
resubmitting from inside the mocked palette read, which is a real awaited seam, so the
test pins the genuine ordering rather than an invented one.

Severity note: this is HIGH **the day `PORTAL_COLOR_SELECTION=live`**, and currently
unreachable — the flag ships `off`. There is no browser retest to do while that holds;
the unit test is the guard. Before switching that flag on, this is the thing to have
fixed.

### AUD-009 — the half that should not have waited

The consolidation of the two reporting stacks stays deferred; the new engine needs real
use first. But its own recommendation included "add a note at the top of both files
pointing at the other," and that was not done.

Both `src/proposals/analytics.ts` and `src/reporting/dataset.ts` now open with a block
naming the other, what overlaps, why they agree today, and the rule: a change to how a
figure is computed in one needs the same change in the other, or a note saying why not.

`dataset.ts` needed it most. Its existing header asserts that every insights endpoint
reads through one function — true inside that engine, and very easy to read as a claim
about the application.

### AUD-008 — a stale status line

The finding header read `Status: Open` while its own continuation two hundred lines
below read `Fixed — awaiting retest`. Corrected, with a note saying it was stale, since
a status field that lies is worse than one that is missing.

## Files from this session

| File                                    | Change                                                     |
| --------------------------------------- | ---------------------------------------------------------- |
| `src/portal/colorSelection.ts`          | AUD-022 — claim-before-write inside a transaction          |
| `tests/unit/portal-color-apply.test.ts` | **New.** 6 cases pinning the race and the happy path       |
| `src/proposals/analytics.ts`            | AUD-009 cross-reference block                              |
| `src/reporting/dataset.ts`              | AUD-009 cross-reference block                              |
| `SOFTWARE_AUDIT.md`                     | AUD-017 closed; AUD-022 added; AUD-009 and AUD-008 amended |

Plus the eleven files from step 1 and its follow-ons, listed in
`docs/AUD-003-STEP-1.md`.

## Verification

```powershell
npx tsc --noEmit          # must be silent
pnpm lint:count           # must be 0
pnpm test:unit            # the 6 new portal-colour cases
```

`colorSelection.ts` needs a real typecheck run — the claim's `where` clause mixes
`status: { not: … }` with a nullable `submittedAt`, which is valid Prisma but is the
kind of thing worth seeing `tsc` agree with.

## Step 1 is doing its job — measured

Not estimated. Every top-level declaration in the `app.js` closure (580) against every
identifier each screen references:

| Screen         | Needs from the shell | Satisfied by `SSGUI` | Still needs `app.js` | Predicted |
| -------------- | -------------------- | -------------------- | -------------------- | --------- |
| Catalog        | 22                   | 17                   | **4**                | 21 → ~4   |
| Administration | 38                   | 17                   | **21**               | 30 → ~13  |

Catalog is exactly what the module was built for. Administration is not, and that is the
more useful half of the answer — the full working is in
`docs/AUD-003-STEP-3-CATALOG.md`.

Catalog also turns out to have **one** entry point: 85 of its 89 declarations are
referenced nowhere outside its own block.

## Then, in order

1. **Retest step 1 in a browser.** Everything else waits on this. Self-check first.
2. **Retest the AUD-021 dates** with the clock set to US Pacific, after 5pm local.
3. **Three small moves that unblock Catalog** — each independently shippable, none of
   them the extraction:
   - `streetLine` (7 lines) → `ssg-ui.js`. A pure address formatter sitting in Catalog's
     workbook section by accident; its only callers are the builder and the BOM.
   - The **standard-notes panel** (~70 lines) → its own file. Rendered by _both_ Catalog
     and Administration; currently filed under Administration because that is where it
     was written.
   - The **vendor-parts dialog** (~230 lines) → its own file. The mirror: lives in
     Catalog, called from Administration. Same defect twice, opposite directions.
4. **Catalog** — then ~2,510 lines, one entry point, one injected dependency (`authed`),
   one copied line (`canCatalogAdmin`, which is pure despite looking otherwise).
5. **Configurators** — 1,297 lines. Moved ahead of Administration; see below.
6. **Administration** — last of the four. 21 remaining needs, reaching into the proposal
   preview, the configurator, Reports and the shell's own render and logout. The note
   called this "low risk to move"; it is the screen most entangled with the shell,
   because it is the screen that changes the shell.

Leave the **proposal builder** (3,468 lines, 15 entry points) and **Orders / BOM /
QuickBooks** (3,440 lines, 22 entry points) alone. Both sit on the money path.

## Still open, unrelated

- **`GET /health/references`** — one authenticated call; counts dangling `*ById` ids.
  Never run against real data.
- **BOM `.xlsx`** — needs a human to open one in Excel and judge the styling.
- **AUD-001 Part 2** — the migration squash. Procedure in `docs/database-migrations.md`;
  rehearse on a Neon branch.
- **AUD-006** — alert on a failed scheduled report; needs a real failed send.
- **Before `PORTAL_COLOR_SELECTION` goes past `off`:** confirm who at Summit edits the
  Jotform colour forms today. `colorSelection.ts`'s own header raises it — the palette
  is administered in the CRM, but the question wording and the page around it are code,
  and that is a real capability the current flow has and this one does not.

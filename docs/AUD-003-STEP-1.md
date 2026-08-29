# AUD-003 step 1 — the shared primitives module, and three follow-ons

Done 2026-08-28. Corrected files are under `fixes/`, mirroring the repo path; copy each
straight over its original.

| File                                | Change                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `public/ssg-ui.js`                  | **New.** 28 primitives, registering `window.SSGUI`                            |
| `public/app.js`                     | Declarations removed and aliased from `SSGUI`; supplies dates to the renderer |
| `public/proposal-document.js`       | `fmtDate` / `todayISO` moved from copied to injected — fixes the UTC-day bug  |
| `public/belt-shipments.js`          | `todayISO` defers to `SSGUI`; `fmtStamp` no longer mixes UTC and local        |
| `public/accounts-receivable.js`     | `fmtStamp` — the same defect, in the same copied function                     |
| `public/index.html`                 | `ssg-ui.js` first; cache-busters bumped on the three changed scripts          |
| `src/routes/web.ts`                 | `'ssg-ui.js'` first in `CLIENT_SCRIPTS`                                       |
| `tests/unit/client-scripts.test.ts` | New case: `ssg-ui.js` must be the first `<script>` tag                        |
| `eslint.config.js`                  | `SSGUI` global; an `error`-level block for `public/ssg-ui.js`                 |
| `.prettierignore`                   | `public/ssg-ui.js`, so the moved bodies stay diffable as a move               |
| `SOFTWARE_AUDIT.md`                 | AUD-003 step 1 + step 1a; new finding AUD-021; four change-log rows           |

`app.js` goes from 16,083 lines to 15,920.

These are four separate commits' worth of work and are best landed in that order: the
module, then the date fix, then the escape widening. The audit amendment can ride with
whichever you like.

---

## 1. The module

All 28 candidates from the audit note, verified verbatim: the byte-for-byte block of
each original declaration was found inside `ssg-ui.js` and confirmed absent from
`app.js`.

`esc` `titleCase` `rt` (with `rtUnescapeTags` + `RT_TAGS`) `isoLocal` `todayISO`
`fmtDate` `fmtDateTime` `fmtMoney` `fmt0` `money` `costMoney` `d2m` `hasRole`
`roleLabel` `td` `tableShell` `statusChip` `kpi` `fieldRow` `formSection` `IN`
`selectEl` `bomFieldStyle` `openModal` `toast` `downloadCsv` `downloadBlob`
`serverMessage`

`isoLocal` was not on the list. It moved because `todayISO` is a one-line call to it,
and it has two remaining callers in `app.js` (`repRangeParams`, `addDays`), so it is
aliased back alongside the rest. `rtUnescapeTags` and `RT_TAGS` moved with `rt` and are
deliberately **not** aliased — nothing else used them, and aliasing them would trip
`no-unused-vars`.

**Call sites were not rewritten.** `app.js` gets one `var` block aliasing all 28 names
back to their originals instead of `SSGUI.esc(...)` at each call. `esc` has 780
references and `td` has 301; editing roughly two thousand call sites is pure risk, and
it would hide the only thing this commit needs to prove — that each body moved
unchanged. The block is `var`, not hoisted declarations, so the names exist from that
line down; every call site is inside a function that runs after boot, and a use added
above the block throws immediately rather than misbehaving.

`app.js` also refuses to boot without `SSGUI`, after writing a plain-English message
into `#root`. A missing primitives module is not a degraded shell, and `esc is not a
function` from three thousand lines down says nothing about the cause.

**`hasRole` was copied, not injected.** The audit note flags it as reading
`currentUser`. It does not, and its signature says so: `hasRole(list, role)` is pure.
`rt` was the one that needed a decision, and putting it in `ssg-ui.js` is what caution 2
actually asks for — one implementation. `app.js` still hands that same function to the
renderer through `wireProposalDocument`'s `useRules({ rt: rt, … })`.

## 2. The de-duplication of the six screen files — closed, not done

Recorded in `SOFTWARE_AUDIT.md` as **step 1a, closed as not-applicable**, so nobody
re-opens it as debt.

Only about twelve lines across those six files are identical copies (`esc` +
`titleCase` in `accounts-receivable.js`, `esc` in `belt-shipments.js`). The rest are
different functions that happen to share a name: `openModal(title, body, footerHtml,
width)` against `openModal(title, body, onSubmit, submitLabel, opts)`; `money` returning
`'$1,234.50'` against `'1234.50'`; `td(html, right)` against `td(v)`;
`statusChip(status, daysPastDue)` against `statusChip(s)`.

Those screens carry their own visual language — their own `INK`/`LINE`/`MUTE` tokens,
Georgia rather than Newsreader, a dialog with a header bar and a close X.
`accounts-receivable.js` says so in a comment: it borrows nothing on purpose. Forcing
them onto `SSGUI` is a redesign of three screens wearing a refactor's clothes, and
twelve lines is not worth the churn.

The payoff of step 1 was never retroactive dedupe. It is Catalog dropping from 21 needs
to about 4 and Administration from 30 to about 13, and that is banked.

## 3. AUD-021 — two UTC-day date bugs

Found while reading those six files. Both answered "what day is it" in UTC, so west of
Greenwich they were a day early for the last hours of every working day.

**`proposal-document.js`** is the serious one: it renders the Proposal Date, the
Expiration Date and the discount-expiry line on the page a customer signs, and the same
file renders the server PDF — so screen, print and PDF were all wrong together, which is
the version hardest to notice. A proposal made at 6pm Mountain claimed to expire a day
sooner than it does.

Fixed by **injection, not by copying the good version in**: `fmtDate` and `todayISO`
moved out of that file's copied-primitives block into its `rules` object, supplied by
`app.js` from `SSGUI`. `useRules()` throws if either is missing, so this cannot silently
regress. The file's header doctrine is amended to say why — a copy of a pure function
cannot drift, but it can be wrong at the moment it is made, and then it stays wrong
while the original is fixed. That is exactly what happened.

Behaviourally, the timezone is the _only_ change: all five `fmtDate` call sites in that
file are guarded by a truthiness check, so the old `''`-for-empty return was
unreachable and the switch to `'—'` cannot surface.

**`belt-shipments.js`**'s `todayISO` is the date printed on a packing slip. It now
defers to `SSGUI.todayISO()`.

**A third instance — and I initially got this one wrong.** `fmtStamp`, copied
identically into `belt-shipments.js` and `accounts-receivable.js`, printed **a UTC date
beside a local time**: the date from `fmtDate(iso)` (which reads the first ten
characters of the string) and the time from `toLocaleTimeString` (which is local). At
6:30pm Mountain that renders `Aug 29, 2026 at 6:30 PM` — tomorrow's date next to
tonight's time, under a doc comment claiming "in the reader's own timezone." Verified
against the real shape of the bug:

    2026-08-29T00:30:00Z   before: Aug 29, 2026 at 6:30 PM
                           after : Aug 28, 2026 at 6:30 PM

I first deferred this as screen-only, on the grounds that fixing it meant touching those
files' own `fmtDate` and so re-opening the de-duplication just closed. That was wrong
twice over. The defect is in `fmtStamp`, not `fmtDate` — `fmtDate`'s string slicing is
correct for the bare `YYYY-MM-DD` calendar dates it is otherwise handed, which have no
timezone to get wrong. And it is not one stamp: it is all six `fmtStamp` call sites
across the two files, including "shipped at" on a belt shipment and "payment request
sent" on a receivable — where someone is counting days.

Fixed by taking both halves from the parsed `Date`, in each file, without touching
`fmtDate`. `belt-shipments.js` line 531 also round-tripped its argument through
`new Date(e.last).toISOString()` first, which was pointless as well as wrong; it now
passes the timestamp straight in.

## 4. `SSGUI.esc` now escapes `'`

`app.js` escaped four characters; `proposal-document.js`, `insights.js` and `goals.js`
all escaped five. Resolved in favour of the wider set, because `app.js` builds
single-quoted attributes in places and a four-character escape does not close them
safely.

Widening is safe in a way narrowing never is: `&#39;` renders as `'` in element text, in
a `value="…"` and in a `<textarea>`, so nothing a reader sees changes. It would be
visible only if escaped text were written somewhere that is not HTML.

**That was checked rather than assumed.** All 753 `esc` call sites in `app.js` were
examined at statement level — for each one, the enclosing statement was tested against
`textContent`, `.value =`, `encodeURIComponent`, `setAttribute`, `new Blob`, `alert`,
`confirm`, `prompt`, `localStorage.setItem`, `.download =`, `.href =` and a request
`body:`. **Zero hits.** Every one of the 753 assembles HTML. Separately, all nine
`downloadCsv` exports build their rows from raw values (`col.plain(row)`,
`x.ourPart`, …), never from `esc`.

---

## Verification

```powershell
npx tsc --noEmit          # must be silent
pnpm lint:count           # must be 0
pnpm test:unit            # 48 files; 470 tests now (the new client-scripts case)
```

Already checked here: all four JS files parse; `ssg-ui.js` registers exactly the 28
members `app.js` aliases, none missing and none unused; `proposal-document.js` declares
12 rules and `app.js` supplies exactly those 12; brace and paren balance in `app.js` is
unchanged from the original; and the one comment orphaned by the removals was cleaned
up.

### In the browser

This list is long because `esc` has 780 references and `td` has 301, so a mistake in
either is everywhere at once and looking is the only way to know:

Dashboard · CRM · Catalog (all six tabs) · Proposals · the builder · Reports · Orders ·
a Bill of Materials · Accounts Receivable · Insights · Goals · Administration (all five
tabs) · a proposal preview in both US and Canadian form.

Watch specifically for: money and dates rendering as `—` where a figure belongs (an
alias that did not resolve), a modal that opens but whose Save does nothing
(`openModal`), an empty table body (`tableShell`), and the notes on a proposal preview
losing their bold and paragraph breaks (`rt`).

### The date fix needs a west-of-UTC clock

Set the machine to US Pacific. After 5pm local, check the **Proposal Date** and
**Expiration Date** on a preview, on print, and on the server PDF, in both US and
Canadian form — all three must agree with each other and with the local calendar day.
Then make one packing slip and check its date, and check the timestamps that now come
from `fmtStamp`: "shipped at" and "voided by" on a belt shipment, "Last …" on the
summary row, and "payment request sent" on a receivable. The date and the time in each
of those must agree with each other.

### The escape widening

Save an organization, a contact and a proposal title containing an apostrophe
(`O'Brien Children's Therapy`) and confirm it renders as typed — not as `&#39;` — in the
list, in the edit form's input, on the proposal preview, and in a CSV export of that
table.

## After this

Unchanged: Catalog (2,559 lines), then Administration (1,942), then Configurators
(1,297). The builder and Orders/BOM/QuickBooks stay where they are.

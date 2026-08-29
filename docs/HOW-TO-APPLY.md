# The write-up

**Two files. Documentation only — no code.**

| File                |                                    |
| ------------------- | ---------------------------------- |
| `SOFTWARE_AUDIT.md` | replace — 945 → 1,069 lines        |
| `github.md`         | replace (or new, at the repo root) |

Commit them with anything else outstanding. Nothing to test.

## `SOFTWARE_AUDIT.md`

Three additions, all dated 2026-08-29:

**Seven change-log rows** in section 12, covering AUD-023 through AUD-026, the integrity
gate, the Catalog extraction, and the UI work — with browser verification marked outstanding
rather than implied.

**Section 13 rewritten.** It said "no broad remediation has begun." That is no longer true,
and a status field that lags is the same problem as one that overstates.

**A new section 14** documenting the pass properly: what the user report actually turned out
to be, the table of which create path writes which half, the $0.00 exposure and why no
customer was ever mispriced, what was fixed, the rule table with severities, and what is
outstanding.

Two things in it worth your attention:

**The three non-defects are recorded, with the reasoning error named.** `Sku.category` vs the
tree, `ProductSourcing` cardinality, and the `isPrimary` default. All three came from
inferring a data model from field names instead of opening `prisma/schema.prisma`, and in
one case from reading back a comment written earlier in the same session as if it were
evidence. A future session that repeats that will waste the same hours, so the section says
so plainly: **the schema is the authority; a field's shape is not its meaning.**

**AUD-011's status is contradicted.** It claims the QuickBooks mock was repaired with a
Proxy fallback so any new model answers null. That code was not in the repo — which is why
nine tests were still dying on undefined models today. Recorded rather than quietly
overwritten, because it is the second status field in this document found overstating (the
first was AUD-008, corrected yesterday).

## `github.md`

The part that earns its place is the **data-model notes**. Five facts that cost three
rounds of rework to establish:

- a part is two rows, joined by part number
- three different "category" fields with three different jobs
- `ProductSourcing` is many-to-many, and `isPrimary` defaults to true
- the BOM reads `Sku.manufacturer`, so that is who you actually order from
- **the builder snapshots the rate onto the line** — with a note not to "improve" it into a
  live lookup, since that single decision is why 192 parts priced at $0.00 never reached a
  customer wrong

Plus the screen map, the commands, everything outstanding, and a note on hand-off packaging
so the README-overwrite and line-ending problems from this session do not recur.

## Where that leaves the project

`pnpm check` passes with a data-integrity gate. 80/80 integration tests. 0 blocking
violations. The catalog's blocking defects are closed at the source and guarded against
recurrence.

**7.5**, and the missing half-point is browser verification of today's UI work — an hour of
clicking, not more code.

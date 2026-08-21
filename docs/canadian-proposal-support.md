# Canadian proposal and cross-border pricing support

Status: **foundation slice only.** Nothing in this document is reachable from the
UI yet, and `CrossBorderSetting.enabled` ships `false`. Applying the migration
changes no existing proposal.

## 1. What the codebase already does

Discovered before writing anything, and worth stating because several design
choices below exist only because these patterns were already here.

| Concern                | How this repo does it                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Stack                  | Fastify + TypeScript, Prisma/Postgres, vanilla-JS client (`public/app.js`), Vercel                                  |
| Money                  | Integer **minor units** (`Int`/`BigInt`). `src/lib/money.ts`, `src/pricing/decimal.ts`. No floats anywhere          |
| Rates and factors      | `Decimal` columns — `FinanceRate.factor` is `Decimal(10,6)`                                                         |
| Effective dating       | `PriceList`, `FinanceRateCard`/`FinanceRateBand`, `FormulaRevision`                                                 |
| Snapshots              | `PriceSnapshot`, `RuleEvaluationSnapshot`, `AcceptedOrder`'s frozen totals                                          |
| "Not answered" vs zero | `priceEntry.ts` and `FreightTrueUp` both use nullable money columns, because a null and a zero are different claims |
| Actor references       | Plain `String` id columns, no FK (`ProposalVersion.releasedById`)                                                   |
| Audit                  | `src/lib/audit.ts` → `AuditLog`, append-only                                                                        |
| Auth / roles           | `src/authz/permissions.ts`, `rbac.ts`                                                                               |
| PDF                    | `src/render/pdf.ts`, `src/routes/render.ts`                                                                         |
| Acceptance             | DocuSeal — `EsignEnvelope`, `EsignSigner`, `EsignEvent`                                                             |
| Tests                  | Vitest, `tests/unit`, `tests/integration`, `tests/regression`                                                       |

Two consequences:

- **The requirement to "use a decimal money type" is already satisfied.** Minor
  units are exact. CAD is stored the same way; exchange rates are `Decimal(12,6)`
  to match the `FinanceRate.factor` precedent. No new money type was introduced.
- **No new framework, no new patterns.** Effective dating, snapshots and
  nullable-money-means-unanswered are all lifted from code already in the repo.

## 2. Decisions, and what they cost

### 2.1 The trigger is the BILLING address

Directed by SSG. The conventional rule is ship-to, because tax follows where the
goods land, and the specification's own test #4 asserts that a Canadian billing
address with a US ship-to must **not** trigger Canadian treatment.

This application has no ship-to on a proposal at all: `ShipToAddress` hangs off
orders and `BomVendorSection`, and `FreightRfq` freezes its own copy at RFQ time.
Adding one was rejected in favour of using `Address` where `type = BILLING`.

**Cost:** a Canadian-billed order shipping to a US address will be treated as
Canadian, which is wrong. Accepted on the basis that SSG's Canadian customers are
billed and shipped in the same country.

**Containment:** `resolveJurisdiction()` in `src/crossborder/jurisdiction.ts` is
the only function that reads an address. Nothing downstream touches one. Changing
the trigger later is a change to that one function.

### 2.2 There is no tariff calculator

The specification asks for duty computed from tariff classification, country of
origin, CUSMA certification, melt-and-pour, surtax orders and non-stacking
precedence. **None of that data exists in this database.** There are no HS codes on
`Sku` or `Product`, no origin records, and no certificates.

Duty computed from absent data is worse than no duty, because it produces a number
someone will quote. So v1 implements what the specification itself requires in
§2.3 and §6.5 — the review gate — plus a human-entered figure:

- every Canadian proposal starts at `REQUIRES_CUSTOMS_REVIEW`
- a user enters duty, surtax, SIMA, import tax and brokerage as amounts, with a
  source reference (broker quote, ruling, prior entry)
- an authorized user approves it, which moves it to `CONFIRMED`
- **null is not zero.** Every amount column is nullable and starts null. A zero
  duty is a claim this application will not make on its own

`ProposalCustomsEntry` holds this. The engine interfaces are shaped so a
calculator can be added later without changing callers.

### 2.3 Registrations are empty on purpose

`CanadianTaxRegistration` is created and **not seeded**. A province having a rate
is not a reason to charge it. With no rows, every Canadian proposal returns
`REQUIRES_TAX_REVIEW` and cannot be released.

Entering SSG's federal GST/HST number is the one required admin step to make
Canadian proposals releasable. **One row with `province = NULL` covers GST and HST
in every province** — see §3.2.

## 3. Modules

### 3.1 `src/lib/country.ts`

Pure normalization. Exists because this database holds country three ways:
`Address.country` defaults `"US"`, `ShipToAddress.country` and
`Manufacturer.country` default `"USA"`, and `FreightRfq.shipToCountry` is free
text from monday or the portal.

Normalizes to ISO alpha-2. Accepts `CA`, `CAN`, `Canada`, `Canadá`; and `US`,
`USA`, `U.S.A.`, `United States`. Province aliases cover codes, full names, French
names (`Colombie-Britannique`, `Québec`) and legacy abbreviations (`PQ`, `NF`,
`NWT`).

`postalCodeProvinceHint()` is used **only to cross-check** a province that was
given, never to supply a missing one. `X` returns null because Nunavut and the
Northwest Territories share it.

### 3.2 `src/crossborder/tax.ts`

A pure function over rule rows — no database, no clock, no config. That is what
makes tax behaviour a fixture table.

Three invariants:

1. **HST is one line.** Never split into federal and provincial parts.
2. **Manitoba is RST, Quebec is QST.** The label comes from the tax type on the
   rule, so there is nowhere to get it wrong.
3. **GST and HST are ONE federal registration.** A single row with a null province
   satisfies both. This was a real bug during development: matching `taxType`
   exactly meant a correctly registered company failed the check in every HST
   province. Locked by a named regression test.

Nothing compounds. Quebec's QST is calculated on the same base as GST, not on top
of it. A `compoundOn` field exists on the rate rule so a future jurisdiction can
express compounding without a code change; no current rate uses it.

`effectiveTo` is **EXCLUSIVE**: a row runs `[effectiveFrom, effectiveTo)`. Rows
for the same province and tax type must abut exactly. Seed data and admin entry
must both follow this or the scheme is wrong by one day at every boundary.

A charge category with **no** applicable taxability rule returns
`missing_taxability_rule` and puts the proposal in review. It does not default to
taxable or exempt.

### 3.3 `src/crossborder/fx.ts` and `rateService.ts`

`fx.ts` reads the Bank of Canada Valet API (series `FXUSDCAD`, Canadian dollars
per one US dollar) and converts money. `rateService.ts` owns caching, fallback and
audit.

**Why the window query matters.** The Bank does not publish every day. Asking for
a single date and treating an empty response as an error breaks every Monday
proposal. The provider requests a 14-day window and takes the last observation in
it.

**Why there are two rate tables.** `ExchangeRateObservation` is what was
published. `ExchangeRateResolution` is _which observation answered a given date_.
Without the second, a Monday proposal cannot distinguish "Friday is genuinely the
latest publication" from "we have not fetched Monday yet" — so it would either
call the API on every page view or quote a stale rate. With it, resolving a date is
idempotent and the API is called once per date.

**A fallback is never cached**, so the next attempt can still reach the Bank. A
manual rate is never cached as a resolution either — that would make its warning
vanish on the next read.

**Conversion.** `CAD = round(USD_minor × rate)` in `bigint` against the rate's own
scale. No step touches a float. Rounding is **half-up away from zero**, so a
discount and the charge it discounts round the same way and CAD lines still sum to
the CAD total. `convertCadMinorToUsd` exists for a CAD-quoted broker fee and is the
only sanctioned CAD→USD direction — a _converted_ CAD amount is never converted
back.

## 4. Assumptions flagged for confirmation

Listed because guessing silently is the failure mode this whole design is built
to avoid.

1. **Every seeded rate and effective date needs verification.** They are seeded as
   effective-dated rows precisely so a correction is an `UPDATE`, not a code
   change. Two are least certain: **Nova Scotia's HST reduction to 14% and its
   effective date (seeded `2025-04-01`)**, and **Saskatchewan's PST date (seeded
   `2017-03-23`)**. Confirm all thirteen provinces before enabling.
2. **`INSTALLATION`, `DESIGN`, `TRAINING`, `TRAVEL` and `OTHER` have no taxability
   rows.** Their provincial treatment genuinely varies — installation into real
   property especially. Unseeded means those proposals go to review, which is the
   intended conservative behaviour, not an oversight. Needs a ruling per category.
3. **Border charges are seeded as not taxable** for seller-collected tax. Correct
   while the customer is importer of record. Revisit if SSG becomes IOR.
4. **`BLOCK_FINALIZATION` vs `DRAFT_WITH_REVIEW`.** The requirement lists both, and
   they only differ if one also withholds the draft. Read as: `BLOCK_FINALIZATION`
   produces no CAD figures, `DRAFT_WITH_REVIEW` produces them with a warning. If
   that is backwards, `RateResolution.allowsDraft` in `rateService.ts` is the only
   place to change.
5. **Billing-address trigger** — see §2.1.

## 5. Migration

`prisma/migrations/0060_cross_border/migration.sql`. Eleven tables, eight enums,
**additive only**. No existing table, column, index or constraint is touched, and
nothing has a foreign key into `User`, `Organization`, `Proposal` or
`ProposalVersion`, so no delete behaviour anywhere changes.

Apply with `node prisma/apply-crossborder-schema.mjs` (appends the models,
idempotent, writes `schema.prisma.bak`), then `pnpm db:generate`, then the SQL.

Rollback is a `DROP` block at the foot of the migration file. Because the
migration is additive, dropping loses only cross-border data.

## 6. Not built yet

The charge-line pipeline, the snapshot writer, the customs entry flow, broker fee
evaluation, the proposal and PDF presentation, the acceptance re-lock and the admin
screens (`docs/cross-border-admin.md`) have all since landed. What remains:

- **the six end-to-end city fixtures** — `tests/integration/crossBorderCities.test.ts`
  now runs a whole proposal through the pipeline once per regime (Toronto, Halifax,
  Vancouver, Winnipeg, Montreal, Calgary), so what remains here is only the same
  fixture against the SEEDED rates rather than a written-out rule set
- **configurable proposal-language templates** — the currency statement and the
  cross-border terms are still written in `src/render/pdf.ts`
- **a tier-table editor** — the admin screen enters flat, percentage and per-unit
  brokerage schedules; a tiered tariff still needs its `tiers` JSON entered directly
- **taxability rules for `INSTALLATION`, `DESIGN`, `TRAINING`, `TRAVEL` and
  `OTHER`** — unseeded on purpose (§4.2), but they need a ruling before a Canadian
  job with installation on it can be released
- **`rateService.ts` tests** — see §7

## 7. Verification status

`tests/unit/crossBorder.test.ts` covers country and province normalization,
jurisdiction resolution, conversion arithmetic and rounding symmetry, the Bank of
Canada provider against a stubbed transport including the weekend fallback, and
the tax engine including the GST/HST registration regression.

`tests/unit/brokerFees.test.ts` covers the brokerage arithmetic: percent-not-fraction,
the floor applying to the broker's own fee before pass-through charges, inclusive tier
ceilings, and the refusal on a value above every tier.

`tests/integration/crossBorderCities.test.ts` runs the whole pipeline once per tax
regime and asserts what would print: one HST line at 13% in Ontario and 14% in Nova
Scotia, GST + PST in British Columbia, RST in Manitoba, QST on the same base as GST in
Quebec, GST alone in Alberta. It also locks the gates — a missing provincial
registration, an absent taxability rule, unreviewed customs figures, an undetermined
importer of record, and an exemption nobody approved — and the CAD column adding up to
its own total.

**`rateService.ts` has no tests.** It needs a test database or a Prisma mock, and
an integration test rather than a unit test. It is reviewed, not proven.

Before enabling: run the suite, `tsc --noEmit`, lint, and the production build;
confirm the rates with SSG's tax adviser; enter the federal registration; and have
the customs approach reviewed by SSG's customs broker.

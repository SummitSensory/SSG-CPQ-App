/**
 * Adds the cross-border (Canadian proposal) models to prisma/schema.prisma.
 *
 * Run from the repo root:  node prisma/apply-crossborder-schema.mjs
 * Then:                    pnpm db:generate
 *
 * Idempotent — running it twice changes nothing. Appends only; it does not touch
 * any existing model, so no existing relation, column or index moves. That is
 * deliberate: none of these tables has a foreign key into User or Proposal.
 * Actor and version references are plain String columns, following the precedent
 * already in this schema (`ProposalVersion.releasedById`, `FreightTrueUp.versionId`).
 * A cross-border row therefore cannot cascade-delete anything or block a delete.
 *
 * Writes prisma/schema.prisma.bak first.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PATH = 'prisma/schema.prisma';
const MARKER = 'model CrossBorderSetting';

const MODELS = `

// ===========================================================================
// Cross-border: Canadian proposals
//
// USD is the controlling currency. Every money column below is USD minor units
// unless its name says otherwise, and CAD is a derived figure recomputed from the
// authoritative USD amount and a dated exchange rate — never stored as the source
// of truth and never converted back.
//
// Everything that can change over time is effective-dated with an EXCLUSIVE
// \`effectiveTo\`: a rate row runs [effectiveFrom, effectiveTo). Two rows for the
// same province and tax type must abut exactly, so one and only one is ever in
// force on a given date.
// ===========================================================================

enum CrossBorderTaxType {
  GST
  HST
  PST
  RST
  QST
  /// GST assessed at the border by CBSA, not collected by SSG. Held separately
  /// because it is never a seller-collected line.
  IMPORT_GST
}

enum TaxRegistrationStatus {
  REGISTERED
  NOT_REGISTERED
  PENDING
  INACTIVE
}

enum TaxResponsibilityMode {
  SELLER_COLLECTS
  CUSTOMER_PAYS_AT_IMPORT
  SELLER_IS_IMPORTER_OF_RECORD
  TAX_EXEMPT
  REQUIRES_TAX_REVIEW
}

enum ImporterOfRecord {
  CUSTOMER
  SUMMIT
  THIRD_PARTY
  TO_BE_DETERMINED
}

/// What a charge on a proposal is, for taxability. Freight, installation,
/// brokerage and duty are taxed differently from equipment in at least one
/// province, so they cannot share a category.
enum CrossBorderChargeCategory {
  EQUIPMENT
  PARTS
  FREIGHT
  INSTALLATION
  DESIGN
  TRAINING
  TRAVEL
  CUSTOMS_DUTY
  TARIFF_SURTAX
  SIMA
  BROKERAGE
  BROKER_DISBURSEMENT
  IMPORT_TAX
  SALES_TAX
  DISCOUNT
  CREDIT
  OTHER
}

/// What to do when the Bank of Canada cannot be reached.
enum FxFallbackMode {
  /// Use the most recent observation already stored.
  LAST_CACHED
  /// Use the administrator's manual rate.
  MANUAL_RATE
  /// Refuse to finalize. Drafts still open.
  BLOCK_FINALIZATION
  /// Allow a draft, labelled as needing exchange-rate review.
  DRAFT_WITH_REVIEW
}

/// Customs on a proposal is a human-entered figure in this version. There is no
/// tariff calculator: classifications, origin records and CUSMA certificates do
/// not exist in this database yet, and a duty computed from absent data is a
/// number somebody would quote.
enum CustomsEntryStatus {
  /// The default for every Canadian proposal until a person enters a figure.
  REQUIRES_CUSTOMS_REVIEW
  /// A figure has been entered and is presented as an estimate.
  ESTIMATED
  /// Entered and approved by an authorized reviewer.
  CONFIRMED
  /// No customs charges arise (e.g. SSG is not shipping across the border).
  NOT_APPLICABLE
}

enum BrokerFeeType {
  FLAT
  PERCENTAGE
  TIERED
  PER_ENTRY
  PER_SHIPMENT
  PER_LINE
  MANUAL
}

/// One published exchange-rate observation. A rate is a fact with a date, not a
/// current value: a proposal records which observation it was quoted on, and
/// re-reading it a year later shows the same CAD figures.
model ExchangeRateObservation {
  id              String   @id @default(cuid())
  pair            String
  observationDate DateTime @db.Date
  /// As published, unrounded. Rounding happens once, at display.
  rate            Decimal  @db.Decimal(12, 6)
  source          String
  retrievedAt     DateTime @default(now())

  @@unique([pair, observationDate])
}

/// "Which observation did we decide applies to date X." Separate from the
/// observations themselves so the answer is cached exactly rather than guessed:
/// without this, a Monday proposal cannot tell "Friday is genuinely the latest
/// publication" from "we have not fetched Monday yet", and would either hit the
/// Bank of Canada on every page view or quote a stale rate. Only written when a
/// live provider answered — a fallback is never cached, so the next attempt can
/// still get the real rate.
model ExchangeRateResolution {
  id              String   @id @default(cuid())
  pair            String
  /// The date we needed a rate FOR (proposal date, or acceptance date).
  forDate         DateTime @db.Date
  /// The observation that answered it, on or before forDate.
  observationDate DateTime @db.Date
  rate            Decimal  @db.Decimal(12, 6)
  source          String
  resolvedAt      DateTime @default(now())

  @@unique([pair, forDate])
}

/// A rate an administrator typed, with the reason they typed it. Never used
/// unless the configured fallback mode says so, and always shown as a warning on
/// the proposal.
model ExchangeRateOverride {
  id            String   @id @default(cuid())
  pair          String
  rate          Decimal  @db.Decimal(12, 6)
  effectiveDate DateTime @db.Date
  reason        String
  active        Boolean  @default(true)
  createdById   String
  createdAt     DateTime @default(now())

  @@index([pair, effectiveDate])
}

/// A provincial or federal sales-tax rate, effective-dated.
model CanadianTaxRate {
  id            String             @id @default(cuid())
  /// ISO 3166-2:CA subdivision code — AB, BC, MB, NB, NL, NS, NT, NU, ON, PE,
  /// QC, SK, YT.
  province      String
  taxType       CrossBorderTaxType
  ratePercent   Decimal            @db.Decimal(7, 4)
  effectiveFrom DateTime           @db.Date
  /// Exclusive. Null means "still in force".
  effectiveTo   DateTime?          @db.Date
  /// Where the figure came from, e.g. a CRA or provincial publication.
  source        String?
  approvedById  String?
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt

  @@index([province, taxType, effectiveFrom])
}

/// Whether SSG is registered to collect a given tax. A province having a rate is
/// NOT a reason to charge it; this table is.
///
/// GST and HST are one federal registration: a single row with a null province
/// covers every province. PST, RST and QST are registered province by province.
model CanadianTaxRegistration {
  id                 String                @id @default(cuid())
  taxType            CrossBorderTaxType
  /// Null for the federal GST/HST registration; set for PST, RST and QST.
  province           String?
  registrationNumber String?
  status             TaxRegistrationStatus @default(NOT_REGISTERED)
  effectiveFrom      DateTime              @db.Date
  effectiveTo        DateTime?             @db.Date
  notes              String?
  approvedById       String?
  createdAt          DateTime              @default(now())
  updatedAt          DateTime              @updatedAt

  @@index([taxType, province, effectiveFrom])
}

/// Whether a charge category is taxable, per tax type, optionally per province.
///
/// A category with NO applicable rule does not default to taxable or exempt. The
/// engine returns \`missing_taxability_rule\` and the proposal needs a human.
/// Defaulting either way is how a freight line silently acquires or loses 13%.
model CrossBorderTaxabilityRule {
  id            String                    @id @default(cuid())
  category      CrossBorderChargeCategory
  taxType       CrossBorderTaxType
  /// Null means every province. A province-specific row wins over it.
  province      String?
  taxable       Boolean
  effectiveFrom DateTime                  @db.Date
  effectiveTo   DateTime?                 @db.Date
  source        String?
  createdAt     DateTime                  @default(now())
  updatedAt     DateTime                  @updatedAt

  @@index([category, taxType])
}

/// An approved customer exemption. A customer being a school, charity or public
/// body is not an exemption, and a rebate it can claim later is not a
/// point-of-sale exemption — \`approvedById\` must be set for this to suppress
/// anything.
model CustomerTaxExemption {
  id                String               @id @default(cuid())
  organizationId    String
  /// Which taxes this certificate exempts, e.g. ["QST"].
  taxTypes          CrossBorderTaxType[]
  exemptionType     String?
  certificateNumber String?
  issuingAuthority  String?
  effectiveFrom     DateTime             @db.Date
  effectiveTo       DateTime?            @db.Date
  attachmentId      String?
  approvedById      String?
  approvedAt        DateTime?
  notes             String?
  createdById       String
  createdAt         DateTime             @default(now())
  updatedAt         DateTime             @updatedAt

  @@index([organizationId, effectiveFrom])
}

/// A customs broker's fee schedule. Missing configuration produces "To be
/// confirmed", never zero.
model CustomsBrokerFeeSchedule {
  id                    String        @id @default(cuid())
  name                  String
  brokerName            String?
  feeType               BrokerFeeType
  /// The currency the schedule is QUOTED in. A CAD-quoted fee is converted to a
  /// USD display equivalent; the CAD figure remains the source document.
  currency              String        @default("CAD")
  amountMinor           Int?
  percent               Decimal?      @db.Decimal(7, 4)
  minMinor              Int?
  maxMinor              Int?
  /// Tier bands: [{ "minMinor": 0, "maxMinor": 500000, "amountMinor": 25000 }].
  tiers                 Json?
  disbursementMinor     Int?
  advancementMinor      Int?
  bondMinor             Int?
  /// The customer pays the broker directly, so this never enters the SSG total.
  customerPaysDirectly  Boolean       @default(true)
  includedInSellerTotal Boolean       @default(false)
  active                Boolean       @default(true)
  isDefault             Boolean       @default(false)
  effectiveFrom         DateTime      @db.Date
  effectiveTo           DateTime?     @db.Date
  notes                 String?
  reviewedById          String?
  reviewedAt            DateTime?
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt

  @@index([active, effectiveFrom])
}

/// The human-entered customs figures for one proposal version.
///
/// One row per version. Starts as REQUIRES_CUSTOMS_REVIEW with every amount null
/// — and null is not zero. Null means "nobody has answered", which is the same
/// distinction priceEntry.ts and FreightTrueUp make, and for the same reason: a
/// zero duty is a claim, and this application must not make it on its own.
model ProposalCustomsEntry {
  id                    String             @id @default(cuid())
  proposalId            String
  versionId             String             @unique
  status                CustomsEntryStatus @default(REQUIRES_CUSTOMS_REVIEW)
  /// The currency the broker quoted these in.
  currency              String             @default("CAD")
  dutyMinor             Int?
  surtaxMinor           Int?
  simaMinor             Int?
  otherDutyMinor        Int?
  importTaxMinor        Int?
  brokerFeeMinor        Int?
  brokerFeeScheduleId   String?
  /// Why these numbers: broker quote reference, ruling number, prior entry.
  sourceReference       String?
  basis                 String?
  importerOfRecord      ImporterOfRecord   @default(CUSTOMER)
  /// Only true where SSG is collecting or advancing these amounts. When false
  /// they appear in the separately-payable section and are excluded from the
  /// amount payable to SSG.
  includedInSellerTotal Boolean            @default(false)
  enteredById           String?
  enteredAt             DateTime?
  approvedById          String?
  approvedAt            DateTime?
  reason                String?
  notes                 String?
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt

  @@index([proposalId])
  @@index([status])
}

/// The frozen calculation for one proposal version: jurisdiction, the exchange
/// rate used, every tax and charge line, and the statuses.
///
/// This is why refreshing a tax table or a broker schedule cannot restate a
/// proposal that has already gone out. Follows the existing snapshot precedent
/// (PriceSnapshot, RuleEvaluationSnapshot) rather than inventing a pattern.
model ProposalCrossBorderSnapshot {
  id            String   @id @default(cuid())
  proposalId    String
  versionId     String
  /// Resolved jurisdiction: regime, country, province, issues.
  jurisdiction  Json
  /// { pair, rate, observationDate, source, retrievedAt, forDate, stale,
  ///   fallbackUsed, overrideReason }
  fx            Json
  /// Proposal-date FX and acceptance-date FX are separate concepts and separate
  /// keys. Customs FX is a third; it is not the commercial rate.
  acceptanceFx  Json?
  customsFx     Json?
  taxLines      Json
  chargeLines   Json
  statuses      Json
  totalsUsd     Json
  totalsCad     Json
  /// Set when the version is released or accepted. A frozen snapshot is never
  /// updated in place; a revision creates a new version and a new snapshot.
  frozen        Boolean  @default(false)
  createdById   String
  createdAt     DateTime @default(now())

  @@index([proposalId])
  @@index([versionId])
}

/// Singleton configuration row. Cross-border behaviour is OFF until switched on,
/// so deploying this migration changes nothing about any existing proposal.
model CrossBorderSetting {
  id                              String                @id @default("singleton")
  enabled                         Boolean               @default(false)
  defaultImporterOfRecord         ImporterOfRecord      @default(CUSTOMER)
  defaultTaxResponsibility        TaxResponsibilityMode @default(SELLER_COLLECTS)
  allowCadPayment                 Boolean               @default(false)
  fxFallbackMode                  FxFallbackMode        @default(DRAFT_WITH_REVIEW)
  /// Days after which a cached observation is called stale on the proposal.
  staleRateDays                   Int                   @default(5)
  requireCustomsReviewBeforeFinal Boolean               @default(true)
  requireTaxReviewBeforeFinal     Boolean               @default(true)
  proposalValidityDays            Int                   @default(30)
  updatedById                     String?
  createdAt                       DateTime              @default(now())
  updatedAt                       DateTime              @updatedAt
}
`;

if (!existsSync(PATH)) {
  console.error(`${PATH} not found — run this from the repository root.`);
  process.exit(1);
}

const before = readFileSync(PATH, 'utf8');

if (before.includes(MARKER)) {
  console.log('Cross-border models are already present. Nothing to do.');
  process.exit(0);
}

writeFileSync(`${PATH}.bak`, before);
writeFileSync(PATH, `${before.replace(/\s*$/, '')}\n${MODELS}`);

console.log(`Appended the cross-border models to ${PATH} (backup at ${PATH}.bak).`);
console.log('Next: pnpm db:generate, then apply prisma/migrations/0060_cross_border.');

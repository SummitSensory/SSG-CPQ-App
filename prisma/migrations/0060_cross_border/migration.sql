-- Cross-border (Canadian proposal) support.
--
-- Additive only. Creates eleven new tables and eight new enum types, and touches
-- no existing table, column, index or constraint. Nothing here has a foreign key
-- into User, Organization, Proposal or ProposalVersion, so no delete behaviour
-- anywhere in the application changes.
--
-- Cross-border behaviour is OFF after this migration ("CrossBorderSetting"."enabled"
-- defaults to false), so applying it changes nothing about any existing proposal.
--
-- ROLLBACK: see the DROP block at the foot of this file. Because the migration is
-- purely additive, dropping these tables returns the database to its previous
-- state with no data loss outside cross-border data itself.
--
-- ---------------------------------------------------------------------------
-- RATES AND DATES IN THE SEED DATA BELOW ARE NOT AUTHORITATIVE.
--
-- They are a starting configuration, seeded as effective-dated ROWS precisely so
-- that correcting one is an UPDATE rather than a code change. Every rate and every
-- effective date must be confirmed against current CRA and provincial publications
-- by SSG's Canadian tax adviser before "enabled" is switched on.
--
-- Two in particular are flagged in docs/canadian-proposal-support.md as needing
-- confirmation rather than trust: the Nova Scotia HST reduction to 14% and its
-- effective date, and the Saskatchewan PST rate change date.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "CrossBorderTaxType" AS ENUM ('GST', 'HST', 'PST', 'RST', 'QST', 'IMPORT_GST');
CREATE TYPE "TaxRegistrationStatus" AS ENUM ('REGISTERED', 'NOT_REGISTERED', 'PENDING', 'INACTIVE');
CREATE TYPE "TaxResponsibilityMode" AS ENUM ('SELLER_COLLECTS', 'CUSTOMER_PAYS_AT_IMPORT', 'SELLER_IS_IMPORTER_OF_RECORD', 'TAX_EXEMPT', 'REQUIRES_TAX_REVIEW');
CREATE TYPE "ImporterOfRecord" AS ENUM ('CUSTOMER', 'SUMMIT', 'THIRD_PARTY', 'TO_BE_DETERMINED');
CREATE TYPE "CrossBorderChargeCategory" AS ENUM ('EQUIPMENT', 'PARTS', 'FREIGHT', 'INSTALLATION', 'DESIGN', 'TRAINING', 'TRAVEL', 'CUSTOMS_DUTY', 'TARIFF_SURTAX', 'SIMA', 'BROKERAGE', 'BROKER_DISBURSEMENT', 'IMPORT_TAX', 'SALES_TAX', 'DISCOUNT', 'CREDIT', 'OTHER');
CREATE TYPE "FxFallbackMode" AS ENUM ('LAST_CACHED', 'MANUAL_RATE', 'BLOCK_FINALIZATION', 'DRAFT_WITH_REVIEW');
CREATE TYPE "CustomsEntryStatus" AS ENUM ('REQUIRES_CUSTOMS_REVIEW', 'ESTIMATED', 'CONFIRMED', 'NOT_APPLICABLE');
CREATE TYPE "BrokerFeeType" AS ENUM ('FLAT', 'PERCENTAGE', 'TIERED', 'PER_ENTRY', 'PER_SHIPMENT', 'PER_LINE', 'MANUAL');

-- CreateTable
CREATE TABLE "ExchangeRateObservation" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "observationDate" DATE NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "source" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExchangeRateResolution" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "forDate" DATE NOT NULL,
    "observationDate" DATE NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "source" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateResolution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExchangeRateOverride" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CanadianTaxRate" (
    "id" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "taxType" "CrossBorderTaxType" NOT NULL,
    "ratePercent" DECIMAL(7,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "source" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanadianTaxRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CanadianTaxRegistration" (
    "id" TEXT NOT NULL,
    "taxType" "CrossBorderTaxType" NOT NULL,
    "province" TEXT,
    "registrationNumber" TEXT,
    "status" "TaxRegistrationStatus" NOT NULL DEFAULT 'NOT_REGISTERED',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanadianTaxRegistration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrossBorderTaxabilityRule" (
    "id" TEXT NOT NULL,
    "category" "CrossBorderChargeCategory" NOT NULL,
    "taxType" "CrossBorderTaxType" NOT NULL,
    "province" TEXT,
    "taxable" BOOLEAN NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossBorderTaxabilityRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerTaxExemption" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taxTypes" "CrossBorderTaxType"[],
    "exemptionType" TEXT,
    "certificateNumber" TEXT,
    "issuingAuthority" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "attachmentId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTaxExemption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomsBrokerFeeSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brokerName" TEXT,
    "feeType" "BrokerFeeType" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "amountMinor" INTEGER,
    "percent" DECIMAL(7,4),
    "minMinor" INTEGER,
    "maxMinor" INTEGER,
    "tiers" JSONB,
    "disbursementMinor" INTEGER,
    "advancementMinor" INTEGER,
    "bondMinor" INTEGER,
    "customerPaysDirectly" BOOLEAN NOT NULL DEFAULT true,
    "includedInSellerTotal" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomsBrokerFeeSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProposalCustomsEntry" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" "CustomsEntryStatus" NOT NULL DEFAULT 'REQUIRES_CUSTOMS_REVIEW',
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "dutyMinor" INTEGER,
    "surtaxMinor" INTEGER,
    "simaMinor" INTEGER,
    "otherDutyMinor" INTEGER,
    "importTaxMinor" INTEGER,
    "brokerFeeMinor" INTEGER,
    "brokerFeeScheduleId" TEXT,
    "sourceReference" TEXT,
    "basis" TEXT,
    "importerOfRecord" "ImporterOfRecord" NOT NULL DEFAULT 'CUSTOMER',
    "includedInSellerTotal" BOOLEAN NOT NULL DEFAULT false,
    "enteredById" TEXT,
    "enteredAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalCustomsEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProposalCrossBorderSnapshot" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "jurisdiction" JSONB NOT NULL,
    "fx" JSONB NOT NULL,
    "acceptanceFx" JSONB,
    "customsFx" JSONB,
    "taxLines" JSONB NOT NULL,
    "chargeLines" JSONB NOT NULL,
    "statuses" JSONB NOT NULL,
    "totalsUsd" JSONB NOT NULL,
    "totalsCad" JSONB NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalCrossBorderSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CrossBorderSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultImporterOfRecord" "ImporterOfRecord" NOT NULL DEFAULT 'CUSTOMER',
    "defaultTaxResponsibility" "TaxResponsibilityMode" NOT NULL DEFAULT 'SELLER_COLLECTS',
    "allowCadPayment" BOOLEAN NOT NULL DEFAULT false,
    "fxFallbackMode" "FxFallbackMode" NOT NULL DEFAULT 'DRAFT_WITH_REVIEW',
    "staleRateDays" INTEGER NOT NULL DEFAULT 5,
    "requireCustomsReviewBeforeFinal" BOOLEAN NOT NULL DEFAULT true,
    "requireTaxReviewBeforeFinal" BOOLEAN NOT NULL DEFAULT true,
    "proposalValidityDays" INTEGER NOT NULL DEFAULT 30,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossBorderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRateObservation_pair_observationDate_key" ON "ExchangeRateObservation"("pair", "observationDate");
CREATE UNIQUE INDEX "ExchangeRateResolution_pair_forDate_key" ON "ExchangeRateResolution"("pair", "forDate");
CREATE INDEX "ExchangeRateOverride_pair_effectiveDate_idx" ON "ExchangeRateOverride"("pair", "effectiveDate");
CREATE INDEX "CanadianTaxRate_province_taxType_effectiveFrom_idx" ON "CanadianTaxRate"("province", "taxType", "effectiveFrom");
CREATE INDEX "CanadianTaxRegistration_taxType_province_effectiveFrom_idx" ON "CanadianTaxRegistration"("taxType", "province", "effectiveFrom");
CREATE INDEX "CrossBorderTaxabilityRule_category_taxType_idx" ON "CrossBorderTaxabilityRule"("category", "taxType");
CREATE INDEX "CustomerTaxExemption_organizationId_effectiveFrom_idx" ON "CustomerTaxExemption"("organizationId", "effectiveFrom");
CREATE INDEX "CustomsBrokerFeeSchedule_active_effectiveFrom_idx" ON "CustomsBrokerFeeSchedule"("active", "effectiveFrom");
CREATE UNIQUE INDEX "ProposalCustomsEntry_versionId_key" ON "ProposalCustomsEntry"("versionId");
CREATE INDEX "ProposalCustomsEntry_proposalId_idx" ON "ProposalCustomsEntry"("proposalId");
CREATE INDEX "ProposalCustomsEntry_status_idx" ON "ProposalCustomsEntry"("status");
CREATE INDEX "ProposalCrossBorderSnapshot_proposalId_idx" ON "ProposalCrossBorderSnapshot"("proposalId");
CREATE INDEX "ProposalCrossBorderSnapshot_versionId_idx" ON "ProposalCrossBorderSnapshot"("versionId");

-- ---------------------------------------------------------------------------
-- Seed: the configuration singleton. Disabled.
-- ---------------------------------------------------------------------------
INSERT INTO "CrossBorderSetting" ("id", "updatedAt") VALUES ('singleton', CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Seed: sales-tax rates, effective-dated. effectiveTo is EXCLUSIVE, so two rows
-- for the same province and tax type abut exactly and only one is ever in force.
--
-- Nova Scotia is seeded as two rows on purpose: it is the one province in this
-- table that has changed recently, and having both rows means a proposal dated
-- before the change still prices at the rate that was in force on its own date.
-- CONFIRM THE 14% RATE AND ITS DATE BEFORE ENABLING.
-- ---------------------------------------------------------------------------
INSERT INTO "CanadianTaxRate"
  ("id", "province", "taxType", "ratePercent", "effectiveFrom", "effectiveTo", "source", "createdAt", "updatedAt")
VALUES
  ('cbr_ab_gst',    'AB', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_bc_gst',    'BC', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_bc_pst',    'BC', 'PST',  7,      DATE '2013-04-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_mb_gst',    'MB', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_mb_rst',    'MB', 'RST',  7,      DATE '2019-07-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_nb_hst',    'NB', 'HST',  15,     DATE '2016-07-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_nl_hst',    'NL', 'HST',  15,     DATE '2016-07-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_nt_gst',    'NT', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_ns_hst_15', 'NS', 'HST',  15,     DATE '2010-07-01', DATE '2025-04-01', 'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_ns_hst_14', 'NS', 'HST',  14,     DATE '2025-04-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_nu_gst',    'NU', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_on_hst',    'ON', 'HST',  13,     DATE '2010-07-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_pe_hst',    'PE', 'HST',  15,     DATE '2016-10-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_qc_gst',    'QC', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_qc_qst',    'QC', 'QST',  9.975,  DATE '2013-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_sk_gst',    'SK', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_sk_pst',    'SK', 'PST',  6,      DATE '2017-03-23', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cbr_yt_gst',    'YT', 'GST',  5,      DATE '2008-01-01', NULL,              'seed:0060 — CONFIRM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Seed: taxability, for the categories whose treatment is not in doubt.
--
-- Goods, freight, discounts and credits are seeded. The border charges are seeded
-- as NOT taxable, which is correct while the customer is the importer of record:
-- they are not part of SSG's consideration for the supply.
--
-- INSTALLATION, DESIGN, TRAINING, TRAVEL and OTHER are DELIBERATELY NOT SEEDED.
-- Their provincial treatment genuinely varies — installation into real property
-- especially — and the engine's response to a missing rule is
-- `missing_taxability_rule`, which puts the proposal in review. That is the
-- intended behaviour: an unseeded category asks a human rather than guessing.
-- Add rows here once SSG's tax adviser has ruled on each.
-- ---------------------------------------------------------------------------
INSERT INTO "CrossBorderTaxabilityRule"
  ("id", "category", "taxType", "province", "taxable", "effectiveFrom", "effectiveTo", "source", "createdAt", "updatedAt")
SELECT
  'cbt_' || lower(c.category) || '_' || lower(t.tax),
  c.category::"CrossBorderChargeCategory",
  t.tax::"CrossBorderTaxType",
  NULL,
  c.taxable,
  DATE '2008-01-01',
  NULL,
  'seed:0060 — CONFIRM',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (VALUES
  ('EQUIPMENT',           true),
  ('PARTS',               true),
  ('FREIGHT',             true),
  ('DISCOUNT',            true),
  ('CREDIT',              true),
  ('CUSTOMS_DUTY',        false),
  ('TARIFF_SURTAX',       false),
  ('SIMA',                false),
  ('IMPORT_TAX',          false),
  ('BROKERAGE',           false),
  ('BROKER_DISBURSEMENT', false),
  ('SALES_TAX',           false)
) AS c(category, taxable)
CROSS JOIN (VALUES ('GST'), ('HST'), ('PST'), ('RST'), ('QST')) AS t(tax);

-- ---------------------------------------------------------------------------
-- NOT SEEDED, ON PURPOSE: "CanadianTaxRegistration".
--
-- The table is left empty. A province having a rate is not a reason to charge it;
-- a registration is. With no rows, every Canadian proposal returns
-- REQUIRES_TAX_REVIEW and cannot be released as final — which is the correct
-- state until somebody enters SSG's real GST/HST number and any provincial ones.
--
-- Entering the federal registration is the single required admin step to make
-- Canadian proposals releasable. One row, province NULL, covers GST and HST in
-- every province.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ROLLBACK
--
-- DROP TABLE IF EXISTS "ProposalCrossBorderSnapshot", "ProposalCustomsEntry",
--   "CustomsBrokerFeeSchedule", "CustomerTaxExemption", "CrossBorderTaxabilityRule",
--   "CanadianTaxRegistration", "CanadianTaxRate", "ExchangeRateOverride",
--   "ExchangeRateResolution", "ExchangeRateObservation", "CrossBorderSetting";
-- DROP TYPE IF EXISTS "BrokerFeeType", "CustomsEntryStatus", "FxFallbackMode",
--   "CrossBorderChargeCategory", "ImporterOfRecord", "TaxResponsibilityMode",
--   "TaxRegistrationStatus", "CrossBorderTaxType";
-- ---------------------------------------------------------------------------

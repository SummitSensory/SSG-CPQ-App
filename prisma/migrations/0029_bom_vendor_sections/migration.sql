-- 0029_bom_vendor_sections
--
-- Splits the single order-level Bill of Materials header into one section per
-- vendor, and adds the pieces every other BOM feature hangs off:
--
--   * BomVendorSection    per-vendor header, confirm/unlock state, sort order
--   * BomQuestionTemplate reusable per-vendor questions (admin)
--   * BomVendorAnswer     those questions + their answers, snapshotted per order
--   * BomSend             append-only audit of every BOM emailed to a vendor
--   * PowderColorBrand / PowderColor   managed colour palette (brand -> code)
--   * FinanceFactor       Ryan Capital payment factors per term
--
-- Additive only. The order-level header columns on AcceptedOrder stay exactly
-- where they are and become the DEFAULTS a new section inherits, so an order
-- locked before this migration keeps rendering while sections backfill.

-- ---------------------------------------------------------------- enums
CREATE TYPE "BomSectionStatus" AS ENUM ('DRAFT', 'SUBMITTED');
CREATE TYPE "BomQuestionType" AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN');
CREATE TYPE "BomSendFormat" AS ENUM ('EXCEL', 'PDF', 'BOTH');
CREATE TYPE "BomSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'DELIVERED', 'BOUNCED');

-- ---------------------------------------------------------------- sections
CREATE TABLE "BomVendorSection" (
  "id"              TEXT NOT NULL,
  "orderId"         TEXT NOT NULL,
  "vendor"          TEXT NOT NULL,
  "sortOrder"       INTEGER NOT NULL DEFAULT 0,
  "jobName"         TEXT,
  "shipTo"          "BomShipTo" NOT NULL DEFAULT 'CUSTOMER',
  "submittedOn"     TIMESTAMP(3),
  "deliveryType"    TEXT,
  "powderCoatBrand" TEXT,
  "shipmentQuote"   TEXT,
  "notes"           TEXT,
  "status"          "BomSectionStatus" NOT NULL DEFAULT 'DRAFT',
  "confirmedAt"     TIMESTAMP(3),
  "confirmedById"   TEXT,
  "unlockedAt"      TIMESTAMP(3),
  "unlockedById"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BomVendorSection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BomVendorSection_orderId_vendor_key" ON "BomVendorSection"("orderId", "vendor");
CREATE INDEX "BomVendorSection_orderId_idx" ON "BomVendorSection"("orderId");
ALTER TABLE "BomVendorSection"
  ADD CONSTRAINT "BomVendorSection_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- questions
CREATE TABLE "BomQuestionTemplate" (
  "id"        TEXT NOT NULL,
  "vendor"    TEXT,
  "label"     TEXT NOT NULL,
  "type"      "BomQuestionType" NOT NULL DEFAULT 'TEXT',
  "options"   JSONB,
  "helpText"  TEXT,
  "required"  BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BomQuestionTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BomQuestionTemplate_vendor_idx" ON "BomQuestionTemplate"("vendor");

CREATE TABLE "BomVendorAnswer" (
  "id"         TEXT NOT NULL,
  "sectionId"  TEXT NOT NULL,
  "templateId" TEXT,
  "label"      TEXT NOT NULL,
  "type"       "BomQuestionType" NOT NULL DEFAULT 'TEXT',
  "options"    JSONB,
  "required"   BOOLEAN NOT NULL DEFAULT false,
  "value"      TEXT,
  "sortOrder"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BomVendorAnswer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BomVendorAnswer_sectionId_idx" ON "BomVendorAnswer"("sectionId");
ALTER TABLE "BomVendorAnswer"
  ADD CONSTRAINT "BomVendorAnswer_sectionId_fkey" FOREIGN KEY ("sectionId")
  REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- send audit
CREATE TABLE "BomSend" (
  "id"                TEXT NOT NULL,
  "sectionId"         TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "vendor"            TEXT NOT NULL,
  "toEmail"           TEXT NOT NULL,
  "ccEmails"          TEXT,
  "subject"           TEXT NOT NULL,
  "bodyPreview"       TEXT,
  "format"            "BomSendFormat" NOT NULL DEFAULT 'PDF',
  "status"            "BomSendStatus" NOT NULL DEFAULT 'QUEUED',
  "providerMessageId" TEXT,
  "error"             TEXT,
  "sentById"          TEXT NOT NULL,
  "sentAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt"       TIMESTAMP(3),
  "openedAt"          TIMESTAMP(3),
  CONSTRAINT "BomSend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BomSend_sectionId_idx" ON "BomSend"("sectionId");
CREATE INDEX "BomSend_orderId_idx" ON "BomSend"("orderId");
CREATE INDEX "BomSend_providerMessageId_idx" ON "BomSend"("providerMessageId");
ALTER TABLE "BomSend"
  ADD CONSTRAINT "BomSend_sectionId_fkey" FOREIGN KEY ("sectionId")
  REFERENCES "BomVendorSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- colours
-- The brand is a managed list (that is where the spelling drift was); the colour
-- CODE is typed per part, because the brands' catalogues change faster than we
-- could maintain a copy of them.
CREATE TABLE "PowderColorBrand" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "website"   TEXT,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PowderColorBrand_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PowderColorBrand_name_key" ON "PowderColorBrand"("name");

INSERT INTO "PowderColorBrand" ("id", "name", "sortOrder") VALUES
  ('pcb_cardinal',  'Cardinal',  10),
  ('pcb_prismatic', 'Prismatic', 20);

-- ---------------------------------------------------------------- financing
CREATE TABLE "FinanceFactor" (
  "id"          TEXT NOT NULL,
  "termMonths"  INTEGER NOT NULL,
  "factor"      DECIMAL(10,6) NOT NULL,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceFactor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinanceFactor_termMonths_key" ON "FinanceFactor"("termMonths");

-- The factors behind the Ryan Capital sheet, seeded so the financing document
-- calculates on day one. Editable in Administration -> Financing.
INSERT INTO "FinanceFactor" ("id", "termMonths", "factor", "sortOrder") VALUES
  ('ff_term_12', 12, 0.090700, 10),
  ('ff_term_24', 24, 0.047080, 20),
  ('ff_term_36', 36, 0.032700, 30),
  ('ff_term_48', 48, 0.025530, 40),
  ('ff_term_60', 60, 0.021240, 50);

-- ---------------------------------------------------------------- columns
ALTER TABLE "ProcurementLine" ADD COLUMN "powderBrandId" TEXT;
ALTER TABLE "ProcurementLine" ADD COLUMN "powderColorCode" TEXT;
ALTER TABLE "ProcurementLine"
  ADD CONSTRAINT "ProcurementLine_powderBrandId_fkey" FOREIGN KEY ("powderBrandId")
  REFERENCES "PowderColorBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Sku" ADD COLUMN "productUrl" TEXT;
ALTER TABLE "Sku" ADD COLUMN "requiresPowderColor" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Manufacturer" ADD COLUMN "bomEmailTo" TEXT;
ALTER TABLE "Manufacturer" ADD COLUMN "bomEmailCc" TEXT;
ALTER TABLE "Manufacturer" ADD COLUMN "bomEmailSubject" TEXT;
ALTER TABLE "Manufacturer" ADD COLUMN "bomEmailBody" TEXT;
ALTER TABLE "Manufacturer" ADD COLUMN "bomEmailFormat" "BomSendFormat" NOT NULL DEFAULT 'PDF';

-- ---------------------------------------------------------------- backfill
-- One section per (order, vendor) already present in the procurement lines,
-- inheriting the order-level header so nothing on screen changes value. Vendors
-- are numbered alphabetically with 'Unassigned vendor' last, matching the order
-- the UI already renders them in.
INSERT INTO "BomVendorSection" (
  "id", "orderId", "vendor", "sortOrder", "jobName", "shipTo", "submittedOn",
  "deliveryType", "powderCoatBrand", "shipmentQuote", "notes", "status", "updatedAt"
)
SELECT
  'bvs_' || substr(md5(v."orderId" || '|' || v."vendor"), 1, 20),
  v."orderId",
  v."vendor",
  (row_number() OVER (
     PARTITION BY v."orderId"
     ORDER BY (v."vendor" = 'Unassigned vendor'), v."vendor"
   ))::int * 10,
  o."jobName", o."bomShipTo", o."bomSubmittedOn",
  o."deliveryType", o."powderCoatBrand", o."shipmentQuote", o."bomNotes",
  'DRAFT', CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT
    pl."orderId",
    COALESCE(NULLIF(btrim(pl."vendor"), ''), 'Unassigned vendor') AS "vendor"
  FROM "ProcurementLine" pl
) v
JOIN "AcceptedOrder" o ON o."id" = v."orderId"
ON CONFLICT ("orderId", "vendor") DO NOTHING;

-- Existing free-typed powder colours are left exactly as they are on the line.
-- They are matched to a brand only when an operator picks one, so no historic BOM
-- silently changes wording.

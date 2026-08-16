-- Ryan Capital financing rate sheets: amount band x term, versioned.
-- Additive. FinanceFactor is left in place and still read as a fallback until a
-- card is published, so this migration changes no existing behaviour on its own.

ALTER TABLE "ProposalVersion" ADD COLUMN "financeRateCardId" TEXT;

CREATE TABLE "FinanceRateCard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "effectiveOn" DATE NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceRateCard_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinanceRateCard_active_effectiveOn_idx" ON "FinanceRateCard"("active", "effectiveOn");

CREATE TABLE "FinanceRateBand" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minMinor" INTEGER NOT NULL,
    "maxMinor" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FinanceRateBand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinanceRateBand_cardId_minMinor_idx" ON "FinanceRateBand"("cardId", "minMinor");

ALTER TABLE "FinanceRateBand"
  ADD CONSTRAINT "FinanceRateBand_cardId_fkey" FOREIGN KEY ("cardId")
  REFERENCES "FinanceRateCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FinanceRate" (
    "id" TEXT NOT NULL,
    "bandId" TEXT NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "factor" DECIMAL(10,6) NOT NULL,

    CONSTRAINT "FinanceRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FinanceRate_bandId_termMonths_key" ON "FinanceRate"("bandId", "termMonths");
CREATE INDEX "FinanceRate_termMonths_idx" ON "FinanceRate"("termMonths");

ALTER TABLE "FinanceRate"
  ADD CONSTRAINT "FinanceRate_bandId_fkey" FOREIGN KEY ("bandId")
  REFERENCES "FinanceRateBand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 0118_color_upcharge_push
--
-- The ledger of Prismatic (portal colour) upcharges billed to QuickBooks. The
-- customer portal prices the upcharge when colours are confirmed; nothing put it on
-- an invoice, so it relied on someone remembering. Each row is one change to what has
-- been billed for an order's upcharge — added to the invoice, raised as an
-- upcharge-only invoice, reduced, or recorded as handled outside the CRM.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ColorUpchargeMode') THEN
  CREATE TYPE "ColorUpchargeMode" AS ENUM ('AMEND', 'SUPPLEMENT', 'REDUCE', 'MANUAL');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ColorUpchargePush" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "pushKey" TEXT NOT NULL,
    "portalContentHash" TEXT NOT NULL,
    "portalTotalMinor" BIGINT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "mode" "ColorUpchargeMode" NOT NULL,
    "invoiceTxnId" TEXT,
    "qboDocNumber" TEXT,
    "previousTotalMinor" BIGINT,
    "newTotalMinor" BIGINT,
    "note" TEXT,
    "pushedById" TEXT NOT NULL,
    "pushedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ColorUpchargePush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ColorUpchargePush_pushKey_key" ON "ColorUpchargePush"("pushKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ColorUpchargePush_orderId_idx" ON "ColorUpchargePush"("orderId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ColorUpchargePush_orderId_fkey') THEN
    ALTER TABLE "ColorUpchargePush" ADD CONSTRAINT "ColorUpchargePush_orderId_fkey" FOREIGN KEY ("orderId")
      REFERENCES "AcceptedOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

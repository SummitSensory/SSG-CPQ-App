-- Ship-to address book, per-vendor freight source, and the estimated tax figure.
--
-- Three related changes to the Bill of Materials:
--   * an order can now ship somewhere that is neither the customer's site nor
--     Summit's dock, and that address is reusable across vendors and orders;
--   * each vendor's sheet knows which freight figure on the deal is theirs — the
--     mats ship on their own line, everything else on the structure line;
--   * the deal's estimated tax is carried onto the sheet.

CREATE TYPE "BomFreightSource" AS ENUM ('STRUCTURE', 'MATS', 'NONE');

ALTER TABLE "Manufacturer"
    ADD COLUMN "bomFreightSource" "BomFreightSource" NOT NULL DEFAULT 'STRUCTURE';

CREATE TABLE "ShipToAddress" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'USA',
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipToAddress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipToAddress_name_idx" ON "ShipToAddress"("name");

ALTER TABLE "BomVendorSection"
    ADD COLUMN "shipToAddressId" TEXT,
    ADD COLUMN "estimatedTax" TEXT;

ALTER TABLE "BomVendorSection"
    ADD CONSTRAINT "BomVendorSection_shipToAddressId_fkey"
    FOREIGN KEY ("shipToAddressId") REFERENCES "ShipToAddress"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The mat vendor quotes the mats freight line. Named rather than inferred, so a
-- second mat supplier is a one-row change.
UPDATE "Manufacturer" SET "bomFreightSource" = 'MATS' WHERE lower("name") = 'resilite';

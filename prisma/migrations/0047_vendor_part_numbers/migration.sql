-- Vendor part numbers: what a supplier calls a part we number ourselves.
--
-- Keyed on the vendor AND our part number, so two vendors may number the same part
-- differently. "ourPart" is intentionally not a foreign key to Sku: Adventure mat
-- numbers (R-SSG-1010CLM) are generated at price time and have no catalog row, and
-- they are the main thing this table maps.

CREATE TABLE "VendorPartNumber" (
    "id" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "ourPart" TEXT NOT NULL,
    "vendorPart" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorPartNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VendorPartNumber_manufacturerId_ourPart_key"
    ON "VendorPartNumber"("manufacturerId", "ourPart");

CREATE INDEX "VendorPartNumber_ourPart_idx" ON "VendorPartNumber"("ourPart");

ALTER TABLE "VendorPartNumber"
    ADD CONSTRAINT "VendorPartNumber_manufacturerId_fkey"
    FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

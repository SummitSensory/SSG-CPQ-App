-- Standard proposal notes: reusable boilerplate blocks that print either inside
-- the line-item table or below the signature lines. Notes marked autoInclude are
-- added to every new proposal automatically.

CREATE TYPE "NotePlacement" AS ENUM ('TABLE', 'FOOTER');

CREATE TABLE "StandardNote" (
  "id"          TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "placement"   "NotePlacement" NOT NULL DEFAULT 'TABLE',
  "autoInclude" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StandardNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StandardNote_active_placement_sortOrder_idx"
  ON "StandardNote" ("active", "placement", "sortOrder");

-- Seed the three notes that were previously hard-coded in the builder. The first
-- prints on every proposal, so it is flagged autoInclude.
INSERT INTO "StandardNote" ("id", "title", "body", "placement", "autoInclude", "sortOrder", "updatedAt") VALUES
  ('sn_important_details', 'Important Proposal Details',
   'This proposal serves as a detailed estimate of the total cost for the products and services outlined and does not constitute an invoice. Once signed and returned, it becomes a binding agreement, confirming acceptance of the order and associated payment terms. A **50% deposit is required to initiate production**, with the remaining balance due prior to shipment. The signed proposal may be returned by mail or fax using the contact information provided above. For payments made by credit card, a 3.5% processing fee will be added to the total amount.',
   'TABLE', true, 0, CURRENT_TIMESTAMP),
  ('sn_crating_freight', 'Crating & Freight',
   'Final crating and freight charges will be calculated and invoiced at the time of shipment based on the actual costs incurred and the rates in effect at that time. Summit makes no representations or warranties regarding the availability or stability of crating costs or freight rates prior to shipment.',
   'TABLE', false, 1, CURRENT_TIMESTAMP),
  ('sn_freight_taxes', 'Freight & Taxes',
   'Freight charges and all applicable taxes included in this proposal are strictly our best estimates of total freight and anticipated tax expense. Final freight and tax amounts will be based on the shipment destination, carrier rates in effect at the time of shipment, and applicable tax requirements.',
   'TABLE', false, 2, CURRENT_TIMESTAMP),
  ('sn_acceptance_footer', 'Acceptance & Next Steps',
   'By signing above, the customer authorizes Summit Sensory Gym to proceed with production of the items listed in this proposal. **A countersigned copy and the 50% deposit are required before production begins.** Lead times quoted are estimates from the date of signed acceptance and receipt of deposit.',
   'FOOTER', true, 0, CURRENT_TIMESTAMP);

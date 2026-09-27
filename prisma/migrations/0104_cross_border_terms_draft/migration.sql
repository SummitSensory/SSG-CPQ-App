-- 0104_cross_border_terms_draft
--
-- Adds a DRAFT list for the Cross-Border Terms, so legal wording can be written,
-- previewed and reviewed without printing on customer proposals until someone with
-- access publishes it (Administration -> Canada -> Cross-Border Terms -> Draft).
--
-- Adds CrossBorderSetting."crossBorderTermsDraft" (JSONB, nullable). Nothing reads
-- it when a proposal prints. Seeds it with a reconciled draft for Summit and its
-- counsel to review: one statement of Summit's tariff classification (as a fill-in
-- field), 9979.00.00 worded as a claim in addition to that classification, one
-- importer-of-record clause per model (Summit / not Summit) with Summit's
-- reassessment clause under the Summit model, four overlapping estimate clauses
-- merged into one, the duplicate standard-rate GST/HST clause dropped, and host
-- system identification printed only for replacement/expansion parts.
--
-- Guarded: the column is added only if missing, and the draft is written only while
-- the column is still NULL, so a re-run never overwrites a draft being edited.

-- AlterTable
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "crossBorderTermsDraft" JSONB;

-- Seed
UPDATE "CrossBorderSetting"
SET "crossBorderTermsDraft" = $draft$[
  {
    "id": "draft-currency-and-exchange-rate",
    "title": "Currency and Exchange Rate",
    "text": "All quoted prices and contractual payment obligations are denominated in United States dollars (USD). Canadian-dollar (CAD) amounts are provided for reference and budgeting convenience only. Estimated CAD amounts are calculated using the Bank of Canada daily average USD/CAD exchange rate published for {{fxDate}}, at a rate of 1 USD = {{fxRate}} CAD. If this proposal is accepted, the CAD reference amounts will be recalculated and locked using the most recently published Bank of Canada daily average rate on or before the date of acceptance. Payment remains due in USD unless Summit Sensory Gym expressly agrees in writing to accept payment in CAD. In the event of any discrepancy, the USD amounts control. The exchange rate shown may differ from the rate offered by the customer’s bank or payment provider.",
    "condition": "ALWAYS",
    "order": 0
  },
  {
    "id": "draft-bank-and-payment-fees",
    "title": "Payment and Bank Fees",
    "text": "The customer is responsible for any wire-transfer fees, intermediary-bank fees, credit-card fees where permitted, foreign-exchange charges, or other payment-processing costs imposed by the customer’s financial institution or payment provider. Summit Sensory Gym must receive the full invoiced amount.",
    "condition": "ALWAYS",
    "order": 1
  },
  {
    "id": "draft-classification",
    "title": "Tariff Classification",
    "condition": "ALWAYS",
    "text": "Summit systems are engineered therapeutic apparatus for occupational and physical therapy use, designed and load-analyzed by a licensed professional engineer for dynamic suspended therapeutic loads. Summit Sensory Gym’s position is that the goods on this proposal are classified under tariff item {{tariffClassification}} of the Customs Tariff, supported by Summit’s design and engineering documentation and reviewed by Summit’s Canadian customs broker. That documentation is available on request to the importer of record, its customs broker or the Canada Border Services Agency (CBSA). Summit has applied, or will apply, to CBSA for an advance ruling confirming this classification. The Customer acknowledges that this classification represents Summit’s supported position and has not yet been confirmed by CBSA; classification is finally determined by CBSA.",
    "order": 2
  },
  {
    "id": "draft-9979-claimed",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "condition": "TARIFF_9979_CLAIMED",
    "text": "In addition to the classification above, the goods are claimed under tariff item 9979.00.00 of the Customs Tariff, which provides relief from customs duty for goods specifically designed to assist persons with disabilities. The claim is subject to review and final determination by CBSA at the time of importation.",
    "order": 3
  },
  {
    "id": "draft-9979-not-claimed",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "text": "The goods on this proposal are not being entered under tariff item 9979.00.00 of the Canadian Customs Tariff. Standard customs duty treatment applies, subject to the classification determined by the Canada Border Services Agency at the time of importation.",
    "condition": "TARIFF_9979_NOT_CLAIMED",
    "order": 4
  },
  {
    "id": "draft-9979-undetermined",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "text": "Whether the goods on this proposal will be entered under tariff item 9979.00.00 of the Canadian Customs Tariff has not yet been determined. This proposal does not assume relief under that item; confirm eligibility and classification with your customs broker before relying on it.",
    "condition": "TARIFF_9979_UNDETERMINED",
    "order": 5
  },
  {
    "id": "draft-9979-diversion",
    "title": "Diversion of Goods Entered Under Tariff Item 9979.00.00",
    "text": "If any good entered into Canada under tariff item 9979.00.00 of the Canadian Customs Tariff is later sold, leased, or otherwise diverted to a use that does not qualify for that tariff item, the party responsible for the customs accounting on this shipment must correct that accounting and pay any customs duty and other charges that become owing as a result, in accordance with the Canadian Customs Tariff and the Accounting for Imported Goods and Payment of Duties Regulations.",
    "condition": "TARIFF_9979_CLAIMED",
    "order": 6
  },
  {
    "id": "draft-ior-summit",
    "title": "Importer of Record and Import Charges",
    "condition": "IOR_SUMMIT",
    "text": "Summit Sensory Gym is the importer of record for this shipment and is responsible to CBSA for accounting for the goods and paying the customs duties, surtaxes and import taxes assessed at importation. Those charges, and customs brokerage, are shown separately on this proposal, are not included in the equipment price, and are billed to the Customer at actual cost.",
    "order": 7
  },
  {
    "id": "draft-reassessment",
    "title": "Reassessment of Canadian Import Charges",
    "condition": "IOR_SUMMIT",
    "text": "If CBSA issues a final determination reassessing the goods under a classification other than that stated in these terms, and that determination results in additional customs duty, surtax, interest, administrative monetary penalties or broker fees, the Customer will reimburse Summit for fifty percent (50%) of those amounts.\n\nSummit will control any response, review or appeal and will pursue any reasonable avenue to reduce or eliminate the assessment before invoking this clause. The Customer’s obligation arises only on a final determination after Summit’s rights of review and appeal are exhausted or knowingly not pursued, and only where Summit gives written notice with the supporting CBSA documentation. Payment is due within thirty (30) days of that notice.\n\nThis obligation expires if CBSA has not issued a reassessment within four (4) years of the accounting date for the shipment.\n\nIf Summit subsequently recovers any amount contributed by the Customer, Summit will credit that amount to the Customer in full.\n\nThe Customer will provide any documentation CBSA reasonably requests regarding the use of the goods and will not take a position on classification inconsistent with these terms.\n\nThe person signing this proposal confirms they are authorized to bind the Customer to this clause.",
    "order": 8
  },
  {
    "id": "draft-ior-not-summit",
    "title": "Importer of Record and Border Charges",
    "condition": "IOR_NOT_SUMMIT",
    "text": "Summit Sensory Gym is not the importer of record for this shipment (importer of record: {{importerOfRecord}}). Except for any amount expressly identified on this proposal as fixed and included in the total payable to Summit Sensory Gym, the customer is responsible for all customs duties, tariffs, surtaxes, safeguard and anti-dumping measures, import taxes, brokerage charges, storage, demurrage, examination and inspection fees, disbursements and penalties assessed on the importation of the goods, together with any increase in those amounts arising after the proposal date. Summit Sensory Gym has no control over the classification, valuation or rate applied by the Canada Border Services Agency or by the customs broker and is not liable for any such charge, for any increase in one, or for delay, storage or additional cost arising from a customs examination, a re-determination of classification or origin, or a change in law. Where Summit Sensory Gym advances any such amount on the customer’s behalf, it is reimbursable in full.",
    "order": 9
  },
  {
    "id": "draft-estimates",
    "title": "Estimates and Changes in Government Charges",
    "condition": "ALWAYS",
    "text": "Any customs duty, surtax, import tax or brokerage figure on this proposal is an estimate made on the proposal date from the tariff classification, country of origin, customs value, trade-agreement eligibility, exchange rate and government rules known on that date. It is not a quotation of, or a cap on, the amounts CBSA or the customs broker will assess, which are determined under the laws and rates in effect when the goods are imported and may increase or decrease. Tariff rates, surtax and remission orders and other government charges change without notice; any new or increased charge that applies after the proposal date and before importation, delivery or invoicing may be added to the amount payable unless Summit Sensory Gym has agreed in writing to absorb it. Unless expressly identified as fixed and included, any difference between estimated and actual border assessments is the Customer’s responsibility. These estimates do not constitute customs, tax or legal advice; the Customer is encouraged to confirm them with its own customs broker before relying on them for budgeting.",
    "order": 10
  },
  {
    "id": "draft-canadian-sales-taxes",
    "title": "Canadian Sales Taxes",
    "text": "Applicable GST, HST, PST, RST, or QST will be determined based on the ship-to location, the nature of the goods and services supplied, Summit Sensory Gym’s applicable registration obligations, the customer’s documented tax status, and the laws and rates in effect at the time of invoicing or shipment. Tax amounts shown on this proposal are estimates and may be revised on the final invoice if the delivery location, applicable rate, taxability, exemption status, transaction structure, or governing law changes. Any valid exemption documentation must be provided and approved before the final invoice is issued.",
    "condition": "ALWAYS",
    "order": 11
  },
  {
    "id": "draft-gst-relief",
    "title": "GST/HST Treatment",
    "text": "Goods qualify for relief as medical and assistive devices — confirm with broker.",
    "condition": "GST_RELIEF",
    "order": 12
  },
  {
    "id": "draft-gst-undetermined",
    "title": "GST/HST Treatment",
    "text": "Whether these goods qualify for GST/HST relief as medical and assistive devices has not yet been determined for this proposal. Standard tax treatment is assumed on this estimate until confirmed otherwise; confirm the applicable treatment with your customs broker or tax advisor before relying on this proposal for tax planning.",
    "condition": "GST_UNDETERMINED",
    "order": 13
  },
  {
    "id": "draft-customer-tax-rebates",
    "title": "Customer Tax Rebates",
    "text": "The customer may be eligible to apply for a tax rebate or recovery based on its own legal or organizational status. Any such rebate is the customer’s responsibility and does not reduce the tax charged by Summit Sensory Gym unless a valid point-of-sale exemption applies and the required documentation has been received and approved.",
    "condition": "ALWAYS",
    "order": 14
  },
  {
    "id": "draft-cusma-treatment",
    "title": "CUSMA Treatment",
    "text": "Preferential tariff treatment under the Canada–United States–Mexico Agreement applies only when the goods satisfy the applicable rules of origin and the required origin documentation is available and accepted. Shipment from the United States does not, by itself, establish eligibility for preferential tariff treatment.",
    "condition": "ALWAYS",
    "order": 15
  },
  {
    "id": "draft-customs-brokerage",
    "title": "Customs Brokerage Extras",
    "text": "Additional disbursement, advancement, bond, inspection, storage, carrier, port, redelivery, or other accessorial charges may apply. Unless expressly included as a fixed charge, these additional third-party costs are the customer’s responsibility.",
    "condition": "ALWAYS",
    "order": 16
  },
  {
    "id": "draft-canadian-delivery-charges",
    "title": "Canadian Delivery Charges",
    "text": "Freight is based on the delivery conditions and information available on the proposal date. Additional charges may apply for limited-access locations, appointment delivery, liftgate service, inside delivery, remote-area service, construction delays, storage, redelivery, address changes, border delays, or other services not included in the original freight quotation.",
    "condition": "ALWAYS",
    "order": 17
  },
  {
    "id": "draft-host-system",
    "title": "Host System Identification",
    "condition": "HOST_SYSTEM_PRESENT",
    "text": "The components on this proposal are replacement or expansion parts for the Customer’s existing Summit Sensory Gym system, {{hostSystem}}, and are identified to that host system, consistent with CBSA’s treatment of parts for equipment previously qualifying under tariff item 9979.00.00.",
    "order": 18
  }
]$draft$::jsonb
WHERE "crossBorderTermsDraft" IS NULL;

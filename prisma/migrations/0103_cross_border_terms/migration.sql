-- 0103_cross_border_terms
--
-- Makes the "Cross-Border Terms" on a Canadian proposal editable in Administration
-- (Canada -> Cross-Border Terms) instead of hard-coded in public/proposal-document.js.
--
-- Adds CrossBorderSetting."crossBorderTerms" (JSONB, nullable) and seeds it with the
-- exact wording the document printed before this change, one entry per clause. The
-- clauses that used to change with the customs entry (GST/HST treatment, tariff item
-- 9979.00.00, the diversion clause, the named host system) are seeded as separate
-- entries with a "condition", so every existing Canadian proposal prints exactly what
-- it printed before. {{fxDate}}, {{fxRate}} and {{hostSystem}} are filled from the
-- proposal when it prints.
--
-- Statements are guarded so a re-run is harmless: migrate-deploy.mjs runs on
-- every deploy and a half-applied migration must be repairable by running it again.
-- The seed only fills a column that is still NULL, so it never overwrites an edit.

-- AlterTable
ALTER TABLE "CrossBorderSetting" ADD COLUMN IF NOT EXISTS "crossBorderTerms" JSONB;

-- Seed
UPDATE "CrossBorderSetting"
SET "crossBorderTerms" = $terms$[
  {
    "id": "cbt-currency-and-exchange-rate",
    "title": "Currency and Exchange Rate",
    "text": "All quoted prices and contractual payment obligations are denominated in United States dollars (USD). Canadian-dollar (CAD) amounts are provided for reference and budgeting convenience only. Estimated CAD amounts are calculated using the Bank of Canada daily average USD/CAD exchange rate published for {{fxDate}}, at a rate of 1 USD = {{fxRate}} CAD. If this proposal is accepted, the CAD reference amounts will be recalculated and locked using the most recently published Bank of Canada daily average rate on or before the date of acceptance. Payment remains due in USD unless Summit Sensory Gym expressly agrees in writing to accept payment in CAD. In the event of any discrepancy, the USD amounts control. The exchange rate shown may differ from the rate offered by the customer’s bank or payment provider.",
    "condition": "ALWAYS",
    "order": 0
  },
  {
    "id": "cbt-bank-and-payment-fees",
    "title": "Bank and Payment Fees",
    "text": "The customer is responsible for any wire-transfer fees, intermediary-bank fees, credit-card fees where permitted, foreign-exchange charges, or other payment-processing costs imposed by the customer’s financial institution or payment provider. Summit Sensory Gym must receive the full invoiced amount.",
    "condition": "ALWAYS",
    "order": 1
  },
  {
    "id": "cbt-canadian-sales-taxes",
    "title": "Canadian Sales Taxes",
    "text": "Applicable GST, HST, PST, RST, or QST will be determined based on the ship-to location, the nature of the goods and services supplied, Summit Sensory Gym’s applicable registration obligations, the customer’s documented tax status, and the laws and rates in effect at the time of invoicing or shipment. Tax amounts shown on this proposal are estimates and may be revised on the final invoice if the delivery location, applicable rate, taxability, exemption status, transaction structure, or governing law changes. Any valid exemption documentation must be provided and approved before the final invoice is issued.",
    "condition": "ALWAYS",
    "order": 2
  },
  {
    "id": "cbt-gst-standard",
    "title": "GST/HST Treatment",
    "text": "Standard rate applies.",
    "condition": "GST_STANDARD",
    "order": 3
  },
  {
    "id": "cbt-gst-relief",
    "title": "GST/HST Treatment",
    "text": "Goods qualify for relief as medical and assistive devices — confirm with broker.",
    "condition": "GST_RELIEF",
    "order": 4
  },
  {
    "id": "cbt-gst-undetermined",
    "title": "GST/HST Treatment",
    "text": "Whether these goods qualify for GST/HST relief as medical and assistive devices has not yet been determined for this proposal. Standard tax treatment is assumed on this estimate until confirmed otherwise; confirm the applicable treatment with your customs broker or tax advisor before relying on this proposal for tax planning.",
    "condition": "GST_UNDETERMINED",
    "order": 5
  },
  {
    "id": "cbt-basis-of-the-estimates",
    "title": "Basis of the Estimates",
    "text": "The tariff and tax rates applied on this proposal were entered by Summit Sensory Gym based on the information available for goods of this kind. They are not derived from a tariff classification ruling, a country-of-origin determination or an advance ruling from the Canada Border Services Agency, and they do not constitute customs, tax or legal advice. The customer is encouraged to confirm the applicable rates with their own customs broker before relying on these figures for budgeting.",
    "condition": "ALWAYS",
    "order": 6
  },
  {
    "id": "cbt-customs-duties-and-tariffs",
    "title": "Customs Duties and Tariffs",
    "text": "Customs duties, counter-tariffs, surtaxes, safeguard measures, anti-dumping duties, countervailing duties, and other border assessments shown in this proposal are estimates based on the product information, tariff classification, country of origin, customs value, trade-agreement eligibility, exchange-rate information, and government rules available on the proposal date. Final amounts are determined by the Canada Border Services Agency or the authorized customs broker under the laws and rates in effect when the goods are imported. Unless expressly identified as fixed and included, any difference between estimated and actual border assessments is the customer’s responsibility.",
    "condition": "ALWAYS",
    "order": 7
  },
  {
    "id": "cbt-estimated-tariffs-are-dated-to-this-proposal",
    "title": "Estimated Tariffs Are Dated to This Proposal",
    "text": "Any tariff, duty, surtax or brokerage figure shown on this proposal is an estimate calculated on the proposal date, using the rates in effect and the information available on that date. Tariff rates, surtax orders and remission orders are set by government and change without notice, sometimes between the date a proposal is issued and the date the goods cross the border. The figures shown are not a quotation of, or a cap on, the amounts that will ultimately be assessed, and they may increase or decrease.",
    "condition": "ALWAYS",
    "order": 8
  },
  {
    "id": "cbt-9979-claimed",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "text": "Summit Sensory Gym has identified the goods on this proposal as eligible for classification under tariff item 9979.00.00 of the Canadian Customs Tariff, which provides relief from customs duty for goods designed to assist persons with disabilities. This classification is subject to review and final determination by the Canada Border Services Agency at the time of importation.",
    "condition": "TARIFF_9979_CLAIMED",
    "order": 9
  },
  {
    "id": "cbt-9979-not-claimed",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "text": "The goods on this proposal are not being entered under tariff item 9979.00.00 of the Canadian Customs Tariff. Standard customs duty treatment applies, subject to the classification determined by the Canada Border Services Agency at the time of importation.",
    "condition": "TARIFF_9979_NOT_CLAIMED",
    "order": 10
  },
  {
    "id": "cbt-9979-undetermined",
    "title": "Tariff Item 9979.00.00 (Goods for Persons with Disabilities)",
    "text": "Whether the goods on this proposal will be entered under tariff item 9979.00.00 of the Canadian Customs Tariff has not yet been determined. This proposal does not assume relief under that item; confirm eligibility and classification with your customs broker before relying on it.",
    "condition": "TARIFF_9979_UNDETERMINED",
    "order": 11
  },
  {
    "id": "cbt-9979-diversion",
    "title": "Diversion of Goods Entered Under Tariff Item 9979.00.00",
    "text": "If any good entered into Canada under tariff item 9979.00.00 of the Canadian Customs Tariff is later sold, leased, or otherwise diverted to a use that does not qualify for that tariff item, the party responsible for the customs accounting on this shipment must correct that accounting and pay any customs duty and other charges that become owing as a result, in accordance with the Canadian Customs Tariff and the Accounting for Imported Goods and Payment of Duties Regulations.",
    "condition": "TARIFF_9979_CLAIMED",
    "order": 12
  },
  {
    "id": "cbt-design-and-engineering-documentation",
    "title": "Design and Engineering Documentation",
    "text": "Summit Sensory Gym maintains design, engineering and clinical documentation supporting the intended use of this equipment by persons with disabilities. That documentation is available on request to whoever is handling customs clearance for this shipment, or directly to the Canada Border Services Agency.",
    "condition": "ALWAYS",
    "order": 13
  },
  {
    "id": "cbt-host-system",
    "title": "Host System Identification",
    "text": "Where any component on this proposal is a replacement or expansion part for an existing Summit Sensory Gym system rather than part of a new, complete system, it is identified to the host system it belongs to, consistent with the Canada Border Services Agency’s treatment of parts for equipment previously qualifying under tariff item 9979.00.00.",
    "condition": "ALWAYS",
    "order": 14
  },
  {
    "id": "cbt-host-system-named",
    "title": "Existing System",
    "text": "This proposal is for replacement or expansion components for the customer’s existing system: {{hostSystem}}.",
    "condition": "HOST_SYSTEM_PRESENT",
    "order": 15
  },
  {
    "id": "cbt-responsibility-for-border-charges",
    "title": "Responsibility for Border Charges",
    "text": "Except for any amount expressly identified on this proposal as fixed and included in the total payable to Summit Sensory Gym, the customer is responsible for all customs duties, tariffs, surtaxes, safeguard and anti-dumping measures, import taxes, brokerage charges, storage, demurrage, examination and inspection fees, disbursements and penalties assessed on the importation of the goods, together with any increase in those amounts arising after the proposal date. Summit Sensory Gym has no control over the classification, valuation or rate applied by the Canada Border Services Agency or by the customs broker and is not liable for any such charge, for any increase in one, or for delay, storage or additional cost arising from a customs examination, a re-determination of classification or origin, or a change in law. Where Summit Sensory Gym advances any such amount on the customer’s behalf, it is reimbursable in full.",
    "condition": "ALWAYS",
    "order": 16
  },
  {
    "id": "cbt-cusma-treatment",
    "title": "CUSMA Treatment",
    "text": "Preferential tariff treatment under the Canada–United States–Mexico Agreement applies only when the goods satisfy the applicable rules of origin and the required origin documentation is available and accepted. Shipment from the United States does not, by itself, establish eligibility for preferential tariff treatment.",
    "condition": "ALWAYS",
    "order": 17
  },
  {
    "id": "cbt-customs-brokerage",
    "title": "Customs Brokerage",
    "text": "Additional disbursement, advancement, bond, inspection, storage, carrier, port, redelivery, or other accessorial charges may apply. Unless expressly included as a fixed charge, these additional third-party costs are the customer’s responsibility.",
    "condition": "ALWAYS",
    "order": 18
  },
  {
    "id": "cbt-changes-in-government-charges",
    "title": "Changes in Government Charges",
    "text": "Taxes, duties, tariffs, surtaxes, trade remedies, customs requirements, and government fees are subject to change. Any new or increased governmental charge that becomes applicable after the proposal date and before importation, delivery, or invoicing may be added to the final amount payable, unless Summit Sensory Gym has expressly agreed in writing to absorb that charge.",
    "condition": "ALWAYS",
    "order": 19
  },
  {
    "id": "cbt-canadian-delivery-charges",
    "title": "Canadian Delivery Charges",
    "text": "Freight is based on the delivery conditions and information available on the proposal date. Additional charges may apply for limited-access locations, appointment delivery, liftgate service, inside delivery, remote-area service, construction delays, storage, redelivery, address changes, border delays, or other services not included in the original freight quotation.",
    "condition": "ALWAYS",
    "order": 20
  },
  {
    "id": "cbt-customer-tax-rebates",
    "title": "Customer Tax Rebates",
    "text": "The customer may be eligible to apply for a tax rebate or recovery based on its own legal or organizational status. Any such rebate is the customer’s responsibility and does not reduce the tax charged by Summit Sensory Gym unless a valid point-of-sale exemption applies and the required documentation has been received and approved.",
    "condition": "ALWAYS",
    "order": 21
  }
]$terms$::jsonb
WHERE "crossBorderTerms" IS NULL;

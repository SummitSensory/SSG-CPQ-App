# UAT_TEST_CASES.md — Summit Sensory Gym CPQ

Each case carries: **Test ID · Preconditions · User role · Input data · Steps · Expected result**.
Execution fields (**Actual result · Pass/Fail · Defect ID · Severity · Evidence**) are filled during
runs and mirrored in `UAT_RESULTS.md`; a blank execution block is included at the end of every case.

Test-data conventions: money shown as dollars but stored as integer cents; "Acme Therapy" = new org;
"Northside Clinic" = pre-existing org; roles map to seeded UAT users (rep1, mgr1, ops1, pm1, install1,
acct1, exec1).

---

### UAT-01 — Create a new customer
- **Preconditions:** logged in; org "Acme Therapy" does not exist.
- **User role:** Sales Rep.
- **Input data:** org name "Acme Therapy", type "New", primary contact name/email/phone, billing +
  site address.
- **Steps:** 1) Customers → New. 2) Enter org + contact. 3) Save.
- **Expected result:** org + contact created, owner = rep1, source id preserved if imported; appears in
  the rep's customer list; audit entry recorded; no duplicate created.

### UAT-02 — Create an opportunity
- **Preconditions:** "Acme Therapy" exists.
- **User role:** Sales Rep.
- **Input data:** opportunity name, stage "Discovery", estimated value, primary contact.
- **Steps:** 1) Open org → New Opportunity. 2) Fill fields. 3) Save.
- **Expected result:** opportunity created linked to org + owner; appears in pipeline at "Discovery";
  editable only by owner/managers.

### UAT-03 — Record facility information
- **Preconditions:** opportunity exists.
- **User role:** Sales Rep.
- **Input data:** facility dimensions, ceiling height, floor type, access constraints, power/network,
  dock/hours.
- **Steps:** 1) Opportunity → Facility. 2) Enter details. 3) Save.
- **Expected result:** facility record saved against the opportunity; used later to seed installation
  + facility-access handoff requirements; persists across sessions.

### UAT-04 — Configure each major product family
- **Preconditions:** catalog + configuration rules seeded.
- **User role:** Sales Rep.
- **Input data:** one representative configuration per major product family (run the case once per
  family).
- **Steps:** 1) New proposal on the opportunity. 2) Add a product from the family. 3) Complete required
  options. 4) Add to proposal.
- **Expected result:** each family configures with valid option sets; included/excluded items resolve
  correctly; line appears with correct base price; invalid option combos are prevented (see UAT-05/06).

### UAT-05 — Trigger required-product rule
- **Preconditions:** a product with a required-companion rule exists.
- **User role:** Sales Rep.
- **Input data:** the primary product without its required companion.
- **Steps:** 1) Add the primary product. 2) Attempt to proceed/save without the required item.
- **Expected result:** system blocks or auto-adds the required product per rule; a clear message
  explains the requirement; proposal cannot be completed missing a required item.

### UAT-06 — Trigger incompatible-product rule
- **Preconditions:** two products with an incompatibility rule exist.
- **User role:** Sales Rep.
- **Input data:** both incompatible products on one proposal.
- **Steps:** 1) Add product A. 2) Add incompatible product B.
- **Expected result:** system rejects the combination with a clear reason; user must remove/replace;
  no invalid configuration is persisted.

### UAT-07 — Calculate prices
- **Preconditions:** valid configured proposal; active price list.
- **User role:** Sales Rep.
- **Input data:** configured lines with quantities.
- **Steps:** 1) View pricing summary.
- **Expected result:** line totals = qty × unit price from the effective price list; subtotal/total
  correct to the cent; rounding per policy; a price snapshot is created for the version.

### UAT-08 — Apply an authorized discount
- **Preconditions:** rep discount authority = up to allowed threshold.
- **User role:** Sales Rep.
- **Input data:** discount within the rep's authorized limit.
- **Steps:** 1) Apply discount. 2) Recalculate.
- **Expected result:** discount applied, totals recomputed, discount recorded on the version; no
  approval required; margin recalculated (visible only to financial roles).

### UAT-08b — Request an unauthorized discount
- **Preconditions:** rep discount authority is below the requested amount.
- **User role:** Sales Rep (then Sales Manager for approval).
- **Input data:** discount exceeding the rep's limit.
- **Steps:** 1) Rep applies over-limit discount. 2) Submit.
- **Expected result:** system blocks auto-apply and routes for manager approval (or rejects); rep
  cannot self-approve; approval/denial recorded; unauthorized discount never silently applied.

### UAT-09 — Calculate installation
- **Preconditions:** facility info recorded; installation rules seeded.
- **User role:** Sales Rep.
- **Input data:** installation-relevant config + site data.
- **Steps:** 1) View installation estimate.
- **Expected result:** installation estimate computed per rules and clearly labeled **ESTIMATED**; not
  merged into product revenue; feeds installation handoff requirement.

### UAT-10 — Calculate travel
- **Preconditions:** site address recorded; travel rules seeded.
- **User role:** Sales Rep.
- **Input data:** site distance/zone.
- **Steps:** 1) View travel estimate.
- **Expected result:** travel computed per distance/zone rules, labeled ESTIMATED; correct for the
  site; excluded from margin/revenue.

### UAT-11 — Calculate freight
- **Preconditions:** shippable items on proposal; freight rules seeded.
- **User role:** Sales Rep.
- **Input data:** items with weight/dimensions + destination.
- **Steps:** 1) View freight estimate.
- **Expected result:** freight computed per rules, labeled ESTIMATED; feeds shipping handoff
  requirement; excluded from revenue/margin.

### UAT-12 — Apply tax exemption
- **Preconditions:** customer flagged tax-exempt with a valid exemption reference.
- **User role:** Sales Rep.
- **Input data:** exemption certificate reference.
- **Steps:** 1) Mark proposal tax-exempt. 2) Recalculate.
- **Expected result:** tax = 0 with exemption recorded; total recomputed correctly; exemption
  reference stored; non-exempt customers still taxed.

### UAT-13 — Create a payment schedule
- **Preconditions:** priced proposal.
- **User role:** Sales Rep / Accounting.
- **Input data:** deposit % + milestone terms.
- **Steps:** 1) Define schedule. 2) Save.
- **Expected result:** schedule sums to the proposal total (no over/under allocation); deposit line
  distinct from remainder; deposit feeds the deposit requirement at acceptance.

### UAT-14 — Create a proposal
- **Preconditions:** configured + priced lines.
- **User role:** Sales Rep.
- **Input data:** proposal name, terms, expiration date.
- **Steps:** 1) Finalize draft → Create proposal (v1). 2) Generate PDF.
- **Expected result:** version 1 created with a locked price snapshot; PDF matches the version exactly
  (lines, discounts, tax, totals, terms); expiration set.

### UAT-15 — Revise a proposal
- **Preconditions:** proposal v1 exists.
- **User role:** Sales Rep.
- **Input data:** a changed quantity or added line.
- **Steps:** 1) Create revision. 2) Change data. 3) Save v2. 4) Generate PDF.
- **Expected result:** v2 created with its own snapshot; **v1 and its snapshot are unchanged**; v2 PDF
  reflects new totals; version history shows both.

### UAT-16 — Compare versions
- **Preconditions:** v1 and v2 exist.
- **User role:** Sales Rep / Sales Manager.
- **Input data:** none.
- **Steps:** 1) Open version comparison v1 vs v2.
- **Expected result:** diff shows added/removed/changed lines and total delta accurately from each
  version's snapshot; no recomputation of historical values.

### UAT-17 — Approve a proposal
- **Preconditions:** proposal needing internal approval (e.g. over-limit discount from UAT-08b).
- **User role:** Sales Manager.
- **Input data:** approval decision + note.
- **Steps:** 1) Open approval queue. 2) Approve.
- **Expected result:** approval recorded with approver + timestamp; approval turnaround captured;
  rep cannot approve own; state advances.

### UAT-18 — Customer acceptance
- **Preconditions:** approved proposal version.
- **User role:** Sales Rep / Ops.
- **Input data:** customer authorization (name, title, method).
- **Steps:** 1) Record acceptance on the version.
- **Expected result:** acceptance recorded against the exact version; enables the operational lock
  step (`POST /orders/from-version/:versionId`); does not itself alter pricing.

### UAT-19 — QuickBooks estimate creation
- **Preconditions:** accepted order locked; QBO sandbox connected.
- **User role:** Ops / Accounting.
- **Input data:** the locked order.
- **Steps:** 1) Trigger order lock (auto side effect) or retry-integrations. 2) Check QBO sandbox.
- **Expected result:** a QBO estimate is created matching the accepted snapshot; `qboEstimateId` stored;
  `QBO_ESTIMATE_CREATED` event logged; re-running does not duplicate the estimate (idempotent).

### UAT-20 — Deposit invoice creation
- **Preconditions:** accepted order with a deposit requirement; QBO connected.
- **User role:** Accounting.
- **Input data:** deposit amount from the schedule.
- **Steps:** 1) Create deposit invoice. 2) Check QBO sandbox.
- **Expected result:** deposit invoice created in QBO for the correct amount; `qboInvoiceId` stored;
  deposit status = INVOICED (distinct from COLLECTED); no duplicate on re-run.

### UAT-21 — Monday.com handoff
- **Preconditions:** accepted order; monday test board connected.
- **User role:** Ops / PM.
- **Input data:** the locked order + seeded handoff tasks.
- **Steps:** 1) Trigger monday project creation. 2) Check the test board.
- **Expected result:** a monday project/items created (or updated if existing) reflecting handoff
  tasks; `mondayProjectId` stored; `MONDAY_PROJECT_CREATED` event logged; no duplicate project.

### UAT-22 — Integration failure handling
- **Preconditions:** ability to simulate QBO/monday outage (invalid token / forced error in UAT).
- **User role:** Ops.
- **Input data:** order lock while an integration is down.
- **Steps:** 1) Lock order with integration forced to fail. 2) Inspect order + events. 3) Restore +
  retry-integrations.
- **Expected result:** order lock still succeeds; integration id stays null; `*_FAILED` event logged;
  no crash/rollback of the order; retry succeeds afterward and fills the id; still idempotent.

### UAT-23 — Duplicate prevention
- **Preconditions:** an accepted order already exists for a proposal; an already-imported source file.
- **User role:** Ops / Accounting.
- **Input data:** repeat the accept/lock; re-upload same import file; re-run integrations.
- **Steps:** 1) Attempt second order lock on same proposal. 2) Re-run QBO/monday. 3) Re-import same
  source file.
- **Expected result:** second lock refused (one order per proposal); integrations do not create
  duplicate external records; import dedupes by source hash/key; clear messaging in each case.

### UAT-24 — Permission restrictions
- **Preconditions:** users seeded for each role.
- **User role:** run as Sales Rep, Installer, Accounting, Exec (matrix).
- **Input data:** attempts to access cost/margin/discount/deposit reports, other reps' records,
  export endpoints, and admin/import actions.
- **Steps:** 1) As each role, attempt in-scope and out-of-scope actions (UI + direct API).
- **Expected result:** each role can do exactly what its permissions allow; cost/margin/deposit hidden
  without financial permission; reps see only own records; export/import gated; out-of-scope attempts
  return 403 (not just hidden in UI).

### UAT-25 — Mobile use
- **Preconditions:** UAT build on a phone-sized viewport / real device.
- **User role:** Sales Rep.
- **Input data:** a representative flow (view opportunity, view proposal, record facility note).
- **Steps:** 1) Run the flow on mobile.
- **Expected result:** layouts responsive with no horizontal overflow; hit targets ≥44px; key read/
  light-edit flows usable; PDFs/reports open acceptably; no blocking layout defects.

---

## Execution block template (copy per case into UAT_RESULTS.md)
```
Test ID:
Cycle / Date / Tester:
Actual result:
Pass / Fail:
Defect ID (if fail):
Severity:
Evidence (screenshot / log / QBO or monday record link):
```

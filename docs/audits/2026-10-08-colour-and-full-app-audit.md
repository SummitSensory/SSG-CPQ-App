# Audit — customer colours → BOM, and the whole application (2026-10-08)

Ten audit agents, each on its own local database (never production), each
writing tests that drive the real code. No application source was changed.
Every confirmed bug is pinned by an `it.fails("BUG: …")` / `KNOWN GAP` test:
the suite stays green while the bug exists, and the test turns red the moment
the bug is fixed — flip it to a plain `it` as part of that fix.

|                                               | Count             |
| --------------------------------------------- | ----------------- |
| Tests before the audit                        | 1,377 (162 files) |
| New tests (`tests/**/audit-*`, `e2e/audit-*`) | ~1,030 (34 files) |
| Of which pin a confirmed bug (`it.fails`)     | 94                |
| Full suite after the audit                    | 2,407 — all pass  |

## Part 1 — Customer colour selections → Bill of Materials

**Verdict: the software maps colours correctly, end to end.** One thing
cannot be proven from the repository and must be checked in production (see
"Production check" below).

### Proof, stage by stage

| Stage                             | What was proven                                                                                                                                                                                                                                                                                                                                                                                                 | Tests                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Portal → monday → CRM             | The CRM reads the exact column, JSON shape, status label and brand spelling the Customer-Portal writes. All 40 portal colour areas are accepted. **All 131 Cardinal and 378 Prismatic codes** match the portal's charts, names included. Every area × every allowed colour (3,990 combinations), run through the portal's own `sanitizeSelections`, arrives unchanged. Changed answers re-open the item as NEW. | `tests/unit/audit-color-ingestion.test.ts` (602), `tests/integration/audit-color-ingestion.test.ts` (6) |
| Mark reviewed → BOM lines         | Right colour on the right line; every line of the part; hardware fasteners sharing a part number stay blank; unmapped parts stay blank (never a wrong colour); conflicts reported, not guessed; changed answers replace old colours; multi-vendor lines all coloured; submitted vendor sections protected; case/whitespace in part numbers handled.                                                             | `tests/integration/audit-color-mapping.test.ts` (12)                                                    |
| BOM / PO output                   | Colour prints on the correct row in HTML/PDF, Excel, CSV, the "All vendors" sheet and the **emailed Excel attachment**; the same part in two colours stays two rows everywhere, including the PO; every chart code prints "Brand Name Code"; PO regeneration picks up changes, sent POs are frozen.                                                                                                             | `tests/integration/audit-color-output.test.ts` (29), `tests/unit/audit-color-output.test.ts` (6)        |
| Colour check (`checkOrderColors`) | It catches what it should: we deliberately corrupted BOMs (wrong text, blank, dropped row, dropped column, swapped colours, unreviewed answers) and it flagged every one.                                                                                                                                                                                                                                       | same files                                                                                              |
| Routes & screens                  | Only the right roles can map areas or mark reviewed; double-clicks and simultaneous clicks are safe (one wins, one 409); every field the screens read is present in what the server returns; unreviewed colours never block sending a BOM (your decision) but are shown as NEW.                                                                                                                                 | `tests/integration/audit-color-routes.test.ts` (36)                                                     |

### Production check (cannot be done from the repo)

Which BOM parts each colour area paints lives **only** in the production
table `PortalColorAreaMapping`, entered under Administration → Portal colour
areas. No seed or migration creates it. If an area has no mapping, review
still succeeds but nothing is coloured for that area (it is listed under
"unmapped areas" in the review result). Confirm every area has parts mapped,
especially the newer ones: `soft_steps_2_mat.*`, `soft_steps_3_mat.*`,
`foundation_mat.foundation_mat`, `climbing_wall_color.climbing_wall`,
`slide_platform_paint.slide_platform`. Also confirm the CRM vinyl palette
uses the portal's 14 names (Black, Charcoal, Kelly Green, Light Gray, Lime,
Navy, Orange, Pink, Purple, Red, Royal Blue, Tan, White, Yellow).

### Colour findings (edge cases — none affect the normal path)

| Sev | Finding                                                                                                                                             | Where                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Med | Re-reviewing re-applies **every** area, so a staff hand-correction on an area the customer didn't change is overwritten.                            | `src/portal/colorAreas.ts:622-680`                                     |
| Med | A frame-paint code not on the brand's chart prints on the vendor sheet with no warning anywhere (the portal normally blocks this).                  | `colorAreas.ts:287`, `planColorApplication`                            |
| Med | Lines added after review (hand-added, kit components, secondary vendors) get no colour and review can't be re-run; the colour check does flag them. | `src/portal/orderPortal.ts:697-701`, `src/handoff/bomBuild.ts:440,513` |
| Med | A colour step marked ✅ by Jotform/legacy "mark complete" with no picks reviews as "nothing applied" with no warning.                               | `orderPortal.ts:315`, `colorAreas.ts:628`                              |
| Med | PO picker marks the _other_ colour of the same part as "already on a PO".                                                                           | `src/handoff/purchaseOrder.ts:125-142`                                 |
| Low | A line with a colour code but no colour text passes submission yet prints "—".                                                                      | `bomSections.ts:956-962`, `bomDocuments.ts:257`                        |
| Low | Eye-bolt roll-up merges two colours into one row.                                                                                                   | `src/handoff/bomRollup.ts:66,185-226`                                  |
| Low | A conflict that first appears on re-review leaves the old colour printing; a dropped area keeps its old colour.                                     | `colorAreas.ts:576-580`                                                |
| Low | Area keys are case-sensitive; a mis-cased admin key never matches (shown as unmapped).                                                              | `colorAreas.ts:706`                                                    |

## Part 2 — Whole application

Baseline (before any audit test): typecheck, lint, build, migrations, part
integrity, 1,377 unit+integration tests and 6 e2e tests all pass. Migration
chain applies cleanly to an empty database with no drift.

### High severity — recommend fixing first

| Area                           | Finding                                                                                                                                                                                                   | Where                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Security                       | **XSS on the SSO hand-off page.** `returnTo` is placed into an inline `<script>` via `JSON.stringify`, which doesn't escape `</script>`. A crafted sign-in link can run script and read the login tokens. | `src/routes/sso.ts:24-30, 51`                           |
| Security                       | READ_ONLY users can create/edit scheduled reports with any recipient and any `sendAsId` — company data emailed from another user's mailbox.                                                               | `src/routes/insights.ts:200-277`, `cronInsights.ts:191` |
| Security                       | READ_ONLY users can email customer financing PDFs to any address.                                                                                                                                         | `src/routes/finance.ts:543,581`                         |
| Reports                        | **Scheduled reports never send**: route is POST-only (Vercel Cron sends GET) and it's missing from `vercel.json`.                                                                                         | `src/routes/cronInsights.ts:153`                        |
| Integrations                   | A transient Microsoft/network error permanently disconnects a rep's Outlook.                                                                                                                              | `src/integrations/microsoft/graph.ts:288`               |
| Integrations                   | Two simultaneous QuickBooks token refreshes can deactivate the connection.                                                                                                                                | `src/integrations/quickbooks/oauth.ts:270-283`          |
| Pricing                        | A new version of an ACTIVE pricing rule goes live immediately, without approval or cycle check.                                                                                                           | `src/rules/service.ts:82-118`                           |
| Approvals                      | Simultaneous approve + reject both succeed (last write wins).                                                                                                                                             | `src/approvals/service.ts:118-145`                      |
| Receivables                    | USD and CAD balances added into one "$" total.                                                                                                                                                            | `src/integrations/quickbooks/receivables.ts:323-330`    |
| BOM vendors                    | At lock time ProductSourcing overrides `Sku.manufacturer`, contrary to the documented rule; the BOM and freight RFQ can name different vendors.                                                           | `src/handoff/service.ts:221-229,263`                    |
| BOM vendors                    | Re-sourcing a part moves secondary-vendor/free-issue lines and touches CANCELLED/COMPLETE orders.                                                                                                         | `src/handoff/vendorReassign.ts:65-73`                   |
| PO                             | PO reference collisions (two vendors with the same code, or a second order on a Project ID) return a raw 500.                                                                                             | `src/handoff/purchaseOrder.ts:216-226`                  |
| Catalog (API only, not the UI) | `DELETE /skus/:id`, `PATCH /skus/:id {part}` and `{manufacturer}` break Product↔Sku/sourcing integrity.                                                                                                   | `src/routes/skus.ts:237-273`                            |

### Medium and low

Each is pinned by a named `BUG:` test in the file listed. Highlights:

- **Pricing** (`audit-pricing-*`): cost/margin visible via `GET /pricing/snapshots/:ref` and finding messages to roles without cost access; line discounts bypass discount authority; sub-1 bps loss not flagged; concurrent proposal clone → 500; fractional mileage → 500; category auto-include undercounts; float rounding on % discounts.
- **Handoff** (`audit-handoff-*`): line upsert can move a line off a submitted section or across orders; draft PO on a cancelled order can still be emailed; cost refresh can set cost to $0; qty-0 kit treated as 1; non-deterministic vendor when several sources are primary.
- **Integrations** (`audit-integrations-*`): QuickBooks retries non-idempotent POSTs on 5xx (duplicate invoice emails); failed monday stage change lost on retry; failed alert suppresses retries for an hour; FX cron can stamp yesterday's rate; Resend webhook not idempotent.
- **Security** (`audit-security-*`): belt-shipment ledger and CRM notes writable by READ_ONLY; Blob token sent to client-supplied hosts; password-reset link uses `Host` header if `APP_BASE_URL` unset; Outlook consent not bound to the user's mailbox; open redirect via `/\`; monday webhook JWT replayable; malformed JSON → 500.
- **CRM/reporting** (`audit-crm-*`): line-grain report totals double-count; UTC used where business time is America/Denver; goal edit ignores metric/period and zeroes count targets; financing "Add band" always 400.
- **Catalog/schema** (`audit-catalog-*`): case-insensitive part joins vs case-sensitive unique keys; deleting a manufacturer in use → 500; on a fresh database the 0029 seed rows (powder brands, finance factors) are skipped by the bootstrap.

## Not covered / needs real credentials

- Real PDF rendering (no local Chromium) — the HTML the PDF prints from is verified.
- Live behaviour of Intuit, Microsoft, monday, Resend and DocuSeal under the
  failure modes above.
- Production data: the colour-area mappings and vinyl palette names.
- Nothing was clicked through in a browser beyond the e2e smoke specs.

## Test hygiene change

`tests/integration/portal-color-to-bom.test.ts` (and two new colour suites)
created the shared Cardinal/Prismatic brand rows when missing and deleted
them on cleanup, which made other suites running in parallel flake. They now
leave those shared reference rows in place.

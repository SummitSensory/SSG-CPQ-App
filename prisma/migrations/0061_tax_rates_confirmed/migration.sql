-- Canadian tax rates: confirmed against CRA and provincial sources, with one
-- correction.
--
-- 0060 seeded these rows marked "CONFIRM". SSG's review returned the same figures
-- with one date change, applied here rather than by editing 0060, which is already
-- applied in production.
--
-- BRITISH COLUMBIA GST — effectiveFrom 2008-01-01 → 2013-04-01.
--
-- BC ran HST at 12% from 2010-07-01 until 2013-03-31 and returned to GST 5% + PST
-- 7% on 2013-04-01. The seeded 2008 date claimed GST 5% applied continuously, so a
-- proposal dated inside the HST window would have been priced at 5% instead of 12%.
-- No such proposal exists — this system has no data that old — but the rule table
-- is meant to be true about the past, not just about today.
--
-- A BC proposal dated before 2013-04-01 now finds no rate and reports
-- `no_rate_for_province`, which is correct: the rate that applied then was HST, and
-- no HST row for BC exists. Nobody needs to quote 2012, so the historical HST row
-- is deliberately not added.
--
-- Nova Scotia is unchanged. SSG's table reads "effective through 2025-03-31" while
-- the column stores 2025-04-01, because effectiveTo is EXCLUSIVE — the same
-- interval either way. Storing 2025-03-31 would leave that day with no rate at all.

UPDATE "CanadianTaxRate"
   SET "effectiveFrom" = DATE '2013-04-01',
       "updatedAt"     = CURRENT_TIMESTAMP
 WHERE "id" = 'cbr_bc_gst'
   AND "effectiveFrom" = DATE '2008-01-01';

-- Mark the rate table as reviewed. The marker is what the admin screen reads to
-- decide whether to warn that rates are unverified, so it has to change when the
-- review actually happens.
UPDATE "CanadianTaxRate"
   SET "source"    = 'SSG tax review 2026-08-21 — CRA and provincial sources',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "source" = 'seed:0060 — CONFIRM';

-- Taxability rules are NOT marked reviewed. Equipment, parts, freight, discounts
-- and credits were seeded, and the border-charge categories were seeded as not
-- taxable while the customer is importer of record. INSTALLATION, DESIGN, TRAINING,
-- TRAVEL and OTHER remain unseeded on purpose: their provincial treatment varies,
-- installation into real property especially, and an unseeded category sends the
-- proposal to review instead of guessing. Those need a ruling per category before
-- this marker changes.

-- ROLLBACK
--
-- UPDATE "CanadianTaxRate" SET "effectiveFrom" = DATE '2008-01-01'
--  WHERE "id" = 'cbr_bc_gst';
-- UPDATE "CanadianTaxRate" SET "source" = 'seed:0060 — CONFIRM'
--  WHERE "source" = 'SSG tax review 2026-08-21 — CRA and provincial sources';

/**
 * Adds the freight true-up models to prisma/schema.prisma.
 *
 * Run from the repo root:  node prisma/apply-freight-trueup-schema.mjs
 * Then:                    pnpm db:generate
 *
 * Idempotent — running it twice changes nothing. Does two things:
 *   1. inserts `freightTrueUps FreightTrueUp[]` inside model Proposal, after the
 *      existing `freightRfqs FreightRfq[]` line;
 *   2. appends the two enums and the FreightTrueUp model to the end of the file.
 *
 * Writes prisma/schema.prisma.bak first.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PATH = 'prisma/schema.prisma';

const RELATION = '  freightTrueUps FreightTrueUp[]';

const MODELS = `

/// A freight true-up is the one sanctioned way a frozen proposal changes after
/// release. It exists because SSG quotes before the vendors have quoted freight:
/// the customer often signs, and manufacturing often starts, on a document whose
/// freight lines are still blank.
///
/// It is deliberately NOT a new proposal version. The customer signed P-2026-0117
/// v3 and that document keeps its number, its signature and its line items; only
/// the freight fields move, and only through this record — which carries who
/// entered the figure, which vendor quoted it, the quote reference, the before and
/// after totals, and what was done to the QuickBooks invoice as a result.
enum FreightTrueUpStatus {
  /// Raised: freight is known to be outstanding. Nothing entered yet.
  OPEN
  /// Amounts entered and evidenced, not yet written onto the proposal.
  STAGED
  /// Written onto the proposal; the price snapshot has been re-frozen.
  APPLIED
  /// Withdrawn — including "no freight applies", which carries a reason.
  VOID
}

/// How the freight reached an invoice that already existed in QuickBooks.
enum FreightInvoiceMode {
  /// Freight lines appended to the existing invoice, raising its total.
  AMEND
  /// A separate freight-only invoice, because the original had payments applied.
  SUPPLEMENT
}

model FreightTrueUp {
  id                    String              @id @default(cuid())
  proposalId            String
  proposal              Proposal            @relation(fields: [proposalId], references: [id], onDelete: Cascade)
  /// The frozen version the freight is being written onto.
  versionId             String
  status                FreightTrueUpStatus @default(OPEN)

  // ---- Staged amounts, minor units. NULL means "not answered", which is not
  // the same as 0 ("quoted at nothing") — the same distinction priceEntry.ts
  // makes for line prices, and for the same reason.
  structureFreightMinor Int?
  stdFreightMinor       Int?
  /// Per-line third-party freight: [{ ref, sku, name, amountMinor }]. Keyed by the
  /// line's \`ref\` because that is what survives a re-order of the proposal.
  thirdPartyLines       Json?
  /// Sum of thirdPartyLines, cached so the queue can be listed without parsing.
  thirdPartyTotalMinor  Int?

  // ---- Provenance. A freight figure with no source is a guess.
  vendorName            String?
  vendorQuoteRef        String?
  /// The vendor's quote document, uploaded through the ordinary attachment flow.
  quoteAttachmentId     String?
  /// The RFQ this quote answers, when it came back against one.
  freightRfqId          String?
  note                  String?
  /// Set when someone records that no freight applies. Status goes VOID.
  noFreightReason       String?

  // ---- Application onto the proposal
  appliedAt             DateTime?
  appliedById           String?
  previousTotalMinor    BigInt?
  newTotalMinor         BigInt?
  previousSnapshotId    String?
  newSnapshotId         String?

  // ---- QuickBooks
  qboMode               FreightInvoiceMode?
  /// The invoice that was amended, or the one the supplement follows.
  qboSourceTxnId        String?
  /// The freight-only invoice, when one had to be raised.
  qboSupplementTxnId    String?
  qboPreviousTotalMinor BigInt?
  qboNewTotalMinor      BigInt?
  qboPushedAt           DateTime?
  qboPushedById         String?
  qboError              String?

  /// The amended total has been sent to the customer. Null after an amendment is
  /// applied, which is what makes the "revised total, customer not notified" flag
  /// appear — nothing is emailed automatically.
  customerNotifiedAt    DateTime?
  customerNotifiedById  String?

  createdById           String
  createdAt             DateTime            @default(now())
  updatedAt             DateTime            @updatedAt

  @@index([proposalId])
  @@index([versionId])
  @@index([status])
}
`;

if (!existsSync(PATH)) {
  console.error(`Cannot find ${PATH}. Run this from the repository root.`);
  process.exit(1);
}

let schema = readFileSync(PATH, 'utf8');
const before = schema;

if (schema.includes('model FreightTrueUp')) {
  console.log('model FreightTrueUp is already present — nothing appended.');
} else {
  schema = schema.replace(/\s*$/, '') + '\n' + MODELS;
  console.log('Appended FreightTrueUpStatus, FreightInvoiceMode and model FreightTrueUp.');
}

if (schema.includes('freightTrueUps')) {
  console.log('Proposal.freightTrueUps is already present — nothing inserted.');
} else {
  // Anchored on the existing relation field inside model Proposal, which is the
  // only occurrence of this exact line in the file.
  const anchor = /^(\s*freightRfqs\s+FreightRfq\[\].*)$/m;
  if (!anchor.test(schema)) {
    console.error(
      'Could not find the `freightRfqs FreightRfq[]` line inside model Proposal. Add this line to model Proposal by hand:\n' +
        RELATION,
    );
    process.exit(1);
  }
  schema = schema.replace(anchor, `$1\n${RELATION}`);
  console.log('Inserted freightTrueUps into model Proposal.');
}

if (schema === before) {
  console.log('Schema already up to date.');
  process.exit(0);
}

writeFileSync(`${PATH}.bak`, before, 'utf8');
writeFileSync(PATH, schema, 'utf8');
console.log(`Wrote ${PATH} (previous version saved as ${PATH}.bak). Now run: pnpm db:generate`);

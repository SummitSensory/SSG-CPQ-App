/**
 * Adds the August 2026 administration + operations fields to prisma/schema.prisma.
 *
 * Run from the repo root:  node prisma/apply-admin-ops-schema.mjs
 * Then:                    pnpm db:generate
 *
 * Pairs with prisma/migrations/0046_admin_ops_changes/migration.sql. Idempotent —
 * running it twice changes nothing. Does three things:
 *
 *   1. appends FormulaRevisionKind, FormulaRevisionAction and model FormulaRevision;
 *   2. adds five columns to model AcceptedOrder (manufacturing release + the
 *      QuickBooks-invoice waiver);
 *   3. adds three columns to model ProcurementLine (quantity override).
 *
 * Insertion works by locating the model BLOCK by name and placing the new fields
 * inside it, rather than by anchoring on a field line. An earlier version anchored
 * on `exceptionReason String?` — which occurs in ProcurementLine, HandoffRequirement
 * AND HandoffTask — and refused to run rather than write to the wrong model. Model
 * names are unique by definition, so this cannot land in the wrong place.
 *
 * Writes prisma/schema.prisma.bak first, and writes nothing at all unless every
 * edit succeeds.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const PATH = 'prisma/schema.prisma';

const MODELS = `

/// The record of every change made to an editable formula — frame and component
/// quantities, hardware fastener quantities, and the business numbers.
///
/// AuditLog already notes that a formula changed, but it stores only the fields
/// that were SENT. That is enough to answer "who touched this" and not enough to
/// answer "what did it used to be", which is the question actually asked when a
/// bill of materials comes out wrong. So each revision carries a complete snapshot
/// of the rule before and after, which is also what makes Undo possible without
/// re-deriving anything.
enum FormulaRevisionKind {
  /// A frame or component quantity rule.
  FRAME
  /// A hardware fastener quantity rule.
  HARDWARE
  /// A business number (deposit %, mat rates, leg spans).
  SETTING
}

enum FormulaRevisionAction {
  /// A rule that had no override before now has one.
  CREATE
  /// An existing override changed.
  UPDATE
  /// An override was cleared, putting the row back on its workbook default.
  RESET
  /// Restore workbook defaults — one batch, one row per cleared override.
  RESET_ALL
  /// This revision reverses an earlier one. Recorded as a revision in its own
  /// right, so the log reads as a history rather than as rows that vanish.
  UNDO
}

model FormulaRevision {
  id             String                @id @default(cuid())

  /// One confirmation can move several rows — "Restore workbook defaults" moves
  /// all of them. The batch groups those rows so the log can show the act.
  batchId        String
  kind           FormulaRevisionKind
  action         FormulaRevisionAction

  /// Part number for FRAME/HARDWARE, setting key for SETTING. One column rather
  /// than two nullable ones: either way it is the row's identity.
  target         String
  /// The row's name as it read at the time, so an entry still makes sense after a
  /// part is renamed or drops out of the workbook.
  targetName     String?

  /// Complete rule (or { key, value }) either side of the change. A null
  /// \`before\` means no override existed; a null \`after\` means it was reset back
  /// to the workbook default.
  before         Json?
  after          Json?
  /// One-line description of what moved, composed when the row is written. Kept so
  /// neither the log nor the Excel export has to re-derive wording from two JSON
  /// blobs — and so the wording cannot drift as the formula editor changes.
  summary        String

  /// The confirmation the user typed, verbatim. Evidence the gate was met rather
  /// than a boolean asserting it was.
  confirmedWord  String?
  /// Orders judged impacted at confirmation time: [{ id, number, customer }].
  /// Snapshotted, not recomputed — which orders were open THEN is the fact worth
  /// keeping, and it is what the notification email quoted.
  impactedOrders Json?
  impactedCount  Int                   @default(0)

  notifiedAt     DateTime?
  /// Why the notification did not go out. A failed email must not fail the change
  /// that was already committed, so the failure is recorded here instead.
  notifyError    String?

  undoneAt       DateTime?
  undoneById     String?
  /// The revision this one reverses. Set only on action = UNDO.
  undoesId       String?               @unique
  undoes         FormulaRevision?      @relation("FormulaRevisionUndo", fields: [undoesId], references: [id], onDelete: SetNull)
  undoneBy       FormulaRevision?      @relation("FormulaRevisionUndo")

  actorId        String
  createdAt      DateTime              @default(now())

  @@index([kind, createdAt])
  @@index([batchId])
  @@index([target])
  @@index([actorId])
}
`;

const ORDER_FIELDS = `  // ---- Manufacturing release ----
  // Creating the order and releasing it to the shop are two separate acts. The
  // order is created when the proposal is marked signed; release is later, and is
  // gated on a QuickBooks invoice existing — or on that requirement being waived
  // on purpose, with a reason.
  manufacturingReleasedAt   DateTime?
  manufacturingReleasedById String?
  qboInvoiceWaivedAt        DateTime?
  qboInvoiceWaivedById      String?
  qboInvoiceWaivedReason    String?`;

const LINE_FIELDS = `  /// What the formula produced for this line, captured when the line was created
  /// from the accepted proposal. \`quantity\` above is the operational figure and
  /// may be overridden by hand; a difference between the two is what badges the
  /// line as edited. NULL on lines added by hand, which have no formula figure to
  /// differ from.
  quantityOriginal   Int?
  quantityEditedById String?
  quantityEditedAt   DateTime?`;

if (!existsSync(PATH)) {
  console.error(`Cannot find ${PATH}. Run this from the repository root.`);
  process.exit(1);
}

let schema = readFileSync(PATH, 'utf8');
const before = schema;
const notes = [];
let failed = false;

/**
 * Add fields inside `model <name> { … }`.
 *
 * The block is found by model name — unique in a Prisma schema — and the fields go
 * in just above the first `@@` block attribute, or immediately before the closing
 * brace when the model has none. That keeps the conventional layout of fields
 * first, block attributes last.
 */
function addFieldsToModel(modelName, block, guard, what) {
  const open = new RegExp(`^model\\s+${modelName}\\s*\\{[^\\n]*$`, 'm');
  const openMatch = open.exec(schema);
  if (!openMatch) {
    console.error(`${what}: could not find "model ${modelName} {" in ${PATH}.`);
    failed = true;
    return;
  }
  const start = openMatch.index;
  // The first line that is a closing brace in column 1 ends the block. Prisma
  // never indents a model's closing brace, so this is unambiguous.
  const closeRel = schema.slice(start).search(/^\}/m);
  if (closeRel === -1) {
    console.error(`${what}: model ${modelName} has no closing brace.`);
    failed = true;
    return;
  }
  const end = start + closeRel;
  const body = schema.slice(start, end);

  if (body.includes(guard)) {
    notes.push(`${what}: already present.`);
    return;
  }

  // Insert above the first block attribute if there is one, else at the end of
  // the body.
  const attrRel = body.search(/^\s*@@/m);
  const at = attrRel === -1 ? end : start + attrRel;
  const insert = `${block}\n\n`;
  schema = schema.slice(0, at) + insert + schema.slice(at);
  notes.push(`${what}: inserted into model ${modelName}.`);
}

// 1. The new enums + model, appended at the end of the file.
if (schema.includes('model FormulaRevision')) {
  notes.push('model FormulaRevision: already present.');
} else {
  schema = schema.replace(/\s*$/, '') + '\n' + MODELS;
  notes.push('model FormulaRevision: appended with both enums.');
}

// 2 and 3.
addFieldsToModel(
  'AcceptedOrder',
  ORDER_FIELDS,
  'manufacturingReleasedAt',
  'AcceptedOrder release fields',
);
addFieldsToModel(
  'ProcurementLine',
  LINE_FIELDS,
  'quantityOriginal',
  'ProcurementLine quantity override',
);

if (failed) {
  console.error('\nNothing has been written. Fix the above and run again.');
  process.exit(1);
}

for (const n of notes) console.log(n);

if (schema === before) {
  console.log('Schema already up to date.');
  process.exit(0);
}

writeFileSync(`${PATH}.bak`, before, 'utf8');
writeFileSync(PATH, schema, 'utf8');
console.log(`\nWrote ${PATH} (previous version saved as ${PATH}.bak). Now run: pnpm db:generate`);

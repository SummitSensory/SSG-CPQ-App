import { createHash } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { env, qboEnvironment } from '../../config/env.js';
import { create } from './client.js';
import { findOrCreateCustomer } from './customers.js';
import { buildEstimateBody } from './estimates.js';
import { buildInvoiceBody, buildPortionInvoiceBody } from './invoices.js';
import { TXN_LABEL, type AcceptedLine } from './mapping.js';
import { versionTotals } from '../../proposals/analytics.js';
import { findLink } from './links.js';
import { assertSkusMapped } from './skuPreflight.js';
import { resolveSynthesizedItemId } from './synthesizedItems.js';
import { resolveTermForInvoice } from './terms.js';
import { customFieldId } from './customFields.js';
import { resolveInvoiceReferences } from '../monday/dealReferences.js';
import type { QboTxnType, QboTxnStatus, QboEnvironment, Prisma } from '@prisma/client';

/**
 * Financial-transaction safety core. Every live QuickBooks document is:
 *   1. PREPARED   — totals frozen from the ACCEPTED proposal + idempotency key.
 *   2. AUTHORIZED — an explicit, logged user sign-off (no auto-posting).
 *   3. EXECUTED   — created in QuickBooks with the idempotency key as the QBO
 *                   requestid, so a retry can never double-create.
 * Accepted totals are re-verified at execute time and never silently altered.
 */

/** Accept number | string | bigint from JSON snapshots without float drift. */
function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new ValidationError(`Cannot read integer minor-unit value from ${JSON.stringify(v)}`);
}

interface AcceptedTotals {
  currency: string;
  grandTotalMinor: bigint;
  deposit: bigint;
  progress: bigint;
  final: bigint;
  priceSnapshotId: string;
  engineVersion: string;
  lines: AcceptedLine[];
  fees: Array<{ label: string; amountMinor: bigint }>;
  orderDiscountMinor: bigint;
  taxMinor: bigint;
}

/** The snapshot fields both readers below need. */
interface SnapshotHead {
  id: string;
  currency: string;
  grandTotal: bigint;
  engineVersion: string;
}

/**
 * The QuickBooks item id linked to the catalog product carrying this part number.
 *
 * Generated lines (the H-1000 hardware rollup, frame parts) name a part but carry no
 * productId, so the ordinary product-id lookup misses a link that plainly exists.
 * Matching is case-insensitive because line part numbers are upper-cased on the way
 * in while the catalog stores them as entered.
 */
async function linkForProductSku(sku: string): Promise<string | null> {
  const product = await prisma.product.findFirst({
    where: { sku: { equals: sku, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!product) return null;
  const link = await findLink({ entity: 'Item', entityId: product.id });
  return link?.qboId ?? null;
}

/** Read + freeze the accepted proposal totals. Throws unless the version is ACCEPTED. */
export async function loadAcceptedTotals(proposalVersionId: string): Promise<AcceptedTotals> {
  const version = await prisma.proposalVersion.findUnique({ where: { id: proposalVersionId } });
  if (!version) throw new NotFoundError('Proposal version not found');
  if (version.status !== 'ACCEPTED')
    throw new ConflictError('Only an ACCEPTED proposal version may be sent to QuickBooks');
  if (!version.priceSnapshotId) throw new ConflictError('Accepted version has no price snapshot');

  const snap = await prisma.priceSnapshot.findUnique({ where: { id: version.priceSnapshotId } });
  if (!snap) throw new NotFoundError('Price snapshot not found');
  const b = snap.breakdown as Record<string, unknown>;

  // Two snapshot shapes exist in this database. The pricing engine writes a
  // `lines[]` array with a `net` per line plus a `fees` map. The proposal
  // builder ('proposal-builder-1', src/handoff/service.ts) writes flat *Minor
  // totals and keeps the line detail on the version itself. Reading a builder
  // snapshot with the pricing-engine reader yields zero lines and a zero total,
  // which the document builders then (correctly) refuse to send.
  return Array.isArray(b.lines)
    ? fromPricingEngine(snap, b, version.items)
    : fromProposalBuilder(snap, b, version.items, version.sections);
}

/** Pricing-engine snapshot: `lines[].net`, `fees` map, `tax`, `orderDiscount`. */
async function fromPricingEngine(
  snap: SnapshotHead,
  b: Record<string, unknown>,
  rawItems: unknown,
): Promise<AcceptedTotals> {
  const payment = (b.payment ?? {}) as Record<string, unknown>;
  const items =
    (rawItems as unknown as Array<{
      ref: string;
      productId: string;
      name: string;
      quantity: number;
    }>) ?? [];
  const byRef = new Map(items.map((i) => [i.ref, i]));
  const breakdownLines = (b.lines as Array<{ ref: string; net: unknown }>) ?? [];

  const lines: AcceptedLine[] = [];
  /**
   * A line with no `net` used to be skipped.
   *
   * The grand total on the snapshot head still counted it, so skipping produced a
   * document quietly short by that line's value and a total-mismatch error that named
   * no cause. Refusing here instead points straight at the line, and the money can
   * never go missing without somebody being told which line it was.
   */
  const netless = breakdownLines.filter((bl) => bl.net == null).map((bl) => bl.ref);
  if (netless.length) {
    throw new ConflictError(
      `Accepted price snapshot has ${netless.length} line(s) with no net amount (${netless
        .slice(0, 5)
        .join(
          ', ',
        )}${netless.length > 5 ? ', …' : ''}). Re-price and re-accept the proposal before sending it to QuickBooks.`,
    );
  }
  for (const bl of breakdownLines) {
    const item = byRef.get(bl.ref);
    const link = item ? await findLink({ entity: 'Item', entityId: item.productId }) : null;
    lines.push({
      kind: 'PRODUCT',
      description: item?.name ?? bl.ref,
      qboItemId: link?.qboId ?? null,
      productId: item?.productId ?? null,
      quantity: item?.quantity ?? 1,
      amountMinor: toBig(bl.net),
    });
  }

  const fees: Array<{ label: string; amountMinor: bigint }> = [];
  for (const [key, val] of Object.entries((b.fees ?? {}) as Record<string, { amount: unknown }>)) {
    fees.push({ label: key, amountMinor: toBig(val.amount) });
  }

  return {
    currency: snap.currency,
    grandTotalMinor: snap.grandTotal,
    deposit: toBig(payment.deposit ?? 0),
    progress: toBig(payment.progress ?? 0),
    final: toBig(payment.final ?? snap.grandTotal),
    priceSnapshotId: snap.id,
    engineVersion: snap.engineVersion,
    lines,
    fees,
    orderDiscountMinor: toBig(b.orderDiscount ?? 0),
    taxMinor: toBig(b.tax ?? 0),
  };
}

/**
 * Proposal-builder snapshot ('proposal-builder-1'). Flat totals on the
 * breakdown; product lines come from ProposalVersion.items. Mirrors
 * versionTotals() in src/proposals/analytics.ts so the assembled document total
 * equals the accepted grand total exactly:
 *   subtotal - discount + tpFreight + tax + structureFreight + matsFreight
 */
async function fromProposalBuilder(
  snap: SnapshotHead,
  b: Record<string, unknown>,
  rawItems: unknown,
  rawSections: unknown,
): Promise<AcceptedTotals> {
  /**
   * Does the frozen snapshot still describe this version's contents?
   *
   * The document's money comes from two places that are supposed to agree. Line
   * amounts are read LIVE from ProposalVersion.items. The grand total the document is
   * asserted against is PriceSnapshot.grandTotal, frozen when the version was
   * released. If the items were edited after that freeze the two disagree, and the
   * builders fail their total assertion — which reports a difference and nothing about
   * the fact that the accepted price of record no longer matches the proposal.
   *
   * The pre-existing check could not catch this: executeTransaction compares
   * totalsHash(totals) with the hash frozen at prepare, but `totals` is recomputed
   * from the same snapshot every time, so it only ever compares the snapshot to itself.
   *
   * Checked here, in the one place every document type loads its totals, so it fires at
   * PREPARE rather than at the QuickBooks write — the operator finds out before
   * authorising, not after. Nothing is repaired automatically: which of the two figures
   * is correct is a commercial question about what the customer actually accepted, and
   * an app that quietly re-freezes a price so an invoice balances is worse than one
   * that refuses to send.
   */
  const live = versionTotals(rawItems, rawSections);
  const liveTotal = BigInt(Math.round(live.total));
  if (liveTotal !== snap.grandTotal) {
    const drift = snap.grandTotal - liveTotal;
    throw new ConflictError(
      "This proposal's contents no longer match the price that was accepted. The frozen " +
        'accepted total is ' +
        snap.grandTotal +
        " but the version's own lines now come " +
        'to ' +
        liveTotal +
        ', a difference of ' +
        (drift < 0n ? -drift : drift) +
        '. That ' +
        'happens when a version is edited after it was released. Nothing is sent to ' +
        'QuickBooks until the two agree: create a new version with the correct content, ' +
        'release it and accept it, then push from that.',
    );
  }
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

  const items = Array.isArray(rawItems)
    ? (rawItems.filter((i) => i && typeof i === 'object') as Array<Record<string, unknown>>)
    : [];

  // The proposal's structure is preserved: GROUP / SUBGROUP / NOTE rows travel
  // through as description-only lines so the QuickBooks document reads like the
  // proposal the customer accepted. Only PRODUCT rows carry money, which is the
  // same rule the proposal's own totals use.
  const lines: AcceptedLine[] = [];
  for (const it of items) {
    const lineType = String(it.lineType ?? 'PRODUCT');

    if (lineType === 'GROUP' || lineType === 'SUBGROUP') {
      const heading = String(it.name ?? '').trim();
      if (!heading) continue;
      lines.push({
        kind: lineType,
        description: heading,
        optional: Boolean(it.optional),
        quantity: 0,
        amountMinor: 0n,
      });
      continue;
    }
    if (lineType === 'NOTE') {
      const text = [it.name, it.description]
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
        .join(' — ');
      if (text) lines.push({ kind: 'NOTE', description: text, quantity: 0, amountMinor: 0n });
      continue;
    }
    if (lineType !== 'PRODUCT') continue;

    const qty = num(it.quantity);
    const amountMinor = BigInt(Math.round(qty * num(it.rateMinor)));
    const productId = typeof it.productId === 'string' ? it.productId : null;
    const sku = typeof it.sku === 'string' ? it.sku.trim().toUpperCase() : '';
    // Prefer the product-id link; fall back to the SKU-keyed link so generated
    // frame / adventure lines (which carry a part number but no productId) still
    // land on the right QuickBooks item instead of the default service.
    const link =
      (productId ? await findLink({ entity: 'Item', entityId: productId }) : null) ??
      (sku ? await findLink({ entity: 'ItemSku', entityId: sku }) : null);
    /**
     * Third: the line carries a part number but no productId, and the part IS a real
     * catalog product.
     *
     * The hardware rollup is the case that matters. H-1000 is an ACTIVE product with
     * a QuickBooks item linked to it, but the engine synthesizes the rollup line
     * rather than reading the catalog, so the line arrives with sku "H-1000" and
     * productId null — and the product-id lookup above has nothing to look up. This
     * resolves the part number to its catalog product and uses that product's link.
     */
    const skuProductLink = !link && sku ? await linkForProductSku(sku) : null;
    /**
     * Fourth, for lines the engine synthesizes out of nothing: every Adventure mat
     * SIZE generates its own R-SSG-…CLM part number, so no catalog row and no link
     * can ever match it. One QuickBooks item stands for the family — see
     * synthesizedItems.ts. Tried last, so a real link always wins.
     */
    const qboItemId = link?.qboId ?? skuProductLink ?? (sku ? resolveSynthesizedItemId(sku) : null);
    const name = String(it.name ?? it.sku ?? 'Line item');
    const detail = String(it.description ?? '').trim();
    lines.push({
      kind: 'PRODUCT',
      description: detail ? `${name} — ${detail}` : name,
      // Kept apart from `description` so the QuickBooks builder can print the
      // part number and the detail WITHOUT repeating the item name QuickBooks
      // already prints from the ItemRef.
      detail: detail || null,
      qboItemId,
      sku: sku || null,
      productId,
      quantity: qty || 1,
      amountMinor,
    });
  }

  const fees: Array<{ label: string; amountMinor: bigint }> = [];
  const addFee = (label: string, key: string) => {
    const amt = toBig(b[key] ?? 0);
    if (amt !== 0n) fees.push({ label, amountMinor: amt });
  };
  addFee('Third-party freight', 'thirdPartyFreightMinor');
  addFee('Structure freight', 'structureFreightMinor');
  addFee('Mats & padding freight', 'matsFreightMinor');
  addFee('Standard freight', 'stdFreightMinor');

  const payment = (b.payment ?? {}) as Record<string, unknown>;
  const deposit = toBig(payment.deposit ?? 0);
  // This builder has no progress stage: deposit + balance is the whole schedule.
  const balance =
    payment.balanceDueMinor != null ? toBig(payment.balanceDueMinor) : snap.grandTotal - deposit;

  return {
    currency: snap.currency,
    grandTotalMinor: snap.grandTotal,
    deposit,
    progress: 0n,
    final: balance,
    priceSnapshotId: snap.id,
    engineVersion: snap.engineVersion,
    lines,
    fees,
    orderDiscountMinor: toBig(b.discountMinor ?? 0),
    taxMinor: toBig(b.taxMinor ?? 0),
  };
}

/**
 * Document-number suffix per type. The estimate carries the proposal number
 * verbatim so the two are trivially cross-referenced; invoices append a stage
 * marker because QuickBooks requires document numbers to be unique per type.
 * Requires "Custom transaction numbers" to be ON in QuickBooks
 * (Settings → Account and settings → Sales → Sales form content).
 */
const DOC_SUFFIX: Record<QboTxnType, string> = {
  ESTIMATE: '',
  // Invoice numbers are a separate sequence in QuickBooks, so the full-value
  // invoice can carry the proposal number verbatim alongside its estimate.
  INVOICE: '',
  DEPOSIT_INVOICE: '-D',
  PROGRESS_INVOICE: '-P',
  FINAL_INVOICE: '-F',
};

/**
 * Copy number off the tail of an idempotency key (`qbo:<env>:<type>:<id>:<seq>`).
 * Copy 1 is the ordinary case; anything higher is a deliberate second document
 * for the same accepted version, prepared with an explicit `sequence`.
 */
function sequenceOf(idempotencyKey: string): number {
  const m = /:(\d+)$/.exec(idempotencyKey);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Document number for a transaction.
 *
 * A second copy MUST NOT reuse the first one's number. QuickBooks companies with
 * custom transaction numbers switched on reject a duplicate DocNumber outright,
 * and the whole point of a copy is that it is a distinct document someone can
 * refer to. Copies are suffixed `-2`, `-3`, and so on, after any type suffix.
 */
function docNumberFor(proposalNumber: string, type: QboTxnType, seq: number): string {
  const base = `${proposalNumber}${DOC_SUFFIX[type]}`;
  return seq > 1 ? `${base}-${seq}` : base;
}

/**
 * The monday.com Project ID off a proposal version's `meta` section.
 *
 * It is the number the shop, the freight desk and the customer all use to talk
 * about a job, so it belongs on the QuickBooks document. Stored in the same
 * sections blob the builder writes, hence the defensive read.
 */
/**
 * Whether the deposit applies to this deal.
 *
 * The same `showDeposit` flag the builder sets from "Show the 50% deposit on the
 * customer proposal". Absent means true, matching the builder's own default — a
 * proposal written before the flag existed had a deposit.
 */
function depositAppliesOf(sections: unknown): boolean {
  if (!Array.isArray(sections)) return true;
  const meta = sections.find(
    (s) => s && typeof s === 'object' && (s as { id?: string }).id === 'meta',
  ) as { data?: { showDeposit?: unknown } } | undefined;
  return meta?.data?.showDeposit !== false;
}

function projectIdOf(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  const meta = sections.find(
    (s) => s && typeof s === 'object' && (s as { id?: string }).id === 'meta',
  ) as { data?: { projectId?: unknown } } | undefined;
  return String(meta?.data?.projectId ?? '').trim();
}

/** QuickBooks date fields are plain yyyy-mm-dd. */
function toQboDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function amountForType(type: QboTxnType, t: AcceptedTotals): bigint {
  switch (type) {
    case 'ESTIMATE':
      return t.grandTotalMinor;
    // The full-value invoice bills the entire accepted order; the payment split
    // is expressed as terms on the document, not as a reduced amount.
    case 'INVOICE':
      return t.grandTotalMinor;
    case 'DEPOSIT_INVOICE':
      return t.deposit;
    case 'PROGRESS_INVOICE':
      return t.progress;
    case 'FINAL_INVOICE':
      return t.final;
  }
}

function idempotencyKey(
  environment: QboEnvironment,
  type: QboTxnType,
  proposalVersionId: string,
  seq: number,
): string {
  return `qbo:${environment}:${type}:${proposalVersionId}:${seq}`;
}

/** Stable hash of the frozen totals — lets execute detect any drift. */
function totalsHash(t: AcceptedTotals): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        g: t.grandTotalMinor.toString(),
        d: t.deposit.toString(),
        p: t.progress.toString(),
        f: t.final.toString(),
        c: t.currency,
        s: t.priceSnapshotId,
      }),
    )
    .digest('hex');
}

export interface PrepareInput {
  proposalVersionId: string;
  type: QboTxnType;
  sequence?: number;
}

/**
 * Step 1 — prepare. Idempotent: the unique idempotency key means calling this
 * twice for the same (version, type, sequence) returns the SAME row rather than
 * creating a duplicate. Totals are frozen into the row here.
 */
export async function prepareTransaction(input: PrepareInput, userId: string) {
  const environment = qboEnvironment() as QboEnvironment;
  const seq = input.sequence ?? 1;
  const key = idempotencyKey(environment, input.type, input.proposalVersionId, seq);

  const existing = await prisma.qboTransaction.findUnique({ where: { idempotencyKey: key } });
  if (existing) return existing;

  const totals = await loadAcceptedTotals(input.proposalVersionId);
  const amount = amountForType(input.type, totals);
  if (amount <= 0n && input.type !== 'ESTIMATE') {
    throw new ValidationError(
      `${TXN_LABEL[input.type]} amount is zero in the accepted payment schedule`,
    );
  }
  const version = await prisma.proposalVersion.findUniqueOrThrow({
    where: { id: input.proposalVersionId },
  });

  const txn = await prisma.qboTransaction.create({
    data: {
      type: input.type,
      environment,
      status: 'PENDING_AUTHORIZATION',
      proposalId: version.proposalId,
      proposalVersionId: version.id,
      proposalVersion: version.version,
      currency: totals.currency,
      proposalTotalMinor: totals.grandTotalMinor,
      amountMinor: amount,
      totalsSnapshot: {
        hash: totalsHash(totals),
        currency: totals.currency,
        grandTotalMinor: totals.grandTotalMinor.toString(),
        deposit: totals.deposit.toString(),
        progress: totals.progress.toString(),
        final: totals.final.toString(),
        priceSnapshotId: totals.priceSnapshotId,
        engineVersion: totals.engineVersion,
      } as Prisma.InputJsonValue,
      idempotencyKey: key,
      initiatedById: userId,
    },
  });
  await recordAudit({
    actorId: userId,
    action: 'qbo.txn.prepare',
    entity: 'QboTransaction',
    entityId: txn.id,
    details: { type: input.type, environment, amountMinor: amount.toString() },
  });
  return txn;
}

/** Step 2 — explicit user authorization. Required before any live create. */
export async function authorizeTransaction(txnId: string, userId: string) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status !== 'PENDING_AUTHORIZATION')
    throw new ConflictError(`Cannot authorize a ${txn.status} transaction`);
  const updated = await prisma.qboTransaction.update({
    where: { id: txnId },
    data: { status: 'AUTHORIZED', authorizedById: userId, authorizedAt: new Date() },
  });
  await recordAudit({
    actorId: userId,
    action: 'qbo.txn.authorize',
    entity: 'QboTransaction',
    entityId: txnId,
    details: { type: txn.type, environment: txn.environment },
  });
  return updated;
}

async function activeRealmId(environment: QboEnvironment): Promise<string> {
  const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
  if (!conn) throw new ConflictError(`No active QuickBooks connection for ${environment}`);
  return conn.realmId;
}

/**
 * Step 3 — execute. Requires AUTHORIZED. Re-verifies the accepted totals have
 * not changed, enforces the production write gate, then creates the document in
 * QuickBooks using the idempotency key as the QBO requestid. Already-CREATED
 * transactions short-circuit (never double-create).
 */
export async function executeTransaction(
  txnId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status === 'CREATED') return txn; // idempotent: already exists in QuickBooks
  if (txn.status !== 'AUTHORIZED')
    throw new ForbiddenError(
      'Transaction must be explicitly AUTHORIZED before it is created in QuickBooks',
    );

  // Hard production safety gate.
  if (txn.environment === 'PRODUCTION' && !env.QBO_PRODUCTION_WRITE_ENABLED) {
    throw new ForbiddenError(
      'Production QuickBooks writes are disabled. Complete and authorize the production test plan, then set QBO_PRODUCTION_WRITE_ENABLED=true.',
    );
  }

  // Re-verify accepted totals are unchanged since prepare — never silently alter.
  const totals = await loadAcceptedTotals(txn.proposalVersionId);
  const frozen = txn.totalsSnapshot as { hash: string };
  if (totalsHash(totals) !== frozen.hash || amountForType(txn.type, totals) !== txn.amountMinor) {
    throw new ConflictError(
      'Accepted proposal totals changed since this transaction was prepared — refusing to create. Re-prepare from the current accepted version.',
    );
  }

  const realmId = await activeRealmId(txn.environment);

  try {
    // Every part number on the accepted proposal must resolve to a real, active
    // QuickBooks item before a document carrying those lines is created. An
    // unmapped line is not rejected by QuickBooks — it posts under the default
    // service item, so the money is right and every product report is wrong,
    // which nobody discovers until they read one. Portion invoices carry a
    // single summary line with no ItemRef, so there is nothing to check there.
    if (txn.type === 'ESTIMATE' || txn.type === 'INVOICE') {
      await assertSkusMapped(totals.lines, realmId, fetchImpl);
    }

    // Ensure the customer exists (find-or-create is itself duplicate-safe).
    const version = await prisma.proposalVersion.findUniqueOrThrow({
      where: { id: txn.proposalVersionId },
      include: { proposal: true },
    });
    const { qboId: customerQboId, email: billEmail } = await findOrCreateCustomer(
      version.proposal.organizationId,
      realmId,
      userId,
      fetchImpl,
    );
    const docNumber = docNumberFor(
      version.proposal.number,
      txn.type,
      sequenceOf(txn.idempotencyKey),
    );

    /**
     * Project ID and the customer's PO, resolved once for the whole document.
     *
     * Both used to come only from our own records, and both were routinely empty:
     * the proposal's meta carries a Project ID only if somebody filled it in, and
     * the PO captured at signing is blank whenever the customer raised it later —
     * which is most of the time. Empty means nothing is sent, which is why these
     * fields were arriving blank on QuickBooks invoices and being typed in by hand.
     *
     * The deal board is now consulted for both. See dealReferences.ts for why the
     * precedence differs per field: the proposal wins on Project ID because that is
     * what the customer's signed document says, and the board wins on the PO because
     * the freshest reference the customer gave us is the right one.
     */
    const poFromAcceptance =
      txn.type === 'ESTIMATE'
        ? null
        : ((
            await prisma.acceptedOrder.findUnique({
              where: { proposalVersionId: version.id },
              select: { customerApproval: { select: { poNumber: true } } },
            })
          )?.customerApproval?.poNumber ?? null);

    const depositApplies = depositAppliesOf(version.sections);
    const refs = await resolveInvoiceReferences(
      version.id,
      { projectId: projectIdOf(version.sections), poNumber: poFromAcceptance },
      fetchImpl,
    );
    const projectId = refs.projectId;
    // The custom field's slot number is read from company preferences, not
    // guessed — see customFields.ts. Env var overrides it if ever needed.
    const projectFieldId = projectId
      ? await customFieldId(
          realmId,
          'Project ID',
          process.env.QBO_CUSTOM_FIELD_ID_PROJECT,
          fetchImpl,
        )
      : null;

    /**
     * The customer's PO number, captured when the proposal was marked signed and
     * stored on the order's CustomerApproval record. It belongs on the invoice
     * because it is the reference the customer's accounts-payable team matches
     * against; without it an invoice can sit unpaid pending "which PO is this?".
     *
     * Read from the order rather than the proposal: the PO is part of the
     * acceptance, not part of the quote, and a proposal may be re-accepted with a
     * different one.
     *
     * Slot resolution follows the Project ID precedent — env override first, then
     * the company's own preferences by field NAME. The literal '1' is the final
     * fallback because that is the slot named "Customer Purchase Order #" on this
     * company, and the requirement is specifically custom field 1; a company whose
     * slot 1 is something else should set QBO_CUSTOM_FIELD_ID_PO.
     */
    /**
     * Every invoice flavour carries the PO, not just the full one.
     *
     * A deposit invoice is the first document a customer's accounts-payable team
     * sees, so it is the one most likely to be held up for want of a PO reference.
     * Restricting this to type INVOICE meant the deposit and progress invoices went
     * out without it.
     */
    /**
     * No made-up slot number.
     *
     * This used to fall back to DefinitionId '1' when the lookup found nothing, on
     * the assumption that slot 1 was the PO field. On a company using Intuit's newer
     * Custom Fields feature there are no legacy slots at all: the API accepts the
     * field, silently discards it, and the PO disappears from the invoice AND from
     * the memo — because the memo only carries it when no slot resolved. A guess that
     * loses data is worse than no guess.
     *
     * So the slot is used only when it is genuinely configured, or when an operator
     * has set QBO_CUSTOM_FIELD_ID_PO explicitly. Otherwise the value goes to the
     * memo, which always prints.
     */
    let poNumber: string | null = txn.type === 'ESTIMATE' ? null : refs.poNumber;
    let poFieldId: string | null = null;
    if (poNumber) {
      poFieldId = await customFieldId(
        realmId,
        'Customer Purchase Order #',
        process.env.QBO_CUSTOM_FIELD_ID_PO,
        fetchImpl,
      );
    }

    /**
     * The Note to customer, as a labelled block.
     *
     * Both references are stated here unconditionally rather than only as a fallback.
     * This company's custom fields are on Intuit's newer Custom Fields feature, which
     * the v3 API cannot write — proven by reading back an invoice that visibly has
     * them filled in and getting an empty CustomField array. The note is therefore not
     * a consolation prize, it is the only place either reference can appear on the
     * document the customer receives, so it is formatted to be read rather than
     * scanned: one label per line, in the order accounts payable needs them.
     */
    const memo = [
      projectId ? `Project ID:  ${projectId}` : null,
      poNumber ? `Customer PO:  ${poNumber}` : null,
      `Per Accepted Proposal:  ${version.proposal.number} v${txn.proposalVersion}`,
    ]
      .filter(Boolean)
      .join('\n');
    // Invoice date is today in QuickBooks terms; sent explicitly so the due date
    // can be pinned to it when no payment term governs.
    const txnDate = new Date().toISOString().slice(0, 10);
    let resource: string;
    let body: Record<string, unknown>;
    if (txn.type === 'ESTIMATE') {
      resource = 'estimate';
      body = buildEstimateBody({
        customerQboId,
        currency: totals.currency,
        docNumber,
        billEmail,
        expirationDate: toQboDate(version.expirationDate),
        memo,
        projectId,
        projectFieldId,
        lines: totals.lines,
        fees: totals.fees,
        orderDiscountMinor: totals.orderDiscountMinor,
        taxMinor: totals.taxMinor,
        expectedTotalMinor: totals.grandTotalMinor,
      });
    } else if (txn.type === 'INVOICE') {
      // Full-value itemized invoice: same line structure as the estimate, with
      // the accepted payment split stated as terms and a closing schedule row.
      resource = 'invoice';
      // Resolved here rather than above so an estimate never touches the term
      // tables — the invoice is the only document a payment term applies to.
      /**
       * The deposit choice decides the term AND whether the schedule is stated.
       *
       * Unticked means there is no schedule to state: one payment, due on receipt.
       * Printing "PAYMENT SCHEDULE — Due upfront: 50%" underneath a term of "Due upon
       * receipt" would put two different payment arrangements on one document.
       */
      const term = await resolveTermForInvoice(
        realmId,
        version.proposalId,
        depositApplies,
        fetchImpl,
      );
      body = buildInvoiceBody({
        customerQboId,
        currency: totals.currency,
        docNumber,
        billEmail,
        memo,
        projectId,
        projectFieldId,
        poNumber,
        poFieldId,
        lines: totals.lines,
        fees: totals.fees,
        orderDiscountMinor: totals.orderDiscountMinor,
        taxMinor: totals.taxMinor,
        expectedTotalMinor: totals.grandTotalMinor,
        // Payment term: proposal override -> client default -> system default.
        // Chosen in the portal, never hard-coded per deal.
        salesTermId: term.id,
        // With a term set, QuickBooks derives the due date from it. With none,
        // the invoice is due the day it is issued.
        dueDate: term.id ? null : txnDate,
        txnDate,
        schedule: depositApplies
          ? {
              depositMinor: totals.deposit,
              progressMinor: totals.progress,
              finalMinor: totals.final,
            }
          : null,
      });
    } else {
      // Portion invoices (deposit / progress / final): a single summary line for
      // the scheduled portion. Retained for staged billing.
      resource = 'invoice';
      body = buildPortionInvoiceBody({
        customerQboId,
        currency: totals.currency,
        docNumber,
        billEmail,
        amountMinor: txn.amountMinor,
        description: `${TXN_LABEL[txn.type]} — ${memo}`,
        memo,
      });
    }

    // requestid = idempotencyKey: QuickBooks returns the original on any retry.
    const created = await create<
      Record<string, { Id: string; SyncToken: string; DocNumber?: string }>
    >(realmId, resource, body, txn.idempotencyKey, fetchImpl);
    const obj = created[txn.type === 'ESTIMATE' ? 'Estimate' : 'Invoice'];
    if (!obj) throw new Error(`QuickBooks response missing ${resource} object`);

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.qboTransaction.update({
        where: { id: txnId },
        data: {
          status: 'CREATED',
          qboId: obj.Id,
          qboSyncToken: obj.SyncToken,
          qboDocNumber: obj.DocNumber ?? null,
          customerQboId,
          error: null,
        },
      });
      await tx.integrationSyncLog.create({
        data: {
          provider: 'quickbooks',
          direction: 'OUTBOUND',
          entity: txn.type,
          entityId: txnId,
          externalId: obj.Id,
          status: 'ok',
        },
      });
      return u;
    });
    await recordAudit({
      actorId: userId,
      action: 'qbo.txn.create',
      entity: 'QboTransaction',
      entityId: txnId,
      details: {
        type: txn.type,
        environment: txn.environment,
        qboId: obj.Id,
        docNumber: obj.DocNumber,
      },
    });
    logger.info({ txnId, qboId: obj.Id, type: txn.type }, 'QuickBooks transaction created');
    return updated;
  } catch (err) {
    const message = err instanceof AppError ? err.message : String(err);
    await prisma.qboTransaction.update({
      where: { id: txnId },
      data: { status: 'FAILED', error: message },
    });
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'quickbooks',
        direction: 'OUTBOUND',
        entity: txn.type,
        entityId: txnId,
        status: 'error',
        error: message,
      },
    });
    logger.error({ err, txnId }, 'QuickBooks transaction failed');
    if (err instanceof AppError) throw err;
    throw new AppError('QuickBooks transaction failed', 502, 'QBO_CREATE_FAILED');
  }
}

/**
 * Manual retry of a FAILED transaction. Re-runs execute with the SAME
 * idempotency key, so if QuickBooks actually created the document on the failed
 * attempt it is returned (not duplicated).
 */
export async function retryTransaction(
  txnId: string,
  userId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const txn = await prisma.qboTransaction.findUnique({ where: { id: txnId } });
  if (!txn) throw new NotFoundError('Transaction not found');
  if (txn.status !== 'FAILED')
    throw new ConflictError(`Only FAILED transactions can be retried (status is ${txn.status})`);
  // Return to AUTHORIZED so execute's guard passes; authorization already granted.
  await prisma.qboTransaction.update({ where: { id: txnId }, data: { status: 'AUTHORIZED' } });
  await recordAudit({
    actorId: userId,
    action: 'qbo.txn.retry',
    entity: 'QboTransaction',
    entityId: txnId,
  });
  return executeTransaction(txnId, userId, fetchImpl);
}

export interface TxnFilter {
  status?: QboTxnStatus;
  proposalId?: string;
}

export async function listTransactions(filter: TxnFilter = {}) {
  return prisma.qboTransaction.findMany({
    where: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.proposalId ? { proposalId: filter.proposalId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

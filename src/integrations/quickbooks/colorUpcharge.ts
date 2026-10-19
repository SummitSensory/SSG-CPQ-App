import type {
  ColorUpchargeMode,
  ColorUpchargePush,
  QboEnvironment,
  QboTransaction,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env, qboEnvironment } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../lib/audit.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';
import { create, readById, update } from './client.js';
import { syncTransactionState } from './billing.js';
import {
  assertAssembledTotal,
  formatMinor,
  minorToQboAmount,
  projectCustomField,
} from './mapping.js';
import { sumLineAmounts } from './estimates.js';
import { chargeDetail, chargeItemId } from './chargeItems.js';
import { COLOR_UPCHARGE_SUPPLEMENT } from './freightInvoiced.js';
import { activeRealmId, invoiceForProposal, notifyAccounting } from './freightPush.js';
import { findOrCreateCustomer } from './customers.js';
import { customFieldId } from './customFields.js';
import { resolveTermForProposal } from './terms.js';
import {
  upchargeFromAnswers,
  type PortalUpcharge,
  type UnlinkedUpcharge,
} from '../../portal/colorUpchargeAnswers.js';

export { upchargeFromAnswers, type PortalUpcharge, type UnlinkedUpcharge };

/**
 * The Prismatic paint upcharge a customer agreed to in the portal → their QuickBooks
 * invoice.
 *
 * The customer portal prices Prismatic paint when colours are confirmed ($500 for the
 * first colour, $300 for each further one) and stores the total with the picks — the
 * CRM reads it into the order's COLOR portal item (`answers.totalUpcharge`). No
 * proposal carries it, so until it is on an invoice it has not been billed: before
 * this, it relied on someone reading an email and remembering.
 *
 * Modelled on the freight push (freightPush.ts), for the same reason — this changes
 * what a customer owes on a document they already hold:
 *
 *   nothing paid → a row is added to the order's invoice.
 *   part paid    → a separate upcharge-only invoice (`P-…-CLR`), because raising the
 *                  total of an invoice with a payment on it makes the customer's
 *                  remittance stop matching anything. With the usual 50% deposit,
 *                  this is the common case.
 *
 * And if a staff colour change LOWERS the upcharge after it was billed, the CRM's own
 * row is lowered (or removed) while that invoice is still unpaid; once it has been
 * paid, a credit is a person's call in QuickBooks, and the screen says so.
 *
 * Nothing here is automatic. A person sees the before/after and confirms, exactly as
 * for freight. What makes sure it is not forgotten is the daily check
 * (`unbilledColorUpcharges`, run by /cron/portal-delivery): every order whose portal
 * upcharge differs from what the CRM has billed is emailed to accounting every day
 * until it is billed or marked as handled by hand.
 *
 * The ledger is ColorUpchargePush: one row per change to what has been billed, so the
 * billed amount is their sum and "already billed" never depends on reading an email.
 */

export type UpchargeStatus = 'NONE' | 'UNCONFIRMED' | 'TO_BILL' | 'TO_REDUCE' | 'BILLED';

/** Where an order's upcharge stands, from what the portal says and what was billed. */
export function upchargeStatus(
  owed: bigint | null,
  billed: bigint,
  confirmed: boolean,
): UpchargeStatus {
  if (!confirmed || owed === null)
    return billed !== 0n ? 'BILLED' : owed && owed > 0n ? 'UNCONFIRMED' : 'NONE';
  if (owed > billed) return 'TO_BILL';
  if (owed < billed) return 'TO_REDUCE';
  return owed > 0n ? 'BILLED' : 'NONE';
}

/**
 * The CRM's own upcharge rows carry "Prismatic paint color upcharge … (order <number>)"
 * in their description (see `row` below), so it never mistakes them for one added by
 * hand — whichever item, Primary or Secondary, they are on.
 */
function isOurLine(line: Record<string, unknown>, orderNumber: string): boolean {
  const d = String(line.Description ?? '');
  return d.startsWith('Prismatic paint color upcharge') && d.includes(`(order ${orderNumber})`);
}

/** A Prismatic row the CRM did not write — someone billed it by hand. */
function isHandPrismaticLine(line: Record<string, unknown>, orderNumber: string): boolean {
  if (line.DetailType !== 'SalesItemLineDetail' || isOurLine(line, orderNumber)) return false;
  const item = (line.SalesItemLineDetail as { ItemRef?: { name?: unknown } } | undefined)?.ItemRef
    ?.name;
  return /prismatic/i.test(`${String(line.Description ?? '')} ${String(item ?? '')}`);
}

function lineMinor(line: Record<string, unknown>): bigint {
  return sumLineAmounts([line]);
}

/**
 * The portal's Prismatic prices: $500 for the first colour, $300 for each further
 * one (PRISMATIC_UPCHARGE in the Customer-Portal's lib/colorCatalog.js). SSG's
 * QuickBooks already has an item for each — "Premium Paint Color - Primary" and
 * "- Secondary" — so the upcharge is billed as those two rows rather than one lump.
 */
export const PRIMARY_COLOR_MINOR = 50_000n;
export const ADDITIONAL_COLOR_MINOR = 30_000n;

function row(
  orderNumber: string,
  what: string,
  kind: 'COLOR_UPCHARGE' | 'COLOR_UPCHARGE_ADDITIONAL',
  qty: bigint,
  unitMinor: bigint,
): Record<string, unknown> {
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: minorToQboAmount(qty * unitMinor),
    Description: `Prismatic paint color upcharge — ${what} chosen in the customer portal (order ${orderNumber})`,
    SalesItemLineDetail: {
      ...chargeDetail(kind),
      Qty: Number(qty),
      UnitPrice: minorToQboAmount(unitMinor),
    },
  };
}

/**
 * The CRM's upcharge rows for `amountMinor` on one invoice, where `offsetMinor` of
 * the order's upcharge is already billed on its other invoices (or by hand).
 *
 * The first $500 of the order's upcharge — counted across every invoice — is the
 * Primary row; the rest is Secondary, as N × $300 (or one row for any remainder that
 * isn't a whole number of colours). So $800 at once is Primary + 1 × Secondary, and a
 * later $300 for an added colour is 1 × Secondary on whichever invoice it lands.
 *
 * With no Secondary item configured (QBO_ITEM_ID_COLOR_UPCHARGE_ADDITIONAL), it is
 * one row on the Primary item, as before.
 */
export function upchargeLines(
  orderNumber: string,
  amountMinor: bigint,
  offsetMinor: bigint,
  prismaticColors: number,
): Array<Record<string, unknown>> {
  if (amountMinor <= 0n) return [];
  if (!chargeItemId('COLOR_UPCHARGE_ADDITIONAL')) {
    const what =
      prismaticColors > 0
        ? `${prismaticColors} Prismatic color${prismaticColors === 1 ? '' : 's'}`
        : 'Prismatic colors';
    return [row(orderNumber, what, 'COLOR_UPCHARGE', 1n, amountMinor)];
  }
  const room = PRIMARY_COLOR_MINOR - (offsetMinor > 0n ? offsetMinor : 0n);
  const primary = room <= 0n ? 0n : room < amountMinor ? room : amountMinor;
  const rest = amountMinor - primary;
  const out: Array<Record<string, unknown>> = [];
  if (primary > 0n)
    out.push(row(orderNumber, 'first Prismatic color', 'COLOR_UPCHARGE', 1n, primary));
  if (rest > 0n) {
    if (rest % ADDITIONAL_COLOR_MINOR === 0n) {
      const n = rest / ADDITIONAL_COLOR_MINOR;
      out.push(
        row(
          orderNumber,
          `${n} additional Prismatic color${n === 1n ? '' : 's'}`,
          'COLOR_UPCHARGE_ADDITIONAL',
          n,
          ADDITIONAL_COLOR_MINOR,
        ),
      );
    } else {
      out.push(
        row(orderNumber, 'additional Prismatic colors', 'COLOR_UPCHARGE_ADDITIONAL', 1n, rest),
      );
    }
  }
  return out;
}

/**
 * The invoice's lines with the CRM's upcharge rows replaced by rows for
 * `newOursMinor` (none when it is zero). Every other line is passed back exactly as
 * QuickBooks sent it — QuickBooks replaces the whole Line array on update, so a line
 * dropped here would be deleted from the customer's invoice.
 */
export function withUpchargeLines(
  existing: Array<Record<string, unknown>>,
  orderNumber: string,
  newOursMinor: bigint,
  prismaticColors: number,
  offsetMinor = 0n,
): Array<Record<string, unknown>> {
  if (!existing.length) {
    throw new Error(
      'QuickBooks returned an invoice with no lines. Refusing to update it — that would empty the customer’s invoice.',
    );
  }
  const kept = existing.filter((l) => !isOurLine(l, orderNumber));
  return [...kept, ...upchargeLines(orderNumber, newOursMinor, offsetMinor, prismaticColors)];
}

/* ────────────────────────── state ────────────────────────── */

interface Loaded {
  order: {
    id: string;
    number: string;
    status: string;
    proposalId: string;
    proposalVersionId: string;
    organizationId: string;
    currency: string;
  };
  portal: PortalUpcharge;
  contentHash: string | null;
  pushes: ColorUpchargePush[];
  billedMinor: bigint;
}

async function load(orderId: string): Promise<Loaded> {
  const order = await prisma.acceptedOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      number: true,
      status: true,
      proposalId: true,
      proposalVersionId: true,
      organizationId: true,
      currency: true,
    },
  });
  if (!order) throw new NotFoundError('Order not found');
  const [item, pushes] = await Promise.all([
    prisma.orderPortalItem.findUnique({ where: { orderId_kind: { orderId, kind: 'COLOR' } } }),
    prisma.colorUpchargePush.findMany({ where: { orderId }, orderBy: { pushedAt: 'asc' } }),
  ]);
  return {
    order,
    portal: upchargeFromAnswers(item?.answers ?? null),
    contentHash: item?.contentHash ?? null,
    pushes,
    billedMinor: pushes.reduce((a, p) => a + p.amountMinor, 0n),
  };
}

export interface ColorUpchargeState {
  orderId: string;
  orderNumber: string;
  status: UpchargeStatus;
  owedMinor: string | null;
  billedMinor: string;
  /** What is still to bill (negative: billed more than the portal now says). */
  deltaMinor: string;
  confirmedAt: string | null;
  itemConfigured: boolean;
  pushes: Array<{
    id: string;
    mode: ColorUpchargeMode;
    amountMinor: string;
    qboDocNumber: string | null;
    note: string | null;
    pushedAt: string;
    pushedById: string;
  }>;
  formatted: { owed: string | null; billed: string; delta: string };
}

export async function colorUpchargeState(orderId: string): Promise<ColorUpchargeState> {
  const l = await load(orderId);
  const owed = l.portal.confirmed ? l.portal.totalMinor : null;
  const delta = (owed ?? l.billedMinor) - l.billedMinor;
  return {
    orderId,
    orderNumber: l.order.number,
    status: upchargeStatus(l.portal.totalMinor, l.billedMinor, l.portal.confirmed),
    owedMinor: owed === null ? null : owed.toString(),
    billedMinor: l.billedMinor.toString(),
    deltaMinor: delta.toString(),
    confirmedAt: l.portal.confirmedAt,
    itemConfigured: !!chargeItemId('COLOR_UPCHARGE'),
    pushes: l.pushes.map((p) => ({
      id: p.id,
      mode: p.mode,
      amountMinor: p.amountMinor.toString(),
      qboDocNumber: p.qboDocNumber,
      note: p.note,
      pushedAt: p.pushedAt.toISOString(),
      pushedById: p.pushedById,
    })),
    formatted: {
      owed: owed === null ? null : formatMinor(owed),
      billed: formatMinor(l.billedMinor),
      delta: formatMinor(delta),
    },
  };
}

/* ────────────────────────── preview ────────────────────────── */

export interface ColorUpchargePreview {
  orderId: string;
  mode: 'AMEND' | 'SUPPLEMENT' | 'REDUCE';
  reason: string;
  /** Set when this cannot be done from here — the person must act in QuickBooks. */
  blocked: string | null;
  owedMinor: string;
  billedMinor: string;
  chargeMinor: string;
  invoice: {
    txnId: string;
    qboId: string | null;
    docNumber: string | null;
    currentTotalMinor: string;
    paidMinor: string;
    sentAt: string | null;
  };
  newTotalMinor: string;
  supplementDocNumber: string | null;
  warnings: string[];
  currency: string;
  formatted: { current: string; charge: string; next: string; owed: string; billed: string };
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

type QboInvoiceDoc = {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  Line?: Array<Record<string, unknown>>;
  CustomerMemo?: { value?: string };
};

async function readInvoice(
  realmId: string,
  qboId: string,
  fetchImpl: typeof fetch,
): Promise<QboInvoiceDoc> {
  const read = await readById<{ Invoice?: QboInvoiceDoc }>(realmId, 'invoice', qboId, fetchImpl);
  if (!read.Invoice) throw new AppError('QuickBooks returned no invoice', 502, 'QBO_READ_FAILED');
  return read.Invoice;
}

/** The nth upcharge-only invoice's number: P-2026-0117-CLR, then -CLR2… */
export function upchargeDocNumber(proposalNumber: string, sequence: number): string {
  return sequence <= 1 ? `${proposalNumber}-CLR` : `${proposalNumber}-CLR${sequence}`;
}

/**
 * Before / after, read from QuickBooks rather than from our own record — whether the
 * invoice has been paid is what the whole decision turns on.
 */
export async function colorUpchargePreview(
  orderId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ColorUpchargePreview> {
  const l = await load(orderId);
  if (l.order.status === 'CANCELLED')
    throw new ValidationError('This order is cancelled — nothing is billed for it.');
  if (!l.portal.confirmed || l.portal.totalMinor === null) {
    throw new ValidationError(
      'The customer has not confirmed their colors in the portal, so there is no upcharge to bill yet.',
    );
  }
  const owed = l.portal.totalMinor;
  const delta = owed - l.billedMinor;
  if (delta === 0n)
    throw new ValidationError(
      `Nothing to bill — ${formatMinor(owed)} is already recorded as billed.`,
    );

  const proposal = await prisma.proposal.findUniqueOrThrow({
    where: { id: l.order.proposalId },
    select: { number: true },
  });
  const environment = qboEnvironment() as QboEnvironment;
  const realmId = await activeRealmId(environment);
  const warnings: string[] = [];
  let blocked: string | null = null;

  if (!chargeItemId('COLOR_UPCHARGE')) {
    warnings.push(
      'No QuickBooks item is set for the color upcharge (QBO_ITEM_ID_COLOR_UPCHARGE), so the row will be filed under the company’s default sales item.',
    );
  }

  // Which invoice: the order's main invoice when adding; the one carrying our row
  // when lowering.
  let txn: QboTransaction;
  if (delta > 0n) {
    try {
      txn = await invoiceForProposal(l.order.proposalId);
    } catch {
      throw new ValidationError(
        'There is no QuickBooks invoice for this order yet. Raise the invoice first, then bill the upcharge — the daily reminder keeps listing it until then.',
      );
    }
  } else {
    const lastWrite = [...l.pushes].reverse().find((p) => p.mode !== 'MANUAL' && p.invoiceTxnId);
    if (!lastWrite?.invoiceTxnId) {
      blocked = `The portal upcharge went down to ${formatMinor(owed)}, but the ${formatMinor(l.billedMinor)} billed was recorded by hand. Credit the difference in QuickBooks, then use “Already handled”.`;
      const main = await invoiceForProposal(l.order.proposalId).catch(() => null);
      if (!main) throw new ValidationError(blocked);
      txn = main;
    } else {
      txn = await prisma.qboTransaction.findUniqueOrThrow({
        where: { id: lastWrite.invoiceTxnId },
      });
    }
  }

  try {
    await syncTransactionState(txn.id, fetchImpl);
    txn = await prisma.qboTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  } catch (e) {
    warnings.push(
      `QuickBooks could not be read just now (${e instanceof Error ? e.message : 'unknown error'}), so payment state may be stale.`,
    );
  }
  if (txn.currency !== 'USD') {
    blocked ??= `This order is invoiced in ${txn.currency}; the portal upcharge is in USD. Bill it by hand, then use “Already handled”.`;
  }

  const paid = big(txn.paidMinor ?? 0);
  const current = big(txn.qboTotalMinor ?? txn.amountMinor);
  let mode: ColorUpchargePreview['mode'];
  let next: bigint;
  let supplementDoc: string | null = null;

  // What QuickBooks itself holds, so nothing the CRM did not record is billed twice.
  const lines =
    txn.qboId && !blocked ? ((await readInvoice(realmId, txn.qboId, fetchImpl)).Line ?? []) : [];
  const oursOnInvoice = lines
    .filter((x) => isOurLine(x, l.order.number))
    .reduce((a, x) => a + lineMinor(x), 0n);
  const recordedOnInvoice = l.pushes
    .filter((p) => p.invoiceTxnId === txn.id && p.mode !== 'MANUAL')
    .reduce((a, p) => a + p.amountMinor, 0n);
  const hand = lines.find((x) => isHandPrismaticLine(x, l.order.number));

  if (delta > 0n) {
    if (hand && !blocked) {
      blocked = `Invoice ${txn.qboDocNumber ?? txn.qboId} already has a Prismatic row someone added by hand (“${String(hand.Description ?? '').slice(0, 120)}”). If it covers this upcharge, use “Already billed by hand”; otherwise remove it in QuickBooks first.`;
    }
    if (oursOnInvoice !== recordedOnInvoice && !blocked) {
      blocked = `Invoice ${txn.qboDocNumber ?? txn.qboId} carries ${formatMinor(oursOnInvoice)} of this order’s upcharge, but the CRM recorded ${formatMinor(recordedOnInvoice)} on it. Check the invoice in QuickBooks, then use “Already billed by hand” for whatever is already there.`;
    }
    mode = paid > 0n ? 'SUPPLEMENT' : 'AMEND';
    next = mode === 'AMEND' ? current + delta : delta;
    if (mode === 'SUPPLEMENT') {
      const prior = await prisma.qboTransaction.count({
        where: {
          proposalId: l.order.proposalId,
          type: 'INVOICE',
          status: 'CREATED',
          totalsSnapshot: { path: ['kind'], equals: COLOR_UPCHARGE_SUPPLEMENT },
        },
      });
      supplementDoc = upchargeDocNumber(proposal.number, prior + 1);
      if (prior > 0)
        warnings.push(
          `${prior} upcharge invoice${prior === 1 ? ' has' : 's have'} already been raised on this job. This is a further one, for the increase only.`,
        );
    } else if (txn.sentAt) {
      warnings.push(
        `This invoice was already emailed to the customer on ${txn.sentAt.toISOString().slice(0, 10)}. Adding the upcharge changes what they owe — re-send it afterwards.`,
      );
    }
  } else {
    mode = 'REDUCE';
    next = current + delta;
    if (!blocked && paid > 0n) {
      blocked = `The upcharge went down by ${formatMinor(-delta)}, but invoice ${txn.qboDocNumber ?? txn.qboId} has ${formatMinor(paid)} paid against it. Issue a credit in QuickBooks, then use “Already handled”.`;
    }
    if (!blocked && oursOnInvoice < -delta) {
      blocked = `Invoice ${txn.qboDocNumber ?? txn.qboId} carries only ${formatMinor(oursOnInvoice)} of this order’s upcharge, less than the ${formatMinor(-delta)} to take off. Adjust it in QuickBooks, then use “Already handled”.`;
    }
    const others = lines.filter(
      (x) => x.DetailType === 'SalesItemLineDetail' && !isOurLine(x, l.order.number),
    );
    if (!blocked && oursOnInvoice + delta === 0n && !others.length) {
      blocked = `That would leave upcharge invoice ${txn.qboDocNumber ?? txn.qboId} with nothing on it. Void it in QuickBooks, then use “Already handled”.`;
    }
  }

  return {
    orderId,
    mode,
    reason:
      mode === 'AMEND'
        ? 'No payment has been applied, so the upcharge goes onto the existing invoice.'
        : mode === 'SUPPLEMENT'
          ? `${formatMinor(paid, txn.currency)} has been paid against invoice ${txn.qboDocNumber ?? txn.qboId}, so the upcharge is raised as a separate upcharge-only invoice.`
          : `The portal upcharge went down (a staff color change), so the CRM’s upcharge row on invoice ${txn.qboDocNumber ?? txn.qboId} is lowered while the invoice is unpaid.`,
    blocked,
    owedMinor: owed.toString(),
    billedMinor: l.billedMinor.toString(),
    chargeMinor: delta.toString(),
    invoice: {
      txnId: txn.id,
      qboId: txn.qboId,
      docNumber: txn.qboDocNumber,
      currentTotalMinor: current.toString(),
      paidMinor: paid.toString(),
      sentAt: txn.sentAt ? txn.sentAt.toISOString() : null,
    },
    newTotalMinor: next.toString(),
    supplementDocNumber: supplementDoc,
    warnings,
    currency: txn.currency,
    formatted: {
      current: formatMinor(current, txn.currency),
      charge: formatMinor(delta, txn.currency),
      next: formatMinor(next, txn.currency),
      owed: formatMinor(owed),
      billed: formatMinor(l.billedMinor),
    },
  };
}

/* ────────────────────────── the push ────────────────────────── */

export interface ColorUpchargePushResult {
  mode: ColorUpchargePreview['mode'];
  docNumber: string | null;
  previousTotalMinor: string;
  newTotalMinor: string;
  chargeMinor: string;
  notifyError: string | null;
}

function pushKeyFor(orderId: string, contentHash: string | null, delta: bigint): string {
  return `${orderId}:${contentHash ?? 'none'}:${delta.toString()}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * Do it. Requires the confirmed figures from the preview: if anything moved in
 * between — a payment landed, the customer's upcharge changed — nothing is sent.
 */
export async function pushColorUpcharge(
  orderId: string,
  userId: string,
  confirm: {
    expectedCurrentTotalMinor: string;
    expectedNewTotalMinor: string;
    expectedChargeMinor: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ColorUpchargePushResult> {
  const environment = qboEnvironment() as QboEnvironment;
  if (environment === 'PRODUCTION' && !env.QBO_PRODUCTION_WRITE_ENABLED) {
    throw new ForbiddenError(
      'Production QuickBooks writes are disabled. Set QBO_PRODUCTION_WRITE_ENABLED=true once the production test plan is authorized.',
    );
  }

  const preview = await colorUpchargePreview(orderId, fetchImpl);
  if (preview.blocked) throw new ConflictError(preview.blocked);
  if (
    preview.invoice.currentTotalMinor !== confirm.expectedCurrentTotalMinor ||
    preview.newTotalMinor !== confirm.expectedNewTotalMinor ||
    preview.chargeMinor !== confirm.expectedChargeMinor
  ) {
    throw new ConflictError(
      `The figures changed while you were looking at them — the upcharge to bill is now ${preview.formatted.charge} and the invoice is ${preview.formatted.current}. Nothing has been sent. Review the new figures and confirm again.`,
    );
  }

  const l = await load(orderId);
  const delta = BigInt(preview.chargeMinor);
  const pushKey = pushKeyFor(orderId, l.contentHash, delta);
  if (await prisma.colorUpchargePush.findUnique({ where: { pushKey } })) {
    throw new ConflictError(
      'This upcharge was already billed just now. Refresh the order before trying again.',
    );
  }

  const realmId = await activeRealmId(environment);
  const txn = await prisma.qboTransaction.findUniqueOrThrow({
    where: { id: preview.invoice.txnId },
  });
  if (!txn.qboId) throw new ConflictError('That invoice has no QuickBooks id');
  const proposal = await prisma.proposal.findUniqueOrThrow({ where: { id: l.order.proposalId } });
  const noteDate = new Date().toISOString().slice(0, 10);

  try {
    let invoiceTxnId = txn.id;
    let docNumber: string | null = txn.qboDocNumber;

    if (preview.mode === 'AMEND' || preview.mode === 'REDUCE') {
      const invoice = await readInvoice(realmId, txn.qboId, fetchImpl);
      const existing = invoice.Line ?? [];
      const oursNow = existing
        .filter((x) => isOurLine(x, l.order.number))
        .reduce((a, x) => a + lineMinor(x), 0n);
      // What the order's other invoices (and anything recorded by hand) already
      // carry, so the Primary row is only billed once across them.
      const lines = withUpchargeLines(
        existing,
        l.order.number,
        oursNow + delta,
        l.portal.prismaticColors,
        l.billedMinor - oursNow,
      );
      assertAssembledTotal('Invoice', sumLineAmounts(lines), BigInt(preview.newTotalMinor), [
        [`${existing.length} existing lines`, sumLineAmounts(existing)],
        ['color upcharge change', delta],
      ]);
      const note =
        preview.mode === 'AMEND'
          ? `Prismatic color upcharge added ${noteDate}`
          : `Prismatic color upcharge reduced ${noteDate}`;
      const memo = [String(invoice.CustomerMemo?.value ?? '').trim(), note]
        .filter(Boolean)
        .join('  ·  ');
      // An update, not a create: QuickBooks refuses a stale SyncToken, so a retry or
      // a second click can never add the row twice.
      const saved = await update<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(
        realmId,
        'invoice',
        {
          Id: invoice.Id,
          SyncToken: invoice.SyncToken,
          Line: lines,
          CustomerMemo: { value: memo },
        },
        fetchImpl,
      );
      docNumber = saved.Invoice.DocNumber ?? txn.qboDocNumber;
      await prisma.qboTransaction.update({
        where: { id: txn.id },
        data: {
          qboSyncToken: saved.Invoice.SyncToken,
          qboTotalMinor: BigInt(preview.newTotalMinor),
          amountMinor: BigInt(preview.newTotalMinor),
        },
      });
    } else {
      const version = await prisma.proposalVersion.findUniqueOrThrow({
        where: { id: l.order.proposalVersionId },
      });
      const { qboId: customerQboId, email: billEmail } = await findOrCreateCustomer(
        proposal.organizationId,
        realmId,
        userId,
        fetchImpl,
      );
      const projectId = String(
        (Array.isArray(version.sections)
          ? (version.sections as Array<{ id?: string; data?: { projectId?: unknown } }>).find(
              (s) => s?.id === 'meta',
            )?.data?.projectId
          : '') ?? '',
      ).trim();
      const projectFieldId = projectId
        ? await customFieldId(
            realmId,
            'Project ID',
            process.env.QBO_CUSTOM_FIELD_ID_PROJECT,
            fetchImpl,
          )
        : null;
      const term = await resolveTermForProposal(proposal.id);
      const docNo = preview.supplementDocNumber ?? upchargeDocNumber(proposal.number, 1);
      const lines = upchargeLines(l.order.number, delta, l.billedMinor, l.portal.prismaticColors);
      assertAssembledTotal('Invoice', sumLineAmounts(lines), delta, [['color upcharge', delta]]);
      const customField = projectCustomField(projectId, projectFieldId);
      const body = {
        CustomerRef: { value: customerQboId },
        CurrencyRef: { value: txn.currency },
        ...(customField.length ? { CustomField: customField } : {}),
        DocNumber: docNo,
        ...(billEmail ? { BillEmail: { Address: billEmail } } : {}),
        TxnDate: noteDate,
        ...(term.id ? { SalesTermRef: { value: term.id } } : { DueDate: noteDate }),
        CustomerMemo: {
          value: `Prismatic paint color upcharge for accepted proposal ${proposal.number}, invoice ${txn.qboDocNumber ?? txn.qboId}. Chosen in the customer portal after the original invoice was issued.`,
        },
        Line: lines,
      };
      // requestid: a retry of this exact push returns the same invoice rather than a second one.
      const saved = await create<{
        Invoice: { Id: string; SyncToken: string; DocNumber?: string };
      }>(realmId, 'invoice', body, `qbo:color-upcharge:supplement:${pushKey}`, fetchImpl);
      docNumber = saved.Invoice.DocNumber ?? docNo;
      try {
        const supplement = await prisma.qboTransaction.create({
          data: {
            type: 'INVOICE',
            environment,
            status: 'CREATED',
            proposalId: proposal.id,
            proposalVersionId: version.id,
            proposalVersion: version.version,
            currency: txn.currency,
            proposalTotalMinor: delta,
            amountMinor: delta,
            totalsSnapshot: {
              kind: COLOR_UPCHARGE_SUPPLEMENT,
              orderId,
              followsTxnId: txn.id,
              followsDocNumber: txn.qboDocNumber,
              portalTotalMinor: preview.owedMinor,
            } as object,
            idempotencyKey: `qbo:${environment}:INVOICE:${version.id}:color:${pushKey}`,
            customerQboId,
            qboId: saved.Invoice.Id,
            qboSyncToken: saved.Invoice.SyncToken,
            qboDocNumber: docNumber,
            initiatedById: userId,
            authorizedById: userId,
            authorizedAt: new Date(),
          },
        });
        invoiceTxnId = supplement.id;
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ConflictError(
            'This upcharge was already billed by another request just now. Refresh the order before trying again.',
          );
        throw err;
      }
      await prisma.integrationSyncLog.create({
        data: {
          provider: 'quickbooks',
          direction: 'OUTBOUND',
          entity: 'INVOICE',
          entityId: invoiceTxnId,
          externalId: saved.Invoice.Id,
          status: 'ok',
        },
      });
    }

    try {
      await prisma.colorUpchargePush.create({
        data: {
          orderId,
          pushKey,
          portalContentHash: l.contentHash ?? 'none',
          portalTotalMinor: BigInt(preview.owedMinor),
          amountMinor: delta,
          mode: preview.mode,
          invoiceTxnId,
          qboDocNumber: docNumber,
          previousTotalMinor: BigInt(preview.invoice.currentTotalMinor),
          newTotalMinor: BigInt(preview.newTotalMinor),
          pushedById: userId,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictError(
          'This upcharge was already billed by another request just now. Refresh the order before trying again.',
        );
      throw err;
    }

    const what = preview.mode === 'REDUCE' ? 'reduced' : 'billed';
    const notifyError = await notifyAccounting(
      `${proposal.number}: Prismatic color upcharge ${preview.formatted.charge} ${what} — ${
        preview.mode === 'SUPPLEMENT'
          ? `upcharge invoice ${docNumber ?? ''}`
          : `invoice now ${preview.formatted.next}`
      }`,
      [
        `Order ${l.order.number} — proposal ${proposal.number} (${proposal.title})`,
        '',
        preview.mode === 'AMEND'
          ? `Invoice ${docNumber ?? txn.qboId} was amended in QuickBooks.`
          : preview.mode === 'REDUCE'
            ? `The upcharge row on invoice ${docNumber ?? txn.qboId} was lowered (staff changed the customer's colors).`
            : `Upcharge invoice ${docNumber ?? ''} was raised (invoice ${txn.qboDocNumber ?? txn.qboId} had payments applied).`,
        `Upcharge the customer agreed to in the portal: ${preview.formatted.owed}`,
        `Billed before this: ${preview.formatted.billed}`,
        `This change: ${preview.formatted.charge}`,
        preview.mode === 'SUPPLEMENT'
          ? `New invoice total: ${preview.formatted.next}`
          : `Invoice was ${preview.formatted.current}, now ${preview.formatted.next}`,
        '',
        `Done by user ${userId} from the CPQ application.`,
      ].join('\n'),
    );

    await recordAudit({
      actorId: userId,
      action: 'color.upcharge.qbo_push',
      entity: 'AcceptedOrder',
      entityId: orderId,
      details: {
        mode: preview.mode,
        environment,
        invoiceTxnId,
        docNumber,
        chargeMinor: preview.chargeMinor,
        owedMinor: preview.owedMinor,
        previousTotalMinor: preview.invoice.currentTotalMinor,
        newTotalMinor: preview.newTotalMinor,
        notifyError,
      },
    });
    logger.info(
      { orderId, mode: preview.mode, chargeMinor: preview.chargeMinor },
      'color upcharge pushed to QuickBooks',
    );

    return {
      mode: preview.mode,
      docNumber,
      previousTotalMinor: preview.invoice.currentTotalMinor,
      newTotalMinor: preview.newTotalMinor,
      chargeMinor: preview.chargeMinor,
      notifyError,
    };
  } catch (err) {
    const message = err instanceof AppError ? err.message : String(err);
    await prisma.integrationSyncLog.create({
      data: {
        provider: 'quickbooks',
        direction: 'OUTBOUND',
        entity: 'INVOICE',
        entityId: orderId,
        status: 'error',
        error: message,
      },
    });
    await recordAudit({
      actorId: userId,
      action: 'color.upcharge.qbo_push_failed',
      entity: 'AcceptedOrder',
      entityId: orderId,
      details: { error: message, mode: preview.mode, chargeMinor: preview.chargeMinor },
    });
    logger.error({ err, orderId }, 'color upcharge push to QuickBooks failed');
    if (err instanceof AppError) throw err;
    throw new AppError(
      'QuickBooks did not accept the color upcharge',
      502,
      'QBO_COLOR_UPCHARGE_PUSH_FAILED',
    );
  }
}

/**
 * Record that the difference was dealt with outside the CRM — billed or credited by
 * hand in QuickBooks, or not to be charged. Needs a note, and the figure the person
 * saw, so a stale screen cannot clear a different amount.
 */
export async function markColorUpchargeHandled(
  orderId: string,
  userId: string,
  input: { note: string; expectedChargeMinor: string },
): Promise<ColorUpchargeState> {
  const note = input.note.trim();
  if (note.length < 3)
    throw new ValidationError('Say what was done (e.g. “added to invoice 1050 by hand”).');
  const l = await load(orderId);
  if (!l.portal.confirmed || l.portal.totalMinor === null) {
    throw new ValidationError(
      'The customer has not confirmed their colors in the portal, so there is nothing to record.',
    );
  }
  const delta = l.portal.totalMinor - l.billedMinor;
  if (delta === 0n) throw new ValidationError('Nothing is outstanding on this order’s upcharge.');
  if (delta.toString() !== input.expectedChargeMinor) {
    throw new ConflictError(
      `The upcharge changed while you were looking at it — ${formatMinor(delta)} is now outstanding. Review it and confirm again.`,
    );
  }
  try {
    await prisma.colorUpchargePush.create({
      data: {
        orderId,
        pushKey: pushKeyFor(orderId, l.contentHash, delta),
        portalContentHash: l.contentHash ?? 'none',
        portalTotalMinor: l.portal.totalMinor,
        amountMinor: delta,
        mode: 'MANUAL',
        note: note.slice(0, 1000),
        pushedById: userId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new ConflictError('This was already recorded just now. Refresh the order.');
    throw err;
  }
  await recordAudit({
    actorId: userId,
    action: 'color.upcharge.manual',
    entity: 'AcceptedOrder',
    entityId: orderId,
    details: { chargeMinor: delta.toString(), owedMinor: l.portal.totalMinor.toString(), note },
  });
  return colorUpchargeState(orderId);
}

/* ────────────────────────── the daily check ────────────────────────── */

export interface UnbilledUpcharge {
  orderId: string;
  orderNumber: string;
  customer: string;
  status: UpchargeStatus;
  deltaMinor: string;
  owedMinor: string;
  confirmedAt: string | null;
}

/** Every live order whose confirmed portal upcharge differs from what was billed. */
export async function unbilledColorUpcharges(): Promise<UnbilledUpcharge[]> {
  const items = await prisma.orderPortalItem.findMany({
    where: { kind: 'COLOR' },
    select: { orderId: true, answers: true },
  });
  const owedByOrder = new Map<string, PortalUpcharge>();
  for (const i of items) {
    const u = upchargeFromAnswers(i.answers);
    if (u.confirmed && u.totalMinor !== null) owedByOrder.set(i.orderId, u);
  }
  const pushes = await prisma.colorUpchargePush.groupBy({
    by: ['orderId'],
    _sum: { amountMinor: true },
  });
  const billedByOrder = new Map(pushes.map((p) => [p.orderId, p._sum.amountMinor ?? 0n]));

  const candidates = [...owedByOrder.entries()].filter(
    ([orderId, u]) => (u.totalMinor ?? 0n) !== (billedByOrder.get(orderId) ?? 0n),
  );
  if (!candidates.length) return [];
  const orders = await prisma.acceptedOrder.findMany({
    where: { id: { in: candidates.map(([id]) => id) }, status: { not: 'CANCELLED' } },
    select: { id: true, number: true, organizationId: true, jobName: true },
  });
  const orgs = await prisma.organization.findMany({
    where: { id: { in: [...new Set(orders.map((o) => o.organizationId))] } },
    select: { id: true, name: true },
  });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return orders
    .map((o) => {
      const u = owedByOrder.get(o.id)!;
      const billed = billedByOrder.get(o.id) ?? 0n;
      const owed = u.totalMinor ?? 0n;
      return {
        orderId: o.id,
        orderNumber: o.number,
        customer: orgName.get(o.organizationId) ?? o.jobName ?? '',
        status: upchargeStatus(owed, billed, true),
        deltaMinor: (owed - billed).toString(),
        owedMinor: owed.toString(),
        confirmedAt: u.confirmedAt,
      };
    })
    .sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt)));
}

/**
 * The daily reminder to accounting: every upcharge not yet billed, and every one on
 * a monday row no order is linked to (so it cannot be billed from the CRM until it
 * is). Sent every day while the list is not empty — that is the point.
 */
export async function sendUpchargeReminder(
  unlinked: UnlinkedUpcharge[] = [],
): Promise<{ unbilled: number; unlinked: number; notifyError: string | null }> {
  const unbilled = await unbilledColorUpcharges();
  if (!unbilled.length && !unlinked.length) return { unbilled: 0, unlinked: 0, notifyError: null };
  const total = unbilled.reduce((a, u) => a + BigInt(u.deltaMinor), 0n);
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'date unknown');
  const body = [
    unbilled.length
      ? `Prismatic color upcharges confirmed by customers in the portal and not yet billed (open each order → Customer Portal → Color selections → Bill to QuickBooks):`
      : '',
    ...unbilled.map(
      (u) =>
        `  ${u.orderNumber} — ${u.customer}: ${u.status === 'TO_REDUCE' ? 'reduce by' : 'bill'} ${formatMinor(BigInt(u.deltaMinor) < 0n ? -BigInt(u.deltaMinor) : BigInt(u.deltaMinor))} (portal total ${formatMinor(BigInt(u.owedMinor))}, confirmed ${day(u.confirmedAt)})`,
    ),
    unlinked.length
      ? `\nConfirmed upcharges on Manufacturing Process rows that are not linked to a CRM order — link the order (or bill these by hand):`
      : '',
    ...unlinked.map(
      (u) =>
        `  ${u.name} (monday item ${u.mondayItemId}): ${formatMinor(BigInt(u.totalMinor))}, confirmed ${day(u.confirmedAt)}`,
    ),
    '',
    'This reminder is sent every day until each one is billed or marked as handled by hand.',
  ]
    .filter((x) => x !== '')
    .join('\n');
  const notifyError = await notifyAccounting(
    `Prismatic upcharges to bill: ${unbilled.length + unlinked.length}${unbilled.length ? ` (${formatMinor(total)})` : ''}`,
    body,
  );
  return { unbilled: unbilled.length, unlinked: unlinked.length, notifyError };
}

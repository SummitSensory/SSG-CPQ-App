/**
 * Strategic Partnership Proposals: the record, its calculated economics, and the
 * generation run that turns both into a Canva document and an archived PDF.
 *
 * The CRM is authoritative. A rep enters the assumptions; the backend calculates
 * every output (calculate.ts) on every save and stores it — the browser never sends
 * a calculated figure, and nothing here accepts one. 3-Year Equipment Savings is one
 * of those stored columns, not a value derived at display time.
 *
 * Generation replaces the old Power Automate + Excel flow with the CRM talking to
 * Canva directly. It is a small state machine persisted on the record, advanced in
 * short steps, because a serverless request has a 30-second budget and a Canva
 * Autofill followed by a PDF export can take longer:
 *
 *   ASSETS -> AUTOFILL_START -> AUTOFILL -> EXPORT_START -> EXPORT -> DONE
 *
 * `generate` starts a run and takes the first steps; `advance` (polled by the
 * screen while the run is open) takes the next ones. A step never blocks waiting on
 * Canva: it starts a job or checks one, and returns. A lease on the run stops two
 * polls from doing the same step twice, and the run id makes a double-click return
 * the run already in flight instead of starting a second one.
 */
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { Prisma } from '@prisma/client';
import type { StrategicPartnershipProposal, StrategicPartnershipStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { allocateNumbered, formatNumber } from '../lib/documentNumber.js';
import { divRound } from '../pricing/decimal.js';
import {
  type PartnershipInputs,
  type PartnershipOutputs,
  CALCULATION_VERSION,
  PartnershipInputError,
  calculatePartnership,
  formatPercentBps,
} from './calculate.js';
import { type CopyContext, IMAGE_FIELDS, renderTemplate, renderTextFields } from './copy.js';
import { getPartnershipSettings } from './settings.js';
import type {
  AutofillValue,
  BrandTemplateDataset,
  CanvaApi,
  ChartData,
} from '../integrations/canva/client.js';

/* ======================================================================= types */

export interface StoredFile {
  url: string;
  pathname: string;
  filename: string;
  contentType: string;
  bytes: number;
}

export type GenerationPhase =
  'ASSETS' | 'AUTOFILL_START' | 'AUTOFILL' | 'EXPORT_START' | 'EXPORT' | 'DONE' | 'FAILED';

export interface GenerationState {
  runId: string;
  phase: GenerationPhase;
  startedAt: string;
  startedById: string;
  leaseUntil: string | null;
  assets: Record<string, { pathname: string; jobId?: string; assetId?: string }>;
  autofillJobId?: string;
  designId?: string;
  exportJobId?: string;
  warnings: string[];
  log: Array<{ at: string; message: string }>;
}

const IN_FLIGHT: StrategicPartnershipStatus[] = ['CALCULATING', 'GENERATING_CANVA'];
const EDITABLE: StrategicPartnershipStatus[] = [
  'DRAFT',
  'READY_TO_GENERATE',
  'READY_FOR_REVIEW',
  'ERROR',
];

/** A run that has not finished in this long is failed rather than polled forever. */
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
/** How long one advance call holds the run. Below the function's 30-second budget. */
const LEASE_MS = 25_000;
/** Work budget for one advance call before it hands back to the poller. */
const STEP_BUDGET_MS = 18_000;

/** US Letter portrait in PDF points, and the tolerance a design tool's rounding needs. */
export const LETTER_WIDTH_PT = 612;
export const LETTER_HEIGHT_PT = 792;
const PAGE_TOLERANCE_PT = 1.5;

export const MAX_PROJECT_IMAGES = 5;

/* ================================================================ required set */

/** The inputs the financial model and the Canva master both need. Label for the screen. */
export const REQUIRED_INPUTS: ReadonlyArray<[keyof StrategicPartnershipProposal, string]> = [
  ['customerShortName', 'Customer short name'],
  ['customerFullName', 'Customer full name'],
  ['executiveName', 'Executive name'],
  ['executiveTitle', 'Executive title'],
  ['industry', 'Industry / segment'],
  ['partnerDiscountBps', 'Partner discount'],
  ['standardProjectValueMinor', 'Standard project value'],
  ['pmHoursReturnedPerCenterHundredths', 'PM hours returned per center'],
  ['pmHourValueMinor', 'Internal PM hourly value'],
  ['year1PlannedCenters', 'Year 1 planned centers'],
  ['year2PlannedCenters', 'Year 2 planned centers'],
  ['year3PlannedCenters', 'Year 3 planned centers'],
];

type InputRow = Pick<
  StrategicPartnershipProposal,
  | 'customerShortName'
  | 'customerFullName'
  | 'executiveName'
  | 'executiveTitle'
  | 'industry'
  | 'partnerDiscountBps'
  | 'standardProjectValueMinor'
  | 'pmHoursReturnedPerCenterHundredths'
  | 'pmHourValueMinor'
  | 'year1PlannedCenters'
  | 'year2PlannedCenters'
  | 'year3PlannedCenters'
  | 'year4PlannedCenters'
  | 'year5PlannedCenters'
>;

/** Labels of the required inputs this record is missing. Empty means complete. */
export function missingInputs(row: InputRow): string[] {
  const out: string[] = [];
  for (const [key, label] of REQUIRED_INPUTS) {
    const v = (row as Record<string, unknown>)[key as string];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === ''))
      out.push(label);
  }
  return out;
}

/** DRAFT until every required input is present, then READY_TO_GENERATE. */
export function derivedDraftStatus(row: InputRow): StrategicPartnershipStatus {
  return missingInputs(row).length ? 'DRAFT' : 'READY_TO_GENERATE';
}

/** The calculation inputs, or null while any is missing. */
export function calculationInputs(row: InputRow): PartnershipInputs | null {
  if (
    row.partnerDiscountBps == null ||
    row.standardProjectValueMinor == null ||
    row.pmHoursReturnedPerCenterHundredths == null ||
    row.pmHourValueMinor == null ||
    row.year1PlannedCenters == null ||
    row.year2PlannedCenters == null ||
    row.year3PlannedCenters == null
  ) {
    return null;
  }
  return {
    partnerDiscountBps: row.partnerDiscountBps,
    standardProjectValueMinor: row.standardProjectValueMinor,
    pmHoursReturnedPerCenterHundredths: row.pmHoursReturnedPerCenterHundredths,
    pmHourValueMinor: row.pmHourValueMinor,
    year1PlannedCenters: row.year1PlannedCenters,
    year2PlannedCenters: row.year2PlannedCenters,
    year3PlannedCenters: row.year3PlannedCenters,
    year4PlannedCenters: row.year4PlannedCenters,
    year5PlannedCenters: row.year5PlannedCenters,
  };
}

/** The stored-output columns for a calculation, or all-null when it cannot run. */
export type OutputColumns = Pick<
  StrategicPartnershipProposal,
  | 'partnerProjectValueMinor'
  | 'savingsPerCenterMinor'
  | 'threeYearEquipmentSavingsMinor'
  | 'fiveYearEquipmentSavingsMinor'
  | 'pmCapacityValuePerCenterMinor'
  | 'threeYearPmCapacityValueMinor'
  | 'fiveYearPmCapacityValueMinor'
  | 'threeYearCombinedValueMinor'
  | 'fiveYearCombinedValueMinor'
  | 'threeYearCumulativeCenters'
  | 'fiveYearCumulativeCenters'
  | 'calculatedAt'
  | 'calculationVersion'
>;

export function outputColumns(outputs: PartnershipOutputs | null, at: Date): OutputColumns {
  if (!outputs) {
    return {
      partnerProjectValueMinor: null,
      savingsPerCenterMinor: null,
      threeYearEquipmentSavingsMinor: null,
      fiveYearEquipmentSavingsMinor: null,
      pmCapacityValuePerCenterMinor: null,
      threeYearPmCapacityValueMinor: null,
      fiveYearPmCapacityValueMinor: null,
      threeYearCombinedValueMinor: null,
      fiveYearCombinedValueMinor: null,
      threeYearCumulativeCenters: null,
      fiveYearCumulativeCenters: null,
      calculatedAt: null,
      calculationVersion: null,
    };
  }
  return {
    partnerProjectValueMinor: outputs.partnerProjectValueMinor,
    savingsPerCenterMinor: outputs.savingsPerCenterMinor,
    threeYearEquipmentSavingsMinor: outputs.threeYearEquipmentSavingsMinor,
    fiveYearEquipmentSavingsMinor: outputs.fiveYearEquipmentSavingsMinor,
    pmCapacityValuePerCenterMinor: outputs.pmCapacityValuePerCenterMinor,
    threeYearPmCapacityValueMinor: outputs.threeYearPmCapacityValueMinor,
    fiveYearPmCapacityValueMinor: outputs.fiveYearPmCapacityValueMinor,
    threeYearCombinedValueMinor: outputs.threeYearCombinedValueMinor,
    fiveYearCombinedValueMinor: outputs.fiveYearCombinedValueMinor,
    threeYearCumulativeCenters: outputs.threeYearCumulativeCenters,
    fiveYearCumulativeCenters: outputs.fiveYearCumulativeCenters,
    calculatedAt: at,
    calculationVersion: CALCULATION_VERSION,
  };
}

function calculateOrThrow(
  inputs: PartnershipInputs | null,
  scaleCenters: readonly number[],
): PartnershipOutputs | null {
  if (!inputs) return null;
  try {
    return calculatePartnership(inputs, scaleCenters);
  } catch (err) {
    if (err instanceof PartnershipInputError) throw new ValidationError(err.message);
    throw err;
  }
}

/* ======================================================================== DTO */

function num(v: bigint | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('money value exceeds the safe integer range');
  return n;
}

/** Cents -> "16514" / "16514.5" for re-filling the form. */
function dollarsInput(v: bigint | null): string {
  if (v === null) return '';
  const whole = v / 100n;
  const frac = (v % 100n).toString().padStart(2, '0');
  return frac === '00' ? whole.toString() : `${whole}.${frac}`;
}

function hundredthsInput(v: number | null): string {
  if (v === null) return '';
  const whole = Math.trunc(v / 100);
  const frac = String(v % 100).padStart(2, '0');
  return frac === '00' ? String(whole) : `${whole}.${frac}`.replace(/0$/, '');
}

export function asStoredFile(v: unknown): StoredFile | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || typeof o.pathname !== 'string') return null;
  return {
    url: o.url,
    pathname: o.pathname,
    filename: typeof o.filename === 'string' ? o.filename : 'image',
    contentType: typeof o.contentType === 'string' ? o.contentType : 'image/png',
    bytes: typeof o.bytes === 'number' ? o.bytes : 0,
  };
}

/** Always five slots, PROJECT_IMAGE_1..5, null where empty. */
export function projectImageSlots(v: unknown): Array<StoredFile | null> {
  const arr = Array.isArray(v) ? v : [];
  return Array.from({ length: MAX_PROJECT_IMAGES }, (_, i) => asStoredFile(arr[i]));
}

function fileDto(f: StoredFile | null) {
  return f ? { filename: f.filename, contentType: f.contentType, bytes: f.bytes } : null;
}

export function asGeneration(v: unknown): GenerationState | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as Partial<GenerationState>;
  if (typeof g.runId !== 'string' || typeof g.phase !== 'string') return null;
  return {
    runId: g.runId,
    phase: g.phase,
    startedAt: String(g.startedAt ?? ''),
    startedById: String(g.startedById ?? ''),
    leaseUntil: g.leaseUntil ?? null,
    assets: g.assets ?? {},
    autofillJobId: g.autofillJobId,
    designId: g.designId,
    exportJobId: g.exportJobId,
    warnings: Array.isArray(g.warnings) ? g.warnings : [],
    log: Array.isArray(g.log) ? g.log : [],
  };
}

type RowWithOrg = StrategicPartnershipProposal & {
  organization?: { id: string; name: string } | null;
};

export function toDto(row: RowWithOrg) {
  const gen = asGeneration(row.generation);
  const missing = missingInputs(row);
  return {
    id: row.id,
    number: row.number,
    organizationId: row.organizationId,
    organizationName: row.organization?.name ?? null,
    opportunityId: row.opportunityId,
    status: row.status,
    inputs: {
      customerShortName: row.customerShortName,
      customerFullName: row.customerFullName,
      executiveName: row.executiveName,
      executiveTitle: row.executiveTitle,
      industry: row.industry,
      partnerDiscountPercent:
        row.partnerDiscountBps === null
          ? ''
          : formatPercentBps(row.partnerDiscountBps).replace('%', ''),
      standardProjectValue: dollarsInput(row.standardProjectValueMinor),
      pmHoursReturnedPerCenter: hundredthsInput(row.pmHoursReturnedPerCenterHundredths),
      pmHourValue: dollarsInput(row.pmHourValueMinor),
      contributionMarginPerHour: dollarsInput(row.contributionMarginPerHourMinor),
      year1PlannedCenters: row.year1PlannedCenters,
      year2PlannedCenters: row.year2PlannedCenters,
      year3PlannedCenters: row.year3PlannedCenters,
      year4PlannedCenters: row.year4PlannedCenters,
      year5PlannedCenters: row.year5PlannedCenters,
    },
    images: {
      customerLogo: fileDto(asStoredFile(row.customerLogo)),
      projectImages: projectImageSlots(row.projectImages).map(fileDto),
    },
    outputs:
      row.calculatedAt === null
        ? null
        : {
            partnerProjectValueMinor: num(row.partnerProjectValueMinor),
            savingsPerCenterMinor: num(row.savingsPerCenterMinor),
            threeYearEquipmentSavingsMinor: num(row.threeYearEquipmentSavingsMinor),
            fiveYearEquipmentSavingsMinor: num(row.fiveYearEquipmentSavingsMinor),
            pmHoursReturnedPerCenterHundredths: row.pmHoursReturnedPerCenterHundredths,
            pmCapacityValuePerCenterMinor: num(row.pmCapacityValuePerCenterMinor),
            threeYearPmCapacityValueMinor: num(row.threeYearPmCapacityValueMinor),
            fiveYearPmCapacityValueMinor: num(row.fiveYearPmCapacityValueMinor),
            threeYearCombinedValueMinor: num(row.threeYearCombinedValueMinor),
            fiveYearCombinedValueMinor: num(row.fiveYearCombinedValueMinor),
            threeYearCumulativeCenters: row.threeYearCumulativeCenters,
            fiveYearCumulativeCenters: row.fiveYearCumulativeCenters,
            calculatedAt: row.calculatedAt.toISOString(),
            calculationVersion: row.calculationVersion,
          },
    missingInputs: missing,
    generation: gen
      ? {
          runId: gen.runId,
          phase: gen.phase,
          startedAt: gen.startedAt,
          warnings: gen.warnings,
          log: gen.log.slice(-20),
        }
      : null,
    automationRunId: row.automationRunId,
    errorMessage: row.errorMessage,
    canvaDesignId: row.canvaDesignId,
    canvaDesignUrl: row.canvaDesignUrl,
    canvaViewUrl: row.canvaViewUrl,
    hasPdf: Boolean(row.pdfPathname),
    generatedAt: row.generatedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedById: row.approvedById,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type PartnershipDto = ReturnType<typeof toDto>;

/* ====================================================================== reads */

const withOrg = { organization: { select: { id: true, name: true } } } as const;

export async function loadPartnership(id: string): Promise<RowWithOrg> {
  const row = await prisma.strategicPartnershipProposal.findUnique({
    where: { id },
    include: withOrg,
  });
  if (!row) throw new NotFoundError('Strategic partnership proposal not found');
  return row;
}

export async function listPartnerships(filter: {
  organizationId?: string;
  status?: StrategicPartnershipStatus;
  q?: string;
}): Promise<PartnershipDto[]> {
  const where: Prisma.StrategicPartnershipProposalWhereInput = {};
  if (filter.organizationId) where.organizationId = filter.organizationId;
  if (filter.status) where.status = filter.status;
  if (filter.q) {
    where.OR = [
      { number: { contains: filter.q, mode: 'insensitive' } },
      { customerShortName: { contains: filter.q, mode: 'insensitive' } },
      { customerFullName: { contains: filter.q, mode: 'insensitive' } },
    ];
  }
  const rows = await prisma.strategicPartnershipProposal.findMany({
    where,
    include: withOrg,
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  return rows.map(toDto);
}

/* ===================================================================== writes */

export interface InputPatch {
  customerShortName?: string;
  customerFullName?: string;
  executiveName?: string;
  executiveTitle?: string;
  industry?: string;
  partnerDiscountBps?: number | null;
  standardProjectValueMinor?: bigint | null;
  pmHoursReturnedPerCenterHundredths?: number | null;
  pmHourValueMinor?: bigint | null;
  contributionMarginPerHourMinor?: bigint | null;
  year1PlannedCenters?: number | null;
  year2PlannedCenters?: number | null;
  year3PlannedCenters?: number | null;
  year4PlannedCenters?: number | null;
  year5PlannedCenters?: number | null;
  opportunityId?: string | null;
}

async function nextNumber<T>(create: (number: string) => Promise<T>): Promise<T> {
  const prefix = `SPP-${new Date().getUTCFullYear()}-`;
  const { row } = await allocateNumbered({
    prefix,
    field: 'number',
    format: (seq) => formatNumber(prefix, seq, 4),
    highest: async () =>
      (
        await prisma.strategicPartnershipProposal.findFirst({
          where: { number: { startsWith: prefix } },
          orderBy: { number: 'desc' },
          select: { number: true },
        })
      )?.number ?? null,
    create,
  });
  return row;
}

export async function createPartnership(
  organizationId: string,
  patch: InputPatch,
  actorId: string,
): Promise<PartnershipDto> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!org) throw new NotFoundError('Customer not found');
  const settings = await getPartnershipSettings();

  const merged: InputRow = {
    customerShortName: patch.customerShortName ?? org.name,
    customerFullName: patch.customerFullName ?? org.name,
    executiveName: patch.executiveName ?? '',
    executiveTitle: patch.executiveTitle ?? '',
    industry: patch.industry ?? '',
    partnerDiscountBps: patch.partnerDiscountBps ?? null,
    standardProjectValueMinor: patch.standardProjectValueMinor ?? null,
    pmHoursReturnedPerCenterHundredths: patch.pmHoursReturnedPerCenterHundredths ?? null,
    pmHourValueMinor: patch.pmHourValueMinor ?? null,
    year1PlannedCenters: patch.year1PlannedCenters ?? null,
    year2PlannedCenters: patch.year2PlannedCenters ?? null,
    year3PlannedCenters: patch.year3PlannedCenters ?? null,
    year4PlannedCenters: patch.year4PlannedCenters ?? null,
    year5PlannedCenters: patch.year5PlannedCenters ?? null,
  };
  const now = new Date();
  const outputs = calculateOrThrow(calculationInputs(merged), settings.content.scaleCenters);

  const row = await nextNumber((number) =>
    prisma.strategicPartnershipProposal.create({
      data: {
        number,
        organizationId,
        opportunityId: patch.opportunityId ?? null,
        ...merged,
        contributionMarginPerHourMinor: patch.contributionMarginPerHourMinor ?? null,
        status: derivedDraftStatus(merged),
        createdById: actorId,
        ...outputColumns(outputs, now),
      },
      include: withOrg,
    }),
  );
  await recordAudit({
    actorId,
    action: 'strategicPartnership.create',
    entity: 'StrategicPartnershipProposal',
    entityId: row.id,
    details: { number: row.number, organizationId },
  });
  return toDto(row);
}

export async function updatePartnership(
  id: string,
  patch: InputPatch,
  actorId: string,
): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  if (!EDITABLE.includes(row.status)) {
    throw new ConflictError(
      row.status === 'APPROVED' || row.status === 'SENT'
        ? 'This proposal has been approved. Reopen it before changing its terms.'
        : 'A proposal is being generated from these terms. Wait for it to finish.',
    );
  }
  const merged: InputRow = { ...row };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'opportunityId' && k !== 'contributionMarginPerHourMinor') {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  const settings = await getPartnershipSettings();
  const outputs = calculateOrThrow(calculationInputs(merged), settings.content.scaleCenters);
  const data: Prisma.StrategicPartnershipProposalUncheckedUpdateInput = {
    customerShortName: merged.customerShortName,
    customerFullName: merged.customerFullName,
    executiveName: merged.executiveName,
    executiveTitle: merged.executiveTitle,
    industry: merged.industry,
    partnerDiscountBps: merged.partnerDiscountBps,
    standardProjectValueMinor: merged.standardProjectValueMinor,
    pmHoursReturnedPerCenterHundredths: merged.pmHoursReturnedPerCenterHundredths,
    pmHourValueMinor: merged.pmHourValueMinor,
    year1PlannedCenters: merged.year1PlannedCenters,
    year2PlannedCenters: merged.year2PlannedCenters,
    year3PlannedCenters: merged.year3PlannedCenters,
    year4PlannedCenters: merged.year4PlannedCenters,
    year5PlannedCenters: merged.year5PlannedCenters,
    ...outputColumns(outputs, new Date()),
    // Changed terms mean the generated document no longer matches: back to the
    // derived state, so the Generate button is what the screen offers next. The old
    // Canva/PDF links stay on the record until a new run replaces them.
    status: derivedDraftStatus(merged),
  };
  if (patch.opportunityId !== undefined) data.opportunityId = patch.opportunityId;
  if (patch.contributionMarginPerHourMinor !== undefined) {
    data.contributionMarginPerHourMinor = patch.contributionMarginPerHourMinor;
  }
  const saved = await prisma.strategicPartnershipProposal.update({
    where: { id },
    data,
    include: withOrg,
  });
  await recordAudit({
    actorId,
    action: 'strategicPartnership.update',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: { fields: Object.keys(patch) },
  });
  return toDto(saved);
}

/** Replace (or clear) one image slot. `slot` is 'logo' or 1..5. */
export async function setImage(
  id: string,
  slot: 'logo' | number,
  file: StoredFile | null,
  actorId: string,
): Promise<{ dto: PartnershipDto; replaced: StoredFile | null }> {
  const row = await loadPartnership(id);
  if (!EDITABLE.includes(row.status)) {
    throw new ConflictError('Images cannot change while the proposal is approved or generating.');
  }
  let replaced: StoredFile | null;
  const data: Prisma.StrategicPartnershipProposalUncheckedUpdateInput = {
    status: derivedDraftStatus(row),
  };
  if (slot === 'logo') {
    replaced = asStoredFile(row.customerLogo);
    data.customerLogo = file ? (file as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
  } else {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_PROJECT_IMAGES) {
      throw new ValidationError('Project images are numbered 1 to 5.');
    }
    const slots = projectImageSlots(row.projectImages);
    replaced = slots[slot - 1] ?? null;
    slots[slot - 1] = file;
    data.projectImages = slots as unknown as Prisma.InputJsonValue;
  }
  const saved = await prisma.strategicPartnershipProposal.update({
    where: { id },
    data,
    include: withOrg,
  });
  await recordAudit({
    actorId,
    action: file ? 'strategicPartnership.image.set' : 'strategicPartnership.image.clear',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: { slot, filename: file?.filename ?? null },
  });
  return { dto: toDto(saved), replaced };
}

/* ================================================================ transitions */

export async function approvePartnership(id: string, actorId: string): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  if (row.status !== 'READY_FOR_REVIEW') {
    throw new ConflictError('Only a generated proposal that is ready for review can be approved.');
  }
  const saved = await prisma.strategicPartnershipProposal.update({
    where: { id },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedById: actorId },
    include: withOrg,
  });
  await recordAudit({
    actorId,
    action: 'strategicPartnership.approve',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: { runId: row.automationRunId },
  });
  return toDto(saved);
}

export async function markPartnershipSent(id: string, actorId: string): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  if (row.status !== 'APPROVED') {
    throw new ConflictError('A proposal is approved before it is marked as sent.');
  }
  const saved = await prisma.strategicPartnershipProposal.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
    include: withOrg,
  });
  await recordAudit({
    actorId,
    action: 'strategicPartnership.sent',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: {},
  });
  return toDto(saved);
}

/** Back to editable, from approved, sent, or a failed run. */
export async function reopenPartnership(id: string, actorId: string): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  if (IN_FLIGHT.includes(row.status)) {
    throw new ConflictError('A generation run is in progress. Wait for it to finish.');
  }
  const saved = await prisma.strategicPartnershipProposal.update({
    where: { id },
    data: {
      status: derivedDraftStatus(row),
      approvedAt: null,
      approvedById: null,
      sentAt: null,
    },
    include: withOrg,
  });
  await recordAudit({
    actorId,
    action: 'strategicPartnership.reopen',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: { from: row.status },
  });
  return toDto(saved);
}

/* ================================================================ generation */

export interface GenerationDeps {
  /** A ready Canva client. Throws when Canva is not configured or not connected. */
  canva: () => Promise<CanvaApi>;
  /** Whether Canva can be called at all — checked before a run starts. */
  canvaReady: () => Promise<boolean>;
  getFile: (url: string) => Promise<Buffer>;
  putFile: (
    pathname: string,
    bytes: Buffer,
    contentType: string,
  ) => Promise<{ url: string; pathname: string }>;
  fileStoreConfigured: () => boolean;
  now: () => Date;
  newRunId: () => string;
}

/** Problems that stop a run before it starts, in words a rep can act on. */
export async function generationBlockers(
  row: StrategicPartnershipProposal,
  deps: Pick<GenerationDeps, 'canvaReady' | 'fileStoreConfigured'>,
): Promise<string[]> {
  const out: string[] = [];
  const missing = missingInputs(row);
  if (missing.length) out.push(`Missing: ${missing.join(', ')}.`);
  if (!asStoredFile(row.customerLogo)) out.push('Upload the customer logo.');
  const settings = await getPartnershipSettings();
  if (!settings.brandTemplateId) {
    out.push(
      'No Canva brand template is set. An administrator sets it in Strategic Partnership settings.',
    );
  }
  if (!(await deps.canvaReady())) {
    out.push(
      'Canva is not connected. An administrator connects it from Strategic Partnership settings.',
    );
  }
  if (!deps.fileStoreConfigured()) {
    out.push(
      'File storage is not configured on this deployment, so the PDF could not be archived.',
    );
  }
  return out;
}

function stamp(state: GenerationState, deps: GenerationDeps, message: string): void {
  state.log.push({ at: deps.now().toISOString(), message });
  if (state.log.length > 50) state.log.splice(0, state.log.length - 50);
}

/** The text a rep is shown for a stored-proposal render context. */
export function copyContext(
  row: StrategicPartnershipProposal,
  outputs: PartnershipOutputs,
): CopyContext {
  return {
    customerShortName: row.customerShortName,
    customerFullName: row.customerFullName,
    executiveName: row.executiveName,
    executiveTitle: row.executiveTitle,
    industry: row.industry,
    partnerDiscountBps: row.partnerDiscountBps ?? 0,
    pmHourValueMinor: row.pmHourValueMinor ?? 0n,
    outputs,
  };
}

/** The Canva chart dataset: a header row, then one row per scale scenario, whole dollars. */
export function chartData(outputs: PartnershipOutputs): ChartData {
  const dollars = (m: bigint) => Number(divRound(m, 100n, 'HALF_UP'));
  return {
    rows: [
      {
        cells: [
          { type: 'string', value: 'Centers' },
          { type: 'string', value: 'Equipment Savings' },
          { type: 'string', value: 'PM Capacity Value' },
          { type: 'string', value: 'Combined Value' },
        ],
      },
      ...outputs.scaleScenario.map((r) => ({
        cells: [
          { type: 'string' as const, value: `${r.centers} Centers` },
          { type: 'number' as const, value: dollars(r.equipmentSavingsMinor) },
          { type: 'number' as const, value: dollars(r.pmCapacityValueMinor) },
          { type: 'number' as const, value: dollars(r.combinedValueMinor) },
        ],
      })),
    ],
  };
}

/**
 * Match what the CRM has to what the brand template asks for.
 *
 * A text field on the template with no copy is an ERROR: Autofill would leave the
 * template's sample wording (another customer's name, a stale figure) in a document
 * going to this one. An image field with no upload keeps the template's own image —
 * the master ships with Summit project photography — and is reported as a warning.
 */
export function buildAutofillData(input: {
  dataset: BrandTemplateDataset;
  textFields: Record<string, string>;
  assetIds: Record<string, string>;
  chart: ChartData;
  chartField: string | null | undefined;
}): { data: Record<string, AutofillValue>; warnings: string[] } {
  const data: Record<string, AutofillValue> = {};
  const warnings: string[] = [];
  const missingText: string[] = [];
  const chartFields = Object.entries(input.dataset)
    .filter(([, f]) => f.type === 'chart')
    .map(([name]) => name);
  const chosenChart =
    input.chartField ?? (chartFields.length === 1 ? (chartFields[0] ?? null) : null);

  for (const [name, field] of Object.entries(input.dataset)) {
    if (field.type === 'text') {
      const text = input.textFields[name];
      if (text === undefined) missingText.push(name);
      else data[name] = { type: 'text', text };
    } else if (field.type === 'image') {
      const assetId = input.assetIds[name];
      if (assetId) data[name] = { type: 'image', asset_id: assetId };
      else warnings.push(`Image field ${name} keeps the template's own image.`);
    } else if (field.type === 'chart') {
      if (name === chosenChart) data[name] = { type: 'chart', chart_data: input.chart };
      else warnings.push(`Chart field ${name} was not filled (set the chart field in settings).`);
    }
  }
  if (missingText.length) {
    throw new ValidationError(
      `The Canva template has text field${missingText.length > 1 ? 's' : ''} the CRM has no copy for: ${missingText.join(', ')}. Add ${missingText.length > 1 ? 'them' : 'it'} in Strategic Partnership settings.`,
    );
  }
  for (const name of Object.keys(input.textFields)) {
    if (!input.dataset[name]) warnings.push(`Copy field ${name} is not on the Canva template.`);
  }
  for (const name of Object.keys(input.assetIds)) {
    if (!input.dataset[name])
      warnings.push(`Image ${name} was uploaded but the template has no such field.`);
  }
  if (input.chartField && !input.dataset[input.chartField]) {
    warnings.push(`Chart field ${input.chartField} is not on the Canva template.`);
  }
  return { data, warnings };
}

/**
 * Refuse a PDF that is not US Letter portrait on every page — 612 x 792 pt, 8.5 x 11
 * in. The page size is set by the Canva master, not by the export call, so this is
 * the one place the CRM can hold the standard: a master resized by accident fails
 * the run here rather than reaching a customer as A4.
 */
export async function assertUsLetterPortrait(bytes: Buffer): Promise<number> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new ValidationError('Canva returned a file that is not a readable PDF.');
  }
  const pages = doc.getPages();
  if (!pages.length) throw new ValidationError('Canva returned a PDF with no pages.');
  pages.forEach((page, i) => {
    let { width, height } = page.getSize();
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (angle === 90 || angle === 270) [width, height] = [height, width];
    if (
      Math.abs(width - LETTER_WIDTH_PT) > PAGE_TOLERANCE_PT ||
      Math.abs(height - LETTER_HEIGHT_PT) > PAGE_TOLERANCE_PT
    ) {
      throw new ValidationError(
        `Page ${i + 1} of the exported PDF is ${Math.round(width)} x ${Math.round(height)} pt. The Strategic Partnership master must be US Letter portrait (612 x 792 pt, 8.5 x 11 in) — fix the page size of the Canva brand template.`,
      );
    }
  });
  return pages.length;
}

async function saveState(
  id: string,
  state: GenerationState,
  extra: Prisma.StrategicPartnershipProposalUncheckedUpdateInput = {},
): Promise<RowWithOrg> {
  return prisma.strategicPartnershipProposal.update({
    where: { id },
    data: { generation: state as unknown as Prisma.InputJsonValue, ...extra },
    include: withOrg,
  });
}

async function failRun(
  id: string,
  state: GenerationState,
  deps: GenerationDeps,
  message: string,
): Promise<RowWithOrg> {
  state.phase = 'FAILED';
  state.leaseUntil = null;
  stamp(state, deps, `Failed: ${message}`);
  logger.warn({ id, runId: state.runId, message }, 'strategic partnership: generation failed');
  return saveState(id, state, { status: 'ERROR', errorMessage: message.slice(0, 2000) });
}

/**
 * Start a generation run. Idempotent: while a run is in flight, a second call
 * returns that run (after nudging it along) rather than starting another.
 */
export async function generatePartnership(
  id: string,
  actorId: string,
  deps: GenerationDeps,
): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  const current = asGeneration(row.generation);
  const now = deps.now();

  if (IN_FLIGHT.includes(row.status) && current && !timedOut(current, now)) {
    return advancePartnership(id, deps);
  }
  if (row.status === 'APPROVED' || row.status === 'SENT') {
    throw new ConflictError(
      'This proposal has been approved. Reopen it before generating a new document.',
    );
  }
  const blockers = await generationBlockers(row, deps);
  if (blockers.length) throw new ValidationError(blockers.join(' '));

  const settings = await getPartnershipSettings();
  const runId = deps.newRunId();

  // Claim the record: only one caller can move it out of an idle status.
  const claimed = await prisma.strategicPartnershipProposal.updateMany({
    where: { id, updatedAt: row.updatedAt },
    data: { status: 'CALCULATING', automationRunId: runId, errorMessage: null },
  });
  if (claimed.count !== 1) return toDto(await loadPartnership(id));

  // Calculate fresh — the run documents today's formula, not whatever was stored.
  let outputs: PartnershipOutputs;
  let textFields: Record<string, string>;
  let title: string;
  try {
    const calc = calculateOrThrow(calculationInputs(row), settings.content.scaleCenters);
    if (!calc) throw new ValidationError('The proposal is missing required inputs.');
    outputs = calc;
    const ctx = copyContext(row, outputs);
    textFields = renderTextFields(settings.content, ctx);
    title = renderTemplate(settings.content.titleTemplate, ctx).slice(0, 255);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.strategicPartnershipProposal.update({
      where: { id },
      data: { status: 'ERROR', errorMessage: message },
    });
    throw err instanceof ValidationError ? err : new ValidationError(message);
  }

  const assets: GenerationState['assets'] = {};
  const logo = asStoredFile(row.customerLogo);
  if (logo) assets.CUSTOMER_LOGO = { pathname: logo.pathname };
  projectImageSlots(row.projectImages).forEach((f, i) => {
    if (f) assets[IMAGE_FIELDS[i + 1]!] = { pathname: f.pathname };
  });

  const state: GenerationState = {
    runId,
    phase: 'ASSETS',
    startedAt: now.toISOString(),
    startedById: actorId,
    leaseUntil: null,
    assets,
    warnings: [],
    log: [],
  };
  stamp(state, deps, 'Economics calculated.');

  await saveState(id, state, {
    ...outputColumns(outputs, now),
    status: 'GENERATING_CANVA',
    generatedSnapshot: {
      runId,
      calculationVersion: CALCULATION_VERSION,
      settingsVersion: settings.version,
      brandTemplateId: settings.brandTemplateId,
      title,
      inputs: toDto(row).inputs,
      outputs: serializeOutputs(outputs),
      textFields,
      chartData: chartData(outputs),
    } as unknown as Prisma.InputJsonValue,
  });
  await recordAudit({
    actorId,
    action: 'strategicPartnership.generate',
    entity: 'StrategicPartnershipProposal',
    entityId: id,
    details: { runId, brandTemplateId: settings.brandTemplateId },
  });
  return advancePartnership(id, deps);
}

function timedOut(state: GenerationState, now: Date): boolean {
  const started = Date.parse(state.startedAt);
  return Number.isFinite(started) && now.getTime() - started > RUN_TIMEOUT_MS;
}

/** BigInts to strings, for the JSON snapshot. */
export function serializeOutputs(o: PartnershipOutputs): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
}

type StepResult = 'continue' | 'wait';

/**
 * Take the next steps of an in-flight run, within one request's budget. Safe to call
 * at any time and from any number of pollers: a record that is not generating is
 * returned as it is, and a run another caller holds the lease on is left alone.
 */
export async function advancePartnership(
  id: string,
  deps: GenerationDeps,
): Promise<PartnershipDto> {
  const row = await loadPartnership(id);
  if (row.status !== 'GENERATING_CANVA') return toDto(row);
  const state = asGeneration(row.generation);
  if (!state) {
    const failed = await prisma.strategicPartnershipProposal.update({
      where: { id },
      data: {
        status: 'ERROR',
        errorMessage: 'The generation run lost its progress record. Generate again.',
      },
      include: withOrg,
    });
    return toDto(failed);
  }
  const now = deps.now();
  if (timedOut(state, now)) {
    return toDto(
      await failRun(id, state, deps, 'Canva did not finish within 20 minutes. Generate again.'),
    );
  }
  if (state.leaseUntil && Date.parse(state.leaseUntil) > now.getTime()) return toDto(row);

  // Take the lease with a compare-and-swap on updatedAt.
  state.leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const took = await prisma.strategicPartnershipProposal.updateMany({
    where: { id, updatedAt: row.updatedAt },
    data: { generation: state as unknown as Prisma.InputJsonValue },
  });
  if (took.count !== 1) return toDto(await loadPartnership(id));

  const deadline = now.getTime() + STEP_BUDGET_MS;
  const extra: Prisma.StrategicPartnershipProposalUncheckedUpdateInput = {};
  try {
    const canva = await deps.canva();
    for (let i = 0; i < 8; i++) {
      const result = await step(row, state, canva, deps, extra);
      if (result === 'wait' || state.phase === 'DONE') break;
      if (deps.now().getTime() > deadline) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toDto(await failRun(id, state, deps, message));
  }
  state.leaseUntil = null;
  return toDto(await saveState(id, state, extra));
}

async function step(
  row: StrategicPartnershipProposal,
  state: GenerationState,
  canva: CanvaApi,
  deps: GenerationDeps,
  extra: Prisma.StrategicPartnershipProposalUncheckedUpdateInput,
): Promise<StepResult> {
  switch (state.phase) {
    case 'ASSETS': {
      const files = new Map<string, StoredFile>();
      const logo = asStoredFile(row.customerLogo);
      if (logo) files.set('CUSTOMER_LOGO', logo);
      projectImageSlots(row.projectImages).forEach((f, i) => {
        if (f) files.set(IMAGE_FIELDS[i + 1]!, f);
      });
      let pending = 0;
      for (const [field, slot] of Object.entries(state.assets)) {
        if (slot.assetId) continue;
        const file = files.get(field);
        if (!file || file.pathname !== slot.pathname) {
          throw new ValidationError(
            `${field} changed while the proposal was generating. Generate again.`,
          );
        }
        if (!slot.jobId) {
          const bytes = await deps.getFile(file.url);
          const job = await canva.startAssetUpload(`${row.number} ${field}`, bytes);
          slot.jobId = job.id;
          if (job.status === 'success' && job.asset?.id) slot.assetId = job.asset.id;
          else pending++;
          continue;
        }
        const job = await canva.getAssetUpload(slot.jobId);
        if (job.status === 'failed') {
          throw new ValidationError(
            `Canva could not import ${field}: ${job.error?.message ?? job.error?.code ?? 'unknown error'}.`,
          );
        }
        if (job.status === 'success' && job.asset?.id) slot.assetId = job.asset.id;
        else pending++;
      }
      if (pending) return 'wait';
      stamp(state, deps, 'Images uploaded to Canva.');
      state.phase = 'AUTOFILL_START';
      return 'continue';
    }
    case 'AUTOFILL_START': {
      const snap = row.generatedSnapshot as {
        textFields?: Record<string, string>;
        title?: string;
      } | null;
      const settings = await getPartnershipSettings();
      if (!settings.brandTemplateId) throw new ValidationError('No Canva brand template is set.');
      const outputs = calculateOrThrow(calculationInputs(row), settings.content.scaleCenters);
      if (!outputs) throw new ValidationError('The proposal is missing required inputs.');
      const dataset = await canva.getBrandTemplateDataset(settings.brandTemplateId);
      const assetIds: Record<string, string> = {};
      for (const [field, slot] of Object.entries(state.assets))
        if (slot.assetId) assetIds[field] = slot.assetId;
      const { data, warnings } = buildAutofillData({
        dataset,
        textFields:
          snap?.textFields ?? renderTextFields(settings.content, copyContext(row, outputs)),
        assetIds,
        chart: chartData(outputs),
        chartField: settings.content.chartField,
      });
      state.warnings = warnings;
      const job = await canva.startAutofill({
        brandTemplateId: settings.brandTemplateId,
        title: snap?.title ?? row.number,
        data,
      });
      state.autofillJobId = job.id;
      state.phase = 'AUTOFILL';
      stamp(state, deps, 'Canva autofill started.');
      return 'wait';
    }
    case 'AUTOFILL': {
      if (!state.autofillJobId) throw new ValidationError('The Canva autofill job was lost.');
      const job = await canva.getAutofill(state.autofillJobId);
      if (job.status === 'in_progress') return 'wait';
      if (job.status === 'failed' || !job.result?.design?.id) {
        throw new ValidationError(
          `Canva autofill failed: ${job.error?.message ?? job.error?.code ?? 'no design was created'}.`,
        );
      }
      const design = job.result.design;
      extra.canvaDesignId = design.id;
      extra.canvaDesignUrl = design.urls?.edit_url ?? design.url ?? null;
      extra.canvaViewUrl = design.urls?.view_url ?? null;
      stamp(state, deps, 'Canva design created.');
      state.phase = 'EXPORT_START';
      state.designId = design.id;
      return 'continue';
    }
    case 'EXPORT_START': {
      const designId = state.designId ?? row.canvaDesignId ?? null;
      if (!designId) throw new ValidationError('The Canva design id was lost before export.');
      const job = await canva.startPdfExport(designId);
      state.exportJobId = job.id;
      state.phase = 'EXPORT';
      stamp(state, deps, 'PDF export started.');
      return 'wait';
    }
    case 'EXPORT': {
      if (!state.exportJobId) throw new ValidationError('The Canva export job was lost.');
      const job = await canva.getExport(state.exportJobId);
      if (job.status === 'in_progress') return 'wait';
      const url = job.urls?.[0];
      if (job.status === 'failed' || !url) {
        throw new ValidationError(
          `Canva PDF export failed: ${job.error?.message ?? job.error?.code ?? 'no file was produced'}.`,
        );
      }
      const pdf = await canva.download(url);
      const pages = await assertUsLetterPortrait(pdf);
      const stored = await deps.putFile(
        `strategic-partnerships/${row.number}/${state.runId}.pdf`,
        pdf,
        'application/pdf',
      );
      const at = deps.now();
      extra.pdfUrl = stored.url;
      extra.pdfPathname = stored.pathname;
      extra.generatedAt = at;
      extra.status = 'READY_FOR_REVIEW';
      extra.errorMessage = null;
      stamp(
        state,
        deps,
        `PDF archived (${pages} page${pages === 1 ? '' : 's'}, US Letter portrait).`,
      );
      state.phase = 'DONE';
      return 'wait';
    }
    case 'DONE':
    case 'FAILED':
      return 'wait';
  }
}

/** For the review screen: what the Canva copy says for this record, right now. */
export async function previewCopy(
  id: string,
): Promise<{ textFields: Record<string, string>; title: string }> {
  const row = await loadPartnership(id);
  const settings = await getPartnershipSettings();
  const outputs = calculateOrThrow(calculationInputs(row), settings.content.scaleCenters);
  if (!outputs) throw new ValidationError(`Missing: ${missingInputs(row).join(', ')}.`);
  const ctx = copyContext(row, outputs);
  return {
    textFields: renderTextFields(settings.content, ctx),
    title: renderTemplate(settings.content.titleTemplate, ctx),
  };
}

/** A fresh run id — the idempotency key for one generation run. */
export function newRunId(): string {
  return randomUUID();
}

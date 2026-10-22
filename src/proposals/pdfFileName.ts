import { prisma } from '../lib/prisma.js';

/**
 * The proposal PDF's file name when the browser did not send one — the server's copy
 * of public/app.js proposalFileName(), so a proposal PDF is named the same way on
 * every path, for every user: Customer-Frame Code-Proposal#[-RevN]-MMDDYYYY.
 *
 * The browser's name always wins where it is sent (Save PDF, Print, release, email,
 * e-sign all send it); this only replaces the bare proposal number those paths fell
 * back to. Keep the two in step — tests/unit/proposal-pdf-file-name.test.ts pins the
 * shape.
 */

interface NameLine {
  lineType?: string;
  name?: string;
  description?: string;
}

const ITEMIZED = /\s*[-–—]\s*itemized.*$/i;
const HAS_DIMS = /(^|-)\d+(\.\d+)?x\d+(\.\d+)?(-|$)/i;
const SIZE_IN_NOTE = /(\d+)\s*'?\s*[×x]\s*(\d+)/i;

/** Title case the way the browser's tc() does: a letter after a space, hyphen or slash. */
const tc = (s: string): string =>
  s.replace(
    /(^|[\s\-/])([^\sA-Za-z0-9]*)([a-z])/g,
    (_m, pre: string, punct: string, c: string) => pre + punct + c.toUpperCase(),
  );

export function proposalPdfFileName(input: {
  orgName?: string | null;
  number?: string | null;
  version?: number | null;
  lines: unknown;
  now?: Date;
}): string {
  let model = '';
  let size = '';
  let firstGroup = '';
  for (const l of (Array.isArray(input.lines) ? input.lines : []) as NameLine[]) {
    if (!l || (l.lineType || '') !== 'GROUP') continue;
    if (!firstGroup && l.name) firstGroup = String(l.name);
    if (!model && /itemized/i.test(l.name || ''))
      model = String(l.name).replace(ITEMIZED, '').trim();
    if (!size) {
      const sm = SIZE_IN_NOTE.exec(String(l.description || ''));
      if (sm) size = `${sm[1]}x${sm[2]}`;
    }
  }
  if (model) {
    if (size && !HAS_DIMS.test(model)) model = `${model}-${size}`;
    size = '';
  } else if (firstGroup) {
    model = tc(firstGroup.toLowerCase());
  }
  const now = input.now ?? new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const today = `${p2(now.getMonth() + 1)}${p2(now.getDate())}${now.getFullYear()}`;
  const v = Number(input.version) || 1;
  const rev = v > 1 ? `Rev${v - 1}` : '';
  return [input.orgName || 'Proposal', model, size, input.number || '', rev, today]
    .filter(Boolean)
    .join('-')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The same name for a saved version, read from the database. */
export async function proposalPdfFileNameForVersion(versionId: string): Promise<string> {
  const v = await prisma.proposalVersion.findUnique({
    where: { id: versionId },
    select: {
      version: true,
      items: true,
      proposal: { select: { number: true, organizationId: true } },
    },
  });
  if (!v) return 'Proposal';
  const org = await prisma.organization.findUnique({
    where: { id: v.proposal.organizationId },
    select: { name: true },
  });
  return proposalPdfFileName({
    orgName: org?.name,
    number: v.proposal?.number,
    version: v.version,
    lines: v.items,
  });
}

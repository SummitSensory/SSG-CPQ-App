import { z } from 'zod';
import { ProductInput } from './validation.js';

export interface ImportIssue {
  row: number;
  field: string;
  message: string;
}
export interface ImportResult {
  valid: boolean;
  validRows: number;
  issues: ImportIssue[];
}

/**
 * Validate a batch of product rows: required fields, field formats, and
 * in-batch duplicate SKUs. DB-level duplicate checks happen in the route.
 */
export function validateImportBatch(rows: unknown[]): ImportResult {
  const issues: ImportIssue[] = [];
  const seenSku = new Map<string, number>();
  let validRows = 0;

  rows.forEach((raw, i) => {
    const row = i + 1;
    const parsed = ProductInput.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ row, field: issue.path.join('.') || '(root)', message: issue.message });
      }
      return;
    }
    const sku = parsed.data.sku;
    if (seenSku.has(sku)) {
      issues.push({ row, field: 'sku', message: `duplicate SKU in batch (also row ${seenSku.get(sku)})` });
      return;
    }
    seenSku.set(sku, row);
    validRows += 1;
  });

  return { valid: issues.length === 0, validRows, issues };
}

export const ImportEnvelope = z.object({
  dryRun: z.boolean().default(true),
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
});

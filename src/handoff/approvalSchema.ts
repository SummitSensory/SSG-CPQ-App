import { z } from 'zod';

/**
 * The customer-approval record captured when an accepted proposal is locked into an
 * operational order. Shared by the two routes that lock: "Proposal Signed", which
 * accepts and locks in one step, and the direct lock on an already-accepted version
 * (the recovery path when the lock half of that step did not complete).
 */
export const ApprovalSchema = z.object({
  method: z.enum([
    'SIGNATURE',
    'COUNTERSIGNED_PROPOSAL',
    'PURCHASE_ORDER',
    'EMAIL',
    'VERBAL',
    'PORTAL',
  ]),
  approverName: z.string().trim().min(1),
  approverTitle: z.string().optional(),
  approverEmail: z.string().email().optional(),
  poNumber: z.string().optional(),
  documentRef: z.string().optional(),
  ipAddress: z.string().optional(),
  approvedAt: z.coerce.date(),
  notes: z.string().optional(),
  trainingIncluded: z.boolean().optional(),
  installationIncluded: z.boolean().optional(),
});

export type ApprovalInput = z.infer<typeof ApprovalSchema>;

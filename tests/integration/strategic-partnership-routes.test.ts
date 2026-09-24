import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Strategic Partnership routes: who may do what, and that the server — not the
 * browser — owns every calculated figure. Prisma is a plain in-memory stub, the
 * convention part-integrity.test.ts describes.
 */

type Row = Record<string, unknown> & { id: string; updatedAt: Date };
const ROWS = new Map<string, Row>();
let seq = 0;

vi.mock('../../src/lib/prisma.js', () => {
  const org = { id: 'org1', name: 'Treetop ABA' };
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        isActive: true,
        role: String(where.id).replace(/^user-/, ''),
      }),
    },
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'org1' ? org : null,
    },
    strategicPartnershipProposal: {
      findFirst: async () => null,
      findMany: async () => [...ROWS.values()].map((r) => ({ ...r, organization: org })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = ROWS.get(where.id);
        return r ? { ...r, organization: org } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `spp${++seq}`;
        const row: Row = {
          id,
          customerLogo: null,
          projectImages: [],
          generation: null,
          generatedSnapshot: null,
          automationRunId: null,
          errorMessage: null,
          canvaDesignId: null,
          canvaDesignUrl: null,
          canvaViewUrl: null,
          pdfUrl: null,
          pdfPathname: null,
          generatedAt: null,
          approvedAt: null,
          approvedById: null,
          sentAt: null,
          createdAt: new Date(),
          ...data,
          updatedAt: new Date(),
        };
        ROWS.set(id, row);
        return { ...row, organization: org };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = ROWS.get(where.id)!;
        Object.assign(r, data, { updatedAt: new Date() });
        return { ...r, organization: org };
      },
    },
    strategicPartnershipSettings: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    canvaConnection: { findUnique: async () => null },
    auditLog: { create: async () => ({}) },
  };
  return { prisma };
});

async function tokenFor(role: string): Promise<string> {
  const { signAccessToken } = await import('../../src/auth/tokens.js');
  return signAccessToken({ sub: 'user-' + role, role });
}

let app: FastifyInstance;

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerErrorHandler } = await import('../../src/plugins/error-handler.js');
  const { registerStrategicPartnershipRoutes } =
    await import('../../src/routes/strategicPartnership.js');
  app = Fastify();
  registerErrorHandler(app);
  registerStrategicPartnershipRoutes(app);
  await app.ready();
});

beforeEach(() => {
  ROWS.clear();
});

const TERMS = {
  organizationId: 'org1',
  customerShortName: 'Treetop',
  customerFullName: 'The Treetop ABA Therapy Center',
  executiveName: 'Ari Treuhaft',
  executiveTitle: 'CEO',
  industry: 'ABA Therapy',
  partnerDiscountPercent: '17.5',
  standardProjectValue: '16,514',
  pmHoursReturnedPerCenter: '41',
  pmHourValue: '75',
  year1PlannedCenters: 10,
  year2PlannedCenters: 10,
  year3PlannedCenters: 10,
};

async function call(
  role: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await tokenFor(role)}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe('strategic partnership routes', () => {
  it('a rep creates one; the server calculates and stores 3-Year Equipment Savings', async () => {
    const res = await call('SALES_REP', 'POST', '/strategic-partnerships', TERMS);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      status: string;
      number: string;
      outputs: { threeYearEquipmentSavingsMinor: number; savingsPerCenterMinor: number };
      can: { write: boolean; review: boolean };
    };
    expect(body.number).toMatch(/^SPP-\d{4}-0001$/);
    expect(body.status).toBe('READY_TO_GENERATE');
    expect(body.outputs.threeYearEquipmentSavingsMinor).toBe(8_669_850);
    expect(body.outputs.savingsPerCenterMinor).toBe(288_995);
    expect(body.can).toMatchObject({ write: true, review: false });
    expect([...ROWS.values()][0]!.threeYearEquipmentSavingsMinor).toBe(8_669_850n);
  });

  it('ignores any calculated figure a client tries to send', async () => {
    const res = await call('SALES_REP', 'POST', '/strategic-partnerships', {
      ...TERMS,
      threeYearEquipmentSavingsMinor: 1,
      savingsPerCenterMinor: 1,
    });
    expect(res.statusCode).toBe(201);
    expect(
      (res.json() as { outputs: { threeYearEquipmentSavingsMinor: number } }).outputs
        .threeYearEquipmentSavingsMinor,
    ).toBe(8_669_850);
  });

  it('a partial record is a DRAFT with no outputs, and says what is missing', async () => {
    const res = await call('SALES_REP', 'POST', '/strategic-partnerships', {
      organizationId: 'org1',
      standardProjectValue: '16514',
    });
    const body = res.json() as { status: string; outputs: unknown; missingInputs: string[] };
    expect(body.status).toBe('DRAFT');
    expect(body.outputs).toBeNull();
    expect(body.missingInputs).toContain('Partner discount');
    // Short/full name default to the customer record.
    expect(body.missingInputs).not.toContain('Customer short name');
  });

  it('a malformed amount is a 400, never a zero', async () => {
    const res = await call('SALES_REP', 'POST', '/strategic-partnerships', {
      ...TERMS,
      standardProjectValue: '16,514.555',
    });
    expect(res.statusCode).toBe(400);
  });

  it('read-only users can read but not create', async () => {
    expect((await call('READ_ONLY', 'POST', '/strategic-partnerships', TERMS)).statusCode).toBe(
      403,
    );
    expect((await call('READ_ONLY', 'GET', '/strategic-partnerships')).statusCode).toBe(200);
  });

  it('a rep cannot approve; a sales manager can only approve a generated proposal', async () => {
    const created = (await call('SALES_REP', 'POST', '/strategic-partnerships', TERMS)).json() as {
      id: string;
    };
    expect(
      (await call('SALES_REP', 'POST', `/strategic-partnerships/${created.id}/approve`)).statusCode,
    ).toBe(403);
    expect(
      (await call('SALES_MANAGER', 'POST', `/strategic-partnerships/${created.id}/approve`))
        .statusCode,
    ).toBe(409);
    ROWS.get(created.id)!.status = 'READY_FOR_REVIEW';
    const ok = await call('SALES_MANAGER', 'POST', `/strategic-partnerships/${created.id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('APPROVED');
    // Approved terms are locked until reopened.
    const edit = await call('SALES_REP', 'PATCH', `/strategic-partnerships/${created.id}`, {
      pmHourValue: '80',
    });
    expect(edit.statusCode).toBe(409);
  });

  it('editing terms recalculates and sends a reviewed proposal back to Ready To Generate', async () => {
    const created = (await call('SALES_REP', 'POST', '/strategic-partnerships', TERMS)).json() as {
      id: string;
    };
    ROWS.get(created.id)!.status = 'READY_FOR_REVIEW';
    const res = await call('SALES_REP', 'PATCH', `/strategic-partnerships/${created.id}`, {
      partnerDiscountPercent: '20',
    });
    const body = res.json() as {
      status: string;
      outputs: { threeYearEquipmentSavingsMinor: number };
    };
    expect(body.status).toBe('READY_TO_GENERATE');
    expect(body.outputs.threeYearEquipmentSavingsMinor).toBe(9_908_400); // 30 x 16514 x 20%
  });

  it('the calculate preview uses the same engine', async () => {
    const res = await call('READ_ONLY', 'POST', '/strategic-partnerships/calculate', TERMS);
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { outputs: { fiveYearEquipmentSavingsMinor: number } }).outputs
        .fiveYearEquipmentSavingsMinor,
    ).toBe(14_449_750);
  });

  it('generation is refused, in words, while Canva and the template are not set up', async () => {
    const created = (await call('SALES_REP', 'POST', '/strategic-partnerships', TERMS)).json() as {
      id: string;
    };
    const res = await call('SALES_REP', 'POST', `/strategic-partnerships/${created.id}/generate`);
    expect(res.statusCode).toBe(400);
    const msg = (res.json() as { message: string }).message;
    expect(msg).toMatch(/customer logo/);
    expect(msg).toMatch(/brand template/);
    expect(msg).toMatch(/Canva is not connected/);
    const detail = (
      await call('SALES_REP', 'GET', `/strategic-partnerships/${created.id}`)
    ).json() as {
      generationBlockers: string[];
    };
    expect(detail.generationBlockers.length).toBeGreaterThan(0);
  });

  it('settings: anyone who reads proposals can see them; only an admin can change them', async () => {
    const got = await call('SALES_REP', 'GET', '/strategic-partnerships/settings');
    expect(got.statusCode).toBe(200);
    const body = got.json() as { content: unknown; isDefault: boolean };
    expect(body.isDefault).toBe(true);
    expect(
      (
        await call('SALES_MANAGER', 'PUT', '/strategic-partnerships/settings', {
          content: body.content,
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('SALES_MANAGER', 'GET', '/integrations/canva')).statusCode).toBe(403);
    expect((await call('SYSTEM_ADMIN', 'GET', '/integrations/canva')).statusCode).toBe(200);
  });
});

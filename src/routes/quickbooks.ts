import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../plugins/authz.js';
import { Permission } from '../authz/permissions.js';
import { env, isQuickbooksConfigured, qboEnvironment } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { authorizeUrl, exchangeCode, disconnect } from '../integrations/quickbooks/oauth.js';
import { findOrCreateCustomer } from '../integrations/quickbooks/customers.js';
import { syncItem, linkItemsBySku } from '../integrations/quickbooks/items.js';
import { query, readById } from '../integrations/quickbooks/client.js';
import {
  listTerms,
  resolveTermForProposal,
  setProposalTerm,
  setOrganizationTerm,
} from '../integrations/quickbooks/terms.js';
import {
  prepareTransaction,
  authorizeTransaction,
  executeTransaction,
  retryTransaction,
  discardTransaction,
  listTransactions,
  loadAcceptedTotals,
} from '../integrations/quickbooks/transactions.js';
import { reconcile } from '../integrations/quickbooks/reconcile.js';
import {
  billingForProposal,
  syncTransactionState,
  documentPdf,
} from '../integrations/quickbooks/billing.js';
import { compareCustomerProfile } from '../integrations/quickbooks/customerProfile.js';
import { checkSkuMapping } from '../integrations/quickbooks/skuPreflight.js';
import { customFieldId } from '../integrations/quickbooks/customFields.js';
import { resolveInvoiceReferences } from '../integrations/monday/dealReferences.js';
import type { QboEnvironment, QboTxnType } from '@prisma/client';

/** QboTransaction rows carry BigInt columns — serialize to strings for JSON. */
/**
 * QboTransaction rows carry BigInt columns — serialized to strings for JSON.
 *
 * Every bigint on the row, not a named two. The row has nine of them and six
 * (qboTotalMinor, balanceMinor, paidMinor, initialTotalMinor and friends) are null
 * until QuickBooks has been read back — so naming columns one at a time produced a
 * route that worked on every draft transaction and threw 'Do not know how to serialize
 * a BigInt' the moment a real document synced. Listing them was the bug; walking them
 * cannot go stale when a column is added.
 */
function serializeTxn(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) out[k] = typeof v === 'bigint' ? v.toString() : v;
  return out;
}

async function activeRealmId(): Promise<string | null> {
  const conn = await prisma.qboConnection.findFirst({
    where: { environment: qboEnvironment() as QboEnvironment, isActive: true },
  });
  return conn?.realmId ?? null;
}

// Intuit redirects the BROWSER back to us with no Authorization header, so the
// callback cannot sit behind requirePermission. Instead the `state` nonce is a
// short-lived signed token naming the admin who started the flow: it doubles as
// CSRF protection and as the identity the token exchange is recorded against.
const stateKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const STATE_TTL = 900;

async function signState(userId: string): Promise<string> {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL)
    .sign(stateKey);
}

async function readState(state: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(state, stateKey);
    return String(payload.uid);
  } catch {
    return null;
  }
}

function resultPage(title: string, detail: string, ok: boolean): string {
  const safe = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe(title)}</title></head>
<body style="font-family:system-ui;max-width:520px;margin:80px auto;padding:0 24px;color:#20241f;">
<h1 style="font-size:20px;color:${ok ? '#3f9d78' : '#c2452f'};">${safe(title)}</h1>
<p style="color:#82877d;line-height:1.6;">${safe(detail)}</p>
<p><a href="/" style="color:#3d4a55;">Back to the workspace</a></p>
</body></html>`;
}

export function registerQuickbooksRoutes(app: FastifyInstance): void {
  const manage = { preHandler: requirePermission(Permission.QBO_MANAGE) };
  const transact = { preHandler: requirePermission(Permission.QBO_TRANSACT) };

  /**
   * What the next push will put in Project ID and Customer Purchase Order #, and
   * where each value comes from.
   *
   * Worth its own endpoint because "the field is blank in QuickBooks" has four
   * different causes that look identical from the outside: no value anywhere, a
   * value we hold but no writable slot to put it in, a slot collision, or a board
   * that could not be read. Guessing between them from a blank field is hopeless;
   * this states which one it is.
   *
   * The slot caveat matters most. QuickBooks' v3 API can only write the three LEGACY
   * sales-form custom fields. The newer Custom Fields feature — Settings → Custom
   * fields, with per-form "Print on form" toggles — is not writable through the API
   * at all. If these two fields were created there, no push can ever populate them
   * and the value goes in the memo instead. `writable: false` below is that case,
   * and the fix is to recreate them as legacy sales-form fields in QuickBooks.
   */
  app.get('/integrations/quickbooks/references/:versionId', transact, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const version = await prisma.proposalVersion.findUnique({
      where: { id: versionId },
      select: { id: true, sections: true, proposal: { select: { number: true } } },
    });
    if (!version) return reply.status(404).send({ error: 'NOT_FOUND' });

    const meta = Array.isArray(version.sections)
      ? (version.sections as Array<{ id?: string; data?: Record<string, unknown> }>).find(
          (s) => s?.id === 'meta',
        )?.data
      : undefined;
    const order = await prisma.acceptedOrder.findUnique({
      where: { proposalVersionId: version.id },
      select: { customerApproval: { select: { poNumber: true } } },
    });

    const refs = await resolveInvoiceReferences(version.id, {
      projectId: String(meta?.projectId ?? '').trim(),
      poNumber: order?.customerApproval?.poNumber ?? null,
    });

    const environment = qboEnvironment() as QboEnvironment;
    const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
    let projectSlot: string | null = null;
    let poSlot: string | null = null;
    let slotError: string | null = null;
    if (conn) {
      try {
        projectSlot = await customFieldId(
          conn.realmId,
          'Project ID',
          process.env.QBO_CUSTOM_FIELD_ID_PROJECT,
        );
        poSlot =
          (await customFieldId(
            conn.realmId,
            'Customer Purchase Order #',
            process.env.QBO_CUSTOM_FIELD_ID_PO,
          )) ?? '1';
      } catch (err) {
        slotError = err instanceof Error ? err.message : String(err);
      }
    }

    const collision = !!projectSlot && projectSlot === poSlot;
    return {
      proposal: version.proposal.number,
      boardError: refs.boardError,
      slotError,
      connected: !!conn,
      projectId: {
        value: refs.projectId || null,
        from: refs.source.projectId,
        slot: projectSlot,
        writable: !!projectSlot,
        willPrint: refs.projectId
          ? projectSlot
            ? 'custom field'
            : 'memo only'
          : 'nothing to send',
      },
      poNumber: {
        value: refs.poNumber,
        from: refs.source.poNumber,
        slot: collision ? null : poSlot,
        writable: !!poSlot && !collision,
        willPrint: refs.poNumber
          ? collision
            ? 'memo only — both fields resolve to the same QuickBooks slot'
            : poSlot
              ? 'custom field'
              : 'memo only'
          : 'nothing to send',
      },
      note: collision
        ? 'Project ID and Customer Purchase Order # resolve to the same custom-field slot. QuickBooks matches on the slot number, so one would overwrite the other — the PO is put in the memo instead. Give them different slots in QuickBooks.'
        : null,
    };
  });

  /**
   * What custom fields an invoice ALREADY IN QuickBooks actually carries.
   *
   * The slot lookup reads company preferences, which only ever list the three legacy
   * sales-form fields. A company on Intuit's newer Custom Fields feature has its
   * fields somewhere that lookup cannot see, so "no slot" is reported for a field
   * that plainly exists on screen — which is exactly the position this company is in.
   *
   * The only reliable way to learn the ids the newer fields use is to read a document
   * that has them filled in and look. This does that: hand-type the values on one
   * invoice in QuickBooks, run this, and it returns the DefinitionId and Name of
   * every custom field on that document. Those ids then go in
   * QBO_CUSTOM_FIELD_ID_PROJECT and QBO_CUSTOM_FIELD_ID_PO and the push writes them
   * directly, bypassing the preferences lookup entirely.
   */
  app.get('/integrations/quickbooks/invoice-fields/:versionId', transact, async (req, reply) => {
    const { versionId } = req.params as { versionId: string };
    const environment = qboEnvironment() as QboEnvironment;
    const conn = await prisma.qboConnection.findFirst({ where: { environment, isActive: true } });
    if (!conn) return reply.status(409).send({ error: 'NO_ACTIVE_CONNECTION' });

    const txn = await prisma.qboTransaction.findFirst({
      where: {
        proposalVersionId: versionId,
        type: 'INVOICE',
        status: 'CREATED',
        qboId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, qboId: true, qboDocNumber: true },
    });
    if (!txn?.qboId) {
      return reply.status(404).send({
        error: 'NO_INVOICE',
        message: 'No QuickBooks invoice has been created for that version.',
      });
    }

    const read = await readById<{
      Invoice: {
        Id: string;
        DocNumber?: string;
        CustomField?: Array<{
          DefinitionId?: string;
          Name?: string;
          Type?: string;
          StringValue?: string;
        }>;
        CustomerMemo?: { value?: string };
      };
    }>(conn.realmId, 'invoice', txn.qboId);

    const inv = read.Invoice;
    return {
      docNumber: inv?.DocNumber ?? txn.qboDocNumber,
      qboId: inv?.Id ?? txn.qboId,
      customFields: (inv?.CustomField ?? []).map((f) => ({
        definitionId: f.DefinitionId ?? null,
        name: f.Name ?? null,
        value: f.StringValue ?? null,
      })),
      memo: inv?.CustomerMemo?.value ?? null,
      hint:
        'Put the definitionId of the Project ID row in QBO_CUSTOM_FIELD_ID_PROJECT, and the ' +
        'Customer Purchase Order # row in QBO_CUSTOM_FIELD_ID_PO. An empty customFields array ' +
        'means these fields are not exposed on the API at all, and the memo is the only place ' +
        'the values can go.',
    };
  });

  // --- Status & connection (manage) ---
  app.get('/integrations/quickbooks/status', manage, async () => ({
    provider: 'quickbooks',
    configured: isQuickbooksConfigured(),
    environment: qboEnvironment(),
    productionWritesEnabled: env.QBO_PRODUCTION_WRITE_ENABLED,
    connections: await prisma.qboConnection.count({
      where: { environment: qboEnvironment() as QboEnvironment, isActive: true },
    }),
  }));

  // Begin OAuth: returns the Intuit consent URL. `state` is a signed nonce that
  // the callback verifies — the caller just follows the URL.
  app.get('/integrations/quickbooks/connect', manage, async (req, reply) => {
    if (!isQuickbooksConfigured()) return reply.status(409).send({ error: 'NOT_CONFIGURED' });
    const state = await signState(req.user!.sub);
    return { url: await authorizeUrl(state), state };
  });

  // OAuth redirect target. Public by necessity (see signState above); the state
  // token is what authenticates it.
  app.get('/integrations/quickbooks/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      realmId?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    reply.type('text/html; charset=utf-8');

    if (q.error)
      return reply
        .status(400)
        .send(resultPage('Connection cancelled', q.error_description ?? q.error, false));
    if (!q.code || !q.realmId || !q.state) {
      return reply
        .status(400)
        .send(resultPage('Connection failed', 'QuickBooks sent an incomplete response.', false));
    }

    const userId = await readState(q.state);
    if (!userId) {
      return reply
        .status(401)
        .send(
          resultPage(
            'Connection failed',
            'That connection request expired. Start again from Administration → Integrations.',
            false,
          ),
        );
    }

    try {
      await exchangeCode(q.code, q.realmId, userId);
      return reply.send(
        resultPage(
          'QuickBooks connected',
          `Connected to company ${q.realmId} in the ${qboEnvironment().toLowerCase()} environment.`,
          true,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The token exchange failed.';
      return reply.status(502).send(resultPage('Connection failed', message, false));
    }
  });

  app.post('/integrations/quickbooks/disconnect/:realmId', manage, async (req) => {
    const { realmId } = req.params as { realmId: string };
    await disconnect(realmId);
    return { disconnected: true };
  });

  // --- Master-data sync (manage) ---
  // refresh: true — push the current CRM profile onto an already-linked
  // QuickBooks customer, so fields missing at first creation get filled in.
  app.post(
    '/integrations/quickbooks/customers/:organizationId/sync',
    manage,
    async (req, reply) => {
      const realmId = await activeRealmId();
      if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
      const { organizationId } = req.params as { organizationId: string };
      return findOrCreateCustomer(organizationId, realmId, req.user!.sub, fetch, {
        refresh: true,
      });
    },
  );

  // Bulk-link the catalog to QuickBooks items by SKU. Creates nothing in
  // QuickBooks — items are imported there via the Products & Services
  // spreadsheet; this records which CPQ record maps to which QuickBooks item.
  // Idempotent, safe to re-run after any catalog or import change.
  app.post('/integrations/quickbooks/items/link-by-sku', manage, async (req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    // This is an operator-run maintenance scan, not a customer-facing route:
    // return the real failure so it can be diagnosed without digging through
    // platform logs. The generic INTERNAL handler hides the cause entirely.
    try {
      return await linkItemsBySku(realmId, req.user!.sub);
    } catch (err) {
      req.log.error({ err, realmId }, 'link-by-sku failed');
      return reply.status(500).send({
        error: 'LINK_BY_SKU_FAILED',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join('\n') : undefined,
      });
    }
  });

  /**
   * Income accounts, for the catalog's Sync to QuickBooks dialog.
   *
   * QuickBooks requires an income account on every item it creates. Which one is a
   * bookkeeping decision belonging to whoever is doing the sync, so the dialog asks
   * rather than a constant in code deciding for them. Inactive accounts are dropped
   * — offering one would only produce a rejected create.
   */
  app.get('/integrations/quickbooks/accounts', manage, async (_req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    const res = await query<{
      Account?: Array<{ Id: string; Name: string; AccountSubType?: string; Active?: boolean }>;
    }>(realmId, "select * from Account where AccountType = 'Income' maxresults 200");
    return {
      accounts: (res.Account ?? [])
        .filter((a) => a.Active !== false)
        .map((a) => ({ id: a.Id, name: a.Name, subType: a.AccountSubType ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  /**
   * Which products already have a QuickBooks item, so the catalog can show the link
   * state per row instead of making someone guess. Read from our own link table, not
   * from QuickBooks — it is the record of what THIS system believes, which is exactly
   * what decides whether an estimate will build.
   */
  app.get('/integrations/quickbooks/items/links', manage, async () => {
    const rows = await prisma.qboEntityLink.findMany({
      where: { environment: qboEnvironment() as QboEnvironment, entity: 'Item' },
      select: { entityId: true, qboId: true, state: true },
    });
    return { links: rows.map((r) => ({ productId: r.entityId, qboId: r.qboId, state: r.state })) };
  });

  // --- Payment terms (manage) ---
  // Terms live in QuickBooks; CPQ references them by Id. The portal reads this
  // list to populate its dropdowns.
  app.get('/integrations/quickbooks/terms', manage, async (_req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    return { terms: await listTerms(realmId) };
  });

  // Effective term for a proposal, with its source, so the UI can distinguish a
  // per-deal choice from one inherited from the client.
  app.get('/integrations/quickbooks/terms/proposal/:proposalId', manage, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    return resolveTermForProposal(proposalId);
  });

  // Send termId: null to clear an override and fall back to the client default.
  app.put('/integrations/quickbooks/terms/proposal/:proposalId', manage, async (req, reply) => {
    const { proposalId } = req.params as { proposalId: string };
    const b = (req.body ?? {}) as { termId?: string | null; termName?: string | null };
    if (b.termId !== null && typeof b.termId !== 'string') {
      return reply.status(400).send({ error: 'INVALID_INPUT' });
    }
    return setProposalTerm(proposalId, b.termId ?? null, b.termName ?? null);
  });

  app.put(
    '/integrations/quickbooks/terms/organization/:organizationId',
    manage,
    async (req, reply) => {
      const { organizationId } = req.params as { organizationId: string };
      const b = (req.body ?? {}) as { termId?: string | null; termName?: string | null };
      if (b.termId !== null && typeof b.termId !== 'string') {
        return reply.status(400).send({ error: 'INVALID_INPUT' });
      }
      return setOrganizationTerm(organizationId, b.termId ?? null, b.termName ?? null);
    },
  );

  app.post('/integrations/quickbooks/items/:productId/sync', manage, async (req, reply) => {
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    const { productId } = req.params as { productId: string };
    const { incomeAccountRef } = (req.body ?? {}) as { incomeAccountRef?: string };
    if (!incomeAccountRef) return reply.status(400).send({ error: 'INCOME_ACCOUNT_REF_REQUIRED' });
    return syncItem(productId, realmId, incomeAccountRef, req.user!.sub);
  });

  // --- Transactions (list = manage; mutate = transact) ---
  app.get('/integrations/quickbooks/transactions', manage, async (req) => {
    const q = req.query as { proposalId?: string };
    const rows = await listTransactions({ proposalId: q.proposalId });
    return rows.map(serializeTxn);
  });

  app.get('/integrations/quickbooks/reconcile', manage, async () =>
    reconcile(env.QBO_PRODUCTION_WRITE_ENABLED),
  );

  const TXN_TYPES: QboTxnType[] = [
    'ESTIMATE',
    'INVOICE',
    'DEPOSIT_INVOICE',
    'PROGRESS_INVOICE',
    'FINAL_INVOICE',
  ];

  // Prepare: freeze totals + idempotency key. Does NOT touch QuickBooks.
  app.post('/integrations/quickbooks/transactions/prepare', transact, async (req, reply) => {
    const b = (req.body ?? {}) as {
      proposalVersionId?: string;
      type?: QboTxnType;
      sequence?: number;
    };
    if (!b.proposalVersionId || !b.type || !TXN_TYPES.includes(b.type)) {
      return reply.status(400).send({ error: 'INVALID_INPUT' });
    }
    const txn = await prepareTransaction(
      { proposalVersionId: b.proposalVersionId, type: b.type, sequence: b.sequence },
      req.user!.sub,
    );
    return serializeTxn(txn);
  });

  // Explicit authorization — required before any live financial create.
  app.post('/integrations/quickbooks/transactions/:id/authorize', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await authorizeTransaction(id, req.user!.sub));
  });

  // Execute: create the document in QuickBooks (idempotent).
  app.post('/integrations/quickbooks/transactions/:id/execute', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await executeTransaction(id, req.user!.sub));
  });

  /**
   * Discard a prepared document that was never created in QuickBooks.
   *
   * The totals froze when it was prepared, so a freight correction afterwards leaves it
   * holding a figure the proposal no longer carries. Discarding releases the order to be
   * prepared again at the current total.
   */
  app.post('/integrations/quickbooks/transactions/:id/discard', transact, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    return serializeTxn(await discardTransaction(id, req.user!.sub, body.reason ?? ''));
  });

  // Manual retry of a FAILED transaction (same idempotency key — never duplicates).
  app.post('/integrations/quickbooks/transactions/:id/retry', transact, async (req) => {
    const { id } = req.params as { id: string };
    return serializeTxn(await retryTransaction(id, req.user!.sub));
  });

  // --- Customer profile comparison (manage) ---
  // What QuickBooks holds for this customer against what the CRM holds, field
  // by field. Read-only in both directions: CPQ owns every field compared, so
  // the fix for a difference is to correct the CRM record and re-run the sync
  // above — there is deliberately no way to pull an accountant's typo back into
  // the CRM.
  app.get(
    '/integrations/quickbooks/customers/:organizationId/profile',
    manage,
    async (req, reply) => {
      const { organizationId } = req.params as { organizationId: string };
      try {
        return await compareCustomerProfile(organizationId);
      } catch (err) {
        req.log.error({ err, organizationId }, 'customer profile comparison failed');
        return reply.status(502).send({
          error: 'QBO_PROFILE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // --- Part-number preflight (manage) ---
  // Does every priced line on the accepted proposal resolve to a real, active
  // QuickBooks item? This is the same check the create step enforces, exposed
  // so the answer is visible before anyone authorizes a document rather than
  // arriving as a failed create.
  app.get('/integrations/quickbooks/preflight/:proposalVersionId', manage, async (req, reply) => {
    const { proposalVersionId } = req.params as { proposalVersionId: string };
    const realmId = await activeRealmId();
    if (!realmId) return reply.status(409).send({ error: 'NOT_CONNECTED' });
    try {
      const totals = await loadAcceptedTotals(proposalVersionId);
      return await checkSkuMapping(totals.lines, realmId);
    } catch (err) {
      // A version that is not ACCEPTED, or has no snapshot, is a 4xx the caller
      // can act on — only a genuine QuickBooks read failure is a 502.
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      req.log.error({ err, proposalVersionId }, 'QuickBooks SKU preflight failed');
      return reply.status(502).send({
        error: 'QBO_PREFLIGHT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // --- Billing: delivery, payments, reminders ---
  // The whole billing picture for one proposal, from the local mirror.
  // ?refresh=1 re-reads QuickBooks first; without it this is a cheap local read
  // so opening an order does not cost an Intuit round trip per document.
  app.get('/integrations/quickbooks/billing/:proposalId', manage, async (req) => {
    const { proposalId } = req.params as { proposalId: string };
    const { refresh } = req.query as { refresh?: string };
    return billingForProposal(proposalId, { refresh: refresh === '1' || refresh === 'true' });
  });

  // Re-read one document's state from QuickBooks. Reading is not transacting,
  // so this sits under manage rather than transact.
  app.post('/integrations/quickbooks/transactions/:id/sync', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { transaction, payments } = await syncTransactionState(id);
      return {
        transaction: serializeTxn(transaction),
        payments: payments.map((p) => ({
          ...p,
          amountMinor: p.amountMinor.toString(),
          totalAmountMinor: p.totalAmountMinor.toString(),
          unappliedMinor: p.unappliedMinor.toString(),
        })),
      };
    } catch (err) {
      req.log.error({ err, id }, 'qbo sync failed');
      return reply.status(502).send({
        error: 'QBO_SYNC_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Customer delivery is NOT ours to do.
   *
   * Biller Genie owns every customer-facing email: it picks up each invoice from
   * QuickBooks within a few minutes of creation and sends it on Summit's branded
   * letterhead with its own payment link and follow-up schedule. If QuickBooks also
   * emailed, the customer would receive the same invoice twice, from two systems,
   * with two different ways to pay — and the payment taken through the wrong one
   * would not reconcile.
   *
   * So the send and reminder endpoints are closed rather than merely hidden. The
   * buttons are gone from the panel, but a stale tab, a bookmarked call or a future
   * UI could still reach them, and the cost of one accidental send is a confused
   * customer and a misapplied payment.
   *
   * To re-enable: delete these three handlers and restore the originals from git
   * history — sendTransaction, draftReminder and sendReminder are all still intact.
   */
  const DELIVERY_IS_EXTERNAL = {
    error: 'DELIVERY_HANDLED_EXTERNALLY',
    message:
      'Invoices are delivered by Biller Genie, not by QuickBooks. It collects each invoice from QuickBooks within a few minutes of creation and emails the customer itself, so nothing needs to be sent from here.',
  } as const;

  app.post('/integrations/quickbooks/transactions/:id/send', transact, async (_req, reply) =>
    reply.status(409).send(DELIVERY_IS_EXTERNAL),
  );

  // The document as the customer received it. Fetched live from QuickBooks each
  // time — an invoice edited on the accounting side should show its current
  // state, and a cached copy would quietly disagree with the customer's.
  app.get('/integrations/quickbooks/transactions/:id/pdf', manage, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { pdf, filename } = await documentPdf(id);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${filename}"`)
      .send(pdf);
  });

  // Reminders are Biller Genie's follow-up schedule, not ours. See above.
  app.get('/integrations/quickbooks/transactions/:id/reminder', manage, async (_req, reply) =>
    reply.status(409).send(DELIVERY_IS_EXTERNAL),
  );

  app.post('/integrations/quickbooks/transactions/:id/reminder', transact, async (_req, reply) =>
    reply.status(409).send(DELIVERY_IS_EXTERNAL),
  );
}

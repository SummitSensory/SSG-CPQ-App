// QuickBooks sandbox end-to-end test.
// Paste into the browser console on the Preview deployment, logged in as an
// admin with the `transact` permission.
//
// 1. Set VERSION_ID below to an ACCEPTED proposal version id.
// 2. Run. It walks prepare -> authorize -> execute for the estimate, then the
//    full-value itemized invoice, printing every response.
//
// Nothing is created in QuickBooks until the execute step, and each execute
// carries the transaction's idempotency key, so a re-run never duplicates.

const VERSION_ID = 'PASTE_ACCEPTED_PROPOSAL_VERSION_ID';

(async () => {
  const at = localStorage.getItem('ssg_at');
  if (!at) return console.error('No access token — log in first.');
  const H = { authorization: 'Bearer ' + at, 'content-type': 'application/json' };

  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    const row = { step: `${method} ${url}`, status: r.status, body: parsed };
    console.log(row.status < 400 ? '%c✓ ' + row.step : '%c✗ ' + row.step,
      row.status < 400 ? 'color:green' : 'color:red', row);
    if (r.status >= 400) throw new Error(`${row.step} -> ${r.status} ${text}`);
    return parsed;
  }

  const results = {};

  async function run(type) {
    const prepared = await call('POST', '/integrations/quickbooks/transactions/prepare',
      { proposalVersionId: VERSION_ID, type });
    const id = prepared.id;
    await call('POST', `/integrations/quickbooks/transactions/${id}/authorize`);
    const executed = await call('POST', `/integrations/quickbooks/transactions/${id}/execute`);
    results[type] = {
      txnId: id,
      status: executed.status,
      qboId: executed.qboId,
      docNumber: executed.qboDocNumber,
      amountMinor: executed.amountMinor,
    };
    return executed;
  }

  try {
    await run('ESTIMATE');
    await run('INVOICE');
    results.reconcile = await call('GET', '/integrations/quickbooks/reconcile');
  } catch (err) {
    console.error('Stopped at first failure:', err.message);
    results.error = err.message;
  }

  const pretty = JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2);
  console.log(pretty);
  try { await navigator.clipboard.writeText(pretty); console.log('%c✓ copied to clipboard', 'color:green'); }
  catch { console.log('Clipboard blocked — copy the JSON above manually.'); }
})();

// Round-trip test for the per-project price gate.
//
// Paste into the browser console on the deployment, logged in as someone who can
// edit proposals. Pass a DRAFT proposal id — the test writes to its latest
// version and puts the original items back when it finishes.
//
//   priceGateTest('cmxxxxxxxxxxxx')
//
// It never releases anything. The release path is checked by reading
// /price-check, which is the same audit the release gate runs.
//
// What it proves, in order:
//   1. a rate of null survives the save  (the bug that would break the gate)
//   2. an unanswered line is reported AWAITING_PRICE
//   3. $0.00 with no reason is reported ZERO_WITHOUT_REASON
//   4. $0.00 with a reason clears
//   5. a typed rate clears
//
// On any failure it stops, restores, and prints what came back.

window.priceGateTest = async function priceGateTest(proposalId, sku) {
  sku = sku || 'SVC-CON-HR';
  const at = localStorage.getItem('ssg_at');
  if (!at) return console.error('No access token — log in first.');
  if (!proposalId) return console.error('Pass a DRAFT proposal id: priceGateTest("cm…")');

  const call = async (path, opts) => {
    const r = await fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let body = null;
    try {
      body = JSON.parse(await r.text());
    } catch (e) {
      /* non-JSON */
    }
    return { status: r.status, ok: r.ok, body };
  };

  const results = [];
  const pass = (name, detail) => {
    results.push({ step: name, result: 'PASS', detail });
    console.log('%c✓ ' + name, 'color:green', detail || '');
  };
  const fail = (name, detail) => {
    results.push({ step: name, result: 'FAIL', detail });
    console.log('%c✗ ' + name, 'color:#b00', detail);
  };

  // ---- load the proposal and pick the newest version ----
  const p = await call('/proposals/' + proposalId);
  if (!p.ok || !p.body) return console.error('Could not load that proposal.', p);
  const versions = p.body.versions || [];
  const version = versions[versions.length - 1];
  if (!version) return console.error('That proposal has no versions.');
  if (version.status !== 'DRAFT') {
    return console.error(
      'Latest version is ' + version.status + '. Use a DRAFT — this test writes to it.',
    );
  }
  const versionId = version.id;
  const original = JSON.parse(JSON.stringify(version.items || []));
  console.log(
    'Testing version',
    versionId,
    '(v' + version.version + '),',
    original.length,
    'existing lines. Original items saved for restore.',
  );

  // Full copy of the original payload shape, plus one test line appended.
  const withTestLine = (rateMinor, priceNote) => {
    const line = {
      ref: 'pricegate-test',
      lineType: 'PRODUCT',
      kind: 'INCLUDED',
      productId: null,
      sku: sku,
      name: 'PRICE GATE TEST — delete if you see this',
      description: '',
      quantity: 1,
      rateMinor: rateMinor,
      priceNote: priceNote,
      costEach: 0,
      weightEach: 0,
      group: '',
      optional: false,
      order: original.length,
    };
    return { items: original.concat([line]) };
  };

  const readBackTestLine = async () => {
    const again = await call('/proposals/' + proposalId);
    const vs = (again.body && again.body.versions) || [];
    const v = vs.filter((x) => x.id === versionId)[0];
    return ((v && v.items) || []).filter((l) => l.ref === 'pricegate-test')[0] || null;
  };

  const restore = async () => {
    const r = await call('/proposals/versions/' + versionId, {
      method: 'PATCH',
      body: { items: original },
    });
    if (r.ok) console.log('%c↩ original lines restored', 'color:#555');
    else
      console.error(
        'RESTORE FAILED — the test line may still be on the proposal. Delete it in the builder.',
        r,
      );
  };

  try {
    // ---- 1. null rate survives the round trip ----
    let w = await call('/proposals/versions/' + versionId, {
      method: 'PATCH',
      body: withTestLine(null, null),
    });
    if (!w.ok) {
      fail('save a line with no rate', w);
      await restore();
      return console.table(results);
    }
    let back = await readBackTestLine();
    if (!back) {
      fail('read the test line back', 'line not found after save');
      await restore();
      return console.table(results);
    }
    if (back.rateMinor === null || back.rateMinor === undefined)
      pass('null rate survives the save', 'rateMinor came back ' + JSON.stringify(back.rateMinor));
    else
      fail(
        'null rate survives the save',
        'rateMinor came back ' +
          JSON.stringify(back.rateMinor) +
          ' — the gate cannot tell "unanswered" from "$0.00". Stop here.',
      );

    // ---- 2. unanswered is reported ----
    let chk = await call('/proposals/versions/' + versionId + '/price-check');
    let hit = ((chk.body && chk.body.issues) || []).filter((i) => i.sku === sku)[0];
    if (hit && hit.reason === 'AWAITING_PRICE') pass('unanswered line is flagged', hit.reason);
    else fail('unanswered line is flagged', JSON.stringify(chk.body));

    // ---- 3. zero with no reason is reported ----
    await call('/proposals/versions/' + versionId, {
      method: 'PATCH',
      body: withTestLine(0, null),
    });
    chk = await call('/proposals/versions/' + versionId + '/price-check');
    hit = ((chk.body && chk.body.issues) || []).filter((i) => i.sku === sku)[0];
    if (hit && hit.reason === 'ZERO_WITHOUT_REASON')
      pass('$0.00 with no reason is flagged', hit.reason);
    else fail('$0.00 with no reason is flagged', JSON.stringify(chk.body));

    // ---- 4. zero with a reason clears ----
    await call('/proposals/versions/' + versionId, {
      method: 'PATCH',
      body: withTestLine(0, 'Waived — included in the project fee'),
    });
    back = await readBackTestLine();
    chk = await call('/proposals/versions/' + versionId + '/price-check');
    hit = ((chk.body && chk.body.issues) || []).filter((i) => i.sku === sku)[0];
    if (!hit && String((back && back.priceNote) || '').trim())
      pass('$0.00 with a reason clears', 'priceNote stored: ' + JSON.stringify(back.priceNote));
    else if (hit) fail('$0.00 with a reason clears', 'still flagged as ' + hit.reason);
    else
      fail(
        '$0.00 with a reason clears',
        'cleared, but priceNote did not persist: ' + JSON.stringify(back && back.priceNote),
      );

    // ---- 5. a real rate clears ----
    await call('/proposals/versions/' + versionId, {
      method: 'PATCH',
      body: withTestLine(18500, null),
    });
    back = await readBackTestLine();
    chk = await call('/proposals/versions/' + versionId + '/price-check');
    hit = ((chk.body && chk.body.issues) || []).filter((i) => i.sku === sku)[0];
    if (!hit && Number(back && back.rateMinor) === 18500)
      pass('a typed rate clears', '$185.00 stored');
    else
      fail(
        'a typed rate clears',
        hit
          ? 'still flagged as ' + hit.reason
          : 'rate came back ' + JSON.stringify(back && back.rateMinor),
      );
  } catch (err) {
    fail('unexpected error', String((err && err.message) || err));
  }

  await restore();
  console.table(results);
  const failed = results.filter((r) => r.result === 'FAIL');
  console.log(
    failed.length
      ? '%c' + failed.length + ' step(s) failed — do not rely on the gate yet.'
      : '%cAll steps passed. The gate is doing what it should.',
    'font-weight:bold;color:' + (failed.length ? '#b00' : 'green'),
  );
  return results;
};

console.log('%cLoaded. Run:  priceGateTest("<draft proposal id>")', 'font-weight:bold');

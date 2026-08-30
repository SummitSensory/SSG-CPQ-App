// Paste into the browser console on the Preview deployment, logged in as admin.
// Runs the QuickBooks item link-by-SKU scan and prints copyable JSON.
(async () => {
  const at = localStorage.getItem('ssg_at');
  if (!at) return console.error('No access token — log in first.');

  const r = await fetch('/integrations/quickbooks/items/link-by-sku', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' },
  });

  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  const out = { httpStatus: r.status, ok: r.ok, body };
  console.log(out);

  const pretty = JSON.stringify(out, null, 2);
  console.log(pretty);
  try {
    await navigator.clipboard.writeText(pretty);
    console.log('%c✓ copied to clipboard', 'color:green');
  } catch {
    console.log('Clipboard blocked — select the JSON above and copy manually.');
  }
})();

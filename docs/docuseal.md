# Proposal e-signing (DocuSeal)

## What was built

Assembly-first. A proposal is composed **in the CRM** — the browser's proposal HTML,
plus any attachment documents, rendered to one PDF by the same headless Chromium
that produces the monday document and the customer email. That PDF is the signing
package. DocuSeal signs it; it does not build it.

    proposal HTML (browser)
      + attachment templates (EsignDocumentTemplate, kind=ATTACHMENT)
      + signature page with DocuSeal text tags
      → one Letter PDF → SHA-256 → our storage → DocuSeal template → submission

## Files

| File                                         | Role                                        |
| -------------------------------------------- | ------------------------------------------- |
| `prisma/schema.esign.prisma`                 | Models to paste into `schema.prisma`        |
| `prisma/migrations/0050_esign/migration.sql` | The migration                               |
| `src/integrations/docuseal/client.ts`        | REST client (`X-Auth-Token`, retry/backoff) |
| `src/integrations/docuseal/assembly.ts`      | Package composition + signature page        |
| `src/integrations/docuseal/storage.ts`       | Vercel Blob via REST, no new dependency     |
| `src/integrations/docuseal/service.ts`       | Send, status, void, template resolution     |
| `src/routes/esign.ts`                        | API                                         |
| `src/routes/esignWebhook.ts`                 | `POST /webhooks/docuseal`                   |
| `src/config/env.ts`                          | DocuSeal + Blob variables                   |
| `src/app.ts`                                 | Route registration                          |
| `src/authz/permissions.ts`                   | `proposal:esign`                            |

`schema.prisma` and the three modified files are complete replacements; the schema
fragment is the only thing to paste, following the `schema.freight-rfq.prisma`
precedent.

## Decisions

**MCP is not in the path.** `claude mcp add docuseal` gives _you_ DocuSeal tools in
Claude Code. Production code talks to `api.docuseal.com` over plain HTTPS — an agent
transport with an interactive auth step has no business inside a send.

**Storage: Vercel Blob.** Already on Vercel, so it is one token instead of an IAM
role, a bucket policy and a signing library; a serverless function has no writable
disk; and the executed contract must not live only in DocuSeal, where retention
depends on someone else's account staying paid. Set `BLOB_READ_WRITE_TOKEN` and both
the outgoing package and the signed PDF are copied to
`esign/<proposal>/<envelope>/{package,signed}.pdf`. Unset is supported — the envelope
keeps DocuSeal's own URL. Swapping to S3 later means replacing `storage.ts` and
nothing else.

**~10 templates, auto-picked with manual override.** `EsignDocumentTemplate` rows
carry `productLineIds`; the resolver prefers a template naming a product line on the
version, falls back to the one naming none, and a `templateKey` in the request always
wins. `GET /esign/proposals/versions/:id/plan` shows the pick before sending.

**Conditional attachments are stubbed honestly.** Which of liability, financing and
the mat pages ride along is undecided, so `resolveAttachments` reads exactly two
things: an explicit list from the caller, and `attachRule.always === true`. Any other
rule you write in `attachRule` is stored and ignored until the conditions are settled
— then one function changes.

**Signature fields come from the document.** The signature page renders DocuSeal text
tags (`{{Customer Signature;role=Customer;type=signature}}`), so field positions move
with the layout and there are no stored coordinates to drift.

**One live envelope per version, and a send is never edited.** A corrected proposal is
a new envelope; the old one is voided explicitly. Two open signing links for the same
job is how a customer signs the wrong price.

## Environment

    DOCUSEAL_API_TOKEN=...                 # DocuSeal → Settings → API
    DOCUSEAL_WEBHOOK_SECRET=...            # long random string
    BLOB_READ_WRITE_TOKEN=...              # Vercel → Storage → Blob
    DOCUSEAL_SEND_EMAIL=true               # false to send the link from the CRM
    DOCUSEAL_FOLDER=Proposals              # optional
    DOCUSEAL_API_URL=https://api.docuseal.com          # self-hosted: your /api
    DOCUSEAL_SIGNING_BASE_URL=https://docuseal.com

In DocuSeal → Settings → Webhooks, point the URL at
`https://crm.summitsensory.com/webhooks/docuseal`, subscribe to `form.viewed`,
`form.started`, `form.completed`, `form.declined` and `submission.completed`, and add
a custom header `X-Webhook-Secret` with the same value as `DOCUSEAL_WEBHOOK_SECRET`.
Without the secret the endpoint refuses every request, matching the Resend webhook's
stance.

## Deploy order

1. Paste the schema fragment into `prisma/schema.prisma`, copy the migration folder.
2. `pnpm db:migrate:deploy && pnpm db:generate` (0047–0049 are still pending — this
   goes after them).
3. Copy the source files, set the env vars on the `qbo-sandbox` preview first.
4. `pnpm typecheck` — the new `prisma.esign*` clients only exist after `db:generate`.
5. Seed a first PROPOSAL template: `POST /esign/templates` with
   `{"key":"standard","kind":"PROPOSAL","name":"Standard proposal","bodyHtml":"<div></div>"}`.
   A PROPOSAL template's `bodyHtml` is not rendered today (the proposal body comes
   from the browser); it exists so the auto-pick has something to name and so a
   future cover page has somewhere to live.

## API

    GET  /esign/status
    GET  /esign/proposals/versions/:versionId/plan?templateKey=&attachmentKeys=
    POST /render/esign/proposals/versions/:versionId/send
    GET  /esign/envelopes?proposalId=&versionId=&status=
    GET  /esign/envelopes/:id
    POST /esign/envelopes/:id/sync
    POST /esign/envelopes/:id/void          {"reason":"..."}
    GET|POST|PATCH|DELETE /esign/templates

The send body:

    {
      "proposalHtml": "<html>…</html>",
      "signers": [
        {"role":"Customer","name":"Jane Doe","email":"jane@example.org","order":1},
        {"role":"Summit","name":"Bryan Shepherd","email":"bryan@summitsensory.com","order":2}
      ],
      "templateKey": "standard",
      "attachmentKeys": ["liability-waiver"],
      "subject": "Your Summit Sensory Gym proposal",
      "message": "…"
    }

The send is under `/render/*` deliberately: `vercel.json` routes that prefix to the
2 GB / 60 s function, which is where a cold headless browser can finish.

## Still open

- The attachment conditions, and the ~10 templates' actual content.
- Embedded signing. Signer links open in a new tab today. Embedding DocuSeal's form
  in the app needs `frameSrc`/`scriptSrc` for `docuseal.com` in the helmet CSP in
  `app.ts` — a deliberate loosening, so it is not done pre-emptively.
- No UI yet. `public/app.js` needs a send dialog (signers, template, attachments) and
  a status strip on the proposal; the API is shaped for it, and the `plan` endpoint
  exists so the dialog can show the auto-pick.
- Countersigning is modelled as a second signer with `role=Summit`, order 2. Whether
  Summit countersigns every proposal or only financed ones is your call.

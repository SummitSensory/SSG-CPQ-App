# Payment requests, invoice balances and the customer's purchase order

What this adds, and what has to be done once before it works.

## What it does

**Accounts Receivable** — a new tab in the sidebar, between Orders and Belt
Shipments. Every invoice in QuickBooks with what the customer was originally
billed, what they have paid, and what is left. Totals across the top. Nightly
sweep plus a Refresh button.

**The customer's purchase order** — editable on any order at any time from the
Purchase order panel on each row. It writes `CustomerApproval.poNumber`, which is
the field the QuickBooks push, the monday board reconciliation and the order
paperwork already read, so there is no second copy to disagree with it. When the
invoice already exists in QuickBooks, the row shows that the document does not
carry the PO and offers to push it: that writes the invoice's purchase-order
custom field and its note to the customer, and nothing else. The PO document
itself can be uploaded, kept on the order, opened later, and attached to an email.

**The payment request** — an HTML email composed from an editable template, sent
from the signed-in person's own Outlook mailbox with their own saved signature. It
can carry the QuickBooks invoice PDF, one letterhead letter rendered to PDF, and
any of the customer's uploaded purchase orders. Every send is logged with the body
as it went out, and written to the customer's note timeline.

The email is genuinely from that mailbox: Microsoft sends it as the signed-in
user under delegated `Mail.Send`, so the From address, the SPF/DKIM result, the
reply path and the Sent Items copy are all theirs. Nothing sets a From header.

## Setup, once

1. **Run the migration.** `prisma/migrations/0070_payment_requests` is applied by
   `scripts/migrate-deploy.mjs` on deploy. Append the models in
   `prisma/schema.payment-requests.prisma` to `prisma/schema.prisma` first — that
   file also lists the six columns to add to `model QboTransaction`. Without the
   schema edit, Prisma will not know the new tables and every query on this screen
   fails; without the migration, Prisma selects columns the database does not have
   and breaks `QboTransaction` queries everywhere.

2. **Add `Mail.Send` to the Entra app registration.** Delegated, not application:
   _App registrations → your SSO app → API permissions → Add → Microsoft Graph →
   Delegated → Mail.Send_, then grant admin consent. `Mail.ReadWrite` is already
   there.

3. **Every user reconnects Outlook once.** Microsoft does not widen an existing
   grant on refresh, so a mailbox connected before this change holds a token
   without `Mail.Send`. The composer detects that and says so; reconnecting from
   the profile screen is one click and keeps everything else as it is.

4. **Set `BLOB_READ_WRITE_TOKEN`** on Vercel if it is not already set. Without it
   the PO upload refuses rather than silently dropping the file. Everything else
   works.

5. **Confirm `CRON_SECRET` is set.** The nightly sweep at `/cron/receivables`
   (11:00 UTC, in `vercel.json`) refuses to run without it.

6. **Optionally set `QBO_CUSTOM_FIELD_ID_PO`.** QuickBooks' v3 API can only write
   the three legacy sales-form custom fields; fields created under _Settings →
   Custom fields_ are not writable through the API at all. When no legacy slot
   resolves, the PO goes in the note to the customer, which always prints. To find
   the real ids on a company using the newer feature, fill the field in by hand on
   one invoice and call `GET /integrations/quickbooks/invoice-fields/:versionId`.

## The letters

The letter templates are empty on purpose. The wording is Summit's own and it goes
out over somebody's signature, so nothing is invented here. Add each one under
**Accounts Receivable → Letters & email → New letter**: give it a name, a key, the
heading that prints on the letter, and the body as simple HTML. `Preview PDF`
prints it on the letterhead with sample figures.

The letterhead is the one the freight RFQ and the financing sheet already use —
the 52px mark, the company name in Georgia over a navy rule, the red accent bar —
so everything a customer receives reads as one system.

### Merge fields

`{{customer_first_name}}` `{{customer_name}}` `{{organization_name}}`
`{{invoice_number}}` `{{invoice_date}}` `{{invoice_amount}}` `{{invoice_link}}`
`{{balance_due}}` `{{amount_paid}}` `{{due_date}}` `{{days_past_due}}`
`{{po_number}}` `{{order_number}}` `{{proposal_number}}` `{{sender_name}}`
`{{sender_title}}` `{{sender_email}}` `{{sender_phone}}` `{{today}}`

`{{FIGURES}}` drops in the invoice figures table.

Three are typed in on the send form rather than read from the CRM, because they
are commitments made per message and guessing them from a due date would put a
promise in front of a customer that nobody made: `{{tentative_ship_date}}`,
`{{payment_deadline}}`, `{{final_payment_deadline}}`.

A letter that uses a field with no value is **refused before it is sent**, naming
the field. A letter reading "your balance of is now due" is not a letter anybody
wants to have sent under their name.

## Where the code is

| File                                         | What it holds                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/integrations/quickbooks/receivables.ts` | The balance mirror: initial total, invoice date, payment link, the ledger, the sweep |
| `src/integrations/quickbooks/poSync.ts`      | Writing the PO onto a live invoice; recording it on the order                        |
| `src/integrations/quickbooks/client.ts`      | `update()` — QuickBooks sparse update, and `include=invoiceLink`                     |
| `src/integrations/microsoft/graph.ts`        | `Mail.Send`, attachments, and sending as the signed-in user                          |
| `src/email/paymentTemplates.ts`              | Merge fields, the email shell, the letterhead                                        |
| `src/lib/fileStore.ts`                       | Uploads to Vercel Blob, any content type                                             |
| `src/routes/receivables.ts`                  | Reads, the PO, the template admin                                                    |
| `src/routes/receivablesRender.ts`            | The send and the letter PDFs — on the renderer function                              |
| `src/routes/cronReceivables.ts`              | `/cron/receivables`                                                                  |
| `public/accounts-receivable.js`              | The screen. Installs its own nav entry; app.js is untouched                          |

## Two things worth knowing

**The send runs on the renderer function.** It prints the letter with headless
Chromium, so it is routed under `/render/*` where there are 180 seconds and 3009 MB
(`vercel.json`). The main function's thirty seconds is not enough for a Chromium
cold start plus a QuickBooks PDF fetch plus three Graph calls, and the failure mode
when it is not enough is a timeout halfway through sending a customer a demand for
money.

**This does not touch Biller Genie.** Biller Genie still collects each invoice from
QuickBooks and delivers it on Summit letterhead with its own payment link and
follow-up schedule; the QuickBooks send and reminder endpoints stay closed. This is
a different act — a person writing to a customer from their own mailbox about a
specific balance — and it is composed by hand every time. Nothing here sends
anything on a schedule, deliberately: a cron that emailed customers about money
would be one bad query away from an apology.

## Permissions

Reading this screen is `accounting:read` (Accounting, Executive, System Admin).
Every write — the PO, the upload, the push, the send — is `accounting:write`
(Accounting, System Admin). Editing templates is `rules:manage` (System Admin).
To let another role send, add `ACCOUNTING_WRITE` to that role in
`src/authz/permissions.ts`.

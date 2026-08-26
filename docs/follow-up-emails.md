# Follow-up email templates

Ten templates, picked from inside the CRM, copied to the clipboard, pasted into Outlook,
and logged per customer.

## Files

| File                                                       | Role                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/email/followUpTemplates.ts`                           | **New.** The ten emails, their guidance, and the HTML/plain renderer    |
| `src/routes/followUps.ts`                                  | **New.** List with history, log a send, remove a line                   |
| `prisma/migrations/0052_follow_up_email_log/migration.sql` | **New.**                                                                |
| `prisma/schema.prisma`                                     | **Replace.** Adds `FollowUpEmailLog` + the `Organization` back-relation |
| `src/app.ts`                                               | **Replace.** Registers the routes                                       |
| `public/app.js`                                            | **Replace.** The picker on the proposal screen                          |

```
copy /Y fixes\prisma\schema.prisma prisma\schema.prisma
copy /Y fixes\src\app.ts src\app.ts
copy /Y fixes\public\app.js public\app.js
mkdir src\email
copy /Y fixes\src\email\followUpTemplates.ts src\email\followUpTemplates.ts
copy /Y fixes\src\routes\followUps.ts src\routes\followUps.ts
mkdir prisma\migrations\0052_follow_up_email_log
copy /Y fixes\prisma\migrations\0052_follow_up_email_log\migration.sql prisma\migrations\0052_follow_up_email_log\migration.sql
pnpm db:migrate:deploy
pnpm db:generate
pnpm typecheck
```

Then open any released proposal — **Follow-up email…** sits beside _Write an email…_.
On the **Proposals list**, each live or lapsed row gets a **Follow-up…** button next to
Quick status, so the past-expiration band can be worked straight down without opening
each proposal first.

## How it works

Pick a template on the left, read it on the right, then **Copy & log it**. The clipboard
gets two flavours at once: `text/html` so Outlook keeps the paragraphs and the bolded
question, and `text/plain` for anything that refuses HTML. Paste into a new Outlook
message and send it from your own mailbox, so the reply comes back to you.

**Copy without logging** is there for a redraft you are not actually sending yet.

The row button is offered only while a proposal is still live or lapsed — a follow-up
sequence has nothing to say to an accepted or rejected deal — and it stops the click from
also opening the proposal.

## Decisions

**History is per customer, not per proposal.** Two live proposals for one organization
do not entitle it to two copies of _What Are Your Initial Thoughts?_ — that reads as a
mail-merge accident regardless of which project prompted it. The proposal is still
recorded on each line, so the history says which project each email was about.

**Nothing is blocked.** Each template shows when it last went, to whom, and by whom, and
you decide — a hard block would be wrong the first time a stalled project restarts a
year later or the contact changes. Every line also lands in the customer's note log, so
the account timeline reads as one story.

**The column is `copiedAt`, not `sentAt`.** The app formats the email; Outlook sends it.
A row is your assertion that you sent it, not a delivery receipt, and the field name
keeps that honest. Removing a line is possible for a mis-click and is audited.

**The emails are plain on purpose.** No logo, no header band, no buttons — 11pt Calibri
after the system stack, which is Outlook's own default. Every style is inline, because
Outlook strips a `<style>` block on paste. One question per email is bold and alone; a
question buried mid-paragraph does not get answered.

**The sequence order is load-bearing.** Financing appears at 6 only after 5 has
established that budget is the obstacle, and 9 opens the door to a concession only when
the gap is known to be small. The picker leads with the step number and the _when to
send_ line for that reason. You asked for no automatic suggestion, so nothing is greyed
out or pre-selected.

## Editing the copy

The wording lives in `FOLLOW_UP_TEMPLATES` in `src/email/followUpTemplates.ts` — one
object per email, `paragraphs` as an array where `{ ask: '…' }` is the bolded question.
Edit and redeploy. Placeholders available: `[First Name]`, `[Customer]`,
`[Proposal Number]`, `[Proposal]`, `[Sender]`.

If you would rather edit these in the CRM without a deploy, say so — it is the same
shape as the rate-sheet editor and would take a table plus a screen.

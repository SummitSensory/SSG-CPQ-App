# Follow-up emails — Outlook handoff and template editing

Two changes: the picker now hands Outlook a filled-in draft instead of asking you to
paste, and the templates moved out of code into an Administration screen.

## Files

| File                                                       | Role                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/email/followUpTemplates.ts`                           | **Replace.** Body is now editable plain text; adds the `.eml` builder |
| `src/routes/followUps.ts`                                  | **Replace.** Draft route, DB-backed templates, admin CRUD             |
| `prisma/schema.prisma`                                     | **Replace.** Adds `FollowUpTemplate`                                  |
| `prisma/migrations/0053_follow_up_templates/migration.sql` | **New.**                                                              |
| `public/app.js`                                            | **Replace.** Outlook buttons + Administration → Follow-up emails      |

```
copy /Y fixes\prisma\schema.prisma prisma\schema.prisma
copy /Y fixes\src\email\followUpTemplates.ts src\email\followUpTemplates.ts
copy /Y fixes\src\routes\followUps.ts src\routes\followUps.ts
copy /Y fixes\public\app.js public\app.js
mkdir prisma\migrations\0053_follow_up_templates
copy /Y fixes\prisma\migrations\0053_follow_up_templates\migration.sql prisma\migrations\0053_follow_up_templates\migration.sql
pnpm db:generate
pnpm db:migrate:deploy
pnpm typecheck
```

The ten templates seed themselves into the table the first time Administration or the
picker loads. Nothing to run.

## Opening it in Outlook

**Open in Outlook** is now the primary button. It downloads a `.eml` draft; opening it
gives you an Outlook message already addressed, with the subject and the formatted body
in place, ready to send from your mailbox.

That file route is the only way to pre-fill Outlook _and_ keep formatting. `mailto:` has
no provision for HTML — the standard does not define it and Outlook ignores any attempt —
so the second button, **Open as plain text**, launches Outlook instantly via `mailto:` but
loses the bold on the question. Both are offered because the trade is real: one is
instant, the other keeps the formatting. **Copy instead** is still there as a third
option.

Two details make Outlook treat the file as a draft rather than as received mail: the
`X-Unsent: 1` header, which is the documented flag for exactly this, and the absence of a
`From` header, so Outlook fills in your own mailbox. Without them you would get a
read-only message you had to forward.

If Windows opens `.eml` files in something other than Outlook, set Outlook as the default
for that extension once (right-click any `.eml` → Open with → Choose another app → Always).

Logging is now a checkbox next to the buttons, ticked by default, so all three routes
record the send the same way.

## Editing the templates

**Administration → Follow-up emails.** Every template lists its step, subject, when to
send, and how many times it has gone out. Edit any of them, or **+ New template**.

The body is plain text with two rules: a blank line starts a new paragraph, and a
paragraph wrapped in `**double asterisks**` is the one bolded question. A live preview
below the field shows the result as you type. The greeting and sign-off are added
automatically, so they are not in the field.

Plain text rather than a rich-text editor is deliberate: one unclosed tag in an HTML field
is a broken customer email that nobody notices until after it has gone.

Placeholders: `[First Name]`, `[Customer]`, `[Proposal Number]`, `[Proposal]`, `[Sender]`.

Three guardrails worth knowing:

- **The key freezes once a template has been sent.** The send history refers to it, so
  renaming it would orphan those lines. Change the name instead — that is free.
- **Retire, not delete.** A built-in, or anything that has been sent, is switched off
  rather than removed, because history that resolves to nothing is a worse record than
  history that resolves to something retired. An unused custom template deletes properly.
- **Reset** puts a built-in back to the wording it shipped with, for when an edit has gone
  somewhere you did not intend.

Editing requires the same permission as the pricing formulas (`rules:manage`) — it changes
what every rep sends.

## Step numbers

The step decides the order in the picker, and the order carries weight: financing appears
at 6 only after 5 has established that budget is the obstacle, and 9 opens the door to a
concession only when the gap is known to be small. If you insert a new email mid-sequence,
give it the step it belongs at and renumber the ones after it.

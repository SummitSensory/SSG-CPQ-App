# Customer portal invite: Manufacturing Process board

When a row on the Manufacturing Process board has its trigger status
(`color_mm547f1s`) set to **Send Invite**, the portal invite status
(`color_mm5427cr`) is set to **Send Invite**.

Files: `src/integrations/monday/portalInvite.ts` (new),
`src/integrations/monday/webhookRegistration.ts`, `src/routes/integrations.ts`,
`src/routes/cron.ts`, `src/config/env.ts`.

No migration. Attempts are recorded in `IntegrationSyncLog` under entity
`monday-portal-invite`, which already exists.

---

## Why this is code and not a monday recipe

monday does this natively: _when status changes to Send Invite, change status to
Send Invite_. Build that recipe too — it is faster than a webhook round trip and it
works when this deployment is down.

What a native recipe cannot do is tell you it did not run. Three things make it not
run, and all three fail by doing nothing:

- **An automation firing another automation is suppressed.** If anything else on the
  board writes the trigger column — an integration, a mirror, another recipe — the
  chain stops there. monday does not report it.
- **A renamed or reordered label.** The recipe holds a label id. Rename it and the
  recipe still fires, writing a label the portal is not watching.
- **A monday incident during the click.** The event is gone; nothing retries it.

The first report of any of those is a customer who never got an invite. So this path
logs every attempt and re-checks the board nightly. Belt and braces: run both, and
the second one to arrive finds the column already correct and writes nothing.

## What it does

Two webhook subscriptions on the Manufacturing board, `create_item` and
`change_column_value`. Both are needed for the same reason the delivery board needs
both: a row is created and its status is set a moment later, so the create event
carries no status at all.

Every event re-reads the row. The **board is the idempotency key** — an item whose
invite column already says Send Invite is left alone — which makes a redelivered
webhook free and still lets a deliberate re-invite fire (clear the invite column,
set the trigger again).

Three refusals worth knowing about:

- **The label must already exist on `color_mm5427cr`.** The labels are read before
  the write. Writing with `create_labels_if_missing` would invent a second "Send
  Invite" that the portal is not watching — that looks like success and sends
  nothing. A missing label is reported as `label-missing` with the remedy in words.
- **The trigger and invite columns must be different columns.** Same column is a
  loop; `isPortalInviteConfigured()` returns false and nothing fires.
- **An event naming any other column costs no monday call.** Every column on the
  board posts here; the handler returns `ignored` before touching the API.

## Turning it on

1. **Add the label first.** `color_mm5427cr` → column settings → Edit Labels →
   confirm **Send Invite** exists, spelled exactly. Nothing else works until it
   does.
2. Deploy. No migration, no new required environment variable.
3. Register the subscriptions:

   ```bash
   curl -X POST ".../integrations/monday/webhooks/sync?dryRun=true"   # report
   curl -X POST ".../integrations/monday/webhooks/sync"               # register
   curl ".../integrations/monday/webhooks"                            # ready=true
   ```

   Needs `PUBLIC_BASE_URL`. Idempotent, and the daily cron re-asserts it.

4. Check `GET /integrations/monday/portal-invite`. `configured: true` and
   `labelOnColumn: true` are the two that matter.
5. Test on one throwaway row: set the trigger to Send Invite, confirm the invite
   column follows within a few seconds, then confirm the attempt appears in
   `GET /integrations/monday/portal-invite` as `set`.

## Operating it

|                                                          |                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /integrations/monday/portal-invite`                 | Config, whether the label exists, recent attempts           |
| `POST /integrations/monday/portal-invite/apply/:itemId`  | Fire one row by hand. `?force=true` skips the trigger check |
| `POST /integrations/monday/portal-invite/sweep`          | Fix every row the board says is waiting                     |
| `POST /integrations/monday/portal-invite/refresh-labels` | After editing the labels in monday                          |

Outcomes: `set`, `already-set`, `not-triggered`, `ignored`, `label-missing`,
`failed`, `notfound`, `unconfigured`. Only the ones that mean something are logged —
`not-triggered` and `ignored` are the overwhelming majority of this board's traffic
and logging them would bury the rest.

The daily cron (`POST /cron/portal-delivery`, 13:00 UTC) sweeps up to 500 rows and
writes at most 25 per run. A quiet day is one board read and no writes.

## Configuration

All optional. Unset, the live board and column ids are used.

| Variable                        | Default          |
| ------------------------------- | ---------------- |
| `MONDAY_MANUFACTURING_BOARD_ID` | `6533700776`     |
| `MONDAY_MFG_TRIGGER_COLUMN`     | `color_mm547f1s` |
| `MONDAY_MFG_INVITE_COLUMN`      | `color_mm5427cr` |
| `MONDAY_INVITE_TRIGGER_LABEL`   | `Send Invite`    |
| `MONDAY_INVITE_LABEL`           | `Send Invite`    |

A board or column rebuilt in monday is a config change, not a deploy.

## What this does not do

It sets a status column. It does not send the invite email — that is still the
portal's own automation off `color_mm5427cr`, and if that leg fails, this integration
reports success because from its side the write landed. If invites need to be
observable end to end, the next step is the CRM sending them, which is the argument
in `portal-delivery.md` §7.

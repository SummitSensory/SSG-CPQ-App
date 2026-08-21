# Enhancement queue

Requested, not yet built. Newest first. Each entry records what was asked for, why,
and what it touches — enough to start from without re-interviewing.

---

## 1. Project ID in customer selection, and search by project ID

**Requested** 21 Aug 2026. **Status** queued.

### What

Two changes to the customer picker in the **New proposal** dialog:

1. Show the monday Project ID next to the customer's name in the search results and in
   the selected-organization dropdown.
2. Let the search field match on Project ID, not only on the customer name.

### Why

One customer can have several concurrent orders — Jackson County Intermediate School
District is the live example — and each is a different Project ID. Picking the
customer by name alone gives the rep no way to tell which project they are attaching
the proposal to, and the Project ID is not just a label: it is the reference the
freight request is raised against, the number that prints on the customer's document,
and the id an RFQ quotes. Attaching a proposal to the wrong one is discovered late and
is awkward to unpick.

### Where it goes

The dialog is the `New proposal` modal in `public/app.js` — the organization
`<input>` plus the `<select>` under it, and the "Not listed? Find a customer in
monday" affordance beside them.

- Project ID already resolves for a proposal via `src/crm/projectId.ts` and
  `DEAL_COL.projectId` (`pulse_id_mm5kc9f8`, an Item ID column, so its value IS the
  monday item id).
- `Opportunity.mondayItemId` is the existing local link between an organization and a
  deal row.
- The customer search endpoint behind that dialog needs to return the project ids per
  organization and to match on them.

### Open questions to settle before building

- **One customer, several project ids** — does the picker list the customer once with
  all its project ids shown, or once per project id? The second is probably what the
  rep wants (they are choosing a project, not a customer), but it changes what
  "organization" means on the created proposal.
- **Where the id comes from** — the local `Opportunity` rows, or a live monday read?
  Local is fast and works offline; live is current. Probably local with a refresh, the
  same shape as the freight pull.
- **Closed projects** — should a project id whose deal is closed still be offered, and
  if so marked as such?
- Should the same treatment apply to the **proposals list search** at the top of the
  screen ("Search customer, title, number…"), which has the same ambiguity?

### Size

Small-to-medium. The data is already in the database; most of the work is the endpoint
returning it and the picker rendering two lines per row instead of one.

---

_Nothing else queued._

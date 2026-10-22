# Proposal clarity pages: "What's Included" and "Before You Sign"

Two optional pages on a Summit Adventure Series proposal.

- **What's Included** prints immediately before the itemized pricing. It decodes the model code and lists the components, safety items and padding on the proposal.
- **Before You Sign** prints immediately before the Acceptance page. It shows the total, the deposit, what is not included, and what happens after signing.

Each page is always exactly one letter-size sheet. Each carries the standard running header and footer, and its footer names the page, e.g. "What's Included · Page 1 of 6". The pages appear wherever the proposal does: preview, print, Save PDF, the monday file and the DocuSeal package. All of these come from the same document HTML.

## Where the content comes from

| What                      | Source                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model code and its pieces | The code the proposal prints on its itemized heading, read by `decodeFrameCode` in `src/proposals/clarityPages.ts` with the convention that wrote it. A code from before dimensions were in the code (`R-2MBL1Z`) prints with the frame size added: `R-2MBL1Z-10x8`. |
| Frame length and width    | The configurator's Frame Dimensions (`meta.advAnswers`).                                                                                                                                                                                                             |
| Interior beam count       | Exactly as the code prints it. Nothing about how beams are counted has changed.                                                                                                                                                                                      |
| Components                | A component shows when any of its listed part numbers is on the proposal with a quantity.                                                                                                                                                                            |
| Mat row                   | Mat size from the floor mat's part number (`R-SSG-1008CLM` → 10' × 8' × 3.25"). Column wraps are the quantities of `SSUSP67` and `SSCW67`. Ladder wraps are the quantity of `SSUSP72`.                                                                               |
| Total and deposit         | The document's own `docTotal` and `docDeposit`, the same figures the pricing totals and the Acceptance line print. Nothing is recalculated. The deposit note uses the proposal's deposit percentage. With "Show the deposit" off, only the total is shown.           |
| Preparer                  | The same person as "Proposal Prepared By": name, title, phone and email from their user record.                                                                                                                                                                      |
| Wording                   | The frame naming convention's `page` block (below).                                                                                                                                                                                                                  |

## Editing the naming convention and the wording

Go to **Administration → Proposals → Frame naming**. Only a system admin can open it.

The top half is the code itself: segment order, shape codes, each feature's letter, when its quantity prints, and feature order. The section **Proposal pages: What's Included and Before You Sign** holds everything the pages say:

- **Frame row**: the frame name, label and description for each shape, the dimensions spec, the height options, the label under the dimensions, the icon and the page order.
- **Code features**: for each feature, its name, the label under the code, the description, the spec (and a spec used when the count is over one), the icon and the page order. Page order can differ from the order in the code.
- **Components**: key, name, description, the part numbers that include it, more specific descriptions keyed to part numbers (one per line: `150045, A-2349 | Steamroller ramp with the scooter board conversion kit.`), spec, icon, page order and active.
- **Mat system row**.
- **What's Not Included**: in print order. Each item has a key, title, description, an optional "hide when a line contains" (e.g. `install`), a placeholder flag and active.
- **What Happens Next**: up to 6 steps. Each can carry a sentence that is added when mats are on the proposal.
- **Page text**: every heading, intro and note on both pages.

Templates take `{count}`, `{s}` (an "s" when the count is not 1), `{kind}` (Dual/Single for the trolley), `{length}`, `{width}`, plus `{heights}` in the frame note and `{pct}` in the deposit note.

As you edit, the preview shows the sample codes and the first sample's What's Included rows. A save is refused if a code could be read two ways, if two rows share a page order, if a key repeats, or if a required name is empty.

**Saving creates a new version. Nothing is ever edited in place.**

## Versioning: what changes and what never does

- A draft's pages are recomputed whenever its model code or lines change, and always before it is previewed, printed or saved. The result is stored on the version as `meta.clarityPages.snapshot`.
- The document only ever prints that snapshot. A released version is frozen and can no longer be saved, so it keeps the pages it was released with, whatever the convention says later.
- A code is read by the newest convention version it fits, so a code named before a letter change still reads by its own version's letters and wording.
- New proposals have both pages on. A proposal saved before this feature has them off when it is reopened. Turning a page on, or hiding one What's Not Included item on one proposal, is saved on that version and carried into revisions.

## Builder

Adventure Series proposals (those with configurator answers) get a **Customer clarity pages** card with the following:

- the two toggles;
- the model code and naming version the pages were read with;
- a checkbox per What's Not Included item, to hide it on this proposal only;
- a note listing any wording still marked as a placeholder.

If the itemized heading has been retyped so that it no longer reads as a frame code, the card says so and neither page prints.

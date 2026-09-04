/**
 * Proposal follow-up email templates.
 *
 * Ten emails, in the order a stalling deal actually moves through: an easy opening
 * question, then clarification, then the vision, then the approval process, then money,
 * then timing, then candour, then permission to pause. The sequence is deliberate —
 * email 6 introduces financing only after email 5 has established that budget is the real
 * obstacle, and email 9 opens the door to a concession only when the gap is known to be
 * small. Sending them out of order wastes the ones that follow.
 *
 * These are the SEED. Once the app has run, the templates live in the FollowUpTemplate
 * table and are edited under Administration → Follow-up emails; this array is only read
 * to populate an empty table, and to restore a built-in someone has edited into a corner.
 * Editing a sentence should not require a deploy.
 *
 * They are one-to-one emails from a person, so the markup is deliberately plain: no logo,
 * no header band, no buttons. A follow-up that looks like a marketing blast gets read as
 * one, and the whole point of email 1 is that it is easy to reply to. What the HTML buys
 * is correct paragraph spacing and one bolded question per email.
 */

import { esc, firstNameOf } from './textHelpers.js';

export { firstNameOf };

/** The ten as shipped. Body format: blank line between paragraphs, **the question**. */
export const DEFAULT_FOLLOW_UP_TEMPLATES: FollowUpTemplateData[] = [
  {
    key: 'initial-reaction',
    name: 'Initial Reaction',
    step: 1,
    whenToSend: '2–3 business days after sending the proposal',
    objective: 'Get the easiest possible response.',
    angle: 'Collaboration, not closing.',
    subject: 'Summit Sensory Gym | What Are Your Initial Thoughts?',
    body: 'I wanted to follow up now that you’ve had a little time to review the proposal and design recommendations we prepared for your space.\n\nBefore we get too far into next steps, I’d really value your initial reaction.\n\n**Does the proposed design feel aligned with what you were hoping to create?**\n\nIf there are elements you really like, areas you’d like us to reconsider, or questions that came up while reviewing everything, please send them my way.\n\nAt this stage, our priority is making sure we’ve captured your vision correctly and that the proposed sensory therapy environment supports your clinicians, the individuals you serve, and the long-term goals of your organization.\n\nI’d love to hear what stood out to you when you reviewed the proposal.',
  },
  {
    key: 'clarify-proposal',
    name: 'Clarify the Proposal',
    step: 2,
    whenToSend: '4–5 business days later if there is no response',
    objective: 'Make asking questions easy.',
    angle: 'Expertise and transparency.',
    subject: 'Summit Sensory Gym | What Can We Help Clarify?',
    body: 'I wanted to reconnect regarding the sensory therapy gym proposal we recently shared.\n\nOnce a team begins reviewing the design, equipment, pricing, and implementation details, it’s completely normal for additional questions to surface.\n\nIf there’s anything you’d like us to explain in more detail—even something as simple as why we recommended one component over another—please don’t hesitate to ask.\n\nWe want your team to clearly understand what we’re proposing, how the different elements work together, and why we believe the design is appropriate for your space.\n\n**Is there anything I can help clarify?**',
  },
  {
    key: 'reconnect-vision',
    name: 'Reconnect Them to the Vision',
    step: 3,
    whenToSend: 'Customer was engaged with design but has gone quiet',
    objective: 'Shift attention from line-item pricing back to the outcome.',
    angle: 'Transformation and clinical functionality.',
    subject: 'Summit Sensory Gym | Does the Design Reflect Your Vision?',
    body: 'I’ve been thinking about the sensory therapy gym we designed for your organization and wanted to ask one important question:\n\n**Does the proposed design feel like the environment you envisioned creating?**\n\nPricing and equipment selections are obviously important, but before focusing exclusively on those details, I want to make sure we’ve captured the larger vision correctly.\n\nIf you’d like us to reconsider the layout, frame configuration, equipment selection, safety features, or how the room will ultimately function for your team, we’re happy to continue refining the concept.\n\nOur best projects are highly collaborative, and your feedback is an important part of getting the design right.\n\nI’d really appreciate hearing your thoughts.',
  },
  {
    key: 'approval-process',
    name: 'Understand the Approval Process',
    step: 4,
    whenToSend: 'You suspect more people are involved',
    objective: 'Identify decision-makers and procurement barriers.',
    angle: 'Make their internal job easier.',
    subject: 'Summit Sensory Gym | How Can We Support Your Internal Review?',
    body: 'I wanted to check in regarding the proposal and better understand where the project currently stands within your organization.\n\n**Are there additional stakeholders who need to review or approve the project before you’re able to move forward?**\n\nIf so, we’re happy to help make that process easier. We can provide updated renderings, equipment specifications, safety information, revised pricing, supporting documentation, or participate in a brief conversation with the broader team.\n\nIf I understand what the next internal step looks like, I can make sure we’re providing you with information that’s actually helpful rather than simply continuing to follow up.\n\nWhat would be most useful from us at this stage?',
  },
  {
    key: 'investment-expectation',
    name: 'Determine Whether Cost Is Actually the Issue',
    step: 5,
    whenToSend: 'There are indications the investment may be creating hesitation',
    objective: 'Surface the real financial objection.',
    angle: 'Flexibility without immediately discounting.',
    caution:
      'The first email where financing is worth considering — but only if they reply that budget or cash flow is the issue.',
    subject: 'Summit Sensory Gym | Is the Investment Where You Expected It to Be?',
    body: 'I wanted to follow up regarding the proposal and ask a question that may help us determine the most appropriate next step.\n\n**Is the overall project investment within the range you anticipated?**\n\nIf not, please feel comfortable sharing that with me. Understanding the investment level your organization is trying to work within gives us an opportunity to evaluate the project more strategically.\n\nBecause our sensory therapy gyms are highly configurable and expandable, there are often several ways to approach a project without compromising the long-term vision. In some cases, that may involve adjusting equipment selections, phasing certain components over time, or exploring alternative purchasing options.\n\nIf the current proposal isn’t quite where it needs to be, I’d rather understand that and see whether there’s a reasonable path forward.\n\nWould it be helpful to discuss the investment in more detail?',
  },
  {
    key: 'financing-phasing',
    name: 'Financing / Phased Implementation',
    step: 6,
    whenToSend:
      'Customer likes the project but says cash flow, capital availability, or budget timing is the obstacle',
    objective: 'Preserve the desired solution instead of immediately reducing scope.',
    angle: 'Make the project financially achievable.',
    caution: 'Attach the financing options sheet when you send this one.',
    subject: 'Summit Sensory Gym | There May Be Another Way to Structure the Project',
    body: 'Thank you for sharing the additional context around the budget.\n\nBefore we begin removing elements from the design, I wanted to make sure you’re aware that there may be other ways to structure the project.\n\nFor qualified U.S.-based organizations, Summit Sensory Gym offers financing options that can allow the cost of the project to be spread over time rather than requiring the full capital expenditure upfront.\n\nDepending on your organization’s priorities, we can also explore a phased approach—installing the core sensory therapy gym now while designing the system so additional equipment and accessories can be incorporated as budgets become available.\n\nMy preference is always to first determine whether there’s a way to preserve the therapy environment your team actually wants before compromising the design simply because of the timing of the expenditure.\n\n**Would you like me to provide information on the financing options, a phased configuration, or both?**',
  },
  {
    key: 'timeline',
    name: 'Timeline',
    step: 7,
    whenToSend: 'Interest remains high but timing is unclear',
    objective: 'Determine whether the deal is delayed or stalled.',
    angle: 'Planning and operational support.',
    subject: 'Summit Sensory Gym | What Timeline Are You Working Toward?',
    body: 'As we continue thinking about your proposed sensory therapy gym, I wanted to get a better understanding of your ideal timeline.\n\n**Are you still hoping to move forward within the timeframe we originally discussed, or have priorities shifted?**\n\nWhether you’re working toward a clinic opening, construction completion, school year, fiscal deadline, board approval, or another milestone, knowing that timing helps us plan manufacturing and delivery appropriately.\n\nAnd if the project has simply moved further into the future, that’s completely fine as well. I’d rather understand your timeline and follow up appropriately than create unnecessary pressure.\n\nWhat does the ideal timeline look like from your perspective?',
  },
  {
    key: 'whats-holding-it-back',
    name: 'Ask What Is Actually Preventing the Sale',
    step: 8,
    whenToSend: 'You’ve received limited feedback after multiple contacts',
    objective: 'Get candor.',
    angle: 'Respect and problem-solving.',
    subject: 'Summit Sensory Gym | Is Anything Holding the Project Back?',
    body: 'Rather than continue guessing where things stand, I wanted to ask you directly:\n\n**Is there anything specific preventing the sensory therapy gym project from moving forward right now?**\n\nIt could be budget, timing, funding, internal approval, construction, questions about the design, competing priorities, or simply that the project has been placed on hold.\n\nWhatever the situation may be, please feel comfortable being candid with me.\n\nIf there is an obstacle we can help address, we’d certainly appreciate the opportunity to do so. If the timing simply isn’t right, knowing that allows us to respect your process and reconnect at a more appropriate time.\n\nEven a brief update would be greatly appreciated.',
  },
  {
    key: 'strategic-pricing',
    name: 'Strategic Pricing Conversation',
    step: 9,
    whenToSend:
      'Only when you know the customer wants the project and a relatively small financial gap is genuinely preventing the close',
    objective: 'Resolve the final obstacle without devaluing the product.',
    angle: 'Partnership and justified flexibility.',
    caution:
      'Where a project credit, multi-location incentive, manufacturing credit, value-add or modest discount could become appropriate.',
    subject: 'Summit Sensory Gym | Let’s See If We Can Find a Path Forward',
    body: 'Thank you for being open with me about where things stand.\n\nBased on our conversations, it sounds like there is genuine interest in moving forward and that we’re reasonably close to finding a structure that works for both organizations.\n\nBefore we make any significant changes to the design, I’d like to take one more look internally at the project and determine whether there are any opportunities for us to help bridge the remaining gap.\n\nThat could potentially involve adjusting certain equipment selections, coordinating the project with an upcoming manufacturing cycle, exploring a phased purchase, or identifying another reasonable way to create additional value.\n\nI don’t want to make assumptions about what would be most helpful, so let me ask directly:\n\n**What would need to change for your team to feel comfortable moving forward?**\n\nIf you can give me a better understanding of that, I’ll see what we can reasonably do from our side.',
  },
  {
    key: 'permission-to-pause',
    name: 'Permission to Pause',
    step: 10,
    whenToSend: 'Multiple attempts have gone unanswered',
    objective: 'Get closure without sounding like a stereotypical sales breakup email.',
    angle: 'Respect.',
    subject: 'Summit Sensory Gym | Should We Pause the Project for Now?',
    body: 'I know priorities and timelines can change, so I wanted to reach out before continuing to follow up regarding your sensory therapy gym project.\n\n**Would it make sense for us to pause the project for now?**\n\nIf you’re still interested but simply need additional time, that’s completely understandable. I’m happy to make a note to reconnect at a more appropriate point.\n\nIf the project is still actively moving forward, just let me know where things currently stand and whether there’s anything you need from our team.\n\nEither way, a quick update would help me make sure we’re supporting you appropriately and respecting your timeline.\n\nWe remain excited about the possibility of working together whenever the timing is right.',
  },
];

export function defaultTemplateByKey(key: string): FollowUpTemplateData | undefined {
  return DEFAULT_FOLLOW_UP_TEMPLATES.find((t) => t.key === key);
}

export interface FollowUpContext {
  /** Recipient's first name. Falls back to "there" rather than printing a blank. */
  firstName: string;
  /** The sender's first name, for the sign-off. */
  senderFirstName: string;
  customerName?: string;
  proposalNumber?: string;
  proposalTitle?: string;
}

/** A template as stored, whether it came from the seed or from an edit in the app. */
export interface FollowUpTemplateData {
  key: string;
  name: string;
  step: number;
  whenToSend: string;
  objective: string;
  angle: string;
  caution?: string | null;
  subject: string;
  /**
   * Plain text. A blank line starts a new paragraph; a paragraph wrapped in
   * **asterisks** is the one bolded question.
   */
  body: string;
}

/**
 * Substitute the placeholders a template may carry.
 *
 * Only these five. A template reaching for anything else would silently print an empty
 * string into a customer email, which is worse than not offering the field at all.
 */
function fill(text: string, ctx: FollowUpContext): string {
  return String(text ?? '')
    .replace(/\[First Name\]/g, ctx.firstName)
    .replace(/\[Customer\]/g, ctx.customerName ?? '')
    .replace(/\[Proposal Number\]/g, ctx.proposalNumber ?? '')
    .replace(/\[Proposal\]/g, ctx.proposalTitle ?? '')
    .replace(/\[Sender\]/g, ctx.senderFirstName);
}

export interface BodyParagraph {
  text: string;
  /** The one question the email exists to get answered. Rendered bold, on its own. */
  ask: boolean;
}

/**
 * Read the editable body format.
 *
 * Blank line between paragraphs, **asterisks** around the question. Chosen over storing
 * HTML because this is a field a salesperson edits in a textarea: one unclosed tag in
 * HTML is a broken customer email that nobody notices until after it has gone. Single
 * newlines inside a paragraph are kept as line breaks, which is what someone typing an
 * address block or a short list expects.
 */
export function parseBody(body: string): BodyParagraph[] {
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const ask = /^\*\*[\s\S]+\*\*$/.test(chunk);
      return { text: ask ? chunk.replace(/^\*\*|\*\*$/g, '').trim() : chunk, ask };
    });
}

/** The reverse, for seeding the table from the templates written in this file. */
export function toBody(paragraphs: Array<string | { ask: string }>): string {
  return paragraphs.map((p) => (typeof p === 'string' ? p : `**${p.ask}**`)).join('\n\n');
}

/**
 * Paragraph margins are inline on every element and the font is on a wrapping div.
 *
 * Outlook applies its own defaults to bare elements and strips a <style> block, so
 * anything not written inline is lost by the time the message is composed. 11pt Calibri
 * after the system stack is Outlook's own default size — the email should look like the
 * rep typed it, not like it arrived from a system.
 *
 * ONE block element for the whole message, paragraphs separated by <br><br>, and this is
 * the reason: Outlook inserts the rep's default signature into an X-Unsent draft after
 * the FIRST block-level child of the body. With a <p> per paragraph that put the
 * signature directly under "Hi Vanessa," and left the rest of the email below it. There
 * is no header or flag that moves it — the placement follows from the markup — so the
 * message is emitted as a single block whose end is the end of the email, which is where
 * a signature belongs. Blank-line spacing comes from the double <br> instead of a
 * paragraph margin; Outlook renders the two the same.
 */
const WRAP =
  "font-family:-apple-system,'Segoe UI',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#000000;";

export interface RenderedFollowUp {
  subject: string;
  /** For the .eml draft and the on-screen preview. */
  html: string;
  /** For the mailto: draft and any client that refuses HTML. */
  text: string;
}

export function renderFollowUp(
  template: FollowUpTemplateData,
  ctx: FollowUpContext,
): RenderedFollowUp {
  const greeting = `Hi ${ctx.firstName},`;
  const paragraphs = parseBody(template.body);

  // Every visible line of the email, in order, as inline HTML. Joined with <br><br> so
  // the whole thing is one block element — see WRAP above for why that matters.
  const blocks = [
    esc(greeting),
    ...paragraphs.map((p) => {
      const inner = esc(fill(p.text, ctx)).replace(/\n/g, '<br>');
      return p.ask ? `<strong>${inner}</strong>` : inner;
    }),
    `Best,<br>${esc(ctx.senderFirstName)}`,
  ];

  const html = `<div style="${WRAP}">${blocks.join('<br><br>')}</div>`;

  const text = [
    greeting,
    '',
    ...paragraphs.flatMap((p) => [fill(p.text, ctx), '']),
    'Best,',
    ctx.senderFirstName,
  ].join('\n');

  return { subject: fill(template.subject, ctx), html, text };
}

/**
 * Build an .eml draft.
 *
 * This is what makes "open it in Outlook already filled in" possible WITH formatting.
 * A mailto: URL cannot carry HTML — the standard has no provision for it and Outlook
 * ignores any attempt — so the choice is a plain-text mailto or a real MIME message.
 * An .eml opens in Outlook as a message with the recipient, subject and formatted body
 * already in place.
 *
 * Two details that make Outlook treat it as a DRAFT rather than as received mail:
 * X-Unsent: 1, which is the documented flag for exactly this, and the absence of a From
 * header, so Outlook fills in the signed-in mailbox. Get either wrong and the rep gets a
 * read-only message they have to forward.
 *
 * Body parts are quoted-printable because a proposal email contains em dashes and curly
 * quotes, and 8-bit content in an .eml renders as mojibake in Outlook often enough to be
 * not worth risking.
 */
export function buildEml(input: {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
}): string {
  const boundary = `----=_SSG_${Date.now().toString(36)}`;
  const to = input.toName ? `${encodeHeader(input.toName)} <${input.to}>` : input.to;
  return [
    'MIME-Version: 1.0',
    `To: ${to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'X-Unsent: 1',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(input.text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(`<!doctype html><html><body>${input.html}</body></html>`),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** RFC 2047 for a header that may hold a non-ASCII name or a curly apostrophe. */
function encodeHeader(value: string): string {
  const v = String(value ?? '');

  if (!/[^\x20-\x7E]/.test(v)) return v;
  const b64 = Buffer.from(v, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** Quoted-printable with the 76-character soft line breaks the encoding requires. */
function quotedPrintable(input: string): string {
  const bytes = Buffer.from(String(input ?? '').replace(/\r\n/g, '\n'), 'utf8');
  let line = '';
  const out: string[] = [];
  const push = (token: string) => {
    if (line.length + token.length > 73) {
      out.push(`${line}=`);
      line = '';
    }
    line += token;
  };
  for (const byte of bytes) {
    if (byte === 0x0a) {
      out.push(line);
      line = '';
      continue;
    }
    const printable = (byte >= 0x20 && byte <= 0x3c) || (byte >= 0x3e && byte <= 0x7e);
    push(
      printable
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    );
  }
  out.push(line);
  return out.join('\r\n');
}

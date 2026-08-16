/**
 * Proposal follow-up email templates.
 *
 * Ten emails, in the order a stalling deal actually moves through: an easy opening
 * question, then clarification, then the vision, then the approval process, then
 * money, then timing, then candour, then permission to pause. The sequence is
 * deliberate — email 6 introduces financing only after email 5 has established that
 * budget is the real obstacle, and email 9 opens the door to a concession only when
 * the gap is known to be small. Sending them out of order wastes the ones that
 * follow.
 *
 * These are one-to-one emails from a person, so the markup is deliberately plain: no
 * logo, no header band, no buttons. A follow-up that looks like a marketing blast
 * gets read as one, and the whole point of email 1 is that it is easy to reply to.
 * What the HTML buys is correct paragraph spacing and one bolded question per email,
 * which is what survives a paste into Outlook.
 *
 * The copy is the approved wording. Placeholders are substituted; nothing else is
 * rewritten at render time.
 */

/** Values a template can interpolate. Everything is optional but the first name. */
export interface FollowUpContext {
  /** Recipient's first name. Falls back to "there" rather than printing a blank. */
  firstName: string;
  /** The sender's first name, for the sign-off. */
  senderFirstName: string;
  customerName?: string;
  proposalNumber?: string;
  proposalTitle?: string;
}

export interface FollowUpTemplate {
  key: string;
  /** Shown in the picker. */
  name: string;
  /** Position in the sequence, 1-10. */
  step: number;
  /** When to send it — guidance for the rep, never sent to the customer. */
  whenToSend: string;
  objective: string;
  /** Why the email is written the way it is. */
  angle: string;
  subject: string;
  /**
   * Body paragraphs. A string is an ordinary paragraph; `{ ask: … }` is the one
   * question the email exists to get answered, and renders bold on its own line.
   */
  paragraphs: Array<string | { ask: string }>;
  /** Shown in the picker as a caution, not sent. */
  caution?: string;
}

const P = (...paragraphs: Array<string | { ask: string }>) => paragraphs;

export const FOLLOW_UP_TEMPLATES: FollowUpTemplate[] = [
  {
    key: 'initial-reaction',
    name: 'Initial Reaction',
    step: 1,
    whenToSend: '2–3 business days after sending the proposal',
    objective: 'Get the easiest possible response.',
    angle: 'Collaboration, not closing.',
    subject: 'Summit Sensory Gym | What Are Your Initial Thoughts?',
    paragraphs: P(
      'I wanted to follow up now that you\u2019ve had a little time to review the proposal and design recommendations we prepared for your space.',
      'Before we get too far into next steps, I\u2019d really value your initial reaction.',
      { ask: 'Does the proposed design feel aligned with what you were hoping to create?' },
      'If there are elements you really like, areas you\u2019d like us to reconsider, or questions that came up while reviewing everything, please send them my way.',
      'At this stage, our priority is making sure we\u2019ve captured your vision correctly and that the proposed sensory therapy environment supports your clinicians, the individuals you serve, and the long-term goals of your organization.',
      'I\u2019d love to hear what stood out to you when you reviewed the proposal.',
    ),
  },
  {
    key: 'clarify-proposal',
    name: 'Clarify the Proposal',
    step: 2,
    whenToSend: '4–5 business days later if there is no response',
    objective: 'Make asking questions easy.',
    angle: 'Expertise and transparency.',
    subject: 'Summit Sensory Gym | What Can We Help Clarify?',
    paragraphs: P(
      'I wanted to reconnect regarding the sensory therapy gym proposal we recently shared.',
      'Once a team begins reviewing the design, equipment, pricing, and implementation details, it\u2019s completely normal for additional questions to surface.',
      'If there\u2019s anything you\u2019d like us to explain in more detail\u2014even something as simple as why we recommended one component over another\u2014please don\u2019t hesitate to ask.',
      'We want your team to clearly understand what we\u2019re proposing, how the different elements work together, and why we believe the design is appropriate for your space.',
      { ask: 'Is there anything I can help clarify?' },
    ),
  },
  {
    key: 'reconnect-vision',
    name: 'Reconnect Them to the Vision',
    step: 3,
    whenToSend: 'Customer was engaged with design but has gone quiet',
    objective: 'Shift attention from line-item pricing back to the outcome.',
    angle: 'Transformation and clinical functionality.',
    subject: 'Summit Sensory Gym | Does the Design Reflect Your Vision?',
    paragraphs: P(
      'I\u2019ve been thinking about the sensory therapy gym we designed for your organization and wanted to ask one important question:',
      { ask: 'Does the proposed design feel like the environment you envisioned creating?' },
      'Pricing and equipment selections are obviously important, but before focusing exclusively on those details, I want to make sure we\u2019ve captured the larger vision correctly.',
      'If you\u2019d like us to reconsider the layout, frame configuration, equipment selection, safety features, or how the room will ultimately function for your team, we\u2019re happy to continue refining the concept.',
      'Our best projects are highly collaborative, and your feedback is an important part of getting the design right.',
      'I\u2019d really appreciate hearing your thoughts.',
    ),
  },
  {
    key: 'approval-process',
    name: 'Understand the Approval Process',
    step: 4,
    whenToSend: 'You suspect more people are involved',
    objective: 'Identify decision-makers and procurement barriers.',
    angle: 'Make their internal job easier.',
    subject: 'Summit Sensory Gym | How Can We Support Your Internal Review?',
    paragraphs: P(
      'I wanted to check in regarding the proposal and better understand where the project currently stands within your organization.',
      {
        ask: 'Are there additional stakeholders who need to review or approve the project before you\u2019re able to move forward?',
      },
      'If so, we\u2019re happy to help make that process easier. We can provide updated renderings, equipment specifications, safety information, revised pricing, supporting documentation, or participate in a brief conversation with the broader team.',
      'If I understand what the next internal step looks like, I can make sure we\u2019re providing you with information that\u2019s actually helpful rather than simply continuing to follow up.',
      'What would be most useful from us at this stage?',
    ),
  },
  {
    key: 'investment-expectation',
    name: 'Determine Whether Cost Is Actually the Issue',
    step: 5,
    whenToSend: 'There are indications the investment may be creating hesitation',
    objective: 'Surface the real financial objection.',
    angle: 'Flexibility without immediately discounting.',
    subject: 'Summit Sensory Gym | Is the Investment Where You Expected It to Be?',
    caution:
      'The first email where financing is worth considering \u2014 but only if they reply that budget or cash flow is the issue.',
    paragraphs: P(
      'I wanted to follow up regarding the proposal and ask a question that may help us determine the most appropriate next step.',
      { ask: 'Is the overall project investment within the range you anticipated?' },
      'If not, please feel comfortable sharing that with me. Understanding the investment level your organization is trying to work within gives us an opportunity to evaluate the project more strategically.',
      'Because our sensory therapy gyms are highly configurable and expandable, there are often several ways to approach a project without compromising the long-term vision. In some cases, that may involve adjusting equipment selections, phasing certain components over time, or exploring alternative purchasing options.',
      'If the current proposal isn\u2019t quite where it needs to be, I\u2019d rather understand that and see whether there\u2019s a reasonable path forward.',
      'Would it be helpful to discuss the investment in more detail?',
    ),
  },
  {
    key: 'financing-phasing',
    name: 'Financing / Phased Implementation',
    step: 6,
    whenToSend:
      'Customer likes the project but says cash flow, capital availability, or budget timing is the obstacle',
    objective: 'Preserve the desired solution instead of immediately reducing scope.',
    angle: 'Make the project financially achievable.',
    subject: 'Summit Sensory Gym | There May Be Another Way to Structure the Project',
    caution: 'Attach the financing options sheet when you send this one.',
    paragraphs: P(
      'Thank you for sharing the additional context around the budget.',
      'Before we begin removing elements from the design, I wanted to make sure you\u2019re aware that there may be other ways to structure the project.',
      'For qualified U.S.-based organizations, Summit Sensory Gym offers financing options that can allow the cost of the project to be spread over time rather than requiring the full capital expenditure upfront.',
      'Depending on your organization\u2019s priorities, we can also explore a phased approach\u2014installing the core sensory therapy gym now while designing the system so additional equipment and accessories can be incorporated as budgets become available.',
      'My preference is always to first determine whether there\u2019s a way to preserve the therapy environment your team actually wants before compromising the design simply because of the timing of the expenditure.',
      {
        ask: 'Would you like me to provide information on the financing options, a phased configuration, or both?',
      },
    ),
  },
  {
    key: 'timeline',
    name: 'Timeline',
    step: 7,
    whenToSend: 'Interest remains high but timing is unclear',
    objective: 'Determine whether the deal is delayed or stalled.',
    angle: 'Planning and operational support.',
    subject: 'Summit Sensory Gym | What Timeline Are You Working Toward?',
    paragraphs: P(
      'As we continue thinking about your proposed sensory therapy gym, I wanted to get a better understanding of your ideal timeline.',
      {
        ask: 'Are you still hoping to move forward within the timeframe we originally discussed, or have priorities shifted?',
      },
      'Whether you\u2019re working toward a clinic opening, construction completion, school year, fiscal deadline, board approval, or another milestone, knowing that timing helps us plan manufacturing and delivery appropriately.',
      'And if the project has simply moved further into the future, that\u2019s completely fine as well. I\u2019d rather understand your timeline and follow up appropriately than create unnecessary pressure.',
      'What does the ideal timeline look like from your perspective?',
    ),
  },
  {
    key: 'whats-holding-it-back',
    name: 'Ask What Is Actually Preventing the Sale',
    step: 8,
    whenToSend: 'You\u2019ve received limited feedback after multiple contacts',
    objective: 'Get candor.',
    angle: 'Respect and problem-solving.',
    subject: 'Summit Sensory Gym | Is Anything Holding the Project Back?',
    paragraphs: P(
      'Rather than continue guessing where things stand, I wanted to ask you directly:',
      {
        ask: 'Is there anything specific preventing the sensory therapy gym project from moving forward right now?',
      },
      'It could be budget, timing, funding, internal approval, construction, questions about the design, competing priorities, or simply that the project has been placed on hold.',
      'Whatever the situation may be, please feel comfortable being candid with me.',
      'If there is an obstacle we can help address, we\u2019d certainly appreciate the opportunity to do so. If the timing simply isn\u2019t right, knowing that allows us to respect your process and reconnect at a more appropriate time.',
      'Even a brief update would be greatly appreciated.',
    ),
  },
  {
    key: 'strategic-pricing',
    name: 'Strategic Pricing Conversation',
    step: 9,
    whenToSend:
      'Only when you know the customer wants the project and a relatively small financial gap is genuinely preventing the close',
    objective: 'Resolve the final obstacle without devaluing the product.',
    angle: 'Partnership and justified flexibility.',
    subject: 'Summit Sensory Gym | Let\u2019s See If We Can Find a Path Forward',
    caution:
      'Where a project credit, multi-location incentive, manufacturing credit, value-add or modest discount could become appropriate.',
    paragraphs: P(
      'Thank you for being open with me about where things stand.',
      'Based on our conversations, it sounds like there is genuine interest in moving forward and that we\u2019re reasonably close to finding a structure that works for both organizations.',
      'Before we make any significant changes to the design, I\u2019d like to take one more look internally at the project and determine whether there are any opportunities for us to help bridge the remaining gap.',
      'That could potentially involve adjusting certain equipment selections, coordinating the project with an upcoming manufacturing cycle, exploring a phased purchase, or identifying another reasonable way to create additional value.',
      'I don\u2019t want to make assumptions about what would be most helpful, so let me ask directly:',
      { ask: 'What would need to change for your team to feel comfortable moving forward?' },
      'If you can give me a better understanding of that, I\u2019ll see what we can reasonably do from our side.',
    ),
  },
  {
    key: 'permission-to-pause',
    name: 'Permission to Pause',
    step: 10,
    whenToSend: 'Multiple attempts have gone unanswered',
    objective: 'Get closure without sounding like a stereotypical sales breakup email.',
    angle: 'Respect.',
    subject: 'Summit Sensory Gym | Should We Pause the Project for Now?',
    paragraphs: P(
      'I know priorities and timelines can change, so I wanted to reach out before continuing to follow up regarding your sensory therapy gym project.',
      { ask: 'Would it make sense for us to pause the project for now?' },
      'If you\u2019re still interested but simply need additional time, that\u2019s completely understandable. I\u2019m happy to make a note to reconnect at a more appropriate point.',
      'If the project is still actively moving forward, just let me know where things currently stand and whether there\u2019s anything you need from our team.',
      'Either way, a quick update would help me make sure we\u2019re supporting you appropriately and respecting your timeline.',
      'We remain excited about the possibility of working together whenever the timing is right.',
    ),
  },
];

export function templateByKey(key: string): FollowUpTemplate | undefined {
  return FOLLOW_UP_TEMPLATES.find((t) => t.key === key);
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const firstNameOf = (name: string | null | undefined): string =>
  String(name ?? '')
    .trim()
    .split(/\s+/)[0] || 'there';

/**
 * Substitute the placeholders a template may carry.
 *
 * Only these five. A template that reaches for anything else would silently print an
 * empty string into a customer email, which is worse than not offering the field.
 */
function fill(text: string, ctx: FollowUpContext): string {
  return text
    .replace(/\[First Name\]/g, ctx.firstName)
    .replace(/\[Customer\]/g, ctx.customerName ?? '')
    .replace(/\[Proposal Number\]/g, ctx.proposalNumber ?? '')
    .replace(/\[Proposal\]/g, ctx.proposalTitle ?? '')
    .replace(/\[Sender\]/g, ctx.senderFirstName);
}

/**
 * Paragraph margins are set on every element and the font on a wrapping div.
 *
 * Outlook applies its own defaults to bare elements and strips a <style> block on
 * paste, so anything not written inline is lost by the time the rep hits send. 11pt
 * Calibri after the system stack is Outlook's own default size — the message should
 * look like the rep typed it, not like it arrived from a system.
 */
const WRAP =
  "font-family:-apple-system,'Segoe UI',Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#000000;";
const PARA = 'margin:0 0 12pt;padding:0;';

export interface RenderedFollowUp {
  subject: string;
  /** For the clipboard's text/html flavour, and for the preview. */
  html: string;
  /** For the clipboard's text/plain flavour, and for any client that refuses HTML. */
  text: string;
}

export function renderFollowUp(template: FollowUpTemplate, ctx: FollowUpContext): RenderedFollowUp {
  const greeting = `Hi ${fill('[First Name]', ctx)},`;
  const signOff = ['Best,', ctx.senderFirstName];

  const bodyHtml = template.paragraphs
    .map((p) => {
      if (typeof p === 'string') return `<p style="${PARA}">${esc(fill(p, ctx))}</p>`;
      // The one question the email exists to get answered. Bold and alone, because a
      // question buried mid-paragraph is a question that does not get answered.
      return `<p style="${PARA}"><strong>${esc(fill(p.ask, ctx))}</strong></p>`;
    })
    .join('\n');

  const html = `<div style="${WRAP}">
<p style="${PARA}">${esc(greeting)}</p>
${bodyHtml}
<p style="${PARA}">${esc(signOff[0])}<br>${esc(signOff[1])}</p>
</div>`;

  const text = [
    greeting,
    '',
    ...template.paragraphs.flatMap((p) => [fill(typeof p === 'string' ? p : p.ask, ctx), '']),
    ...signOff,
  ].join('\n');

  return { subject: fill(template.subject, ctx), html, text };
}

/** The picker's payload: every template, its guidance, and the rendered email. */
export function renderAllFollowUps(
  ctx: FollowUpContext,
): Array<FollowUpTemplate & RenderedFollowUp> {
  return FOLLOW_UP_TEMPLATES.map((t) => ({ ...t, ...renderFollowUp(t, ctx) }));
}

export { firstNameOf };

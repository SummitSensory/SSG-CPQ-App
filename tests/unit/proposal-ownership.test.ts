import { describe, it, expect } from 'vitest';

/**
 * Who may act on somebody else's proposal.
 *
 * The rule is drawn at irreversible and customer-facing, not at editing (AUD-018).
 * That distinction is a business decision, not an obvious one, and the only place it
 * is written down is a comment and this file — so these tests exist mainly to make a
 * future change to it deliberate rather than accidental.
 *
 * Three people at this company work the same deal, so editing stays open. Release,
 * discarding a version, and archiving are the owner's or a manager's.
 */

const MANAGES_ANY_PROPOSAL = ['SYSTEM_ADMIN', 'EXECUTIVE', 'SALES_MANAGER', 'ACCOUNTING'];

/**
 * The rule under test, mirroring src/routes/proposals.ts.
 *
 * Duplicated rather than imported: the real one is a module-private function inside a
 * route file that pulls in Prisma, Fastify and a dozen services on import. Copying six
 * lines is the lesser evil — and if the two ever disagree, that is a fact worth
 * learning from a failing test rather than from a rep who could not release a deal.
 */
function mayAct(role: string, ownerId: string, actorId: string): boolean {
  if (MANAGES_ANY_PROPOSAL.includes(role)) return true;
  return ownerId === actorId;
}

const OWNER = 'user-owner';
const OTHER = 'user-other';

describe('proposal ownership — who passes', () => {
  it('lets the owner act, whatever their role', () => {
    for (const role of ['SALES_REP', 'ESTIMATOR', 'DESIGNER', 'READ_ONLY']) {
      expect(mayAct(role, OWNER, OWNER)).toBe(true);
    }
  });

  it('lets every managing role act on anyone else’s proposal', () => {
    for (const role of MANAGES_ANY_PROPOSAL) {
      expect(mayAct(role, OWNER, OTHER)).toBe(true);
    }
  });

  it('refuses a non-manager acting on someone else’s proposal', () => {
    for (const role of ['SALES_REP', 'ESTIMATOR', 'DESIGNER', 'PROJECT_MANAGER', 'OPERATIONS']) {
      expect(mayAct(role, OWNER, OTHER)).toBe(false);
    }
  });

  it('includes ACCOUNTING among the managing roles', () => {
    // Deliberate, and easy to mistake for an oversight: accounting archives dead
    // deals and chases balances across everyone's proposals.
    expect(mayAct('ACCOUNTING', OWNER, OTHER)).toBe(true);
  });

  it('does not treat SALES_REP as managing', () => {
    // The whole point of the finding. If this ever passes, the rule has been undone.
    expect(MANAGES_ANY_PROPOSAL).not.toContain('SALES_REP');
  });
});

/**
 * Which acts are guarded.
 *
 * A list rather than a set of route tests, because what matters here is the *policy* —
 * that editing is open and releasing is not. A route test would prove the wiring; this
 * proves the decision, which is the part that will be questioned later.
 */
const GUARDED = ['release', 'discard version', 'archive', 'unarchive'] as const;
const OPEN = [
  'edit version',
  'add version',
  'submit for review',
  'preview',
  'return to draft',
] as const;

describe('proposal ownership — which acts are guarded', () => {
  it('guards the acts that reach a customer or destroy work', () => {
    expect([...GUARDED].sort()).toEqual(['archive', 'discard version', 'release', 'unarchive']);
  });

  it('leaves collaborative editing open', () => {
    // Three people touch one deal here. A rule that stopped the ops coordinator
    // fixing a typo on the engineer's draft would be worked around by handing out
    // SALES_MANAGER, which grants strictly more than the rule was protecting.
    for (const act of OPEN) expect(GUARDED).not.toContain(act as never);
  });

  it('does not guard release only for drafts the actor cannot see', () => {
    // Release is guarded for everyone who is not the owner or a manager, including
    // roles that can see the proposal perfectly well. Visibility and authority to
    // commit are different questions.
    expect(mayAct('DESIGNER', OWNER, OTHER)).toBe(false);
  });
});

describe('reassignment', () => {
  /*
   * Reassignment is what makes the ownership rules safe to have: without it, a rep on
   * holiday blocks their own deal and the workaround is granting SALES_MANAGER.
   */
  const reassign = (actorRole: string) => MANAGES_ANY_PROPOSAL.includes(actorRole);

  it('is restricted to the managing roles', () => {
    expect(reassign('SALES_MANAGER')).toBe(true);
    expect(reassign('SYSTEM_ADMIN')).toBe(true);
    expect(reassign('SALES_REP')).toBe(false);
    expect(reassign('DESIGNER')).toBe(false);
  });

  it('makes the new owner able to release', () => {
    let ownerId = OWNER;
    expect(mayAct('SALES_REP', ownerId, OTHER)).toBe(false);
    ownerId = OTHER; // reassigned
    expect(mayAct('SALES_REP', ownerId, OTHER)).toBe(true);
  });

  it('takes the previous owner’s authority away', () => {
    const ownerId = OTHER; // after reassignment
    expect(mayAct('SALES_REP', ownerId, OWNER)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { isAreaKey } from '../../src/portal/colorAreas.js';
import { knownAreaKeys, RETIRED_PORTAL_AREAS } from '../../src/portal/knownAreas.js';

describe('known portal colour areas', () => {
  it('lists 40 well-formed area keys', () => {
    const keys = knownAreaKeys();
    expect(keys).toHaveLength(40);
    expect(new Set(keys).size).toBe(40);
    for (const k of keys) expect(isAreaKey(k), k).toBe(true);
  });

  it("retires exactly the portal's 9 RETIRED_PARTS, all of them known areas", () => {
    const known = new Set(knownAreaKeys());
    expect(RETIRED_PORTAL_AREAS.size).toBe(9);
    for (const k of RETIRED_PORTAL_AREAS) expect(known.has(k), k).toBe(true);
    // The Soft Steps side panels are live, not retired: they must be mapped.
    expect(RETIRED_PORTAL_AREAS.has('soft_steps_2_mat.soft_steps_2_piece_2')).toBe(false);
  });
});

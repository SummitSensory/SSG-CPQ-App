import { describe, it, expect } from 'vitest';
import { projectIdOfOpportunity } from '../../src/crm/projectId.js';

describe('projectIdOfOpportunity', () => {
  it('reads the "Project ID:" line out of notes', () => {
    expect(projectIdOfOpportunity({ notes: 'Project ID: 4821', mondayItemId: '999' })).toBe('4821');
  });

  it('reads the id out of a multi-line notes field', () => {
    expect(
      projectIdOfOpportunity({
        notes: 'Some summary text\nProject ID: 5017\nMore notes below',
        mondayItemId: null,
      }),
    ).toBe('5017');
  });

  it('falls back to the linked monday item id when notes carry no Project ID line', () => {
    expect(
      projectIdOfOpportunity({
        notes: 'Just a summary, no project line',
        mondayItemId: '12414494509',
      }),
    ).toBe('12414494509');
  });

  it('answers empty for an opportunity created by hand, with neither source', () => {
    expect(projectIdOfOpportunity({ notes: null, mondayItemId: null })).toBe('');
    expect(projectIdOfOpportunity({})).toBe('');
  });

  it('prefers the notes line over the item id when both are present', () => {
    expect(projectIdOfOpportunity({ notes: 'Project ID: 4821', mondayItemId: '999999' })).toBe(
      '4821',
    );
  });
});

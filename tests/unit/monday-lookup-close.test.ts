import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Find a customer in monday" (public/app.js, openMondayLookup) carries a Close
 * button beside Cancel and Search, so a rep who has imported a customer has an
 * obvious way to finish. From the CRM, Close also refreshes the CRM list; from the
 * New proposal form (opts.onImported) it only dismisses the dialog.
 *
 * Tested from the shipped file against a minimal fake DOM — the repo has no DOM
 * library, and the dialog only needs a handful of node operations.
 */

const app = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8').split(/\r?\n/);

function clientSource(name: string): string {
  const i = app.findIndex((l) => l.startsWith(`  function ${name}(`));
  const j = app.findIndex((l, k) => k > i && l === '  }');
  expect(i, `${name} not found in public/app.js`).toBeGreaterThanOrEqual(0);
  return app.slice(i, j + 1).join('\n');
}

class FakeEl {
  id = '';
  type = '';
  className = '';
  textContent = '';
  disabled = false;
  style = { cssText: '' };
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private handlers: Record<string, Array<() => void>> = {};
  constructor(id = '') {
    this.id = id;
  }
  appendChild(c: FakeEl): FakeEl {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl): FakeEl {
    c.parentNode = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  removeChild(c: FakeEl): FakeEl {
    this.children.splice(this.children.indexOf(c), 1);
    c.parentNode = null;
    return c;
  }
  querySelector(sel: string): FakeEl | null {
    const id = sel.replace(/^#/, '');
    for (const c of this.children) {
      if (c.id === id) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  addEventListener(ev: string, fn: () => void): void {
    (this.handlers[ev] ||= []).push(fn);
  }
  focus(): void {}
  click(): void {
    for (const fn of this.handlers.click || []) fn();
  }
}

type Crm = { q: string; page: number };
type Lookup = (user: unknown, opts?: { onImported?: (name: string) => void }) => void;

let body: FakeEl;
let crm: Crm;
let loads: number;
let lookup: Lookup;

beforeEach(() => {
  body = new FakeEl('body');
  crm = { q: 'soar', page: 3 };
  loads = 0;
  // Stand-in for SSGUI.openModal: the footer row holds Cancel then the primary.
  const openModal = (): FakeEl => {
    const ov = new FakeEl('overlay');
    ov.appendChild(new FakeEl('mSearch'));
    ov.appendChild(new FakeEl('mResults'));
    const footer = ov.appendChild(new FakeEl('footer'));
    footer.appendChild(new FakeEl('mCancel'));
    footer.appendChild(new FakeEl('mSave'));
    return body.appendChild(ov);
  };
  const document = { createElement: () => new FakeEl() };
  lookup = new Function(
    'openModal',
    'esc',
    'IN',
    'crm',
    'loadCrm',
    'authed',
    'document',
    `${clientSource('openMondayLookup')}\nreturn openMondayLookup;`,
  )(
    openModal,
    (s: string) => s,
    '',
    crm,
    () => {
      loads++;
    },
    () => Promise.reject(new Error('no network in this test')),
    document,
  ) as Lookup;
});

function footerIds(): string[] {
  return body.querySelector('#footer')!.children.map((c) => c.id);
}

describe('openMondayLookup Close button (public/app.js)', () => {
  it('sits between Cancel and Search, as a non-submit button labelled Close', () => {
    lookup({});
    expect(footerIds()).toEqual(['mCancel', 'mClose', 'mSave']);
    const close = body.querySelector('#mClose')!;
    expect(close.textContent).toBe('Close');
    expect(close.type).toBe('button');
  });

  it('from the CRM, dismisses the dialog and refreshes the CRM list', () => {
    lookup({});
    body.querySelector('#mClose')!.click();
    expect(body.querySelector('#overlay')).toBeNull();
    expect(crm).toEqual({ q: '', page: 1 });
    expect(loads).toBe(1);
  });

  it('from the proposal form, only dismisses the dialog', () => {
    const handedBack: string[] = [];
    lookup({}, { onImported: (n) => handedBack.push(n) });
    body.querySelector('#mClose')!.click();
    expect(body.querySelector('#overlay')).toBeNull();
    expect(crm).toEqual({ q: 'soar', page: 3 });
    expect(loads).toBe(0);
    expect(handedBack).toEqual([]);
  });
});

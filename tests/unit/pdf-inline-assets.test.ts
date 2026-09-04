import { describe, it, expect } from 'vitest';
import { inlineKnownAssets } from '../../src/render/pdf.js';

describe('inlineKnownAssets', () => {
  it('replaces the known relative asset paths with embedded data URIs', async () => {
    const html =
      '<img src="logo.png" alt=""><img src="proposal/engineer-of-record-badge.png" alt="">';
    const out = await inlineKnownAssets(html);
    expect(out).not.toContain('src="logo.png"');
    expect(out).not.toContain('src="proposal/engineer-of-record-badge.png"');
    expect(out).toMatch(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  });

  it('leaves everything else untouched', async () => {
    const html = '<p>Hello & welcome</p><img src="other.png">';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });
});

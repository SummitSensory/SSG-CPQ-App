import { describe, it, expect } from 'vitest';
import { inlineKnownAssets } from '../../src/render/pdf.js';

describe('inlineKnownAssets', () => {
  it('inlines a bare relative path (the logo, the engineer-of-record badge)', async () => {
    const html =
      '<img src="logo.png" alt=""><img src="proposal/engineer-of-record-badge.png" alt="">';
    const out = await inlineKnownAssets(html);
    expect(out).not.toContain('src="logo.png"');
    expect(out).not.toContain('src="proposal/engineer-of-record-badge.png"');
    expect(out).toMatch(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  });

  it('inlines a root-relative house-file path for any product line, not just a hardcoded list', async () => {
    // Every product line's introduction (Adventure, Soar, Flex) falls back to
    // a house photo referenced exactly like this — see intro-flex.js et al.
    const html = '<img src="/proposal/flex-p3-unit.jpg" alt="">';
    const out = await inlineKnownAssets(html);
    expect(out).not.toContain('src="/proposal/flex-p3-unit.jpg"');
    expect(out).toMatch(/src="data:image\/jpeg;base64,[A-Za-z0-9+/=]+"/);
  });

  it('leaves a data: URI (an admin-uploaded photo) untouched', async () => {
    const html = '<img src="data:image/jpeg;base64,abcd">';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });

  it('never fetches an http(s) URL', async () => {
    const html = '<img src="https://example.com/tracking-pixel.png">';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });

  it('leaves a genuinely missing local asset untouched rather than failing the render', async () => {
    const html = '<img src="no-such-file.png">';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });

  it('refuses to read outside public/, however the path is spelled', async () => {
    // A recognised image extension, so this actually exercises the path-bounds
    // check rather than being rejected by the extension filter first.
    const html = '<img src="../../package.json/x.png">';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });

  it('leaves non-image content untouched', async () => {
    const html = '<p>Hello & welcome</p>';
    const out = await inlineKnownAssets(html);
    expect(out).toBe(html);
  });
});

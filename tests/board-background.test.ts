import {describe, expect, it} from 'vitest';

import {backgroundStyle, safeImageUrl} from '../src/app/boards/background';
import {bgImageUrl} from '../src/server/bg-image';

const node = () => ({style: {background: 'old'}}) as unknown as HTMLElement;
const base = {bgColor1: '#1E3A5F', bgColor2: '#1E3A5F', bgAngle: 135};

describe('board background photo', () => {
  it('builds our own address, versioned by the file, or null', () => {
    expect(bgImageUrl(7, null)).toBeNull();
    const url = bgImageUrl(7, 'file_abc123xyz789qq');
    expect(url).toMatch(/^\/site-api\/boards\/7\/background\?v=[a-z0-9]+$/);
    expect(safeImageUrl(url)).toBe(url);
  });

  it('never lets another address into the CSS', () => {
    for (const bad of ['https://evil.test/x.png', '/site-api/boards/7/background?v=a")', 'javascript:alert(1)', '/site-api/boards/x/background?v=1', '']) {
      expect(safeImageUrl(bad)).toBeNull();
    }
  });

  it('shows the photo over the colour when the kind is image', () => {
    const el = node();
    backgroundStyle(el, {...base, bgKind: 'image', bgImage: '/site-api/boards/7/background?v=abc'});
    expect(el.style.background).toBe('url("/site-api/boards/7/background?v=abc") center / cover no-repeat #1E3A5F');
  });

  it('falls back to the colour when the photo is missing or unsafe, and ignores it for other kinds', () => {
    const a = node();
    backgroundStyle(a, {...base, bgKind: 'image', bgImage: 'https://evil.test/x.png'});
    expect(a.style.background).toBe('#1E3A5F');
    const b = node();
    backgroundStyle(b, {...base, bgKind: 'color', bgImage: '/site-api/boards/7/background?v=abc'});
    expect(b.style.background).toBe('#1E3A5F');
  });
});

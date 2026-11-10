import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('RTL contract', () => {
  it('Icon mirrors the directional set automatically', () => {
    const src = read('src/portal/ui/icon.tsx');
    for (const n of ['arrow-left', 'arrow-right', 'chevron-left', 'chevron-right']) expect(src).toContain(`'${n}'`);
    expect(src).toContain("'icon-flip'");
  });
  it('Menu resolves start/end against computed direction', () => {
    expect(read('src/portal/ui/overlay.tsx')).toMatch(/direction === 'rtl'/);
  });
  it('i18n.css resets tracking for cursive scripts and raises Urdu line-height', () => {
    const css = read('src/styles/i18n.css');
    expect(css).toMatch(/letter-spacing: 0 !important/);
    expect(css).toMatch(/:lang\(ur\)/);
    expect(css).toMatch(/line-height: 1\.9/);
  });
});

describe('app CSS style guard', () => {
  const files = [
    'src/app/app.css', 'src/app/design.css', 'src/app/responsive.css', 'src/app/phase3.css', 'src/app/tables.css',
    'src/app/boards/a11y.css', 'src/app/boards/lane-menu.css', 'src/app/boards/polish.css', 'src/app/boards/settings.css',
    'src/app/cards/cards.css', 'src/app/cards/a11y.css', 'src/app/chat/chat.css', 'src/app/notifications/bell.css',
    'src/app/settings/settings.css', 'src/app/members/members.css',
  ];
  it('uses logical properties only (no physical left/right)', () => {
    const bad = /(margin|padding)-(left|right)|border-(left|right)\b|text-align:\s*(left|right)|float:\s*(left|right)|(^|[\s;{])(left|right):\s*[-\d.]/m;
    for (const f of files) expect(read(f), f).not.toMatch(bad);
  });
  it('keeps a coarse-pointer 44px target block and a reduced-motion rule', () => {
    expect(read('src/app/responsive.css')).toMatch(/pointer: coarse[\s\S]*min-block-size: 44px/);
    expect(read('src/styles/a11y.css')).toMatch(/prefers-reduced-motion: reduce/);
  });
  it('the phone nav drawer moves focus in and Esc returns it to the menu button', () => {
    const src = read('src/app/shell.tsx');
    expect(src).toMatch(/\.app-sidebar \.app-nav-link'\)\?\.focus/);
    expect(src).toMatch(/\.app-menu-button'\)\?\.focus/);
  });
});

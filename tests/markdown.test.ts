import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';

import {Markdown, MAX_SOURCE, parseMarkdown, safeUrl} from '../src/lib/markdown';

const html = (source: string, mentions?: string[]) => renderToStaticMarkup(createElement(Markdown, {source, mentions}));

describe('markdown subset', () => {
  it('renders paragraphs and line breaks', () => {
    expect(html('one\ntwo\n\nthree')).toBe('<div class="md"><p>one<br/>two</p><p>three</p></div>');
  });

  it('renders bold, italic and code', () => {
    expect(html('**b** *i* `c`')).toBe('<div class="md"><p><strong>b</strong> <em>i</em> <code>c</code></p></div>');
    expect(html('a * b * c')).toContain('a * b * c');
    expect(html('snake_case_name')).toContain('snake_case_name');
    expect(html('**a *b* c**')).toContain('<strong>a <em>b</em> c</strong>');
  });

  it('renders fenced code verbatim', () => {
    const out = html('```ts\n**not bold** <b>x</b>\n```\nafter');
    expect(out).toContain('<pre><code>**not bold** &lt;b&gt;x&lt;/b&gt;</code></pre>');
    expect(out).toContain('<p>after</p>');
    expect(html('```\nunclosed <i>')).toContain('<pre><code>unclosed &lt;i&gt;</code></pre>');
  });

  it('renders lists and task items (display only)', () => {
    const out = html('- a\n- b\n\n1. x\n2. y\n\n- [ ] todo\n- [x] done');
    expect(out).toContain('<ul><li><span>a</span></li><li><span>b</span></li></ul>');
    expect(out).toContain('<ol start="1">');
    expect(out).toContain('<input type="checkbox" readOnly="" disabled="" tabindex="-1" aria-label="Not done"/>');
    expect(out).toContain('checked=""');
    expect(parseMarkdown('- [x] done')).toEqual([{t: 'list', ordered: false, start: 1, items: [{task: true, c: [{t: 'text', v: 'done'}]}]}]);
  });

  it('renders blockquotes', () => {
    expect(html('> a\n> b')).toBe('<div class="md"><blockquote>a<br/>b</blockquote></div>');
  });

  it('renders headings as a bold block with no heading role', () => {
    const out = html('# One\n###### Six\n## Two');
    expect(out).not.toMatch(/<h[1-6]/);
    expect(out).toContain('<div role="none" class="md-heading md-h3">One</div>');
    expect(out).toContain('md-h5">Six');
    expect(out).toContain('md-h4">Two');
  });

  it('keeps @mentions of known names', () => {
    expect(html('hi @Ada Lovelace, ok', ['Ada Lovelace'])).toContain('<strong class="cd-mention">@Ada Lovelace</strong>');
    expect(html('hi @Ada', [])).toContain('hi @Ada');
    expect(html('**@Ada Lovelace**', ['Ada Lovelace', 'Ada'])).toContain('<strong><strong class="cd-mention">@Ada Lovelace</strong></strong>');
  });

  it('supports backslash escapes', () => {
    expect(html('\\*not italic\\*')).toContain('*not italic*');
    expect(html('\\*not italic\\*')).not.toContain('<em>');
  });
});

describe('links', () => {
  it('opens http, https and mailto safely', () => {
    const out = html('[site](https://example.com/a?b=1) [mail](mailto:a@example.com) [h](http://example.com)');
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">site</a>');
    expect(out).toContain('href="mailto:a@example.com"');
    expect(out).toContain('href="http://example.com/"');
  });

  it('auto-links bare URLs without trailing punctuation', () => {
    expect(html('see https://example.com/x.')).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
    expect(html('(https://example.com/a_(b))')).toContain('href="https://example.com/a_(b)"');
    expect(html('(see https://example.com/a)')).toContain('href="https://example.com/a"');
    expect(html('nohttps://example.com')).not.toContain('<a ');
  });

  it('every anchor has target and rel', () => {
    const out = html('a https://a.com [b](https://b.com) [c](mailto:c@d.com) https://e.com');
    const anchors = out.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBe(4);
    for (const a of anchors) expect(a).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('refuses javascript:, data:, vbscript:, file:, relative and protocol-relative targets', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x61;script:alert(1)',
      '&#106;avascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///tmp/secret.txt',
      '//evil.com',
      '/relative',
      'evil.com',
      'https://user:pass@evil.com',
      'https://',
      'blob:https://example.com/x',
      'ftp://example.com',
    ]) {
      expect(safeUrl(bad), bad).toBeNull();
      const out = html(`[click](${bad})`);
      expect(out, bad).not.toContain('<a ');
      expect(out, bad).not.toContain('href');
    }
  });

  it('does not let quotes, angle brackets or whitespace break out of the attribute', () => {
    expect(safeUrl('https://a.com/"onmouseover="alert(1)')).toBeNull();
    expect(safeUrl('https://a.com/<script>')).toBeNull();
    expect(safeUrl('https://a.com/ x')).toBeNull();
    const out = html('https://a.com/x"onclick="alert(1)');
    expect(out).not.toMatch(/<[^>]*\sonclick=/);
  });

  it('handles nested brackets and parentheses', () => {
    expect(html('[a [b] c](https://example.com)')).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">a [b] c</a>');
    expect(html('[[[[[[x](javascript:alert(1))')).not.toContain('<a ');
    expect(html('[x](https://example.com/a(b)c)')).toContain('href="https://example.com/a(b)c"');
    expect(html('[x](https://example.com')).not.toContain('<a href="https://example.com"');
    expect(html('[x]')).toContain('[x]');
  });

  it('does not nest links, and an unsafe outer label stays text', () => {
    const out = html('[a https://b.com](https://c.com)');
    expect((out.match(/<a /g) ?? []).length).toBe(1);
    expect(html('[<img src=x onerror=alert(1)>](javascript:x)')).toBe('<div class="md"><p>&lt;img src=x onerror=alert(1)&gt;</p></div>');
  });
});

describe('escaping and XSS', () => {
  it('escapes raw HTML in every position', () => {
    for (const src of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '**<b onmouseover=x>**', '`<script>`', '> <iframe src=javascript:1>', '- <svg onload=alert(1)>', '# <style>', '[<a>](https://a.com)']) {
      const out = html(src);
      expect(out, src).not.toMatch(/<(script|img|iframe|svg|style|b |a>)/i);
    }
    expect(html('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('produces no inline handlers, style attributes or non-allowed tags', () => {
    const out = html('# h\n**b** *i* `c`\n```\nx\n```\n- [ ] t\n1. n\n> q\n[l](https://a.com)\n<b onclick=1>');
    expect(out).not.toMatch(/<[^>]*\son\w+=/i);
    expect(out).not.toMatch(/<[^>]*\sstyle=/);
    const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/g)].map(m => m[1]));
    for (const tag of tags) expect(['div', 'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'span', 'input', 'blockquote', 'a', 'br']).toContain(tag);
  });

  it('strips unicode bidi controls and zero-width characters', () => {
    const out = html('safe‮ecivres‬ ⁦x⁩ a​b﻿c ؜');
    expect(out).not.toMatch(/[‪-‮⁦-⁩​-‏﻿؜]/);
    expect(out).toContain('safeecivres');
    // A bidi control cannot hide a scheme or a host.
    expect(safeUrl('https://exa‮mple.com')).toBeNull();
    expect(html('[x](java​script:alert(1))')).not.toContain('<a ');
    expect(html('[x](https://a.com‮)')).toContain('href="https://a.com/"');
  });

  it('strips control characters and normalises newlines', () => {
    expect(html('a\u0000b\u0007c\r\nd')).toBe('<div class="md"><p>abc<br/>d</p></div>');
  });

  it('keeps emoji and other scripts intact', () => {
    expect(html('**مرحبا** 日本語 👩‍💻')).toContain('<strong>مرحبا</strong> 日本語 👩‍💻');
  });
});

describe('limits', () => {
  it('cuts huge input at the source cap', () => {
    const out = html('a'.repeat(MAX_SOURCE * 5));
    expect(out.length).toBeLessThan(MAX_SOURCE + 100);
  });

  it('stays fast on pathological input', () => {
    const cases = ['*'.repeat(MAX_SOURCE), '[' .repeat(MAX_SOURCE), '`'.repeat(MAX_SOURCE), '**a '.repeat(MAX_SOURCE / 4), '[a](' .repeat(MAX_SOURCE / 4), '*a_'.repeat(MAX_SOURCE / 3), '- '.repeat(MAX_SOURCE / 2), '> '.repeat(MAX_SOURCE / 2), '\\'.repeat(MAX_SOURCE), 'https://a.b/'.repeat(MAX_SOURCE / 12), '((((['.repeat(MAX_SOURCE / 5)];
    for (const src of cases) {
      const t = performance.now();
      html(src);
      expect(performance.now() - t, src.slice(0, 8)).toBeLessThan(1500);
    }
  });

  it('caps blocks and list items and emphasis nesting', () => {
    expect(parseMarkdown('x\n\n'.repeat(5000)).length).toBeLessThanOrEqual(400);
    const list = parseMarkdown('- a\n'.repeat(5000));
    expect(list.length).toBe(1);
    if (list[0].t === 'list') expect(list[0].items.length).toBeLessThanOrEqual(200);
    expect(() => html('*'.repeat(50) + 'a' + '*'.repeat(50))).not.toThrow();
    expect(() => html('['.repeat(3000) + 'x' + '](https://a.com)'.repeat(3))).not.toThrow();
  });

  it('renders empty and whitespace input as nothing', () => {
    expect(html('')).toBe('<div class="md"></div>');
    expect(html('  \n \n')).toBe('<div class="md"></div>');
  });
});

describe('markdown: pathological input stays cheap', () => {
  const fast = (source: string) => {
    const t = performance.now();
    const blocks = parseMarkdown(source);
    const ms = performance.now() - t;
    expect(blocks.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500);
  };
  it('many unmatched brackets, stars, underscores and backticks', () => {
    fast('['.repeat(MAX_SOURCE));
    fast('*a '.repeat(7000));
    fast('_a '.repeat(7000));
    fast('`'.repeat(MAX_SOURCE));
    fast('`a '.repeat(7000));
    fast('[a](('.repeat(5000));
    fast('**a *b '.repeat(3000));
  });
  it('degrades to plain text once the budget is spent, and normal text still formats', () => {
    expect(html('*a '.repeat(7000))).toContain('*a');
    expect(html('**bold** and [x](https://a.test)')).toContain('<strong>bold</strong>');
  });
});

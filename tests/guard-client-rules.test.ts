import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

import {describe, expect, it} from 'vitest';

// Guards the client-side repo rules in AGENTS.md ("Buttons and forms", "A dashboard looks like a
// dashboard", "Never"). Scans only the four source dirs below. A new violation fails the test:
// fix the code; add an `allow` entry (exact file + justification) only when it is truly needed.

const ROOT = join(__dirname, '..');
const DIRS = ['src/app', 'src/portal', 'src/pages', 'src/components'];
const EXT = /\.(tsx|ts|astro)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => walk(join(ROOT, d))).map((p) => ({
  rel: relative(ROOT, p).split('\\').join('/'),
  // Comment lines (` * ...`, `// ...`) are blanked, keeping line numbers, so docs can mention the rules.
  text: readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => (/^\s*(?:\*|\/\/|\/\*)/.test(l) ? '' : l))
    .join('\n'),
}));

type Rule = {
  name: string;
  pattern: RegExp; // must be global
  files?: RegExp; // only these files (default: all scanned)
  skip?: RegExp; // never these files
  // Reject a match as a false positive (receives the matched text).
  ignore?: (match: string) => boolean;
  // Exact file -> justification. Matches in these files are accepted.
  allow?: Record<string, string>;
};

const RULES: Rule[] = [
  {
    name: 'window.confirm / alert / prompt (use useConfirm and toasts)',
    // bare `confirm(` is NOT matched: it is the useConfirm() hook result in this codebase
    pattern: /\bwindow\.(?:confirm|alert|prompt)\s*\(|(?<![.\w])(?:alert|prompt)\s*\(/g,
    files: /\.(tsx|ts)$/,
  },
  {
    name: 'dangerouslySetInnerHTML',
    pattern: /dangerouslySetInnerHTML/g,
  },
  {
    name: 'set:html with non-literal data',
    pattern: /set:html=\{(?!\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*\})[^}]*\}/g,
    files: /\.astro$/,
  },
  {
    name: 'innerHTML assignment',
    pattern: /\.innerHTML\s*\+?=/g,
  },
  {
    name: 'style={...} attribute (CSP; use classes/tokens)',
    pattern: /\bstyle=\{/g,
    files: /\.(tsx|astro)$/,
    allow: {
      'src/app/boards/card.tsx': 'dnd-kit sortable transform/transition: computed per frame, cannot be a class',
      'src/app/boards/lane.tsx': 'dnd-kit sortable transform/transition: computed per frame, cannot be a class',
      'src/app/boards/views/calendar-view.tsx': 'dnd-kit draggable translate: computed per frame, cannot be a class',
    },
  },
  {
    name: 'hex colour in tsx (use tokens in CSS)',
    pattern: /['"`]#[0-9a-fA-F]{3,8}['"`]/g,
    files: /\.tsx$/,
    allow: {
      'src/app/boards/board-settings.tsx': 'board background presets: stored as plain #rrggbb data (server contract), not UI chrome',
    },
  },
  {
    name: 'target="_blank" without rel noopener',
    pattern: /<a\b[^>]*target=["']_blank["'][^>]*>/g,
    ignore: (m) => /rel=(?:"[^"]*|'[^']*|\{["'][^"']*)noopener/.test(m),
  },
  {
    name: '<form without noValidate / novalidate',
    pattern: /<form\b[^>]*>/gi,
    ignore: (m) => /no-?validate/i.test(m),
    allow: {},
  },
  {
    name: '<input type="password" outside PasswordInput',
    pattern: /<input\b[^>]*type=["']password["']/g,
    // .astro account pages use the documented `.pw-input` + `data-reveal-password` + bindPasswordReveal() pattern
    skip: /\.astro$|(?:^|\/)password-input\.tsx$|src\/portal\/ui\/form\.tsx$/,
    allow: {},
  },
  {
    name: 'Link from @tanstack/react-router in src/app (use src/app/nav.tsx)',
    pattern: /import\s*\{[^}]*\bLink\b[^}]*\}\s*from\s*['"]@tanstack\/react-router['"]/g,
    files: /^src\/app\//,
    skip: /^src\/app\/nav\.tsx$/,
  },
  {
    name: 'plain fetch( outside the api layer (use api / siteFetch)',
    pattern: /(?<![.\w])fetch\s*\(/g,
    files: /^src\/(?:app|portal)\//,
    skip: /^src\/app\/api\.ts$|^src\/portal\/api\.ts$/,
    allow: {},
  },
  {
    name: 'console.log of likely PII (email, password, token)',
    pattern: /console\.log\([^)]*(?:email|password|token)/gi,
  },
];

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

describe('client rules guard', () => {
  it('scans a sane number of files', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  for (const rule of RULES) {
    it(`no regressions: ${rule.name}`, () => {
      const hits: string[] = [];
      for (const f of FILES) {
        if (rule.files && !rule.files.test(f.rel)) continue;
        if (rule.skip && rule.skip.test(f.rel)) continue;
        if (rule.allow && f.rel in rule.allow) continue;
        for (const m of f.text.matchAll(rule.pattern)) {
          if (rule.ignore?.(m[0])) continue;
          hits.push(`${f.rel}:${lineOf(f.text, m.index ?? 0)}  ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
        }
      }
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }
});

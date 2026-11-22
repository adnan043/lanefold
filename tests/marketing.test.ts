import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {ABOUT, FEATURES, FOOTER_NAV, HOME, NAV, PLAN_DEFAULTS, PRICING} from '../src/content/site';
import {absoluteUrl, DEFAULT_SOCIAL_IMAGE, jsonLdText, postJsonLd, siteJsonLd, xmlEscape} from '../src/lib/seo';
import {computeEntitlements} from '../src/server/entitlements';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The `plan_limits` rows the migrations leave: the first migration's seed, then every later `UPDATE`, in order. */
function seedRows() {
  const dir = join(root, 'prisma/migrations');
  const sql = readdirSync(dir)
    .filter(name => !name.includes('.'))
    .sort()
    .map(name => read(`prisma/migrations/${name}/migration.sql`))
    .join('\n');
  const insert = /INSERT INTO "plan_limits"[^;]*VALUES([^;]*);/.exec(sql);
  expect(insert, 'plan_limits seed not found').toBeTruthy();
  type Row = {plan: string; maxMembers: number; maxBoards: number | null; maxFileBytes: number; flowRunsPerMonth: number | null; auditLog: boolean};
  const rows: Row[] = [...insert![1]!.matchAll(/\('(\w+)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*'[^']*',\s*(true|false)/g)].map(m => ({
    plan: m[1]!,
    maxMembers: Number(m[2]),
    maxBoards: null,
    maxFileBytes: Number(m[3]),
    flowRunsPerMonth: null,
    auditLog: m[6] === 'true',
  }));
  const columns: Record<string, keyof Row> = {
    max_members: 'maxMembers',
    max_boards: 'maxBoards',
    max_file_bytes: 'maxFileBytes',
    flow_runs_per_month: 'flowRunsPerMonth',
    audit_log: 'auditLog',
  };
  for (const m of sql.matchAll(/UPDATE "plan_limits" SET ([^;]*?) WHERE "plan" = '(\w+)';/g)) {
    const row = rows.find(r => r.plan === m[2]);
    if (!row) continue;
    for (const [, col, value] of m[1]!.matchAll(/"(\w+)" = ([\w.]+)/g)) {
      const key = columns[col!];
      if (!key) continue;
      (row as Record<string, unknown>)[key] = value === 'NULL' ? null : value === 'true' ? true : value === 'false' ? false : Number(value);
    }
  }
  return rows;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const bytes = (text: string) => {
  const m = /^(\d+) (MB|GB)$/.exec(text);
  expect(m, `unparseable size "${text}"`).toBeTruthy();
  return Number(m![1]) * (m![2] === 'GB' ? GB : MB);
};
/** A count cell: a number, or null for "Unlimited". */
const count = (text: string) => (text === 'Unlimited' ? null : Number(text.replace(/,/g, '')));
/** The app shows members at the safety cap (500) as unlimited. */
const shownMembers = (n: number) => (n >= 500 ? null : n);

describe('pricing numbers match the limits the app enforces', () => {
  const rows = seedRows();

  it('lists exactly the seeded plans, in order', () => {
    expect(PRICING.plans.map(p => p.key)).toEqual(rows.map(r => r.plan));
  });

  for (const row of seedRows()) {
    it(`${row.plan}: members, boards, file size, flow runs and audit log (like Trello, no storage)`, () => {
      const plan = PRICING.plans.find(p => p.key === row.plan)!;
      expect(count(plan.limits.members)).toBe(shownMembers(row.maxMembers));
      expect(count(plan.limits.boards)).toBe(row.maxBoards);
      expect(bytes(plan.limits.file)).toBe(row.maxFileBytes);
      expect(plan.limits.audit).toBe(row.auditLog);
      expect('storage' in plan.limits).toBe(false);
      const d = PLAN_DEFAULTS[row.plan as keyof typeof PLAN_DEFAULTS];
      expect(d.members).toBe(shownMembers(row.maxMembers));
      expect(d.boards).toBe(row.maxBoards);
      expect(d.fileMb * MB).toBe(row.maxFileBytes);
      expect(d.flowRuns).toBe(row.flowRunsPerMonth);
      expect(plan.limits.flows).toBe(row.flowRunsPerMonth === null ? 'Unlimited' : `${row.flowRunsPerMonth.toLocaleString('en-US')} a month`);
    });
  }

  it('the Trello limits: Free 10 members / 10 boards / 10 MB / 250 runs; Pro and Team unlimited members and boards, 250 MB', () => {
    expect(PLAN_DEFAULTS.free).toEqual({members: 10, boards: 10, fileMb: 10, flowRuns: 250, auditLog: false});
    expect(PLAN_DEFAULTS.pro).toEqual({members: null, boards: null, fileMb: 250, flowRuns: 1000, auditLog: false});
    expect(PLAN_DEFAULTS.team).toEqual({members: null, boards: null, fileMb: 250, flowRuns: null, auditLog: true});
    expect(JSON.stringify(PRICING.plans)).not.toMatch(/storage/i);
  });

  it('feature bullets quote the same member limit', () => {
    const free = PRICING.plans.find(p => p.key === 'free')!;
    expect(free.features).toContain(`Up to ${free.limits.members} members`);
    expect(free.features).toContain(`Up to ${free.limits.boards} boards`);
    expect(PRICING.plans.find(p => p.key === 'pro')!.features).toContain('Unlimited members');
  });

  it('the free plan equals the strictest fallback in entitlements.ts', () => {
    const src = read('src/server/entitlements.ts');
    const fallback = /FALLBACK_LIMITS: PlanLimits = \{([^}]*)\}/.exec(src)![1]!;
    const value = (key: string) => {
      const expr = new RegExp(`${key}: ([\\d *]+),`).exec(fallback)![1]!;
      return expr.split('*').reduce((n, part) => n * Number(part.trim()), 1);
    };
    expect(value('maxMembers')).toBe(PLAN_DEFAULTS.free.members);
    expect(value('maxBoards')).toBe(PLAN_DEFAULTS.free.boards);
    expect(value('maxFileBytes')).toBe(PLAN_DEFAULTS.free.fileMb * MB);
  });

  it('is flat per workspace and never invents a price', () => {
    const text = JSON.stringify(PRICING);
    expect(text).not.toMatch(/[$€£]\s?\d/);
    expect(PRICING.perWorkspace).toContain('per workspace');
  });
});

describe('public copy', () => {
  it('links only to public or app paths ending with a slash', () => {
    for (const item of [...NAV, ...FOOTER_NAV]) expect(item.href === '/' || item.href.endsWith('/')).toBe(true);
    expect(PRICING.changePlanHref).toBe('/app/settings/billing');
  });
  it('has a home description of a sensible length and an about page', () => {
    expect(HOME.description.length).toBeGreaterThan(60);
    expect(HOME.description.length).toBeLessThanOrEqual(200);
    expect(ABOUT.sections.length).toBeGreaterThan(0);
    expect(PRICING.description.length).toBeLessThanOrEqual(200);
  });
});

describe('sitemap and robots', () => {
  const pagesDir = join(root, 'src/pages');
  const walk = (dir: string, prefix = ''): string[] =>
    readdirSync(join(pagesDir, dir), {withFileTypes: true}).flatMap(entry =>
      entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : entry.name.endsWith('.astro') ? [`${prefix}${entry.name}`] : []
    );

  it('the discovered pages are exactly the public ones (no /jobs/)', () => {
    const exclude = new Set(['/404/', '/500/', '/checkout/', '/thanks/']);
    const privateRe = /^\/(account|portal|site-api|dashboard|app)(\/|$)/;
    const paths = walk('')
      .filter(f => !f.includes('['))
      .map(f => `/${f.replace(/\.astro$/, '').replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/'))
      .filter(p => !privateRe.test(p) && !exclude.has(p))
      .sort();
    expect(paths).toEqual(['/', '/about/', '/blog/', '/features/', '/pricing/']);
  });

  it('the sitemap route keeps the same exclusions as this test', () => {
    const src = read('src/pages/sitemap.xml.ts');
    expect(src).toContain("new Set(['/404/', '/500/', '/checkout/', '/thanks/'])");
    expect(src).toContain('account|portal|site-api|dashboard|app');
    expect(src).not.toMatch(/jobs/);
  });

  it('robots.txt keeps private areas out and lists the sitemap', () => {
    const src = read('src/pages/robots.txt.ts');
    for (const line of ['Disallow: /site-api/', 'Disallow: /app', 'Disallow: /dashboard', 'Disallow: /account/']) expect(src).toContain(line);
    expect(src).toContain('/sitemap.xml');
    expect(src).not.toMatch(/jobs/);
  });
});

describe('blog posts', () => {
  const dir = join(root, 'src/content/blog');
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const slugs = new Set(files.map(f => f.replace(/\.md$/, '')));

  it('has five posts', () => expect(files).toHaveLength(5));

  for (const file of files) {
    it(`${file}: front matter, date, tags and internal links`, () => {
      const src = readFileSync(join(dir, file), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(src)![1]!;
      const title = /^title:\s*(.+)$/m.exec(fm)![1]!.replace(/^"|"$/g, '');
      const description = /^description:\s*(.+)$/m.exec(fm)![1]!.replace(/^"|"$/g, '');
      expect(title.length).toBeLessThanOrEqual(120);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(200);
      const date = /^publishedAt:\s*(\d{4}-\d{2}-\d{2})$/m.exec(fm);
      expect(date).toBeTruthy();
      expect(Number.isNaN(Date.parse(date![1]!))).toBe(false);
      expect(/^tags:\s*\[.+\]$/m.test(fm)).toBe(true);
      for (const m of src.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const href = m[1]!.split('#')[0]!;
        expect(href.endsWith('/'), `${href} must end with /`).toBe(true);
        const blog = /^\/blog\/([^/]+)\/$/.exec(href);
        if (blog) expect(slugs.has(blog[1]!), `${href} has no post`).toBe(true);
      }
    });
  }
});

describe('seo helpers', () => {
  it('escapes XML', () => expect(xmlEscape(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'));

  it('makes JSON-LD safe inside a script tag', () => {
    const text = jsonLdText({name: '</script><!-- & -->'});
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(JSON.parse(text).name).toBe('</script><!-- & -->');
  });

  it('keeps absolute URLs only when the origin is known, https URLs as they are', () => {
    expect(absoluteUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    const url = absoluteUrl('/pricing/');
    if (url) expect(url.endsWith('/pricing/')).toBe(true);
  });

  it('default social image is the committed 1200x630 card', () => {
    expect(DEFAULT_SOCIAL_IMAGE).toBe('/images/og-lanefold.png');
    const png = readFileSync(join(root, 'public/images/og-lanefold.png'));
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it('the home graph describes the site and the app with no ratings or prices', () => {
    const data = siteJsonLd({name: 'Lanefold'}, 'A kanban app with chat.', 'en') as {'@graph': Record<string, unknown>[]};
    const types = data['@graph'].map(n => n['@type']);
    expect(types).toEqual(['WebSite', 'Organization', 'SoftwareApplication']);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/aggregateRating|offers|review|price/i);
  });

  it('a post becomes a BlogPosting dated from its front matter', () => {
    const when = new Date('2026-11-02T00:00:00Z');
    const data = postJsonLd({name: 'Lanefold'}, {path: '/blog/x/', title: 'T', description: 'D', publishedAt: when}) as Record<string, unknown>;
    expect(data['@type']).toBe('BlogPosting');
    expect(data.datePublished).toBe(when.toISOString());
    expect(data.dateModified).toBe(when.toISOString());
  });
});

describe('billing modes on the marketing side', () => {
  const limits = (p: (typeof PRICING.plans)[number]) => ({
    plan: p.key,
    maxMembers: count(p.limits.members) ?? 500,
    maxBoards: count(p.limits.boards),
    maxFileBytes: bytes(p.limits.file),
    flowRunsPerMonth: p.limits.flows === 'Unlimited' ? null : Number(p.limits.flows.replace(/[^\d]/g, '')),
    auditLog: p.limits.audit,
  });
  const workspace = (plan: string) => ({id: 1, plan, memberCount: 1, graceUntil: null});

  it('PAID: the entitlements a plan gets equal the numbers the pricing page shows', () => {
    for (const plan of PRICING.plans) {
      const e = computeEntitlements({limits: limits(plan), workspace: workspace(plan.key), mode: 'PAID'});
      expect(e.unlimited.members ? null : e.limits.maxMembers).toBe(count(plan.limits.members));
      expect(e.unlimited.boards ? null : e.limits.maxBoards).toBe(count(plan.limits.boards));
      expect(e.limits.maxFileBytes).toBe(bytes(plan.limits.file));
      expect(e.limits.flowRunsPerMonth === null ? 'Unlimited' : `${e.limits.flowRunsPerMonth.toLocaleString('en-US')} a month`).toBe(plan.limits.flows);
      expect(e.features.auditLog).toBe(plan.limits.audit);
      expect(e.upgradeUi).toBe(true);
    }
  });

  it('FREE_FOR_ALL: plan limits are not enforced, upgrade UI is off, and the static pricing page says so', () => {
    for (const plan of PRICING.plans) {
      const e = computeEntitlements({limits: limits(plan), workspace: workspace(plan.key), mode: 'FREE_FOR_ALL'});
      expect(e.upgradeUi).toBe(false);
      expect(e.readOnly).toBe(false);
      expect(e.features.auditLog).toBe(true);
      expect(e.limits.maxMembers).toBeGreaterThanOrEqual(count(plan.limits.members) ?? 500);
    }
    expect(PRICING.modeNote).toMatch(/free for everyone/);
    expect(PRICING.testNote).toMatch(/test mode/);
  });
});

describe('page titles and descriptions', () => {
  const pages = [
    {name: 'home', description: HOME.description},
    {name: 'pricing', title: PRICING.title, description: PRICING.description},
    {name: 'features', title: FEATURES.title, description: FEATURES.description},
    {name: 'about', title: 'About', description: /description="([^"]+)"/.exec(read('src/pages/about.astro'))![1]!},
    {name: 'blog', title: 'Blog', description: /description=\{`([^`]+)`\}/.exec(read('src/pages/blog/index.astro'))![1]!.replace('${name}', 'Lanefold')},
  ];
  it('are unique and within search-friendly lengths', () => {
    expect(new Set(pages.map(p => p.description)).size).toBe(pages.length);
    expect(new Set(pages.flatMap(p => (p.title ? [p.title] : []))).size).toBe(4);
    for (const p of pages) {
      expect(p.description.length, `${p.name} description`).toBeGreaterThanOrEqual(50);
      expect(p.description.length, `${p.name} description`).toBeLessThanOrEqual(200);
    }
  });

  it('public pages carry no inline style, inline handler, job-board or placeholder copy', () => {
    const files = ['src/pages/index.astro', 'src/pages/about.astro', 'src/pages/pricing.astro', 'src/pages/features.astro', 'src/pages/blog/index.astro', 'src/pages/404.astro', 'src/pages/500.astro', 'src/content/site.ts'];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} inline style`).not.toMatch(/\sstyle=["{]/);
      expect(src, `${f} inline handler`).not.toMatch(/\son[a-z]+=["{]/);
      expect(src, `${f} template copy`).not.toMatch(/My site|\/jobs\/|job board|lorem ipsum/i);
    }
  });
});

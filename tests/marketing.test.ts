import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {ABOUT, FEATURES, FOOTER_NAV, HOME, NAV, PLAN_DEFAULTS, PRICING} from '../src/content/site';
import {absoluteUrl, DEFAULT_SOCIAL_IMAGE, jsonLdText, postJsonLd, siteJsonLd, xmlEscape} from '../src/lib/seo';
import {computeEntitlements} from '../src/server/entitlements';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The `plan_limits` seed rows of the first migration: the defaults the app enforces. */
function seedRows() {
  const dir = join(root, 'prisma/migrations');
  const sql = readdirSync(dir)
    .filter(name => !name.includes('.'))
    .map(name => read(`prisma/migrations/${name}/migration.sql`))
    .join('\n');
  const insert = /INSERT INTO "plan_limits"[^;]*VALUES([^;]*);/.exec(sql);
  expect(insert, 'plan_limits seed not found').toBeTruthy();
  return [...insert![1]!.matchAll(/\('(\w+)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*'[^']*',\s*(true|false)/g)].map(m => ({
    plan: m[1]!,
    maxMembers: Number(m[2]),
    maxFileBytes: Number(m[3]),
    storageQuotaBytes: Number(m[4]),
    maxFlows: Number(m[5]),
    auditLog: m[6] === 'true',
  }));
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const bytes = (text: string) => {
  const m = /^(\d+) (MB|GB)$/.exec(text);
  expect(m, `unparseable size "${text}"`).toBeTruthy();
  return Number(m![1]) * (m![2] === 'GB' ? GB : MB);
};

describe('pricing numbers match the limits the app enforces', () => {
  const rows = seedRows();

  it('lists exactly the seeded plans, in order', () => {
    expect(PRICING.plans.map(p => p.key)).toEqual(rows.map(r => r.plan));
  });

  for (const row of seedRows()) {
    it(`${row.plan}: members, file size, storage and audit log`, () => {
      const plan = PRICING.plans.find(p => p.key === row.plan)!;
      expect(Number(plan.limits.members)).toBe(row.maxMembers);
      expect(bytes(plan.limits.file)).toBe(row.maxFileBytes);
      expect(bytes(plan.limits.storage)).toBe(row.storageQuotaBytes);
      expect(plan.limits.audit).toBe(row.auditLog);
      const d = PLAN_DEFAULTS[row.plan as keyof typeof PLAN_DEFAULTS];
      expect(d.members).toBe(row.maxMembers);
      expect(d.fileMb * MB).toBe(row.maxFileBytes);
      expect(d.storageGb * GB).toBe(row.storageQuotaBytes);
      expect(d.flows).toBe(row.maxFlows);
      expect(plan.limits.flows).toBe(row.maxFlows > 0 ? `Up to ${row.maxFlows}` : 'Not included');
    });
  }

  it('feature bullets quote the same member limit', () => {
    for (const plan of PRICING.plans) {
      expect(plan.features.some(f => f === `Up to ${plan.limits.members} members`)).toBe(true);
    }
  });

  it('the free plan equals the strictest fallback in entitlements.ts', () => {
    const src = read('src/server/entitlements.ts');
    const fallback = /FALLBACK_LIMITS: PlanLimits = \{([^}]*)\}/.exec(src)![1]!;
    const value = (key: string) => {
      const expr = new RegExp(`${key}: ([\\d *]+),`).exec(fallback)![1]!;
      return expr.split('*').reduce((n, part) => n * Number(part.trim()), 1);
    };
    expect(value('maxMembers')).toBe(PLAN_DEFAULTS.free.members);
    expect(value('maxFileBytes')).toBe(PLAN_DEFAULTS.free.fileMb * MB);
    expect(value('storageQuotaBytes')).toBe(PLAN_DEFAULTS.free.storageGb * GB);
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
    maxMembers: Number(p.limits.members),
    maxFileBytes: bytes(p.limits.file),
    storageQuotaBytes: bytes(p.limits.storage),
    maxFlows: 0,
    auditLog: p.limits.audit,
  });
  const workspace = (plan: string) => ({id: 1, plan, memberCount: 1, storageUsedBytes: 0, graceUntil: null});

  it('PAID: the entitlements a plan gets equal the numbers the pricing page shows', () => {
    for (const plan of PRICING.plans) {
      const e = computeEntitlements({limits: limits(plan), workspace: workspace(plan.key), mode: 'PAID'});
      expect(e.limits.maxMembers).toBe(Number(plan.limits.members));
      expect(e.limits.maxFileBytes).toBe(bytes(plan.limits.file));
      expect(e.limits.storageQuotaBytes).toBe(bytes(plan.limits.storage));
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
      expect(e.limits.maxMembers).toBeGreaterThanOrEqual(Number(plan.limits.members));
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

#!/usr/bin/env node
/**
 * Keeps this site current with the platform and the template it started from.
 * Runs on a development machine or in the editor (never deployed). Node 22+,
 * plus `tar` and `git` on the PATH. No dependencies.
 *
 *   npm run platform -- docs [--site URL]   live platform docs → .platform/docs/ (git-ignored)
 *   npm run platform -- check [--from DIR]  the template's own files untouched (scripts/managed-files.json),
 *                                            a store listing's sample data, and is a newer release out?
 *                                            Exit 1: something to fix; 10: a newer release; 0: all good.
 *   npm run platform -- upgrade [--to vX.Y.Z] [--from DIR] [--base DIR] [--dry-run]
 *   npm run platform -- jobs                 check background.json and its handlers (no network)
 *   npm run platform -- prices               the payments catalogue (sandbox in the editor)
 *   npm run platform -- prices currencies    the currencies a new price may use (the providers')
 *   npm run platform -- prices add --key pro-monthly --name "Pro" --amount-cents 1999 --currency USD
 *                         --interval month|year|one_time [--interval-count 1] [--trial-days 14] [--description "…"]
 *                                            add a sandbox price (docs/agent/payments.md). Needs the
 *                                            editor's SITE_KEY and SITE_URL (the editor sets both).
 *   npm run platform -- plans [--write]      the owner's real client plans (owner's own website only);
 *                                            --write saves them to src/content/plans.json
 *                                            (docs/agent/plans-catalogue.md). Same SITE_KEY + SITE_URL.
 *   npm run platform -- setup                your own computer: checks Node and packages, makes .env (a new
 *                                            JWT_SECRET), checks the database, runs the migrations (`npm run setup`)
 *   npm run platform -- dev-admin <email>    LOCAL DEVELOPMENT ONLY: gives a user you signed up on your
 *                                            own machine the `admin` role, in a LOCAL database. Refused
 *                                            with a SITE_KEY, SITE_PREVIEW or NODE_ENV=production, and when
 *                                            DATABASE_URL is not local. Never makes an owner
 *                                            (docs/agent/auth.md "On your own machine").
 *
 * WHERE RELEASES COME FROM: `template.json` `repo`.
 *   - `file:<path>` (today: the platform's templates are not published yet) — a
 *     folder holding the template at its NEWEST version, e.g.
 *     `file:templates/astro-static` inside a platform checkout. A relative
 *     path resolves against `$SITE_DIR` (that checkout's root), else
 *     against this project. `--from DIR` points at the folder directly.
 *     A folder holds one version, so `upgrade` merges 3-way only when
 *     `--base DIR` gives a copy of the OLD version; without it, files you
 *     changed are left as they are and listed for you to compare.
 *   - `owner/name` — a GitHub repository with `vX.Y.Z` tags (later).
 *   In the editor, the platform provides the newest template as a folder: `upgrade --from <it>`
 *   (docs/agent/upgrade.md). A clone of the template's repository on a developer's own computer
 *   takes releases with git instead (`git fetch upstream --tags`, then `git merge v<newest>`); `check`
 *   reads the `upstream` remote's tags. Files that a `--from` folder's `.gitignore` names one by
 *   one (files that came with it, not the template) are never copied in.
 *
 * UPGRADE, file by file, from the version in `template.json` to the target:
 *   - MANAGED paths (`src/platform/**`, `docs/agent/**`, this script, its `managed-files.json`,
 *     `CHANGELOG.md`) are the template's own: replaced wholesale. Do not edit them; extend them from
 *     your own code instead.
 *   - Everything else is a 3-way merge (`git merge-file`): base = the old
 *     template, ours = your file, theirs = the new template. Your changes are
 *     kept; a clash is written with conflict markers and listed at the end.
 *   - A file you deleted stays deleted; a file the template added is added
 *     (unless you already have one at that path, which is merged).
 * Then `template.json` records the new version. Review with `git diff`, solve
 * the listed conflicts, run `npm install`, `npm run build`.
 */
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = process.cwd();
const MANIFEST = join(ROOT, 'template.json');
const MANAGED = [/^src\/platform\//, /^docs\/agent\//, /^scripts\/platform\.mjs$/, /^scripts\/managed-files\.json$/, /^CHANGELOG\.md$/];
/** This release's managed files and their sha256 (`check` compares them; never edit it). */
const MANAGED_LIST_REL = 'scripts/managed-files.json';
const MANAGED_LIST = join(ROOT, MANAGED_LIST_REL);
/** A store listing of this template must ship sample data (prisma/seed.sql). */
const SEED_REQUIRED = true;
const NEVER = [/^\.git\//, /^node_modules\//, /^dist\//, /^\.astro\//, /^\.wrangler\//, /^\.platform\//, /(^|\/)\.DS_Store$/, /^src\/generated\//, /^template\.json$/, /^\.env$/, /^\.dev\.vars/];
const SKIP_IN_MERGE = [/^package-lock\.json$/];

const [command = 'help', ...args] = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function readManifest() {
  if (!existsSync(MANIFEST)) throw new Error('template.json not found: run this from the project root.');
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

const semver = tag => tag.replace(/^v/, '').split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

async function github(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'site-platform-script'},
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return res;
}

/** `file:` source: the folder that holds the template's newest version. */
function localSource(repo) {
  const from = option('--from');
  if (from) return resolve(ROOT, from);
  if (!repo?.startsWith('file:')) return null;
  const path = repo.slice('file:'.length);
  if (isAbsolute(path)) return path;
  return resolve(process.env.SITE_DIR || ROOT, path);
}

const DOWNLOADED_COPY_HELP = [
  'This copy has no newer template next to it to compare with.',
  'A clone of the template\'s repository: keep it as the "upstream" remote (git remote -v), then',
  '  git fetch upstream --tags',
  '  git merge "$(git describe --tags --abbrev=0 upstream/main)"',
  'In the editor, the platform provides the newest template: follow docs/agent/upgrade.md (it passes --from).',
  'In a platform checkout, set SITE_DIR to its root.',
].join('\n');

function localVersion(dir) {
  const file = join(dir, 'template.json');
  if (!existsSync(file)) {
    if (!option('--from') && !process.env.SITE_DIR) throw new Error(`no template folder at ${dir}.\n${DOWNLOADED_COPY_HELP}`);
    throw new Error(`no template.json in ${dir}: pass --from <the unzipped template folder> or set SITE_DIR.`);
  }
  const {version} = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`${file} has no X.Y.Z version.`);
  return `v${version}`;
}

async function latestTag(repo) {
  const local = localSource(repo);
  if (local) return localVersion(local);
  const tags = await (await github(`/repos/${repo}/tags?per_page=100`)).json();
  const versions = tags.map(t => t.name).filter(n => /^v\d+\.\d+\.\d+$/.test(n));
  if (!versions.length) throw new Error(`no release tags on ${repo}`);
  return versions.reduce((best, tag) => (newer(tag, best) ? tag : best));
}

/** Downloads and unpacks `repo@tag`; returns the folder holding the project. */
async function fetchTemplate(repo, tag, into) {
  const res = await github(`/repos/${repo}/tarball/${tag}`);
  const file = join(into, `${tag}.tar.gz`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const dir = join(into, tag);
  mkdirSync(dir, {recursive: true});
  execFileSync('tar', ['-xzf', file, '-C', dir, '--strip-components=1']);
  return dir;
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).split('\\').join('/');
    if (NEVER.some(re => re.test(rel + (statSync(full).isDirectory() ? '/' : '')))) continue;
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(rel);
  }
  return out;
}

/**
 * Files a downloaded copy carries that are not the template's: its `.gitignore` names them one by
 * one (a plain file name on its own line, no wildcard). They are never copied into the project.
 */
function downloadOnlyFiles(dir) {
  const file = join(dir, '.gitignore');
  if (!existsSync(file)) return new Set();
  const names = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^\//, ''))
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!') && !/[*?[\]\/]/.test(line) && /\.[A-Za-z0-9]+$/.test(line));
  return new Set(names.filter(name => existsSync(join(dir, name)) && statSync(join(dir, name)).isFile()));
}

const read = path => (existsSync(path) ? readFileSync(path) : null);
const same = (a, b) => a !== null && b !== null && Buffer.compare(a, b) === 0;

function write(path, data, dryRun) {
  if (dryRun) return;
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, data);
}

async function docs() {
  const site = (option('--site') ?? process.env.SITE_URL ?? '').replace(/\/+$/, '');
  if (!site) throw new Error('pass --site https://<your site host> (or set SITE_URL).');
  const out = join(ROOT, '.platform', 'docs');
  mkdirSync(out, {recursive: true});
  const get = url => fetch(url, {headers: {'user-agent': 'site-platform-script'}}).catch(() => null);

  // The platform's rules for sites (core + topics). The template's own copy is
  // docs/agent/; the live one wins when they differ.
  const base = `${site}/api/public/site/v1/agent-docs`;
  const index = await get(base);
  if (!index?.ok) throw new Error(`nothing saved: ${base} answered ${index?.status ?? 'no response'}.`);
  const core = await index.text();
  writeFileSync(join(out, 'core.md'), core);
  const topics = [...new Set([...core.matchAll(/([a-z0-9-]+(?:\/[a-z0-9-]+)?)\.md/g)].map(m => m[1]))];
  let saved = 1;
  for (const topic of topics) {
    const res = await get(`${base}/${topic}.md`);
    if (!res?.ok) continue;
    write(join(out, `${topic}.md`), await res.text(), false);
    saved++;
  }
  const version = core.match(/\(v([0-9a-f]{6,})\)/)?.[1] ?? 'unknown';
  writeFileSync(join(out, 'VERSION'), `${version}\n`);
  console.log(`saved ${saved} docs (platform rules v${version}) to .platform/docs/ — start with core.md.`);
}

/**
 * The template's own files (`scripts/managed-files.json`, this release's list: path → sha256),
 * compared byte for byte with this project. Changed, missing and (under its folders) added files,
 * with the git command that puts the template's copies back.
 */
function managedProblems(manifest) {
  const restoreHint = rels => `put back the template's copies: git checkout v${manifest.version} -- ${rels.join(' ')}`;
  if (!existsSync(MANAGED_LIST)) return {problems: [`${MANAGED_LIST_REL}: missing`], restore: [MANAGED_LIST_REL], restoreHint};
  let list;
  try {
    list = JSON.parse(readFileSync(MANAGED_LIST, 'utf8'));
  } catch {
    return {problems: [`${MANAGED_LIST_REL}: not valid JSON`], restore: [MANAGED_LIST_REL], restoreHint};
  }
  if (list.version !== manifest.version) {
    return {
      problems: [`template.json says ${manifest.version}, but ${MANAGED_LIST_REL} (like the rest of the template's files) is for ${list.version}: a merge was left half done, or template.json was edited`],
      restore: ['template.json'],
      // The release the other files are on: managed-files.json comes with them, template.json is one small file.
      restoreHint: rels => `finish the merge (git merge v${list.version}), or put back the template's copy: git checkout v${list.version} -- ${rels.join(' ')}`,
    };
  }
  const problems = [];
  const restore = [];
  const hash = buf => createHash('sha256').update(buf).digest('hex');
  for (const [rel, want] of Object.entries(list.files ?? {})) {
    const got = read(join(ROOT, rel));
    if (got === null) {
      problems.push(`${rel}: missing`);
      restore.push(rel);
    } else if (hash(got) !== want) {
      const crlf = got.includes(13) && hash(Buffer.from(got.toString('utf8').replace(/\r\n/g, '\n'))) === want;
      problems.push(`${rel}: ${crlf ? 'Windows line endings (CRLF); the template uses LF (git add --renormalize .)' : 'changed'}`);
      restore.push(rel);
    }
  }
  for (const dir of list.dirs ?? []) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    for (const rel of listFiles(full, ROOT)) if (!(rel in (list.files ?? {}))) problems.push(`${rel}: added (move your code out of ${dir}, then git rm it)`);
  }
  return {problems, restore, restoreHint, list};
}

/** A store listing (this project holds the store's own check, store-check.mjs) of a web app ships sample data. */
function seedProblems(list) {
  if (!SEED_REQUIRED || !existsSync(join(ROOT, 'store-check.mjs'))) return {problems: [], notes: []};
  const seed = read(join(ROOT, 'prisma', 'seed.sql'));
  const text = seed ? seed.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim() : '';
  if (!text) return {problems: ['prisma/seed.sql: missing or empty (seed_missing). Add sample data so the store preview shows a working app.'], notes: []};
  if (!/\binsert\s+into\b/i.test(text)) return {problems: ['prisma/seed.sql: adds no rows (seed_empty). Give it at least one INSERT of sample data.'], notes: []};
  const example = list?.exampleSeed;
  if (example && createHash('sha256').update(seed).digest('hex') === example) {
    return {problems: [], notes: ['prisma/seed.sql is still the template\'s example data: replace it with sample data for your app.']};
  }
  return {problems: [], notes: []};
}

/** The newest `vX.Y.Z` tag of the `upstream` git remote: {tag}, {error}, or null without that remote. */
function upstreamLatest() {
  let remotes = '';
  try {
    remotes = execFileSync('git', ['remote'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    return null;
  }
  if (!remotes.split('\n').includes('upstream')) return null;
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'upstream'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000});
    const tags = out.split('\n').map(line => line.trim().split(/\s+/)[1]?.replace('refs/tags/', '')).filter(t => /^v\d+\.\d+\.\d+$/.test(t ?? ''));
    if (!tags.length) return {error: 'the upstream remote has no release tags'};
    return {tag: tags.reduce((best, t) => (newer(t, best) ? t : best))};
  } catch {
    return {error: 'the upstream remote did not answer (offline?)'};
  }
}

async function check() {
  const manifest = readManifest();
  const current = `v${manifest.version}`;
  let failed = false;

  // 1. The template's own files: untouched (a store listing is refused otherwise).
  const managed = managedProblems(manifest);
  // A site's own rules may follow the template's at the end of AGENTS.md (upgrade.md); a store
  // listing (it holds store-check.mjs) keeps AGENTS.md, CLAUDE.md and GEMINI.md exactly.
  const store = existsSync(join(ROOT, 'store-check.mjs'));
  const ownRules = rel => !store && /^(AGENTS|CLAUDE|GEMINI)\.md$/.test(rel);
  const soft = managed.problems.filter(p => ownRules(p.split(':')[0]));
  const hard = managed.problems.filter(p => !soft.includes(p));
  const restore = managed.restore.filter(rel => !ownRules(rel));
  for (const line of soft) console.log(`note: ${line} (fine if this site added its own rules at its end; the template's part stays as it is)`);
  if (hard.length) {
    failed = true;
    console.log(`template files changed (never edit them):\n  ${hard.join('\n  ')}`);
    if (restore.length) console.log(`fix: ${managed.restoreHint(restore)}`);
  } else if (soft.length) {
    console.log(`template files: the rest untouched (release ${manifest.version}).`);
  } else {
    console.log(`template files: untouched (${Object.keys(managed.list?.files ?? {}).length} files, release ${manifest.version}).`);
  }

  // 2. A store listing's sample data.
  const seed = seedProblems(managed.list);
  for (const line of seed.problems) console.log(line);
  for (const line of seed.notes) console.log(`note: ${line}`);
  if (seed.problems.length) failed = true;

  // 3. Is a newer release out? The upstream remote (a clone of the template's repository), else
  //    the folder holding the newest template (`--from`, a `file:` repo, the editor's copy).
  let latest = null;
  const upstream = option('--from') ? null : upstreamLatest();
  if (upstream?.tag) latest = upstream.tag;
  else if (upstream?.error) console.log(`note: couldn't check for a newer release: ${upstream.error}.`);
  else {
    try {
      latest = await latestTag(manifest.repo);
    } catch (error) {
      if (option('--from') || process.env.SITE_DIR) throw error;
      console.log(`note: couldn't check for a newer release.\n${DOWNLOADED_COPY_HELP}`);
    }
  }
  if (latest && newer(latest, current)) {
    console.log(
      upstream?.tag
        ? `Your template is ${manifest.version}; the current one is ${latest.replace(/^v/, '')}. Merge it before you submit: git fetch upstream --tags, then git merge ${latest}, then npm install, npm run check and node store-check.mjs.`
        : `template ${current} → ${latest} is available. Read its CHANGELOG, then: npm run platform -- upgrade`
    );
    if (!failed) process.exitCode = 10;
  } else if (latest) {
    console.log(`up to date (template ${current}).`);
  }
  if (failed) process.exitCode = 1;
}

async function upgrade() {
  const manifest = readManifest();
  const dryRun = flag('--dry-run');
  const from = `v${manifest.version}`;
  const to = option('--to') ?? (await latestTag(manifest.repo));
  if (!newer(to, from)) return console.log(`nothing to do: ${from} is not older than ${to}.`);
  if (!dryRun) {
    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], {cwd: ROOT}).toString().trim();
      if (dirty && !flag('--force')) {
        throw new Error('commit or stash your changes first (or pass --force), so the upgrade is one reviewable diff.');
      }
    } catch (error) {
      if (error.message.startsWith('commit')) throw error;
    }
  }

  const work = mkdtempSync(join(tmpdir(), 'site-upgrade-'));
  try {
    const local = localSource(manifest.repo);
    let oldDir, newDir;
    if (local) {
      if (to !== localVersion(local)) throw new Error(`${local} holds ${localVersion(local)}, not ${to}.`);
      newDir = local;
      oldDir = option('--base') ? resolve(ROOT, option('--base')) : null;
      if (oldDir && localVersion(oldDir) !== from) throw new Error(`--base holds ${localVersion(oldDir)}, not ${from}.`);
    } else {
      [oldDir, newDir] = await Promise.all([
        fetchTemplate(manifest.repo, from, work),
        fetchTemplate(manifest.repo, to, work),
      ]);
    }
    const extras = downloadOnlyFiles(newDir);
    const files = new Set([...(oldDir ? listFiles(oldDir) : []), ...listFiles(newDir)].filter(rel => !extras.has(rel)));
    const report = {replaced: [], merged: [], added: [], removed: [], conflicts: [], kept: []};

    for (const rel of [...files].sort()) {
      const base = oldDir ? read(join(oldDir, rel)) : null;
      const theirs = read(join(newDir, rel));
      const oursPath = join(ROOT, rel);
      const ours = read(oursPath);
      if (same(base, theirs)) continue; // the template did not change this file
      if (!oldDir && same(ours, theirs)) continue; // already the new version

      if (MANAGED.some(re => re.test(rel))) {
        if (theirs === null) {
          if (ours !== null && !dryRun) rmSync(oursPath);
          report.removed.push(rel);
        } else {
          write(oursPath, theirs, dryRun);
          report.replaced.push(rel);
        }
        continue;
      }
      if (SKIP_IN_MERGE.some(re => re.test(rel))) {
        report.kept.push(`${rel} (regenerate with npm install)`);
        continue;
      }
      if (theirs === null) {
        report.kept.push(`${rel} (removed upstream; delete it yourself if unused)`);
        continue;
      }
      if (!oldDir) {
        if (ours === null) {
          write(oursPath, theirs, dryRun);
          report.added.push(rel);
        } else {
          report.kept.push(`${rel} (differs from ${to}; no --base to merge against: compare it yourself)`);
        }
        continue;
      }
      if (ours === null) {
        if (base === null) {
          write(oursPath, theirs, dryRun);
          report.added.push(rel);
        } else {
          report.kept.push(`${rel} (you deleted it; upstream changed it)`);
        }
        continue;
      }
      if (same(ours, base) || same(ours, theirs)) {
        write(oursPath, theirs, dryRun);
        report.merged.push(rel);
        continue;
      }
      // 3-way merge: ours ← (base → theirs)
      const tmpOurs = join(work, 'ours'), tmpBase = join(work, 'base'), tmpTheirs = join(work, 'theirs');
      writeFileSync(tmpOurs, ours);
      writeFileSync(tmpBase, base ?? Buffer.alloc(0));
      writeFileSync(tmpTheirs, theirs);
      let conflicts = 0;
      try {
        execFileSync('git', ['merge-file', '-L', 'yours', '-L', from, '-L', to, tmpOurs, tmpBase, tmpTheirs]);
      } catch (error) {
        conflicts = error.status ?? 1;
      }
      write(oursPath, readFileSync(tmpOurs), dryRun);
      (conflicts ? report.conflicts : report.merged).push(conflicts ? `${rel} (${conflicts})` : rel);
    }

    if (!dryRun) writeFileSync(MANIFEST, `${JSON.stringify({...manifest, version: to.replace(/^v/, '')}, null, 2)}\n`);

    const show = (title, list) => list.length && console.log(`\n${title}:\n  ${list.join('\n  ')}`);
    console.log(`${dryRun ? '[dry run] ' : ''}template ${from} → ${to}`);
    show('replaced (managed)', report.replaced);
    show('merged', report.merged);
    show('added', report.added);
    show('removed (managed)', report.removed);
    show('left as is', report.kept);
    show('CONFLICTS — search for <<<<<<< and resolve', report.conflicts);
    console.log('\nnext: read CHANGELOG.md, resolve conflicts, npm install, npm run build, git diff.');
    if (report.conflicts.length) process.exitCode = 2;
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

/**
 * `jobs`: the same checks the platform runs on background.json when you publish (names, keys,
 * timing, time zones), plus: every list a schedule uses has a handler in src/server/background.ts.
 * Offline; prints every problem at once.
 */
async function jobs() {
  const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const EVERY = new Set(['minute', 'hour', 'day', 'weekday', 'week', 'month']);
  const file = join(ROOT, 'background.json');
  const problems = [];
  if (!existsSync(file)) {
    console.log('background.json: none (no schedules). Sending jobs still works.');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`background.json is not valid JSON: ${error.message}`);
  }
  const lists = manifest.lists ?? {};
  const schedules = manifest.schedules ?? {};
  for (const key of Object.keys(manifest)) if (!['lists', 'schedules', '$schema'].includes(key)) problems.push(`unknown key "${key}"`);
  for (const [name, list] of Object.entries(lists)) {
    if (!NAME.test(name)) problems.push(`lists.${name}: lower-case letters, digits, dashes`);
    for (const key of Object.keys(list ?? {})) if (!['retries', 'concurrency', 'label', 'ordered'].includes(key)) problems.push(`lists.${name}: unknown key "${key}"`);
    if (list?.ordered !== undefined && typeof list.ordered !== 'boolean') problems.push(`lists.${name}.ordered: true or false`);
    if (list?.retries !== undefined && !(Number.isInteger(list.retries) && list.retries >= 0 && list.retries <= 9)) problems.push(`lists.${name}.retries: 0 to 9`);
    if (list?.concurrency !== undefined && !(Number.isInteger(list.concurrency) && list.concurrency >= 1 && list.concurrency <= 100)) problems.push(`lists.${name}.concurrency: 1 to 100`);
  }
  const needed = new Set(Object.keys(lists));
  for (const [name, s] of Object.entries(schedules)) {
    const where = `schedules.${name}`;
    if (!NAME.test(name)) problems.push(`${where}: lower-case letters, digits, dashes`);
    for (const key of Object.keys(s ?? {})) if (!['list', 'cron', 'every', 'at', 'day', 'tz', 'label', 'data'].includes(key)) problems.push(`${where}: unknown key "${key}"`);
    const list = s?.list ?? name;
    if (!NAME.test(list)) problems.push(`${where}.list: a list name`);
    needed.add(list);
    if ((s?.cron === undefined) === (s?.every === undefined)) problems.push(`${where}: give "cron" OR "every"`);
    if (s?.cron !== undefined) {
      const fields = String(s.cron).trim().split(/\s+/);
      if (fields.length !== 5) problems.push(`${where}.cron: 5 fields (minute hour day month weekday)`);
      else if (fields[2] !== '*' && fields[4] !== '*') problems.push(`${where}.cron: a day of the month OR a weekday, not both (use two schedules)`);
    }
    if (s?.every !== undefined && !EVERY.has(s.every)) problems.push(`${where}.every: one of ${[...EVERY].join(', ')}`);
    if (s?.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) problems.push(`${where}.at: "HH:MM" (24-hour)`);
    if (s?.day !== undefined && !(Number.isInteger(s.day) && s.day >= 0 && s.day <= 6)) problems.push(`${where}.day: 0 (Sunday) to 6 (Saturday)`);
    if (s?.tz !== undefined) {
      try {
        new Intl.DateTimeFormat('en', {timeZone: s.tz});
      } catch {
        problems.push(`${where}.tz: "${s.tz}" is not a time zone`);
      }
    }
  }
  const handlersFile = join(ROOT, 'src/server/background.ts');
  const handlers = existsSync(handlersFile) ? readFileSync(handlersFile, 'utf8').replace(/\/\/.*$/gm, '') : '';
  for (const list of needed) {
    if (!new RegExp(`['"]?${list}['"]?\\s*:`).test(handlers)) problems.push(`no handler for "${list}" in src/server/background.ts`);
  }
  if (problems.length) {
    console.log(`background.json: ${problems.length} problem(s)\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`background.json: ok (${Object.keys(lists).length} list(s), ${Object.keys(schedules).length} schedule(s)). The platform checks it again when you publish.`);
}

/* Payments catalogue (docs/agent/payments.md): the editor's Site Key, never printed. */
async function prices() {
  const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SITE_KEY ?? '';
  if (!site || !key) throw new Error('needs SITE_URL and SITE_KEY (the editor sets both; ask the owner to add prices in the dashboard otherwise).');
  const call = async (method, path, body) => {
    const res = await fetch(`${site}/api/site/v1/payments${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': 'site-platform-script',
        ...(body ? {'content-type': 'application/json'} : {}),
      },
      ...(body ? {body: JSON.stringify(body)} : {}),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!res) throw new Error('the platform did not answer.');
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      const error = answer?.errors?.[0];
      throw new Error(`${error?.code ?? res.status}: ${error?.message ?? 'refused.'}`);
    }
    return answer?.data;
  };
  if (args[0] === 'currencies') {
    const out = await call('GET', '/currencies');
    if (out.unreadable) console.log("the payment providers couldn't be read just now; any common currency is accepted.");
    else if (!out.connected) console.log('no payment provider is connected yet: any common currency is accepted. Ask the owner which one they will use.');
    for (const c of out.currencies ?? []) {
      const by = c.gateways?.length ? `  ${c.gateways.map(g => g.name).join(', ')}` : '';
      console.log(`  ${c.code}${c.subscriptions ? '' : '  (one-time only)'}${by}`);
    }
    return;
  }
  if (args[0] === 'add') {
    const interval = option('--interval') ?? 'one_time';
    const body = {
      key: option('--key'),
      name: option('--name'),
      amountCents: Number(option('--amount-cents')),
      currency: (option('--currency') ?? '').toUpperCase(),
      interval,
      ...(option('--description') ? {description: option('--description')} : {}),
      ...(option('--interval-count') ? {intervalCount: Number(option('--interval-count'))} : {}),
      ...(option('--trial-days') ? {trialDays: Number(option('--trial-days'))} : {}),
    };
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.key ?? '')) throw new Error('--key: lower-case letters, digits and dashes (pro-monthly).');
    if (!body.name) throw new Error('--name: what the buyer sees.');
    if (!Number.isInteger(body.amountCents) || body.amountCents < 1) throw new Error('--amount-cents: whole minor units (1999 = 19.99).');
    if (!/^[A-Z]{3}$/.test(body.currency)) throw new Error('--currency: a 3-letter code (USD).');
    if (!['one_time', 'month', 'year'].includes(interval)) throw new Error('--interval: one_time, month or year.');
    const {price} = await call('POST', '/prices', body);
    console.log(`price "${price.key}": ${price.name}, ${price.amountCents} ${price.currency} ${price.interval} (sandbox). Use it as <BuyButton price="${price.key}" />.`);
    return;
  }
  const catalogue = await call('GET', '');
  console.log(`mode: ${catalogue.mode}${catalogue.ready ? '' : ' (not ready: the owner sets up payments in the dashboard)'}`);
  if (!catalogue.prices?.length) console.log('no prices yet: npm run platform -- prices add --key … (see docs/agent/payments.md)');
  for (const p of catalogue.prices ?? []) {
    const every = p.interval === 'one_time' ? 'once' : `every ${p.intervalCount > 1 ? `${p.intervalCount} ` : ''}${p.interval}`;
    console.log(`  ${p.key.padEnd(24)} ${String(p.amountCents).padStart(9)} ${p.currency} ${every}${p.trialDays ? `, ${p.trialDays}-day trial` : ''}  ${p.name}`);
  }
}

/*
 * `plans` (docs/agent/plans-catalogue.md): the owner's REAL client plans, read with the editor's
 * Site Key (never printed), so a pricing section's build-time fallback is never invented.
 * `--write` saves the answer to src/content/plans.json, the shape the live script reads.
 */
async function plans() {
  const site = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SITE_KEY ?? '';
  if (!site || !key) throw new Error('needs SITE_URL and SITE_KEY (the editor sets both).');
  const res = await fetch(`${site}/api/site/v1/plans`, {
    headers: {accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'site-platform-script'},
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!res) throw new Error('the platform did not answer.');
  if (res.status === 404) {
    console.log("no plans to show: this site isn't the owner's own website (plans-catalogue.md is not for it).");
    return;
  }
  const answer = await res.json().catch(() => null);
  if (!res.ok) {
    const error = answer?.errors?.[0];
    throw new Error(`${error?.code ?? res.status}: ${error?.message ?? 'refused.'}`);
  }
  const catalogue = answer?.data ?? {};
  const closed = catalogue.checkoutOpen === false ? ` (not open yet: ${catalogue.opensLaterReason ?? 'payments'}; paid buttons show "Coming soon")` : '';
  console.log(`sign-up: ${catalogue.signupUrl}${closed}`);
  if (!catalogue.plans?.length) console.log('no plans yet: the owner adds them in the dashboard. Keep a plain sign-up link.');
  for (const p of [...(catalogue.plans ?? []), ...(catalogue.addons ?? [])]) {
    const shown = (p.prices ?? [])
      .filter(price => price.availability === 'open')
      .map(price => `${price.amount} ${price.currency} ${price.interval ? `/${price.interval}` : price.priceType}${price.trialDays ? ` (${price.trialDays}-day trial)` : ''}`);
    console.log(`  ${p.kind === 'addon' ? 'add-on ' : ''}${String(p.code).padEnd(20)} ${p.name}: ${shown.join(', ') || 'no open price (leave it out)'}`);
  }
  if (flag('--write')) {
    const file = join(ROOT, 'src', 'content', 'plans.json');
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, `${JSON.stringify(catalogue, null, 2)}\n`);
    console.log('wrote src/content/plans.json: build the pricing section from it. Run this again when the owner changes plans.');
  }
}

/*
 * `dev-admin <email>`: LOCAL DEVELOPMENT ONLY (docs/agent/auth.md "On your own machine"). On your
 * computer nobody can press "View as admin", so this gives a user you signed up locally the
 * `admin` role. It never makes an `owner`: the owner comes only from the dashboard.
 *
 * Refused, before any connection, unless ALL hold:
 *   - no SITE_KEY (every hosted site, its Preview and staging have one), no SITE_PREVIEW, and
 *     NODE_ENV is not `production`;
 *   - DATABASE_URL is a plain `postgres://` / `postgresql://` URL whose host is THIS computer
 *     (`localhost`, `*.localhost`, `127.x.x.x`, `::1`) or a name with no dot in it (a
 *     docker compose service such as `postgres` or `db`), with no `host=` / `hostaddr=` override.
 *     A Prisma Postgres URL, an IP address elsewhere or any dotted host name is refused.
 */
const LOCAL_HOST = /^(localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/** Why `url` is not a database on this computer, or null when it is. */
export function localDatabaseProblem(url) {
  if (!url) return 'DATABASE_URL is empty: set it in .env to your local Postgres.';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'DATABASE_URL is not a URL.';
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return `DATABASE_URL is a ${parsed.protocol.replace(/:$/, '')} URL, not a local Postgres (postgresql://…@localhost…).`;
  }
  for (const key of parsed.searchParams.keys()) {
    if (/^(host|hostaddr)$/i.test(key)) return `DATABASE_URL sets "${key}=": only a plain local host is accepted.`;
  }
  const host = decodeURIComponent(parsed.hostname);
  if (!host) return 'DATABASE_URL has no host: write it as postgresql://user:password@localhost:5432/name.';
  if (LOCAL_HOST.test(host)) return null;
  // A docker compose service name: one label, not only digits.
  if (SERVICE_NAME.test(host) && !/^\d+$/.test(host)) return null;
  return `DATABASE_URL points at "${host}", which is not this computer: dev-admin only changes a local database.`;
}

/** Why local development mode is off here, or null when it is on. */
export function localDevProblem(environment) {
  if (environment.SITE_KEY) return 'SITE_KEY is set: this copy talks to the platform, where the owner comes from "View as admin".';
  if (environment.SITE_PREVIEW) return 'SITE_PREVIEW is set: this is the editor Preview, where the owner comes from "View as admin".';
  if ((environment.NODE_ENV ?? '').trim().toLowerCase() === 'production') return 'NODE_ENV is production.';
  return null;
}

async function devAdmin() {
  // The same `.env` the dev server and the Prisma CLI read; a variable already set wins.
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  const email = (args[0] ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('usage: npm run dev-admin -- <email of a user you signed up locally>');
  const refused = localDevProblem(process.env) ?? localDatabaseProblem(process.env.DATABASE_URL ?? '');
  if (refused) throw new Error(`refused (local development only): ${refused}`);

  let pg;
  try {
    pg = createRequire(join(ROOT, 'package.json'))('pg');
  } catch {
    throw new Error('the pg package is missing: run npm install first.');
  }
  const client = new pg.Client({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000});
  await client.connect();
  try {
    await client.query('BEGIN');
    const {rows: users} = await client.query(
      'SELECT "id", "status", "platform_owner_id" FROM "users" WHERE "email" = $1 LIMIT 1',
      [email]
    );
    const user = users[0];
    if (!user) {
      throw new Error(
        `no account for ${email} in this database. Sign up first at http://localhost:4321/account/register/ ` +
          '(the code is printed where npm run dev runs), then run this again.'
      );
    }
    if (user.platform_owner_id) {
      await client.query('ROLLBACK');
      console.log(`${email} is the owner account here already. Nothing changed.`);
      return;
    }
    const {rows: roles} = await client.query(`SELECT "id" FROM "roles" WHERE "slug" = 'admin' LIMIT 1`);
    if (!roles.length) throw new Error('this database has no admin role: run npm run db:migrate first.');
    const {rowCount} = await client.query(
      'INSERT INTO "user_roles" ("user_id", "role_id") VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [user.id, roles[0].id]
    );
    if (rowCount) {
      await client.query(
        `INSERT INTO "audit_events" ("actor_user_id", "action", "target_type", "target_id", "meta")
         VALUES (NULL, 'user_roles_changed', 'user', $1, $2)`,
        [String(user.id), JSON.stringify({added: ['admin'], removed: [], via: 'local dev-admin'})]
      );
    }
    await client.query('COMMIT');
    console.log(
      `${email} ${rowCount ? 'is now an admin' : 'was an admin already'} in this LOCAL database (local development only).` +
        `${user.status === 'active' ? '' : ` Its status is "${user.status}": it can't sign in until it is active.`}\n` +
        'Sign in at http://localhost:4321/account/login/ and open /dashboard. The owner role is never given here: on a hosted site the owner opens the admin with "View as admin".'
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/*
 * `setup` (`npm run setup`): gets a copy running on your own computer, step by step, and says
 * what to do next. Safe to run again: it never overwrites a value you set.
 *   1. Node.js 22.12+ and installed packages;
 *   2. `.env` from `.env.example` if missing; an empty JWT_SECRET gets 48 random bytes; an empty
 *      DATABASE_URL gets the local database of `docker-compose.yml`;
 *   3. the database answers (or how to start it);
 *   4. `prisma migrate deploy`.
 */
const LOCAL_DATABASE_URL = 'postgresql://postgres:dev@localhost:5432/site';

function setEnvValue(text, name, value) {
  const line = new RegExp(`^${name}=.*$`, 'm');
  return line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.replace(/\n*$/, '\n')}${name}=${value}\n`;
}

function envValue(text, name) {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  return match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

async function setup() {
  const step = (n, text) => console.log(`\n${n}. ${text}`);
  step(1, 'Node.js and packages');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node.js ${process.versions.node} is too old: install 22.12 or later (\`nvm use\` reads .nvmrc), then run npm run setup again.`);
  }
  let pg;
  try {
    pg = createRequire(join(ROOT, 'package.json'))('pg');
  } catch {
    throw new Error('packages are not installed: run npm install, then npm run setup again.');
  }
  console.log(`   Node.js ${process.versions.node}, packages installed.`);

  step(2, 'Settings (.env)');
  const envFile = join(ROOT, '.env');
  let text;
  if (existsSync(envFile)) {
    text = readFileSync(envFile, 'utf8');
    console.log('   .env is there: only empty values are filled in.');
  } else {
    text = existsSync(join(ROOT, '.env.example')) ? readFileSync(join(ROOT, '.env.example'), 'utf8') : '';
    console.log('   .env made from .env.example (it stays on your computer: git ignores it).');
  }
  if (envValue(text, 'JWT_SECRET').length < 32) {
    text = setEnvValue(text, 'JWT_SECRET', randomBytes(48).toString('base64'));
    console.log('   JWT_SECRET: made a new random one.');
  } else {
    console.log('   JWT_SECRET: kept yours.');
  }
  if (!envValue(text, 'DATABASE_URL')) {
    const port = envValue(text, 'DB_PORT') || '5432';
    text = setEnvValue(text, 'DATABASE_URL', LOCAL_DATABASE_URL.replace(':5432/', `:${port}/`));
    console.log('   DATABASE_URL: the local database from docker-compose.yml.');
  } else {
    console.log('   DATABASE_URL: kept yours.');
  }
  writeFileSync(envFile, text);
  if (envValue(text, 'SITE_KEY')) console.log('   SITE_KEY is set, so local development mode is off (emails go through the platform).');

  step(3, 'The database');
  const url = process.env.DATABASE_URL || envValue(text, 'DATABASE_URL');
  let where = 'the database';
  try {
    const parsed = new URL(url);
    where = `${parsed.hostname}:${parsed.port || 5432}`;
  } catch {
    throw new Error('DATABASE_URL in .env is not a postgresql:// address.');
  }
  const client = new pg.Client({connectionString: url, connectionTimeoutMillis: 5000});
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const code = error?.code ?? '';
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || /timeout/i.test(error?.message ?? '')) {
      throw new Error(`no database answers at ${where}. Start the local one with \`docker compose up -d --wait db\` (Docker must be running), then run npm run setup again.`);
    }
    if (code === '28P01') throw new Error(`the database at ${where} refused the user name or password in DATABASE_URL.`);
    if (code === '3D000') throw new Error(`the database named in DATABASE_URL doesn't exist at ${where}. Create it, or use the one docker-compose.yml makes (${LOCAL_DATABASE_URL}).`);
    throw new Error(`can't reach the database at ${where}: ${error?.message ?? error}`);
  } finally {
    await client.end().catch(() => {});
  }
  console.log(`   ${where} answers.`);

  step(4, 'Tables (migrations)');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {cwd: ROOT, stdio: 'inherit', env: {...process.env, DATABASE_URL: url}});

  console.log(`
Ready. Next:
  npm run dev                              start it: http://localhost:4321
  npm run db:seed                          optional: the sample data (prisma/seed.sql)
Then create your admin account (README "Create your admin account"):
  sign up at http://localhost:4321/account/register/ (the code is printed where npm run dev runs)
  npm run dev-admin -- you@example.com`);
}

const commands = {docs, check, upgrade, jobs, prices, plans, setup, 'dev-admin': devAdmin};
// Run as a command (`npm run platform -- …`), not when a test imports the helpers above.
const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !commands[command]) {
  console.log('usage: npm run platform -- docs [--site URL] | check [--from DIR] | upgrade [--to vX.Y.Z] [--from DIR] [--base DIR] [--dry-run] [--force] | jobs | prices [add --key … --name … --amount-cents … --currency … --interval …] | plans [--write] | setup | dev-admin <email>');
} else if (isMain) {
  commands[command]().catch(error => {
    console.error(`platform ${command}: ${error.message}`);
    process.exitCode = 1;
  });
}

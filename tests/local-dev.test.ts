import {readFileSync} from 'node:fs';

import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';

// @ts-expect-error: a plain Node script, no type declarations.
import {localDatabaseProblem, localDevProblem} from '../scripts/platform.mjs';
import {sendSiteEmail} from '../src/platform/auth/email';
import {config} from '../src/platform/config';
import {localDevAllowed} from '../src/platform/local-dev';

const local = {siteKey: '', preview: false, prodBuild: false, devBuild: true, nodeEnv: 'development'};

describe('local development mode (src/platform/local-dev.ts)', () => {
  it('is on only on a dev build with no Site Key', () => {
    expect(localDevAllowed(local)).toBe(true);
    expect(localDevAllowed({...local, nodeEnv: undefined})).toBe(true);
  });
  it('is refused with a Site Key (every hosted site, its Preview and staging have one)', () => {
    expect(localDevAllowed({...local, siteKey: 'stk_anything'})).toBe(false);
  });
  it('is refused in a production build', () => {
    expect(localDevAllowed({...local, prodBuild: true, devBuild: false})).toBe(false);
    expect(localDevAllowed({...local, prodBuild: true})).toBe(false);
    expect(localDevAllowed({...local, devBuild: false})).toBe(false);
  });
  it('fails closed when the build flags are missing or odd', () => {
    expect(localDevAllowed({...local, prodBuild: undefined})).toBe(false);
    expect(localDevAllowed({...local, devBuild: undefined})).toBe(false);
    expect(localDevAllowed({...local, prodBuild: 'false'})).toBe(false);
  });
  it('is refused with NODE_ENV=production and in the editor Preview', () => {
    expect(localDevAllowed({...local, nodeEnv: 'production'})).toBe(false);
    expect(localDevAllowed({...local, nodeEnv: ' Production '})).toBe(false);
    expect(localDevAllowed({...local, preview: true})).toBe(false);
  });
});

describe('npm run platform -- dev-admin: refused outside a local database (scripts/platform.mjs)', () => {
  it('accepts only this computer or a docker compose service name', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'db.localhost', 'postgres', 'db', 'site-db']) {
      expect(localDatabaseProblem(`postgresql://u:p@${host}:5432/x`), host).toBeNull();
    }
    expect(localDatabaseProblem('postgres://u:p@localhost/x')).toBeNull();
  });
  it('refuses anything else', () => {
    for (const url of [
      '',
      'not a url',
      'prisma+postgres://accelerate.prisma-data.net/?api_key=x',
      'postgresql://u:p@db.prisma.io:5432/x',
      'postgresql://u:p@10.0.0.5:5432/x',
      'postgresql://u:p@192.168.1.2/x',
      'postgresql://u:p@localhost.evil.com/x',
      'postgresql://u:p@localhost/x?host=db.example.com',
      'postgresql://u:p@localhost/x?hostaddr=10.0.0.1',
      'postgresql://u:p@1234/x',
      'mysql://u:p@localhost/x',
    ]) {
      expect(localDatabaseProblem(url), url).not.toBeNull();
    }
  });
  it('refuses with a Site Key, in the Preview and with NODE_ENV=production', () => {
    expect(localDevProblem({})).toBeNull();
    expect(localDevProblem({NODE_ENV: 'development'})).toBeNull();
    expect(localDevProblem({SITE_KEY: 'stk_x'})).not.toBeNull();
    expect(localDevProblem({SITE_PREVIEW: '1'})).not.toBeNull();
    expect(localDevProblem({NODE_ENV: 'production'})).not.toBeNull();
  });
  it('never gives the owner role', () => {
    const script = readFileSync(new URL('../scripts/platform.mjs', import.meta.url), 'utf8');
    const body = script.slice(script.indexOf('async function devAdmin'), script.indexOf('const commands ='));
    expect(body).toContain(`"slug" = 'admin'`);
    expect(body).not.toMatch(/'owner'|platform_owner_id"\s*=\s*\$/);
  });
});

describe('config.localDev and account emails', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    delete env.SITE_KEY;
    delete env.SITE_PREVIEW;
    process.env.NODE_ENV = nodeEnv;
    vi.restoreAllMocks();
  });

  it('reads the real environment: off as soon as a Site Key is set', () => {
    expect(config.localDev).toBe(true);
    env.SITE_KEY = 'stk_test_stub';
    expect(config.localDev).toBe(false);
  });
  it('off in the Preview and with NODE_ENV=production', () => {
    env.SITE_PREVIEW = '1';
    expect(config.localDev).toBe(false);
    delete env.SITE_PREVIEW;
    process.env.NODE_ENV = 'production';
    expect(config.localDev).toBe(false);
  });
  it('prints the sign-up code to the terminal, marked local only, when no Site Key is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent = await sendSiteEmail('http://localhost:4321/site-api/auth/register', {kind: 'sign_up_code', to: 'maya@example.com', code: '123456'});
    expect(sent).toBe(true);
    const out = log.mock.calls.map(call => String(call[0])).join('\n');
    expect(out).toContain('LOCAL DEVELOPMENT ONLY');
    expect(out).toContain('123456');
  });
  it('prints nothing outside local development (NODE_ENV=production, no Site Key)', async () => {
    process.env.NODE_ENV = 'production';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent = await sendSiteEmail('http://localhost:4321/x', {kind: 'sign_up_code', to: 'maya@example.com', code: '123456'});
    expect(sent).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});

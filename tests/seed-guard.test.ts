import {describe, expect, it} from 'vitest';
import {checkSeedTarget} from '../scripts/seed-guard.ts';

describe('seed-demo guard', () => {
  it('allows local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]']) expect(checkSeedTarget(`postgresql://u:p@${h}:5432/app`).ok).toBe(true);
  });
  it('allows _test and _demo database names', () => {
    expect(checkSeedTarget('postgresql://u:p@db.example.com/shop_test').ok).toBe(true);
    expect(checkSeedTarget('postgresql://u:p@db.example.com/shop_demo?sslmode=require').ok).toBe(true);
  });
  it('allows SITE_PREVIEW=1 only', () => {
    expect(checkSeedTarget('postgresql://u:p@db.example.com/app', {SITE_PREVIEW: '1'}).ok).toBe(true);
    expect(checkSeedTarget('postgresql://u:p@db.example.com/app', {SITE_PREVIEW: '0'}).ok).toBe(false);
  });
  it('refuses remote, missing and invalid urls', () => {
    expect(checkSeedTarget('postgresql://u:p@db.example.com/app').ok).toBe(false);
    expect(checkSeedTarget('postgresql://u:p@localhost.evil.com/app').ok).toBe(false);
    expect(checkSeedTarget('postgresql://u:p@db.example.com/demo_app').ok).toBe(false);
    expect(checkSeedTarget(undefined).ok).toBe(false);
    expect(checkSeedTarget('not a url').ok).toBe(false);
  });
  it('never echoes the password or url', () => {
    const r = checkSeedTarget('postgresql://u:s3cretpw@db.example.com/app');
    expect(r.reason).not.toContain('s3cretpw');
    expect(r.reason).not.toContain('db.example.com');
  });
});

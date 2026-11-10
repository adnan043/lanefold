import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const route = readFileSync('src/server/routes/notification-email.ts', 'utf8');
const migration = readFileSync('prisma/migrations/20261104090000_notification_emails/migration.sql', 'utf8');
const en = JSON.parse(readFileSync('src/i18n/messages/en.json', 'utf8')) as Record<string, string>;
const bg = JSON.parse(readFileSync('background.json', 'utf8'));

describe('notification email wiring', () => {
  it('scopes the route to the viewer, requires auth and never touches the address', () => {
    expect(route).toContain('requireAuth');
    expect(route).toContain('userId: c.var.viewer.id!');
    expect(route).not.toMatch(/\.email\b|email:/);
  });
  it('defaults to off and guards the migration', () => {
    expect(migration).toContain("DEFAULT 'off'");
    expect(migration).toContain('IF NOT EXISTS');
    expect(migration).toMatch(/^BEGIN;/m);
  });
  it('has its schedule, list and English strings', () => {
    expect(bg.lists['notification-emails']).toBeDefined();
    expect(bg.schedules['notification-emails']).toBeDefined();
    for (const k of ['title', 'description', 'label', 'hint', 'off', 'digest', 'immediate', 'saving', 'unavailable']) expect(en[`notifEmail.${k}`]).toBeTruthy();
  });
});

import {describe, expect, it} from 'vitest';
import {LOCALES} from '../src/server/validation';
import {NOTIFICATION_STRINGS, renderLocalizedNotificationEmail} from '../src/server/mail/notification-templates';

const LINK = 'https://lane.test/app/';
const FIELDS = ['and', 'subject', 'intro', 'open', 'reason', 'stop', 'off', 'noreply'] as const;

describe('notification templates', () => {
  it('has every field in all 20 languages', () => {
    expect(Object.keys(NOTIFICATION_STRINGS).sort()).toEqual([...LOCALES].sort());
    for (const l of LOCALES) {
      const s = NOTIFICATION_STRINGS[l];
      for (const f of FIELDS) expect(s[f].trim().length, `${l}.${f}`).toBeGreaterThan(0);
      expect(s.mentions.other).toContain('{count}');
      expect(s.assigned.other).toContain('{count}');
      expect(s.and).toContain('{a}');
      expect(s.and).toContain('{b}');
      expect(s.subject).toContain('{summary}');
      expect(s.intro).toContain('{summary}');
    }
  });

  it('renders every language with counts, the link and no leftover placeholders', () => {
    for (const l of LOCALES) {
      for (const counts of [{mentions: 1, assigned: 0}, {mentions: 0, assigned: 3}, {mentions: 2, assigned: 5}, {mentions: 11, assigned: 1}]) {
        const m = renderLocalizedNotificationEmail(counts, LINK, l);
        expect(m.subject + m.text + m.html, l).not.toMatch(/\{\w+\}/);
        expect(m.subject).not.toMatch(/[\r\n]/);
        expect(m.text).toContain('https://lane.test/app/settings/notifications');
        expect(m.html).toContain(`lang="${l}"`);
        expect(m.text + m.html).not.toMatch(/@/);
      }
    }
  });

  it('uses RTL for ar, fa, ur, falls back to English, and escapes the link', () => {
    for (const l of ['ar', 'fa', 'ur']) expect(renderLocalizedNotificationEmail({mentions: 1, assigned: 0}, LINK, l).html).toContain('dir="rtl"');
    expect(renderLocalizedNotificationEmail({mentions: 1, assigned: 0}, LINK, 'xx').subject).toBe('You have 1 mention on Lanefold');
    expect(renderLocalizedNotificationEmail({mentions: 1, assigned: 0}, LINK, null).subject).toBe('You have 1 mention on Lanefold');
    const evil = renderLocalizedNotificationEmail({mentions: 1, assigned: 0}, 'https://x.test/"><script>alert(1)</script>', 'de');
    expect(evil.html).not.toContain('<script>');
  });

  it('picks plural forms (ru, ar)', () => {
    expect(renderLocalizedNotificationEmail({mentions: 5, assigned: 0}, LINK, 'ru').subject).toContain('5 упоминаний');
    expect(renderLocalizedNotificationEmail({mentions: 2, assigned: 0}, LINK, 'ar').subject).toContain('إشارتان');
  });
});

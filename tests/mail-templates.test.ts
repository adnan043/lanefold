import {describe, expect, it} from 'vitest';

import {LOCALES} from '../src/server/validation';
import {clean, escapeHtml, inviteLink, renderInviteEmail} from '../src/server/mail/templates';

const LINK = inviteLink('https://lanefold.example', `iv_${'A'.repeat(43)}`);
const base = {inviterName: 'Ana Silva', workspaceName: 'Design Team', role: 'member', expiresAt: new Date('2026-12-01T10:00:00Z'), link: LINK};

describe('invite email templates', () => {
  it('builds the join link from the site address', () => {
    expect(LINK).toBe(`https://lanefold.example/app/join/iv_${'A'.repeat(43)}`);
    expect(inviteLink('https://lanefold.example/', 'iv_x')).toBe('https://lanefold.example/app/join/iv_x');
  });

  it.each([...LOCALES])('renders %s with the link, the names, no placeholder left and a one-line subject', locale => {
    for (const role of ['viewer', 'member', 'admin']) {
      const mail = renderInviteEmail({...base, role, locale});
      expect(mail.subject).toContain('Ana Silva');
      expect(mail.subject).toContain('Design Team');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.subject.length).toBeLessThanOrEqual(150);
      expect(mail.text).toContain(LINK);
      expect(mail.html).toContain(LINK);
      expect(mail.text).toContain('Design Team');
      for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toMatch(/\{\w+\}|undefined/);
    }
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderInviteEmail({...base, locale: 'xx'}).subject).toBe('Ana Silva invited you to Design Team on Lanefold');
    expect(renderInviteEmail({...base, locale: null}).subject).toBe('Ana Silva invited you to Design Team on Lanefold');
  });

  it('never injects markup from names into the HTML version', () => {
    const mail = renderInviteEmail({...base, locale: 'en', inviterName: '<script>alert(1)</script>', workspaceName: '"><img src=x onerror=alert(1)>'});
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('&quot;&gt;&lt;img');
  });

  it('strips CR/LF and control characters from the subject (no header injection)', () => {
    const mail = renderInviteEmail({...base, locale: 'en', inviterName: 'Ana\r\nBcc: evil@example.com', workspaceName: 'Team\nSubject: x\u0000‮'});
    expect(mail.subject).not.toMatch(/[\r\n\u0000‮]/);
    expect(mail.subject.split('\n')).toHaveLength(1);
  });

  it('caps long names and the subject', () => {
    const mail = renderInviteEmail({...base, locale: 'en', inviterName: 'x'.repeat(500), workspaceName: 'y'.repeat(500)});
    expect(mail.subject.length).toBeLessThanOrEqual(150);
    expect(clean('z'.repeat(500)).length).toBe(60);
  });

  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

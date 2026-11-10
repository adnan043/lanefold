import {afterEach, describe, expect, it, vi} from 'vitest';

import {LOCALES} from '../src/server/validation';
import {clean, inviteLink, renderInviteEmail} from '../src/server/mail/templates';
import {sendMail} from '../src/server/mail/send';

const LINK = inviteLink('https://lanefold.example', `iv_${'A'.repeat(43)}`);
const base = {role: 'member', expiresAt: new Date('2026-12-01T10:00:00Z'), link: LINK, locale: 'en'};
const CREDS = {apiKey: 're_secret_key_12345', from: 'Lanefold <no-reply@example.com>'};

const HOSTILE: Array<[string, string]> = [
  ['script tag', '<script>alert(1)</script>'],
  ['attribute breakout', '"><img src=x onerror=alert(1)>'],
  ['single-quote breakout', "' onmouseover='alert(1)"],
  ['CRLF header injection', 'Team\r\nBcc: evil@example.com\r\nSubject: pwned'],
  ['bidi override', 'abc‮def⁦ghi⁩'],
  ['zero width + BOM', 'a​b‏c﻿d'],
  ['very long', 'x'.repeat(5000)],
  ['emoji', '🚀👩‍💻🇧🇩'.repeat(40)],
  ['NUL and C1', 'a\u0000b\u0085c'],
  ['javascript url as name', 'javascript:alert(1)'],
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hostile names in invite emails', () => {
  for (const locale of [...LOCALES]) {
    it.each(HOSTILE)(`%s is safe in ${locale}`, (_n, evil) => {
      const mail = renderInviteEmail({...base, locale, inviterName: evil, workspaceName: evil});
      expect(mail.subject).not.toMatch(/[\r\n\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩​-‏﻿]/);
      expect(mail.subject.length).toBeLessThanOrEqual(150 * 2);
      expect([...mail.subject].length).toBeLessThanOrEqual(150);
      // No raw markup from a name reaches the HTML: the only tags are the template's own.
      const tags = [...mail.html.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
      expect(new Set(tags)).toEqual(new Set(['html', 'body', 'p', 'br', 'a', 'small', 'bdi'].filter(t => tags.includes(t))));
      expect(mail.html).not.toMatch(/<script|<img/i);
      expect(mail.html).not.toMatch(/‮|⁦|⁧|⁨|⁩|​|﻿/);
      // Plain text: no header-looking line created by a name.
      expect(mail.text).not.toMatch(/^Bcc:/im);
      // (FSI/PDI isolation is the template's own and must stay balanced; no other bidi control or NUL.)
      expect(mail.text).not.toMatch(/[\u0000‪-‮⁧⁪-⁯​‎‏﻿]/);
      expect((mail.text.match(/\u2068/g) ?? []).length).toBe((mail.text.match(/\u2069/g) ?? []).length);
      // The only href is the invite link built by us.
      expect([...mail.html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual([LINK]);
    });
  }

  it('CRLF in a name becomes a space, never a second header or line in the subject', () => {
    const mail = renderInviteEmail({...base, inviterName: 'A\r\nBcc: x@y.z', workspaceName: 'W\nSubject: x'});
    expect(mail.subject).toBe('A Bcc: x@y.z invited you to W Subject: x on Lanefold');
  });

  it('truncates long names by code point (no broken emoji) and bounds the whole email', () => {
    const mail = renderInviteEmail({...base, inviterName: '🚀'.repeat(500), workspaceName: '😀'.repeat(500)});
    expect(mail.subject).not.toMatch(/�/);
    expect(mail.subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(mail.text.length).toBeLessThan(2000);
    expect(mail.html.length).toBeLessThan(3000);
  });

  it('keeps RTL names readable and marks RTL templates dir=rtl, others ltr', () => {
    const name = 'مساحة العمل';
    expect(renderInviteEmail({...base, locale: 'ar', inviterName: name, workspaceName: name}).html).toMatch(/dir="rtl"/);
    expect(renderInviteEmail({...base, locale: 'ur', inviterName: name, workspaceName: name}).html).toMatch(/dir="rtl"/);
    expect(renderInviteEmail({...base, locale: 'fa', inviterName: name, workspaceName: name}).html).toMatch(/dir="rtl"/);
    const en = renderInviteEmail({...base, locale: 'en', inviterName: name, workspaceName: name});
    expect(en.html).toMatch(/dir="ltr"/);
    expect(en.subject).toContain(name);
  });

  it('has a plain-text alternative with the link, an ignore line and a footer; no secrets beyond the link', () => {
    const mail = renderInviteEmail({...base, inviterName: 'Ana', workspaceName: 'Team'});
    expect(mail.text).toContain(LINK);
    expect(mail.text).toMatch(/ignore this email/);
    expect(mail.text).toMatch(/automated message/);
    expect(mail.text.match(/https?:\/\/\S+/g)).toEqual([LINK]);
    expect(mail.text).not.toMatch(/password|code:|secret/i);
    expect(mail.html).not.toMatch(/password|secret/i);
  });

  it('uses only the given link origin (no other URL appears in either body)', () => {
    const mail = renderInviteEmail({...base, inviterName: 'https://evil.example/x', workspaceName: 'http://evil.example'});
    // names are shown as text, but never as a link
    expect([...mail.html.matchAll(/<a\s/g)]).toHaveLength(1);
    expect(inviteLink('https://lanefold.example///', 'iv_t')).toBe('https://lanefold.example/app/join/iv_t');
  });

  it('falls back to a neutral name when a name is only invisible characters', () => {
    const mail = renderInviteEmail({...base, inviterName: '‮​\r\n', workspaceName: '⁦'});
    expect(mail.subject).toBe('Lanefold invited you to Lanefold on Lanefold');
  });

  it('clean() also strips Arabic letter mark, word joiners and soft hyphen', () => {
    expect(clean('a؜b⁠c­d')).not.toMatch(/[؜⁠­]/);
  });
});

describe('name isolation', () => {
  it('wraps names in <bdi> (html) and FSI/PDI (text) but never in the subject', () => {
    for (const locale of [...LOCALES]) {
      const mail = renderInviteEmail({...base, locale, inviterName: 'Ana', workspaceName: 'مساحة'});
      expect(mail.html).toContain('<bdi>Ana</bdi>');
      expect(mail.html).toContain('<bdi>مساحة</bdi>');
      expect(mail.text).toContain('\u2068Ana\u2069');
      expect(mail.text).toContain('\u2068مساحة\u2069');
      expect(mail.subject).not.toMatch(/[\u2066-\u2069\u200B-\u200F\u202A-\u202E]/);
    }
  });

  it('escapes names inside <bdi> and keeps the plain-text link line free of marks', () => {
    const mail = renderInviteEmail({...base, inviterName: '<b>x</b>', workspaceName: 'W'});
    expect(mail.html).toContain('<bdi>&lt;b&gt;x&lt;/b&gt;</bdi>');
    expect(mail.text.split('\n').find(l => l.startsWith('https://'))).toBe(LINK);
  });

  it('keeps ZWNJ/ZWJ in names for the bodies but removes them from the subject', () => {
    const fa = 'می\u200Cخواهم';
    const mail = renderInviteEmail({...base, locale: 'fa', inviterName: fa, workspaceName: '👩\u200D💻'});
    expect(mail.text).toContain(`\u2068${fa}\u2069`);
    expect(mail.html).toContain('<bdi>👩\u200D💻</bdi>');
    expect(mail.subject).not.toMatch(/[\u200C\u200D]/);
    expect(mail.subject).toContain('میخواهم');
  });

  it('a name with a stray joiner cannot add an unbalanced mark or smuggle FSI/PDI', () => {
    const mail = renderInviteEmail({...base, inviterName: '\u2069\u200Dx\u2068', workspaceName: 'W'});
    expect(mail.text).toContain('\u2068x\u2069');
    expect(mail.text.match(/\u2068/g)).toHaveLength(2);
    expect(mail.text.match(/\u2069/g)).toHaveLength(2);
  });
});

describe('mail sending with hostile input', () => {
  it('never sends a subject or address with line breaks, and never leaks the body to logs', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', {status: 200}));
    vi.stubGlobal('fetch', fetchFn);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    expect((await sendMail({to: 'a@b.co', subject: 'x\r\nBcc: e@e.co', text: 't'}, CREDS)).kind).toBe('failed');
    expect((await sendMail({to: 'a@b.co\r\nBcc: e@e.co', subject: 'x', text: 't'}, CREDS)).kind).toBe('failed');
    expect((await sendMail({to: 'a@b.co,e@e.co', subject: 'x', text: 't'}, CREDS)).kind).toBe('failed');
    expect(fetchFn).not.toHaveBeenCalled();
    const mail = renderInviteEmail({...base, inviterName: 'Ana', workspaceName: 'Team'});
    fetchFn.mockRejectedValueOnce(new Error(`boom ${mail.text}`));
    expect((await sendMail({to: 'ana@example.org', subject: mail.subject, text: mail.text}, CREDS)).kind).toBe('retry');
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/ana@example\.org|iv_A/);
  });

  it('sends the idempotency key, a timeout signal, JSON-encoded hostile strings and manual redirects', async () => {
    const fetchFn = vi.fn(async (_u: string, _i: RequestInit) => new Response('{"id":"m1"}', {status: 200}));
    vi.stubGlobal('fetch', fetchFn);
    const mail = renderInviteEmail({...base, inviterName: '"><img onerror=1>', workspaceName: 'W'});
    const r = await sendMail({to: 'ana@example.org', subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: 'invite-1-abc'}, CREDS);
    expect(r).toEqual({kind: 'sent', id: 'm1'});
    const init = fetchFn.mock.calls[0][1];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('invite-1-abc');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string).html).not.toMatch(/<img/);
  });
});

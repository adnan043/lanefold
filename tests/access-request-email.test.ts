import {describe, expect, it} from 'vitest';

import {boardLink, renderAccessApprovedEmail} from '../src/server/mail/access-templates';
import {runAccessApprovedEmail} from '../src/server/jobs/access-request-email';

describe('access approved email', () => {
  it('names the board and the approver, links to the board, in the person\'s language', () => {
    const mail = renderAccessApprovedEmail({locale: 'de', approverName: 'Ann', boardName: 'Launch', link: boardLink('https://site.example/', 42)});
    expect(mail.subject).toContain('Launch');
    expect(mail.text).toContain('https://site.example/app/b/42');
    expect(mail.text).toContain('Ann');
    expect(mail.html).toContain('lang="de"');
  });
  it('falls back to English and keeps hostile names out of the header and the markup', () => {
    const mail = renderAccessApprovedEmail({locale: 'xx', approverName: '<b>x</b>', boardName: 'Evil\r\nBcc: a@b.c <script>', link: 'https://s.example/app/b/1'});
    expect(mail.subject).toMatch(/^You can now open the board/);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>x</b>');
  });
  it('the job refuses a payload that is not a request id', async () => {
    await expect(runAccessApprovedEmail({} as never, {r: 'x'})).rejects.toThrow('Bad payload');
  });
});

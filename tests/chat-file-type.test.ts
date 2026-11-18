import {describe, expect, it} from 'vitest';

import {CHAT_FILE_TYPES, chatFileType} from '../src/lib/chat-files';

describe('chatFileType', () => {
  it('keeps a browser type we take', () => {
    expect(chatFileType('a.png', 'image/png')).toBe('image/png');
    expect(chatFileType('A.PDF', 'APPLICATION/PDF')).toBe('application/pdf');
  });

  it('falls back to the extension when the browser leaves the type empty', () => {
    expect(chatFileType('sheet.xlsx', '')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(chatFileType('notes', '')).toBe('');
  });

  it('takes Windows names for CSV and ZIP (Chrome/Edge with Excel installed)', () => {
    expect(chatFileType('list.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(chatFileType('bundle.zip', 'application/x-zip-compressed')).toBe('application/zip');
    expect(CHAT_FILE_TYPES).toContain(chatFileType('list.csv', 'application/vnd.ms-excel'));
  });

  it('never turns a refused type into an allowed one by its name alone unless the extension is ours', () => {
    expect(chatFileType('page.html', 'text/html')).toBe('text/html');
    expect(chatFileType('x.exe', 'application/x-msdownload')).toBe('application/x-msdownload');
  });
});

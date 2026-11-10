import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {siteFetch} from '../../platform/browser';
import {Menu, useToast} from '../../portal/ui';

/** `attachment; filename="board-2026-01-01.csv"` to the file name, or a plain default. */
const nameOf = (header: string | null, fallback: string) => /filename="([^"\r\n]{1,100})"/.exec(header ?? '')?.[1] ?? fallback;

/**
 * "Export" on the board header (board admins only; the server decides again). The file is fetched through `siteFetch`
 * (the session travels only through it) and saved from a blob: no link to the API is ever opened in a tab.
 * While one export runs, the menu is disabled (never two at once).
 */
export function ExportMenu({boardId}: {boardId: number}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (format: 'json' | 'csv') => {
    setBusy(true);
    toast.info(t('importExport.export.working'));
    try {
      const res = await siteFetch(`/site-api/boards/${boardId}/export.${format}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(body?.message ?? `Request failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = nameOf(res.headers.get('content-disposition'), `board.${format}`);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(t('importExport.export.done'));
    } catch (error) {
      toast.danger(t('importExport.export.failed', {message: errorMessage(error)}));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu
      label={t('importExport.export.label')}
      disabled={busy}
      trigger={<span aria-busy={busy || undefined}>{t('importExport.export.menu')}</span>}
      items={[
        {label: t('importExport.export.json'), icon: 'download', onSelect: () => void run('json')},
        {label: t('importExport.export.csv'), icon: 'download', onSelect: () => void run('csv')},
      ]}
    />
  );
}

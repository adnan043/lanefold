import {useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '../nav';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Icon, useToast} from '../../portal/ui';
import {createBoardFromTemplate, TEMPLATES, type TemplateId} from '../templates';
import {ArchivedBoards} from './archive-panel';
import './settings.css';

/** The empty state's "Start from a template" strip: each card makes a board with its lanes and opens it. */
export function TemplatesStrip({workspaceId}: {workspaceId: number}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<TemplateId | null>(null);
  const make = async (id: TemplateId, title: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const boardId = await createBoardFromTemplate(workspaceId, id, title, t);
      await queryClient.invalidateQueries({queryKey: ['boards', workspaceId]});
      toast.success(t('boards.created'));
      void navigate({to: '/b/$boardId', params: {boardId: String(boardId)}});
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="lf-list-section" aria-labelledby="lf-tpl-title">
      <h2 id="lf-tpl-title">{t('tpl.strip')}</h2>
      <ul className="lf-tpl-strip">
        {TEMPLATES.map(tpl => (
          <li key={tpl.id}>
            <button type="button" className="lf-tpl-card" disabled={busy !== null} aria-busy={busy === tpl.id} onClick={() => void make(tpl.id, t(tpl.title))}>
              <span className="lf-tpl-title">{busy === tpl.id ? t('bx.tpl.creating') : t(tpl.title)}</span>
              <span className="lf-settings-sub">{t(tpl.description)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A "Archived boards" disclosure under the list; the list loads only when opened. */
export function ArchivedBoardsSection({workspaceId}: {workspaceId: number}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section className="lf-list-section" aria-labelledby="lf-arch-title">
      <h2 id="lf-arch-title">
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls="lf-arch-panel" onClick={() => setOpen(v => !v)}>
          <Icon name="archive" size={16} /> {t('bx.archive.boards')}
        </Button>
      </h2>
      <div id="lf-arch-panel">
        <ArchivedBoards workspaceId={workspaceId} open={open} />
      </div>
    </section>
  );
}

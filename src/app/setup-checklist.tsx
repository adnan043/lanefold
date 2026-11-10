import {useInfiniteQuery} from '@tanstack/react-query';
import {Link, useNavigate} from './nav';
import {useState} from 'react';

import {useT} from '../i18n';
import {Button, buttonClass, Card, Icon, ProgressBar, useToast} from '../portal/ui';
import {useMe} from '../portal/shared';
import {boardsQuery} from './queries';
import {createBoardFromTemplate, TEMPLATES, type TemplateId} from './templates';
import {useWorkspace} from './workspace';

const keyOf = (userId: number, workspaceId: number) => `lf:setup:${userId}:${workspaceId}`;

function read(userId: number, workspaceId: number): {dismissed?: boolean; cards?: boolean; chat?: boolean} {
  try {
    return JSON.parse(localStorage.getItem(keyOf(userId, workspaceId)) ?? '{}') as {dismissed?: boolean; cards?: boolean; chat?: boolean};
  } catch {
    return {};
  }
}

/**
 * "Get started" on My Day: four steps that tick from real data where the app can tell (a board exists, a teammate
 * joined) and on click otherwise. With no board yet it shows the starter-template strip. Hides when done or dismissed.
 */
export function SetupChecklist() {
  const {current} = useWorkspace();
  const userId = useMe().data?.viewer.id ?? null;
  // Keyed by user and workspace: its saved state is read once both are known and again when either changes.
  return current && userId ? <SetupChecklistFor key={`${userId}:${current.id}`} userId={userId} /> : null;
}

function SetupChecklistFor({userId}: {userId: number}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const {current} = useWorkspace();
  const workspaceId = current?.id ?? 0;
  const boards = useInfiniteQuery({...boardsQuery(workspaceId), enabled: workspaceId > 0});
  const [state, setState] = useState(() => read(userId, workspaceId));
  const [making, setMaking] = useState<TemplateId | null>(null);
  if (!current || current.role === 'viewer' || boards.isPending || boards.isError || state.dismissed) return null;

  const save = (patch: typeof state) => {
    const next = {...state, ...patch};
    setState(next);
    try {
      localStorage.setItem(keyOf(userId, workspaceId), JSON.stringify(next));
    } catch {
      // Storage blocked: the tick lasts until the page closes.
    }
  };
  const hasBoard = (boards.data?.pages[0]?.items.length ?? 0) > 0;
  const canInvite = current.role === 'owner' || current.role === 'admin';
  const steps = [
    {id: 'board', done: hasBoard, label: t('setup.board'), to: '/boards', mark: undefined},
    {id: 'cards', done: !!state.cards, label: t('setup.cards'), to: '/boards', mark: () => save({cards: true})},
    ...(canInvite ? [{id: 'invite', done: current.memberCount > 1, label: t('setup.invite'), to: '/members', mark: undefined}] : []),
    {id: 'chat', done: !!state.chat, label: t('setup.chat'), to: '/chat', mark: () => save({chat: true})},
  ];
  const doneCount = steps.filter(step => step.done).length;
  if (doneCount === steps.length) return null;

  const start = async (id: TemplateId) => {
    setMaking(id);
    try {
      const boardId = await createBoardFromTemplate(workspaceId, id, t(`tpl.${id}` as 'tpl.blank'), t);
      await boards.refetch();
      void navigate({to: '/b/$boardId', params: {boardId: String(boardId)}});
    } catch {
      toast.danger(t('errors.unknown'));
    } finally {
      setMaking(null);
    }
  };

  return (
    <Card
      title={t('setup.title')}
      actions={
        <Button variant="ghost" size="sm" onClick={() => save({dismissed: true})}>
          {t('setup.dismiss')}
        </Button>
      }>
      <p className="muted lf-setup-count">{t('setup.progress', {done: doneCount, total: steps.length})}</p>
      <ProgressBar value={doneCount} max={steps.length} label={t('setup.title')} />
      <ul className="lf-setup-list">
        {steps.map(step => (
          <li key={step.id} className="lf-setup-row" data-done={step.done ? '' : undefined}>
            {step.done ? <Icon name="check-circle" size={18} /> : <span className="lf-setup-ring" aria-hidden="true" />}
            <span className="lf-setup-label">{step.label}</span>
            {!step.done && (
              <Link to={step.to} className={buttonClass({variant: 'ghost', size: 'sm'})} onClick={step.mark}>
                {t('setup.go')}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {!hasBoard && current.role !== 'guest' && (
        <div className="lf-templates" role="group" aria-label={t('tpl.strip')}>
          <p className="lf-templates-title">{t('tpl.strip')}</p>
          <div className="lf-templates-row">
            {TEMPLATES.map(tpl => (
              <button key={tpl.id} type="button" className="lf-template" disabled={making !== null} aria-busy={making === tpl.id} onClick={() => void start(tpl.id)}>
                <span className="lf-template-title">{making === tpl.id ? t('boards.creating') : t(tpl.title)}</span>
                <span className="lf-template-desc">{t(tpl.description)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

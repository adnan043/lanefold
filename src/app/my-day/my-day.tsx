import {keepPreviousData, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';
import {useEffect, useState} from 'react';

import {useI18n, useT, type MessageKey} from '../../i18n';
import {Badge, Button, buttonClass, Card, EmptyState, ErrorNote, IconButton, LoadingBlock, PageHeader, useToast} from '../../portal/ui';
import {todayISO} from '../../portal/ui/date';
import {call} from '../api';
import {useWriteCooldown} from '../write-cooldown';
import {SetupChecklist} from '../setup-checklist';
import {type DayCard, type DayGroup, myDayQuery} from './queries';
import '../phase3.css';

const GROUPS: {id: DayGroup; title: MessageKey}[] = [
  {id: 'overdue', title: 'myDay.overdue'},
  {id: 'today', title: 'myDay.today'},
  {id: 'next7', title: 'myDay.next7'},
  {id: 'later', title: 'myDay.later'},
  {id: 'none', title: 'myDay.noDate'},
];

/** My Day: the cards assigned to me, from every workspace I am in, by when they are due (Overdue, Today, Next 7 days...). */
export function MyDay() {
  const t = useT();
  const {formatDate, errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [today, setToday] = useState(() => todayISO());
  // The page can stay open past midnight: recompute the day when the tab is shown or focused again.
  useEffect(() => {
    const refresh = () => setToday(todayISO());
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const query = useQuery({...myDayQuery(today), placeholderData: keepPreviousData});
  const [busyId, setBusyId] = useState<number | null>(null);

  const cooldown = useWriteCooldown();
  const done = useMutation({
    mutationFn: (card: DayCard) => call('PATCH', `/cards/${card.id}`, {completed: true}),
    onMutate: card => setBusyId(card.id),
    onSuccess: async () => {
      toast.success(t('myDay.done'));
      await Promise.all([queryClient.invalidateQueries({queryKey: ['my-day']}), queryClient.invalidateQueries({queryKey: ['board']})]);
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const header = <PageHeader title={t('myDay.title')} description={t('myDay.subtitle')} />;
  if (query.isPending) {
    return (
      <div className="app-page">
        {header}
        <LoadingBlock rows={4} />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="app-page">
        {header}
        <ErrorNote error={new Error(errorMessage(query.error))} />
        <Button variant="secondary" icon="refresh" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const items = query.data?.items ?? [];
  const many = new Set(items.map(i => i.workspaceId)).size > 1;
  return (
    <div className="app-page">
      {header}
      <SetupChecklist />
      {items.length === 0 ? (
        <EmptyState
          icon="calendar"
          title={t('myDay.emptyTitle')}
          action={
            <Link to="/boards" className={buttonClass({variant: 'secondary'})}>
              {t('myDay.emptyAction')}
            </Link>
          }>
          {t('myDay.emptyAssigned')}
        </EmptyState>
      ) : (
        <div className="lf-day">
          {GROUPS.map(group => {
            const rows = items.filter(item => item.group === group.id);
            if (rows.length === 0) return null;
            return (
              <Card key={group.id} title={t(group.title)}>
                <ul className="lf-day-list">
                  {rows.map(card => (
                    <li key={card.id} className="lf-day-row">
                      <IconButton
                        icon="check-circle"
                        label={t('myDay.markDone', {title: card.title})}
                        disabled={(busyId !== null && busyId !== card.id) || cooldown.blocked}
                        pending={busyId === card.id}
                        onClick={() => done.mutate(card)}
                      />
                      <Link to="/b/$boardId/c/$cardId" params={{boardId: String(card.boardId), cardId: String(card.id)}} className="lf-day-main">
                        <span className="lf-day-title">{card.title}</span>
                        <span className="lf-day-meta">
                          {many ? `${card.workspaceName} / ` : ''}
                          {card.number != null ? `#${card.number} · ` : ''}
                          {card.boardName} / {card.laneName}
                        </span>
                      </Link>
                      {card.priority !== 'none' && (
                        <Badge tone={card.priority === 'urgent' || card.priority === 'high' ? 'danger' : 'neutral'}>
                          {t(`card.priority.${card.priority}` as 'card.priority.low')}
                        </Badge>
                      )}
                      {card.dueDate && (
                        <Badge tone={group.id === 'overdue' ? 'danger' : 'neutral'} icon="clock">
                          {formatDate(`${card.dueDate}T12:00:00`)}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
          {query.data?.truncated && <p className="muted">{t('myDay.truncated')}</p>}
        </div>
      )}
    </div>
  );
}

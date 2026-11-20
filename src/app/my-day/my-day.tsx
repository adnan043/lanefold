import {keepPreviousData, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';
import {useEffect, useState} from 'react';

import {useI18n, useT, type MessageKey} from '../../i18n';
import {Badge, Button, buttonClass, Card, EmptyState, ErrorNote, IconButton, LoadingBlock, PageHeader, useToast} from '../../portal/ui';
import {todayISO} from '../../portal/ui/date';
import {call} from '../api';
import {useWriteCooldown} from '../write-cooldown';
import {type DayCard, type DayGroup, type MyDayData, myDayQuery} from './queries';
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
  /** Marks the card in the cached list at once (it stays where it is, ticked), before the server's answer. */
  const setCompleted = (id: number, completed: boolean) =>
    queryClient.setQueriesData<MyDayData>({queryKey: ['my-day']}, data => data && {...data, items: data.items.map(i => (i.id === id ? {...i, completed} : i))});
  // Only the card's own board is stale, not every board in the cache.
  const refresh = (card: DayCard) => Promise.all([queryClient.invalidateQueries({queryKey: ['my-day']}), queryClient.invalidateQueries({queryKey: ['board', card.boardId]})]);
  // Done toggles: a done card stays in the list, ticked, with an Archive button; ticking it again reopens it.
  const done = useMutation({
    mutationFn: (card: DayCard) => call('PATCH', `/cards/${card.id}`, {completed: !card.completed}),
    onMutate: card => {
      setBusyId(card.id);
      setCompleted(card.id, !card.completed);
    },
    onSuccess: async (_data, card) => {
      if (!card.completed) toast.success(t('myDay.done'));
      await refresh(card);
    },
    onError: (error, card) => {
      setCompleted(card.id, card.completed);
      toast.danger(errorMessage(error));
    },
    onSettled: () => setBusyId(null),
  });
  // Archive takes the card off its board, and so out of My Day; Undo restores it.
  const archive = useMutation({
    mutationFn: (card: DayCard) => call('POST', `/cards/${card.id}/archive`, {}),
    onMutate: card => setBusyId(card.id),
    onSuccess: async (_data, card) => {
      const undo = () =>
        void call('POST', `/cards/${card.id}/restore`, {})
          .then(() => refresh(card))
          .catch((error: unknown) => toast.danger(errorMessage(error)));
      toast.success(t('inbox.archived'), {action: {label: t('card.undo'), onSelect: undo}});
      await refresh(card);
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const header = <PageHeader title={t('myDay.title')} description={t('myDay.subtitle')} />;
  if (query.isPending) {
    return (
      <div className="app-page lf-my-day">
        {header}
        <LoadingBlock rows={4} />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <div className="app-page lf-my-day">
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
    <div className="app-page lf-my-day">
      {header}
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
                    <li key={card.id} className="lf-day-row" data-done={card.completed ? '' : undefined}>
                      <IconButton
                        className="lf-inbox-check"
                        icon={card.completed ? 'check-circle' : 'circle'}
                        label={card.completed ? t('card.markNotDone', {title: card.title}) : t('myDay.markDone', {title: card.title})}
                        disabled={(busyId !== null && busyId !== card.id) || cooldown.blocked}
                        pending={busyId === card.id && done.isPending}
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
                        <Badge tone={card.priority === 'urgent' ? 'danger' : card.priority === 'high' ? 'warning' : 'neutral'}>
                          {t(`card.priority.${card.priority}` as 'card.priority.low')}
                        </Badge>
                      )}
                      {card.dueDate && (
                        <Badge tone={group.id === 'overdue' && !card.completed ? 'danger' : 'neutral'} icon="clock">
                          {formatDate(`${card.dueDate}T12:00:00`)}
                        </Badge>
                      )}
                      {card.completed && (
                        <IconButton
                          className="lf-day-archive"
                          icon="archive"
                          label={t('inbox.archive', {title: card.title})}
                          disabled={(busyId !== null && busyId !== card.id) || cooldown.blocked}
                          pending={busyId === card.id && archive.isPending}
                          onClick={() => archive.mutate(card)}
                        />
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

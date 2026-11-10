import {useQuery} from '@tanstack/react-query';
import {useRef, useState, useSyncExternalStore} from 'react';

import {useI18n} from '../../i18n';
import {Button, Icon, type IconName, type MenuItem, Menu, useConfirm} from '../../portal/ui';
import {todayISO} from '../../portal/ui/date';
import {call, type LaneT} from '../api';
import type {BoardActions, BulkAction, Undoable} from './actions';
import {useBulkRunner} from './use-bulk-runner';
import {type Selection, useSelectedIds} from './selection';
import './bulk.css';

type BarProps = {boardId: number; lanes: LaneT[]; actions: BoardActions; selection: Selection; onUndoable: (label: string, undo: Undoable) => void};
type LabelOption = {id: number; name: string; colorHex: string};
type PersonOption = {id: number; name: string};

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

/** `YYYY-MM-DD` plus `days` (calendar arithmetic in UTC, so a daylight change never shifts the day). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A menu trigger that looks like the bar's other buttons. */
function Trigger({icon, children}: {icon: IconName; children: string}) {
  return (
    <span className="lf-bulk-trigger">
      <Icon name={icon} size={16} />
      {children}
    </span>
  );
}

/**
 * The bar of the selected cards: "N selected", Clear and the actions. Sticky at the bottom of the board while select
 * mode is on. Every action is ONE request for all the cards, all or nothing (`POST /boards/:id/cards/bulk`): a
 * failure leaves the selection as it was and says why next to the actions; a success clears the ticks.
 */
export function BulkBar({boardId, lanes, actions, selection, onUndoable}: BarProps) {
  const {t, errorMessage} = useI18n();
  const runBulk = useBulkRunner(actions, selection, onUndoable);
  const confirm = useConfirm();
  const ids = useSelectedIds();
  const count = ids.size;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The people list is read for ONE selected card (the seats are the board's, so any card of it will do).
  const first = useRef(0);
  first.current = ids.values().next().value ?? 0;

  const labels = useQuery({
    queryKey: ['board-labels', boardId],
    queryFn: () => call<{items: LabelOption[]}>('GET', `/boards/${boardId}/labels`),
    enabled: count > 0,
    staleTime: 30_000,
  });
  const people = useQuery({
    queryKey: ['bulk-people', boardId],
    queryFn: () => call<{items: PersonOption[]}>('GET', `/cards/${first.current}/people?q=`),
    enabled: count > 0,
    staleTime: 60_000,
  });

  const run = async (name: string, action: BulkAction) => {
    if (busy || count === 0) return;
    setBusy(name);
    setError(null);
    try {
      await runBulk([...ids], action);
    } catch (failure) {
      // The ticks stay, so the person can fix the cause (a full lane, a lost seat) and press again.
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const archive = () =>
    void confirm({
      title: t('bulk.archiveTitle'),
      body: t('bulk.archiveBody', {count}),
      confirmLabel: t('bulk.archive'),
      action: async () => void (await runBulk([...ids], {action: 'archive'})),
    });

  const today = todayISO();
  const moveItems: MenuItem[] = lanes.map(lane => ({label: t('bulk.moveTo', {lane: lane.name}), onSelect: () => void run('move', {action: 'move', laneId: lane.id})}));
  const labelItems: MenuItem[] = labels.data?.items.length
    ? [
        ...labels.data.items.map(l => ({label: t('bulk.labelAdd', {name: l.name}), icon: 'plus' as const, onSelect: () => void run('label', {action: 'label_add', labelId: l.id})})),
        'separator' as const,
        ...labels.data.items.map(l => ({label: t('bulk.labelRemove', {name: l.name}), icon: 'x' as const, onSelect: () => void run('label', {action: 'label_remove', labelId: l.id})})),
      ]
    : [{label: labels.isError ? t('bulk.loadFailed') : labels.isPending ? t('common.loading') : t('bulk.labelsNone'), onSelect: () => void labels.refetch(), disabled: !labels.isError}];
  const peopleItems: MenuItem[] = people.data?.items.length
    ? [
        ...people.data.items.map(p => ({label: t('bulk.assignTo', {name: p.name}), icon: 'user-plus' as const, onSelect: () => void run('assign', {action: 'assign', userId: p.id})})),
        'separator' as const,
        ...people.data.items.map(p => ({label: t('bulk.unassign', {name: p.name}), icon: 'x' as const, onSelect: () => void run('assign', {action: 'unassign', userId: p.id})})),
      ]
    : [{label: people.isError ? t('bulk.loadFailed') : people.isPending ? t('common.loading') : t('bulk.peopleNone'), onSelect: () => void people.refetch(), disabled: !people.isError}];
  const dueItems: MenuItem[] = [
    {label: t('bulk.dueToday'), icon: 'calendar', onSelect: () => void run('due', {action: 'set_due', dueDate: today})},
    {label: t('bulk.dueTomorrow'), icon: 'calendar', onSelect: () => void run('due', {action: 'set_due', dueDate: addDays(today, 1)})},
    {label: t('bulk.dueWeek'), icon: 'calendar', onSelect: () => void run('due', {action: 'set_due', dueDate: addDays(today, 7)})},
    'separator',
    {label: t('bulk.dueClear'), icon: 'x', onSelect: () => void run('due', {action: 'set_due', dueDate: null})},
  ];
  const priorityItems: MenuItem[] = PRIORITIES.map(level => ({
    label: t(`card.priority.${level}` as 'card.priority.low'),
    icon: 'flag' as const,
    onSelect: () => void run('priority', {action: 'set_priority', priority: level}),
  }));

  const disabled = busy !== null || count === 0;
  return (
    <div className="lf-bulk" role="toolbar" aria-label={t('bulk.barLabel')} aria-busy={busy !== null || undefined}>
      <span className="lf-bulk-count" role="status" aria-live="polite">
        {busy ? t('bulk.working') : count === 0 ? t('bulk.hint') : t('bulk.count', {count})}
      </span>
      <div className="lf-bulk-actions">
        <Menu label={t('bulk.move')} items={moveItems} disabled={disabled} align="start" trigger={<Trigger icon="arrow-right">{t('bulk.move')}</Trigger>} />
        <Menu label={t('bulk.labels')} items={labelItems} disabled={disabled} align="start" trigger={<Trigger icon="hash">{t('bulk.labels')}</Trigger>} />
        <Menu label={t('bulk.assign')} items={peopleItems} disabled={disabled} align="start" trigger={<Trigger icon="user-plus">{t('bulk.assign')}</Trigger>} />
        <Menu label={t('bulk.due')} items={dueItems} disabled={disabled} align="start" trigger={<Trigger icon="calendar">{t('bulk.due')}</Trigger>} />
        <Menu label={t('bulk.priority')} items={priorityItems} disabled={disabled} align="start" trigger={<Trigger icon="flag">{t('bulk.priority')}</Trigger>} />
        <Button type="button" variant="danger" size="sm" icon="archive" disabled={disabled} onClick={archive}>
          {t('bulk.archive')}
        </Button>
      </div>
      {error && (
        <p className="lf-bulk-error" role="alert">
          {error}
        </p>
      )}
      <Button type="button" variant="secondary" size="sm" icon="x" disabled={busy !== null} onClick={() => selection.clear()}>
        {t('bulk.clear')}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => selection.reset()}>
        {t('bulk.exit')}
      </Button>
    </div>
  );
}

/** The toolbar's "Select" switch: turns select mode on and off (off clears the ticks). */
export function SelectToggle({selection}: {selection: Selection}) {
  const t = useI18n().t;
  const mode = useSyncExternalStore(selection.subscribe, () => selection.get().mode, () => false);
  return (
    <Button type="button" variant="secondary" size="sm" icon="checklist" aria-pressed={mode} onClick={() => selection.setMode(!mode)}>
      <span className="lf-head-label">{t('bulk.select')}</span>
    </Button>
  );
}

/** The bar, only while select mode is on. */
export function BulkBarHost(props: BarProps) {
  const mode = useSyncExternalStore(props.selection.subscribe, () => props.selection.get().mode, () => false);
  return mode ? <BulkBar {...props} /> : null;
}

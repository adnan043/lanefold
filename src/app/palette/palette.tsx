import {keepPreviousData, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '../nav';
import {useEffect, useMemo, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {useToast} from '../../portal/ui';
import {CommandPalette, type CommandItem} from '../../portal/ui/command';
import {ApiError, call} from '../api';
import {useWorkspace} from '../workspace';
import {searchQuery} from './queries';

const MIN_QUERY = 2;

/** The query, but only once it has rested for `ms` (one search per pause, not per key). */
function useRested(value: string, ms: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return rested;
}

/**
 * Cmd/Ctrl+K: go anywhere, search the current workspace (cards, boards, people: the server only answers with
 * what the visitor may see) and create a board from what was typed. `open` lives in the shell so its top-bar
 * button can open it too; the shortcut is registered here.
 */
export function AppPalette({open, setOpen}: {open: boolean; setOpen: (open: boolean) => void}) {
  const t = useT();
  const {errorMessage, has} = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {current} = useWorkspace();
  const [typed, setTyped] = useState('');
  const rested = useRested(typed.trim(), 300);
  const workspaceId = current?.id ?? 0;
  const canCreate = current !== null && current.role !== 'viewer' && current.role !== 'guest';

  const searching = typed.trim().length >= MIN_QUERY;
  // After a 429 stop searching for a while (the server asks for 30 s; the client error does not carry the header).
  const [cooling, setCooling] = useState(false);
  const results = useQuery({
    ...searchQuery(workspaceId, rested),
    enabled: open && !cooling && workspaceId > 0 && rested.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
  });
  const limited = results.error instanceof ApiError && results.error.status === 429;
  useEffect(() => {
    if (!limited) return;
    setCooling(true);
    const timer = setTimeout(() => setCooling(false), 30_000);
    return () => clearTimeout(timer);
  }, [limited]);

  const create = useMutation({
    mutationFn: (name: string) =>
      call<{board: {id: number}}>('POST', `/workspaces/${workspaceId}/boards`, {
        name,
        visibility: 'workspace',
        lanes: [t('boards.lane.todo'), t('boards.lane.doing'), t('boards.lane.done')],
      }),
    onSuccess: async ({board}) => {
      await queryClient.invalidateQueries({queryKey: ['boards', workspaceId]});
      toast.success(t('boards.created'));
      void navigate({to: '/b/$boardId', params: {boardId: String(board.id)}});
    },
    onError: error => toast.danger(errorMessage(error)),
  });

  const items = useMemo<CommandItem[]>(() => {
    const go = t('shell.paletteGroupGo');
    const actions = t('shell.paletteGroupActions');
    const list: CommandItem[] = [
      {id: 'go-boards', label: t('nav.boards'), icon: 'layout-kanban', group: go, onSelect: () => void navigate({to: '/boards'})},
      {id: 'go-my-day', label: t('nav.myDay'), icon: 'calendar', group: go, onSelect: () => void navigate({to: '/my-day'})},
      {id: 'go-inbox', label: t('nav.inbox'), icon: 'inbox', group: go, onSelect: () => void navigate({to: '/inbox'})},
      {id: 'go-chat', label: t('nav.chat'), icon: 'message', group: go, onSelect: () => void navigate({to: '/chat'})},
      {id: 'go-settings', label: t('nav.settings'), icon: 'settings', group: go, onSelect: () => void navigate({to: '/settings/appearance'})},
    ];
    if (canCreate) {
      list.push({id: 'new-board', label: t('boards.new'), icon: 'plus', group: actions, keywords: ['create', 'add'], onSelect: () => void navigate({to: '/boards'})});
    }
    const found = searching ? results.data : undefined;
    for (const board of found?.boards ?? []) {
      list.push({
        id: `board-${board.id}`,
        label: board.name,
        icon: 'layout-kanban',
        group: t('palette.groupBoards'),
        always: true,
        onSelect: () => void navigate({to: '/b/$boardId', params: {boardId: String(board.id)}}),
      });
    }
    for (const card of found?.cards ?? []) {
      list.push({
        id: `card-${card.id}`,
        label: card.title,
        hint: card.number != null ? `#${card.number} · ${card.boardName}` : card.boardName,
        icon: 'checklist',
        group: t('palette.groupCards'),
        always: true,
        onSelect: () => void navigate({to: '/b/$boardId/c/$cardId', params: {boardId: String(card.boardId), cardId: String(card.id)}}),
      });
    }
    for (const person of found?.people ?? []) {
      list.push({
        id: `person-${person.id}`,
        label: person.name,
        hint: has(`workspace.role.${person.role}`),
        icon: 'user',
        group: t('palette.groupPeople'),
        always: true,
        onSelect: () => void navigate({to: '/settings/workspace'}),
      });
    }
    if (canCreate) {
      const name = typed.trim().slice(0, 80);
      if (name) list.push({id: 'create-board', label: t('palette.createBoard', {name}), icon: 'plus', group: actions, always: true, fallback: true, onSelect: () => create.mutate(name)});
    }
    return list;
  }, [t, has, navigate, canCreate, typed, searching, results.data, create]);

  const waiting = searching && !cooling && (typed.trim() !== rested || results.isFetching);
  const pending = searching && !cooling && !results.isError && (typed.trim() !== rested || results.isFetching || results.isPlaceholderData);
  const emptyText = waiting ? t('palette.searching') : results.isError || cooling ? t('palette.error') : t('shell.paletteEmpty');

  return (
    <CommandPalette
      open={open}
      onClose={() => setOpen(false)}
      items={items}
      label={t('shell.paletteLabel')}
      placeholder={t('shell.palettePlaceholder')}
      emptyText={emptyText}
      onQueryChange={setTyped}
      busy={pending}
    />
  );
}

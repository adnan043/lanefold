import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, EmptyState, Field, IconButton, LoadingBlock, Menu, Modal, Switch, type MenuItem, useConfirm, useForm, useToast, rules} from '../../portal/ui';
import {ApiError, call} from '../api';
import {useDraft} from '../use-draft';
import {canManageSaved, groupSavedFilters, ownCount, type SavedScope} from './saved-filter-groups';
import './settings.css';

/** The board filter bar as a plain snapshot. Mirrors `parseFilter` in `src/server/routes/saved-filters.ts`. */
export type SavedFilterValue = {
  text?: string;
  labelIds?: number[];
  noLabels?: boolean;
  memberIds?: number[];
  noMembers?: boolean;
  dues?: ('none' | 'overdue' | 'day' | 'week' | 'month')[];
  dueFrom?: string;
  dueTo?: string;
  status?: 'complete' | 'incomplete';
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  match?: 'any' | 'all';
};
export type SavedFilter = {id: number; name: string; filter: SavedFilterValue; scope: SavedScope; mine: boolean; author: {name: string | null} | null; createdAt: string};
type ListAnswer = {items: SavedFilter[]; max: number; maxShared: number; canShare: boolean; canAdmin: boolean};

const NAME_MAX = 60;
const keyOf = (boardId: number) => ['saved-filters', boardId] as const;

/** True when the snapshot would filter nothing (so there is nothing to save). */
export const isEmptyFilter = (f: SavedFilterValue) => !f.text?.trim() && !f.labelIds?.length && !f.noLabels && !f.memberIds?.length && !f.noMembers && !f.dues?.length && !f.dueFrom && !f.dueTo && !f.status && !f.priority;

/** The save / rename dialog: one name field. */
function NameDialog({target, canShare, onSubmit, onClose}: {target: 'new' | SavedFilter | null; canShare: boolean; onSubmit: (name: string, share: boolean) => Promise<void>; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const existing = target && target !== 'new' ? target : null;
  const form = useForm({name: existing?.name ?? ''}, {name: [rules.required(t('sf.nameRequired')), rules.maxLength(NAME_MAX, t('sf.nameTooLong'))]});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [share, setShare] = useState(false);
  useEffect(() => {
    if (target === null) return;
    form.reset({name: existing?.name ?? ''});
    setStatus('');
    setShare(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  // The name survives a forced sign-in; switched on only once the form holds this target's values.
  const [syncedTarget, setSyncedTarget] = useState<typeof target>(null);
  useEffect(() => setSyncedTarget(target), [target]);
  const clearDraft = useDraft('sfname', existing?.id ?? 0, form.values.name, text => form.set('name', text), existing?.name ?? '', target !== null && syncedTarget === target);
  const submit = form.submit(async values => {
    setPending(true);
    setStatus('');
    try {
      await onSubmit(values.name.trim(), share);
      clearDraft();
      onClose();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error));
    } finally {
      setPending(false);
    }
  });
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      dismissible={!pending}
      size="sm"
      title={existing ? t('sf.renameTitle') : t('sf.saveTitle')}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="sf-name-form" pending={pending} pendingLabel={t('sf.saving')} disabled={form.blocked}>
            {existing ? t('sf.rename') : t('sf.save')}
          </Button>
        </>
      }>
      <form id="sf-name-form" noValidate onSubmit={submit}>
        <Field label={t('sf.nameLabel')} id="f-name" error={form.error('name')}>
          <input className="input" {...form.field('name')} autoComplete="off" placeholder={t('sf.namePlaceholder')} />
        </Field>
        {!existing && canShare && <Switch label={t('sf.shareSwitch')} description={t('sf.shareHint')} checked={share} onChange={setShare} disabled={pending} />}
        <p role="status" className="form-status">
          {status}
        </p>
      </form>
    </Modal>
  );
}

/** "Saved filters" in the board's filter bar: apply, save the current filter, rename, delete. Personal to the signed-in member. */
export function SavedFiltersMenu({boardId, current, canSave, onApply}: {boardId: number; current: SavedFilterValue; canSave: boolean; onApply: (filter: SavedFilterValue) => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'new' | SavedFilter | null>(null);
  const [manage, setManage] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const query = useQuery({queryKey: keyOf(boardId), queryFn: () => call<ListAnswer>('GET', `/boards/${boardId}/saved-filters`), staleTime: 60_000});
  const refresh = () => queryClient.invalidateQueries({queryKey: keyOf(boardId)});
  const items = query.data?.items ?? [];
  const full = query.data ? ownCount(items) >= query.data.max : false;
  const canShare = query.data?.canShare ?? false;
  const canAdmin = query.data?.canAdmin ?? false;
  const groups = groupSavedFilters(items);
  const manageable = items.filter(i => canManageSaved(i, canAdmin));

  const create = useMutation({
    mutationFn: ({name, share}: {name: string; share: boolean}) => call('POST', `/boards/${boardId}/saved-filters`, {name, filter: current, scope: share ? 'board' : 'private'}),
    onSuccess: async (_data, vars) => {
      await refresh();
      toast.success(vars.share ? t('sf.savedShared') : t('sf.saved'));
    },
  });
  const renameTo = useMutation({
    mutationFn: ({id, name}: {id: number; name: string}) => call('PATCH', `/saved-filters/${id}`, {name}),
    onSuccess: async () => {
      await refresh();
      toast.success(t('sf.renamed'));
    },
  });
  const setScope = useMutation({
    mutationFn: ({id, scope}: {id: number; scope: SavedScope}) => call('PATCH', `/saved-filters/${id}`, {scope}),
    onMutate: ({id}) => setBusyId(id),
    onSuccess: async (_data, vars) => {
      await refresh();
      toast.success(vars.scope === 'board' ? t('sf.shared') : t('sf.unshared'));
    },
    onSettled: () => setBusyId(null),
  });
  const remove = useMutation({
    mutationFn: (id: number) => call('DELETE', `/saved-filters/${id}`),
    onMutate: id => setBusyId(id),
    onSuccess: async () => {
      await refresh();
      toast.success(t('sf.deleted'));
    },
    onSettled: () => setBusyId(null),
  });

  const askDelete = (item: SavedFilter) =>
    void confirm({
      title: t('sf.deleteTitle', {name: item.name}),
      body: item.scope === 'board' ? t('sf.deleteSharedBody') : t('sf.deleteBody'),
      confirmLabel: t('sf.delete'),
      action: async () => {
        try {
          await remove.mutateAsync(item.id);
        } catch (error) {
          // A filter already gone (404) is a result, not a failure.
          if (error instanceof ApiError && error.status === 404) await refresh();
          else throw error;
        }
      },
    });

  const toggleShare = (item: SavedFilter, on: boolean) => {
    const run = async () => {
      try {
        await setScope.mutateAsync({id: item.id, scope: on ? 'board' : 'private'});
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) await refresh();
        else toast.danger(errorMessage(error));
      }
    };
    if (on) void run();
    else
      void confirm({title: t('sf.unshareTitle', {name: item.name}), body: t('sf.unshareBody'), confirmLabel: t('sf.unshare'), action: run});
  };

  const label = (item: SavedFilter) =>
    item.scope !== 'board' ? item.name : item.mine ? t('sf.sharedMine', {name: item.name}) : t('sf.sharedBy', {name: item.name, author: item.author?.name ?? t('sf.formerMember')});
  const menuItems: MenuItem[] = [];
  if (query.isPending) menuItems.push({label: t('sf.loading'), disabled: true, onSelect: () => undefined});
  else if (query.error) menuItems.push({label: t('sf.retry'), icon: 'refresh', onSelect: () => void query.refetch()});
  else if (!items.length) menuItems.push({label: t('sf.none'), disabled: true, onSelect: () => undefined});
  else {
    for (const item of groups.mine) menuItems.push({label: label(item), onSelect: () => onApply(item.filter)});
    if (groups.mine.length && groups.sharedByOthers.length) menuItems.push('separator');
    for (const item of groups.sharedByOthers) menuItems.push({label: label(item), onSelect: () => onApply(item.filter)});
  }
  menuItems.push('separator');
  menuItems.push({label: full ? t('sf.full', {max: query.data?.max ?? 0}) : t('sf.saveCurrent'), icon: 'plus', disabled: !canSave || full || !query.data || isEmptyFilter(current), onSelect: () => setDialog('new')});
  menuItems.push({label: t('sf.manage'), icon: 'pencil', disabled: !manageable.length, onSelect: () => setManage(true)});

  return (
    <>
      <Menu label={t('sf.menu')} align="start" items={menuItems} trigger={<span>{t('sf.menu')}</span>} />
      <NameDialog
        target={dialog}
        canShare={canShare}
        onClose={() => setDialog(null)}
        onSubmit={(name, share) => (dialog === 'new' ? create.mutateAsync({name, share}) : renameTo.mutateAsync({id: (dialog as SavedFilter).id, name})).then(() => undefined)}
      />
      <Modal open={manage} onClose={() => setManage(false)} title={t('sf.manageTitle')} size="md">
        {query.isPending ? (
          <LoadingBlock rows={2} />
        ) : query.error ? (
          <div role="alert">
            <p>{errorMessage(query.error)}</p>
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t('sf.retry')}
            </Button>
          </div>
        ) : !manageable.length ? (
          <EmptyState icon="list" title={t('sf.none')}>
            {t('sf.noneBody')}
          </EmptyState>
        ) : (
          <ul className="lf-archive-list" aria-label={t('sf.manageTitle')}>
            {manageable.map(item => (
              <li key={item.id} className="lf-archive-row">
                <div className="lf-archive-text">
                  <span className="lf-archive-title" dir="auto">{item.name}</span>
                  {item.scope === 'board' && (
                    <span className="lf-archive-meta">{item.mine ? t('sf.sharedBadge') : t('sf.sharedByLine', {author: item.author?.name ?? t('sf.formerMember')})}</span>
                  )}
                </div>
                <Switch
                  label={
                    <>
                      <span aria-hidden="true">{t('sf.shareShort')}</span>
                      <span className="visually-hidden">{t('sf.shareSwitchNamed', {name: item.name})}</span>
                    </>
                  }
                  checked={item.scope === 'board'}
                  onChange={on => toggleShare(item, on)}
                  disabled={busyId !== null || (item.scope !== 'board' && !canShare)}
                  pending={busyId === item.id}
                />
                <IconButton icon="pencil" label={t('sf.renameNamed', {name: item.name})} size="sm" disabled={busyId !== null} onClick={() => setDialog(item)} />
                <IconButton icon="trash" label={t('sf.deleteNamed', {name: item.name})} size="sm" pending={busyId === item.id} disabled={busyId !== null} onClick={() => askDelete(item)} />
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

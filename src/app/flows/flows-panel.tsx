import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Badge, Button, EmptyState, LoadingBlock, Menu, Notice, Switch, useConfirm, useToast} from '../../portal/ui';
import {type ApiError, type BoardT, type LaneT} from '../api';
import {useFlowContext} from './context';
import {FlowEditor} from './flow-editor';
import {type FlowInput, type FlowsAnswer, type FlowT} from './logic';
import {flowsApi, flowsQuery} from './queries';
import {describeFlow} from './summary';
import './flows.css';

/**
 * "Automations" section of the board settings drawer: the board's Flows, each with an on/off switch and an
 * Edit / Delete menu, and a "New automation" button. Board admins only (the server checks again).
 */
export function FlowsSection({board, lanes, open}: {board: BoardT; lanes: LaneT[]; open: boolean}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const allowed = board.canAdmin && !board.archived;
  const query = useQuery({...flowsQuery(board.id), enabled: open && allowed});
  const context = useFlowContext(board.workspaceId, lanes, open && allowed);
  const [editing, setEditing] = useState<FlowT | 'new' | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  if (!allowed) return null;

  const key = flowsQuery(board.id).queryKey;
  const patchCache = (fn: (data: FlowsAnswer) => FlowsAnswer) => queryClient.setQueryData<FlowsAnswer>(key, old => (old ? fn(old) : old));
  const refresh = () => void queryClient.invalidateQueries({queryKey: key});

  const toggle = async (flow: FlowT, enabled: boolean) => {
    setBusyId(flow.id);
    setError('');
    try {
      const saved = await flowsApi.update(flow.id, {enabled});
      patchCache(d => ({...d, items: d.items.map(f => (f.id === flow.id ? saved : f))}));
      refresh(); // the plan count changes when a flow turns on
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (flow: FlowT) => {
    setBusyId(flow.id);
    try {
      await flowsApi.remove(flow.id);
      patchCache(d => ({...d, items: d.items.filter(f => f.id !== flow.id), limit: {...d.limit, used: Math.max(0, d.limit.used - 1)}}));
      refresh();
      toast.success(t('flows.deleted'));
    } finally {
      setBusyId(null);
    }
  };

  const save = async (input: FlowInput) => {
    if (editing && editing !== 'new') await flowsApi.update(editing.id, input);
    else await flowsApi.create(board.id, input);
    toast.success(editing === 'new' ? t('flows.created') : t('flows.saved'));
    setEditing(null);
    refresh();
  };

  const data = query.data;
  const atLimit = !!data && (data.items.length >= data.limit.boardMax || (data.limit.max > 0 && data.limit.used >= data.limit.max));
  const planOff = !!data && !data.enabled;
  const loadError = query.error as ApiError | null;
  const upgrade = loadError?.code === 'plan_feature';

  return (
    <fieldset className="lf-settings-group" aria-busy={query.isPending || busyId !== null}>
      <legend>{t('flows.title')}</legend>
      <p className="lf-settings-sub">{t('flows.hint')}</p>

      {query.isPending && <LoadingBlock rows={2} />}

      {loadError && (
        <Notice
          tone={upgrade ? 'info' : 'danger'}
          action={
            upgrade ? undefined : (
              <Button variant="secondary" size="sm" pending={query.isFetching} pendingLabel={t('common.loading')} onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }>
          {upgrade ? t('flows.planOff') : errorMessage(loadError)}
        </Notice>
      )}

      {data && planOff && <Notice tone="info">{t('flows.planOff')}</Notice>}

      {data && data.enabled && data.items.length === 0 && (
        <EmptyState icon="zap" title={t('flows.empty.title')} action={<Button icon="plus" onClick={() => setEditing('new')}>{t('flows.new')}</Button>}>
          {t('flows.empty.body')}
        </EmptyState>
      )}

      {data && data.items.length > 0 && (
        <>
          <ul className="lf-flow-list">
            {data.items.map(flow => (
              <li key={flow.id} className="lf-flow-row" data-off={flow.enabled ? undefined : ''}>
                <div className="lf-flow-main">
                  <Switch label={flow.name} description={describeFlow(t, flow, context.names)} checked={flow.enabled} disabled={busyId !== null || planOff} pending={busyId === flow.id} onChange={on => void toggle(flow, on)} />
                  {flow.problems.length > 0 && (
                    <div className="lf-flow-problems">
                      {flow.problems.map(code => (
                        <Badge key={code} tone="warning" icon="warning">
                          {t(`flows.problem.${code}` as 'flows.problem.lane_gone', {})}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Menu
                  label={t('flows.menu', {name: flow.name})}
                  disabled={busyId !== null}
                  items={[
                    {label: t('flows.edit'), icon: 'pencil', onSelect: () => setEditing(flow)},
                    'separator',
                    {
                      label: t('flows.delete'),
                      icon: 'trash',
                      danger: true,
                      onSelect: () => void confirm({title: t('flows.deleteTitle'), body: t('flows.deleteBody', {name: flow.name}), confirmLabel: t('flows.delete'), pendingLabel: t('flows.deleting'), action: () => remove(flow)}),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
          <div className="lf-flow-foot">
            <p className="lf-settings-sub">{t('flows.used', {used: data.limit.used, max: data.limit.max > 0 ? data.limit.max : '∞'})}</p>
            <Button variant="secondary" icon="plus" disabled={atLimit || planOff} onClick={() => setEditing('new')}>
              {t('flows.new')}
            </Button>
          </div>
          {atLimit && <p className="lf-settings-sub">{t('flows.limitReached')}</p>}
        </>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      <FlowEditor open={editing !== null} flow={editing && editing !== 'new' ? editing : null} context={context} onClose={() => setEditing(null)} onSave={save} />
    </fieldset>
  );
}

import {useState} from 'react';
import {queryOptions, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';

import {useI18n, useT} from '../../i18n';
import {Badge, Button, buttonClass, Card, Icon, initials, LoadingBlock, Notice, PageHeader, Person, useConfirm, useToast} from '../../portal/ui';
import {type ApiError, call} from '../api';
import {useWorkspace} from '../workspace';
import {useWriteCooldown} from '../write-cooldown';
import {blockerAction, type BlockerReason, hasMoreMembers, isCapped} from './account-logic';
import {SettingsNav} from './nav';

type Reason = BlockerReason;
type Preflight = {
  canDelete: boolean;
  blockers: {reason: Reason; workspaceId: number; name: string; plan: string; archived: boolean; otherMembers: number; actions: string[]; candidates: {userId: number; name: string | null}[]}[];
  summary: {
    removed: {memberships: number; inboxCards: number; emptyWorkspaces: number};
    anonymised: {comments: number; messages: number; cards: number};
    cap: number;
  };
};

const preflightQuery = queryOptions({
  queryKey: ['account', 'delete-preflight'],
  queryFn: () => call<Preflight>('GET', '/account/delete-preflight'),
  staleTime: 0,
});

/** `/app/settings/account`: what stops the account from being deleted, what goes, and the way on to deleting it. */
export function Account() {
  const t = useT();
  const {formatNumber} = useI18n();
  const {setCurrentId} = useWorkspace();
  const check = useQuery(preflightQuery);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // Which person's button is running ("workspaceId:userId"): only that one shows pending, the others are disabled.
  const [busy, setBusy] = useState<string | null>(null);
  const cooldown = useWriteCooldown();
  const transfer = useMutation({
    mutationFn: (v: {workspaceId: number; userId: number}) => call('POST', `/workspaces/${v.workspaceId}/transfer`, {userId: v.userId}),
  });
  const makeOwner = async (workspaceId: number, workspaceName: string, userId: number, name: string) => {
    setBusy(`${workspaceId}:${userId}`);
    try {
      const ok = await confirm({
        title: t('account.makeOwner.title', {name, workspace: workspaceName}),
        body: t('account.makeOwner.body', {name}),
        confirmLabel: t('account.makeOwner.confirm'),
        pendingLabel: t('account.makeOwner.pending'),
        action: () => transfer.mutateAsync({workspaceId, userId}),
      });
      if (!ok) return;
      toast.success(t('account.makeOwner.done', {name, workspace: workspaceName}));
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['workspaces']}),
        queryClient.invalidateQueries({queryKey: ['members']}),
        check.refetch(),
      ]);
    } finally {
      setBusy(null);
    }
  };
  const data = check.data;
  const count = (n: number, cap: number) => (isCapped(n, cap) ? t('account.capped', {count: formatNumber(cap)}) : formatNumber(n));

  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('account.title')} description={t('account.description')} />
      <Card tone="danger" title={t('account.beforeTitle')} description={t('account.beforeDescription')}>
        {check.isPending ? (
          <LoadingBlock rows={3} />
        ) : check.error || !data ? (
          <Notice
            tone="danger"
            action={
              <Button variant="secondary" icon="refresh" onClick={() => void check.refetch()} pending={check.isFetching} pendingLabel={t('account.checking')}>
                {t('common.retry')}
              </Button>
            }
          >
            {check.error ? (check.error as ApiError).message : t('errors.unknown')}
          </Notice>
        ) : (
          <div className="lf-acct">
            {data.canDelete ? <Notice tone="success">{t('account.ready')}</Notice> : <Notice tone="warning">{t('account.blocked')}</Notice>}
            {data.blockers.length > 0 && (
              <ul className="lf-blockers" aria-label={t('account.blockersLabel')}>
                {data.blockers.map(b => {
                  const action = blockerAction(b);
                  return (
                    <li key={b.workspaceId} className="lf-blocker">
                      <div className="lf-blocker-head">
                        <span className="lf-blocker-tile" aria-hidden="true">
                          {initials(b.name) || '?'}
                        </span>
                        <div className="lf-blocker-text">
                          <p className="lf-blocker-name">
                            <strong dir="auto">{b.name}</strong> {b.archived && <Badge tone="warning">{t('account.archived')}</Badge>}
                          </p>
                          <p className="muted">
                            {b.reason === 'last_workspace_owner'
                              ? t('account.reason.last_workspace_owner', {count: formatNumber(b.otherMembers)})
                              : t(`account.reason.${b.reason}`)}
                          </p>
                          {b.archived && <p className="muted">{t('account.archivedHint')}</p>}
                        </div>
                        {action !== 'handover' && (
                          <Link
                            to={action === 'restore' ? '/settings/workspace' : action === 'plan' ? '/settings/billing' : '/boards'}
                            onClick={() => setCurrentId(b.workspaceId)}
                            className={buttonClass({variant: 'secondary', size: 'sm'})}>
                            {t(action === 'restore' ? 'account.action.restore' : action === 'plan' ? 'account.action.plan' : 'account.action.empty')}
                            <Icon name="arrow-right" size={14} />
                          </Link>
                        )}
                      </div>
                      {action === 'handover' && (
                        <div className="lf-blocker-people">
                          {b.candidates.length > 0 && <p className="lf-blocker-label">{t('account.candidatesLabel')}</p>}
                          <ul className="lf-candidates">
                            {b.candidates.map(k => {
                              const name = k.name ?? t('workspaceSettings.transfer.unnamed');
                              const key = `${b.workspaceId}:${k.userId}`;
                              return (
                                <li key={k.userId} className="lf-candidate">
                                  <Person name={name} />
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    icon="user"
                                    aria-label={t('account.action.makeOwner', {name})}
                                    onClick={() => void makeOwner(b.workspaceId, b.name, k.userId, name)}
                                    pending={busy === key}
                                    pendingLabel={t('account.makeOwner.pending')}
                                    disabled={(busy !== null && busy !== key) || cooldown.blocked}>
                                    {t('account.makeOwner.confirm')}
                                  </Button>
                                </li>
                              );
                            })}
                          </ul>
                          {hasMoreMembers(b.otherMembers, b.candidates.length) && (
                            <Link to="/members" onClick={() => setCurrentId(b.workspaceId)} className={buttonClass({variant: 'ghost', size: 'sm'})}>
                              {t('account.action.transfer')}
                              <Icon name="arrow-right" size={14} />
                            </Link>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="lf-acct-summary">
              <section className="lf-acct-panel" data-kind="removed">
                <h4>
                  <span className="lf-acct-panel-icon" aria-hidden="true">
                    <Icon name="trash" size={16} />
                  </span>
                  {t('account.removed.heading')}
                </h4>
                <dl>
                  <div>
                    <dt><Icon name="users" size={16} />{t('account.removed.memberships')}</dt>
                    <dd>{count(data.summary.removed.memberships, data.summary.cap)}</dd>
                  </div>
                  <div>
                    <dt><Icon name="inbox" size={16} />{t('account.removed.inbox')}</dt>
                    <dd>{count(data.summary.removed.inboxCards, data.summary.cap)}</dd>
                  </div>
                  <div>
                    <dt><Icon name="layers" size={16} />{t('account.removed.empty')}</dt>
                    <dd>{formatNumber(data.summary.removed.emptyWorkspaces)}</dd>
                  </div>
                </dl>
              </section>
              <section className="lf-acct-panel" data-kind="kept">
                <h4>
                  <span className="lf-acct-panel-icon" aria-hidden="true">
                    <Icon name="archive" size={16} />
                  </span>
                  {t('account.kept.heading')}
                </h4>
                <dl>
                  <div>
                    <dt><Icon name="reply" size={16} />{t('account.kept.comments')}</dt>
                    <dd>{count(data.summary.anonymised.comments, data.summary.cap)}</dd>
                  </div>
                  <div>
                    <dt><Icon name="message" size={16} />{t('account.kept.messages')}</dt>
                    <dd>{count(data.summary.anonymised.messages, data.summary.cap)}</dd>
                  </div>
                  <div>
                    <dt><Icon name="layout-kanban" size={16} />{t('account.kept.cards')}</dt>
                    <dd>{count(data.summary.anonymised.cards, data.summary.cap)}</dd>
                  </div>
                </dl>
              </section>
            </div>
            <div className="lf-acct-foot">
              <p id="account-delete-hint" className="muted">
                <Icon name={data.canDelete ? 'lock' : 'info'} size={14} />
                {data.canDelete ? t('account.deleteHint') : t('account.deleteBlockedHint')}
              </p>
              <div className="lf-acct-foot-actions">
                <Button variant="secondary" icon="refresh" onClick={() => void check.refetch()} pending={check.isFetching} pendingLabel={t('account.checking')}>
                  {t('account.recheck')}
                </Button>
                {data.canDelete ? (
                  <a href="/dashboard/account?tab=danger" className={buttonClass({variant: 'danger'})} aria-describedby="account-delete-hint">
                    <Icon name="trash" size={16} />
                    {t('account.delete')}
                  </a>
                ) : (
                  <Button variant="danger" icon="trash" disabled aria-describedby="account-delete-hint">
                    {t('account.delete')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

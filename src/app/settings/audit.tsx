import {infiniteQueryOptions, useInfiniteQuery} from '@tanstack/react-query';

import {type MessageKey, useI18n, useT} from '../../i18n';
import {Button, buttonClass, Card, EmptyState, LoadingBlock, Notice, PageHeader} from '../../portal/ui';
import {type ApiError, call} from '../api';
import {Link} from '../nav';
import {useWorkspace} from '../workspace';
import {SettingsNav} from './nav';

type Person = {id: number; name: string | null} | null;
export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  actor: Person;
  subject: Person;
  target: {type: string; name: string | null} | null;
  detail: {from: string | null; to: string | null};
};
type AuditPage = {available: boolean; events: AuditEvent[]; nextBefore: string | null};

const auditQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['audit', workspaceId],
    queryFn: ({pageParam}) => call<AuditPage>('GET', `/workspaces/${workspaceId}/audit?before=${pageParam}`),
    initialPageParam: '',
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

/** Actions with their own sentence (`audit.action.<action>`); anything else uses `audit.action.unknown`. */
export const AUDIT_ACTIONS = new Set([
  'workspace.renamed',
  'workspace.ownership_transferred',
  'workspace.archived',
  'workspace.restored',
  'workspace.plan_changed',
  'workspace.member.role_changed',
  'workspace.member.removed',
  'workspace.member.left',
  'workspace.member.joined',
  'workspace.joinlink.created',
  'workspace.joinlink.revoked',
  'workspace.invite.created',
  'workspace.invite.revoked',
  'workspace.invite.email_resent',
  'board.stale.set',
  'board.member.added',
  'board.member.joined',
  'board.member.role_changed',
  'board.member.left',
  'board.member.removed',
  'board.sharing.updated',
  'board.invite.created',
  'board.invite.revoked',
  'board.invite_link.created',
  'board.invite_link.removed',
  'board.share.create',
  'board.share.rotate',
  'board.share.revoke',
  'board.exported',
  'chat.channel_created',
  'chat.message_deleted',
  'flow.create',
  'flow.update',
  'flow.delete',
]);

const ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
const PLANS = new Set(['free', 'pro', 'team']);

/** `/app/settings/audit`: who did what in this workspace (owners and admins; Team plan). */
export function AuditLog() {
  const t = useT();
  const {formatDateTime, errorMessage} = useI18n();
  const {current, pending: loadingWorkspace} = useWorkspace();
  const canSee = current !== null && (current.role === 'owner' || current.role === 'admin');
  const audit = useInfiniteQuery({...auditQuery(current?.id ?? 0), enabled: canSee});
  const first = audit.data?.pages[0];
  const events = audit.data?.pages.flatMap(page => page.events) ?? [];

  const word = (value: string | null) => {
    if (!value) return '';
    if (ROLES.has(value)) return t(`members.role.${value}` as MessageKey);
    if (PLANS.has(value)) return t(`billing.plan.${value}` as MessageKey);
    return value;
  };
  const fallbackTarget = (type: string | undefined) =>
    t(type === 'board' ? 'audit.aBoard' : type === 'flow' ? 'audit.anAutomation' : 'audit.aChannel');
  const sentence = (event: AuditEvent) => {
    const params = {
      subject: event.subject?.name ?? t('audit.someone'),
      target: event.target?.name ?? fallbackTarget(event.target?.type),
      from: word(event.detail.from),
      to: word(event.detail.to),
      action: event.action,
    };
    return AUDIT_ACTIONS.has(event.action) ? t(`audit.action.${event.action}` as MessageKey, params) : t('audit.action.unknown', params);
  };

  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      {loadingWorkspace || (canSee && audit.isPending) ? (
        <LoadingBlock rows={5} />
      ) : !current ? null : !canSee ? (
        <Notice tone="info">{t('audit.adminOnly')}</Notice>
      ) : audit.isError || !first ? (
        <Notice
          tone="danger"
          action={
            <Button variant="secondary" icon="refresh" onClick={() => void audit.refetch()}>
              {t('common.retry')}
            </Button>
          }>
          {audit.error ? errorMessage(audit.error as ApiError) : t('errors.unknown')}
        </Notice>
      ) : !first.available ? (
        <EmptyState
          icon="lock"
          title={t('audit.planTitle')}
          action={
            <Link to="/settings/billing" className={buttonClass()}>
              {t('audit.seePlans')}
            </Link>
          }>
          {t('audit.planBody')}
        </EmptyState>
      ) : events.length === 0 ? (
        <EmptyState icon="activity" title={t('audit.emptyTitle')}>
          {t('audit.emptyBody')}
        </EmptyState>
      ) : (
        <Card>
          <ol className="lf-audit-list">
            {events.map(event => (
              <li key={event.id} className="lf-audit-row">
                <p className="lf-audit-text">
                  <strong>{event.actor ? (event.actor.name ?? t('audit.someone')) : t('audit.system')}</strong> {sentence(event)}
                </p>
                <time className="muted lf-audit-time" dateTime={event.at}>
                  {formatDateTime(event.at)}
                </time>
              </li>
            ))}
          </ol>
          {audit.hasNextPage && (
            <div className="lf-audit-more">
              <Button
                variant="secondary"
                onClick={() => void audit.fetchNextPage()}
                pending={audit.isFetchingNextPage}
                pendingLabel={t('audit.loadingMore')}>
                {t('audit.loadMore')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

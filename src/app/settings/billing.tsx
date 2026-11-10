import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {formatBytes} from '../../portal/billing-shared';
import {Badge, Button, Card, Drawer, EmptyState, LoadingBlock, Notice, PageHeader, ProgressBar, RadioCards, useConfirm, useToast} from '../../portal/ui';
import {api, type ApiError, call, type MembershipT} from '../api';
import {membershipsQuery} from '../queries';
import {useWorkspace} from '../workspace';
import {useWriteCooldown} from '../write-cooldown';
import {SettingsNav} from './nav';
import {queryOptions} from '@tanstack/react-query';

type Plan = {
  plan: string;
  maxMembers: number;
  maxFileBytes: number;
  storageQuotaBytes: number;
  maxFlows: number;
  auditLog: boolean;
  purchasable: boolean;
};
type WorkspaceBilling = {
  workspace: {id: number; name: string; plan: string};
  entitlements: {
    plan: string;
    limits: {maxMembers: number; maxFileBytes: number; storageQuotaBytes: number};
    usage: {members: number; storageUsedBytes: number};
    features: {auditLog: boolean};
    readOnly: boolean;
    inGrace: boolean;
    graceUntil: string | null;
    upgradeUi: boolean;
  };
  plans: Plan[];
  canManage: boolean;
  payments: {ready: boolean; mode: 'test' | 'live'} | null;
};
type Checkout = {choose: true; gateways: {slug: string; name: string}[]} | {choose: false; redirectUrl: string};

const billingQuery = (id: number) =>
  queryOptions({queryKey: ['billing', 'app', id], queryFn: () => call<WorkspaceBilling>('GET', `/workspaces/${id}/billing`)});

const planName = (t: ReturnType<typeof useT>, plan: string) => (['free', 'pro', 'team'].includes(plan) ? t(`billing.plan.${plan}` as 'billing.plan.free') : plan);

/** Translated "Test mode" badge: shown wherever checkout appears (HANDOFF §2). */
function TestMode({mode}: {mode: 'test' | 'live' | null | undefined}) {
  const t = useT();
  if (mode === 'live') return null;
  return (
    <Badge tone="warning" icon="warning">
      {t('billing.testModeHint')}
    </Badge>
  );
}

function Usage({label, used, limit, text}: {label: string; used: number; limit: number; text: string}) {
  return (
    <div className="lf-usage">
      <div className="lf-usage-head">
        <span>{label}</span>
        <span className="muted">{text}</span>
      </div>
      <ProgressBar label={label} value={used} max={Math.max(1, limit)} />
    </div>
  );
}

/** `/app/settings/billing`: plan, usage against limits, and the upgrade drawer (sandbox checkout). */
export function Billing() {
  const t = useT();
  const {formatNumber, formatDate} = useI18n();
  const {current, pending: loadingWorkspace} = useWorkspace();
  const billing = useQuery({...billingQuery(current?.id ?? 0), enabled: current !== null});
  const [open, setOpen] = useState(false);
  const data = billing.data;
  const biggerPlans = data ? bigger(data) : [];

  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader
        title={t('billing.title')}
        description={t('billing.description')}
        actions={
          data?.entitlements.upgradeUi && data.canManage ? (
            <Button icon="zap" onClick={() => setOpen(true)} disabled={biggerPlans.length === 0}>
              {t('billing.changePlan')}
            </Button>
          ) : undefined
        }
      />
      {loadingWorkspace || (current && billing.isPending) ? (
        <LoadingBlock rows={4} />
      ) : !current ? (
        <EmptyState icon="layers" title={t('billing.emptyTitle')}>
          {t('billing.emptyBody')}
        </EmptyState>
      ) : billing.error || !data ? (
        <Notice tone="danger" action={<Button variant="secondary" icon="refresh" onClick={() => void billing.refetch()}>{t('common.retry')}</Button>}>
          {billing.error ? (billing.error as ApiError).message : t('errors.unknown')}
        </Notice>
      ) : (
        <>
          {data.entitlements.readOnly && <Notice tone="danger">{t('billing.readOnly')}</Notice>}
          {!data.entitlements.readOnly && data.entitlements.inGrace && data.entitlements.graceUntil && (
            <Notice tone="warning">{t('billing.grace', {date: formatDate(data.entitlements.graceUntil)})}</Notice>
          )}
          {!data.entitlements.upgradeUi && <Notice tone="info">{t('billing.freeForAll')}</Notice>}
          <Card title={t('billing.currentPlan')} actions={<Badge tone="brand">{planName(t, data.entitlements.plan)}</Badge>}>
            <div className="lf-form">
              <Usage
                label={t('billing.members')}
                used={data.entitlements.usage.members}
                limit={data.entitlements.limits.maxMembers}
                text={t('billing.usedOf', {
                  used: formatNumber(data.entitlements.usage.members),
                  limit: formatNumber(data.entitlements.limits.maxMembers),
                })}
              />
              <Usage
                label={t('billing.storage')}
                used={data.entitlements.usage.storageUsedBytes}
                limit={data.entitlements.limits.storageQuotaBytes}
                text={t('billing.usedOf', {
                  used: formatBytes(data.entitlements.usage.storageUsedBytes),
                  limit: formatBytes(data.entitlements.limits.storageQuotaBytes),
                })}
              />
              <dl className="lf-settings-list">
                <dt>{t('billing.maxFile')}</dt>
                <dd>{formatBytes(data.entitlements.limits.maxFileBytes)}</dd>
                <dt>{t('billing.auditLog')}</dt>
                <dd>{data.entitlements.features.auditLog ? t('common.on') : t('common.off')}</dd>
              </dl>
            </div>
          </Card>
          {data.canManage && data.entitlements.upgradeUi && <Subscription workspaceId={current.id} />}
          {data.entitlements.upgradeUi && !data.canManage && <Notice tone="info">{t('billing.adminOnly')}</Notice>}
          <UpgradeDrawer open={open} onClose={() => setOpen(false)} workspaceId={current.id} data={data} />
        </>
      )}
    </div>
  );
}

function bigger(data: WorkspaceBilling): Plan[] {
  const now = data.plans.find(plan => plan.plan === data.entitlements.plan);
  return data.plans.filter(plan => plan.purchasable && (!now || plan.storageQuotaBytes > now.storageQuotaBytes));
}

function UpgradeDrawer({open, onClose, workspaceId, data}: {open: boolean; onClose: () => void; workspaceId: number; data: WorkspaceBilling}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const options = bigger(data);
  const [picked, setPicked] = useState('');
  const [gateways, setGateways] = useState<{slug: string; name: string}[] | null>(null);
  const [gateway, setGateway] = useState('');
  const selected = picked || options[0]?.plan || '';

  const cooldown = useWriteCooldown();
  const start = useMutation({
    mutationFn: () =>
      call<Checkout>('POST', `/workspaces/${workspaceId}/billing/checkout`, {plan: selected, ...(gateway ? {gateway} : {})}),
    onSuccess: result => {
      if (result.choose) {
        setGateways(result.gateways);
        setGateway(result.gateways[0]?.slug ?? '');
      } else window.location.assign(result.redirectUrl);
    },
  });
  const close = () => {
    if (start.isPending) return;
    setPicked('');
    setGateways(null);
    setGateway('');
    start.reset();
    onClose();
  };
  const summary = (plan: Plan) =>
    t('billing.planSummary', {members: plan.maxMembers, file: formatBytes(plan.maxFileBytes), storage: formatBytes(plan.storageQuotaBytes)});

  return (
    <Drawer
      open={open}
      onClose={close}
      dismissible={!start.isPending}
      title={t('billing.upgradeTitle')}
      description={t('billing.drawerBody')}
      onSubmit={event => {
        event.preventDefault();
        if (selected) start.mutate();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={start.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!selected || cooldown.blocked} pending={start.isPending} pendingLabel={t('billing.opening')}>
            {gateways ? t('billing.continue') : t('billing.goToCheckout')}
          </Button>
        </>
      }>
      <div className="form-stack">
        <TestMode mode={data.payments?.mode ?? 'test'} />
        {data.payments && !data.payments.ready && <Notice tone="warning">{t('billing.paymentsNotReady')}</Notice>}
        {options.length === 0 ? (
          <Notice tone="info">{t('billing.noBiggerPlan')}</Notice>
        ) : (
          <RadioCards
            legend={t('billing.planLegend')}
            name="plan"
            columns={1}
            value={selected}
            onChange={setPicked}
            options={options.map(plan => ({value: plan.plan, title: planName(t, plan.plan), description: summary(plan)}))}
          />
        )}
        {gateways && (
          <RadioCards
            legend={t('billing.payWith')}
            name="gateway"
            columns={1}
            value={gateway}
            onChange={setGateway}
            options={gateways.map(way => ({value: way.slug, title: way.name}))}
          />
        )}
        {start.error && (
          <Notice tone="danger" title={t('billing.checkoutError')}>
            {errorMessage(start.error)}
          </Notice>
        )}
      </div>
    </Drawer>
  );
}

const GRANTING = new Set(['active', 'trialing', 'past_due']);

/** The workspace's paid plan: the current row of `GET /memberships` for this workspace (newest first), if it still grants access. */
function currentMembership(rows: MembershipT[] | undefined, workspaceId: number): MembershipT | null {
  const now = Date.now();
  return (
    rows?.find(
      row => row.workspaceId === workspaceId && (GRANTING.has(row.status) || (row.accessEndsAt !== null && Date.parse(row.accessEndsAt) > now))
    ) ?? null
  );
}

/** Owners and admins only (the parent checks `canManage`; the server checks again): the plan's renewal or end date and "Cancel plan". */
function Subscription({workspaceId}: {workspaceId: number}) {
  const t = useT();
  const {formatDate, errorMessage} = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const memberships = useQuery(membershipsQuery);
  const row = currentMembership(memberships.data, workspaceId);

  const cooldown = useWriteCooldown();
  const cancel = useMutation({
    mutationFn: (id: string) => api.memberships.cancel(id, true),
    onSuccess: () =>
      // The row, the plan and its limits all change: refresh them (the row updates in place).
      Promise.all([
        queryClient.invalidateQueries({queryKey: ['memberships']}),
        queryClient.invalidateQueries({queryKey: ['billing']}),
        queryClient.invalidateQueries({queryKey: ['workspaces']}),
      ]),
  });

  if (memberships.isPending) return <LoadingBlock rows={2} />;
  if (memberships.error) {
    return (
      <Notice tone="danger" action={<Button variant="secondary" icon="refresh" onClick={() => void memberships.refetch()}>{t('common.retry')}</Button>}>
        {errorMessage(memberships.error)}
      </Notice>
    );
  }
  if (!row) return null;
  const ending = row.accessEndsAt !== null;
  const date = ending ? row.accessEndsAt : row.currentPeriodEnd;

  const ask = async () => {
    const done = await confirm({
      title: t('billing.cancelTitle'),
      body: t('billing.cancelBody'),
      confirmLabel: t('billing.cancelConfirm'),
      pendingLabel: t('billing.cancelling'),
      tone: 'danger',
      // The dialog stays open and shows the words when it fails; the button is usable again.
      action: () =>
        cancel.mutateAsync(row.subscriptionId).catch(error => {
          throw new Error(errorMessage(error));
        }),
    });
    if (done) toast.success(t('billing.cancelled'));
  };

  return (
    <Card
      title={t('billing.subscription')}
      actions={
        ending ? undefined : (
          <Button variant="danger" icon="x" onClick={() => void ask()} pending={cancel.isPending} pendingLabel={t('billing.cancelling')} disabled={cancel.isPending || cooldown.blocked}>
            {t('billing.cancelPlan')}
          </Button>
        )
      }>
      <p>
        {date ? t(ending ? 'billing.accessUntil' : 'billing.renewsOn', {date: formatDate(date)}) : planName(t, row.priceKey)}
      </p>
    </Card>
  );
}

import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {api, ApiError, read} from '../api';
import {formatBytes, PlanBadge, planLabel, TestModeBadge} from '../billing-shared';
import {billingSettingsQuery, type MyWorkspace, myWorkspacesQuery, type PlanInfo, workspaceBillingQuery} from '../queries';
import {when} from '../shared';
import {
  Button,
  Card,
  type Column,
  DataTable,
  Drawer,
  EmptyState,
  ErrorNote,
  LoadingBlock,
  Notice,
  PageHeader,
  ProgressBar,
  RadioCards,
  SettingRow,
  Switch,
  useConfirm,
  useToast,
  useCooldown,
} from '../ui';

type Checkout = {choose: true; gateways: {slug: string; name: string}[]} | {choose: false; redirectUrl: string};

const planSummary = (plan: PlanInfo) =>
  `${plan.maxMembers} members, ${formatBytes(plan.maxFileBytes)} files, ${formatBytes(plan.storageQuotaBytes)} storage${plan.auditLog ? ', audit log' : ''}`;

/** `/dashboard/billing`: the billing mode (site owners) and the plan of each workspace you own or administer. */
export function Billing() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const settings = useQuery(billingSettingsQuery);
  const mine = useQuery(myWorkspacesQuery);
  const [upgrading, setUpgrading] = useState<MyWorkspace | null>(null);

  const setMode = useMutation({
    mutationFn: (billingMode: 'PAID' | 'FREE_FOR_ALL') =>
      read(api.billing.settings.$put({json: {billingMode, graceDays: settings.data!.graceDays}})),
    onSuccess: () => queryClient.invalidateQueries({queryKey: ['billing']}),
  });
  const paid = settings.data?.billingMode === 'PAID';
  const payments = settings.data?.payments;

  const askMode = (next: boolean) =>
    void confirm({
      title: next ? 'Switch to paid plans?' : 'Make every feature free for everyone?',
      body: next
        ? `Plan limits apply again. Workspaces over their plan get ${settings.data?.graceDays ?? 14} days, then become read-only until they upgrade or shrink. Nothing is deleted.`
        : 'Every feature unlocks, plan limits stop applying (only safety caps remain) and the pricing and upgrade screens are hidden. Nothing is deleted.',
      confirmLabel: next ? 'Switch to paid' : 'Make it free for all',
      pendingLabel: 'Switching…',
      action: () => setMode.mutateAsync(next ? 'PAID' : 'FREE_FOR_ALL'),
    }).then(ok => ok && toast.success(next ? 'Plans are on.' : 'Everything is free for all.'));

  const columns: Column<MyWorkspace>[] = [
    {key: 'name', header: 'Workspace', cell: row => <span className="cell-title">{row.name}</span>},
    {key: 'plan', header: 'Plan', width: 'shrink', cell: row => <PlanBadge plan={row.plan} />},
    {key: 'members', header: 'Members', width: 'shrink', hideOnMobile: true, cell: row => row.memberCount},
    {key: 'storage', header: 'Storage used', width: 'shrink', hideOnMobile: true, cell: row => formatBytes(row.storageUsedBytes)},
    {
      key: 'grace',
      header: 'Status',
      width: 'shrink',
      cell: row => (row.graceUntil ? <span className="muted">Over limit, until {when(row.graceUntil)}</span> : <span className="muted">Within limits</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: row => (
        <Button size="sm" variant="secondary" icon="zap" aria-label={`Change plan for ${row.name}`} disabled={!paid} title={paid ? undefined : 'Turn on paid plans to change a plan'} onClick={() => setUpgrading(row)}>
          Change plan
        </Button>
      ),
    },
  ];

  return (
    <div className="app-page">
      <PageHeader
        title="Billing"
        description="Plans per workspace. Payments are sandbox only until a live payment gateway is connected."
        actions={<TestModeBadge mode={payments?.mode ?? 'test'} />}
      />

      {payments && !payments.ready && (
        <Notice tone="warning" title="Payments are not set up yet">
          The payment account cannot take a payment. Create the sandbox prices <code>pro-monthly</code> and <code>team-monthly</code> from the
          editor, then try again.
        </Notice>
      )}
      {settings.error && <ErrorNote error={settings.error} />}
      {setMode.error && <ErrorNote error={setMode.error} />}

      <Card title="Billing mode" description="Applies to the whole site.">
        {settings.isPending ? (
          <LoadingBlock rows={2} />
        ) : settings.data ? (
          <SettingRow title="Paid plans" description="Off: every feature is free for everyone and plan limits are not enforced.">
            <Switch
              label="Paid plans"
              checked={paid}
              pending={setMode.isPending}
              onChange={askMode}
            />
          </SettingRow>
        ) : null}
      </Card>

      <Card title="Your workspaces" description="Workspaces you own or administer. Changing a plan opens a test checkout." flush>
        <DataTable
          caption="Your workspaces"
          columns={columns}
          rows={mine.data?.workspaces}
          rowKey={row => row.id}
          loading={mine.isPending}
          error={mine.error}
          empty={<EmptyState icon="layout-kanban" title="No workspaces yet">Workspaces you own or administer show here with their plan.</EmptyState>}
        />
      </Card>

      <PlanDrawer workspace={upgrading} onClose={() => setUpgrading(null)} />
    </div>
  );
}

/** Pick a bigger plan and go to the (sandbox) checkout. */
function PlanDrawer({workspace, onClose}: {workspace: MyWorkspace | null; onClose: () => void}) {
  const billing = useQuery({...workspaceBillingQuery(workspace?.id ?? 0), enabled: workspace !== null});
  const [picked, setPicked] = useState<string>('');
  const [gateways, setGateways] = useState<{slug: string; name: string}[] | null>(null);
  const [gateway, setGateway] = useState('');

  const data = billing.data;
  const current = data?.plans.find(plan => plan.plan === data.workspace.plan);
  const options = (data?.plans ?? []).filter(plan => plan.purchasable && (!current || plan.storageQuotaBytes > current.storageQuotaBytes));
  const selected = picked || options[0]?.plan || '';

  const cooldown = useCooldown();
  const start = useMutation({
    mutationFn: () =>
      read<Checkout>(
        api.workspaces[':id'].billing.checkout.$post({
          param: {id: String(workspace!.id)},
          json: {plan: selected, gateway: gateway || undefined},
        })
      ),
    onSuccess: result => {
      if (result.choose) {
        setGateways(result.gateways);
        setGateway(result.gateways[0]?.slug ?? '');
      } else window.location.assign(result.redirectUrl);
    },
    onError: err => cooldown.note(err),
  });

  const close = () => {
    if (start.isPending) return;
    setPicked('');
    setGateways(null);
    setGateway('');
    start.reset();
    onClose();
  };
  const fieldError = start.error instanceof ApiError ? Object.values(start.error.fields)[0] : undefined;

  return (
    <Drawer
      open={workspace !== null}
      onClose={close}
      dismissible={!start.isPending}
      title={workspace ? `Change plan: ${workspace.name}` : 'Change plan'}
      description="You pay on the next screen. In test mode no real money moves."
      onSubmit={event => {
        event.preventDefault();
        if (selected) start.mutate();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={start.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!selected || billing.isPending || cooldown.blocked} pending={start.isPending} pendingLabel="Opening checkout…">
            {gateways ? 'Continue' : 'Go to checkout'}
          </Button>
        </>
      }>
      <div className="form-stack">
        <TestModeBadge mode={data?.payments?.mode ?? 'test'} />
        {billing.isPending && <LoadingBlock rows={2} />}
        {billing.error && <ErrorNote error={billing.error} />}
        {data && !data.canManage && <Notice tone="info">Only owners and admins of this workspace can change its plan.</Notice>}
        {data && data.canManage && options.length === 0 && (
          <Notice tone="info" title={`${planLabel(data.workspace.plan)} is the biggest plan.`}>
            There is no bigger plan to move to.
          </Notice>
        )}
        {data && data.canManage && options.length > 0 && (
          <RadioCards
            legend="Plan"
            name="plan"
            columns={1}
            value={selected}
            onChange={setPicked}
            options={options.map(plan => ({value: plan.plan, title: planLabel(plan.plan), description: planSummary(plan)}))}
          />
        )}
        {data && (
          <div>
            <p className="muted">
              Now: {planLabel(data.workspace.plan)}, {data.entitlements.usage.members} of {data.entitlements.limits.maxMembers} members,{' '}
              {formatBytes(data.entitlements.usage.storageUsedBytes)} of {formatBytes(data.entitlements.limits.storageQuotaBytes)} used.
            </p>
            <ProgressBar
              label="Storage used"
              value={data.entitlements.usage.storageUsedBytes}
              max={Math.max(1, data.entitlements.limits.storageQuotaBytes)}
            />
          </div>
        )}
        {gateways && (
          <RadioCards
            legend="Pay with"
            name="gateway"
            columns={1}
            value={gateway}
            onChange={setGateway}
            options={gateways.map(way => ({value: way.slug, title: way.name}))}
          />
        )}
        {start.error && <ErrorNote error={start.error} title={fieldError ? undefined : 'Could not open checkout'} />}
      </div>
    </Drawer>
  );
}

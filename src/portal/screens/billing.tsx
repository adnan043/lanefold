import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {api, ApiError, read} from '../api';
import {formatBytes, PlanBadge, planLabel, TestModeBadge} from '../billing-shared';
import {billingSettingsQuery, type MyWorkspace, myWorkspacesQuery, type PlanInfo, workspaceBillingQuery} from '../queries';
import {when} from '../shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorNote,
  Icon,
  LoadingBlock,
  Notice,
  PageHeader,
  ProgressBar,
  RadioCards,
  Switch,
  useConfirm,
  useToast,
  useCooldown,
} from '../ui';

type Checkout = {choose: true; gateways: {slug: string; name: string}[]} | {choose: false; redirectUrl: string};

const many = (n: number | null, what: string) => (n === null ? `unlimited ${what}` : `${n.toLocaleString('en-US')} ${what}`);
const planSummary = (plan: PlanInfo) =>
  `${many(plan.maxMembers, 'members')}, ${many(plan.maxBoards, 'boards')}, ${formatBytes(plan.maxFileBytes)} files, ${many(plan.flowRunsPerMonth, 'automation runs a month')}${plan.auditLog ? ', audit log' : ''}`;

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
      read(
        api.billing.settings.$put({
          json: {billingMode, graceDays: settings.data!.graceDays},
        })
      ),
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

  const workspaces = mine.data?.workspaces;

  return (
    <div className="app-page screen-billing">
      <PageHeader
        title="Billing"
        description="Plans per workspace. Payments are sandbox only until a live payment gateway is connected."
        actions={<TestModeBadge mode={payments?.mode ?? 'test'} />}
      />

      {payments && !payments.ready && (
        <Notice tone="warning" title="Payments are not set up yet">
          The payment account cannot take a payment. Create the sandbox prices <code>pro-monthly</code> and <code>team-monthly</code> from the editor,
          then try again.
        </Notice>
      )}
      {settings.error && <ErrorNote error={settings.error} />}
      {setMode.error && <ErrorNote error={setMode.error} />}

      <Card
        title="Billing mode"
        description="Applies to the whole site."
        actions={settings.data && <Badge tone={paid ? 'success' : 'neutral'}>{paid ? 'Paid plans on' : 'Free for all'}</Badge>}>
        {settings.isPending ? (
          <LoadingBlock rows={2} />
        ) : settings.data ? (
          <Switch
            label="Paid plans"
            description={
              paid
                ? `Plan limits apply. Workspaces over their plan get ${settings.data.graceDays} days, then become read-only until they upgrade.`
                : 'Every feature is free for everyone and plan limits are not enforced.'
            }
            checked={paid}
            pending={setMode.isPending}
            onChange={askMode}
          />
        ) : null}
      </Card>

      <Card
        title="Your workspaces"
        description="Workspaces you own or administer. Changing a plan opens a test checkout."
        actions={workspaces && workspaces.length > 0 && <span className="muted billing-count">{workspaces.length} total</span>}
        flush>
        {mine.isPending ? (
          <div className="billing-pad">
            <LoadingBlock rows={3} />
          </div>
        ) : mine.error ? (
          <div className="billing-pad">
            <ErrorNote error={mine.error} />
          </div>
        ) : !workspaces?.length ? (
          <EmptyState icon="layout-kanban" title="No workspaces yet">
            Workspaces you own or administer show here with their plan.
          </EmptyState>
        ) : (
          <ul className="billing-list" aria-label="Your workspaces">
            {workspaces.map(row => (
              <li key={row.id} className="billing-row">
                <Avatar name={row.name} size="md" />
                <div className="billing-row-main">
                  <p className="billing-row-title">
                    <span>{row.name}</span>
                    <PlanBadge plan={row.plan} />
                  </p>
                  <p className="billing-row-meta">
                    <span>
                      <Icon name="users" size={14} />
                      {row.memberCount} {row.memberCount === 1 ? 'member' : 'members'}
                    </span>
                    <span>
                      <Icon name="database" size={14} />
                      {formatBytes(row.storageUsedBytes)} used
                    </span>
                    {row.graceUntil ? (
                      <span className="billing-row-over">
                        <Icon name="warning" size={14} />
                        Over limit until {when(row.graceUntil)}
                      </span>
                    ) : (
                      <span className="billing-row-ok">
                        <Icon name="check-circle" size={14} />
                        Within limits
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="zap"
                  aria-label={`Change plan for ${row.name}`}
                  disabled={!paid}
                  title={paid ? undefined : 'Turn on paid plans to change a plan'}
                  onClick={() => setUpgrading(row)}>
                  Change plan
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PlanDrawer workspace={upgrading} onClose={() => setUpgrading(null)} />
    </div>
  );
}

/** Pick a bigger plan and go to the (sandbox) checkout. */
function PlanDrawer({workspace, onClose}: {workspace: MyWorkspace | null; onClose: () => void}) {
  const billing = useQuery({
    ...workspaceBillingQuery(workspace?.id ?? 0),
    enabled: workspace !== null,
  });
  const [picked, setPicked] = useState<string>('');
  const [gateways, setGateways] = useState<{slug: string; name: string}[] | null>(null);
  const [gateway, setGateway] = useState('');

  const data = billing.data;
  const current = data?.plans.find(plan => plan.plan === data.workspace.plan);
  const options = (data?.plans ?? []).filter(plan => plan.purchasable && (!current || plan.rank > current.rank));
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
          <Button
            type="submit"
            disabled={!selected || billing.isPending || cooldown.blocked}
            pending={start.isPending}
            pendingLabel="Opening checkout…">
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
            options={options.map(plan => ({
              value: plan.plan,
              title: planLabel(plan.plan),
              description: planSummary(plan),
            }))}
          />
        )}
        {data && (
          <div>
            <p className="muted">
              Now: {planLabel(data.workspace.plan)},{' '}
              {data.entitlements.unlimited.members ? `${data.entitlements.usage.members} members` : `${data.entitlements.usage.members} of ${data.entitlements.limits.maxMembers} members`},{' '}
              {data.entitlements.unlimited.boards ? `${data.entitlements.usage.boards} open boards` : `${data.entitlements.usage.boards} of ${data.entitlements.limits.maxBoards} open boards`},{' '}
              {data.entitlements.limits.flowRunsPerMonth === null
                ? `${data.entitlements.usage.flowRuns} automation runs this month`
                : `${data.entitlements.usage.flowRuns} of ${data.entitlements.limits.flowRunsPerMonth} automation runs this month`}
              .
            </p>
            {!data.entitlements.unlimited.boards && (
              <ProgressBar label="Open boards" value={data.entitlements.usage.boards} max={Math.max(1, data.entitlements.limits.maxBoards)} />
            )}
          </div>
        )}
        {gateways && (
          <RadioCards
            legend="Pay with"
            name="gateway"
            columns={1}
            value={gateway}
            onChange={setGateway}
            options={gateways.map(way => ({
              value: way.slug,
              title: way.name,
            }))}
          />
        )}
        {start.error && <ErrorNote error={start.error} title={fieldError ? undefined : 'Could not open checkout'} />}
      </div>
    </Drawer>
  );
}

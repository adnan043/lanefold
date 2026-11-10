import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {api, ApiError, read} from '../api';
import {formatBytes, PlanBadge, planLabel} from '../billing-shared';
import {type PlanRow, planLimitsQuery} from '../queries';
import {Badge, Button, Card, Checkbox, type Column, DataTable, Drawer, EmptyState, ErrorNote, Field, Notice, PageHeader, useForm, useToast} from '../ui';

const MB = 1024 * 1024;
const GB = 1024 * MB;

const range = (min: number, max: number, what: string) => (value: string) =>
  /^\d{1,6}$/.test(value.trim()) && Number(value) >= min && Number(value) <= max ? null : `${what}: a whole number from ${min} to ${max}.`;

/** The SAME limits `src/server/routes/billing.ts` enforces (the safety caps in entitlements.ts). */
const RULES = {
  maxMembers: [range(1, 500, 'Members')],
  maxFileMb: [range(1, 100, 'File size in MB')],
  storageGb: [range(1, 200, 'Storage in GB')],
  maxFlows: [range(0, 200, 'Flows (0 turns them off)')],
};

type Values = {maxMembers: string; maxFileMb: string; storageGb: string; maxFlows: string; auditLog: boolean};
const valuesOf = (plan: PlanRow): Values => ({
  maxMembers: String(plan.maxMembers),
  maxFileMb: String(Math.round(plan.maxFileBytes / MB)),
  storageGb: String(Math.round(plan.storageQuotaBytes / GB)),
  maxFlows: String(plan.maxFlows),
  auditLog: plan.auditLog,
});

/** `/dashboard/plans`: what each plan includes (`site:plans:manage`). */
export function PlanLimits() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const plans = useQuery(planLimitsQuery);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const form = useForm<Values>({maxMembers: '', maxFileMb: '', storageGb: '', maxFlows: '', auditLog: false}, RULES);

  const save = useMutation({
    mutationFn: (values: Values) =>
      read(
        api.billing.plans[':plan'].$patch({
          param: {plan: editing!.plan},
          json: {
            maxMembers: Number(values.maxMembers),
            maxFileMb: Number(values.maxFileMb),
            storageGb: Number(values.storageGb),
            maxFlows: Number(values.maxFlows),
            auditLog: values.auditLog,
            // The route READS maxFileMb / storageGb (what the form edits) but Hono types the body as the validator's
            // OUTPUT (bytes), so the typed client needs this cast; the wire shape is the one above.
          } as never,
        })
      ),
    onSuccess: () => {
      toast.success(`${planLabel(editing!.plan)} saved.`);
      setEditing(null);
      return queryClient.invalidateQueries({queryKey: ['billing']});
    },
    onError: err => {
      form.noteError(err);
      if (err instanceof ApiError) form.setServerErrors(err.fields);
    },
  });

  const open = (plan: PlanRow) => {
    form.reset(valuesOf(plan));
    save.reset();
    setEditing(plan);
  };
  const close = () => {
    if (save.isPending) return;
    setEditing(null);
  };
  const saveFailed = save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length);

  const columns: Column<PlanRow>[] = [
    {key: 'plan', header: 'Plan', cell: row => <PlanBadge plan={row.plan} />},
    {key: 'members', header: 'Members', width: 'shrink', cell: row => row.maxMembers},
    {key: 'file', header: 'Largest file', width: 'shrink', hideOnMobile: true, cell: row => formatBytes(row.maxFileBytes)},
    {key: 'storage', header: 'Storage', width: 'shrink', cell: row => formatBytes(row.storageQuotaBytes)},
    {key: 'flows', header: 'Flows', width: 'shrink', hideOnMobile: true, cell: row => row.maxFlows},
    {key: 'audit', header: 'Audit log', width: 'shrink', hideOnMobile: true, cell: row => (row.auditLog ? <Badge tone="success">On</Badge> : <span className="muted">Off</span>)},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: row => (
        <Button size="sm" variant="secondary" icon="pencil" aria-label={`Edit ${planLabel(row.plan)}`} onClick={() => open(row)}>
          Edit
        </Button>
      ),
    },
  ];

  return (
    <div className="app-page">
      <PageHeader title="Plan limits" description="What each plan includes. Applies to every workspace on that plan, at once." />
      <Notice tone="info">
        Lowering a limit never deletes anything: workspaces now over it get the grace period, then become read-only until they shrink or upgrade.
      </Notice>
      <Card flush>
        <DataTable
          caption="Plans"
          columns={columns}
          rows={plans.data?.plans}
          rowKey={row => row.plan}
          loading={plans.isPending}
          error={plans.error}
          empty={<EmptyState icon="settings" title="No plans found">Plans appear here once the plan table is seeded.</EmptyState>}
        />
      </Card>

      <Drawer
        open={editing !== null}
        onClose={close}
        dismissible={!save.isPending}
        title={editing ? `Edit ${planLabel(editing.plan)}` : 'Edit plan'}
        description="Changes apply to workspaces on this plan straight away."
        onSubmit={form.submit(values => save.mutate(values))}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={form.blocked}>
              Save changes
            </Button>
          </>
        }>
        <div className="form-stack">
          <div className="form-grid">
            <Field id="f-maxMembers" label="Members" error={form.error('maxMembers')}>
              <input {...form.field('maxMembers')} inputMode="numeric" autoComplete="off" placeholder="e.g. 10" />
            </Field>
            <Field id="f-maxFlows" label="Flows" hint="0 turns flows off." error={form.error('maxFlows')}>
              <input {...form.field('maxFlows')} inputMode="numeric" autoComplete="off" placeholder="e.g. 5" />
            </Field>
          </div>
          <div className="form-grid">
            <Field id="f-maxFileMb" label="Largest file (MB)" hint="Up to 100." error={form.error('maxFileMb')}>
              <input {...form.field('maxFileMb')} inputMode="numeric" autoComplete="off" placeholder="e.g. 25" />
            </Field>
            <Field id="f-storageGb" label="Storage (GB)" error={form.error('storageGb')}>
              <input {...form.field('storageGb')} inputMode="numeric" autoComplete="off" placeholder="e.g. 5" />
            </Field>
          </div>
          <Checkbox
            label="Audit log"
            description="Workspace admins can see who did what."
            checked={form.values.auditLog}
            onChange={checked => form.set('auditLog', checked)}
          />
          {saveFailed && <ErrorNote error={save.error!} />}
        </div>
      </Drawer>
    </div>
  );
}

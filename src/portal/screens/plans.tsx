import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {api, ApiError, read} from '../api';
import {FILE_CEILING_LABEL, FILE_CEILING_MB} from '../../lib/file-limits';
import {MAX_BOARDS_CAP, MAX_FLOW_RUNS_INPUT, UNLIMITED_MEMBERS} from '../../lib/plan-limits';
import {formatBytes, PlanBadge, planLabel} from '../billing-shared';
import {type PlanRow, planLimitsQuery} from '../queries';
import {Badge, Button, Card, Checkbox, type Column, DataTable, Drawer, EmptyState, ErrorNote, Field, Notice, PageHeader, useForm, useToast} from '../ui';

const MB = 1024 * 1024;

const range = (min: number, max: number, what: string) => (value: string) =>
  /^\d{1,7}$/.test(value.trim()) && Number(value) >= min && Number(value) <= max ? null : `${what}: a whole number from ${min} to ${max}.`;
/** Empty = unlimited; otherwise the same range. */
const optional = (min: number, max: number, what: string) => (value: string) => (value.trim() === '' ? null : range(min, max, what)(value));

/** The SAME limits `src/server/routes/billing.ts` enforces (src/lib/plan-limits.ts; file size: src/lib/file-limits.ts). */
const RULES = {
  maxMembers: [optional(1, UNLIMITED_MEMBERS - 1, 'Members (empty = unlimited)')],
  maxBoards: [optional(1, MAX_BOARDS_CAP - 1, 'Open boards (empty = unlimited)')],
  maxFileMb: [range(1, FILE_CEILING_MB, 'File size in MB')],
  flowRunsPerMonth: [optional(0, MAX_FLOW_RUNS_INPUT, 'Automation runs a month (empty = unlimited, 0 = off)')],
};

type Values = {maxMembers: string; maxBoards: string; maxFileMb: string; flowRunsPerMonth: string; auditLog: boolean};
const text = (n: number | null) => (n === null ? '' : String(n));
const valuesOf = (plan: PlanRow): Values => ({
  maxMembers: text(plan.maxMembers),
  maxBoards: text(plan.maxBoards),
  maxFileMb: String(Math.round(plan.maxFileBytes / MB)),
  flowRunsPerMonth: text(plan.flowRunsPerMonth),
  auditLog: plan.auditLog,
});
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const countCell = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString('en-US'));

/** `/dashboard/plans`: what each plan includes (`site:plans:manage`). */
export function PlanLimits() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const plans = useQuery(planLimitsQuery);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const form = useForm<Values>({maxMembers: '', maxBoards: '', maxFileMb: '', flowRunsPerMonth: '', auditLog: false}, RULES);

  const save = useMutation({
    mutationFn: (values: Values) =>
      read(
        api.billing.plans[':plan'].$patch({
          param: {plan: editing!.plan},
          json: {
            maxMembers: numberOrNull(values.maxMembers),
            maxBoards: numberOrNull(values.maxBoards),
            maxFileMb: Number(values.maxFileMb),
            flowRunsPerMonth: numberOrNull(values.flowRunsPerMonth),
            auditLog: values.auditLog,
            // The route READS maxFileMb (what the form edits) but Hono types the body as the validator's
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
    {key: 'members', header: 'Members', width: 'shrink', cell: row => countCell(row.maxMembers)},
    {key: 'boards', header: 'Open boards', width: 'shrink', cell: row => countCell(row.maxBoards)},
    {key: 'file', header: 'Largest file', width: 'shrink', hideOnMobile: true, cell: row => formatBytes(row.maxFileBytes)},
    {key: 'flows', header: 'Automation runs / month', width: 'shrink', hideOnMobile: true, cell: row => (row.flowRunsPerMonth === 0 ? 'Off' : countCell(row.flowRunsPerMonth))},
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
        Limits work like Trello: members, open boards, file size and automation runs a month. There is no storage limit. Lowering the member limit never deletes anything: workspaces now over it get the grace period, then become read-only until they shrink or upgrade. Over the board limit, a workspace keeps its boards but cannot open new ones.
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
            <Field id="f-maxMembers" label="Members" hint="Leave empty for unlimited." error={form.error('maxMembers')}>
              <input {...form.field('maxMembers')} inputMode="numeric" autoComplete="off" placeholder="e.g. 10" />
            </Field>
            <Field id="f-maxBoards" label="Open boards" hint="Leave empty for unlimited." error={form.error('maxBoards')}>
              <input {...form.field('maxBoards')} inputMode="numeric" autoComplete="off" placeholder="e.g. 10" />
            </Field>
          </div>
          <div className="form-grid">
            <Field id="f-maxFileMb" label="Largest file (MB)" hint={`Up to ${FILE_CEILING_MB} (${FILE_CEILING_LABEL}).`} error={form.error('maxFileMb')}>
              <input {...form.field('maxFileMb')} inputMode="numeric" autoComplete="off" placeholder="e.g. 10" />
            </Field>
            <Field id="f-flowRunsPerMonth" label="Automation runs a month" hint="Empty for unlimited, 0 turns Flows off." error={form.error('flowRunsPerMonth')}>
              <input {...form.field('flowRunsPerMonth')} inputMode="numeric" autoComplete="off" placeholder="e.g. 250" />
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

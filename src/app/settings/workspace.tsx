import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';
import {useState, type FormEvent} from 'react';

import {useI18n, useT, type MessageKey} from '../../i18n';
import {Button, buttonClass, Card, EmptyState, Field, LoadingBlock, Modal, Notice, PageHeader, Select, useForm, useToast} from '../../portal/ui';
import {call} from '../api';
import {useDraft} from '../use-draft';
import {membersListQuery} from '../members/queries';
import {useWorkspace} from '../workspace';
import {useWriteCooldown} from '../write-cooldown';
import {SettingsNav} from './nav';

const NAME_MAX = 80;
const KNOWN_ROLES = ['owner', 'admin', 'member', 'viewer'];

/** A role as words in the person's language, never its slug. */
function useRoleLabel() {
  const {has} = useI18n();
  return (role: string) => (KNOWN_ROLES.includes(role) ? has(`members.role.${role}`) : undefined) ?? role;
}

/** Same rule as the server (`textField(name, 1, 80)`: trimmed, 1 to 80 characters). */
function useNameRules() {
  const t = useT();
  return [
    (value: string) => (value.trim().length < 1 ? t('workspaceSettings.nameRequired') : null),
    (value: string) => (value.trim().length > NAME_MAX ? t('workspaceSettings.nameTooLong') : null),
  ];
}

function RenameForm({workspaceId, name, canEdit}: {workspaceId: number; name: string; canEdit: boolean}) {
  const t = useT();
  const {errorMessage, fieldErrors} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useForm({name}, {name: useNameRules()});
  const [status, setStatus] = useState<string | null>(null);
  const clearDraft = useDraft('wsname', workspaceId, form.values.name, text => form.set('name', text), name, canEdit);
  const rename = useMutation({
    mutationFn: (next: string) => call<{workspace: {name: string}}>('PATCH', `/workspaces/${workspaceId}`, {name: next}),
    onSuccess: async (res, next) => {
      setStatus(null);
      clearDraft();
      form.reset({name: res.workspace.name || next});
      await queryClient.invalidateQueries({queryKey: ['workspaces']});
      toast.success(t('workspaceSettings.renamed'));
    },
    onError: error => {
      form.noteError(error);
      const fields = fieldErrors(error);
      if (fields.name) form.setServerErrors({name: fields.name});
      else setStatus(errorMessage(error));
    },
  });
  const unchanged = form.values.name.trim() === name;
  return (
    <form
      noValidate
      className="lf-form"
      onSubmit={form.submit(values => {
        setStatus(null);
        rename.mutate(values.name.trim());
      }) as (event: FormEvent) => void}>
      <Field id="f-name" label={t('workspaceSettings.name')} error={form.error('name')} hint={canEdit ? undefined : t('workspaceSettings.adminOnly')}>
        <input {...form.field('name')} readOnly={!canEdit} autoComplete="off" placeholder={t('onboarding.namePlaceholder')} />
      </Field>
      {status && (
        <p className="field-error" role="alert">
          {status}
        </p>
      )}
      {canEdit && (
        <div className="lf-form-actions">
          <Button type="submit" pending={rename.isPending} pendingLabel={t('common.saving')} disabled={unchanged || form.blocked}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

function TransferDialog({open, onClose, workspaceId, workspaceName}: {open: boolean; onClose: () => void; workspaceId: number; workspaceName: string}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const members = useInfiniteQuery({...membersListQuery(workspaceId), enabled: open});
  const others = (members.data?.pages.flatMap(page => page.items) ?? []).filter(m => !m.isMe);
  const [target, setTarget] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cooldown = useWriteCooldown();
  const transfer = useMutation({
    mutationFn: (userId: number) => call('POST', `/workspaces/${workspaceId}/transfer`, {userId}),
  });
  const person = others.find(m => String(m.userId) === target);
  const matches = typed.trim() === workspaceName;
  const close = () => {
    if (transfer.isPending) return;
    setTarget('');
    setTyped('');
    setError(null);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!person) {
      setError(t('workspaceSettings.transfer.pickError'));
      return;
    }
    if (!matches) {
      setError(t('workspaceSettings.transfer.mismatch'));
      return;
    }
    setError(null);
    try {
      await transfer.mutateAsync(person.userId);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await Promise.all([queryClient.invalidateQueries({queryKey: ['workspaces']}), queryClient.invalidateQueries({queryKey: ['members']})]);
    toast.success(t('workspaceSettings.transfer.done', {name: person.name ?? t('workspaceSettings.transfer.unnamed')}));
    close();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!transfer.isPending}
      title={t('workspaceSettings.transfer.dialogTitle', {name: workspaceName})}
      description={t('workspaceSettings.transfer.dialogBody')}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={transfer.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="transfer-form" variant="danger" pending={transfer.isPending} pendingLabel={t('workspaceSettings.transfer.pending')} disabled={!person || !matches || cooldown.blocked}>
            {t('workspaceSettings.transfer.submit')}
          </Button>
        </>
      }>
      {members.isPending ? (
        <LoadingBlock rows={2} />
      ) : members.isError ? (
        <Notice tone="danger">{errorMessage(members.error)}</Notice>
      ) : others.length === 0 ? (
        <Notice tone="info">{t('workspaceSettings.transfer.noMembers')}</Notice>
      ) : (
        <form id="transfer-form" noValidate className="lf-form" onSubmit={e => void submit(e)}>
          <Field id="f-transfer-to" label={t('workspaceSettings.transfer.person')}>
            <Select
              id="f-transfer-to"
              value={target}
              disabled={transfer.isPending}
              onChange={event => setTarget(event.target.value)}
              options={[
                {value: '', label: t('workspaceSettings.transfer.choose')},
                ...others.map(m => ({value: String(m.userId), label: m.name ?? t('workspaceSettings.transfer.unnamed')})),
              ]}
            />
          </Field>
          {members.hasNextPage && (
            <div>
              <Button variant="secondary" size="sm" type="button" pending={members.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void members.fetchNextPage()}>
                {t('workspaceSettings.transfer.more')}
              </Button>
            </div>
          )}
          <Field id="f-transfer-confirm" label={t('workspaceSettings.transfer.confirmLabel', {name: workspaceName})}>
            <input id="f-transfer-confirm" value={typed} placeholder={workspaceName} autoComplete="off" disabled={transfer.isPending} onChange={event => setTyped(event.target.value)} />
          </Field>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

function ArchiveDialog({open, onClose, workspaceId, workspaceName}: {open: boolean; onClose: () => void; workspaceId: number; workspaceName: string}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cooldown = useWriteCooldown();
  const archive = useMutation({
    mutationFn: (confirmName: string) => call('POST', `/workspaces/${workspaceId}/archive`, {confirmName}),
  });
  const matches = typed.trim() === workspaceName;
  const close = () => {
    if (archive.isPending) return;
    setTyped('');
    setError(null);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) {
      setError(t('workspaceSettings.archive.mismatch'));
      return;
    }
    setError(null);
    try {
      await archive.mutateAsync(typed.trim());
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await Promise.all([queryClient.invalidateQueries({queryKey: ['workspaces']}), queryClient.invalidateQueries({queryKey: ['archived-workspaces']})]);
    toast.success(t('workspaceSettings.archive.done', {name: workspaceName}));
    setTyped('');
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!archive.isPending}
      title={t('workspaceSettings.archive.dialogTitle', {name: workspaceName})}
      description={t('workspaceSettings.archive.dialogBody')}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={archive.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="archive-form" variant="danger" pending={archive.isPending} pendingLabel={t('workspaceSettings.archive.pending')} disabled={!matches || cooldown.blocked}>
            {t('workspaceSettings.archive.submit')}
          </Button>
        </>
      }>
      <form id="archive-form" noValidate className="lf-form" onSubmit={e => void submit(e)}>
        <Field id="f-archive-confirm" label={t('workspaceSettings.archive.confirmLabel', {name: workspaceName})}>
          <input id="f-archive-confirm" value={typed} placeholder={workspaceName} autoComplete="off" disabled={archive.isPending} onChange={event => setTyped(event.target.value)} />
        </Field>
        <p className="muted">{t('workspaceSettings.archive.billingWarning')}</p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

type ArchivedWorkspace = {id: number; name: string; archivedAt: string};

/** The owner's archived workspaces, each with Restore. The server lists only the ones this person owns. */
function ArchivedList() {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const list = useQuery({queryKey: ['archived-workspaces'], queryFn: () => call<{items: ArchivedWorkspace[]}>('GET', '/workspaces/archived').then(r => r.items)});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cooldown = useWriteCooldown();
  const restore = async (ws: ArchivedWorkspace) => {
    setBusyId(ws.id);
    setError(null);
    try {
      await call('POST', `/workspaces/${ws.id}/restore`);
      await Promise.all([queryClient.invalidateQueries({queryKey: ['workspaces']}), queryClient.invalidateQueries({queryKey: ['archived-workspaces']})]);
      toast.success(t('workspaceSettings.archive.restored', {name: ws.name}));
    } catch (err) {
      cooldown.note(err);
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };
  if (!list.data?.length) return null;
  return (
    <Card title={t('workspaceSettings.archive.restoreTitle')} description={t('workspaceSettings.archive.restoreDescription')}>
      <ul className="lf-settings-list">
        {list.data.map(ws => (
          <li key={ws.id}>
            <span>{ws.name}</span>{' '}
            <Button variant="secondary" size="sm" type="button" pending={busyId === ws.id} pendingLabel={t('workspaceSettings.archive.restoring')} disabled={(busyId !== null && busyId !== ws.id) || cooldown.blocked} onClick={() => void restore(ws)}>
              {t('workspaceSettings.archive.restore')}
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * `/app/settings/workspace`: the current workspace. Admins and owners rename it, owners hand it to another
 * member (they become an admin). Authorization is the server's (`PATCH /workspaces/:id`, `POST .../transfer`);
 * the buttons only follow the role the server reported.
 */
export function WorkspaceSettings() {
  const t = useT();
  const roleLabel = useRoleLabel();
  const {current, pending} = useWorkspace();
  const [transferOpen, setTransferOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const canEdit = current?.role === 'owner' || current?.role === 'admin';
  const isOwner = current?.role === 'owner';
  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('workspaceSettings.title')} description={t('workspaceSettings.description')} />
      {pending ? (
        <LoadingBlock rows={3} />
      ) : !current ? (
        <EmptyState icon="layers" title={t('workspaceSettings.emptyTitle')}>
          {t('workspaceSettings.emptyBody')}
        </EmptyState>
      ) : (
        <>
          <Card>
            {/* Keyed by id and name: a rename elsewhere or a switch of workspace resets the form. */}
            <RenameForm key={`${current.id}:${current.name}`} workspaceId={current.id} name={current.name} canEdit={canEdit} />
          </Card>
          <Card>
            <dl className="lf-settings-list">
              <dt>{t('workspaceSettings.slug')}</dt>
              <dd>{current.slug}</dd>
              <dt>{t('workspaceSettings.plan')}</dt>
              <dd>{t(`billing.plan.${current.plan}` as MessageKey)}</dd>
              <dt>{t('workspaceSettings.role')}</dt>
              <dd>{roleLabel(current.role)}</dd>
              <dt>{t('workspaceSettings.members')}</dt>
              <dd>{t('workspaceSettings.memberCount', {count: current.memberCount})}</dd>
            </dl>
            <div className="lf-form-actions">
              <Link to="/members" className={buttonClass({variant: 'secondary'})}>
                {t('workspaceSettings.manageMembers')}
              </Link>
            </div>
          </Card>
          {isOwner && (
            <Card title={t('workspaceSettings.transfer.title')} description={t('workspaceSettings.transfer.description')}>
              <Button variant="danger" onClick={() => setTransferOpen(true)}>
                {t('workspaceSettings.transfer.button')}
              </Button>
              <TransferDialog open={transferOpen} onClose={() => setTransferOpen(false)} workspaceId={current.id} workspaceName={current.name} />
            </Card>
          )}
          {isOwner && (
            <Card title={t('workspaceSettings.archive.title')} description={t('workspaceSettings.archive.description')}>
              <Button variant="danger" onClick={() => setArchiveOpen(true)}>
                {t('workspaceSettings.archive.button')}
              </Button>
              <ArchiveDialog open={archiveOpen} onClose={() => setArchiveOpen(false)} workspaceId={current.id} workspaceName={current.name} />
            </Card>
          )}
        </>
      )}
      {!pending && <ArchivedList />}
    </div>
  );
}

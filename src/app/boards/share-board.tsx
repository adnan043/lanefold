import {keepPreviousData, queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {
  Badge,
  Button,
  Drawer,
  ErrorNote,
  Field,
  LoadingBlock,
  Menu,
  Notice,
  Person,
  SearchInput,
  Select,
  Switch,
  useConfirm,
  useForm,
  useToast,
} from '../../portal/ui';
import {useMe} from '../../portal/shared';
import {type ApiError, type BoardT, call} from '../api';
import {useNavigate} from '../nav';
import {useDebounced} from '../chat/api';
import './share-board.css';

type Role = 'admin' | 'member' | 'viewer';
type Member = {id: number; name: string; role: Role; seat: Role; guest: boolean; workspaceRole: string | null};
type Admin = {id: number; name: string; workspaceRole: string};
export type Members = {
  members: Member[];
  admins: Admin[];
  more: boolean;
  me: {seated: boolean; guest: boolean};
  canManage: boolean;
  canInvite: boolean;
  canJoin: boolean;
  memberInvites: 'admins' | 'members';
  selfJoin: boolean;
};
type Candidate = {id: number; name: string; workspaceRole: string};
type Pending = {id: number; role: Role; expiresAt: string; emailStatus: string | null; canRevoke: boolean};
type Invited = {result: 'added' | 'already' | 'invited'; link?: string; emailStatus?: string; emailPreview?: {subject: string; text: string; configured: boolean}};

export const boardMembersQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-members', boardId],
    queryFn: () => call<Members>('GET', `/boards/${boardId}/members`),
    staleTime: 30_000,
  });

const candidatesQuery = (boardId: number, q: string) =>
  queryOptions({
    queryKey: ['board-members', boardId, 'candidates', q],
    queryFn: () => call<{items: Candidate[]}>('GET', `/boards/${boardId}/members/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

const pendingQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-members', boardId, 'invites'],
    queryFn: () => call<{items: Pending[]}>('GET', `/boards/${boardId}/invites`),
    staleTime: 30_000,
  });

const linkQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-members', boardId, 'link'],
    queryFn: () => call<{active: boolean; role: 'member' | 'viewer' | null}>('GET', `/boards/${boardId}/invite-link`),
    staleTime: 30_000,
  });

function useRoleLabels() {
  const t = useT();
  const label = (role: string) =>
    t(role === 'admin' ? 'boards.share.role.admin' : role === 'member' ? 'boards.share.role.member' : 'boards.share.role.viewer');
  const options = (allowed: readonly Role[]) => allowed.map(value => ({value, label: label(value)}));
  return {label, options};
}

/** Copies a text; when the clipboard is blocked, selects the field so the person can copy it themselves. */
async function copyText(text: string, field: HTMLInputElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.focus();
    field?.select();
    return false;
  }
}

/** "Join board" in the board header: a workspace member takes a seat on a board they can already see. */
export function JoinBoardButton({board}: {board: BoardT}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const info = useQuery({...boardMembersQuery(board.id), enabled: !board.guest && !board.archived});
  const [busy, setBusy] = useState(false);
  if (!info.data?.canJoin) return null;
  const join = async () => {
    setBusy(true);
    try {
      await call('POST', `/boards/${board.id}/join`, {});
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['board-members', board.id]}),
        queryClient.invalidateQueries({queryKey: ['board-people', board.id]}),
        queryClient.invalidateQueries({queryKey: ['board', board.id]}),
      ]);
      toast.success(t('boards.share.joined'));
    } catch (e) {
      toast.danger(errorMessage(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" icon="user-plus" pending={busy} pendingLabel={t('boards.share.joining')} onClick={() => void join()}>
      {t('boards.share.join')}
    </Button>
  );
}

/**
 * "Share" in the board header: who is on the board and with which role. Board admins (and members, when the board
 * allows it) add workspace people, invite anyone by email (they join as a guest) or share an invite link; admins change
 * roles, remove people and set who may add people. Everyone can leave. The server checks every action again.
 */
export function ShareBoardButton({board}: {board: BoardT}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" icon="user-plus" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {t('boards.share.button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('boards.share.title')}
        description={board.visibility === 'private' ? t('boards.share.descPrivate') : t('boards.share.descWorkspace')}>
        {open && <SharePanel board={board} onLeft={() => setOpen(false)} />}
      </Drawer>
    </>
  );
}

function SharePanel({board, onLeft}: {board: BoardT; onLeft: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roles = useRoleLabels();
  const me = useMe().data?.viewer.id ?? null;
  const list = useQuery(boardMembersQuery(board.id));
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const refresh = (self = false) =>
    Promise.all([
      queryClient.invalidateQueries({queryKey: ['board-members', board.id]}),
      queryClient.invalidateQueries({queryKey: ['board-people', board.id]}),
      // My own role changed: the board's canWrite / canAdmin come from the board read.
      self ? queryClient.invalidateQueries({queryKey: ['board', board.id]}) : undefined,
    ]);

  const run = async (id: number, work: () => Promise<unknown>) => {
    setBusyId(id);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusyId(null);
    }
  };

  const setRole = (person: Member, role: Role) =>
    void run(person.id, async () => {
      await call('PUT', `/boards/${board.id}/members/${person.id}`, {role});
      await refresh(person.id === me);
      toast.success(t('boards.share.roleChanged', {name: person.name}));
    });

  const lostOnRemove = (person: Member) => person.guest || board.visibility === 'private';
  const remove = (person: Member) =>
    void confirm({
      title: t('boards.share.removeTitle', {name: person.name}),
      body: lostOnRemove(person) ? t('boards.share.removeBodyPrivate') : t('boards.share.removeBody'),
      confirmLabel: t('boards.share.remove'),
      action: async () => {
        await call('DELETE', `/boards/${board.id}/members/${person.id}`);
        await refresh();
        toast.success(t('boards.share.removed', {name: person.name}));
      },
    });

  const leave = () =>
    void confirm({
      title: t('boards.share.leaveTitle'),
      body: board.guest || board.visibility === 'private' ? t('boards.share.leaveBodyPrivate') : t('boards.share.leaveBody'),
      confirmLabel: t('boards.share.leave'),
      action: async () => {
        const res = await call<{lostAccess: boolean}>('DELETE', `/boards/${board.id}/members/${me}`);
        toast.success(t('boards.share.left'));
        if (res.lostAccess) {
          onLeft();
          queryClient.removeQueries({queryKey: ['board', board.id]});
          await Promise.all([queryClient.invalidateQueries({queryKey: ['boards']}), queryClient.invalidateQueries({queryKey: ['guest-boards']})]);
          void navigate({to: '/boards'});
        } else await refresh(true);
      },
    });

  if (list.isPending) return <LoadingBlock rows={4} />;
  if (list.isError) return <ErrorNote error={list.error} />;
  const data = list.data;
  const {members, admins, more, canManage, canInvite} = data;
  const inviteRoles: readonly Role[] = canManage ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];

  return (
    <div className="lf-share">
      {canInvite && <InviteByEmail boardId={board.id} roleChoices={inviteRoles} onDone={() => refresh()} />}
      {canInvite && <AddPeople boardId={board.id} roleChoices={inviteRoles} onAdded={() => refresh()} />}
      {canInvite && <InviteLink boardId={board.id} />}
      {canInvite && <PendingInvites boardId={board.id} />}

      <section className="lf-share-group" aria-labelledby="lf-share-members">
        <h3 id="lf-share-members">{t('boards.share.members')}</h3>
        {members.length === 0 ? (
          <p className="lf-share-empty">{t('boards.share.noMembers')}</p>
        ) : (
          <ul className="lf-share-list">
            {members.map(m => {
              const self = m.id === me;
              const busy = busyId === m.id;
              const allowed: readonly Role[] = m.guest ? ['member', 'viewer'] : m.workspaceRole === 'viewer' ? ['viewer'] : ['admin', 'member', 'viewer'];
              return (
                <li key={m.id} className="lf-share-row" aria-busy={busy || undefined}>
                  <Person name={m.name || '?'} detail={self ? t('boards.share.you') : undefined} />
                  {m.guest && <Badge tone="warning">{t('boards.share.guest')}</Badge>}
                  {canManage ? (
                    <Select
                      className="lf-share-role"
                      aria-label={t('boards.share.roleFor', {name: m.name})}
                      value={m.seat === 'admin' && m.guest ? 'member' : m.seat}
                      disabled={busyId !== null}
                      options={roles.options(allowed)}
                      onChange={event => {
                        const next = event.target.value as Role;
                        if (next !== m.seat) setRole(m, next);
                      }}
                    />
                  ) : (
                    <Badge>{roles.label(m.role)}</Badge>
                  )}
                  {(canManage || self) && (
                    <Menu
                      label={t('boards.share.actions', {name: m.name})}
                      disabled={busyId !== null}
                      items={[
                        self
                          ? {label: t('boards.share.leave'), icon: 'log-out', danger: true, onSelect: leave}
                          : {label: t('boards.share.remove'), icon: 'trash', danger: true, onSelect: () => remove(m)},
                      ]}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {more && <p className="lf-share-empty">{t('boards.people.more')}</p>}
      </section>

      <section className="lf-share-group" aria-labelledby="lf-share-admins">
        <h3 id="lf-share-admins">{t('boards.share.admins')}</h3>
        <p className="lf-share-hint">{t('boards.share.adminsHint')}</p>
        <ul className="lf-share-list">
          {admins.map(a => (
            <li key={a.id} className="lf-share-row">
              <Person name={a.name || '?'} detail={a.id === me ? t('boards.share.you') : undefined} />
              <Badge tone="brand">{roles.label('admin')}</Badge>
            </li>
          ))}
        </ul>
      </section>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {canManage && <SharingSettings boardId={board.id} data={data} />}

      {data.me.seated && !canManage && (
        <div>
          <Button variant="danger" icon="log-out" onClick={leave}>
            {t('boards.share.leave')}
          </Button>
        </div>
      )}
    </div>
  );
}

function InviteByEmail({boardId, roleChoices, onDone}: {boardId: number; roleChoices: readonly Role[]; onDone: () => Promise<unknown>}) {
  const t = useT();
  const {errorMessage, fieldErrors} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const roles = useRoleLabels();
  const [role, setRole] = useState<Role>('member');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [sent, setSent] = useState<Invited | null>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const form = useForm({email: ''}, {email: [rules.required(t('boards.share.emailInvalid')), rules.email(t('boards.share.emailInvalid')), rules.maxLength(254)]});

  const send = form.submit(async values => {
    setPending(true);
    setStatus('');
    setSent(null);
    try {
      const res = await call<Invited>('POST', `/boards/${boardId}/invites`, {email: values.email.trim(), role});
      form.reset();
      if (res.result === 'invited') {
        setSent(res);
        toast.success(res.emailStatus === 'queued' ? t('boards.share.inviteSent') : t('boards.share.inviteMade'));
        await queryClient.invalidateQueries({queryKey: ['board-members', boardId, 'invites']});
      } else {
        toast.success(res.result === 'added' ? t('boards.share.addedByEmail') : t('boards.share.alreadyOnBoard'));
        await onDone();
      }
    } catch (e) {
      form.noteError(e);
      form.setServerErrors(fieldErrors(e));
      setStatus(errorMessage(e as ApiError));
    } finally {
      setPending(false);
    }
  });

  return (
    <section className="lf-share-group" aria-labelledby="lf-share-invite">
      <h3 id="lf-share-invite">{t('boards.share.inviteTitle')}</h3>
      <p className="lf-share-hint">{t('boards.share.inviteHint')}</p>
      <form className="lf-share-invite" noValidate onSubmit={send}>
        <Field id="f-email" label={t('boards.share.emailLabel')} error={form.error('email')}>
          <input type="email" autoComplete="off" placeholder={t('boards.share.emailExample')} maxLength={254} {...form.field('email')} />
        </Field>
        <div className="lf-share-add-bar">
          <Select
            className="lf-share-role"
            aria-label={t('boards.share.role')}
            value={role}
            disabled={pending}
            options={roles.options(roleChoices)}
            onChange={event => setRole(event.target.value as Role)}
          />
          <Button type="submit" icon="mail" pending={pending} pendingLabel={t('boards.share.inviting')} disabled={form.blocked}>
            {t('boards.share.invite')}
          </Button>
        </div>
      </form>
      {status && (
        <p className="field-error" role="alert">
          {status}
        </p>
      )}
      {sent?.link && (
        <div className="lf-share-sent">
          {sent.emailStatus !== 'queued' && <Notice tone="warning">{t('boards.share.emailNotSent')}</Notice>}
          <Field id="lf-share-invite-link" label={t('boards.share.inviteLinkOnce')}>
            <input ref={linkField} readOnly value={sent.link} dir="ltr" onFocus={event => event.currentTarget.select()} />
          </Field>
          <div>
            <Button
              variant="secondary"
              icon="copy"
              onClick={() => void copyText(sent.link!, linkField.current).then(ok => ok && toast.success(t('boards.share.copied')))}>
              {t('boards.share.copy')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function AddPeople({boardId, roleChoices, onAdded}: {boardId: number; roleChoices: readonly Role[]; onAdded: () => Promise<unknown>}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const roles = useRoleLabels();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const q = useDebounced(search.trim());
  const found = useQuery(candidatesQuery(boardId, q));
  const items = found.data?.items ?? [];

  const add = async (person: Candidate) => {
    // A workspace viewer can only be a viewer on a board (the server refuses more).
    const as: Role = person.workspaceRole === 'viewer' ? 'viewer' : role;
    setBusyId(person.id);
    setError('');
    try {
      await call('PUT', `/boards/${boardId}/members/${person.id}`, {role: as});
      await onAdded();
      toast.success(t('boards.share.added', {name: person.name}));
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="lf-share-group" aria-labelledby="lf-share-add">
      <h3 id="lf-share-add">{t('boards.share.add')}</h3>
      <div className="lf-share-add-bar">
        <SearchInput
          label={t('boards.share.search')}
          placeholder={t('boards.share.search')}
          value={search}
          maxLength={80}
          onChange={event => setSearch(event.target.value)}
        />
        <Select
          className="lf-share-role"
          aria-label={t('boards.share.role')}
          value={role}
          disabled={busyId !== null}
          options={roles.options(roleChoices)}
          onChange={event => setRole(event.target.value as Role)}
        />
      </div>
      {found.isError ? (
        <ErrorNote error={found.error} />
      ) : found.isPending ? (
        <LoadingBlock rows={2} />
      ) : items.length === 0 ? (
        <p className="lf-share-empty">{q ? t('boards.share.noMatch') : t('boards.share.noCandidates')}</p>
      ) : (
        <ul className="lf-share-list">
          {items.map(p => (
            <li key={p.id} className="lf-share-row">
              <Person name={p.name || '?'} detail={p.workspaceRole === 'viewer' ? t('boards.share.viewerOnly') : undefined} />
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                disabled={busyId !== null}
                pending={busyId === p.id}
                pendingLabel={t('boards.share.adding')}
                aria-label={t('boards.share.addName', {name: p.name})}
                onClick={() => void add(p)}>
                {t('boards.share.addButton')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function InviteLink({boardId}: {boardId: number}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const roles = useRoleLabels();
  const status = useQuery(linkQuery(boardId));
  const [role, setRole] = useState<'member' | 'viewer'>('member');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const active = status.data?.active === true;

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await call<{url: string; role: 'member' | 'viewer'}>('POST', `/boards/${boardId}/invite-link`, {role});
      setUrl(res.url);
      queryClient.setQueryData(linkQuery(boardId).queryKey, {active: true, role: res.role});
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  const remove = () =>
    void confirm({
      title: t('boards.share.linkRemoveTitle'),
      body: t('boards.share.linkRemoveBody'),
      confirmLabel: t('boards.share.linkRemove'),
      action: async () => {
        await call('DELETE', `/boards/${boardId}/invite-link`);
        setUrl('');
        queryClient.setQueryData(linkQuery(boardId).queryKey, {active: false, role: null});
        toast.success(t('boards.share.linkRemoved'));
      },
    });

  return (
    <section className="lf-share-group" aria-labelledby="lf-share-link" aria-busy={busy || undefined}>
      <h3 id="lf-share-link">{t('boards.share.linkTitle')}</h3>
      <p className="lf-share-hint">
        {active && status.data?.role
          ? t('boards.share.linkActive', {role: roles.label(status.data.role)})
          : t('boards.share.linkHint')}
      </p>
      {url && (
        <>
          <input ref={field} readOnly value={url} aria-label={t('boards.share.linkTitle')} dir="ltr" onFocus={event => event.currentTarget.select()} />
          <Notice tone="info">{t('boards.share.linkOnce')}</Notice>
          <div>
            <Button variant="secondary" icon="copy" onClick={() => void copyText(url, field.current).then(ok => ok && toast.success(t('boards.share.copied')))}>
              {t('boards.share.copy')}
            </Button>
          </div>
        </>
      )}
      <div className="lf-share-add-bar">
        <Select
          className="lf-share-role"
          aria-label={t('boards.share.linkRole')}
          value={role}
          disabled={busy || status.isPending}
          options={roles.options(['member', 'viewer'])}
          onChange={event => setRole(event.target.value as 'member' | 'viewer')}
        />
        <Button variant="secondary" icon="link" disabled={status.isPending} pending={busy} pendingLabel={t('boards.share.linkCreating')} onClick={() => void create()}>
          {active ? t('boards.share.linkReplace') : t('boards.share.linkCreate')}
        </Button>
        {active && (
          <Button variant="danger" disabled={busy} onClick={remove}>
            {t('boards.share.linkRemove')}
          </Button>
        )}
      </div>
      {status.isError && <ErrorNote error={status.error} />}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function PendingInvites({boardId}: {boardId: number}) {
  const t = useT();
  const {formatDate} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const roles = useRoleLabels();
  const list = useQuery(pendingQuery(boardId));
  const items = list.data?.items ?? [];
  if (list.isError) return <ErrorNote error={list.error} />;
  if (items.length === 0) return null;
  const revoke = (id: number) =>
    void confirm({
      title: t('boards.share.revokeTitle'),
      body: t('boards.share.revokeBody'),
      confirmLabel: t('boards.share.revoke'),
      action: async () => {
        await call('DELETE', `/boards/${boardId}/invites/${id}`);
        await queryClient.invalidateQueries({queryKey: ['board-members', boardId, 'invites']});
        toast.success(t('boards.share.revoked'));
      },
    });
  return (
    <section className="lf-share-group" aria-labelledby="lf-share-pending">
      <h3 id="lf-share-pending">{t('boards.share.pending')}</h3>
      <ul className="lf-share-list">
        {items.map(i => (
          <li key={i.id} className="lf-share-row">
            <span className="lf-share-pending-text">
              {t('boards.share.pendingItem', {role: roles.label(i.role), date: formatDate(i.expiresAt)})}
            </span>
            {i.canRevoke && (
              <Button size="sm" variant="ghost" onClick={() => revoke(i.id)}>
                {t('boards.share.revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharingSettings({boardId, data}: {boardId: number; data: Members}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'invites' | 'join' | null>(null);
  const [error, setError] = useState('');
  const save = async (which: 'invites' | 'join', body: {memberInvites?: string; selfJoin?: boolean}) => {
    setBusy(which);
    setError('');
    try {
      const res = await call<{memberInvites: 'admins' | 'members'; selfJoin: boolean}>('PATCH', `/boards/${boardId}/sharing`, body);
      queryClient.setQueryData<Members>(boardMembersQuery(boardId).queryKey, old => (old ? {...old, ...res} : old));
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="lf-share-group" aria-labelledby="lf-share-settings">
      <h3 id="lf-share-settings">{t('boards.share.settings')}</h3>
      <Field id="lf-share-who" label={t('boards.share.whoCanAdd')}>
        <Select
          value={data.memberInvites}
          disabled={busy !== null}
          aria-busy={busy === 'invites' || undefined}
          options={[
            {value: 'admins', label: t('boards.share.whoAdmins')},
            {value: 'members', label: t('boards.share.whoMembers')},
          ]}
          onChange={event => event.target.value !== data.memberInvites && void save('invites', {memberInvites: event.target.value})}
        />
      </Field>
      <Switch
        label={t('boards.share.selfJoin')}
        description={t('boards.share.selfJoinHint')}
        checked={data.selfJoin}
        pending={busy === 'join'}
        disabled={busy !== null}
        onChange={next => void save('join', {selfJoin: next})}
      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

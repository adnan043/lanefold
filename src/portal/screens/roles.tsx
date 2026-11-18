import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {grants} from '../../platform/auth/codenames';
import {rules} from '../../lib/rules';
import type {PermissionRow, RoleRow} from '../../lib/types';
import {api, ApiError, read} from '../api';
import {permissionsQuery, rolesQuery} from '../queries';
import {useMe} from '../shared';
import {
  Badge,
  Icon,
  type IconName,
  Button,
  Card,
  Checkbox,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  Menu,
  Notice,
  PageHeader,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

/** The role form's rules: the SAME limits `src/platform/auth/admin.ts` enforces. */
const ROLE_RULES = {
  slug: [
    rules.required('Enter a short id, like "editor".'),
    rules.pattern(
      /^[a-z][a-z0-9-]{1,47}$/,
      'Use 2 to 48 lowercase letters, digits or dashes, starting with a letter.'
    ),
  ],
  name: [rules.required('Enter a name.'), rules.maxLength(80)],
  description: [rules.maxLength(255)],
};

const OWNER = 'owner';
const ALL = '*';

/** Owner a key, Admin a shield, Member one person; any other role (custom ones) a group. */
const ROLE_ICONS: Record<string, IconName> = {[OWNER]: 'key', admin: 'shield', member: 'user'};
const roleIcon = (role: RoleRow): IconName => ROLE_ICONS[role.slug] ?? (role.isSystem ? 'shield' : 'users');

/** "24 people", "100+ people", "1 person". */
function peopleLabel(members: {count: number; more: boolean}) {
  if (members.count === 0) return 'Nobody yet';
  const one = members.count === 1 && !members.more;
  return `${members.count}${members.more ? '+' : ''} ${one ? 'person' : 'people'}`;
}

/**
 * What a role holds, as the catalogue's groups. A permission another held
 * wildcard already covers (`site:user:read` under `site:user:*`) is left out:
 * it adds nothing, and the list stays short.
 */
function groupPermissions(held: string[], catalogue: PermissionRow[]) {
  const byCode = new Map(catalogue.map(p => [p.codename, p]));
  const covered = (codename: string) =>
    held.some(other => other !== codename && other.endsWith('*') && grants(new Set([other]), codename));
  const order = [...new Set(catalogue.map(p => p.group))];
  const groups = new Map<string, {codename: string; title: string}[]>();
  for (const codename of held) {
    if (covered(codename)) continue;
    const row = byCode.get(codename);
    const group = row?.group ?? 'Other';
    groups.set(group, [...(groups.get(group) ?? []), {codename, title: row?.title ?? codename}]);
  }
  const rank = (codename: string) => {
    const at = catalogue.findIndex(p => p.codename === codename);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...groups]
    .sort(([a], [b]) => (order.indexOf(a) + 1 || Infinity) - (order.indexOf(b) + 1 || Infinity))
    .map(([group, items]) => ({group, items: items.sort((a, b) => rank(a.codename) - rank(b.codename))}));
}

/**
 * `/roles` (site:role:read): what each role allows. Editing needs
 * site:role:update, and you can only grant permissions you hold yourself.
 * `owner` is fixed; built-in roles cannot be deleted.
 */
export function Roles() {
  const me = useMe();
  const canEdit = Boolean(me.data?.abilities.editRoles);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);

  const roles = useQuery(rolesQuery);
  const catalogue = useQuery(permissionsQuery);
  const remove = useMutation({
    mutationFn: (slug: string) => read(api.admin.roles[':slug'].$delete({param: {slug}})),
    onSuccess: () => queryClient.invalidateQueries({queryKey: ['roles']}),
  });

  const askDelete = async (role: RoleRow) => {
    const done = await confirm({
      title: `Delete the “${role.name}” role?`,
      body: 'People who have it lose what it allowed. This cannot be undone.',
      confirmLabel: 'Delete role',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(role.slug),
    });
    if (done) toast.success(`The “${role.name}” role is deleted.`);
  };

  return (
    <div className="app-page screen-roles">
      <PageHeader
        title="Roles"
        description="A role is a set of permissions. Give roles to people on the Users screen."
        actions={
          canEdit && (
            <Button icon="plus" onClick={() => setEditing('new')}>
              New role
            </Button>
          )
        }
      />

      {roles.error ? (
        <ErrorNote error={roles.error} />
      ) : roles.isPending ? (
        <div className="roles-grid">
          <Card>
            <LoadingBlock rows={3} />
          </Card>
          <Card>
            <LoadingBlock rows={3} />
          </Card>
        </div>
      ) : roles.data.roles.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield"
            title="No roles yet"
            action={
              canEdit && <Button onClick={() => setEditing('new')}>New role</Button>
            }>
            A role groups permissions you can give to people.
          </EmptyState>
        </Card>
      ) : (
        <div className="roles-grid">
          {roles.data.roles.map(role => (
            <RoleCard
              key={role.slug}
              role={role}
              catalogue={catalogue.data?.permissions}
              canEdit={canEdit}
              busy={remove.isPending && remove.variables === role.slug}
              onEdit={() => setEditing(role)}
              onDelete={() => void askDelete(role)}
            />
          ))}
        </div>
      )}

      {editing !== null && (
        <RoleForm
          key={editing === 'new' ? 'new' : editing.slug}
          role={editing === 'new' ? null : editing}
          catalogue={catalogue.data?.permissions ?? []}
          catalogueError={catalogue.error}
          catalogueLoading={catalogue.isPending}
          onClose={() => setEditing(null)}
          onSaved={name => {
            toast.success(
              editing === 'new'
                ? `The “${name}” role is created.`
                : `The “${name}” role is saved.`
            );
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** One role: who it is for, what it allows (grouped), and how many people hold it. */
function RoleCard({
  role,
  catalogue,
  canEdit,
  busy,
  onEdit,
  onDelete,
}: {
  role: RoleRow;
  catalogue: PermissionRow[] | undefined;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const fixed = role.slug === OWNER;
  const everything = fixed || role.permissions.includes(ALL);
  const held = new Set(role.permissions);
  // Every concrete permission the role grants, wildcards resolved: "7 of 18".
  const concrete = catalogue?.filter(p => !p.codename.endsWith('*'));
  const granted = concrete?.filter(p => everything || grants(held, p.codename)).length;
  const groups = groupPermissions(role.permissions.filter(c => c !== ALL), catalogue ?? []);
  const editable = canEdit && !fixed;

  return (
    <Card className={fixed ? 'roles-card roles-card-fixed' : 'roles-card'}>
      <div className="roles-head">
        <span className={`roles-icon roles-icon-${fixed ? 'fixed' : role.isSystem ? 'system' : 'custom'}`} aria-hidden="true">
          <Icon name={roleIcon(role)} size={18} />
        </span>
        <div className="roles-heading">
          <h3 className="roles-title">
            {role.name}
            {fixed ? (
              <Badge tone="brand" icon="lock">
                Fixed
              </Badge>
            ) : role.isSystem ? (
              <Badge>Built-in</Badge>
            ) : (
              <Badge tone="info">Custom</Badge>
            )}
          </h3>
          <code className="roles-slug">{role.slug}</code>
        </div>
        {editable && !role.isSystem && (
          <Menu
            label={`Actions for the ${role.name} role`}
            disabled={busy}
            items={[
              {label: 'Edit', icon: 'pencil', onSelect: onEdit},
              'separator',
              {label: 'Delete', icon: 'trash', danger: true, onSelect: onDelete},
            ]}
          />
        )}
      </div>

      {role.description && <p className="roles-description">{role.description}</p>}

      <section className="roles-perms" aria-label={`What the ${role.name} role allows`} aria-busy={busy || undefined}>
        <div className="roles-perms-head">
          <span>Permissions</span>
          {concrete && granted !== undefined && (
            <span className="roles-perms-count">
              {everything ? 'All' : `${granted} of ${concrete.length}`}
            </span>
          )}
        </div>
        {concrete && granted !== undefined && (
          <progress className="roles-meter" aria-hidden="true" max={concrete.length || 1} value={everything ? concrete.length || 1 : granted} />
        )}
        {everything ? (
          fixed ? (
            <p className="roles-all">
              <Icon name="lock" size={16} />
              <span>
                <strong>Every permission, always.</strong> Plus what only the Owner can do.
              </span>
            </p>
          ) : (
            // `*` is meant for the Owner alone: on any other role it is worth a second look. It still
            // stops short of the Owner: full email addresses, finding people by email and changing
            // the owner check the owner ROLE (src/platform/auth/admin.ts), not a permission.
            <p className="roles-all roles-all-warn">
              <Icon name="warning" size={16} />
              <span>
                <strong>Holds “Everything”.</strong> Every permission, including ones added later. Owner-only
                actions stay with the Owner.
                {editable && ' Edit the role to give only what it needs.'}
              </span>
            </p>
          )
        ) : groups.length ? (
          <dl className="roles-groups">
            {groups.map(({group, items}) => (
              <div className="roles-group" key={group}>
                <dt>{group}</dt>
                <dd className="badges">
                  {items.map(item => (
                    <span key={item.codename} title={item.codename}>
                      <Badge>{item.title}</Badge>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="roles-none">No extra permissions. People with only this role can sign in, nothing more.</p>
        )}
      </section>

      <div className="roles-foot">
        {role.members ? (
          <span className="roles-members">
            <Icon name="users" size={14} />
            {peopleLabel(role.members)}
          </span>
        ) : (
          <span />
        )}
        {editable && (
          <Button variant="secondary" size="sm" icon="pencil" onClick={onEdit} disabled={busy}>
            Edit
          </Button>
        )}
      </div>
    </Card>
  );
}

function RoleForm({
  role,
  catalogue,
  catalogueError,
  catalogueLoading,
  onClose,
  onSaved,
}: {
  role: RoleRow | null;
  catalogue: PermissionRow[];
  catalogueError: Error | null;
  catalogueLoading: boolean;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm(
    {
      slug: role?.slug ?? '',
      name: role?.name ?? '',
      description: role?.description ?? '',
    },
    role ? {name: ROLE_RULES.name, description: ROLE_RULES.description} : ROLE_RULES
  );
  const [picked, setPicked] = useState<string[]>(role?.permissions ?? []);
  const save = useMutation({
    mutationFn: (values: {slug: string; name: string; description: string}) =>
      role
        ? read(
            api.admin.roles[':slug'].$patch({
              param: {slug: role.slug},
              json: {
                name: values.name,
                description: values.description,
                permissions: picked,
              },
            })
          )
        : read(api.admin.roles.$post({json: {...values, permissions: picked}})),
    onSuccess: async (_data, values) => {
      await queryClient.invalidateQueries({queryKey: ['roles']});
      onSaved(values.name.trim());
    },
    onError: err => {
      form.noteError(err);
      if (err instanceof ApiError) form.setServerErrors(err.fields);
    },
  });
  const groups = [...new Set(catalogue.map(p => p.group))];
  const fieldErrors = save.error instanceof ApiError ? save.error.fields : {};
  const onField = ['slug', 'name', 'description'].some(name => fieldErrors[name]);

  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.isPending}
      title={role ? `Edit ${role.name}` : 'New role'}
      description="You can only give a role permissions you hold yourself."
      onSubmit={form.submit(values => save.mutate(values))}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" pending={save.isPending} pendingLabel="Saving…" disabled={form.blocked}>
            {role ? 'Save changes' : 'Create role'}
          </Button>
        </>
      }>
      <div className="form-stack">
        {!role && (
          <Field
            id="f-slug"
            label="Id"
            hint="Lowercase, used in code, like “editor”. It cannot change later."
            error={form.error('slug')}>
            <input {...form.field('slug')} autoComplete="off" maxLength={48} placeholder="e.g. support-agent" />
          </Field>
        )}
        <Field id="f-name" label="Name" error={form.error('name')}>
          <input {...form.field('name')} autoComplete="off" maxLength={80} placeholder="e.g. Support agent" />
        </Field>
        <Field
          id="f-description"
          label="Description"
          optional
          error={form.error('description')}>
          <textarea {...form.field('description')} rows={2} maxLength={255} placeholder="What people with this role can do" />
        </Field>

        {catalogueError && <ErrorNote error={catalogueError} />}
        {catalogueLoading ? (
          <LoadingBlock rows={3} />
        ) : (
          groups.map(group => (
            <fieldset className="checkbox-group" key={group}>
              <legend>{group}</legend>
              {catalogue
                .filter(p => p.group === group)
                .map(permission => (
                  <Checkbox
                    key={permission.codename}
                    label={permission.title}
                    description={permission.description ?? undefined}
                    checked={picked.includes(permission.codename)}
                    disabled={save.isPending}
                    onChange={checked =>
                      setPicked(current =>
                        checked
                          ? [...current, permission.codename]
                          : current.filter(codename => codename !== permission.codename)
                      )
                    }
                  />
                ))}
            </fieldset>
          ))
        )}
        {fieldErrors.permissions && (
          <Notice tone="danger">{fieldErrors.permissions}</Notice>
        )}
        {save.error && !onField && !fieldErrors.permissions && (
          <ErrorNote error={save.error} />
        )}
      </div>
    </Drawer>
  );
}

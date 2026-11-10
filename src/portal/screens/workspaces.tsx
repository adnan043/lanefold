import {useInfiniteQuery} from '@tanstack/react-query';

import {formatBytes, PlanBadge} from '../billing-shared';
import {type StaffWorkspace, staffWorkspacesQuery} from '../queries';
import {when} from '../shared';
import {Card, type Column, DataTable, EmptyState, LoadMore, Notice, PageHeader, StatusBadge} from '../ui';

/** `/dashboard/workspaces`: every workspace, newest first (`site:workspace:read`). Each load is audited. */
export function Workspaces() {
  const workspaces = useInfiniteQuery(staffWorkspacesQuery);
  const rows = workspaces.data?.pages.flatMap(page => page.workspaces);

  const columns: Column<StaffWorkspace>[] = [
    {
      key: 'name',
      header: 'Workspace',
      cell: row => (
        <div>
          <span className="cell-title">{row.name}</span>
          <span className="cell-sub">{row.slug}</span>
        </div>
      ),
    },
    {key: 'plan', header: 'Plan', width: 'shrink', cell: row => <PlanBadge plan={row.plan} />},
    {key: 'members', header: 'Members', width: 'shrink', cell: row => row.memberCount},
    {key: 'storage', header: 'Storage used', width: 'shrink', hideOnMobile: true, cell: row => formatBytes(row.storageUsedBytes)},
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: row =>
        row.graceUntil ? (
          <StatusBadge tone={new Date(row.graceUntil).getTime() > Date.now() ? 'warning' : 'danger'}>
            {new Date(row.graceUntil).getTime() > Date.now() ? 'In grace' : 'Read-only'}
          </StatusBadge>
        ) : (
          <StatusBadge tone="success">OK</StatusBadge>
        ),
    },
    {key: 'created', header: 'Created', width: 'shrink', hideOnMobile: true, cell: row => when(row.createdAt)},
  ];

  return (
    <div className="app-page">
      <PageHeader title="Workspaces" description="Every workspace on the site, with its plan and usage." />
      <Notice tone="info">Viewing this list is recorded in the activity log. People and boards inside a workspace are not shown here.</Notice>
      <Card flush>
        <DataTable
          caption="Workspaces"
          columns={columns}
          rows={rows}
          rowKey={row => row.id}
          loading={workspaces.isPending}
          error={workspaces.error}
          empty={<EmptyState icon="layout-kanban" title="No workspaces yet">Workspaces show here as soon as people create them.</EmptyState>}
        />
      </Card>
      <LoadMore query={workspaces} />
    </div>
  );
}

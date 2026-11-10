import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {useNavigate} from '../nav';
import { useState } from "react";

import { type MessageKey, useI18n, useT } from "../../i18n";
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  LoadMore,
  Menu,
  PageHeader,
  Person,
  Select,
  StatusBadge,
  useConfirm,
  useToast,
} from "../../portal/ui";
import { call } from "../api";
import type { MemberT } from "../chat/api";
import { useWorkspace } from "../workspace";
import { InviteModal } from "./invite-modal";
import { ResendEmailModal } from "./resend-email-modal";
import {
  type InviteT,
  invitesQuery,
  type JoinLinkT,
  joinLinksQuery,
  membersListQuery,
} from "./queries";
import "./members.css";

const ROLES = ["viewer", "member", "admin"] as const;

/** `/app/members`: the directory, roles, join links and invites. The server decides what each person may do (`canManage`); this only shows it. */
export function Members() {
  const t = useT();
  const { formatDate, errorMessage } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { current, workspaces, setCurrentId } = useWorkspace();
  const workspaceId = current?.id ?? 0;
  const members = useInfiniteQuery({
    ...membersListQuery(workspaceId),
    enabled: workspaceId > 0,
  });
  const myRole = members.data?.pages[0]?.me.role ?? current?.role ?? "viewer";
  const isAdmin = myRole === "owner" || myRole === "admin";
  const links = useInfiniteQuery({
    ...joinLinksQuery(workspaceId),
    enabled: workspaceId > 0 && isAdmin,
  });
  const invites = useInfiniteQuery({
    ...invitesQuery(workspaceId),
    enabled: workspaceId > 0 && isAdmin,
  });
  const [inviting, setInviting] = useState(false);
  const [resendId, setResendId] = useState<number | null>(null);
  // Every row that is mid-action (a Set, so two rows never share one flag).
  const [busySet, setBusySet] = useState<ReadonlySet<string | number>>(
    new Set(),
  );
  const setRowBusy = (key: string | number, on: boolean) =>
    setBusySet((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const isBusy = (key: string | number) => busySet.has(key);
  const firstBusy = (match: (key: string | number) => boolean) =>
    [...busySet].find(match) ?? null;

  const rows = members.data?.pages.flatMap((p) => p.items);
  const refresh = (key: string) =>
    queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
  /** A failure inside a confirm dialog is shown by the dialog: give it the translated sentence. */
  const localized = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  };

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) =>
      call("PATCH", `/workspaces/${workspaceId}/members/${userId}`, { role }),
    onMutate: ({ userId }) => setRowBusy(userId, true),
    onSuccess: () => toast.success(t("members.roleChanged")),
    onError: (error) => toast.danger(errorMessage(error)),
    onSettled: async (_data, _error, { userId }) => {
      await refresh("members");
      setRowBusy(userId, false);
    },
  });

  const remove = (member: MemberT) =>
    void confirm({
      title: t("members.removeTitle", {
        name: member.name ?? t("chat.deletedUser"),
      }),
      body: t("members.removeBody"),
      confirmLabel: t("members.remove"),
      pendingLabel: t("members.removing"),
      action: async () => {
        setRowBusy(member.userId, true);
        try {
          await localized(() =>
            call(
              "DELETE",
              `/workspaces/${workspaceId}/members/${member.userId}`,
            ),
          );
          await Promise.all([
            refresh("members"),
            queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
          ]);
          toast.success(t("members.removed"));
        } finally {
          setRowBusy(member.userId, false);
        }
      },
    });

  const leave = () =>
    void confirm({
      title: t("members.leaveTitle", { name: current?.name ?? "" }),
      body: t("members.leaveBody"),
      confirmLabel: t("members.leave"),
      pendingLabel: t("members.leaving"),
      action: async () => {
        await localized(() => call("POST", `/workspaces/${workspaceId}/leave`));
        const rest = (workspaces ?? []).filter((w) => w.id !== workspaceId);
        if (rest[0]) setCurrentId(rest[0].id);
        await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        toast.success(t("members.left"));
        void navigate({ to: "/boards" });
      },
    });

  const revoke = (kind: "join-links" | "invites", id: number) =>
    void confirm({
      title: t("members.revokeTitle"),
      body: t("members.revokeBody"),
      confirmLabel: t("members.revoke"),
      pendingLabel: t("members.revoking"),
      action: async () => {
        setRowBusy(`${kind}:${id}`, true);
        try {
          await localized(() =>
            call("DELETE", `/workspaces/${workspaceId}/${kind}/${id}`),
          );
          await refresh(kind);
          toast.success(t("members.revoked"));
        } finally {
          setRowBusy(`${kind}:${id}`, false);
        }
      },
    });

  const memberColumns: Column<MemberT>[] = [
    {
      key: "name",
      header: t("members.col.name"),
      cell: (m) => (
        <Person name={m.name ?? t("chat.deletedUser")} detail={m.email ?? m.maskedEmail} />
      ),
    },
    {
      key: "role",
      header: t("members.col.role"),
      width: "shrink",
      cell: (m) =>
        m.canManage && m.role !== "owner" ? (
          <Select
            aria-label={t("members.changeRoleFor", {
              name: m.name ?? t("chat.deletedUser"),
            })}
            value={m.role}
            disabled={isBusy(m.userId)}
            options={ROLES.map((r) => ({
              value: r,
              label: t(`members.role.${r}`),
            }))}
            onChange={(event) =>
              changeRole.mutate({ userId: m.userId, role: event.target.value })
            }
          />
        ) : (
          <Badge tone={m.role === "owner" ? "brand" : "neutral"}>
            {t(`members.role.${m.role as "owner"}`)}
          </Badge>
        ),
    },
    {
      key: "joined",
      header: t("members.col.joined"),
      width: "shrink",
      hideOnMobile: true,
      cell: (m) => formatDate(m.joinedAt, { dateStyle: "medium" }),
    },
    {
      key: "actions",
      header: t("members.col.actions"),
      actions: true,
      cell: (m) => (
        <>
          {m.isMe && <Badge>{t("members.you")}</Badge>}
          {m.canManage && (
            <Menu
              label={t("members.actionsFor", {
                name: m.name ?? t("chat.deletedUser"),
              })}
              disabled={isBusy(m.userId)}
              items={[
                {
                  label: t("members.remove"),
                  icon: "trash",
                  danger: true,
                  onSelect: () => remove(m),
                },
              ]}
            />
          )}
        </>
      ),
    },
  ];

  const linkStatus = (l: JoinLinkT) =>
    l.revoked ? (
      <StatusBadge tone="neutral">{t("members.status.revoked")}</StatusBadge>
    ) : l.active ? (
      <StatusBadge tone="success">{t("members.status.active")}</StatusBadge>
    ) : new Date(l.expiresAt) <= new Date() ? (
      <StatusBadge tone="warning">{t("members.status.expired")}</StatusBadge>
    ) : (
      <StatusBadge tone="neutral">{t("members.status.usedUp")}</StatusBadge>
    );
  const inviteStatus = (i: InviteT) => (
    <span className="badges">
      {i.used ? (
        <StatusBadge tone="neutral">{t("members.status.used")}</StatusBadge>
      ) : i.active ? (
        <StatusBadge tone="success">{t("members.status.active")}</StatusBadge>
      ) : (
        <StatusBadge tone="warning">{t("members.status.expired")}</StatusBadge>
      )}
      {i.emailStatus && !i.used && (
        <StatusBadge
          tone={
            i.emailStatus === "sent"
              ? "success"
              : i.emailStatus === "queued"
                ? "info"
                : i.emailStatus === "failed"
                  ? "danger"
                  : "warning"
          }
        >
          {t(`invite.status.${i.emailStatus}` as MessageKey)}
        </StatusBadge>
      )}
    </span>
  );

  const linkColumns: Column<JoinLinkT>[] = [
    {
      key: "role",
      header: t("members.col.role"),
      cell: (l) => t(`members.role.${l.role as "member"}`),
    },
    {
      key: "uses",
      header: t("members.col.uses"),
      width: "shrink",
      cell: (l) => `${l.uses} / ${l.maxUses}`,
    },
    {
      key: "expires",
      header: t("members.col.expires"),
      width: "shrink",
      hideOnMobile: true,
      cell: (l) => formatDate(l.expiresAt, { dateStyle: "medium" }),
    },
    {
      key: "status",
      header: t("members.col.status"),
      width: "shrink",
      cell: linkStatus,
    },
    {
      key: "actions",
      header: t("members.col.actions"),
      actions: true,
      cell: (l) => (
        <Button
          size="sm"
          variant="ghost"
          disabled={!l.active || isBusy(`join-links:${l.id}`)}
          pending={isBusy(`join-links:${l.id}`)}
          pendingLabel={t("members.revoking")}
          onClick={() => revoke("join-links", l.id)}
        >
          {t("members.revoke")}
        </Button>
      ),
    },
  ];
  const inviteColumns: Column<InviteT>[] = [
    {
      key: "role",
      header: t("members.col.role"),
      cell: (i) => t(`members.role.${i.role as "member"}`),
    },
    {
      key: "bound",
      header: t("members.col.forWhom"),
      width: "shrink",
      hideOnMobile: true,
      cell: (i) =>
        i.boundToEmail ? t("members.oneAddress") : t("members.anyone"),
    },
    {
      key: "expires",
      header: t("members.col.expires"),
      width: "shrink",
      hideOnMobile: true,
      cell: (i) => formatDate(i.expiresAt, { dateStyle: "medium" }),
    },
    {
      key: "status",
      header: t("members.col.status"),
      width: "shrink",
      cell: inviteStatus,
    },
    {
      key: "actions",
      header: t("members.col.actions"),
      actions: true,
      cell: (i) => (
        <>
          {i.active &&
            i.boundToEmail &&
            (i.emailStatus === "failed" ||
              i.emailStatus === "not_configured") && (
              <Button
                size="sm"
                variant="ghost"
                disabled={isBusy(`invites:${i.id}`)}
                onClick={() => setResendId(i.id)}
              >
                {t("invite.resend")}
              </Button>
            )}
        <Button
          size="sm"
          variant="ghost"
          disabled={i.used || isBusy(`invites:${i.id}`)}
          pending={isBusy(`invites:${i.id}`)}
          pendingLabel={t("members.revoking")}
          onClick={() => revoke("invites", i.id)}
        >
          {t("members.revoke")}
        </Button>
        </>
      ),
    },
  ];

  if (!current) return null;

  return (
    <div className="app-page members-page">
      <PageHeader
        title={t("members.title")}
        description={t("members.description", { name: current.name })}
        actions={
          <>
            <Button
              variant="secondary"
              icon="log-out"
              onClick={leave}
              disabled={myRole === "owner"}
              title={
                myRole === "owner"
                  ? t("workspaceSettings.transfer.title")
                  : undefined
              }
            >
              {t("members.leave")}
            </Button>
            {isAdmin && (
              <Button icon="user-plus" onClick={() => setInviting(true)}>
                {t("members.invite")}
              </Button>
            )}
          </>
        }
      />
      <Card flush title={t("members.listTitle")}>
        <DataTable
          caption={t("members.listTitle")}
          columns={memberColumns}
          rows={rows}
          rowKey={(m) => m.userId}
          loading={members.isPending}
          error={members.error ? new Error(errorMessage(members.error)) : null}
          busyKey={firstBusy((k) => typeof k === "number") as number | null}
          empty={
            <EmptyState
              icon="users"
              title={t("members.emptyTitle")}
              action={
                isAdmin ? (
                  <Button icon="user-plus" onClick={() => setInviting(true)}>
                    {t("members.invite")}
                  </Button>
                ) : undefined
              }
            >
              {t("members.emptyBody")}
            </EmptyState>
          }
        />
        {members.error && (
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => void members.refetch()}
          >
            {t("common.retry")}
          </Button>
        )}
        <LoadMore query={members} />
      </Card>
      {isAdmin && (
        <>
          <Card
            flush
            title={t("members.linksTitle")}
            description={t("members.linksDescription")}
          >
            <DataTable
              caption={t("members.linksTitle")}
              columns={linkColumns}
              rows={links.data?.pages.flatMap((p) => p.items)}
              rowKey={(l) => l.id}
              loading={links.isPending}
              error={links.error ? new Error(errorMessage(links.error)) : null}
              busyKey={(() => {
                const k = firstBusy(
                  (x) => typeof x === "string" && x.startsWith("join-links:"),
                );
                return k === null ? null : Number(String(k).split(":")[1]);
              })()}
              empty={
                <EmptyState
                  icon="link"
                  title={t("members.noLinksTitle")}
                  action={
                    <Button
                      variant="secondary"
                      icon="plus"
                      onClick={() => setInviting(true)}
                    >
                      {t("members.createLink")}
                    </Button>
                  }
                >
                  {t("members.noLinksBody")}
                </EmptyState>
              }
            />
            {links.error && (
              <Button
                size="sm"
                variant="secondary"
                icon="refresh"
                onClick={() => void links.refetch()}
              >
                {t("common.retry")}
              </Button>
            )}
            <LoadMore query={links} />
          </Card>
          <Card
            flush
            title={t("members.invitesTitle")}
            description={t("members.invitesDescription")}
          >
            <DataTable
              caption={t("members.invitesTitle")}
              columns={inviteColumns}
              rows={invites.data?.pages.flatMap((p) => p.items)}
              rowKey={(i) => i.id}
              loading={invites.isPending}
              error={
                invites.error ? new Error(errorMessage(invites.error)) : null
              }
              busyKey={(() => {
                const k = firstBusy(
                  (x) => typeof x === "string" && x.startsWith("invites:"),
                );
                return k === null ? null : Number(String(k).split(":")[1]);
              })()}
              empty={
                <EmptyState icon="mail" title={t("members.noInvitesTitle")}>
                  {t("members.noInvitesBody")}
                </EmptyState>
              }
            />
            {invites.error && (
              <Button
                size="sm"
                variant="secondary"
                icon="refresh"
                onClick={() => void invites.refetch()}
              >
                {t("common.retry")}
              </Button>
            )}
            <LoadMore query={invites} />
          </Card>
        </>
      )}
      {isAdmin && (
        <InviteModal
          workspaceId={workspaceId}
          open={inviting}
          onClose={() => setInviting(false)}
        />
      )}
      {isAdmin && (
        <ResendEmailModal
          workspaceId={workspaceId}
          inviteId={resendId}
          onClose={() => setResendId(null)}
        />
      )}
    </div>
  );
}

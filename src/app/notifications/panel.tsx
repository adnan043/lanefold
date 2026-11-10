import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {useNavigate} from '../nav';
import { useState, type RefObject } from "react";

import { useI18n, useT, type MessageKey } from "../../i18n";
import {
  Button,
  EmptyState,
  ErrorNote,
  LoadMore,
  LoadingBlock,
} from "../../portal/ui";
import { Popover } from "../../portal/ui/popover";
import { call } from "../api";
import {useWriteCooldown} from '../write-cooldown';
import type { NotificationT } from "./bell";
import "./bell.css";

const listQuery = () => ({
  queryKey: ["notifications", "list"] as const,
  queryFn: ({ pageParam }: { pageParam: string }) =>
    call<{ items: NotificationT[]; nextBefore: string | null }>(
      "GET",
      `/notifications${pageParam ? `?before=${pageParam}` : ""}`,
    ),
  initialPageParam: "",
  getNextPageParam: (last: { nextBefore: string | null }) =>
    last.nextBefore ?? undefined,
});

const KIND_KEYS: Record<string, MessageKey> = {
  assigned: "notif.kind.assigned",
  mentioned: "notif.kind.mentioned",
  due_soon: "notif.kind.due_soon",
  item_due: "notif.kind.item_due",
  comment: "notif.kind.comment",
  message_mention: "notif.kind.message_mention",
  card_moved: "notif.kind.card_moved",
  card_due: "notif.kind.card_due",
  card_done: "notif.kind.card_done",
  card_member: "notif.kind.card_member",
  board_member: "notif.kind.board_member",
  digest: "notif.kind.digest",
  card_stale: "notif.kind.card_stale",
};

/** The bell's popover and its list: lazy (loaded when the bell is first opened or hovered), the bell and its count are not. */
export default function NotificationPanel({
  open,
  setOpen,
  anchor,
  unread,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
  unread: number;
}) {
  const t = useT();
  const { formatRelative, errorMessage } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const list = useInfiniteQuery({ ...listQuery(), enabled: open });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    ]);
  const readOne = useMutation({
    mutationFn: (id: string) => call("POST", `/notifications/${id}/read`),
    onMutate: (id) => setBusy(id),
    onSettled: async () => {
      await refresh();
      setBusy(null);
    },
  });
  const cooldown = useWriteCooldown();
  const readAll = useMutation({
    mutationFn: () => call("POST", "/notifications/read-all", {}),
    onSettled: refresh,
  });

  const items = list.data?.pages.flatMap((p) => p.items);

  const open_ = (n: NotificationT) => {
    setOpen(false);
    if (n.kind === "digest") void navigate({ to: "/my-day" });
    else if (n.conversationId)
      void navigate({ to: "/chat", search: { c: n.conversationId } as never });
    else if (n.boardId && n.cardId)
      void navigate({
        to: "/b/$boardId/c/$cardId",
        params: { boardId: String(n.boardId), cardId: String(n.cardId) },
      });
    else if (n.boardId)
      void navigate({
        to: "/b/$boardId",
        params: { boardId: String(n.boardId) },
      });
  };
  // Mark read first; on failure stay here and show the error (no navigation).
  const go = (n: NotificationT) => {
    if (n.read) return open_(n);
    readOne.mutate(n.id, { onSuccess: () => open_(n) });
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      anchor={anchor}
      label={t("notif.title")}
      align="end"
      className="notif-panel"
    >
      <div className="notif-head">
        <h2>{t("notif.title")}</h2>
        <Button
          size="sm"
          variant="ghost"
          disabled={unread === 0 || cooldown.blocked}
          pending={readAll.isPending}
          pendingLabel={t("notif.markingAll")}
          onClick={() => readAll.mutate()}
        >
          {t("notif.markAll")}
        </Button>
      </div>
      {readAll.error && (
        <p className="field-error" role="alert">
          {errorMessage(readAll.error)}
        </p>
      )}
      {readOne.error && (
        <p className="field-error" role="alert">
          {errorMessage(readOne.error)}
        </p>
      )}
      {list.isPending ? (
        <LoadingBlock rows={3} />
      ) : list.error && !items?.length ? (
        <div className="notif-state">
          <ErrorNote
            error={new Error(errorMessage(list.error))}
            title={t("states.loadError")}
          />
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => void list.refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : items && items.length === 0 ? (
        <EmptyState
          icon="bell"
          title={t("notif.emptyTitle")}
          action={
            <Button variant="secondary" onClick={() => { setOpen(false); void navigate({ to: "/boards" }); }}>
              {t("boards.backToBoards")}
            </Button>
          }
        >
          {t("notif.emptyBody")}
        </EmptyState>
      ) : (
        <ul className="notif-list">
          {items?.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="notif-item"
                data-unread={n.read ? undefined : ""}
                disabled={busy === n.id || (n.read && n.kind !== "digest" && !n.conversationId && !n.boardId)}
                aria-busy={busy === n.id || undefined}
                onClick={() => go(n)}
              >
                <span className="notif-dot" aria-hidden="true" />
                <span className="notif-text">
                  <span>
                    {t(KIND_KEYS[n.kind] ?? "notif.kind.other", {
                      name: n.actor?.name || t("notif.someone"),
                      due: n.digest?.due ?? 0,
                      overdue: n.digest?.overdue ?? 0,
                      mentions: n.digest?.mentions ?? 0,
                    })}
                  </span>
                  <time dateTime={n.createdAt} className="muted">
                    {formatRelative(n.createdAt)}
                  </time>
                </span>
                {!n.read && (
                  <span className="visually-hidden">{t("notif.unread")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {items && items.length > 0 && <LoadMore query={list} />}
    </Popover>
  );
}

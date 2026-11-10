import {keepPreviousData, queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useMemo} from 'react';

import {putFile} from '../../platform/files-browser';
import {ApiError, type BoardData, call, type CardT} from '../api';
import {patchCard} from '../board-state';
import {tracked} from '../use-board-sync';

/** Wire shapes of `src/server/routes/card-detail.ts`. */
export type LabelT = {id: number; name: string; colorHex: string};
export type PersonT = {id: number; name: string};
export type ItemT = {
  id: number;
  text: string;
  done: boolean;
  assignee: PersonT | null;
  dueDate: string | null;
  /** The due moment (ISO) when a time was picked, and its reminder in minutes before; null = a due day only. */
  dueAt: string | null;
  dueRemindMinutes: number | null;
};
export type ChecklistT = {id: number; title: string; items: ItemT[]};
export type AttachmentT = {
  id: number;
  name: string;
  contentType: string;
  size: number;
  url: string | null;
  isFile: boolean;
  ready: boolean;
  isImage: boolean;
  isCover: boolean;
  uploadedBy: string | null;
  mine: boolean;
  createdAt: string;
};
export type FieldType = 'dropdown' | 'text' | 'number' | 'date' | 'checkbox';
export type FieldOptionT = {id: number; name: string; colorHex: string};
export type FieldT = {id: number; name: string; type: FieldType; options: FieldOptionT[]};
/** text → string, number → number, date → 'YYYY-MM-DD', checkbox → boolean, dropdown → option id; no key = no value. */
export type FieldValueT = string | number | boolean;
export type CommentT = {id: number; authorId: number | null; authorName: string | null; body: string; edited: boolean; createdAt: string; mine: boolean; mentions: PersonT[]};
export type CardDetailT = CardT & {
  boardId: number;
  descriptionMd: string;
  estimateMinutes: number | null;
  startDate: string | null;
  /** The exact due moment (ISO) when a time was picked; null = a due day only. */
  dueAt: string | null;
  /** Remind this many minutes before `dueAt`; null = no reminder. */
  dueRemindMinutes: number | null;
  coverAttachmentId: number | null;
  createdAt: string;
};
export type DetailT = {
  card: CardDetailT;
  me: number;
  /** This person follows the card (their own flag; the bell tells them about its changes). */
  watching: boolean;
  canWrite: boolean;
  canAdmin: boolean;
  labelIds: number[];
  labels: LabelT[];
  fields: FieldT[];
  fieldValues: Record<string, FieldValueT>;
  members: PersonT[];
  checklists: ChecklistT[];
  attachments: AttachmentT[];
  comments: {items: CommentT[]; next: number | null};
};
export type ActivityT = {id: string; kind: string; meta: Record<string, unknown> | null; actorName: string | null; createdAt: string};
type Written = {card: CardT; rev: string};

export const cardDetailQuery = (cardId: number) =>
  queryOptions({
    queryKey: ['card', cardId],
    queryFn: () => call<DetailT>('GET', `/cards/${cardId}/detail`),
    // Our own writes keep it fresh; other people's changes arrive when the panel is opened again.
    staleTime: 15_000,
    gcTime: 5 * 60_000,
  });

export const useActivity = (cardId: number, enabled: boolean, before: string) =>
  useQuery({
    queryKey: ['card-activity', cardId, before],
    queryFn: () => call<{items: ActivityT[]; next: string | null}>('GET', `/cards/${cardId}/activity${before ? `?before=${before}` : ''}`),
    enabled,
    placeholderData: keepPreviousData,
  });

export const usePeople = (cardId: number, q: string, enabled: boolean) =>
  useQuery({
    queryKey: ['card-people', cardId, q],
    queryFn: () => call<{items: (PersonT & {assigned: boolean})[]}>('GET', `/cards/${cardId}/people?q=${encodeURIComponent(q)}`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

/**
 * Every write inside a card, in ONE place. Each is tracked (the board's sync poll waits for it), sends nothing
 * the server decides (no ids of owners, no positions), then applies the server's answer to the open panel's
 * cache AND to the card on the board behind it (counters, due date, title). They reject with the ApiError so
 * the caller can show it where the person is looking. Checklist ticks are optimistic and roll back.
 */
export function useCardActions(boardId: number, cardId: number) {
  const qc = useQueryClient();
  return useMemo(() => {
    const key = ['card', cardId];
    const get = () => qc.getQueryData<DetailT>(key);
    const set = (fn: (d: DetailT) => DetailT) => qc.setQueryData<DetailT>(key, d => (d ? fn(d) : d));
    const onBoard = (card: CardT) =>
      qc.setQueryData<BoardData>(['board', boardId], d => (d ? {...d, lanes: patchCard(d.lanes, card.id, card)} : d));
    /** Send, then fold the server's card summary into both caches. */
    const send = async <T extends Partial<Written>>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> => {
      const res = await tracked(() => call<T>(method, path, body));
      if (res.card) {
        const card = res.card;
        onBoard(card);
        set(d => ({...d, card: {...d.card, ...card}}));
        // My Day lists cards by assignee, due date and done: a change here makes it stale (inactive reads only refetch when shown).
        void qc.invalidateQueries({queryKey: ['my-day']});
      }
      return res;
    };

    type Patch = {title?: string; descriptionMd?: string; priority?: string; estimateMinutes?: number | null; startDate?: string | null; dueDate?: string | null; dueAt?: string | null; dueRemindMinutes?: number | null; completed?: boolean};
    const GUARDED = ['title', 'descriptionMd', 'estimateMinutes'] as const;
    const refetch = () => qc.refetchQueries({queryKey: key}).catch(() => undefined);
    // Guarded writes run one at a time, so a second save carries the rev the first one answered with.
    let chain: Promise<unknown> = Promise.resolve();
    const patchDetails = (patch: Patch): Promise<void> => {
      const run = chain.then(() => writeDetails(patch));
      chain = run.catch(() => undefined);
      return run;
    };
    const writeDetails = async (patch: Patch) => {
      // Title, description and estimate are compared with the card's rev the panel last saw: someone else's
      // newer edit answers 409 `stale` and the panel reloads instead of overwriting it.
      const guarded = GUARDED.some(k => k in patch);
      if (guarded) {
        // Board drags and other writes do not move the panel's rev: look at the server first when the copy is old.
        const updatedAt = qc.getQueryState(key)?.dataUpdatedAt ?? 0;
        if (Date.now() - updatedAt > 3000) await refetch();
      }
      const attempt = () => {
        const expectedRev = guarded ? get()?.card.rev : undefined;
        return send('PATCH', `/cards/${cardId}/details`, expectedRev ? {...patch, expectedRev} : patch);
      };
      const before = get()?.card;
      try {
        await attempt();
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'stale')) throw error;
        await refetch();
        const after = get()?.card;
        // Only unrelated fields changed on the server: the edit is still safe, send it once more.
        const same = !!before && !!after && GUARDED.every(k => !(k in patch) || before[k] === after[k]);
        if (!same) throw error;
        await attempt();
      }
      const {title: _t, priority: _p, dueDate: _d, completed: _c, ...rest} = patch;
      if (Object.keys(rest).length) set(d => ({...d, card: {...d.card, ...rest}}));
    };

    const setLabel = async (labelId: number, on: boolean) => {
      await send(on ? 'PUT' : 'DELETE', `/cards/${cardId}/labels/${labelId}`, on ? {} : undefined);
      set(d => ({...d, labelIds: on ? [...new Set([...d.labelIds, labelId])] : d.labelIds.filter(id => id !== labelId)}));
    };
    const createLabel = async (input: {name: string; colorHex: string}) => {
      const res = await tracked(() => call<{label: LabelT}>('POST', `/boards/${boardId}/labels`, input));
      set(d => ({...d, labels: [...d.labels, res.label]}));
      return res.label;
    };
    const updateLabel = async (id: number, input: {name: string; colorHex: string}) => {
      const res = await tracked(() => call<{label: LabelT}>('PATCH', `/labels/${id}`, input));
      set(d => ({...d, labels: d.labels.map(l => (l.id === id ? res.label : l))}));
    };
    const deleteLabel = async (id: number) => {
      await tracked(() => call('DELETE', `/labels/${id}`));
      set(d => ({...d, labels: d.labels.filter(l => l.id !== id), labelIds: d.labelIds.filter(l => l !== id)}));
    };

    const setMember = async (person: PersonT, on: boolean) => {
      await send(on ? 'PUT' : 'DELETE', `/cards/${cardId}/members/${person.id}`, on ? {} : undefined);
      set(d => ({...d, members: on ? [...d.members.filter(m => m.id !== person.id), person] : d.members.filter(m => m.id !== person.id)}));
      void qc.invalidateQueries({queryKey: ['card-people', cardId]});
    };

    const addChecklist = async (title: string) => {
      const res = await send<Written & {checklist: ChecklistT}>('POST', `/cards/${cardId}/checklists`, {title});
      set(d => ({...d, checklists: [...d.checklists, res.checklist]}));
      return res.checklist;
    };
    const renameChecklist = async (id: number, title: string) => {
      await send('PATCH', `/checklists/${id}`, {title});
      set(d => ({...d, checklists: d.checklists.map(l => (l.id === id ? {...l, title} : l))}));
    };
    const deleteChecklist = async (id: number) => {
      await send('DELETE', `/checklists/${id}`);
      set(d => ({...d, checklists: d.checklists.filter(l => l.id !== id)}));
    };
    /** One request for up to 20 items; the same person, day, time and reminder (all optional) go on every one of them. */
    const addItems = async (checklistId: number, texts: string[], meta: {assigneeId?: number; dueDate?: string; dueAt?: string; dueRemindMinutes?: number | null} = {}) => {
      const res = await send<Written & {items: ItemT[]}>('POST', `/checklists/${checklistId}/items`, {texts, ...meta});
      set(d => ({...d, checklists: d.checklists.map(l => (l.id === checklistId ? {...l, items: [...l.items, ...res.items]} : l))}));
      return res.items;
    };
    const mapItem = (itemId: number, fn: (item: ItemT) => ItemT | null) => (d: DetailT): DetailT => ({
      ...d,
      checklists: d.checklists.map(l => ({...l, items: l.items.flatMap(i => (i.id === itemId ? (fn(i) ? [fn(i)!] : []) : [i]))})),
    });
    /** Optimistic: the box flips at once; a failure puts it back and rejects. */
    const toggleItem = async (itemId: number, done: boolean) => {
      set(mapItem(itemId, i => ({...i, done})));
      try {
        await send('PATCH', `/checklist-items/${itemId}`, {done});
      } catch (error) {
        // Only this box goes back; other edits made meanwhile stay.
        set(mapItem(itemId, i => ({...i, done: !done})));
        throw error;
      }
    };
    const editItem = async (itemId: number, text: string) => {
      await send('PATCH', `/checklist-items/${itemId}`, {text});
      set(mapItem(itemId, i => ({...i, text})));
    };
    /** One person per item (`null` clears). The name comes from the picker, so the row updates without a reload. */
    const setItemAssignee = async (itemId: number, person: PersonT | null) => {
      await send('PATCH', `/checklist-items/${itemId}`, {assigneeId: person?.id ?? null});
      set(mapItem(itemId, i => ({...i, assignee: person})));
    };
    /** A due day only: a day that changes drops the item's time and reminder (the server's trigger does the same). */
    const setItemDue = async (itemId: number, dueDate: string | null) => {
      await send('PATCH', `/checklist-items/${itemId}`, {dueDate});
      set(mapItem(itemId, i => (i.dueDate === dueDate ? {...i, dueDate} : {...i, dueDate, dueAt: null, dueRemindMinutes: null})));
    };
    /** The item's due date popover: the day, the exact moment and its reminder, saved together (all null removes). */
    const setItemDueTime = async (itemId: number, due: {dueDate: string | null; dueAt: string | null; dueRemindMinutes: number | null}) => {
      await send('PATCH', `/checklist-items/${itemId}`, due);
      set(mapItem(itemId, i => ({...i, dueDate: due.dueDate, dueAt: due.dueDate ? due.dueAt : null, dueRemindMinutes: due.dueDate && due.dueAt ? due.dueRemindMinutes : null})));
    };
    const deleteItem = async (itemId: number) => {
      await send('DELETE', `/checklist-items/${itemId}`);
      set(mapItem(itemId, () => null));
    };

    const addComment = async (body: string, mentions: number[]) => {
      const res = await send<Written & {comment: CommentT}>('POST', `/cards/${cardId}/comments`, {body, mentions});
      set(d => ({...d, comments: {...d.comments, items: [res.comment, ...d.comments.items]}}));
    };
    const editComment = async (id: number, body: string, mentions: number[]) => {
      const res = await send<Written & {comment: CommentT}>('PATCH', `/comments/${id}`, {body, mentions});
      set(d => ({...d, comments: {...d.comments, items: d.comments.items.map(c => (c.id === id ? res.comment : c))}}));
    };
    const deleteComment = async (id: number) => {
      await send('DELETE', `/comments/${id}`);
      set(d => ({...d, comments: {...d.comments, items: d.comments.items.filter(c => c.id !== id)}}));
    };
    const moreComments = async () => {
      const next = get()?.comments.next;
      if (!next) return;
      const res = await call<{items: CommentT[]; next: number | null}>('GET', `/cards/${cardId}/comments?before=${next}`);
      set(d => ({...d, comments: {items: [...d.comments.items, ...res.items.filter(i => !d.comments.items.some(c => c.id === i.id))], next: res.next}}));
    };

    const addLink = async (url: string, name: string) => {
      const res = await send<Written & {attachment: AttachmentT}>('POST', `/cards/${cardId}/attachments/link`, {url, ...(name ? {name} : {})});
      set(d => ({...d, attachments: [res.attachment, ...d.attachments]}));
    };
    /** The three steps of docs/agent/files.md: ask, PUT the bytes straight to storage, confirm. */
    const upload = async (file: File, signal?: AbortSignal) => {
      const grant = await tracked(() =>
        call<{attachmentId: number; upload: Parameters<typeof putFile>[0]}>('POST', `/cards/${cardId}/attachments/upload`, {
          name: file.name,
          contentType: file.type,
          size: file.size,
        })
      );
      const put = await putFile(grant.upload, file, {signal});
      if (!put.ok) {
        void call('DELETE', `/attachments/${grant.attachmentId}`).catch(() => undefined); // best effort: drop the unfinished row
        throw new ApiError(put.message, put.status, put.code);
      }
      const res = await send<Written & {attachment: AttachmentT; coverAttachmentId?: number | null}>('POST', `/attachments/${grant.attachmentId}/complete`);
      // The server made the first image the cover: show it at once (the board picks it up with its next sync).
      const cover = res.coverAttachmentId ?? null;
      if (res.attachment)
        set(d => ({
          ...d,
          card: cover === null ? d.card : {...d.card, coverAttachmentId: cover},
          attachments: [{...res.attachment, ...(cover === null ? {} : {isCover: true})}, ...d.attachments.filter(a => a.id !== res.attachment.id)],
        }));
    };
    const renameAttachment = async (id: number, name: string) => {
      await send('PATCH', `/attachments/${id}`, {name});
      set(d => ({...d, attachments: d.attachments.map(a => (a.id === id ? {...a, name} : a))}));
    };
    const removeAttachment = async (id: number) => {
      await send('DELETE', `/attachments/${id}`);
      set(d => ({
        ...d,
        attachments: d.attachments.filter(a => a.id !== id),
        card: d.card.coverAttachmentId === id ? {...d.card, coverAttachmentId: null} : d.card,
      }));
    };
    const setCover = async (attachmentId: number | null) => {
      await send('PUT', `/cards/${cardId}/cover`, {attachmentId});
      set(d => ({
        ...d,
        card: {...d.card, coverAttachmentId: attachmentId},
        attachments: d.attachments.map(a => ({...a, isCover: a.id === attachmentId})),
      }));
    };

    /** Custom fields: a value is optimistic-free (the server validates by type); null clears it. */
    const setFieldValue = async (fieldId: number, value: FieldValueT | null) => {
      await send('PUT', `/cards/${cardId}/fields/${fieldId}`, {value});
      set(d => {
        const next = {...d.fieldValues};
        if (value === null || value === '') delete next[String(fieldId)];
        else next[String(fieldId)] = typeof value === 'string' ? value.trim() : value;
        return {...d, fieldValues: next};
      });
    };
    const createField = async (input: {name: string; type: FieldType; options: {name: string; colorHex: string}[]}) => {
      const res = await tracked(() => call<{field: FieldT}>('POST', `/boards/${boardId}/fields`, input));
      set(d => ({...d, fields: [...d.fields, res.field]}));
    };
    const renameField = async (id: number, name: string) => {
      await tracked(() => call('PATCH', `/fields/${id}`, {name}));
      set(d => ({...d, fields: d.fields.map(f => (f.id === id ? {...f, name} : f))}));
    };
    const deleteField = async (id: number) => {
      await tracked(() => call('DELETE', `/fields/${id}`));
      set(d => {
        const next = {...d.fieldValues};
        delete next[String(id)];
        return {...d, fields: d.fields.filter(f => f.id !== id), fieldValues: next};
      });
    };
    /** Drag order: optimistic, rolled back on failure; a list that went stale (someone added or removed a field) reloads. */
    const reorderFields = async (ids: number[]) => {
      const before = get()?.fields;
      const byId = new Map((before ?? []).map(f => [f.id, f]));
      set(d => ({...d, fields: ids.map(id => byId.get(id)).filter((f): f is FieldT => !!f)}));
      try {
        await tracked(() => call('PUT', `/boards/${boardId}/fields/order`, {ids}));
      } catch (error) {
        if (before) set(d => ({...d, fields: before}));
        if (error instanceof ApiError && error.code === 'stale') void refetch();
        throw error;
      }
    };
    const addOption = async (fieldId: number, input: {name: string; colorHex: string}) => {
      const res = await tracked(() => call<{option: FieldOptionT}>('POST', `/fields/${fieldId}/options`, input));
      set(d => ({...d, fields: d.fields.map(f => (f.id === fieldId ? {...f, options: [...f.options, res.option]} : f))}));
    };
    const deleteOption = async (fieldId: number, optionId: number) => {
      await tracked(() => call('DELETE', `/field-options/${optionId}`));
      set(d => {
        const next = {...d.fieldValues};
        if (next[String(fieldId)] === optionId) delete next[String(fieldId)];
        return {...d, fieldValues: next, fields: d.fields.map(f => (f.id === fieldId ? {...f, options: f.options.filter(o => o.id !== optionId)} : f))};
      });
    };
    /** A copy lands last in the same lane; the board behind reloads to show it. */
    const copyCard = async () => {
      const res = await tracked(() => call<{cardId: number}>('POST', `/cards/${cardId}/copy`));
      void qc.invalidateQueries({queryKey: ['board', boardId]});
      return res.cardId;
    };

    /** Follow or stop following the card: the person's own flag, so reading the card is enough. */
    const setWatching = async (on: boolean) => {
      const res = await tracked(() => call<{watching: boolean}>(on ? 'PUT' : 'DELETE', `/cards/${cardId}/watch`));
      set(d => ({...d, watching: res.watching}));
      return res.watching;
    };

    return {
      setWatching, setFieldValue, createField, renameField, deleteField, reorderFields, addOption, deleteOption, copyCard,
      patchDetails, setLabel, createLabel, updateLabel, deleteLabel, setMember,
      addChecklist, renameChecklist, deleteChecklist, addItems, toggleItem, editItem, deleteItem, setItemAssignee, setItemDue, setItemDueTime,
      addComment, editComment, deleteComment, moreComments,
      addLink, upload, renameAttachment, removeAttachment, setCover,
    };
  }, [qc, boardId, cardId]);
}

export type CardActions = ReturnType<typeof useCardActions>;

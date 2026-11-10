import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {memo, useCallback, useRef} from 'react';

import {useI18n, useT} from '../../i18n';
import {Icon, Menu, useToast} from '../../portal/ui';
import {AvatarStack, Chip} from '../../portal/ui/chips';
import {todayISO} from '../../portal/ui/date';
import type {CardT} from '../api';
import {useEnter} from '../motion';
import {isTemp} from './actions';
import {type QuickTarget, setQuickAction} from './quick-action';
import {MAX_SELECTED, useIsSelected, useSelection, useSelectMode} from './selection';

/** The priority badge's colour class; `none` (or anything unknown) shows no badge. */
const PRIORITY_CLASS: Record<string, string | undefined> = {low: 'lf-pri-low', medium: 'lf-pri-medium', high: 'lf-pri-high', urgent: 'lf-pri-urgent'};

type Handlers = {onEdit: (card: CardT) => void; onArchive: (card: CardT) => void; onMove?: (card: CardT) => void; onCopyLink?: (card: CardT) => void};

/** The card's face: title first, a priority badge (text + colour, as Trello's custom-field badges), ONE meta row (hide zeros). */
export const CardFace = memo(function CardFace({card, canWrite, handlers}: {card: CardT; canWrite: boolean; handlers?: Handlers}) {
  const t = useT();
  const toast = useToast();
  const {formatDate} = useI18n();
  // Bulk select: a tick on the card (people who can write), and a click on the card ticks it while select mode is on.
  const selection = useSelection();
  const selected = useIsSelected(card.id);
  const selectMode = useSelectMode();
  const selectable = selection !== null && canWrite && handlers !== undefined;
  // A quick action opens the card with that part ready (the panel presses the matching control).
  const quick = (target: QuickTarget) => {
    if (!handlers) return;
    setQuickAction(card.id, target);
    handlers.onEdit(card);
  };
  const tick = (range: boolean) => {
    if (selection?.toggle(card.id, range)) toast.danger(t('bulk.limit', {max: MAX_SELECTED}));
  };
  const overdue = card.dueDate !== null && !card.completed && card.dueDate < todayISO();
  const labels = card.labels ?? [];
  const members = card.members ?? [];
  const moreLabels = (card.labelCount ?? labels.length) - labels.length;
  const moreMembers = (card.memberCount ?? members.length) - members.length;
  const hasCounts = card.checklistTotal > 0 || card.commentCount > 0 || card.attachmentCount > 0;
  const hasMeta = PRIORITY_CLASS[card.priority] !== undefined || Boolean(card.dueDate) || hasCounts || members.length > 0;
  const counts = (
    <>
      {card.checklistTotal > 0 && (
        <span className="lf-meta" title={t('card.checklist', {done: card.checklistDone, total: card.checklistTotal})}>
          <Icon name="checklist" size={14} />
          {card.checklistDone}/{card.checklistTotal}
        </span>
      )}
      {card.commentCount > 0 && (
        <span className="lf-meta" title={t('card.comments', {count: card.commentCount})}>
          <Icon name="message" size={14} />
          {card.commentCount}
        </span>
      )}
      {card.attachmentCount > 0 && (
        <span className="lf-meta" title={t('card.attachments', {count: card.attachmentCount})}>
          <Icon name="paperclip" size={14} />
          {card.attachmentCount}
        </span>
      )}
    </>
  );
  return (
    <>
      {card.coverAttachmentId != null && (
        <img className="lf-card-cover" src={`/site-api/attachments/${card.coverAttachmentId}/view`} alt="" loading="lazy" decoding="async" />
      )}
      {labels.length > 0 && (
        <ul className="lf-card-labels" aria-label={t('card.labelsList', {names: labels.map(l => l.name).join(', ')})}>
          {labels.map(l => (
            <li key={l.id} title={t('card.labelTooltip', {name: l.name})}>
              <Chip size="sm" color={l.colorHex}>
                {l.name}
              </Chip>
            </li>
          ))}
          {moreLabels > 0 && <li className="lf-meta">+{moreLabels}</li>}
        </ul>
      )}
      <div className="lf-card-top">
        {selectable && (
          <input
            type="checkbox"
            className="lf-card-check"
            checked={selected}
            aria-label={t('bulk.selectCard', {title: card.title})}
            onChange={() => {}}
            onClick={event => {
              event.stopPropagation();
              tick(event.shiftKey);
            }}
          />
        )}
        {handlers ? (
          <button type="button" className="lf-card-title" dir="auto" data-done={card.completed ? '' : undefined} onClick={event => {
            // Select mode (or Shift / Ctrl / Cmd held): the click ticks the card instead of opening it.
            if (selectable && (selectMode || event.shiftKey || event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              tick(event.shiftKey);
            } else handlers.onEdit(card);
          }}>
            {card.completed && <Icon name="check-circle" size={16} />}
            {card.number != null && <span className="lf-card-num" title={t('card.numberTitle', {number: card.number})}>#{card.number}</span>}
            {card.title}
          </button>
        ) : (
          <span className="lf-card-title" dir="auto" data-done={card.completed ? '' : undefined}>
            {card.completed && <Icon name="check-circle" size={16} />}
            {card.number != null && <span className="lf-card-num" title={t('card.numberTitle', {number: card.number})}>#{card.number}</span>}
            {card.title}
          </span>
        )}
      </div>
      {handlers && canWrite && (
        // A child of the card, not the title row: it sits 4px from the card's top-right corner whatever is above the title.
        <div className="lf-card-tools">
          {/* The pencil (top-right, on hover or focus) opens the card's quick actions. */}
          <Menu
            label={t('card.menu', {title: card.title})}
            trigger={<Icon name="pencil" size={14} />}
            items={[
              {label: t('card.quick.open'), icon: 'external', onSelect: () => handlers.onEdit(card)},
              {label: t('card.quick.labels'), icon: 'hash', onSelect: () => quick('labels')},
              {label: t('card.quick.members'), icon: 'user', onSelect: () => quick('members')},
              {label: t('card.quick.cover'), icon: 'image', onSelect: () => quick('cover')},
              {label: t('card.quick.dates'), icon: 'clock', onSelect: () => quick('dates')},
              ...(handlers.onMove ? [{label: t('card.quick.move'), icon: 'arrow-right' as const, onSelect: () => handlers.onMove?.(card)}] : []),
              ...(handlers.onCopyLink ? [{label: t('card.copyLink'), icon: 'link' as const, onSelect: () => handlers.onCopyLink?.(card)}] : []),
              'separator',
              {label: t('card.quick.archive'), icon: 'archive', onSelect: () => handlers.onArchive(card), danger: true},
            ]}
          />
        </div>
      )}
      {hasMeta && (
        <div className="lf-card-meta">
          {/* The priority badge on a line of its own, above the bottom row (Trello's custom-field badges). */}
          {PRIORITY_CLASS[card.priority] && (
            <span className="lf-card-badges">
              <span className={`lf-pri-badge ${PRIORITY_CLASS[card.priority]}`}>
                <Icon name="flag" size={12} />
                {t('card.priorityLabel', {level: t(`card.priority.${card.priority}` as 'card.priority.low')})}
              </span>
            </span>
          )}
          {/* The counts on their own row; the date below them, bottom-left, level with the avatars on the right. Without
              a date the counts take that bottom-left spot instead. The avatars never wrap off the bottom row. */}
          {hasCounts && <span className={card.dueDate ? 'lf-card-counts' : 'lf-card-icons'}>{counts}</span>}
          {card.dueDate && (
            <span className="lf-card-icons">
              <span className="lf-meta" data-overdue={overdue ? '' : undefined}>
                <Icon name="calendar" size={14} />
                {formatDate(`${card.dueDate}T00:00:00Z`, {dateStyle: 'medium', timeZone: 'UTC'})}
                {overdue && <span className="sr-only"> ({t("card.overdue")})</span>}
              </span>
            </span>
          )}
          {members.length > 0 && (
            <span className="lf-card-people">
              <AvatarStack people={members.map(m => ({name: m.name}))} max={3} size="sm" label={t('card.assignedTo', {names: members.map(m => m.name).join(', ')})} />
              {moreMembers > 0 && <span className="lf-meta">+{moreMembers}</span>}
            </span>
          )}
        </div>
      )}
    </>
  );
});

/** A card in a lane: draggable by pointer, touch and keyboard (the focused card is the keyboard activator). */
function SortableCardView({card, canWrite, handlers}: {card: CardT; canWrite: boolean; handlers: Handlers}) {
  const pending = isTemp(card.id);
  const selected = useIsSelected(card.id);
  const selectMode = useSelectMode();
  const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} = useSortable({
    id: `card-${card.id}`,
    data: {type: 'card', laneId: card.laneId},
    // Select mode still drags (a click moves less than 6 px, so it only ticks); a ticked card takes its ticked friends along.
    // Only keys pressed on the card itself start a keyboard drag, so Space on the tick never does.
    disabled: !canWrite || pending,
  });
  // The card itself is the keyboard drag activator (Space / Enter while the card has focus): no separate grip button.
  // It stays a list item (no role="button" around the card's own buttons); keys pressed on its inner controls never start a drag.
  const self = useRef<HTMLLIElement | null>(null);
  // Brought back (undo, a failed archive): it grows in instead of popping into place.
  useEnter(`card-${card.id}`, self);
  const setRefs = useCallback(
    (node: HTMLLIElement | null) => {
      self.current = node;
      setNodeRef(node);
      setActivatorNodeRef(node);
    },
    [setNodeRef, setActivatorNodeRef]
  );
  return (
    <li
      ref={setRefs}
      className="lf-card"
      tabIndex={attributes.tabIndex}
      aria-roledescription={attributes['aria-roledescription']}
      aria-describedby={attributes['aria-describedby']}
      aria-disabled={attributes['aria-disabled'] || undefined}
      data-card-id={card.id}
      data-dragging={isDragging ? '' : undefined}
      data-pending={pending ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-select-mode={selectMode ? '' : undefined}
      aria-busy={pending ? true : undefined}
      // Applied through React's CSSOM style updates (CSP-safe), never a style attribute in HTML.
      style={{transform: CSS.Transform.toString(transform), transition}}
      {...listeners}
      // A click anywhere on the card (cover, labels, meta, padding) acts like a click on its title. Clicks on the card's
      // own controls (tick, tools, menu) keep their own action. A drag never clicks (dnd-kit's 6 px threshold).
      onClick={event => {
        if (pending) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, [role="menu"], [role="menuitem"], [role="dialog"]')) return;
        const title = event.currentTarget.querySelector<HTMLButtonElement>('button.lf-card-title');
        title?.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey}));
      }}>
      <CardFace card={card} canWrite={canWrite && !pending} handlers={pending ? undefined : handlers} />
    </li>
  );
}

/** Memoized: the lane passes a fresh `handlers` object each render, so compare its two functions, not the object. */
export const SortableCard = memo(
  SortableCardView,
  (a, b) => a.card === b.card && a.canWrite === b.canWrite && a.handlers.onEdit === b.handlers.onEdit && a.handlers.onArchive === b.handlers.onArchive && a.handlers.onMove === b.handlers.onMove
);

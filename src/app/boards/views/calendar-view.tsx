import {DndContext, type DragEndEvent, DragOverlay, type DragStartEvent, MouseSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors} from '@dnd-kit/core';
import {CSS} from '@dnd-kit/utilities';
import {useEffect, useMemo, useState} from 'react';

import {useI18n, useT} from '../../../i18n';
import {Button, IconButton, Notice} from '../../../portal/ui';
import {addDays, todayISO} from '../../../portal/ui/date';
import type {BoardData, CardT} from '../../api';
import {pauseBoardSync} from '../../use-board-sync';
import {type BoardActions, isTemp} from '../actions';
import {LoadMoreBar, useFirstPages} from './use-lanes-loaded';
import {agendaDays, dropChangesDue, groupByDue, isInMonth, monthOf, monthWeeks, shiftMonth, weekdayOrder} from './view-logic';

const MAX_CHIPS = 3;
const SUNDAY = '2026-11-01'; // a known Sunday: weekday names come from Intl, in the user's language

function CardChip({card, canDrag, onOpen}: {card: CardT; canDrag: boolean; onOpen: (card: CardT) => void}) {
  const {setNodeRef, attributes, listeners, transform, isDragging} = useDraggable({id: `cal-${card.id}`, disabled: !canDrag || isTemp(card.id)});
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`lf-cal-chip${card.completed ? ' is-done' : ''}${isDragging ? ' is-dragging' : ''}`}
      {...attributes}
      {...listeners}
      style={transform ? {transform: CSS.Translate.toString(transform)} : undefined}
      dir="auto"
      onClick={() => onOpen(card)}>
      {card.title}
    </button>
  );
}

function DayCell({iso, ym, today, canDrop, cards, canDrag, expanded, onToggle, onOpen, label}: {
  iso: string; ym: {year: number; month: number}; today: string; canDrop: boolean; cards: CardT[]; canDrag: boolean;
  expanded: boolean; onToggle: () => void; onOpen: (card: CardT) => void; label: string;
}) {
  const t = useT();
  const {setNodeRef, isOver} = useDroppable({id: `day-${iso}`, disabled: !canDrop});
  const shown = expanded ? cards : cards.slice(0, MAX_CHIPS);
  return (
    <li ref={setNodeRef} className="lf-cal-day" data-outside={isInMonth(iso, ym) ? undefined : ''} data-today={iso === today ? '' : undefined} data-over={isOver ? '' : undefined} aria-label={t('views.cal.dayCards', {date: label, count: cards.length})}>
      <span className="lf-cal-num" aria-current={iso === today ? 'date' : undefined}>
        {Number(iso.slice(8))}
        {iso === today && <span className="sr-only"> ({t('views.cal.today.sr')})</span>}
      </span>
      <div className="lf-cal-cards">
        {shown.map(card => (
          <CardChip key={card.id} card={card} canDrag={canDrag} onOpen={onOpen} />
        ))}
        {cards.length > MAX_CHIPS && (
          <button type="button" className="lf-cal-more" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? t('views.cal.lessCards') : t('views.cal.moreCards', {count: cards.length - MAX_CHIPS})}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The board as a month calendar by due date. Drag a card to another day: `actions.updateCard` shows it at once,
 * saves through PATCH /cards/:id and rolls back with a message on failure. People who cannot write get no drag and
 * a reason; the card panel's date field is the keyboard way.
 */
export function CalendarView({data, actions, onOpenCard}: {data: BoardData; actions: BoardActions; onOpenCard: (card: CardT) => void}) {
  const t = useT();
  const {firstDayOfWeek, formatDate} = useI18n();
  const canWrite = data.board.canWrite && !data.board.archived;
  const today = todayISO();
  const [ym, setYm] = useState(() => monthOf(today));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState<CardT | null>(null);
  useFirstPages(data.lanes, actions);
  useEffect(() => () => pauseBoardSync(false), []);

  const {byDay, undated} = useMemo(() => groupByDue(data.lanes), [data.lanes]);
  const weeks = useMemo(() => monthWeeks(ym, firstDayOfWeek), [ym, firstDayOfWeek]);
  const agenda = useMemo(() => agendaDays(byDay, ym), [byDay, ym]);
  const sensors = useSensors(useSensor(MouseSensor, {activationConstraint: {distance: 6}}), useSensor(TouchSensor, {activationConstraint: {delay: 220, tolerance: 8}}));

  const fmt = (iso: string, options: Intl.DateTimeFormatOptions) => formatDate(`${iso}T00:00:00Z`, {...options, timeZone: 'UTC'});
  const monthLabel = fmt(`${String(ym.year).padStart(4, '0')}-${String(ym.month).padStart(2, '0')}-01`, {month: 'long', year: 'numeric'});

  const onDragStart = (event: DragStartEvent) => {
    pauseBoardSync(true);
    const id = Number(String(event.active.id).slice(4));
    setDragging(data.lanes.flatMap(l => l.cards).find(c => c.id === id) ?? null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    pauseBoardSync(false);
    setDragging(null);
    const over = event.over ? String(event.over.id) : '';
    if (!over.startsWith('day-')) return;
    const date = over.slice(4);
    const id = Number(String(event.active.id).slice(4));
    const card = data.lanes.flatMap(l => l.cards).find(c => c.id === id);
    if (card && canWrite && dropChangesDue(card, date)) void actions.updateCard(id, {dueDate: date});
  };
  const onDragCancel = () => {
    pauseBoardSync(false);
    setDragging(null);
  };

  return (
    <div className="lf-vw lf-vw-cal">
      <div className="lf-cal-bar">
        <IconButton icon="chevron-left" label={t('views.cal.prev')} onClick={() => setYm(shiftMonth(ym, -1))} />
        <IconButton icon="chevron-right" label={t('views.cal.next')} onClick={() => setYm(shiftMonth(ym, 1))} />
        <Button variant="secondary" size="sm" onClick={() => setYm(monthOf(today))}>
          {t('views.cal.today')}
        </Button>
        <h2 className="lf-cal-title" aria-live="polite">{monthLabel}</h2>
      </div>
      {!canWrite ? (
        <Notice tone="info">{data.board.archived ? t('views.cal.archivedReadOnly') : t('views.cal.readOnly')}</Notice>
      ) : (
        <p className="lf-vw-note">{t('views.cal.dragHint')} {t('views.cal.dragKeyboard')}</p>
      )}
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        <div className="lf-cal-layout">
          <div className="lf-cal-grid-wrap" role="group" aria-label={t('views.cal.label')}>
            <ol className="lf-cal-weekdays" aria-hidden="true">
              {weekdayOrder(firstDayOfWeek).map(wd => (
                <li key={wd}>{fmt(addDays(SUNDAY, wd), {weekday: 'short'})}</li>
              ))}
            </ol>
            <ol className="lf-cal-grid">
              {weeks.flat().map(iso => (
                <DayCell
                  key={iso}
                  iso={iso}
                  ym={ym}
                  today={today}
                  canDrop={canWrite}
                  canDrag={canWrite}
                  cards={byDay.get(iso) ?? []}
                  expanded={expanded === iso}
                  onToggle={() => setExpanded(cur => (cur === iso ? null : iso))}
                  onOpen={onOpenCard}
                  label={fmt(iso, {dateStyle: 'medium'})}
                />
              ))}
            </ol>
          </div>
          <div className="lf-cal-agenda">
            <h3 className="lf-cal-side-title">{t('views.cal.label')}</h3>
            {agenda.length === 0 ? (
              <p className="lf-vw-note">{t('views.cal.agendaEmpty')}</p>
            ) : (
              <ul className="lf-cal-agenda-list">
                {agenda.map(day => (
                  <li key={day.date} data-today={day.date === today ? '' : undefined}>
                    <strong>{fmt(day.date, {weekday: 'short', day: 'numeric', month: 'short'})}</strong>
                    <ul>
                      {day.cards.map(card => (
                        <li key={card.id}>
                          <button type="button" className="lf-cal-chip" dir="auto" onClick={() => onOpenCard(card)}>{card.title}</button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <aside className="lf-cal-undated" aria-label={t('views.cal.noDate')}>
            <h3 className="lf-cal-side-title">{t('views.cal.noDate')}</h3>
            {undated.length === 0 ? (
              <p className="lf-vw-note">{t('views.cal.noDateEmpty')}</p>
            ) : (
              <ul className="lf-cal-undated-list">
                {undated.map(card => (
                  <li key={card.id}>
                    <CardChip card={card} canDrag={canWrite} onOpen={onOpenCard} />
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
        <DragOverlay>{dragging ? <div className="lf-cal-chip lf-cal-chip-overlay">{dragging.title}</div> : null}</DragOverlay>
      </DndContext>
      <LoadMoreBar lanes={data.lanes} actions={actions} />
    </div>
  );
}

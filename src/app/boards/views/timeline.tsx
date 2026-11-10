import {useMemo, useState} from 'react';

import {useI18n, useT} from '../../../i18n';
import {Button, IconButton, Notice} from '../../../portal/ui';
import {addDays, todayISO} from '../../../portal/ui/date';
import type {BoardData, CardT} from '../../api';
import type {BoardActions} from '../actions';
import {isTemp} from '../actions';
import {LoadMoreBar, useFirstPages} from './use-lanes-loaded';
import {monthSegments, placeSpan, shiftAnchor, shiftedDue, timelineRows, todayColumn, windowFor, type Zoom, ZOOMS} from './timeline-logic';

/**
 * The board as a Gantt-style timeline: one row per scheduled card, a bar from its start (or creation) day to its due
 * day. Read, plus one light edit: with a bar focused, Alt+Arrow moves its due date a day (Alt+Shift a week) through
 * `actions.updateCard` (optimistic, rolled back with a message on failure). Enter opens the card. Arrow keys follow
 * the reading direction, so they are mirrored in right-to-left languages.
 */
/** Layout values are set through the CSSOM (the CSP blocks style="" attributes). */
const gridCol = (value: string) => (el: HTMLElement | null) => { if (el) el.style.gridColumn = value; };
const cssVar = (name: string, value: string) => (el: HTMLElement | null) => { if (el) el.style.setProperty(name, value); };

export function TimelineView({data, actions, onOpenCard}: {data: BoardData; actions: BoardActions; onOpenCard: (card: CardT) => void}) {
  const t = useT();
  const {firstDayOfWeek, formatDate} = useI18n();
  const canWrite = data.board.canWrite && !data.board.archived;
  const today = todayISO();
  const [anchor, setAnchor] = useState(today);
  const [zoom, setZoom] = useState<Zoom>('week');
  useFirstPages(data.lanes, actions);

  const {rows, unscheduled} = useMemo(() => timelineRows(data.lanes), [data.lanes]);
  const win = useMemo(() => windowFor(anchor, zoom, firstDayOfWeek), [anchor, zoom, firstDayOfWeek]);
  const placed = useMemo(() => rows.flatMap(row => {
    const place = placeSpan(row.span, win);
    return place ? [{...row, place}] : [];
  }), [rows, win]);
  const months = useMemo(() => monthSegments(win), [win]);
  const todayCol = todayColumn(today, win);
  const days = useMemo(() => Array.from({length: win.days}, (_, i) => addDays(win.start, i)), [win]);

  const fmt = (iso: string, options: Intl.DateTimeFormatOptions) => formatDate(`${iso}T00:00:00Z`, {...options, timeZone: 'UTC'});
  const rangeLabel = `${fmt(win.start, {dateStyle: 'medium'})} – ${fmt(addDays(win.start, win.days - 1), {dateStyle: 'medium'})}`;
  const loading = data.lanes.some(l => !l.loaded) && !data.lanes.some(l => actions.failedLanes.has(l.id));

  const onBarKey = (event: React.KeyboardEvent, card: CardT) => {
    if (!canWrite || !event.altKey || isTemp(card.id)) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget as Element).direction === 'rtl';
    const forward = (event.key === 'ArrowRight') !== rtl;
    const next = shiftedDue(card, (forward ? 1 : -1) * (event.shiftKey ? 7 : 1));
    if (next) void actions.updateCard(card.id, {dueDate: next});
  };

  return (
    <div className="lf-vw lf-vw-tl">
      <div className="lf-tl-bar">
        <IconButton icon="chevron-left" label={t('views.tl.prev')} onClick={() => setAnchor(shiftAnchor(anchor, zoom, -1))} />
        <IconButton icon="chevron-right" label={t('views.tl.next')} onClick={() => setAnchor(shiftAnchor(anchor, zoom, 1))} />
        <Button variant="secondary" size="sm" onClick={() => setAnchor(today)}>{t('views.tl.today')}</Button>
        <h2 className="lf-tl-title" aria-live="polite">{rangeLabel}</h2>
        <div className="lf-tl-zoom" role="group" aria-label={t('views.tl.zoom')}>
          {ZOOMS.map(z => (
            <button key={z} type="button" className="lf-view-btn" aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {t(z === 'week' ? 'views.tl.zoomWeek' : 'views.tl.zoomMonth')}
            </button>
          ))}
        </div>
      </div>
      {!canWrite ? (
        <Notice tone="info">{data.board.archived ? t('views.tl.archivedReadOnly') : t('views.tl.readOnly')}</Notice>
      ) : (
        <p className="lf-vw-note">{t('views.tl.editHint')}</p>
      )}
      {actions.failedLanes.size > 0 && rows.length === 0 && (
        <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => data.lanes.filter(l => actions.failedLanes.has(l.id)).forEach(l => void actions.loadLane(l.id))}>{t('common.retry')}</Button>}>
          {t('views.tl.error')}
        </Notice>
      )}
      {loading && rows.length === 0 ? (
        <p className="lf-vw-note" role="status">{t('views.loadingCards')}</p>
      ) : rows.length === 0 && actions.failedLanes.size === 0 ? (
        <p className="lf-vw-note">{t('views.tl.empty')}</p>
      ) : (
        <div className="lf-tl-scroll" role="group" aria-label={t('views.tl.label')}>
          <div className="lf-tl-grid" ref={cssVar('--lf-tl-days', String(win.days))} data-zoom={zoom}>
            {months.map(m => (
              <div key={m.iso} className="lf-tl-month" ref={gridCol(`${m.col} / span ${m.span}`)} aria-hidden="true">
                {fmt(m.iso, {month: 'long', year: 'numeric'})}
              </div>
            ))}
            {days.map((iso, i) => (
              <div key={iso} className="lf-tl-day" ref={gridCol(`${i + 1}`)} data-today={iso === today ? '' : undefined} aria-hidden="true">
                {zoom === 'week' ? fmt(iso, {weekday: 'short', day: 'numeric'}) : Number(iso.slice(8))}
              </div>
            ))}
            {todayCol !== null && <div className="lf-tl-today" ref={gridCol(`${todayCol}`)} aria-hidden="true" />}
            {placed.length === 0 && <p className="lf-vw-note lf-tl-none">{t('views.tl.noneInRange')}</p>}
            {placed.map(({card, span, place}) => {
              const range = span.milestone
                ? fmt(span.end, {dateStyle: 'medium'})
                : `${fmt(span.start, {dateStyle: 'medium'})} – ${fmt(span.end, {dateStyle: 'medium'})}`;
              return (
                <div key={card.id} className="lf-tl-row" role="presentation">
                  <button
                    type="button"
                    className={`lf-tl-barbtn${card.completed ? ' is-done' : ''}${span.milestone ? ' is-milestone' : ''}`}
                    ref={gridCol(`${place.col} / span ${place.span}`)}
                    data-clip-start={place.clippedStart ? '' : undefined}
                    data-clip-end={place.clippedEnd ? '' : undefined}
                    aria-label={t('views.tl.barLabel', {title: card.title, range})}
                    title={range}
                    dir="auto"
                    onClick={() => onOpenCard(card)}
                    onKeyDown={e => onBarKey(e, card)}>
                    <span className="lf-tl-bartext">{card.title}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {unscheduled.length > 0 && (
        <aside className="lf-tl-unscheduled" aria-label={t('views.tl.unscheduled')}>
          <h3 className="lf-cal-side-title">{t('views.tl.unscheduled')}</h3>
          <ul className="lf-cal-undated-list">
            {unscheduled.map(card => (
              <li key={card.id}>
                <button type="button" className="lf-cal-chip" dir="auto" onClick={() => onOpenCard(card)}>{card.title}</button>
              </li>
            ))}
          </ul>
        </aside>
      )}
      <LoadMoreBar lanes={data.lanes} actions={actions} />
    </div>
  );
}

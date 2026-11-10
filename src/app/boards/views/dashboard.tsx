import {useMemo} from 'react';

import {useI18n, useT} from '../../../i18n';
import {Button, Icon, type IconName, Notice} from '../../../portal/ui';
import {todayISO} from '../../../portal/ui/date';
import type {BoardData} from '../../api';
import type {BoardActions} from '../actions';
import {dashboardStats, type WeekBucket} from './dashboard-logic';
import {LoadMoreBar, useFirstPages} from './use-lanes-loaded';

/** Bar lengths are set through the CSSOM (the CSP blocks style="" attributes). */
const widthPct = (pct: number) => (el: HTMLElement | null) => { if (el) el.style.inlineSize = `${pct}%`; };
const heightPct = (pct: number) => (el: HTMLElement | null) => { if (el) el.style.blockSize = `${pct}%`; };

function BarList({title, rows, empty}: {title: string; rows: {key: string; name: string; count: number}[]; empty: string}) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <section className="lf-db-card" aria-label={title}>
      <h3 className="lf-db-h">{title}</h3>
      {rows.length === 0 ? (
        <p className="lf-vw-note">{empty}</p>
      ) : (
        <ul className="lf-db-bars">
          {rows.map(r => (
            <li key={r.key} className="lf-db-barrow">
              <span className="lf-db-name" dir="auto">{r.name}</span>
              <span className="lf-db-track" aria-hidden="true"><span className="lf-db-fill" ref={widthPct((r.count / max) * 100)} /></span>
              <span className="lf-db-val">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WeeksChart({weeks}: {weeks: WeekBucket[]}) {
  const t = useT();
  const {formatDate} = useI18n();
  const max = Math.max(1, ...weeks.map(w => w.done + w.open));
  const label = (iso: string) => formatDate(`${iso}T00:00:00Z`, {month: 'short', day: 'numeric', timeZone: 'UTC'});
  return (
    <section className="lf-db-card" aria-label={t('views.db.weeks')}>
      <h3 className="lf-db-h">{t('views.db.weeks')}</h3>
      <div className="lf-db-legend" aria-hidden="true">
        <span><i className="lf-db-key is-done" />{t('views.db.done')}</span>
        <span><i className="lf-db-key is-open" />{t('views.db.open')}</span>
      </div>
      <div className="lf-db-cols" role="img" aria-label={t('views.db.weeksSummary', {text: weeks.map(w => t('views.db.weekRow', {date: label(w.start), done: w.done, open: w.open})).join('; ')})}>
        {weeks.map(w => (
          <div key={w.start} className="lf-db-col" title={t('views.db.weekRow', {date: label(w.start), done: w.done, open: w.open})}>
            <div className="lf-db-stack">
              <div className="lf-db-seg is-open" ref={heightPct((w.open / max) * 100)} />
              <div className="lf-db-seg is-done" ref={heightPct((w.done / max) * 100)} />
            </div>
            <span className="lf-db-tick" aria-hidden="true">{label(w.start)}</span>
          </div>
        ))}
      </div>
      <details className="lf-db-table">
        <summary>{t('views.db.showTable')}</summary>
        <table>
          <caption className="lf-db-sr">{t('views.db.weeks')}</caption>
          <thead><tr><th scope="col">{t('views.db.week')}</th><th scope="col">{t('views.db.done')}</th><th scope="col">{t('views.db.open')}</th></tr></thead>
          <tbody>{weeks.map(w => <tr key={w.start}><th scope="row">{label(w.start)}</th><td>{w.done}</td><td>{w.open}</td></tr>)}</tbody>
        </table>
      </details>
    </section>
  );
}

/** Dashboard of the board: counts per list and per assignee, overdue, due soon and a weekly done/open chart. Read only. */
export function DashboardView({data, actions}: {data: BoardData; actions: BoardActions}) {
  const t = useT();
  const {firstDayOfWeek} = useI18n();
  useFirstPages(data.lanes, actions);
  const stats = useMemo(() => dashboardStats(data.lanes, todayISO(), firstDayOfWeek), [data.lanes, firstDayOfWeek]);
  const failed = data.lanes.filter(l => actions.failedLanes.has(l.id));
  const loading = data.lanes.some(l => !l.loaded) && failed.length === 0;

  type Tone = 'info' | 'accent' | 'success' | 'danger' | 'warning' | 'neutral';
  const tiles: {key: string; label: string; value: number; icon: IconName; tone: Tone; bad?: boolean}[] = [
    {key: 'total', label: t('views.db.total'), value: stats.total, icon: 'layers', tone: 'info'},
    {key: 'open', label: t('views.db.open'), value: stats.open, icon: 'circle', tone: 'accent'},
    {key: 'done', label: t('views.db.done'), value: stats.done, icon: 'check-circle', tone: 'success'},
    {key: 'overdue', label: t('views.db.overdue'), value: stats.overdue, icon: 'alert', tone: stats.overdue > 0 ? 'danger' : 'neutral', bad: stats.overdue > 0},
    {key: 'soon', label: t('views.db.dueSoon'), value: stats.dueSoon, icon: 'clock', tone: stats.dueSoon > 0 ? 'warning' : 'neutral'},
  ];
  const assignees = [
    ...stats.byAssignee.map(a => ({key: String(a.id), name: a.name, count: a.count})),
    ...(stats.unassigned > 0 ? [{key: 'none', name: t('views.db.unassigned'), count: stats.unassigned}] : []),
  ];

  return (
    <div className="lf-vw lf-vw-db">
      {failed.length > 0 && stats.total === 0 && (
        <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => failed.forEach(l => void actions.loadLane(l.id))}>{t('common.retry')}</Button>}>
          {t('views.db.error')}
        </Notice>
      )}
      {loading && stats.total === 0 ? (
        <p className="lf-vw-note" role="status">{t('views.loadingCards')}</p>
      ) : stats.total === 0 && failed.length === 0 ? (
        <p className="lf-vw-note">{t('views.db.empty')}</p>
      ) : (
        <>
          <ul className="lf-db-tiles" aria-label={t('views.db.label')}>
            {tiles.map(tile => (
              <li key={tile.key} className="lf-db-tile" data-tone={tile.bad ? 'bad' : undefined}>
                <span className="lf-db-ico" data-tone={tile.tone} aria-hidden="true"><Icon name={tile.icon} size={18} /></span>
                <span className="lf-db-txt">
                  <span className="lf-db-num">{tile.value}</span>
                  <span className="lf-db-cap">{tile.label}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="lf-db-grid">
            <BarList title={t('views.db.byLane')} rows={stats.byLane.map(l => ({key: String(l.laneId), name: l.name, count: l.count}))} empty={t('views.db.none')} />
            <BarList title={t('views.db.byAssignee')} rows={assignees} empty={t('views.db.none')} />
            <WeeksChart weeks={stats.weeks} />
          </div>
        </>
      )}
      <LoadMoreBar lanes={data.lanes} actions={actions} />
    </div>
  );
}

import {useQuery} from '@tanstack/react-query';

import {useT} from '../../../i18n';
import {Button, Notice} from '../../../portal/ui';
import {todayISO} from '../../../portal/ui/date';
import {call} from '../../api';
import {barParts, laneBreakdown, maxOpen, splitEstimate, type WorkloadData, type WorkloadLane, type WorkloadTotals} from './workload-logic';
import './workload.css';

/** Segment lengths are set through the CSSOM (the CSP blocks style="" attributes). */
const widthPct = (pct: number) => (el: HTMLElement | null) => { if (el) el.style.inlineSize = `${pct}%`; };

type RowProps = {name: string; row: WorkloadTotals; lanes: WorkloadLane[]; max: number; onShow?: () => void};

function WorkRow({name, row, lanes, max, onShow}: RowProps) {
  const t = useT();
  const parts = barParts(row, max);
  const est = splitEstimate(row.estimateMinutes);
  const estimate =
    row.estimateMinutes <= 0 ? t('views.wl.noEstimate') : est.hours > 0 && est.minutes > 0 ? t('views.wl.est', {hours: est.hours, minutes: est.minutes}) : est.hours > 0 ? t('views.wl.estHours', {hours: est.hours}) : t('views.wl.estMinutes', {minutes: est.minutes});
  const byLane = laneBreakdown(row, lanes)
    .map(l => `${l.name} ${l.count}`)
    .join(' · ');
  return (
    <tr>
      <th scope="row">
        <span className="lf-wl-person">
          {onShow ? (
            <button type="button" className="lf-wl-link" dir="auto" onClick={onShow} aria-label={t('views.wl.show', {name})}>
              {name}
            </button>
          ) : (
            <span className="lf-wl-name" dir="auto">{name}</span>
          )}
          {byLane && <span className="lf-wl-lanes" dir="auto">{byLane}</span>}
        </span>
      </th>
      <td className="lf-wl-bar-cell">
        <span className="lf-wl-track" role="img" aria-label={t('views.wl.barLabel', {name, open: row.open, overdue: row.overdue})}>
          {parts.overduePct > 0 && <span className="lf-wl-seg-bad" ref={widthPct(parts.overduePct)} />}
          {parts.restPct > 0 && <span className="lf-wl-seg-rest" ref={widthPct(parts.restPct)} />}
        </span>
      </td>
      <td className="lf-wl-num">{row.open}</td>
      <td className={row.overdue > 0 ? 'lf-wl-num lf-wl-bad' : 'lf-wl-num'}>{row.overdue}</td>
      <td className="lf-wl-num lf-wl-hide-sm">{row.dueSoon}</td>
      <td className="lf-wl-num lf-wl-hide-sm">{estimate}</td>
    </tr>
  );
}

/**
 * Workload of the board: one row per person with open cards (busiest first), then "Unassigned". The numbers come from ONE
 * server aggregate (`GET /boards/:id/workload`), so they count every card of the board, not only the loaded ones. It reloads
 * whenever the board's revision moves. Clicking a person filters the Board view to their cards.
 */
export function WorkloadView({boardId, rev, onShowPerson}: {boardId: number; rev: string; onShowPerson: (userId: number) => void}) {
  const t = useT();
  const today = todayISO();
  const query = useQuery({
    queryKey: ['board-workload', boardId, rev, today],
    queryFn: () => call<WorkloadData>('GET', `/boards/${boardId}/workload?today=${today}`),
    gcTime: 60_000,
    placeholderData: previous => previous,
  });
  const data = query.data;

  if (query.isError && !data) {
    return (
      <div className="lf-wl">
        <Notice tone="danger" action={<Button size="sm" variant="secondary" pending={query.isFetching} pendingLabel={t('common.loading')} onClick={() => void query.refetch()}>{t('common.retry')}</Button>}>
          {t('views.wl.error')}
        </Notice>
      </div>
    );
  }
  if (!data) return <p className="lf-vw-note" role="status">{t('common.loading')}</p>;

  const max = maxOpen(data);
  const empty = data.people.length === 0 && !data.unassigned;
  return (
    <div className="lf-wl" aria-busy={query.isFetching}>
      {query.isError && <Notice tone="warning">{t('views.wl.error')}</Notice>}
      {empty ? (
        <p className="lf-vw-note">{t('views.wl.empty')}</p>
      ) : (
        <section className="lf-wl-card" aria-label={t('views.wl.label')}>
          <table className="lf-wl-table">
            <caption>{t('views.wl.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('views.wl.person')}</th>
                <th scope="col">{t('views.wl.load')}</th>
                <th scope="col" className="lf-wl-num">{t('views.wl.open')}</th>
                <th scope="col" className="lf-wl-num">{t('views.wl.overdue')}</th>
                <th scope="col" className="lf-wl-num lf-wl-hide-sm">{t('views.wl.dueSoon')}</th>
                <th scope="col" className="lf-wl-num lf-wl-hide-sm">{t('views.wl.estimate')}</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map(p => (
                <WorkRow key={p.id} name={p.name} row={p} lanes={data.lanes} max={max} onShow={() => onShowPerson(p.id)} />
              ))}
              {data.unassigned && <WorkRow key="none" name={t('views.wl.unassigned')} row={data.unassigned} lanes={data.lanes} max={max} />}
            </tbody>
          </table>
          <div className="lf-wl-legend" aria-hidden="true">
            <span><i className="lf-wl-key is-bad" />{t('views.wl.overdue')}</span>
            <span><i className="lf-wl-key is-rest" />{t('views.wl.onTrack')}</span>
          </div>
        </section>
      )}
      {data.truncated && <p className="lf-vw-note">{t('views.wl.truncated', {count: data.people.length})}</p>}
    </div>
  );
}

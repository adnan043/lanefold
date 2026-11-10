import {useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';
import {useEffect, useRef, useState, type ChangeEvent} from 'react';

import {useI18n, useT, type MessageKey} from '../../i18n';
import {
  chunkCards,
  IMPORT_LIMITS,
  parseTrelloExport,
  type ImportPlan,
  type ImportSummary,
  type ImportWarning,
} from '../../lib/trello-import';
import {Button, Card, DataTable, EmptyState, Field, LoadingBlock, Notice, PageHeader, ProgressBar, useToast} from '../../portal/ui';
import {ApiError, call} from '../api';
import {dryRunMatches} from './import-binding';
import {useWriteCooldown} from '../write-cooldown';
import {useWorkspace} from '../workspace';
import {SettingsNav} from './nav';

type DryRun = {canImport: boolean; problems: {code: string; limit?: number; value?: number}[]};
type Loaded = {workspaceId: number; fileName: string; plan: ImportPlan; summary: ImportSummary; warnings: ImportWarning[]; dry: DryRun; importId: string};
type Stage = 'idle' | 'checking' | 'ready' | 'importing' | 'failed' | 'done';
type Row = {key: string; label: string; count: number};

const newImportId = () => crypto.randomUUID();
/** A failed chunk is tried again this many times (same payload: the server skips what it already has). */
const RETRIES = 2;

/**
 * Settings > Import and export. The file is read and checked IN THE BROWSER (`parseTrelloExport`), the server answers a dry run
 * (plan caps, rights; it writes nothing), then the board is created and its cards go in small batches. Every request is
 * idempotent under one `importId`, so "Retry import" after a failure never duplicates anything.
 */
export function ImportExport() {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {current, pending} = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [fileError, setFileError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState({done: 0, total: 0, starting: false});
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<{boardId: number; cards: number} | null>(null);
  // The board made by this import, kept so a retry resumes it (the server also remembers it by `importId`).
  const boardOf = useRef<{id: number; lanes: Record<string, number>} | null>(null);

  const canImport = current?.role === 'owner' || current?.role === 'admin' || current?.role === 'member';
  const cooldown = useWriteCooldown();
  // The dry run belongs to the workspace it was run for: another workspace starts over (the file is picked again).
  const stale = loaded !== null && !dryRunMatches(loaded, current?.id) && stage !== 'importing' && stage !== 'checking';
  useEffect(() => {
    if (!stale) return;
    setLoaded(null);
    setResult(null);
    setFailure(null);
    boardOf.current = null;
    setStage('idle');
  }, [stale]);
  const busy = stage === 'checking' || stage === 'importing';

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !current) return;
    setFileError(null);
    setFailure(null);
    setResult(null);
    setLoaded(null);
    boardOf.current = null;
    if (file.size > IMPORT_LIMITS.fileBytes) {
      setFileError(t('importExport.file.tooBig'));
      setStage('idle');
      return;
    }
    setStage('checking');
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch (error) {
      setFileError(t(error instanceof SyntaxError ? 'importExport.file.notJson' : 'importExport.file.unreadable'));
      setStage('idle');
      return;
    }
    const parsed = parseTrelloExport(json);
    if (!parsed.ok) {
      setFileError(t(parsed.error === 'empty' ? 'importExport.file.empty' : 'importExport.file.notTrello'));
      setStage('idle');
      return;
    }
    try {
      const s = parsed.summary;
      const dry = await call<DryRun>('POST', `/workspaces/${current.id}/import/trello/dry-run`, {
        lanes: s.lanes,
        labels: s.labels,
        cards: s.cards,
        maxLaneCards: s.maxLaneCards,
        checklists: s.checklists,
        comments: s.comments,
      });
      setLoaded({workspaceId: current.id, fileName: file.name, plan: parsed.plan, summary: s, warnings: parsed.warnings, dry, importId: newImportId()});
      setStage('ready');
    } catch (error) {
      setFileError(errorMessage(error));
      setStage('idle');
    }
  };

  /** One request, tried again on a network error or a 5xx (idempotent: the same body is safe to send twice). */
  const send = async <T,>(path: string, body: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call<T>('POST', path, body);
      } catch (error) {
        const transient = error instanceof ApiError && (error.status === 0 || error.status >= 500);
        if (!transient || attempt >= RETRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  };

  const run = async () => {
    if (!loaded || !current || stage === 'importing' || !dryRunMatches(loaded, current.id)) return;
    const {plan, importId} = loaded;
    const chunks = chunkCards(plan.cards);
    setStage('importing');
    setFailure(null);
    setProgress(p => ({done: p.done, total: plan.cards.length, starting: boardOf.current === null}));
    try {
      if (!boardOf.current) {
        const started = await send<{board: {id: number}; lanes: Record<string, number>}>(`/workspaces/${current.id}/import/trello/start`, {
          importId,
          name: plan.board.name,
          lanes: plan.lanes,
          labels: plan.labels,
          totalCards: plan.cards.length,
        });
        boardOf.current = {id: started.board.id, lanes: started.lanes};
      }
      const boardId = boardOf.current.id;
      // Always from the first chunk: the ones already imported answer "skipped" (cheap), so a retry needs no bookkeeping.
      let done = 0;
      setProgress({done: 0, total: plan.cards.length, starting: false});
      for (const chunk of chunks) {
        await send(`/boards/${boardId}/import/trello/cards`, {importId, cards: chunk});
        done += chunk.length;
        setProgress({done, total: plan.cards.length, starting: false});
      }
      setResult({boardId, cards: plan.cards.length});
      setStage('done');
      void queryClient.invalidateQueries({queryKey: ['boards']});
      toast.success(t('importExport.done.toast', {count: plan.cards.length}));
    } catch (error) {
      cooldown.note(error);
      setFailure(errorMessage(error));
      setStage('failed');
    }
  };

  const rows: Row[] = loaded
    ? [
        {key: 'lanes', label: t('importExport.preview.lanes'), count: loaded.summary.lanes},
        {key: 'cards', label: t('importExport.preview.cards'), count: loaded.summary.cards},
        {key: 'labels', label: t('importExport.preview.labels'), count: loaded.summary.labels},
        {key: 'checklists', label: t('importExport.preview.checklists'), count: loaded.summary.checklists},
        {key: 'items', label: t('importExport.preview.checklistItems'), count: loaded.summary.checklistItems},
        {key: 'comments', label: t('importExport.preview.comments'), count: loaded.summary.comments},
        {key: 'links', label: t('importExport.preview.links'), count: loaded.summary.links},
      ]
    : [];

  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('importExport.title')} description={t('importExport.description')} />
      {pending ? (
        <LoadingBlock rows={3} />
      ) : !current ? (
        <EmptyState icon="layers" title={t('importExport.noWorkspace')} />
      ) : !canImport ? (
        <Notice tone="info">{t('importExport.viewerOnly')}</Notice>
      ) : (
        <Card title={t('importExport.card.title')} description={t('importExport.card.description')}>
          <div className="lf-form">
            <Field id="f-trello-file" label={t('importExport.file.label')} hint={t('importExport.file.hint')} error={fileError ?? undefined}>
              <input
                ref={input}
                id="f-trello-file"
                type="file"
                accept="application/json,.json"
                disabled={busy}
                aria-invalid={fileError ? true : undefined}
                aria-describedby={fileError ? 'f-trello-file-error' : 'f-trello-file-hint'}
                onChange={e => void pick(e)}
              />
            </Field>
            {stage === 'checking' && <p className="muted" role="status">{t('importExport.file.checking')}</p>}

            {loaded && stage !== 'done' && (
              <>
                <h3>{t('importExport.preview.title')}</h3>
                <p>{t('importExport.preview.board', {name: loaded.summary.boardName})}</p>
                <DataTable<Row>
                  caption={t('importExport.preview.caption')}
                  rowKey={r => r.key}
                  rows={rows}
                  columns={[
                    {key: 'label', header: t('importExport.preview.item'), cell: r => r.label},
                    {key: 'count', header: t('importExport.preview.count'), cell: r => r.count, align: 'end', width: 'shrink'},
                  ]}
                />
                {loaded.dry.problems.map(p => (
                  <Notice key={p.code} tone="danger">
                    {t(`importExport.problem.${p.code}` as MessageKey, {limit: p.limit ?? 0, value: p.value ?? 0})}
                  </Notice>
                ))}
                {loaded.warnings.length > 0 && (
                  <Notice tone="warning" title={t('importExport.warnings.title')}>
                    <ul>
                      {loaded.warnings.map(w => (
                        <li key={w.code}>{t(`importExport.warn.${w.code}`, {count: w.count})}</li>
                      ))}
                    </ul>
                  </Notice>
                )}
                {loaded.summary.comments > 0 && <p className="muted">{t('importExport.comments.note')}</p>}
              </>
            )}

            {stage === 'importing' && (
              <div role="status" aria-live="polite">
                <ProgressBar label={t('importExport.progress.label')} value={progress.done} max={Math.max(1, progress.total)} />
                <p className="muted">
                  {progress.starting ? t('importExport.progress.starting') : t('importExport.progress.text', {done: progress.done, total: progress.total})}
                </p>
              </div>
            )}

            {stage === 'failed' && failure && (
              <p className="field-error" role="alert">
                {t('importExport.failed', {message: failure})}
              </p>
            )}

            {stage === 'done' && result && (
              <Notice tone="success" title={t('importExport.done.title')}>
                <p>{t('importExport.done.body', {count: result.cards})}</p>
                <Link to="/b/$boardId" params={{boardId: String(result.boardId)}}>
                  {t('importExport.done.open')}
                </Link>
              </Notice>
            )}

            <div className="lf-form-actions">
              {(stage === 'ready' || stage === 'importing' || stage === 'failed') && loaded && (
                <Button
                  variant="primary"
                  pending={stage === 'importing'}
                  pendingLabel={t('importExport.button.importing')}
                  disabled={!loaded.dry.canImport || !dryRunMatches(loaded, current.id) || cooldown.blocked}
                  onClick={() => void run()}>
                  {stage === 'failed' ? t('importExport.button.retry') : t('importExport.button.import')}
                </Button>
              )}
              {(stage === 'ready' || stage === 'failed' || stage === 'done') && (
                <Button type="button" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                  {t('importExport.button.choose')}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

import {copyCardLink} from './card-link';
import {useQuery} from '@tanstack/react-query';
import {useParams} from '@tanstack/react-router';
import {useNavigate} from '../nav';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';

import {useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, EmptyState, ErrorNote, Icon, IconButton, LoadingBlock, Menu, Notice, useToast} from '../../portal/ui';
import {EditorToolbar} from './editor-toolbar';
import {ApiError} from '../api';
import {useBoardActions} from '../boards/actions';
import {clearQuickAction, peekQuickAction, QUICK_TARGET_SELECTOR} from '../boards/quick-action';
import {Attachments} from './attachments';
import {Checklists} from './checklists';
import {CustomFields} from './fields';
import {RecurrenceSection} from '../recurrence/recurrence-section';
import {ActivityLog, Comments} from './comments';
import {MdView} from './description';
import {MovePopover} from './move-popover';
import {SaveTemplateDialog} from '../templates/save-template-dialog';
import {Section, useAction} from './parts';
import {CardBar} from './card-bar';
import {type CardActions, cardDetailQuery, type DetailT, useCardActions} from './use-card';
import {useDraft, usePeekDraft} from '../use-draft';
import './cards.css';
import './a11y.css';
import './trello-card.css';

/** The title: one input that saves on Enter or blur when it changed and is valid. */
function TitleField({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const t = useT();
  const {run} = useAction();
  const [value, setValue] = useState(detail.card.title);
  const [error, setError] = useState('');
  // A half-typed title is never replaced by a refresh: the server's value is taken again once the field is left.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setValue(detail.card.title);
  }, [detail.card.title]);
  // After the sync effect, so a kept half-typed title wins on mount; clears itself once the value equals the saved title.
  useDraft('title', detail.card.id, value, setValue, detail.card.title, detail.canWrite);
  const save = async () => {
    const title = value.trim();
    if (title === detail.card.title) return setError('');
    const problem = rules.required(t('card.titleRequired'))(title) ?? rules.maxLength(200, t('card.titleTooLong'))(title);
    if (problem) return setError(problem);
    setError('');
    if (!(await run('title', () => actions.patchDetails({title})))) setValue(detail.card.title);
  };
  // The textarea grows with the title so the whole of a long title shows (set through the CSSOM, CSP-safe).
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // A wider or narrower dialog re-wraps the title: fit the height again.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="cd-title">
      <label className="sr-only" htmlFor="cd-title-input">
        {t('card.title')}
      </label>
      <textarea
        ref={box}
        id="cd-title-input"
        dir="auto"
        rows={1}
        placeholder={t('card.addPlaceholder')}
        value={value}
        readOnly={!detail.canWrite}
        maxLength={400}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'cd-title-error' : undefined}
        onChange={event => {
          // A title is one line: a pasted line break becomes a space.
          setValue(event.target.value.replace(/[\r\n]+/g, ' '));
          if (error) setError('');
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          void save();
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <p id="cd-title-error" className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Description({detail, actions}: {detail: DetailT; actions: CardActions}) {
  const t = useT();
  const {busy, run, blocked} = useAction();
  const text = detail.card.descriptionMd;
  const kept = usePeekDraft('desc', detail.card.id);
  const [editing, setEditing] = useState(kept);
  const [draft, setDraft] = useState(kept ? text : '');
  const [error, setError] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const clearDraft = useDraft('desc', detail.card.id, draft, setDraft, text, editing);
  const startEditing = () => {
    setDraft(text);
    setError('');
    setEditing(true);
  };
  const save = async () => {
    if (draft.length > 20000) return setError(t('cd.descriptionTooLong'));
    if (await run('desc', () => actions.patchDetails({descriptionMd: draft}))) {
      clearDraft();
      setEditing(false);
    }
  };
  return (
    <Section
      id="cd-description"
      icon="menu"
      title={t('cd.description')}
      actions={
        // No description yet: the one-line box below is the way in, so no Edit button.
        detail.canWrite && !editing && text ? (
          <Button size="sm" variant="secondary" onClick={startEditing}>
            {t('cd.edit')}
          </Button>
        ) : undefined
      }>
      {editing ? (
        <form
          className="cd-composer"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}>
          {/* The same framed editor as a comment: the formatting bar, then the text. */}
          <div className="cd-editor">
          <EditorToolbar area={area} text={draft} setText={setDraft} disabled={busy === 'desc'} />
          <textarea
            ref={area}
            dir="auto"
            value={draft}
            rows={8}
            aria-label={t('cd.description')}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'cd-desc-error' : undefined}
            placeholder={t('cd.descriptionPlaceholder')}
            autoFocus
            disabled={busy === 'desc'}
            onChange={event => {
              setDraft(event.target.value);
              if (error) setError('');
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                event.preventDefault(); // the modal's native Esc must not also fire
                clearDraft();
                setEditing(false);
              }
            }}
          />
          </div>
          {error && (
            <p id="cd-desc-error" className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="cd-composer-actions">
            <span className="cd-spacer" />
            <Button size="sm" variant="secondary" disabled={busy === 'desc'} onClick={() => {
                clearDraft();
                setEditing(false);
              }}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" pending={busy === 'desc'} pendingLabel={t('common.saving')} disabled={blocked || draft === text}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      ) : text && detail.canWrite ? (
        // Like Trello: a click on the text opens the editor (keyboard users have the Edit button). A click on a link
        // follows the link, and a drag that selects text does not open it.
        <div
          className="cd-desc-view"
          onClick={event => {
            if ((event.target as HTMLElement).closest('a')) return;
            if (window.getSelection()?.toString()) return;
            startEditing();
          }}>
          <MdView source={text} />
        </div>
      ) : text ? (
        <MdView source={text} />
      ) : detail.canWrite ? (
        // Like the comment box: a one-line box first, a click (or Enter) opens the editor.
        <button type="button" className="cd-comment-fake cd-desc-fake" aria-label={t('cd.description')} onClick={startEditing}>
          {t('cd.descriptionPlaceholder')}
        </button>
      ) : (
        <p className="cd-none">{t('cd.descriptionEmpty')}</p>
      )}
    </Section>
  );
}

/** The top bar: the cover (if any) behind the lane chip (opens "Move card") and the close button, like Trello. */
function TopBar({detail, actions, boardActions, boardId, cardId, close}: {detail: DetailT | undefined; actions: CardActions; boardActions: ReturnType<typeof useBoardActions>; boardId: number; cardId: number; close: () => void}) {
  const t = useT();
  const toast = useToast();
  const {busy, run} = useAction();
  const [savingTemplate, setSavingTemplate] = useState(false);
  const cover = detail?.attachments.find(a => a.id === detail.card.coverAttachmentId);
  return (
    <div className="cd-top" data-cover={cover ? '' : undefined}>
      {cover && <img className="cd-top-img" src={`/site-api/attachments/${cover.id}/view`} alt="" loading="lazy" decoding="async" />}
      <div className="cd-top-bar">
        <MovePopover boardId={boardId} cardId={cardId} canWrite={detail?.canWrite ?? false} actions={boardActions} />
        {detail?.card.number != null && (
          <span className="cd-card-num" title={t('card.numberTitle', {number: detail.card.number})}>
            #{detail.card.number}
          </span>
        )}
        <span className="cd-spacer" />
        <IconButton
          icon="link"
          label={t('card.copyLink')}
          onClick={() =>
            void copyCardLink(boardId, cardId).then(ok => {
              if (ok) toast.success(t('card.linkCopied'));
              else toast.danger(t('card.linkCopyFailed'));
            })
          }
        />
        {detail && (
          <IconButton
            icon="eye"
            label={t(detail.watching ? 'cd.watching' : 'cd.watch')}
            aria-pressed={detail.watching}
            disabled={busy === 'watch'}
            onClick={() =>
              void run('watch', async () => {
                const on = await actions.setWatching(!detail.watching);
                toast.success(t(on ? 'cd.watchOn' : 'cd.watchOff'));
              })
            }
          />
        )}
        {cover && detail?.canWrite && (
          <IconButton icon="image" label={t('cd.coverRemove')} disabled={busy === 'cover'} onClick={() => void run('cover', () => actions.setCover(null))} />
        )}
        {detail?.canWrite && (
          <Menu
            label={t('card.menu', {title: detail.card.title})}
            items={[
              {label: t('card.moveTitle'), icon: 'arrow-right', onSelect: () => document.querySelector<HTMLElement>('.cd-lane-chip')?.click()},
              {
                label: t('card.copy'),
                icon: 'copy',
                onSelect: () => void run('copy', async () => {
                  await actions.copyCard();
                  toast.success(t('card.copiedToast'));
                }),
              },
              {label: t('ctpl.save'), icon: 'copy', onSelect: () => setSavingTemplate(true)},
              'separator',
              {
                label: t('card.archive'),
                icon: 'archive',
                onSelect: () => {
                  const undo = boardActions.archiveCard(cardId);
                  // The board's Undo bar is not mounted for this panel's actions: say it in a toast with Undo.
                  if (undo) toast.success(t('card.archivedToast'), {action: {label: t('card.undo'), onSelect: undo.run}});
                  close();
                },
              },
            ]}
          />
        )}
        <IconButton icon="x" label={t('cd.close')} className="cd-close" onClick={close} />
      </div>
      {detail && <SaveTemplateDialog open={savingTemplate} cardId={cardId} defaultName={detail.card.title} onClose={() => setSavingTemplate(false)} />}
    </div>
  );
}

/**
 * The card modal: `/app/b/$boardId/c/$cardId`, rendered by the board screen's `<Outlet />` (so a deep link and the browser's
 * back button work). A native `<dialog>` opened with `showModal()`: top layer, inert board behind a dimmed scrim, focus trap
 * and `role="dialog"` + `aria-modal` for free. Esc, the Close button and a click on the scrim go back to the board; the
 * body scrolls inside the modal; a full-screen sheet on phones (cards.css).
 * Anything that opens from inside (menus, toasts, the undo bar) lives in this dialog while it is open: `portal-host.ts`.
 */
export function CardPanel() {
  const {cardId} = useParams({strict: false}) as {cardId: string};
  // Keyed by card: drafts, the opener and bound actions never carry over to another card.
  return <CardPanelFor key={cardId} />;
}

function CardPanelFor() {
  const t = useT();
  const navigate = useNavigate();
  const {boardId: rawBoard, cardId: rawCard} = useParams({strict: false}) as {boardId: string; cardId: string};
  const boardId = Number(rawBoard);
  const cardId = Number(rawCard);
  const query = useQuery(cardDetailQuery(cardId));
  const actions = useCardActions(boardId, cardId);
  const boardActions = useBoardActions(boardId);
  const dialog = useRef<HTMLDialogElement>(null);
  const intake = useRef<((files: File[]) => void) | null>(null);
  // Where the last pointer went down: a click that ENDS on the scrim only closes when it also STARTED there
  // (a text selection dragged out of the modal must not close it).
  const downOnScrim = useRef(false);
  const [dropping, setDropping] = useState(false);
  const [showActivity, setShowActivity] = useState(true);
  // Set by a click on the complete button only, so its pop plays when toggled, not when a done card opens.
  const [donePop, setDonePop] = useState<number | null>(null);
  const close = () => void navigate({to: '/b/$boardId', params: {boardId: String(boardId)}});
  const closeRef = useRef(close);
  closeRef.current = close;
  // The element that opened the modal (the card's title button or its menu): focus goes back to it on close,
  // however the modal closes (Esc, Close, the scrim, the browser's back button).
  const opener = useRef<HTMLElement | null>(null);
  if (opener.current === null && typeof document !== 'undefined') {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) opener.current = active;
  }
  const {busy, run} = useAction();

  // Opened from a card's quick actions (the pencil on the board): once the card has loaded, press the matching control
  // (labels / members picker, due date) or scroll to the attachments (cover), like the "+ Add" popover does.
  const loaded = query.data !== undefined;
  const writable = query.data?.canWrite === true;
  useEffect(() => {
    if (!loaded) return;
    const target = peekQuickAction(cardId);
    if (!target) return;
    const timer = window.setTimeout(() => {
      clearQuickAction();
      if (!writable) return;
      const {selector, press} = QUICK_TARGET_SELECTOR[target];
      const el = document.querySelector<HTMLElement>(`.cd-panel ${selector}`);
      if (!el) return;
      el.scrollIntoView({block: press ? 'nearest' : 'start'});
      if (press) el.click();
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [loaded, writable, cardId]);

  // Open as a modal before paint; focus lands on the dialog itself (the shell skips its heading focus: `keepFocus`).
  // The page behind cannot scroll while it is open.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (!el.open) el.showModal();
    el.focus({preventScroll: true});
    document.documentElement.classList.add('cd-locked');
    const cancel = (event: Event) => {
      // Reached only for a close request no keydown handler claimed (e.g. a platform "back" gesture).
      event.preventDefault();
      closeRef.current();
    };
    el.addEventListener('cancel', cancel);
    return () => {
      el.removeEventListener('cancel', cancel);
      document.documentElement.classList.remove('cd-locked');
    };
  }, []);

  useEffect(
    () => () => {
      const target = opener.current;
      const card = cardId;
      // The shell leaves focus alone when the modal closes: hand it back to the opener, else to the card.
      const back = target?.isConnected ? target : document.querySelector<HTMLElement>(`.lf-card[data-card-id="${card}"] .lf-card-title`) ?? document.querySelector<HTMLElement>(`.lf-card[data-card-id="${card}"]`);
      back?.focus({preventScroll: true});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const data = query.data;
  const gone = query.error instanceof ApiError && query.error.status === 404;
  return (
    <dialog
      ref={dialog}
      className="cd-dialog"
      aria-labelledby="cd-dialog-title"
      tabIndex={-1}
      onPointerDown={event => {
        downOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={event => {
        if (event.target === event.currentTarget && downOnScrim.current) close();
        downOnScrim.current = false;
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        const target = event.target as HTMLElement;
        // A nested dialog (image preview, confirmation) closes itself.
        if (target.closest('dialog') !== event.currentTarget) return;
        // Claim the key so the browser's own close does not also run. A menu or picker that is open closes itself
        // first (and a field with its own Esc already handled it); only a bare Esc closes the modal.
        const handled = event.defaultPrevented || target.closest('[role="menu"], .popover') !== null;
        event.preventDefault();
        if (!handled) close();
      }}
      onDragOver={event => {
        if (data?.canWrite && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={event => {
        setDropping(false);
        const files = [...event.dataTransfer.files];
        if (files.length) {
          event.preventDefault();
          intake.current?.(files);
        }
      }}
      onPaste={event => {
        const files = [...event.clipboardData.files];
        if (files.length) {
          event.preventDefault();
          intake.current?.(files);
        }
      }}>
      <div className="cd-panel" data-dropping={dropping ? '' : undefined}>
        <h2 id="cd-dialog-title" className="sr-only">
          {data?.card.title ?? t('cd.panel')}
        </h2>
        <TopBar detail={data} actions={actions} boardActions={boardActions} boardId={boardId} cardId={cardId} close={close} />
        <div className="cd-scroll">
          {query.isPending && <LoadingBlock rows={5} />}
          {gone && (
            <EmptyState
              icon="lock"
              title={t('cd.gone')}
              action={
                <Button variant="secondary" onClick={close}>
                  {t('cd.close')}
                </Button>
              }>
              {t('cd.goneBody')}
            </EmptyState>
          )}
          {query.error && !gone && <ErrorNote error={query.error} title={t('states.loadError')} />}
          {data && (
            <>
              {!data.canWrite && <Notice tone="info">{t('cd.readOnly')}</Notice>}
              {data.card.archived && <Notice tone="warning">{t('cd.archived')}</Notice>}
              <div className="cd-grid">
                <div className="cd-main">
                  <div className="cd-head">
                    {/* Trello's round "mark complete" button in front of the title. */}
                    <button
                      type="button"
                      role="checkbox"
                      className={donePop === data.card.id ? 'cd-done is-pop' : 'cd-done'}
                      aria-checked={data.card.completed}
                      aria-label={t(data.card.completed ? 'cd.markIncomplete' : 'cd.markComplete')}
                      title={t(data.card.completed ? 'cd.markIncomplete' : 'cd.markComplete')}
                      disabled={!data.canWrite || busy === 'done'}
                      onClick={() => {
                        setDonePop(data.card.id);
                        void run('done', () => actions.patchDetails({completed: !data.card.completed}));
                      }}>
                      <Icon key={data.card.completed ? 'on' : 'off'} name={data.card.completed ? 'check-circle' : 'circle'} size={20} />
                    </button>
                    <TitleField detail={data} actions={actions} />
                  </div>
                  <CardBar detail={data} actions={actions} />
                  <Description detail={data} actions={actions} />
                  <CustomFields detail={data} actions={actions} />
                  <Checklists detail={data} actions={actions} />
                  {/* Set from the Dates popover; shown here only once a card repeats (its details, edit and stop). */}
                  <RecurrenceSection cardId={data.card.id} canWrite={data.canWrite} hideEmpty />
                </div>
                <div className="cd-side">
                  <div className="cd-section-head">
                    <Icon name="message" size={18} />
                    <h3>{t('cd.comments')} · {t('cd.activity')}</h3>
                    <span className="cd-spacer" />
                    <Button size="sm" variant="secondary" aria-expanded={showActivity} aria-controls="cd-activity" onClick={() => setShowActivity(v => !v)}>
                      {showActivity ? t('cd.activityHide') : t('cd.activityShow')}
                    </Button>
                  </div>
                  <Comments detail={data} actions={actions}>
                    <Attachments detail={data} actions={actions} intake={intake} />
                  </Comments>
                  <ActivityLog cardId={cardId} open={showActivity} />
                </div>
              </div>
            </>
          )}
        </div>
        {dropping && (
          <div className="cd-drop" aria-hidden="true">
            <Icon name="paperclip" size={28} />
            <span>{t('cd.dropHint')}</span>
          </div>
        )}
      </div>
    </dialog>
  );
}

export type {DetailT};

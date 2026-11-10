import {useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '../nav';
import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, Drawer, Field, Icon, RadioCards, useConfirm, useForm, useToast} from '../../portal/ui';
import {ColorPicker} from '../../portal/ui/popover';
import {type ApiError, type BoardT, call, type LaneT} from '../api';
import {useDraft} from '../use-draft';
import {type BoardActions} from './actions';
import {FlowsSection} from '../flows/flows-panel';
import {ShareLink} from './share-link';
import {StaleSetting} from './stale-setting';
import {planWipSaves} from './wip-plan';
import {backgroundStyle, safeImageUrl} from './background';
import './settings.css';

/** Solid colours and gradients offered as presets; the server stores them as plain `#rrggbb` + angle. */
const SOLIDS = ['#F4F4F5', '#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#E0E7FF', '#334155', '#1E3A5F'] as const;
const GRADIENTS = [
  {id: 'dusk', a: '#6366F1', b: '#EC4899'},
  {id: 'ocean', a: '#0EA5E9', b: '#1E3A8A'},
  {id: 'forest', a: '#22C55E', b: '#0F766E'},
  {id: 'sunset', a: '#F59E0B', b: '#EF4444'},
  {id: 'graphite', a: '#64748B', b: '#0F172A'},
] as const;

type Bg = {kind: 'color' | 'gradient' | 'image'; c1: string; c2: string; angle: number};

/** Photo types and size the server takes (`src/server/bg-image.ts`): checked here first, before any upload. */
const PHOTO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const bgOf = (board: BoardT): Bg => ({
  kind: board.bgKind === 'image' && safeImageUrl(board.bgImage) ? 'image' : board.bgKind === 'gradient' ? 'gradient' : 'color',
  c1: board.bgColor1,
  c2: board.bgColor2,
  angle: board.bgAngle,
});

const styleOf = (bg: Bg, image?: string | null) => ({bgKind: bg.kind, bgColor1: bg.c1, bgColor2: bg.c2, bgAngle: bg.angle, bgImage: image});

function Swatch({bg, image, label, selected, onPick, disabled}: {bg: Bg; image?: string | null; label: string; selected: boolean; onPick: () => void; disabled?: boolean}) {
  return (
    <button
      type="button"
      className="lf-swatch"
      aria-label={label}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      ref={node => backgroundStyle(node, styleOf(bg, image))}
    />
  );
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Board settings in a right drawer: name, visibility, background, card limit per lane, duplicate, archive. */
export function BoardSettingsDrawer({
  board,
  lanes,
  actions,
  open,
  onClose,
  onArchive,
}: {
  board: BoardT;
  lanes: LaneT[];
  actions: BoardActions;
  open: boolean;
  onClose: () => void;
  onArchive: () => void;
}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm({name: board.name}, {name: [rules.required(t('boards.nameRequired')), rules.maxLength(80, t('boards.nameTooLong'))]});
  const [visibility, setVisibility] = useState<'private' | 'workspace'>(board.visibility === 'private' ? 'private' : 'workspace');
  // Only a visibility the user picked is sent: a board with another value (public) is never silently changed.
  const [visTouched, setVisTouched] = useState(false);
  const [bg, setBg] = useState<Bg>(() => bgOf(board));
  // Which half of the background picker is open: the photo or the colours; opens on what the board uses now.
  const [bgTab, setBgTab] = useState<'photos' | 'colors'>(() => (bgOf(board).kind === 'image' ? 'photos' : 'colors'));
  const photo = safeImageUrl(board.bgImage);
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [wip, setWip] = useState<Record<number, string>>({});
  const [wipErrors, setWipErrors] = useState<Record<number, string>>({});
  const [pending, setPending] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [status, setStatus] = useState('');
  const shown = lanes.filter(lane => !lane.archived);

  useEffect(() => {
    if (!open) return;
    form.reset({name: board.name});
    setVisibility(board.visibility === 'private' ? 'private' : 'workspace');
    setVisTouched(false);
    setBg(bgOf(board));
    setBgTab(bgOf(board).kind === 'image' ? 'photos' : 'colors');
    setPhotoError('');
    setWip(Object.fromEntries(shown.map(lane => [lane.id, lane.wipLimit === null ? '' : String(lane.wipLimit)])));
    setWipErrors({});
    setStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const busy = pending || duplicating || uploading;
  // The board name survives a forced sign-in; switched on only once the form holds this board's values.
  const [syncedOpen, setSyncedOpen] = useState(false);
  useEffect(() => setSyncedOpen(open), [open]);
  const clearNameDraft = useDraft('board', board.id, form.values.name, text => form.set('name', text), board.name, open && syncedOpen);
  const close = () => {
    clearNameDraft();
    onClose();
  };

  const save = form.submit(async values => {
    const errors: Record<number, string> = {};
    for (const lane of shown) {
      const raw = (wip[lane.id] ?? '').trim();
      if (raw && !/^\d{1,3}$/.test(raw)) errors[lane.id] = t('lane.wipInvalid');
      else if (raw && (Number(raw) < 1 || Number(raw) > 999)) errors[lane.id] = t('lane.wipInvalid');
    }
    setWipErrors(errors);
    if (Object.keys(errors).length) return;
    setPending(true);
    setStatus('');
    try {
      await actions.updateBoard({
        name: values.name.trim(),
        ...(visTouched ? {visibility} : {}),
        // The photo keeps the colours as they are (they show while it loads).
        ...(bg.kind === 'image' ? {bgKind: 'image'} : {bgKind: bg.kind, bgColor1: bg.c1, bgColor2: bg.kind === 'gradient' ? bg.c2 : bg.c1, bgAngle: bg.angle}),
      });
      // Only lanes that were there when the drawer opened (`wip` has them) and are saved (not temporary);
      // a lane that appeared since keeps its limit. A failed lane gets its own error; the others still save.
      const failed: Record<number, string> = {};
      for (const {id, wipLimit} of planWipSaves(shown, wip)) {
        try {
          await actions.updateLane(id, {wipLimit});
        } catch (error) {
          failed[id] = errorMessage(error as ApiError);
        }
      }
      if (Object.keys(failed).length) {
        setWipErrors(failed);
        setStatus(t('bx.wip.partial'));
        return;
      }
      toast.success(t('boards.saved'));
      close();
    } catch (error) {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error) as never);
      setStatus(errorMessage(error as ApiError));
    } finally {
      setPending(false);
    }
  });

  const duplicate = async () => {
    setDuplicating(true);
    setStatus('');
    try {
      const copyName = t('bx.copyName', {name: board.name.slice(0, 70)}).slice(0, 80);
      const {board: copy} = await call<{board: {id: number}}>('POST', `/boards/${board.id}/duplicate`, {name: copyName});
      void queryClient.invalidateQueries({queryKey: ['boards']});
      toast.success(t('bx.duplicated'));
      onClose();
      void navigate({to: '/b/$boardId', params: {boardId: String(copy.id)}});
    } catch (error) {
      setStatus(errorMessage(error as ApiError));
    } finally {
      setDuplicating(false);
    }
  };

  const solidOn = (hex: string) => bg.kind === 'color' && sameHex(bg.c1, hex);

  /** Uploading saves at once (the photo becomes the background); the colours stay for later. */
  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoError('');
    if (!PHOTO_TYPES.has(file.type) || file.size < 1 || file.size > PHOTO_MAX_BYTES) {
      setPhotoError(t('errors.bg_image_invalid'));
      return;
    }
    setUploading(true);
    try {
      await actions.uploadBackground(file);
      setBg(prev => ({...prev, kind: 'image'}));
      toast.success(t('bx.bg.photoSet'));
    } catch (error) {
      setPhotoError(errorMessage(error as ApiError));
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = () =>
    void confirm({
      title: t('bx.bg.removeTitle'),
      body: t('bx.bg.removeBody'),
      confirmLabel: t('bx.bg.remove'),
      pendingLabel: t('bx.bg.removing'),
      action: async () => {
        await actions.removeBackground();
        setBg(prev => (prev.kind === 'image' ? {...prev, kind: 'color'} : prev));
      },
    });

  return (
    <Drawer
      open={open}
      onClose={close}
      dismissible={!busy}
      title={t('boards.settings')}
      description={t('bx.settingsHint')}
      onSubmit={save}
      footer={
        <>
          <Button variant="danger" className="lf-push-start" icon="archive" disabled={busy} onClick={onArchive}>
            {t('boards.archive')}
          </Button>
          <Button variant="secondary" icon="copy" disabled={pending} pending={duplicating} pendingLabel={t('bx.duplicating')} onClick={() => void duplicate()}>
            {t('bx.duplicate')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={duplicating || form.blocked} pending={pending} pendingLabel={t('common.saving')}>
            {t('common.save')}
          </Button>
        </>
      }>
      <div className="lf-form lf-settings">
        <Field id="f-name" label={t('boards.nameLabel')} error={form.error('name')}>
          <input {...form.field('name')} dir="auto" autoComplete="off" maxLength={200} placeholder={t('boards.namePlaceholder')} />
        </Field>
        <RadioCards
          legend={t('boards.visibility')}
          name="board-visibility"
          value={visibility}
          onChange={value => {
            setVisibility(value);
            setVisTouched(true);
          }}
          columns={1}
          options={[
            {value: 'workspace', title: t('boards.visibility.workspace'), description: t('boards.visibility.workspaceHint')},
            {value: 'private', title: t('boards.visibility.private'), description: t('boards.visibility.privateHint')},
          ]}
        />
        <fieldset className="lf-settings-group">
          <legend>{t('boards.background')}</legend>
          <div className="lf-swatch-preview" aria-hidden="true" ref={node => backgroundStyle(node, styleOf(bg, photo))} />
          <div className="lf-bg-kinds">
            <button type="button" className="lf-bg-kind" aria-pressed={bgTab === 'photos'} aria-controls="bs-bg-panel" onClick={() => setBgTab('photos')}>
              <span className="lf-bg-kind-art lf-bg-kind-photos" ref={node => {
                  if (photo) backgroundStyle(node, styleOf({...bg, kind: 'image'}, photo));
                  else if (node) node.style.background = '';
                }}>
                {!photo && <Icon name="image" size={28} />}
              </span>
              <span className="lf-bg-kind-label">{t('bx.bg.photos')}</span>
            </button>
            <button type="button" className="lf-bg-kind" aria-pressed={bgTab === 'colors'} aria-controls="bs-bg-panel" onClick={() => setBgTab('colors')}>
              <span className="lf-bg-kind-art lf-bg-kind-colors">
                {GRADIENTS.slice(0, 2).map(g => (
                  <span key={g.id} className="lf-bg-kind-bar" ref={node => backgroundStyle(node, {bgKind: 'gradient', bgColor1: g.a, bgColor2: g.b, bgAngle: 90})} />
                ))}
              </span>
              <span className="lf-bg-kind-label">{t('bx.bg.colors')}</span>
            </button>
          </div>
          <div id="bs-bg-panel" className="lf-bg-panel">
            {bgTab === 'photos' ? (
              <>
                <div className="lf-bg-photos">
                  {photo && (
                    <button
                      type="button"
                      className="lf-bg-photo"
                      aria-label={t('bx.bg.usePhoto')}
                      aria-pressed={bg.kind === 'image'}
                      disabled={uploading}
                      onClick={() => setBg(prev => ({...prev, kind: 'image'}))}
                      ref={node => backgroundStyle(node, styleOf({...bg, kind: 'image'}, photo))}>
                      {bg.kind === 'image' && (
                        <span className="lf-bg-check" aria-hidden="true">
                          <Icon name="check" size={14} />
                        </span>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="lf-bg-photo lf-bg-upload"
                    aria-describedby={photoError ? 'bs-photo-error' : 'bs-photo-hint'}
                    aria-busy={uploading || undefined}
                    disabled={pending || duplicating || uploading}
                    onClick={() => picker.current?.click()}>
                    {uploading ? <span className="spinner" aria-hidden="true" /> : <Icon name={photo ? 'refresh' : 'plus'} size={20} />}
                    <span>{uploading ? t('bx.bg.uploading') : photo ? t('bx.bg.replace') : t('bx.bg.upload')}</span>
                  </button>
                  <input
                    ref={picker}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                    hidden
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={event => {
                      void uploadPhoto(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </div>
                <p className="lf-settings-sub" id="bs-photo-hint">
                  {t('bx.bg.photoHint')}
                </p>
                {photoError && (
                  <p className="field-error" id="bs-photo-error" role="alert">
                    {photoError}
                  </p>
                )}
                {photo && (
                  <div>
                    <Button variant="danger" size="sm" icon="trash" disabled={busy} onClick={removePhoto}>
                      {t('bx.bg.remove')}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="lf-settings-sub">{t('bx.bg.solid')}</p>
                <div className="lf-swatch-row">
                  {SOLIDS.map(hex => (
                    <Swatch key={hex} bg={{kind: 'color', c1: hex, c2: hex, angle: 135}} label={hex} selected={solidOn(hex)} onPick={() => setBg({kind: 'color', c1: hex, c2: hex, angle: 135})} />
                  ))}
                </div>
                <p className="lf-settings-sub">{t('bx.bg.gradients')}</p>
                <div className="lf-swatch-row">
                  {GRADIENTS.map(g => (
                    <Swatch
                      key={g.id}
                      bg={{kind: 'gradient', c1: g.a, c2: g.b, angle: 135}}
                      label={t(`bx.grad.${g.id}` as 'bx.grad.dusk')}
                      selected={bg.kind === 'gradient' && sameHex(bg.c1, g.a) && sameHex(bg.c2, g.b)}
                      onPick={() => setBg({kind: 'gradient', c1: g.a, c2: g.b, angle: 135})}
                    />
                  ))}
                </div>
                <Field id="bs-custom" label={t('bx.bg.custom')}>
                  <ColorPicker id="bs-custom" value={bg.c1} onChange={hex => setBg({kind: 'color', c1: hex, c2: hex, angle: 135})} label={t('bx.bg.custom')} />
                </Field>
              </>
            )}
          </div>
        </fieldset>
        <fieldset className="lf-settings-group">
          <legend>{t('bx.wip.title')}</legend>
          <p className="lf-settings-sub">{t('lane.wipHint')}</p>
          {shown.length === 0 ? (
            <p className="lf-settings-sub">{t('bx.wip.noLanes')}</p>
          ) : (
            shown.map(lane => (
              <Field key={lane.id} id={`bs-wip-${lane.id}`} label={lane.name} error={wipErrors[lane.id]}>
                <input
                  id={`bs-wip-${lane.id}`}
                  aria-invalid={wipErrors[lane.id] ? true : undefined}
                  aria-describedby={wipErrors[lane.id] ? `bs-wip-${lane.id}-error` : undefined}
                  value={wip[lane.id] ?? ''}
                  onChange={event => setWip(prev => ({...prev, [lane.id]: event.target.value}))}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="5"
                  maxLength={3}
                />
              </Field>
            ))
          )}
        </fieldset>
        <ShareLink board={board} open={open} />
        <StaleSetting board={board} open={open} />
        <FlowsSection board={board} lanes={lanes} open={open} />
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </div>
    </Drawer>
  );
}

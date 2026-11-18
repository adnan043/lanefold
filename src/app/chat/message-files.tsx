import {useEffect, useState} from 'react';

import type {ChatFileT} from '../../lib/chat-files';
import {useI18n, useT} from '../../i18n';
import {Button, buttonClass, Icon, Modal} from '../../portal/ui';
import {bytesLabel} from '../cards/parts';
import {chatFileUrl} from './api';

/** Pictures shown in the message; past this, the last tile is covered with "+N" (the rest open in the viewer). */
const MAX_TILES = 4;

/**
 * The files sent with a message: pictures in a grid of at most two columns and four tiles that open in a viewer,
 * every other file as a row with its size and a download link. Every link goes through the server, which checks
 * access on each view.
 */
export function MessageFiles({files}: {files: readonly ChatFileT[]}) {
  const t = useT();
  const {formatNumber} = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  const images = files.filter(f => f.isImage);
  const others = files.filter(f => !f.isImage);
  const tiles = images.slice(0, MAX_TILES);
  // Pictures not on a tile: shown as "+N" over the last tile.
  const hidden = images.length - tiles.length;
  return (
    <div className="chat-files-block">
      {images.length > 0 && (
        <ul className="chat-file-images" data-count={Math.min(images.length, MAX_TILES)} aria-label={t('chat.messageFiles')}>
          {tiles.map((f, i) => {
            const more = hidden > 0 && i === tiles.length - 1;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  className="chat-file-image"
                  aria-label={more ? `${t('chat.openFile', {name: f.name})}, ${t('chat.morePictures', {n: hidden})}` : t('chat.openFile', {name: f.name})}
                  onClick={() => setOpen(i)}>
                  <img src={chatFileUrl(f.id)} alt="" loading="lazy" decoding="async" />
                  {more && (
                    <span className="chat-file-more" aria-hidden="true">
                      +{formatNumber(hidden)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="chat-files" aria-label={t('chat.messageFiles')}>
          {others.map(f => (
            <li key={f.id} className="chat-file">
              <Icon name="file" size={16} />
              <a className="chat-file-name" href={chatFileUrl(f.id)} target="_blank" rel="noopener noreferrer" title={f.name}>
                {f.name}
              </a>
              <span className="chat-file-size muted">{bytesLabel(f.size, formatNumber)}</span>
              <a className="button button-ghost button-sm icon-button" href={chatFileUrl(f.id, true)} aria-label={t('chat.downloadFile', {name: f.name})} title={t('chat.downloadFile', {name: f.name})}>
                <Icon name="download" size={16} />
              </a>
            </li>
          ))}
        </ul>
      )}
      <ImageViewer images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * A message's pictures, one at a time, in a rounded dialog. The round arrow buttons on either side (and the arrow
 * keys) slide to the previous or next picture; Esc or a click outside closes, and focus goes back to the tile that
 * opened it (the dialog's own behaviour).
 */
function ImageViewer({images, index, onIndex, onClose}: {images: readonly ChatFileT[]; index: number | null; onIndex: (i: number) => void; onClose: () => void}) {
  const t = useT();
  const {formatNumber} = useI18n();
  const current = index === null ? null : (images[index] ?? null);
  const many = images.length > 1;
  /** Which way the last move went: the new picture slides in from that side. */
  const [direction, setDirection] = useState<'next' | 'prev' | null>(null);
  const go = (step: 1 | -1) => {
    if (index === null) return;
    setDirection(step === 1 ? 'next' : 'prev');
    onIndex((index + step + images.length) % images.length);
  };
  useEffect(() => {
    if (index === null || !many) return;
    const onKey = (event: KeyboardEvent) => {
      // Arrows follow the reading direction: in RTL, Left is "next".
      const rtl = document.documentElement.dir === 'rtl';
      if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) go(1);
      else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // Opening the viewer does not slide; only moving inside it does.
  useEffect(() => {
    if (index === null) setDirection(null);
  }, [index]);
  return (
    <Modal
      open={current !== null}
      onClose={onClose}
      size="lg"
      title={current?.name ?? ''}
      footer={
        <>
          {many && index !== null && (
            <span className="chat-viewer-count muted" aria-live="polite">
              {formatNumber(index + 1)} / {formatNumber(images.length)}
            </span>
          )}
          {current && (
            <a className={buttonClass({variant: 'secondary'})} href={chatFileUrl(current.id, true)} rel="noopener noreferrer">
              <Icon name="download" size={16} /> {t('cd.download')}
            </a>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }>
      {current && (
        <div className="chat-viewer">
          {/* Keyed by picture: each one mounts fresh, so the slide-in plays on every move. */}
          <img key={current.id} src={chatFileUrl(current.id)} alt={current.name} decoding="async" data-slide={direction ?? undefined} />
          {many && (
            <>
              <button type="button" className="chat-viewer-arrow" data-side="prev" aria-label={t('cd.previous')} onClick={() => go(-1)}>
                <Icon name="chevron-left" size={22} />
              </button>
              <button type="button" className="chat-viewer-arrow" data-side="next" aria-label={t('cd.next')} onClick={() => go(1)}>
                <Icon name="chevron-right" size={22} />
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

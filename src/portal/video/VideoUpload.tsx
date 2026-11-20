import {useId, useRef, useState} from 'react';

import {siteFetch} from '../../platform/browser';
import {resumableUpload, uploadVideo, type Video, type VideoUploadGrant} from '../../platform/video-browser';
import {Button, Notice, ProgressBar} from '../ui';

/**
 * BROWSER: adds one video, for the owner's (or staff's) screens in the dashboard
 * (`docs/agent/video.md`, "Uploading"). Three steps, like every upload:
 *
 *   1. POST `startPath` {name, size, contentType, declaredSeconds?} → YOUR route checks who may
 *      add videos and this feature's limits, then createUpload() → the grant
 *   2. the bytes go straight from this browser to the video service (uploadVideo), with progress,
 *      retry after a dropped connection, resume after a reload (pick the same file again), cancel
 *   3. POST `confirmPath(id)` → YOUR route calls confirm() and keeps the video id in your table
 *
 * The portal page's frontmatter calls `await allowVideo(Astro.csp, Astro.url)`, or the browser
 * blocks step 2.
 */
export interface VideoUploadProps {
  /** Your route for step 1 (default `/site-api/videos/uploads`). */
  startPath?: string;
  /** Your route for step 3 (default `/site-api/videos/<id>/complete`). */
  confirmPath?: (videoId: string) => string;
  /** This feature's own limit, also checked by your route (default 2 GB). */
  maxBytes?: number;
  /** Types this feature takes, also checked by your route. */
  types?: readonly string[];
  /** Called with the confirmed video (usually `processing`). */
  onDone?: (video: Video) => void;
}

const DEFAULT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
const GB = 1024 ** 3;

const sizeText = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

/** The length, read from the file in this browser (so the upload holds only that much). */
function lengthOf(file: File): Promise<number | undefined> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    const done = (value?: number) => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(value);
    };
    const timer = setTimeout(() => done(), 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(el.duration) && el.duration > 0 ? Math.ceil(el.duration) : undefined);
    };
    el.onerror = () => {
      clearTimeout(timer);
      done();
    };
    el.src = url;
  });
}

type Step = 'pick' | 'uploading' | 'confirming' | 'done';

export function VideoUpload({
  startPath = '/site-api/videos/uploads',
  confirmPath = id => `/site-api/videos/${encodeURIComponent(id)}/complete`,
  maxBytes = 2 * GB,
  types = DEFAULT_TYPES,
  onDone,
}: VideoUploadProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>('pick');
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pick = (picked: File | null) => {
    setError(null);
    setSent(0);
    setStep('pick');
    if (!picked) return setFile(null);
    if (!types.includes(picked.type)) {
      setFile(null);
      return setError('Pick an MP4, MOV or WebM video.');
    }
    if (picked.size > maxBytes) {
      setFile(null);
      return setError(`Pick a video up to ${sizeText(maxBytes)}. This one is ${sizeText(picked.size)}.`);
    }
    setFile(picked);
  };

  const start = async () => {
    if (!file) return;
    setError(null);
    setStep('uploading');
    const controller = new AbortController();
    abort.current = controller;

    let grant: VideoUploadGrant | null = resumableUpload(file);
    if (!grant) {
      const declaredSeconds = await lengthOf(file);
      const res = await siteFetch(startPath, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({name: file.name, size: file.size, contentType: file.type, declaredSeconds}),
      }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as (VideoUploadGrant & {message?: string}) | null;
      if (!res?.ok || !body?.upload) {
        setStep('pick');
        return setError(body?.message ?? 'The upload didn’t start. Try again.');
      }
      grant = body;
    }

    const up = await uploadVideo(grant, file, {signal: controller.signal, onProgress: p => setSent(p.sentBytes)});
    abort.current = null;
    if (!up.ok) {
      setStep('pick');
      return setError(up.code === 'E_UPLOAD_CANCELED' ? null : up.message);
    }

    setStep('confirming');
    const done = await siteFetch(confirmPath(grant.video.id), {method: 'POST'}).catch(() => null);
    const body = (await done?.json().catch(() => null)) as {video?: Video; message?: string} | null;
    if (!done?.ok) {
      setStep('pick');
      return setError(body?.message ?? 'The video arrived, but couldn’t be confirmed. Try again.');
    }
    setStep('done');
    onDone?.(body?.video ?? {...grant.video, status: 'processing'});
  };

  const busy = step === 'uploading' || step === 'confirming';
  return (
    <div className="form-stack">
      <div className="field" data-invalid={error ? '' : undefined}>
        <label htmlFor={id}>Video</label>
        <input
          ref={input}
          id={id}
          type="file"
          accept={types.join(',')}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-${error ? 'error' : 'hint'}`}
          onChange={event => pick(event.target.files?.[0] ?? null)}
        />
        {error ? (
          <p className="field-error" id={`${id}-error`} role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint" id={`${id}-hint`}>
            MP4, MOV or WebM, up to {sizeText(maxBytes)}. You can leave this page open while it uploads.
          </p>
        )}
      </div>

      {file && busy && (
        <ProgressBar value={sent} max={file.size} label={`Uploading ${file.name}`} />
      )}
      {file && step === 'uploading' && (
        <p className="muted">
          {sizeText(sent)} of {sizeText(file.size)}
        </p>
      )}
      {step === 'done' && (
        <Notice tone="success" title="Video added">
          Getting it ready to play on every screen. That takes a few minutes.
        </Notice>
      )}

      <div className="form-actions">
        <Button
          onClick={() => void start()}
          disabled={!file || step === 'done'}
          pending={busy}
          pendingLabel={step === 'confirming' ? 'Finishing…' : 'Uploading…'}>
          Upload video
        </Button>
        {step === 'uploading' && (
          <Button variant="secondary" onClick={() => abort.current?.abort()}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

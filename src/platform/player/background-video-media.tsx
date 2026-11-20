import {resolveAdapterType} from '@videojs/react';
import {BackgroundVideo} from '@videojs/react/media/background-video';
import {lazy, Suspense} from 'react';

const HlsJsVideo = lazy(() =>
  import('@videojs/react/media/hlsjs-video').then((x) => ({default: x.HlsJsVideo})),
);

// BackgroundVideoMedia is the muted, looping video behind a BackgroundVideo;
// load it through BackgroundVideo. HLS plays through hls.js (any segment
// format, unlike Video.js's background HLS element, which needs fMP4).
export function BackgroundVideoMedia({
  src,
  type,
  className,
}: {
  src: string;
  type?: string;
  className?: string;
}) {
  const kind = resolveAdapterType(src, type);
  if (kind === 'hls' || kind === 'mux') {
    return (
      <Suspense>
        <HlsJsVideo source={{src, type}} className={className} autoPlay muted loop playsInline />
      </Suspense>
    );
  }
  return <BackgroundVideo src={src} className={className} />;
}

import {useCallback, useRef} from 'react';

import {vttTrackUrl} from './interactions';

// useChaptersTrack is a ref for a player's chapters <track> (the video's
// and the audio player's): it gives the track a blob: URL of the chapters'
// WebVTT (chaptersVtt) in the browser, revoked when the chapters change
// (another video) or the player unmounts. A track loads its src once, so a
// new set of chapters is a new track element (key it by the WebVTT). The
// ref returns no cleanup, so it works the same on React 18 and 19: it is
// called with null on detach and revokes the last URL then.
export function useChaptersTrack(vtt: string) {
  const last = useRef<string | null>(null);
  return useCallback(
    (track: HTMLTrackElement | null) => {
      if (last.current) URL.revokeObjectURL(last.current);
      last.current = null;
      if (!track) return;
      const url = vttTrackUrl(vtt);
      track.src = url;
      last.current = url;
    },
    [vtt],
  );
}

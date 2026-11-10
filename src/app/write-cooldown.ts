import {useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';

import {useCooldown} from '../portal/ui';

/** `blocked` is true while a 429 from ANY failed mutation of this app is still inside its `Retry-After` (cap 60 s). */
export function useWriteCooldown() {
  const queryClient = useQueryClient();
  const {blocked, secondsLeft, note} = useCooldown();
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe(event => {
        if (event.type === 'updated' && event.action.type === 'error') note(event.action.error);
      }),
    [queryClient, note]
  );
  return {blocked, secondsLeft, note};
}

import {useEffect, useState} from 'react';

import {useT} from '../i18n';
import {Notice} from '../portal/ui';

/** "Offline" strip while the browser reports no connection; reads and the board poll recover on their own (backoff). */
export function OfflineBanner() {
  const t = useT();
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online ? null : <Notice tone="warning">{t('sync.offline')}</Notice>;
}

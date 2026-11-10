import {useEffect, useRef} from 'react';

import {useT} from '../../i18n';
import {Link} from '../nav';
import {useWorkspace} from '../workspace';

/**
 * Sections of Settings: one row of links above each settings screen. On phones the row scrolls sideways
 * (settings.css), so the current section is scrolled into view when the screen opens (each screen mounts its own nav).
 */
export function SettingsNav() {
  const t = useT();
  const {current} = useWorkspace();
  const admin = current?.role === 'owner' || current?.role === 'admin';
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = nav.current;
    const active = row?.querySelector<HTMLElement>('a.active');
    if (!row || !active || row.scrollWidth <= row.clientWidth) return;
    // Only the row scrolls (never the page): centre the active link inside it.
    const rowBox = row.getBoundingClientRect();
    const box = active.getBoundingClientRect();
    row.scrollLeft += box.left - rowBox.left - (rowBox.width - box.width) / 2;
  }, []);
  return (
    <nav className="lf-settings-nav" aria-label={t('nav.settingsSections')} ref={nav}>
      <Link to="/settings/appearance">{t('nav.appearance')}</Link>
      <Link to="/settings/language">{t('nav.language')}</Link>
      <Link to="/settings/workspace">{t('nav.workspaceSettings')}</Link>
      <Link to="/settings/billing">{t('nav.billing')}</Link>
      {admin && <Link to="/settings/audit">{t('audit.title')}</Link>}
      <Link to="/settings/import-export">{t('nav.importExport')}</Link>
      <Link to="/settings/notifications">{t('notifEmail.title')}</Link>
      <Link to="/settings/account">{t('nav.account')}</Link>
    </nav>
  );
}

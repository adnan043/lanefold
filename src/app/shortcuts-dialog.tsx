import {Fragment} from 'react';
import {useT, type MessageKey} from '../i18n';
import {Modal} from '../portal/ui';
import {Kbd} from './shortcuts';

export const SHORTCUT_GROUPS: {title: MessageKey; items: {keys: string[]; label: MessageKey}[]}[] = [
  {
    title: 'shortcuts.general',
    items: [
      {keys: ['?'], label: 'shortcuts.help'},
      {keys: ['/'], label: 'shortcuts.search'},
      {keys: ['Ctrl', 'K'], label: 'shortcuts.palette'},
    ],
  },
  {
    title: 'shortcuts.navigation',
    items: [
      {keys: ['g', 'b'], label: 'shortcuts.goBoards'},
      {keys: ['g', 'm'], label: 'shortcuts.goMyDay'},
      {keys: ['g', 'i'], label: 'shortcuts.goInbox'},
      {keys: ['g', 'c'], label: 'shortcuts.goChat'},
    ],
  },
  {title: 'shortcuts.create', items: [{keys: ['n'], label: 'shortcuts.new'}]},
  {title: 'shortcuts.board', items: [{keys: ['x'], label: 'shortcuts.selectCard'}]},
];

export function ShortcutsDialog({open, setOpen}: {open: boolean; setOpen: (value: boolean) => void}) {
  const t = useT();
  return (
    <Modal open={open} onClose={() => setOpen(false)} title={t('shortcuts.title')} description={t('shortcuts.lead')}>
      <div className="lf-shortcuts">
        {SHORTCUT_GROUPS.map(group => (
          <section key={group.title} aria-labelledby={`sc-${group.title}`}>
            <h3 id={`sc-${group.title}`} className="lf-shortcuts-title">
              {t(group.title)}
            </h3>
            <dl className="lf-shortcuts-list">
              {group.items.map(item => (
                <div key={item.label} className="lf-shortcuts-row">
                  <dt>{t(item.label)}</dt>
                  <dd>
                    {item.keys.map((key, i) => (
                      <Fragment key={key}>
                        {i > 0 && <span className="lf-shortcuts-then">{item.keys[0] === 'Ctrl' ? '+' : t('shortcuts.then')}</span>}
                        <Kbd>{key}</Kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

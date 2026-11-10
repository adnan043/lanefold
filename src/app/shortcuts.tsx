import {useNavigate} from './nav';
import {useEffect, useRef, useState} from 'react';

import {useT} from '../i18n';
import {isPaletteKey, letterOf} from './shortcut-keys';
import {storedShortcuts} from './settings/prefs';


/**
 * Keyboard shortcuts (this file is EAGER and tiny: the listener only; the help dialog is `shortcuts-dialog.tsx`, lazy). Ignored while typing (inputs, textareas, selects, editable text), while a dialog is open
 * (except `?` toggling its own) and with Ctrl / Cmd / Alt held (Cmd K belongs to the palette).
 * `g` then b / m / i / c goes Boards / My Day / Inbox / Chat within 1.5 s. `n` presses the screen's first "add"
 * button (a card on a board, a board on the list). `/` opens the palette.
 */
const GO: Record<string, string> = {b: '/boards', m: '/my-day', i: '/inbox', c: '/chat'};

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function Kbd({children}: {children: string}) {
  return <kbd className="lf-kbd" dir="ltr">{children}</kbd>;
}

export function Shortcuts({open, setOpen, openPalette, togglePalette}: {open: boolean; setOpen: (value: boolean) => void; openPalette: () => void; togglePalette: () => void}) {
  const navigate = useNavigate();
  const t = useT();
  const armed = useRef(0);
  const [armedNote, setArmedNote] = useState('');
  const noteTimer = useRef<number | undefined>(undefined);
  const note = useRef({say: setArmedNote, text: ''});
  note.current = {say: setArmedNote, text: t('shortcuts.armed')};
  const live = useRef({open, setOpen, openPalette, togglePalette, navigate});
  live.current = {open, setOpen, openPalette, togglePalette, navigate};

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && isPaletteKey(event)) {
        event.preventDefault();
        live.current.togglePalette();
        return;
      }
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      if (event.repeat) return;
      // Single-key shortcuts can be turned off in Settings > Appearance (WCAG 2.1.4); read at event time.
      if (!storedShortcuts()) return;
      const {open: isOpen, setOpen: toggle, openPalette: palette, navigate: go} = live.current;
      // `?` closes its own dialog; over any other dialog or menu it does nothing.
      if (event.key === '?' && isOpen) {
        event.preventDefault();
        toggle(false);
        return;
      }
      if (isOpen || document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) {
        armed.current = 0;
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        toggle(true);
        return;
      }
      // Shift + a letter is a different chord (Shift+G, Shift+N): only `?` uses Shift.
      if (event.shiftKey) {
        armed.current = 0;
        return;
      }
      const key = letterOf(event);
      if (armed.current && Date.now() - armed.current < 1500 && GO[key]) {
        event.preventDefault();
        armed.current = 0;
        note.current.say('');
        void go({to: GO[key]});
        return;
      }
      armed.current = 0;
      window.clearTimeout(noteTimer.current);
      note.current.say('');
      if (key === 'g') {
        armed.current = Date.now();
        note.current.say(note.current.text);
        window.clearTimeout(noteTimer.current);
        noteTimer.current = window.setTimeout(() => note.current.say(''), 1500);
      } else if (key === '/') {
        event.preventDefault();
        palette();
      } else if (key === 'n') {
        const add = document.querySelector<HTMLButtonElement>('[data-shortcut="new"]:not(:disabled)');
        if (add) {
          event.preventDefault();
          add.click();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(noteTimer.current);
    };
  }, []);

  return (
    <span className="visually-hidden" role="status">
      {armedNote}
    </span>
  );
}

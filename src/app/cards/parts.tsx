import {type ReactNode, useCallback, useRef, useState} from 'react';

import {useI18n} from '../../i18n';
import {Icon, type IconName, useToast} from '../../portal/ui';
import {useWriteCooldown} from '../write-cooldown';

/**
 * Shared bits of the card panel. `useAction` is the one pending-and-error pattern: `run(id, work)` marks `id`
 * busy (only that row shows pending, its siblings are disabled), toasts the server's error in the person's
 * language on failure, and always frees the button. It resolves `true` when the work succeeded.
 */
export function useAction() {
  const {errorMessage} = useI18n();
  const toast = useToast();
  const cooldown = useWriteCooldown();
  const {note} = cooldown;
  const [busy, setBusy] = useState<string | null>(null);
  // Every running id: finishing one never frees another's pending state.
  const running = useRef<string[]>([]);
  const run = useCallback(
    async (id: string, work: () => Promise<unknown>) => {
      running.current.push(id);
      setBusy(id);
      try {
        await work();
        return true;
      } catch (error) {
        note(error);
        toast.danger(errorMessage(error));
        return false;
      } finally {
        const at = running.current.indexOf(id);
        if (at >= 0) running.current.splice(at, 1);
        setBusy(running.current[running.current.length - 1] ?? null);
      }
    },
    [errorMessage, toast, note]
  );
  return {busy, run, blocked: cooldown.blocked};
}

export function Section({id, icon, title, actions, children}: {id: string; icon: IconName; title: string; actions?: ReactNode; children: ReactNode}) {
  return (
    <section className="cd-section" aria-labelledby={id}>
      <div className="cd-section-head">
        <Icon name={icon} size={18} />
        <h3 id={id}>{title}</h3>
        <span className="cd-spacer" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/** "812 KB", "3.4 MB": file sizes are short and unit-universal. */
export function bytesLabel(bytes: number, format: (n: number, o?: Intl.NumberFormatOptions) => string): string {
  if (bytes < 1024) return `${format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${format(Math.round(bytes / 1024))} KB`;
  return `${format(bytes / (1024 * 1024), {maximumFractionDigits: 1})} MB`;
}

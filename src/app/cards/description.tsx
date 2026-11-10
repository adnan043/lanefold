import {useT} from '../../i18n';
import {Markdown} from '../../lib/markdown';
import {Button} from '../../portal/ui';
import './markdown.css';

/** Rendered Markdown text for a card description or a comment (`mentions` = the names to show as @mentions). */
export function MdView({source, mentions}: {source: string; mentions?: string[]}) {
  const t = useT();
  return <Markdown source={source} mentions={mentions} labels={{taskDone: t('md.taskDone'), taskOpen: t('md.taskOpen')}} />;
}

/** The Preview / Edit toggle of a text box. The text box stays mounted (`hidden`) so nothing typed is lost. */
export function PreviewToggle({on, onChange, disabled}: {on: boolean; onChange: (on: boolean) => void; disabled?: boolean}) {
  const t = useT();
  return (
    <Button size="sm" variant="secondary" aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)}>
      {on ? t('md.write') : t('md.preview')}
    </Button>
  );
}

/** What replaces the text box while previewing. */
export function MdPreview({source, mentions}: {source: string; mentions?: string[]}) {
  const t = useT();
  return (
    <div className="cd-preview" aria-live="polite">
      {source.trim() ? <MdView source={source} mentions={mentions} /> : <p className="cd-none">{t('md.previewEmpty')}</p>}
    </div>
  );
}

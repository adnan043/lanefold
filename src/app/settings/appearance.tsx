import {useCallback, useEffect, useRef, useState, type KeyboardEvent} from 'react';

import {useT, type MessageKey} from '../../i18n';
import {PageHeader, RadioCards, Card, Button, Icon, Switch, useConfirm, useToast} from '../../portal/ui';
import {SettingsNav} from './nav';
import {
  ACCENTS,
  type Accent,
  applyAccent,
  applyCustomAccent,
  applyDensity,
  applyFontScale,
  applyRadius,
  applyReduceMotion,
  applyShortcuts,
  applyTheme,
  type Density,
  DENSITIES,
  FONT_SCALES,
  RADII,
  type Radius,
  storedRadius,
  type FontScale,
  storedAccent,
  storedCustomAccent,
  storedDensity,
  storedFontScale,
  storedReduceMotion,
  storedShortcuts,
  storedTheme,
  THEMES,
  type ThemeMode,
  CUSTOM_ACCENT_START,
} from './prefs';
import {useSavePreferences, type PreferencesPatch} from './sync';

const FONT_LABEL: Record<FontScale, MessageKey> = {
  '100': 'appearance.fontScale.default',
  '112': 'appearance.fontScale.large',
  '125': 'appearance.fontScale.larger',
  '150': 'appearance.fontScale.largest',
};

/**
 * The last pill of the swatch row: the person's own colour, picked on the browser's colour plate (a native
 * `<input type="color">` covering the pill). Applied live while dragging; `onDone` once the plate closes.
 */
function CustomSwatch({value, checked, onPick, onDone}: {value: string; checked: boolean; onPick: (hex: string) => void; onDone: () => void}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  // React's onChange is the native `input` event (every drag step); the native `change` fires once, when committed.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.addEventListener('change', onDone);
    return () => el.removeEventListener('change', onDone);
  }, [onDone]);
  return (
    <label className="lf-swatch lf-swatch-custom" data-accent="custom" data-checked={checked || undefined}>
      <span className="lf-swatch-dot" aria-hidden="true">
        {checked && <Icon name="check" size={14} />}
      </span>
      {t('appearance.accent.custom')}
      <input
        ref={input}
        type="color"
        className="lf-swatch-input"
        value={value || CUSTOM_ACCENT_START}
        aria-label={t('appearance.accent.custom')}
        onChange={event => onPick(event.target.value)}
      />
    </label>
  );
}

/** One row of colour swatches: a radio group (arrow keys move and pick, one tab stop), then the custom colour. */
function AccentPicker({
  value,
  onChange,
  custom,
  onCustom,
  onCustomDone,
}: {
  value: Accent;
  onChange: (accent: Accent) => void;
  custom: string;
  onCustom: (hex: string) => void;
  onCustomDone: () => void;
}) {
  const t = useT();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const rtl = document.documentElement.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const step = event.key === forward || event.key === 'ArrowDown' ? 1 : event.key === back || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + ACCENTS.length) % ACCENTS.length;
    onChange(ACCENTS[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div className="lf-swatches">
      <div className="lf-swatches-group" role="radiogroup" aria-label={t('appearance.accent.presets')}>
      {ACCENTS.map((accent, index) => (
        <button
          key={accent}
          ref={node => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          className="lf-swatch"
          data-accent={accent}
          aria-checked={value === accent}
          tabIndex={value === accent || (value === 'custom' && index === 0) ? 0 : -1}
          onClick={() => onChange(accent)}
          onKeyDown={event => move(event, index)}>
          <span className="lf-swatch-dot" aria-hidden="true">
            {value === accent && <Icon name="check" size={14} />}
          </span>
          {t(`appearance.accent.${accent}` as MessageKey)}
        </button>
      ))}
      </div>
      <CustomSwatch value={custom} checked={value === 'custom'} onPick={onCustom} onDone={onCustomDone} />
    </div>
  );
}

/**
 * `/app/settings/appearance`: mode, density, accent, text size and motion, applied at once. Mode and density
 * are saved to the profile (so they follow the person to every device) and always to this browser.
 */
export function Appearance() {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const save = useSavePreferences();
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  const [density, setDensity] = useState<Density>(storedDensity);
  const [accent, setAccent] = useState<Accent>(storedAccent);
  const [customAccent, setCustomAccent] = useState<string>(() => storedCustomAccent() ?? '');
  const [font, setFont] = useState<FontScale>(storedFontScale);
  const [radius, setRadius] = useState<Radius>(storedRadius);
  const [reduce, setReduce] = useState(storedReduceMotion);
  const [shortcuts, setShortcuts] = useState(storedShortcuts);

  const saved = async (patch: PreferencesPatch) => {
    const ok = await save(patch);
    if (ok) toast.success(t('appearance.saved'));
    else toast.info(t('appearance.savedLocal'));
  };
  const pickTheme = (next: ThemeMode) => {
    setTheme(next);
    applyTheme(next);
    void saved({themeMode: next});
  };
  const pickDensity = (next: Density) => {
    setDensity(next);
    applyDensity(next);
    void saved({density: next});
  };
  const pickAccent = (next: Accent) => {
    setAccent(next);
    applyAccent(next);
    toast.success(t('appearance.saved'));
  };
  const pickCustomAccent = (hex: string) => {
    setCustomAccent(hex);
    setAccent('custom');
    applyCustomAccent(hex);
  };
  const customAccentDone = useCallback(() => toast.success(t('appearance.saved')), [toast, t]);
  const pickFont = (next: FontScale) => {
    setFont(next);
    applyFontScale(next);
    void saved({fontScale: Number(next)});
  };
  const pickMotion = (next: boolean) => {
    setReduce(next);
    applyReduceMotion(next);
    void saved({reduceMotion: next});
  };
  const pickRadius = (next: Radius) => {
    setRadius(next);
    applyRadius(next);
    void saved({radius: next});
  };
  const pickShortcuts = (next: boolean) => {
    setShortcuts(next);
    applyShortcuts(next);
    toast.success(t('appearance.saved'));
  };
  const reset = async () => {
    const ok = await confirm({
      title: t('appearance.resetTitle'),
      body: t('appearance.resetBody'),
      confirmLabel: t('appearance.resetConfirm'),
      pendingLabel: t('appearance.resetPending'),
      tone: 'primary',
      action: async () => {
        setAccent('brand');
        applyAccent('brand');
        setFont('100');
        applyFontScale('100');
        setRadius('soft');
        applyRadius('soft');
        setReduce(false);
        applyReduceMotion(false);
        setShortcuts(true);
        applyShortcuts(true);
        setTheme('system');
        applyTheme('system');
        setDensity('comfortable');
        applyDensity('comfortable');
        await save({themeMode: 'system', density: 'comfortable', fontScale: 100, radius: 'soft', reduceMotion: false});
      },
    });
    if (ok) toast.success(t('appearance.saved'));
  };

  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('appearance.title')} description={t('appearance.description')} />
      <Card title={t('appearance.mode.title')}>
        <RadioCards
          legend={t('appearance.mode.title')}
          name="theme"
          columns={2}
          value={theme}
          onChange={pickTheme}
          options={THEMES.map(mode => ({
            value: mode,
            title: t(`appearance.mode.${mode}`),
            description: t(`appearance.mode.${mode}Description`),
          }))}
        />
      </Card>
      <Card title={t('appearance.accent.title')} description={t('appearance.accent.description')}>
        <AccentPicker value={accent} onChange={pickAccent} custom={customAccent} onCustom={pickCustomAccent} onCustomDone={customAccentDone} />
      </Card>
      <Card title={t('appearance.fontScale.title')} description={t('appearance.fontScale.description')}>
        <RadioCards
          legend={t('appearance.fontScale.title')}
          name="font"
          columns={4}
          value={font}
          onChange={pickFont}
          options={FONT_SCALES.map(value => ({value, title: t(FONT_LABEL[value])}))}
        />
      </Card>
      <Card title={t('appearance.radius.title')} description={t('appearance.radius.description')}>
        <RadioCards
          legend={t('appearance.radius.title')}
          name="radius"
          columns={3}
          value={radius}
          onChange={pickRadius}
          options={RADII.map(value => ({value, title: t(`appearance.radius.${value}` as MessageKey)}))}
        />
      </Card>
      <Card title={t('appearance.density.title')} description={t('appearance.density.description')}>
        <RadioCards
          legend={t('appearance.density.title')}
          name="density"
          columns={3}
          value={density}
          onChange={pickDensity}
          options={DENSITIES.map(value => ({value, title: t(`appearance.density.${value}`)}))}
        />
      </Card>
      <Card>
        <Switch label={t('appearance.motion.title')} description={t('appearance.motion.description')} checked={reduce} onChange={pickMotion} />
      </Card>
      <Card>
        <Switch label={t('appearance.shortcuts.title')} description={t('appearance.shortcuts.description')} checked={shortcuts} onChange={pickShortcuts} />
      </Card>
      <Card title={t('appearance.preview.title')} description={t('appearance.preview.description')}>
        <ul className="lf-cards lf-density-preview">
          {[0, 1].map(i => (
            <li key={i} className="lf-card">
              <span className="lf-card-title">{t('appearance.preview.card')}</span>
            </li>
          ))}
        </ul>
        <div className="lf-form-actions">
          <Button>{t('appearance.preview.primary')}</Button>
          <Button variant="secondary">{t('appearance.preview.secondary')}</Button>
        </div>
      </Card>
      <div>
        <Button variant="secondary" icon="refresh" onClick={() => void reset()}>
          {t('appearance.reset')}
        </Button>
      </div>
    </div>
  );
}

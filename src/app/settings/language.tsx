import {useI18n, useT, LOCALES, isLocale, NEEDS_REVIEW} from '../../i18n';
import {Badge, Card, Field, PageHeader, Select, useToast} from '../../portal/ui';
import {SettingsNav} from './nav';
import {useSavePreferences} from './sync';

/** `/app/settings/language`: every launch language, named in itself; applies at once, direction included. */
export function Language() {
  const t = useT();
  const {locale, dir, setLocale} = useI18n();
  const toast = useToast();
  const save = useSavePreferences();
  return (
    <div className="app-page">
      <SettingsNav />
      <PageHeader title={t('nav.language')} description={t('language.description')} />
      <Card>
        <div className="lf-form">
          <Field id="f-locale" label={t('language.label')} hint={dir === 'rtl' ? t('language.dirRtl') : t('language.dirLtr')}>
            <Select
              id="f-locale"
              value={locale}
              options={LOCALES.map(item => ({value: item.code, label: item.native}))}
              onChange={event => {
                const next = event.target.value;
                if (!isLocale(next)) return;
                setLocale(next);
                // Kept in the cookie at once; the profile (every device) follows when signed in.
                void save({locale: next}).then(ok => (ok ? toast.success(t('settings.saved')) : toast.info(t('appearance.savedLocal'))));
              }}
            />
          </Field>
          {NEEDS_REVIEW.has(locale) && <Badge tone="warning">{t('language.draft')}</Badge>}
        </div>
      </Card>
    </div>
  );
}

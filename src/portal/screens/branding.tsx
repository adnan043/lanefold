import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef, useState} from 'react';

import {type AccentTokens, brandPalette, DARK_SURFACES, DEFAULT_BRAND, LIGHT_SURFACES} from '../../lib/brand';
import {api, read} from '../api';
import {brandingQuery} from '../queries';
import {Button, Card, ErrorNote, Field, LoadingBlock, Notice, PageHeader, useConfirm, useToast} from '../ui';
import {readableOn} from '../ui/contrast';
import {ColorPicker} from '../ui/popover';

/**
 * A sample of the accent in one mode: a filled button, a link and a soft badge on that mode's page colour.
 * The colours are DATA (computed from the admin's choice), so they reach the element as custom properties
 * through `element.style` (the CSP blocks `style=""`).
 */
function Sample({mode, tokens}: {mode: 'light' | 'dark'; tokens: AccentTokens}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bg = mode === 'light' ? LIGHT_SURFACES[0] : DARK_SURFACES[2];
    const vars: Record<string, string> = {
      '--pv-bg': bg,
      '--pv-ink': readableOn(bg),
      '--pv-accent': tokens.accent,
      '--pv-accent-ink': tokens.accentInk,
      '--pv-accent-soft': tokens.accentSoft,
      '--pv-accent-text': tokens.accentText,
    };
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  }, [mode, tokens]);
  return (
    <div ref={ref} className="brand-sample" aria-label={mode === 'light' ? 'Light mode preview' : 'Dark mode preview'} role="group">
      <p className="brand-sample-mode">{mode === 'light' ? 'Light mode' : 'Dark mode'}</p>
      <span className="brand-sample-button" aria-hidden="true">
        Primary button
      </span>
      <span className="brand-sample-link" aria-hidden="true">
        A link
      </span>
      <span className="brand-sample-badge" aria-hidden="true">
        Selected
      </span>
      <code className="brand-sample-hex">{tokens.accent}</code>
    </div>
  );
}

/** Reloads this tab's brand stylesheet (the layouts link it) so a saved colour shows here at once, without a reload. */
function reloadBrandSheet() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="/site-api/brand.css"]');
  if (link) link.href = `/site-api/brand.css?v=${Date.now()}`;
}

/** `/dashboard/branding`: the site's brand colour (website, dashboard and app), any colour, made readable. */
export function Branding() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const branding = useQuery(brandingQuery);
  const saved = branding.data?.brandColor ?? null;
  const [draft, setDraft] = useState<string>(DEFAULT_BRAND);
  useEffect(() => {
    if (branding.data) setDraft(branding.data.brandColor ?? DEFAULT_BRAND);
  }, [branding.data]);

  const save = useMutation({
    mutationFn: (brandColor: string | null) => read<{brandColor: string | null}>(api.branding.$put({json: {brandColor}})),
    onSuccess: data => {
      queryClient.setQueryData(brandingQuery.queryKey, data);
      reloadBrandSheet();
    },
  });

  const palette = brandPalette(draft);
  // Nothing to save: the colour already in use (the default green when none is set).
  const unchanged = palette?.color === (saved ?? DEFAULT_BRAND);

  const onSave = () => {
    if (!palette) return;
    save.mutate(palette.color, {onSuccess: () => toast.success('Brand colour saved. Everyone sees it on their next page load.')});
  };
  const onReset = () =>
    void confirm({
      title: 'Go back to the default green?',
      body: 'The website, the dashboard and the app use the default green again. People who chose their own accent keep it.',
      confirmLabel: 'Use the default',
      pendingLabel: 'Resetting…',
      action: () => save.mutateAsync(null),
    }).then(ok => ok && toast.success('Back to the default green.'));

  return (
    <div className="app-page">
      <PageHeader title="Branding" description="The brand colour of the website, this dashboard and the app: buttons, links and highlights." />

      {branding.error && <ErrorNote error={branding.error} />}

      <Card
        title="Brand colour"
        description="Pick any colour. It is darkened for light mode or lightened for dark mode only as far as needed for readable text."
        footer={
          branding.data && (
            <>
              <Button variant="secondary" disabled={saved === null || save.isPending} onClick={onReset}>
                Reset to default
              </Button>
              <Button pending={save.isPending} pendingLabel="Saving…" disabled={!palette || unchanged} onClick={onSave}>
                Save colour
              </Button>
            </>
          )
        }>
        {branding.isPending ? (
          <LoadingBlock rows={3} />
        ) : branding.data ? (
          <div className="brand-form">
            <div className="brand-colour">
              <Field id="brand-colour" label="Colour" hint={saved === null ? 'Now: the default green.' : `Now: ${saved}.`}>
                <ColorPicker value={draft} onChange={setDraft} label="Brand colour" disabled={save.isPending} />
              </Field>
            </div>
            {palette && (
              <>
                <div className="brand-samples">
                  <Sample mode="light" tokens={palette.light} />
                  <Sample mode="dark" tokens={palette.dark} />
                </div>
                {palette.adjusted && (
                  <Notice tone="info" title="Adjusted for readability">
                    Text on this colour would be hard to read as it is, so light mode uses <code>{palette.light.accent}</code> and dark mode uses{' '}
                    <code>{palette.dark.accent}</code>.
                  </Notice>
                )}
              </>
            )}
            {save.error && <ErrorNote error={save.error} />}
            <p className="muted brand-note">
              Everyone sees a change on their next page load. People who picked their own accent in the app (Settings, Appearance) keep theirs; high
              contrast mode is never changed.
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

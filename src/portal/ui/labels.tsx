import {createContext, type ReactNode, useContext, useMemo} from 'react';

/**
 * The kit's own accessible names and button texts. The /dashboard portal has no i18n and keeps these English
 * defaults; `/app` wraps its tree in `<UiLabels labels={...}>` with translated values (any subset).
 */
export type UiLabelSet = {
  close: string;
  dismiss: string;
  cancel: string;
  loading: string;
  presetColours: string;
  previousMonth: string;
  nextMonth: string;
  previousYear: string;
  nextYear: string;
  /** The word in a field's "(optional)" suffix; the brackets are added by `Field`. */
  optional: string;
};

export const DEFAULT_UI_LABELS: UiLabelSet = {
  close: 'Close',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  loading: 'Loading…',
  presetColours: 'Preset colours',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  previousYear: 'Previous year',
  nextYear: 'Next year',
  optional: 'optional',
};

const UiLabelsContext = createContext<UiLabelSet>(DEFAULT_UI_LABELS);

export function UiLabels({labels, children}: {labels: Partial<UiLabelSet>; children: ReactNode}) {
  const merged = useMemo(() => ({...DEFAULT_UI_LABELS, ...labels}), [labels]);
  return <UiLabelsContext.Provider value={merged}>{children}</UiLabelsContext.Provider>;
}

export const useUiLabels = () => useContext(UiLabelsContext);

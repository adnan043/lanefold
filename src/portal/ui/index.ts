/**
 * The portal's UI kit: import EVERYTHING from here (`import {Button, Card} from '../ui'`).
 * Every screen is built from these pieces, so the whole app looks and behaves
 * as one (docs/agent/ui.md). Need something that is not here? Build it in
 * this folder from the same tokens (`src/styles/global.css`) and classes
 * (`src/styles/app.css`), export it here, and use it everywhere; never a
 * second UI library.
 *
 * NOT in this barrel on purpose (it kept ~14 KB of date picker, color picker, popover, chips and the command palette in the shared
 * chunk every screen loads): import them straight from their file, `from '../ui/popover'` (Popover, DatePicker, ColorPicker),
 * `'../ui/chips'` (Chip, ChipInput, AvatarStack, ColorDot), `'../ui/command'` (CommandPalette), `'../ui/date'` (date helpers),
 * `'../ui/contrast'` and `'../ui/fuzzy'`.
 *
 * On screen while you work: `/dashboard/components` in the Preview (dev only).
 */
export * from './button';
export * from './cooldown';
export * from './display';
export * from './form';
export * from './icon';
export * from './labels';
export * from './nav';
export * from './overlay';
export * from './portal-host';
export * from './table';

import { defaultOf, type PreferenceValues } from '../features/preferences/preferenceSchema';

type AppearanceValues = Pick<
  PreferenceValues,
  | 'density'
  | 'uiFontSize'
  | 'editorFontFamily'
  | 'editorFontSize'
  | 'gridFontFamily'
  | 'gridFontSize'
  | 'nullStyle'
>;

/** Base size of the text tokens (`--text-md`), the one `--font-scale` is relative to. */
const BASE_TEXT_PX = 13;

function setOrClear(style: CSSStyleDeclaration, name: string, value: string | null): void {
  if (value === null) style.removeProperty(name);
  else style.setProperty(name, value);
}

/** The font stack for a user family: it goes first, the bundled mono stays as the fallback. */
function stack(family: string): string | null {
  return family === '' ? null : `${family}, var(--font-code)`;
}

function pixelsUnlessDefault(
  key: 'editorFontSize' | 'gridFontSize' | 'uiFontSize',
  value: number,
): string | null {
  return value === defaultOf(key) ? null : `${String(value)}px`;
}

/**
 * Puts the look preferences on `<html>`: density as an attribute, the rest as the CSS variables
 * of `tokens.css`. A value left at its default removes the override, so the theme's tokens apply.
 */
export function applyAppearance(values: AppearanceValues): void {
  const root = document.documentElement;
  const { style } = root;
  root.dataset.density = values.density;
  setOrClear(
    style,
    '--font-scale',
    values.uiFontSize === defaultOf('uiFontSize') ? null : String(values.uiFontSize / BASE_TEXT_PX),
  );
  setOrClear(style, '--editor-font-family', stack(values.editorFontFamily));
  setOrClear(
    style,
    '--editor-font-size',
    pixelsUnlessDefault('editorFontSize', values.editorFontSize),
  );
  setOrClear(style, '--grid-font-family', stack(values.gridFontFamily));
  setOrClear(style, '--grid-font-size', pixelsUnlessDefault('gridFontSize', values.gridFontSize));
  const plain = values.nullStyle === 'plain';
  setOrClear(style, '--grid-null-font-style', plain ? 'normal' : null);
  setOrClear(style, '--grid-null-font-size', plain ? 'inherit' : null);
  setOrClear(style, '--grid-null-letter-spacing', plain ? 'normal' : null);
}

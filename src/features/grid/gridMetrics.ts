import type { WidthMetrics } from './gridMath';

/** Sizes the layout code needs, read from the theme tokens (`--grid-*`) and the fonts. */
export interface GridMetrics extends WidthMetrics {
  rowHeight: number;
  headerHeight: number;
  gutterMinWidth: number;
  /** Width a header needs to show its column name and type (and `marks` icons: a lock…). */
  headerWidth: (name: string, typeName: string, marks?: number) => number;
}

const MAX_COLUMN_WIDTH = 400;

function pixels(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

type Measure = (text: string, font: string) => number;

function textMeasure(): Measure | null {
  // jsdom has no canvas (unit tests): fall back to an estimate.
  if (navigator.userAgent.includes('jsdom')) return null;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;
  return (text, font) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/** Reads the grid's metrics from the styles applied to `el` (the grid's scroller). */
export function readGridMetrics(el: HTMLElement): GridMetrics {
  const style = getComputedStyle(el);
  const fontSize = pixels(style, 'font-size', 12);
  const cellFont = `${String(fontSize)}px ${style.fontFamily || 'monospace'}`;
  const uiFamily = style.getPropertyValue('--font-ui').trim() || 'sans-serif';
  const headerFont = `600 ${String(fontSize)}px ${uiFamily}`;
  const typeSize = pixels(style, '--text-2xs', fontSize - 1.5);
  const typeFont = `${String(typeSize)}px ${uiFamily}`;
  // Both paddings, the cell's border and a pixel of rounding slack (else the ellipsis shows).
  const padding =
    2 * pixels(style, '--grid-cell-padding-x', 8) + pixels(style, '--border-width', 1) + 1;
  const measure = textMeasure();
  const charWidth = measure ? measure('0'.repeat(20), cellFont) / 20 : fontSize * 0.6;
  const gap = pixels(style, '--space-2', 6);
  return {
    rowHeight: pixels(style, '--grid-row-height', 24),
    headerHeight: pixels(style, '--grid-header-height', 30),
    gutterMinWidth: pixels(style, '--grid-gutter-min-width', 44),
    minWidth: pixels(style, '--grid-col-min-width', 48),
    maxWidth: MAX_COLUMN_WIDTH,
    padding,
    charWidth,
    headerWidth: (name, typeName, marks = 0) => {
      const nameWidth = measure ? measure(name, headerFont) : name.length * fontSize * 0.62;
      const typeWidth = !typeName
        ? 0
        : gap + (measure ? measure(typeName, typeFont) : typeName.length * typeSize * 0.6);
      const markWidth = marks * (pixels(style, '--icon-size-sm', 14) + gap);
      return Math.ceil(nameWidth + typeWidth + markWidth + padding);
    },
  };
}

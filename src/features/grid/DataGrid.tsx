import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { IconButton } from '../../ui/IconButton';
import { matchShortcut } from '../../ui/shortcuts';
import { getPreference, usePreference } from '../preferences/preferenceStore';
import { displayLength } from './cellDisplay';
import { CellViewer } from './CellViewer';
import {
  SETTLE_MS,
  createExtents,
  measureLoaded,
  widenColumns,
  type ColumnExtents,
} from './columnGrowth';
import type { CopyFormat } from './copyFormats';
import styles from './DataGrid.module.css';
import { GridBody, type BodyLayout } from './gridBody';
import {
  columnAt,
  columnLefts,
  fitWidth,
  gutterWidth as gutterWidthFor,
  holdRange,
  initialWidth,
  moveItem,
  scrollToInclude,
  scrollTopFor,
  verticalMetrics,
  virtualTop,
  visibleColumns,
  visibleRows,
  type Range,
} from './gridMath';
import { GridHeader, type HeaderSort } from './GridHeader';
import { GridMenu } from './GridMenu';
import { readGridMetrics, type GridMetrics } from './gridMetrics';
import { modKey, selectModeOf } from './modifiers';
import { createRangeStore } from './rangeStore';
import { headerIcons, type RowSource } from './rowSource';
import {
  addCell,
  afterColumnMove,
  cellSelection,
  countRows,
  extendTo,
  isCellSelected,
  isColSelected,
  isRowSelected,
  moveFocus,
  moveFocusTo,
  selectAll,
  selectCols,
  selectedColumns,
  selectedRowIntervals,
  selectRows,
  type CellPos,
  type Selection,
  type SelectMode,
} from './selection';
import { useGridCopy, type CopyExtras } from './useGridCopy';

/**
 * Rows drawn above and below the viewport: about one wheel notch, so a compositor that scrolls
 * ahead of the main thread (WebView2) shows rows; more makes every column entering cost more.
 */
const OVERSCAN_ROWS = 4;
/** Columns drawn past each side of the viewport when the drawn ones move (`holdRange`). */
const COLUMN_BATCH = 1;
/** Rows auto-fit reads at most. */
const AUTO_FIT_ROWS = 20_000;
/** Speed of the scroll while a drag selection is held past an edge (fraction of the overshoot). */
const AUTO_SCROLL_RATE = 0.35;

/**
 * The event is not the grid's own: it comes from an editor or an overlay drawn over a cell, or
 * from a portal (a popover) that React bubbles through the grid without being inside it.
 */
function notOnGrid(event: { target: EventTarget; currentTarget: EventTarget }): boolean {
  const { target, currentTarget } = event;
  if (!(target instanceof Element) || !(currentTarget instanceof Element)) return true;
  return (
    !currentTarget.contains(target) ||
    target.closest('[data-grid-editor], [data-grid-overlay]') !== null
  );
}

export interface DataGridProps {
  source: RowSource;
  /** Identifies the source in caches (e.g. `result-42`). */
  sourceKey: string;
  /** Accessible name of the grid. */
  label: string;
  /** Start of the footer strip (row count, streaming state…). */
  footer?: ReactNode;
  /** Shown in the rows area when there is no row. */
  emptyText?: string;
  copyExtras?: CopyExtras;
  /** The selection's size (the block a copy produces) after it changes; `null`: no selection. */
  onSelectionSize?: (size: { rows: number; cols: number } | null) => void;
  /**
   * The selection as loaded rows and data columns (in display order) when it is one range, else
   * `null`: what an export of the selection writes.
   */
  onSelectionRange?: (range: { rowFrom: number; rowTo: number; columns: number[] } | null) => void;
  /** Adds "Export…" to the context menu. */
  onExport?: () => void;
  /** Header sorting (table tabs): a click sorts instead of selecting the column. */
  sort?: HeaderSort;
  /** Cell editing (table tabs): keys, double click and paste go there first. */
  editing?: GridEditing;
  /** Imperative access for an editing layer (selection, focus). */
  apiRef?: Ref<DataGridApi | null>;
  /** More context menu entries, after the grid's own. */
  menuExtras?: ReactNode;
  /** Column widths and order to start with, by column name (a restored table tab). */
  initialLayout?: ColumnLayout;
  /** The widths or the order of the columns changed (resize, move, auto-fit). */
  onLayoutChange?: (layout: ColumnLayout) => void;
  /** No cell can be changed (`aria-readonly`). */
  readOnly?: boolean;
  /** Elements drawn over cells (a cell's action button, the anchor of a popover). */
  cellOverlays?: readonly GridCellOverlay[];
  /** The cell under the pointer changed (`null`: none). */
  onHoverCell?: (cell: GridCellRef | null) => void;
  /** The focused cell changed (`null`: none). */
  onFocusChange?: (cell: GridCellRef | null) => void;
}

/** Something drawn over a cell, as wide and high as it; its children take the pointer. */
export interface GridCellOverlay extends GridCellRef {
  key: string;
  node: ReactNode;
  /** Where in the cell the node goes: `end` (default) or `start` (over a right-aligned value). */
  align?: 'start' | 'end';
}

/** A cell by row and data column (not display column). */
export interface GridCellRef {
  row: number;
  dataCol: number;
}

export interface GridEditing {
  /** A key pressed on the grid itself (not in an editor), before the grid's own: `true` if handled. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>, focus: GridCellRef | null) => boolean;
  /** A double click on a cell: `true` when handled (the cell viewer then stays closed). */
  onCellDoubleClick?: (cell: GridCellRef) => boolean;
  /**
   * A press on a cell, before the grid selects it: `true` when handled (the cell is then only
   * focused). For `Mod`+click actions.
   */
  onCellPointerDown?: (cell: GridCellRef, event: ReactPointerEvent<HTMLElement>) => boolean;
  /** Text pasted while the grid has the focus. */
  onPaste?: (text: string, focus: GridCellRef | null) => void;
  /** The open editor, drawn over its cell. */
  editor?: { row: number; dataCol: number; node: ReactNode } | null;
}

export interface DataGridApi {
  /** The selection (display columns), `null` when there is none. */
  selection: () => Selection | null;
  /** Display index → data column. */
  order: () => readonly number[];
  /** Selects one cell and scrolls it into view (after the next render, so new rows count). */
  focusCell: (cell: GridCellRef) => void;
  /** Selects whole rows `[from, to]`. */
  selectRows: (from: number, to: number) => void;
  /** Gives the keyboard focus back to the grid. */
  focus: () => void;
}

export interface ColumnLayout {
  /** Width of each column the user sized (or auto-fit), by name. */
  widths: Record<string, number>;
  /** Column names in display order. */
  order: string[];
}

type Hit =
  | { area: 'none' }
  | { area: 'corner' }
  | { area: 'header'; col: number }
  | { area: 'gutter'; row: number }
  | { area: 'cell'; row: number; col: number };

interface Snapshot {
  source: RowSource;
  metrics: GridMetrics;
  layout: BodyLayout;
  selection: Selection | null;
  rowCount: number;
  viewport: { width: number; height: number };
}

interface Drag {
  kind: 'cells' | 'rows';
  x: number;
  y: number;
  frame: number | null;
}

/**
 * The data grid (F-060 to F-064): virtualized rows and columns over a `RowSource`, selection,
 * copy, column resize / reorder / auto-fit and the cell viewer. It knows nothing of queries;
 * `ResultGrid` feeds it a backend result.
 */
export function DataGrid({
  source,
  sourceKey,
  label,
  footer,
  emptyText,
  copyExtras,
  onSelectionSize,
  onSelectionRange,
  onExport,
  sort,
  editing,
  apiRef,
  menuExtras,
  initialLayout,
  onLayoutChange,
  readOnly,
  cellOverlays,
  onHoverCell,
  onFocusChange,
}: DataGridProps) {
  const t = useT();
  const nullText = usePreference('nullText');
  const locale = useI18nStore((state) => state.locale);
  const focusId = `${useId()}-focus`;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const guttersRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GridBody | null>(null);
  const snapshot = useRef<Snapshot | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const drawnCols = useRef<Range>({ start: 0, end: 0 });
  const fitted = useRef(false);
  const resized = useRef(new Set<number>());
  const revealRef = useRef<CellPos | null>(null);
  const initialLayoutRef = useRef(initialLayout);
  // Widths follow the rows that load while scrolling (see `columnGrowth.ts`): measured once the
  // scroll settles, so the columns never move under a gesture.
  const extents = useRef<ColumnExtents>(createExtents(source.columns.length));
  const lastScrollAt = useRef(-Infinity);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const widthsRef = useRef<number[]>([]);
  const scrollShift = useRef(0);
  const hovered = useRef<string | null>(null);

  const [metrics, setMetrics] = useState<GridMetrics | null>(null);
  const [order, setOrder] = useState<number[]>(() => source.columns.map((_, i) => i));
  const [widths, setWidths] = useState<number[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [colsStore] = useState(createRangeStore);
  const [menuColumn, setMenuColumn] = useState<number | null>(null);
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const rowCount = useSyncExternalStore(subscribe, () => source.rowCount);
  const copy = useGridCopy(source, copyExtras);
  const colCount = order.length;

  const gutter = metrics ? Math.max(metrics.gutterMinWidth, gutterWidthFor(rowCount, metrics)) : 0;
  const lefts = useMemo(
    () => columnLefts(order.map((dataCol) => widths[dataCol] ?? 0)),
    [order, widths],
  );
  const layout = useMemo<BodyLayout | null>(
    () =>
      metrics && widths.length === source.columns.length
        ? { order, lefts, gutterWidth: gutter, rowHeight: metrics.rowHeight }
        : null,
    [metrics, widths.length, source.columns.length, order, lefts, gutter],
  );
  const domHeight = metrics ? verticalMetrics(rowCount, metrics.rowHeight, 0).domHeight : 0;
  const totalWidth = gutter + (lefts[lefts.length - 1] ?? 0);

  /** Draws the visible rows for the current scroll position; cheap enough for every frame. */
  const paint = useCallback(() => {
    const s = snapshot.current;
    const el = scrollerRef.current;
    const body = rendererRef.current;
    if (!s || !el || !body) return;
    const bodyHeight = Math.max(0, s.viewport.height - s.metrics.headerHeight);
    const m = verticalMetrics(s.rowCount, s.layout.rowHeight, bodyHeight);
    const top = virtualTop(el.scrollTop, m);
    const rows = visibleRows(top, bodyHeight, s.layout.rowHeight, s.rowCount, OVERSCAN_ROWS);
    const visible = holdRange(
      drawnCols.current,
      visibleColumns(s.layout.lefts, el.scrollLeft, s.viewport.width - s.layout.gutterWidth, 0),
      COLUMN_BATCH,
      s.layout.lefts.length - 1,
    );
    drawnCols.current = visible;
    body.render({
      rows,
      cols: visible,
      shift: top - el.scrollTop,
      layout: s.layout,
      selection: s.selection,
    });
    s.source.request(rows.start, rows.end);
    colsStore.set(visible);
  }, [colsStore]);

  /** Width that fits a column's header and its loaded values. */
  const fittedWidth = useCallback(
    (dataCol: number, m: GridMetrics) => {
      const column = source.columns[dataCol];
      if (!column) return m.minWidth;
      let longest = 0;
      let rows = 0;
      for (const block of source.loaded()) {
        const values = block.columns[dataCol];
        if (!values) continue;
        for (let i = 0; i < block.rowCount && rows < AUTO_FIT_ROWS; i++, rows++) {
          const kind = values.kinds?.[i] ?? column.kind;
          longest = Math.max(longest, displayLength(values.values[i] ?? null, kind, nullText));
        }
      }
      return fitWidth(longest, m.headerWidth(column.name, column.typeName, headerIcons(column)), m);
    },
    [source, nullText],
  );

  /** Widens the columns a newly loaded window does not fit in; leaves the user's widths alone. */
  const widenToLoaded = useCallback(
    (s: Snapshot) => {
      if (!measureLoaded(s.source, extents.current, nullText)) return;
      const current = widthsRef.current;
      const headers = s.source.columns.map((c) =>
        s.metrics.headerWidth(c.name, c.typeName, headerIcons(c)),
      );
      const next = widenColumns(current, extents.current, headers, resized.current, s.metrics);
      if (next === current) return;
      // Columns wholly left of the viewport push the rest to the right: scroll by as much.
      const left = scrollerRef.current?.scrollLeft ?? 0;
      let shift = 0;
      s.layout.order.forEach((dataCol, i) => {
        if ((s.layout.lefts[i + 1] ?? 0) <= left)
          shift += (next[dataCol] ?? 0) - (current[dataCol] ?? 0);
      });
      scrollShift.current = shift;
      setWidths(next);
    },
    [nullText],
  );

  const schedulePaint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      // The first rows replace the widths guessed from the types by widths that fit them
      // (once, and not for a column the user already resized).
      const s = snapshot.current;
      if (!fitted.current && s?.source.block(0)) {
        fitted.current = true;
        measureLoaded(s.source, extents.current, nullText);
        const m = s.metrics;
        setWidths((all) =>
          all.map((w, dataCol) => (resized.current.has(dataCol) ? w : fittedWidth(dataCol, m))),
        );
      } else if (fitted.current && s && performance.now() - lastScrollAt.current >= SETTLE_MS) {
        widenToLoaded(s);
      }
      paint();
    });
  }, [paint, fittedWidth, widenToLoaded, nullText]);

  // A font preference changed under a grid on screen: the columns the user did not size follow.
  const refit = useRef<(m: GridMetrics) => void>(() => undefined);
  useEffect(() => {
    refit.current = (m) => {
      setWidths((all) =>
        all.map((width, dataCol) => {
          const column = source.columns[dataCol];
          if (resized.current.has(dataCol) || !column) return width;
          return fitted.current
            ? fittedWidth(dataCol, m)
            : initialWidth(
                column.kind,
                m.headerWidth(column.name, column.typeName, headerIcons(column)),
                m,
              );
        }),
      );
    };
  }, [source, fittedWidth]);

  // Sizes come from the theme's tokens and the loaded fonts: read them from the DOM.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const read = readGridMetrics(el);
    const fontsOf = (m: GridMetrics) =>
      `${String(m.charWidth)} ${String(m.headerWidth('id', 'int'))}`;
    let fonts = fontsOf(read);
    extents.current = createExtents(source.columns.length);
    setMetrics(read);
    const saved = initialLayoutRef.current;
    setWidths(
      source.columns.map((c, dataCol) => {
        const width = saved?.widths[c.name];
        if (width !== undefined && Number.isFinite(width)) {
          resized.current.add(dataCol);
          return Math.max(read.minWidth, Math.round(width));
        }
        return initialWidth(c.kind, read.headerWidth(c.name, c.typeName, headerIcons(c)), read);
      }),
    );
    if (saved && saved.order.length > 0) {
      const byName = new Map(source.columns.map((c, i) => [c.name, i]));
      const known = saved.order
        .map((name) => byName.get(name))
        .filter((i): i is number => i !== undefined);
      const rest = source.columns.map((_, i) => i).filter((i) => !known.includes(i));
      setOrder([...known, ...rest]);
    }
    let live = true;
    const reread = () => {
      if (!live || !scrollerRef.current) return;
      const next = readGridMetrics(scrollerRef.current);
      setMetrics(next);
      const nextFonts = fontsOf(next);
      if (nextFonts !== fonts) {
        fonts = nextFonts;
        refit.current(next);
      }
    };
    void document.fonts.ready.then(reread);
    // The density and font preferences change the row height and font tokens.
    const observer = new MutationObserver(reread);
    observer.observe(document.documentElement, { attributeFilter: ['data-density', 'style'] });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [source]);

  useLayoutEffect(() => {
    const container = bodyRef.current;
    const gutters = guttersRef.current;
    const grid = scrollerRef.current;
    if (!container || !gutters || !grid) return;
    const body = new GridBody({
      container,
      gutters,
      grid,
      source,
      focusId,
      classes: {
        row: styles.row ?? '',
        placeholder: styles.placeholder ?? '',
        gutter: styles.gutterCell ?? '',
        cell: styles.cell ?? '',
        num: styles.num ?? '',
        null: styles.null ?? '',
        empty: styles.empty ?? '',
        mark: styles.mark ?? '',
      },
      labels: { null: getPreference('nullText'), empty: '' },
    });
    rendererRef.current = body;
    return () => {
      rendererRef.current = null;
      body.destroy();
    };
  }, [source, focusId]);

  // Every render: hand the latest state to the scroll path, then draw.
  useLayoutEffect(() => {
    widthsRef.current = widths;
    if (scrollShift.current !== 0 && scrollerRef.current) {
      scrollerRef.current.scrollLeft += scrollShift.current;
      scrollShift.current = 0;
    }
    rendererRef.current?.setLabels({
      null: nullText,
      empty: t('grid.empty'),
      default: t('grid.default'),
      required: t('grid.required'),
    });
    if (!metrics || !layout) {
      snapshot.current = null;
      return;
    }
    snapshot.current = {
      source,
      metrics,
      layout,
      selection,
      rowCount,
      viewport,
    };
    paint();
    const pending = revealRef.current;
    if (pending && pending.row < rowCount) {
      revealRef.current = null;
      reveal(pending);
    }
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    const onScroll = () => {
      lastScrollAt.current = performance.now();
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(schedulePaint, SETTLE_MS + 10);
    };
    el.addEventListener('scroll', paint, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    const unsubscribe = source.subscribe(schedulePaint);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', paint);
      el.removeEventListener('scroll', onScroll);
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [paint, schedulePaint, source]);

  const hitTest = useCallback((clientX: number, clientY: number, clamp: boolean): Hit => {
    const el = scrollerRef.current;
    const s = snapshot.current;
    if (!el || !s) return { area: 'none' };
    const rect = el.getBoundingClientRect();
    let x = clientX - rect.left - el.clientLeft;
    let y = clientY - rect.top - el.clientTop;
    if (!clamp && (x < 0 || y < 0 || x >= el.clientWidth || y >= el.clientHeight)) {
      return { area: 'none' };
    }
    x = Math.max(0, Math.min(el.clientWidth - 1, x));
    y = Math.max(0, Math.min(el.clientHeight - 1, y));
    const { layout: l, metrics: m } = s;
    const contentX = el.scrollLeft + x - l.gutterWidth;
    const total = l.lefts[l.lefts.length - 1] ?? 0;
    const col = columnAt(l.lefts, Math.min(contentX, total - 1));
    if (y < m.headerHeight && !clamp) {
      if (x < l.gutterWidth) return { area: 'corner' };
      return contentX < total ? { area: 'header', col } : { area: 'none' };
    }
    if (s.rowCount === 0) return { area: 'none' };
    const bodyHeight = Math.max(0, s.viewport.height - m.headerHeight);
    const top = virtualTop(el.scrollTop, verticalMetrics(s.rowCount, l.rowHeight, bodyHeight));
    const row = Math.max(
      0,
      Math.min(s.rowCount - 1, Math.floor((top + y - m.headerHeight) / l.rowHeight)),
    );
    if (x < l.gutterWidth && !clamp) return { area: 'gutter', row };
    if (contentX >= total && !clamp) return { area: 'none' };
    return { area: 'cell', row, col };
  }, []);

  /** Scrolls the least needed so the cell is fully visible. */
  const reveal = useCallback((pos: CellPos) => {
    const el = scrollerRef.current;
    const s = snapshot.current;
    if (!el || !s) return;
    const { layout: l, metrics: m } = s;
    const bodyHeight = Math.max(0, el.clientHeight - m.headerHeight);
    const vm = verticalMetrics(s.rowCount, l.rowHeight, bodyHeight);
    const top = virtualTop(el.scrollTop, vm);
    const rowTop = pos.row * l.rowHeight;
    const nextTop = scrollToInclude(top, bodyHeight, rowTop, rowTop + l.rowHeight);
    if (nextTop !== top) el.scrollTop = scrollTopFor(nextTop, vm);
    const left = el.scrollLeft;
    const nextLeft = scrollToInclude(
      left,
      el.clientWidth - l.gutterWidth,
      l.lefts[pos.col] ?? 0,
      l.lefts[pos.col + 1] ?? 0,
    );
    if (nextLeft !== left) el.scrollLeft = nextLeft;
  }, []);

  const dragTo = useCallback(
    (drag: Drag) => {
      const hit = hitTest(drag.x, drag.y, true);
      if (hit.area !== 'cell') return;
      setSelection((sel) => {
        if (!sel) return sel;
        if (drag.kind === 'rows') return selectRows(sel, hit.row, 'extend');
        const { focus } = sel;
        if (focus.row === hit.row && focus.col === hit.col) return sel;
        return extendTo(sel, { row: hit.row, col: hit.col });
      });
    },
    [hitTest],
  );

  /** Keeps scrolling while a drag selection is held past an edge. */
  const autoScroll = useCallback(() => {
    const drag = dragRef.current;
    const el = scrollerRef.current;
    const s = snapshot.current;
    if (!drag || !el || !s) return;
    const rect = el.getBoundingClientRect();
    const x = drag.x - rect.left;
    const y = drag.y - rect.top;
    const over = (value: number, min: number, max: number) =>
      value < min ? value - min : value > max ? value - max : 0;
    const dx = over(x, s.layout.gutterWidth, el.clientWidth);
    const dy = over(y, s.metrics.headerHeight, el.clientHeight);
    if (dx === 0 && dy === 0) {
      drag.frame = null;
      return;
    }
    el.scrollLeft += dx * AUTO_SCROLL_RATE;
    el.scrollTop += dy * AUTO_SCROLL_RATE;
    dragTo(drag);
    drag.frame = requestAnimationFrame(autoScroll);
  }, [dragTo]);

  const endDrag = () => {
    const drag = dragRef.current;
    if (drag?.frame != null) cancelAnimationFrame(drag.frame);
    dragRef.current = null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!el || event.button !== 0 || notOnGrid(event)) return;
    const hit = hitTest(event.clientX, event.clientY, false);
    if (hit.area === 'none') return;
    el.focus({ preventScroll: true });
    // The header handles its own clicks (select, drag, resize).
    if (hit.area === 'header' || hit.area === 'corner') return;
    event.preventDefault();
    const mode = selectModeOf(event);
    if (hit.area === 'gutter') {
      setSelection((sel) => selectRows(sel, hit.row, mode));
    } else {
      const pos = { row: hit.row, col: hit.col };
      const cell = { row: hit.row, dataCol: order[hit.col] ?? hit.col };
      if (editing?.onCellPointerDown?.(cell, event)) {
        setSelection(cellSelection(pos));
        return;
      }
      setSelection((sel) => {
        if (sel && mode === 'extend') return extendTo(sel, pos);
        if (sel && mode === 'add') return addCell(sel, pos);
        return cellSelection(pos);
      });
    }
    el.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: hit.area === 'gutter' ? 'rows' : 'cells',
      x: event.clientX,
      y: event.clientY,
      frame: null,
    };
  };

  const hover = (cell: GridCellRef | null) => {
    const id = cell ? `${String(cell.row)}:${String(cell.dataCol)}` : null;
    if (id === hovered.current) return;
    hovered.current = id;
    onHoverCell?.(cell);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      if (!onHoverCell || notOnGrid(event)) return;
      const hit = hitTest(event.clientX, event.clientY, false);
      hover(hit.area === 'cell' ? { row: hit.row, dataCol: order[hit.col] ?? hit.col } : null);
      return;
    }
    if ((event.buttons & 1) === 0) {
      endDrag();
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    dragTo(drag);
    if (drag.frame === null) drag.frame = requestAnimationFrame(autoScroll);
  };

  const toggleViewer = useCallback(() => {
    setViewerOpen((open) => !open);
  }, []);

  const selectColumn = useCallback((col: number, mode: SelectMode) => {
    setSelection((sel) => selectCols(sel, col, mode));
  }, []);

  const runCopy = useCallback(
    (format: CopyFormat, headers: boolean) => {
      void copy(snapshot.current?.selection ?? null, order, format, headers);
    },
    [copy, order],
  );

  const autoFit = useCallback(
    (col: number) => {
      const s = snapshot.current;
      if (!s) return;
      const dataCol = order[col] ?? col;
      const width = fittedWidth(dataCol, s.metrics);
      resized.current.add(dataCol);
      setWidths((all) => all.map((w, i) => (i === dataCol ? width : w)));
    },
    [order, fittedWidth],
  );

  const moveColumn = useCallback((from: number, to: number) => {
    setOrder((current) => moveItem(current, from, to));
    setSelection((sel) => afterColumnMove(sel, from, to));
  }, []);

  // The viewer narrows the grid: keep the focused cell in sight.
  useEffect(() => {
    if (!viewerOpen) return;
    const frame = requestAnimationFrame(() => {
      const focus = snapshot.current?.selection?.focus;
      if (focus) reveal(focus);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [viewerOpen, reveal]);

  const focusRef = (): GridCellRef | null =>
    selection && rowCount > 0
      ? { row: selection.focus.row, dataCol: order[selection.focus.col] ?? selection.focus.col }
      : null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = snapshot.current;
    // Keys typed in an editor over a cell are the editor's.
    if (!s || event.target !== event.currentTarget) return;
    if (editing?.onKeyDown?.(event, focusRef())) return;
    if (event.altKey) return;
    const bounds = { rowCount, colCount };
    const mod = modKey(event);
    if (matchShortcut(event, 'Mod+C') || matchShortcut(event, 'Mod+Shift+C')) {
      event.preventDefault();
      runCopy('tsv', event.shiftKey);
      return;
    }
    if (matchShortcut(event, 'Mod+A')) {
      event.preventDefault();
      if (rowCount > 0) setSelection((sel) => selectAll(sel));
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      if (!mod && !event.shiftKey) {
        toggleViewer();
      } else if (selection && rowCount > 0) {
        // Shift+Space: the whole rows of the selection; Mod+Space: its whole columns.
        const { anchor, focus } = selection;
        setSelection(
          event.shiftKey
            ? selectRows(selectRows(selection, anchor.row, 'replace'), focus.row, 'extend')
            : selectCols(selectCols(selection, anchor.col, 'replace'), focus.col, 'extend'),
        );
      }
      return;
    }
    if (event.key === 'Escape') {
      if (viewerOpen) {
        event.preventDefault();
        setViewerOpen(false);
      } else if (selection && selection.ranges.length > 0) {
        setSelection(cellSelection(selection.focus));
      }
      return;
    }
    if (rowCount === 0 || colCount === 0) return;
    const bodyHeight = Math.max(0, s.viewport.height - s.metrics.headerHeight);
    const page = Math.max(1, Math.floor(bodyHeight / s.layout.rowHeight) - 1);
    const current = selection ?? cellSelection({ row: 0, col: 0 });
    const { focus } = current;
    const extend = event.shiftKey;
    const lastRow = rowCount - 1;
    const lastCol = colCount - 1;
    let next: Selection;
    switch (event.key) {
      case 'ArrowDown':
        next = mod
          ? moveFocusTo(current, { row: lastRow, col: focus.col }, extend, bounds)
          : moveFocus(current, 1, 0, extend, bounds);
        break;
      case 'ArrowUp':
        next = mod
          ? moveFocusTo(current, { row: 0, col: focus.col }, extend, bounds)
          : moveFocus(current, -1, 0, extend, bounds);
        break;
      case 'ArrowRight':
        next = mod
          ? moveFocusTo(current, { row: focus.row, col: lastCol }, extend, bounds)
          : moveFocus(current, 0, 1, extend, bounds);
        break;
      case 'ArrowLeft':
        next = mod
          ? moveFocusTo(current, { row: focus.row, col: 0 }, extend, bounds)
          : moveFocus(current, 0, -1, extend, bounds);
        break;
      case 'PageDown':
        next = moveFocus(current, page, 0, extend, bounds);
        break;
      case 'PageUp':
        next = moveFocus(current, -page, 0, extend, bounds);
        break;
      case 'Home':
        next = moveFocusTo(current, { row: mod ? 0 : focus.row, col: 0 }, extend, bounds);
        break;
      case 'End':
        next = moveFocusTo(
          current,
          { row: mod ? lastRow : focus.row, col: lastCol },
          extend,
          bounds,
        );
        break;
      default:
        return;
    }
    event.preventDefault();
    // The first key press on a grid without selection selects the first cell.
    const result = selection ? next : cellSelection({ row: 0, col: 0 });
    setSelection(result);
    reveal(result.focus);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (notOnGrid(event)) return;
    const hit = hitTest(event.clientX, event.clientY, false);
    setMenuColumn(hit.area === 'header' ? hit.col : null);
    if (hit.area === 'cell' && !isCellSelected(selection, hit.row, hit.col)) {
      setSelection(cellSelection({ row: hit.row, col: hit.col }));
    } else if (hit.area === 'gutter' && !isRowSelected(selection, hit.row)) {
      setSelection(selectRows(selection, hit.row, 'replace'));
    } else if (hit.area === 'header' && !isColSelected(selection, hit.col)) {
      setSelection(selectCols(selection, hit.col, 'replace'));
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (notOnGrid(event)) return;
    const hit = hitTest(event.clientX, event.clientY, false);
    if (hit.area !== 'cell') return;
    if (editing?.onCellDoubleClick?.({ row: hit.row, dataCol: order[hit.col] ?? hit.col })) return;
    setViewerOpen(true);
  };

  useImperativeHandle(
    apiRef,
    (): DataGridApi => ({
      selection: () => snapshot.current?.selection ?? null,
      order: () => order,
      focusCell: ({ row, dataCol }) => {
        const pos = { row, col: Math.max(0, order.indexOf(dataCol)) };
        setSelection(cellSelection(pos));
        revealRef.current = pos;
      },
      selectRows: (from, to) => {
        setSelection(selectRows(selectRows(null, from, 'replace'), to, 'extend'));
        revealRef.current = { row: from, col: 0 };
      },
      focus: () => {
        scrollerRef.current?.focus({ preventScroll: true });
      },
    }),
    [order],
  );

  useEffect(() => {
    if (!onLayoutChange || widths.length !== source.columns.length) return;
    const named: Record<string, number> = {};
    source.columns.forEach((column, dataCol) => {
      const width = widths[dataCol];
      if (width !== undefined && resized.current.has(dataCol)) named[column.name] = width;
    });
    onLayoutChange({
      widths: named,
      order: order.map((dataCol) => source.columns[dataCol]?.name ?? ''),
    });
  }, [onLayoutChange, widths, order, source]);

  const editor = editing?.editor ?? null;
  const editorCol = editor ? order.indexOf(editor.dataCol) : -1;
  const editorRow = editor?.row ?? -1;
  useEffect(() => {
    if (editorRow >= 0 && editorCol >= 0) reveal({ row: editorRow, col: editorCol });
  }, [editorRow, editorCol, reveal]);

  const rowsSelected = countRows(selectedRowIntervals(selection, rowCount));
  const colsSelected = selectedColumns(selection, colCount).length;
  const number = new Intl.NumberFormat(locale);
  const hasSelection = rowsSelected * colsSelected > 0;
  useEffect(() => {
    onSelectionSize?.(hasSelection ? { rows: rowsSelected, cols: colsSelected } : null);
  }, [onSelectionSize, hasSelection, rowsSelected, colsSelected]);
  useEffect(() => {
    const only = selection?.ranges.length === 1 ? selection.ranges[0] : undefined;
    if (!only || rowCount === 0 || colCount === 0) {
      onSelectionRange?.(null);
      return;
    }
    const columns: number[] = [];
    for (let c = only.c0; c <= Math.min(only.c1, colCount - 1); c++) {
      const dataCol = order[c];
      if (dataCol !== undefined) columns.push(dataCol);
    }
    onSelectionRange?.({
      rowFrom: only.r0,
      rowTo: Math.min(only.r1, rowCount - 1),
      columns,
    });
  }, [onSelectionRange, selection, rowCount, colCount, order]);
  const focusCell =
    selection && rowCount > 0
      ? { row: selection.focus.row, col: order[selection.focus.col] ?? selection.focus.col }
      : null;
  const focusRow = focusCell?.row ?? -1;
  const focusDataCol = focusCell?.col ?? -1;
  useEffect(() => {
    onFocusChange?.(focusRow < 0 ? null : { row: focusRow, dataCol: focusDataCol });
  }, [onFocusChange, focusRow, focusDataCol]);

  return (
    <div className={styles.grid}>
      <div className={styles.main}>
        <ContextMenu
          content={
            <GridMenu
              hasSelection={!!selection && rowCount > 0}
              viewerOpen={viewerOpen}
              onCopy={runCopy}
              onSelectAll={() => {
                setSelection((sel) => selectAll(sel));
              }}
              onViewCell={toggleViewer}
              onExport={onExport}
              extras={menuExtras}
              onAutoFit={
                menuColumn === null
                  ? null
                  : () => {
                      autoFit(menuColumn);
                    }
              }
            />
          }
        >
          <div
            ref={scrollerRef}
            className={styles.scroller}
            role="grid"
            aria-label={label}
            aria-rowcount={rowCount + 1}
            aria-colcount={colCount}
            aria-multiselectable="true"
            aria-readonly={readOnly || undefined}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => {
              if (!dragRef.current) hover(null);
            }}
            onKeyDown={onKeyDown}
            onFocus={(event) => {
              // Reached with Tab: show where the keyboard is.
              if (
                event.target === event.currentTarget &&
                !selection &&
                rowCount > 0 &&
                event.currentTarget.matches(':focus-visible')
              ) {
                setSelection(cellSelection({ row: 0, col: 0 }));
              }
            }}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            onPaste={(event) => {
              if (!editing?.onPaste || event.target !== event.currentTarget) return;
              event.preventDefault();
              editing.onPaste(event.clipboardData.getData('text/plain'), focusRef());
            }}
          >
            <div className={styles.sizer} style={{ width: totalWidth }}>
              {layout && metrics && (
                <GridHeader
                  columns={source.columns}
                  order={order}
                  lefts={lefts}
                  widths={widths}
                  gutterWidth={gutter}
                  cols={colsStore}
                  selection={selection}
                  minWidth={metrics.minWidth}
                  onSelectAll={() => {
                    if (rowCount > 0) setSelection((sel) => selectAll(sel));
                  }}
                  onSelectColumn={selectColumn}
                  onResize={(dataCol, width) => {
                    resized.current.add(dataCol);
                    setWidths((all) => all.map((w, i) => (i === dataCol ? width : w)));
                  }}
                  onAutoFit={autoFit}
                  onMove={moveColumn}
                  sort={sort}
                />
              )}
              <div
                className={styles.body}
                style={
                  {
                    width: totalWidth,
                    height: domHeight,
                    '--gutter': `${String(gutter)}px`,
                  } as CSSProperties
                }
              >
                <div ref={guttersRef} className={styles.gutters} aria-hidden="true" />
                <div ref={bodyRef} role="rowgroup" className={styles.rows} />
                {editor && metrics && editorCol >= 0 && (
                  // Rows past the scroll height cap are shifted; a page (≤ 50 000 rows) never is.
                  <div
                    data-grid-editor=""
                    className={styles.editorLayer}
                    style={{
                      top: editor.row * metrics.rowHeight,
                      left: gutter + (lefts[editorCol] ?? 0),
                      width: (lefts[editorCol + 1] ?? 0) - (lefts[editorCol] ?? 0),
                      minHeight: metrics.rowHeight,
                    }}
                  >
                    {editor.node}
                  </div>
                )}
                {metrics &&
                  cellOverlays?.map((overlay) => {
                    const col = order.indexOf(overlay.dataCol);
                    if (col < 0 || overlay.row >= rowCount) return null;
                    return (
                      <div
                        key={overlay.key}
                        data-grid-overlay=""
                        data-align={overlay.align ?? 'end'}
                        className={styles.cellOverlay}
                        style={{
                          top: overlay.row * metrics.rowHeight,
                          left: gutter + (lefts[col] ?? 0),
                          width: (lefts[col + 1] ?? 0) - (lefts[col] ?? 0),
                          height: metrics.rowHeight,
                        }}
                      >
                        {overlay.node}
                      </div>
                    );
                  })}
              </div>
            </div>
            {rowCount === 0 && emptyText && <div className={styles.emptyRows}>{emptyText}</div>}
          </div>
        </ContextMenu>
        {viewerOpen && (
          <CellViewer
            source={source}
            sourceKey={sourceKey}
            target={focusCell}
            onClose={() => {
              setViewerOpen(false);
              scrollerRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
      <div className={styles.footer}>
        <div className={styles.footerStart}>{footer}</div>
        {rowsSelected * colsSelected > 1 && (
          <span className={styles.selectionInfo}>
            {t('grid.selection', {
              rows: number.format(rowsSelected),
              cols: number.format(colsSelected),
            })}
          </span>
        )}
        <IconButton
          icon="panelRight"
          size="sm"
          label={viewerOpen ? t('grid.viewer.hide') : t('grid.viewer.show')}
          shortcut="Space"
          aria-pressed={viewerOpen}
          onClick={toggleViewer}
        />
      </div>
    </div>
  );
}

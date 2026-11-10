import {
  useCallback,
  useEffect,
  useId,
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
} from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { IconButton } from '../../ui/IconButton';
import { matchShortcut } from '../../ui/shortcuts';
import { displayLength } from './cellDisplay';
import { CellViewer } from './CellViewer';
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
import { GridHeader } from './GridHeader';
import { GridMenu } from './GridMenu';
import { readGridMetrics, type GridMetrics } from './gridMetrics';
import { modKey, selectModeOf } from './modifiers';
import { createRangeStore } from './rangeStore';
import type { RowSource } from './rowSource';
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
}: DataGridProps) {
  const t = useT();
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
          longest = Math.max(longest, displayLength(values.values[i] ?? null, kind, 'NULL'));
        }
      }
      return fitWidth(longest, m.headerWidth(column.name, column.typeName), m);
    },
    [source],
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
        const m = s.metrics;
        setWidths((all) =>
          all.map((w, dataCol) => (resized.current.has(dataCol) ? w : fittedWidth(dataCol, m))),
        );
      }
      paint();
    });
  }, [paint, fittedWidth]);

  // Sizes come from the theme's tokens and the loaded fonts: read them from the DOM.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const read = readGridMetrics(el);
    setMetrics(read);
    setWidths(
      source.columns.map((c) => initialWidth(c.kind, read.headerWidth(c.name, c.typeName), read)),
    );
    let live = true;
    void document.fonts.ready.then(() => {
      if (live && scrollerRef.current) setMetrics(readGridMetrics(scrollerRef.current));
    });
    // The density preference changes the row height tokens.
    const observer = new MutationObserver(() => {
      if (scrollerRef.current) setMetrics(readGridMetrics(scrollerRef.current));
    });
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
      labels: { null: 'NULL', empty: '' },
    });
    rendererRef.current = body;
    return () => {
      rendererRef.current = null;
      body.destroy();
    };
  }, [source, focusId]);

  // Every render: hand the latest state to the scroll path, then draw.
  useLayoutEffect(() => {
    rendererRef.current?.setLabels({ null: 'NULL', empty: t('grid.empty') });
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
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    el.addEventListener('scroll', paint, { passive: true });
    const unsubscribe = source.subscribe(schedulePaint);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', paint);
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
    if (!el || event.button !== 0) return;
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

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = snapshot.current;
    if (!s || event.altKey) return;
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
    if (hitTest(event.clientX, event.clientY, false).area === 'cell') setViewerOpen(true);
  };

  const rowsSelected = countRows(selectedRowIntervals(selection, rowCount));
  const colsSelected = selectedColumns(selection, colCount).length;
  const number = new Intl.NumberFormat(locale);
  const hasSelection = rowsSelected * colsSelected > 0;
  useEffect(() => {
    onSelectionSize?.(hasSelection ? { rows: rowsSelected, cols: colsSelected } : null);
  }, [onSelectionSize, hasSelection, rowsSelected, colsSelected]);
  const focusCell =
    selection && rowCount > 0
      ? { row: selection.focus.row, col: order[selection.focus.col] ?? selection.focus.col }
      : null;

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
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
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

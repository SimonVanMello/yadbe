import {
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { dropIndex, gapAt } from './gridMath';
import styles from './DataGrid.module.css';
import type { GridColumn } from './rowSource';
import { selectModeOf } from './modifiers';
import type { RangeStore } from './rangeStore';
import { colTouched, isColSelected, type Selection, type SelectMode } from './selection';

/** Header sorting (table tabs, F-081): a click sorts by a column, `Shift`+click adds it. */
export interface HeaderSort {
  /** The sort, first key first (data columns). */
  keys: readonly { dataCol: number; direction: 'asc' | 'desc' }[];
  onSort: (dataCol: number, additive: boolean) => void;
}

/** Pointer travel before a press on a header becomes a column drag. */
const DRAG_THRESHOLD_PX = 4;

interface GridHeaderProps {
  columns: readonly GridColumn[];
  order: readonly number[];
  lefts: Float64Array;
  widths: readonly number[];
  gutterWidth: number;
  /** The visible columns, updated by the scroll path. */
  cols: RangeStore;
  selection: Selection | null;
  minWidth: number;
  onSelectAll: () => void;
  onSelectColumn: (col: number, mode: SelectMode) => void;
  onResize: (dataCol: number, width: number) => void;
  onAutoFit: (col: number) => void;
  onMove: (from: number, to: number) => void;
  /** Present: a click sorts (`Mod`+click still selects the column). */
  sort?: HeaderSort;
}

/**
 * The header row: sticky at the top of the scroller, its cells placed at the same x as the
 * body's so both scroll together natively. Click selects a column, drag moves it, the right
 * edge resizes it (double-click: fit to content).
 */
export function GridHeader({
  columns,
  order,
  lefts,
  widths,
  gutterWidth,
  cols: colsStore,
  selection,
  minWidth,
  onSelectAll,
  onSelectColumn,
  onResize,
  onAutoFit,
  onMove,
  sort,
}: GridHeaderProps) {
  const t = useT();
  const cols = useSyncExternalStore(colsStore.subscribe, colsStore.get);
  const rowRef = useRef<HTMLDivElement>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const press = useRef<{ col: number; x: number; drag: boolean } | null>(null);

  const contentX = (event: ReactPointerEvent) => {
    const rect = rowRef.current?.getBoundingClientRect();
    return event.clientX - (rect?.left ?? 0) - gutterWidth;
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, dataCol: number) => {
    event.stopPropagation();
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = widths[dataCol] ?? minWidth;
    const move = (e: PointerEvent) => {
      onResize(dataCol, Math.max(minWidth, Math.round(startWidth + e.clientX - startX)));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const cells = [];
  for (let col = cols.start; col < cols.end; col++) {
    const dataCol = order[col] ?? col;
    const column = columns[dataCol];
    if (!column) continue;
    const left = gutterWidth + (lefts[col] ?? 0);
    const width = (lefts[col + 1] ?? 0) - (lefts[col] ?? 0);
    const selected = isColSelected(selection, col);
    const touched = !selected && colTouched(selection, col);
    const sortIndex = sort ? sort.keys.findIndex((key) => key.dataCol === dataCol) : -1;
    const sortKey = sort?.keys[sortIndex];
    const readOnly = !!column.readOnlyReason;
    cells.push(
      <div
        key={dataCol}
        role="columnheader"
        aria-colindex={col + 1}
        aria-selected={selected}
        aria-sort={
          sort && sortIndex === 0 && sortKey
            ? sortKey.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : undefined
        }
        aria-readonly={readOnly || undefined}
        title={[
          column.typeName ? `${column.name} · ${column.typeName}` : column.name,
          ...(column.readOnlyReason ? [column.readOnlyReason] : []),
          ...(sort ? [t('grid.sort.hint')] : []),
        ].join('\n')}
        className={[
          styles.headerCell,
          readOnly ? styles.headerReadOnly : '',
          selected ? styles.headerSelected : '',
          touched ? styles.headerTouched : '',
          dragging === col ? styles.headerDragging : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ left, width }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          press.current = { col, x: event.clientX, drag: false };
        }}
        onPointerMove={(event) => {
          const current = press.current;
          if (!current || current.col !== col) return;
          if (!current.drag) {
            if (Math.abs(event.clientX - current.x) < DRAG_THRESHOLD_PX) return;
            if (event.shiftKey || event.metaKey || event.ctrlKey) return;
            current.drag = true;
            setDragging(col);
          }
          setDropGap(gapAt(lefts, contentX(event)));
        }}
        onPointerUp={(event) => {
          const current = press.current;
          press.current = null;
          setDragging(null);
          setDropGap(null);
          if (!current || current.col !== col) return;
          if (current.drag) {
            const to = dropIndex(col, gapAt(lefts, contentX(event)));
            if (to !== col) onMove(col, to);
          } else if (sort && !event.metaKey && !event.ctrlKey) {
            sort.onSort(dataCol, event.shiftKey);
          } else {
            onSelectColumn(col, sort ? 'add' : selectModeOf(event));
          }
        }}
        onPointerCancel={() => {
          press.current = null;
          setDragging(null);
          setDropGap(null);
        }}
      >
        {readOnly && <Icon name="lock" className={styles.headerIcon} />}
        <span className={styles.headerName}>{column.name}</span>
        {column.typeName && <span className={styles.headerType}>{column.typeName}</span>}
        {sortKey && (
          <span
            className={styles.headerSort}
            aria-label={t(sortKey.direction === 'asc' ? 'grid.sort.asc' : 'grid.sort.desc', {
              rank: sortIndex + 1,
            })}
          >
            <Icon name={sortKey.direction === 'asc' ? 'arrowUp' : 'arrowDown'} />
            {sort.keys.length > 1 && <span>{sortIndex + 1}</span>}
          </span>
        )}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('grid.column.resize', { name: column.name })}
          className={styles.resizeHandle}
          onPointerDown={(event) => {
            startResize(event, dataCol);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onAutoFit(col);
          }}
        />
      </div>,
    );
  }

  return (
    <div
      ref={rowRef}
      role="row"
      aria-rowindex={1}
      className={styles.header}
      style={{ width: gutterWidth + (lefts[lefts.length - 1] ?? 0) }}
    >
      <div
        aria-hidden="true"
        title={t('grid.menu.selectAll')}
        className={styles.corner}
        style={{ width: gutterWidth }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          onSelectAll();
        }}
      >
        #
      </div>
      {cells}
      {dropGap !== null && (
        <div
          className={styles.dropIndicator}
          style={{ left: gutterWidth + (lefts[dropGap] ?? 0) }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

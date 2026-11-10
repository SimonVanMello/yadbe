import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { TableDataInfo, Value } from '../../ipc';
import { matchShortcut } from '../../ui/shortcuts';
import {
  DataGrid,
  type ColumnLayout,
  type DataGridApi,
  type GridCellRef,
  type GridEditing,
} from '../grid/DataGrid';
import { formatCount } from '../grid/formatCount';
import { CellEditor } from './CellEditor';
import type { EditMove } from './cellEditorTypes';
import { isFiltered } from './filterModel';
import {
  cellBlock,
  explain,
  pasteText,
  registerEditorFlush,
  registerGrid,
  sortBy,
  writeCells,
} from './tableActions';
import { openTableExport } from './tableExport';
import { TableMenu } from './TableMenu';
import type { TableRowSource } from './tableRowSource';
import { useTableSelectionStore, useTableSessionStore } from './tableSessionStore';
import { getTableTabState, useTableTabStore } from './tableTabStore';
import styles from './TableView.module.css';

interface EditingCell extends GridCellRef {
  initial: Value;
  typed: string | null;
}

interface TableGridProps {
  tabId: string;
  info: TableDataInfo;
  source: TableRowSource;
  label: string;
}

/**
 * The grid of a table tab: the data grid over the tab's rows, with header sorting (F-081), cell
 * editors (F-082), paste, and the row actions in its menu (F-083). Memoized: the rest of the
 * view changing (counts, filter typing) does not re-render it, and typing in an editor only
 * renders the editor.
 */
export const TableGrid = memo(function TableGrid({ tabId, info, source, label }: TableGridProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const apiRef = useRef<DataGridApi | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const pasteAsRows = useRef(false);
  const lastWrite = useRef<Promise<void>>(Promise.resolve());
  const pageVersion = useTableSessionStore((state) => state.sessions[tabId]?.pageVersion ?? 0);
  const editVersion = useTableSessionStore((state) => state.sessions[tabId]?.editVersion ?? 0);
  const rowCount = useTableSessionStore((state) => state.sessions[tabId]?.page?.rowCount ?? 0);
  const durationMs = useTableSessionStore((state) => state.sessions[tabId]?.page?.durationMs);
  const pendingCount = useTableSessionStore((state) => state.sessions[tabId]?.pendingCount ?? 0);
  const sort = useTableTabStore((state) => state.tabs[tabId]?.sort);
  const filtered = useTableTabStore((state) => {
    const filter = state.tabs[tabId]?.filter;
    return filter ? isFiltered(filter) : false;
  });
  const [initialLayout] = useState(() => getTableTabState(tabId).layout ?? undefined);
  const editable = info.readOnlyReasons.length === 0;

  const setApi = useCallback(
    (api: DataGridApi | null) => {
      apiRef.current = api;
      registerGrid(tabId, api);
    },
    [tabId],
  );

  const startEdit = useCallback(
    async (cell: GridCellRef, typed: string | null) => {
      const block = cellBlock(tabId, cell.row, cell.dataCol);
      if (block) {
        explain(block);
        return;
      }
      const initial = await source.fullValue(cell.row, cell.dataCol);
      setEditing({ ...cell, initial, typed });
    },
    [tabId, source],
  );

  const close = useCallback(
    (cell: GridCellRef, move: EditMove) => {
      setEditing(null);
      const api = apiRef.current;
      if (!api) return;
      const order = api.order();
      const col = order.indexOf(cell.dataCol);
      let next = cell;
      if (move === 'down' && cell.row + 1 < source.rowCount) next = { ...cell, row: cell.row + 1 };
      else if (move === 'right' && col + 1 < order.length)
        next = { ...cell, dataCol: order[col + 1] ?? cell.dataCol };
      else if (move === 'left' && col > 0)
        next = { ...cell, dataCol: order[col - 1] ?? cell.dataCol };
      api.focusCell(next);
      api.focus();
    },
    [source],
  );

  useEffect(() => {
    registerEditorFlush(tabId, async () => {
      // Leaving the editor commits a valid value (its blur handler).
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-grid-editor]')) active.blur();
      await lastWrite.current;
    });
    return () => {
      registerEditorFlush(tabId, null);
    };
  }, [tabId]);

  useEffect(
    () => () => {
      registerGrid(tabId, null);
    },
    [tabId],
  );

  const editor = useMemo(() => {
    const column = editing ? info.columns[editing.dataCol] : undefined;
    if (!editing || !column) return null;
    return {
      row: editing.row,
      dataCol: editing.dataCol,
      node: (
        <CellEditor
          key={`${String(editing.row)}:${String(editing.dataCol)}`}
          column={column}
          initial={editing.initial}
          typed={editing.typed}
          label={t('tableData.editor.label', { column: column.name, row: editing.row + 1 })}
          onCommit={(value, move) => {
            lastWrite.current = writeCells(tabId, [
              { row: editing.row, dataCol: editing.dataCol, value },
            ]);
            close(editing, move);
          }}
          onCancel={() => {
            close(editing, 'none');
          }}
        />
      ),
    };
  }, [editing, info.columns, t, tabId, close]);

  const editingProps: GridEditing = useMemo(
    () => ({
      onKeyDown: (event, focus) => {
        // `Mod+Shift+V`: the paste that follows makes new rows.
        if (matchShortcut(event, 'Mod+Shift+V')) {
          pasteAsRows.current = true;
          return false;
        }
        if (!focus || event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          void startEdit(focus, null);
          return true;
        }
        if (event.key.length === 1 && event.key !== ' ') {
          event.preventDefault();
          void startEdit(focus, event.key);
          return true;
        }
        return false;
      },
      onCellDoubleClick: (cell) => {
        // A read-only table opens the cell viewer instead.
        if (!editable) return false;
        void startEdit(cell, null);
        return true;
      },
      onPaste: (text) => {
        const asRows = pasteAsRows.current;
        pasteAsRows.current = false;
        void pasteText(tabId, text, asRows);
      },
      editor,
    }),
    [startEdit, editable, tabId, editor],
  );

  const sortKeys = useMemo(
    () =>
      (sort ?? []).flatMap((key) => {
        const dataCol = info.columns.findIndex((c) => c.name === key.column);
        return dataCol < 0 ? [] : [{ dataCol, direction: key.direction }];
      }),
    [sort, info.columns],
  );
  const headerSort = useMemo(
    () => ({
      keys: sortKeys,
      onSort: (dataCol: number, additive: boolean) => {
        void sortBy(tabId, dataCol, additive);
      },
    }),
    [sortKeys, tabId],
  );

  const onLayoutChange = useCallback(
    (layout: ColumnLayout) => {
      useTableTabStore.getState().update(tabId, { layout });
    },
    [tabId],
  );
  const onSelectionSize = useCallback(
    (size: { rows: number; cols: number } | null) => {
      useTableSelectionStore.getState().report(tabId, size);
    },
    [tabId],
  );

  const footer = (
    <>
      <span>{formatCount(locale, 'grid.rows', rowCount)}</span>
      {durationMs !== null && durationMs !== undefined && (
        <span className={styles.muted}>
          {t('tableData.page.duration', { ms: Math.round(durationMs) })}
        </span>
      )}
      {pendingCount > 0 && (
        <span className={styles.pendingBadge} data-testid="table-pending">
          {t('tableData.pending', { count: pendingCount })}
        </span>
      )}
    </>
  );

  const onExport = useCallback(() => {
    openTableExport(tabId);
  }, [tabId]);

  return (
    <DataGrid
      source={source}
      sourceKey={`table-${tabId}-${String(pageVersion)}-${String(editVersion)}`}
      label={label}
      footer={footer}
      emptyText={filtered ? t('tableData.empty.filtered') : t('tableData.empty.table')}
      sort={headerSort}
      editing={editingProps}
      apiRef={setApi}
      menuExtras={<TableMenu tabId={tabId} editable={editable} />}
      onExport={onExport}
      initialLayout={initialLayout}
      onLayoutChange={onLayoutChange}
      onSelectionSize={onSelectionSize}
      readOnly={!editable}
    />
  );
});

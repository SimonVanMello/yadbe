import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useT } from '../../i18n/useT';
import type { ForeignKey, TableColumn, Value } from '../../ipc';
import { matchShortcut } from '../../ui/shortcuts';
import type { DataGridApi, GridCellRef, GridEditing } from '../grid/DataGrid';
import { modKey } from '../grid/modifiers';
import { CellEditor } from './CellEditor';
import type { EditMove } from './cellEditorTypes';
import { FkCellEditor } from './FkCellEditor';
import {
  cellBlock,
  explain,
  pasteText,
  registerEditorFlush,
  writeCells,
  type CellWrite,
} from './tableActions';
import type { TableRowSource } from './tableRowSource';

interface EditingCell extends GridCellRef {
  initial: Value;
  typed: string | null;
}

interface CellEditingOptions {
  /** The edit session (a table tab, or an editable query result). */
  tabId: string;
  columns: readonly TableColumn[];
  source: TableRowSource;
  apiRef: RefObject<DataGridApi | null>;
  /** Double-click edits; otherwise it opens the cell viewer. */
  editable: boolean;
  /** Foreign key navigation (table tabs, F-088): the key of a column, and where to go. */
  foreignKeys?: {
    of: (dataCol: number) => ForeignKey | undefined;
    connectionId: string | undefined;
    goTo: (cell: GridCellRef) => void;
  };
}

/**
 * The cell editing of an edit session's grid (F-082): `Enter`, `F2`, typing or a double-click
 * opens a type-aware editor (a lookup editor on a foreign key, F-088), its value goes into the
 * pending changes, and paste writes cells or adds rows. Shared by table tabs and editable query
 * results (F-087).
 */
export function useCellEditing({
  tabId,
  columns,
  source,
  apiRef,
  editable,
  foreignKeys,
}: CellEditingOptions): { editing: GridEditing; editingCell: GridCellRef | null } {
  const t = useT();
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const pasteAsRows = useRef(false);
  const lastWrite = useRef<Promise<void>>(Promise.resolve());

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
    [source, apiRef],
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

  const fkOf = foreignKeys?.of;
  const fkConnection = foreignKeys?.connectionId;
  const goTo = foreignKeys?.goTo;

  const editor = useMemo(() => {
    const column = editing ? columns[editing.dataCol] : undefined;
    if (!editing || !column) return null;
    const foreignKey = fkOf?.(editing.dataCol);
    const label = t('tableData.editor.label', { column: column.name, row: editing.row + 1 });
    const commit = (value: Value | undefined, move: EditMove) => {
      lastWrite.current = writeCells(tabId, [
        { row: editing.row, dataCol: editing.dataCol, value },
      ]);
      close(editing, move);
    };
    if (foreignKey && fkConnection) {
      return {
        row: editing.row,
        dataCol: editing.dataCol,
        node: (
          <FkCellEditor
            key={`${String(editing.row)}:${String(editing.dataCol)}`}
            column={column}
            initial={editing.initial}
            typed={editing.typed}
            label={label}
            tabId={tabId}
            connectionId={fkConnection}
            foreignKey={foreignKey}
            onCommit={commit}
            onChoose={(values, move) => {
              // A composite key fills its columns together; one that cannot be written says why.
              const writes: CellWrite[] = [];
              for (const { column: name, value } of values) {
                const dataCol = columns.findIndex((c) => c.name === name);
                const block = dataCol < 0 ? null : cellBlock(tabId, editing.row, dataCol);
                if (block) explain(block);
                else if (dataCol >= 0) writes.push({ row: editing.row, dataCol, value });
              }
              lastWrite.current = writeCells(tabId, writes);
              close(editing, move);
            }}
            onCancel={() => {
              close(editing, 'none');
            }}
          />
        ),
      };
    }
    return {
      row: editing.row,
      dataCol: editing.dataCol,
      node: (
        <CellEditor
          key={`${String(editing.row)}:${String(editing.dataCol)}`}
          column={column}
          initial={editing.initial}
          typed={editing.typed}
          label={label}
          onCommit={commit}
          onCancel={() => {
            close(editing, 'none');
          }}
        />
      ),
    };
  }, [editing, columns, t, tabId, close, fkOf, fkConnection]);

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
      onCellPointerDown: (cell, event) => {
        // Mod+click on a foreign key cell jumps to the referenced row (as "go to definition").
        if (!goTo || !modKey(event) || event.shiftKey || event.altKey || !fkOf?.(cell.dataCol)) {
          return false;
        }
        goTo(cell);
        return true;
      },
      onCellDoubleClick: (cell) => {
        // A read-only source opens the cell viewer instead.
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
    [startEdit, editable, tabId, editor, fkOf, goTo],
  );

  return { editing: editingProps, editingCell: editing };
}

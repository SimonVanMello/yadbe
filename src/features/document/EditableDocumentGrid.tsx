import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { CollectionPage } from '../../ipc';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { DataGrid, type DataGridApi, type GridCellRef } from '../grid/DataGrid';
import { createResultRowSource, type ResultRowSource } from '../grid/resultRowSource';
import {
  deleteTargets,
  duplicate,
  editDocument,
  editField,
  newDocument,
  removeNewDocument,
  revertTarget,
  stageField,
  targetOf,
  undeleteTarget,
} from './docEditActions';
import { editableText } from './docEditModel';
import { useTabDocEdits } from './docEditStore';
import { createDocOverlaySource, overlayOf, type DocOverlaySource } from './docOverlay';

interface EditableDocumentGridProps {
  tabId: string;
  page: CollectionPage;
  label: string;
  /** Deleting is refused (a capped collection). */
  noDelete: boolean;
}

/**
 * A page's documents in the grid with their pending edits drawn over them (M4-4): a changed
 * top-level field is marked and shows its new value, a deleted document is struck, new
 * documents follow the page's. Double click edits a field (typed editor), Delete marks the
 * selected documents, the context menu has the rest (unset, edit as JSON, duplicate, revert).
 */
export function EditableDocumentGrid({ tabId, page, label, noDelete }: EditableDocumentGridProps) {
  const t = useT();
  const edits = useTabDocEdits(tabId);
  const [focused, setFocused] = useState<GridCellRef | null>(null);
  const api = useRef<DataGridApi | null>(null);
  const summary = page.documents.result;

  const sources: { base: ResultRowSource; shown: DocOverlaySource } = useMemo(() => {
    const base = createResultRowSource(summary.resultId, summary.columns, summary.rowCount);
    return { base, shown: createDocOverlaySource(base) };
    // One source per page result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.resultId]);

  useEffect(() => {
    sources.base.revive();
    return () => {
      sources.base.dispose();
    };
  }, [sources]);

  useEffect(() => {
    sources.shown.setOverlay(
      overlayOf(edits, page.ids, summary.columns, (text) =>
        t('mongo.edit.was', { value: text ?? t('mongo.edit.missing') }),
      ),
    );
  }, [sources, edits, page.ids, summary.columns, t]);

  const serverRows = summary.rowCount;

  // A document just added is shown: the grid goes to its row.
  const inserts = edits.inserts.length;
  const seenInserts = useRef(inserts);
  useEffect(() => {
    if (inserts > seenInserts.current) {
      api.current?.focusCell({ row: serverRows + inserts - 1, dataCol: 0 });
    }
    seenInserts.current = inserts;
  }, [inserts, serverRows]);
  const columnName = (col: number) => summary.columns[col]?.name ?? null;
  const insertAt = (row: number) => edits.inserts[row - serverRows] ?? null;

  /** The rows the selection covers (whole page rows only), else the focused one. */
  const selectedRows = (): number[] => {
    const selection = api.current?.selection();
    const rows = new Set<number>();
    for (const range of selection?.ranges ?? []) {
      const end = Math.min(range.r1, serverRows + edits.inserts.length - 1);
      for (let row = range.r0; row <= end; row++) rows.add(row);
    }
    if (rows.size === 0 && focused) rows.add(focused.row);
    return [...rows].sort((a, b) => a - b);
  };

  const onRow = (
    row: number,
    action: (target: NonNullable<Awaited<ReturnType<typeof targetOf>>>) => void,
  ) => {
    void targetOf(tabId, row).then((target) => {
      if (target) action(target);
    });
  };

  const editCell = (cell: GridCellRef) => {
    const insert = insertAt(cell.row);
    if (insert) {
      newDocument(tabId, editableText(insert.document), insert.key);
      return;
    }
    const name = columnName(cell.dataCol);
    if (name === null || name === '_id') return;
    onRow(cell.row, (target) => {
      editField(tabId, target, [name]);
    });
  };

  const deleteSelected = () => {
    const rows = selectedRows();
    const serverSide = rows.filter((r) => r < serverRows);
    const inserts = rows.filter((r) => r >= serverRows).map((r) => insertAt(r)?.key);
    void Promise.all(serverSide.map((row) => targetOf(tabId, row))).then((targets) => {
      if (!noDelete)
        deleteTargets(
          tabId,
          targets.filter((x) => x !== null),
        );
    });
    for (const key of inserts) if (key !== undefined) removeNewDocument(tabId, key);
  };

  const onServerRow = focused !== null && focused.row < serverRows;
  const focusedName = focused ? columnName(focused.dataCol) : null;
  const focusedId = focused && onServerRow ? page.ids[focused.row] : null;
  const focusedEdit = focusedId ? edits.documents.get(focusedId) : undefined;

  const menu = (
    <>
      <ContextMenuItem
        icon="pencil"
        disabled={focused === null || focusedName === '_id' || focusedEdit?.deleted === true}
        onSelect={() => {
          if (focused) editCell(focused);
        }}
      >
        {t('mongo.edit.editField')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={
          !onServerRow ||
          focusedName === null ||
          focusedName === '_id' ||
          focusedEdit?.deleted === true
        }
        onSelect={() => {
          if (!focused || focusedName === null) return;
          onRow(focused.row, (target) => {
            stageField(tabId, target, [focusedName], null);
          });
        }}
      >
        {t('mongo.edit.unsetField')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="file"
        disabled={!onServerRow || focusedEdit?.deleted === true}
        onSelect={() => {
          if (focused)
            onRow(focused.row, (target) => {
              editDocument(tabId, target);
            });
        }}
      >
        {t('mongo.edit.editJson')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="copy"
        disabled={!onServerRow}
        onSelect={() => {
          if (focused)
            onRow(focused.row, (target) => {
              duplicate(tabId, target);
            });
        }}
      >
        {t('mongo.edit.duplicate')}
      </ContextMenuItem>
      {focusedEdit?.deleted ? (
        <ContextMenuItem
          icon="undo"
          onSelect={() => {
            if (focusedId) undeleteTarget(tabId, focusedId);
          }}
        >
          {t('mongo.edit.undelete')}
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          icon="trash"
          disabled={focused === null || (noDelete && onServerRow)}
          onSelect={deleteSelected}
        >
          {t('mongo.edit.delete')}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        icon="undo"
        disabled={!focusedEdit}
        onSelect={() => {
          if (focusedId) revertTarget(tabId, focusedId);
        }}
      >
        {t('mongo.edit.revertDocument')}
      </ContextMenuItem>
    </>
  );

  return (
    <DataGrid
      source={sources.shown}
      sourceKey={`documents-${String(summary.resultId)}`}
      label={label}
      apiRef={api}
      onFocusChange={setFocused}
      menuExtras={menu}
      editing={{
        onCellDoubleClick: (cell) => {
          editCell(cell);
          return true;
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>, cell) => {
          if (cell === null) return false;
          if (event.key === 'Delete') {
            deleteSelected();
            return true;
          }
          if (event.key === 'F2' || event.key === 'Enter') {
            editCell(cell);
            return true;
          }
          return false;
        },
      }}
    />
  );
}

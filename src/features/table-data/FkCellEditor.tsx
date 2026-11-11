import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, type ForeignKey, type LookupPage, type Value, type YadbeError } from '../../ipc';
import { matchShortcut } from '../../ui/shortcuts';
import { Spinner } from '../../ui/Spinner';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { cellValue, editText, formatHint, parseInput } from './cellValues';
import { stopMenu, type CellEditorProps, type EditMove } from './cellEditorTypes';
import styles from './CellEditor.module.css';
import { compositeFill, descriptiveColumns } from './fkModel';
import { newRequestId } from './fkNavigation';
import fk from './ForeignKeys.module.css';
import { tableLabel } from './tableNames';

/** Rows per lookup request. */
const LOOKUP_PAGE = 50;
/** Typing pauses this long before the server is searched. */
const SEARCH_DELAY_MS = 200;
/** Options drawn past each end of the list's viewport. */
const OVERSCAN = 6;

interface FkCellEditorProps extends CellEditorProps {
  tabId: string;
  connectionId: string;
  foreignKey: ForeignKey;
  /** A row was chosen: every column of the key takes its value (composite keys at once). */
  onChoose: (values: { column: string; value: Value }[], move: EditMove) => void;
}

interface LookupRow {
  key: string[];
  texts: (string | null)[];
  values: Map<string, Value>;
}

function rowsOf(page: LookupPage, keyCount: number): LookupRow[] {
  const rows: LookupRow[] = [];
  for (let i = 0; i < page.window.rowCount; i++) {
    const values = new Map<string, Value>();
    const texts = page.columns.map((column, c) => {
      const window = page.window.columns[c];
      const text = window?.values[i] ?? null;
      values.set(column.name, cellValue(text, window?.kinds?.[i] ?? column.kind));
      return text;
    });
    rows.push({
      key: texts.slice(0, keyCount).map((text) => text ?? 'NULL'),
      texts: texts.slice(keyCount),
      values,
    });
  }
  return rows;
}

/** The row height of the lookup list, from the grid's token. */
function rowHeightOf(element: HTMLElement | null): number {
  const value = element
    ? parseFloat(getComputedStyle(element).getPropertyValue('--grid-row-height'))
    : NaN;
  return Number.isFinite(value) && value > 0 ? value : 24;
}

/**
 * The editor of a foreign key cell (F-088): a text box, as for any cell, over a searchable,
 * paged and virtualized list of the referenced table (its key and a few columns that tell rows
 * apart), searched on the server as the user types. `↑` / `↓` pick a row and `Enter` takes it
 * (a composite key fills all its columns); `Tab` or `Enter` without a pick keep the typed value.
 */
export function FkCellEditor({
  column,
  initial,
  typed,
  label,
  onCommit,
  onCancel,
  tabId,
  connectionId,
  foreignKey,
  onChoose,
}: FkCellEditorProps) {
  const t = useT();
  const listId = useId();
  const start = typed ?? editText(initial);
  const [text, setText] = useState(start);
  const [isNull, setIsNull] = useState(typed === null && initial.kind === 'null');
  const [edited, setEdited] = useState(typed !== null);
  const [showError, setShowError] = useState(false);
  const [active, setActive] = useState(-1);
  const [display, setDisplay] = useState<string[] | null>(null);
  const [pages, setPages] = useState<LookupRow[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState<YadbeError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requests = useRef(new Set<string>());
  const loadingPage = useRef<number | null>(null);
  const done = useRef(false);
  const table = foreignKey.referencedTable;
  const tableName = tableLabel(table);
  const keyColumns = foreignKey.referencedColumns;

  // The first search is the whole table: the cell's own value is not a search yet.
  const search = useDebouncedValue(edited && !isNull ? text.trim() : '', SEARCH_DELAY_MS);
  const parsed = isNull ? null : parseInput(text, column);
  const invalid = parsed && !parsed.ok ? t(parsed.error, parsed.params) : null;
  const rows = useMemo(() => pages.flat(), [pages]);

  // Opened without a key typed: the value is selected, so typing searches anew.
  const selectAll = typed === null;
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(selectAll ? 0 : end, end);
  }, [selectAll]);

  // The columns that describe a referenced row, from its table's (cached) metadata.
  useEffect(() => {
    let live = true;
    void ipc.commands.getTableDetails(null, connectionId, table).then((result) => {
      if (!live) return;
      if (result.status === 'error') {
        setDisplay([]);
        return;
      }
      const details = result.data;
      setDisplay(
        descriptiveColumns(
          details.columns,
          keyColumns,
          details.uniqueKeys.map((key) => key.columns),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [connectionId, table, keyColumns]);

  const cancelAll = () => {
    for (const id of requests.current) void ipc.commands.cancelReferenceLookup(id);
    requests.current.clear();
  };

  const load = async (index: number, reset: boolean) => {
    if (display === null) return;
    loadingPage.current = index;
    const requestId = newRequestId('lookup');
    requests.current.add(requestId);
    const result = await ipc.commands.searchReferencedRows(tabId, requestId, {
      table,
      keyColumns,
      displayColumns: display,
      search: search === '' ? null : search,
      offset: index * LOOKUP_PAGE,
      limit: LOOKUP_PAGE,
    });
    const current = requests.current.delete(requestId);
    if (!current || done.current) return;
    loadingPage.current = null;
    if (result.status === 'error') {
      if (result.error.code === 'cancelled') return;
      setStatus('failed');
      setError(result.error);
      return;
    }
    const page = rowsOf(result.data, keyColumns.length);
    setPages((previous) => (reset ? [page] : [...previous.slice(0, index), page]));
    setHasMore(result.data.hasMore);
    setStatus('ready');
  };

  // A new search starts over (what was running for the previous one is cancelled).
  useEffect(() => {
    cancelAll();
    setStatus('loading');
    setError(null);
    setActive(-1);
    void load(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` reads the current search
  }, [search, display]);

  useEffect(
    () => () => {
      cancelAll();
    },
    [],
  );

  const rowHeight = rowHeightOf(listRef.current);
  const count = rows.length + (hasMore ? 1 : 0);
  // eslint-disable-next-line react-hooks/incompatible-library -- options are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  // The loader row came into view: the next page.
  useEffect(() => {
    if (!last || last.index < rows.length || !hasMore || loadingPage.current !== null) return;
    void load(pages.length, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the visible range only
  }, [last?.index, rows.length, hasMore]);

  const choose = (index: number, move: EditMove) => {
    const row = rows[index];
    if (!row || done.current) return;
    done.current = true;
    cancelAll();
    onChoose(
      compositeFill(foreignKey, (referenced) => row.values.get(referenced)),
      move,
    );
  };

  const commit = (move: EditMove) => {
    if (done.current) return;
    if (isNull) {
      done.current = true;
      cancelAll();
      onCommit({ kind: 'null' }, move);
      return;
    }
    if (!parsed?.ok) {
      setShowError(true);
      return;
    }
    done.current = true;
    cancelAll();
    onCommit(parsed.value, move);
  };

  const cancel = () => {
    if (done.current) return;
    done.current = true;
    cancelAll();
    onCancel();
  };

  const moveActive = (delta: number) => {
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, active + delta));
    setActive(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (matchShortcut(event, 'Mod+Backspace')) {
      event.preventDefault();
      setIsNull(true);
      setText('');
      setShowError(false);
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'PageDown':
        event.preventDefault();
        moveActive(8);
        return;
      case 'PageUp':
        event.preventDefault();
        moveActive(-8);
        return;
      case 'Tab':
        event.preventDefault();
        commit(event.shiftKey ? 'left' : 'right');
        return;
      case 'Enter':
        event.preventDefault();
        if (active >= 0) choose(active, 'down');
        else commit('down');
        return;
    }
  };

  const optionId = (index: number) => `${listId}-option-${String(index)}`;
  const fills = foreignKey.columns.length > 1 ? foreignKey.columns.join(', ') : null;

  return (
    <div className={styles.editor}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-invalid={showError && invalid !== null ? true : undefined}
        className={styles.input}
        data-null={isNull || undefined}
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder={isNull ? 'NULL' : (formatHint(column.kind) ?? '')}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setText(event.target.value);
          setIsNull(false);
          setEdited(true);
          setShowError(false);
        }}
        onBlur={() => {
          // Clicking elsewhere keeps a valid value, and drops one that is not.
          if (isNull || parsed?.ok) commit('none');
          else cancel();
        }}
        onContextMenu={stopMenu}
      />
      <div className={fk.lookup} data-testid="fk-lookup">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t('tableData.fk.lookup.label', { table: tableName })}
          className={fk.options}
          // The text box keeps the focus while an option is clicked.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
        >
          <div style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) {
                return (
                  <div
                    key="loader"
                    className={fk.option}
                    style={{ top: item.start }}
                    aria-hidden="true"
                  >
                    <Spinner />
                  </div>
                );
              }
              return (
                <div
                  key={item.index}
                  id={optionId(item.index)}
                  role="option"
                  aria-selected={item.index === active}
                  className={fk.option}
                  style={{ top: item.start }}
                  onClick={() => {
                    choose(item.index, 'down');
                  }}
                >
                  <span className={fk.optionKey}>{row.key.join(' · ')}</span>
                  <span className={fk.optionText}>
                    {row.texts.map((value) => value ?? 'NULL').join(' · ')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {status === 'loading' && rows.length === 0 && (
          <div className={fk.lookupState} role="status">
            <Spinner />
            {t('tableData.fk.lookup.loading')}
          </div>
        )}
        {status === 'ready' && rows.length === 0 && (
          <div className={fk.lookupState} role="status">
            {t('tableData.fk.lookup.empty', { table: tableName })}
          </div>
        )}
        {status === 'failed' && (
          <div className={`${fk.lookupState} ${fk.error}`} role="alert">
            {error ? localize(error.message) : t('tableData.fk.lookup.failed')}
          </div>
        )}
        <div className={fk.lookupHint}>
          {showError && invalid ? (
            <span className={styles.error} role="alert">
              {invalid}
            </span>
          ) : (
            <>
              <span>{t('tableData.fk.lookup.keys')}</span>
              <span>{fills ? t('tableData.fk.lookup.fills', { columns: fills }) : tableName}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

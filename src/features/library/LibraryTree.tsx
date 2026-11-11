import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { matchShortcut } from '../../ui/shortcuts';
import { treeShape } from '../sidebar/sidebarRows';
import { useRowHeight } from '../sidebar/useRowHeight';
import { BuiltinHeaderRow } from './BuiltinHeaderRow';
import { BuiltinRow } from './BuiltinRow';
import { FolderRow } from './FolderRow';
import { deleteFolder, deleteSaved, insertBuiltin, insertSaved, openSaved } from './libraryActions';
import type { Library, LibraryRow } from './libraryModel';
import { useLibraryUi } from './libraryStore';
import { QueryRow } from './QueryRow';
import styles from './LibraryTree.module.css';
import { ROOT_DROP, useLibraryDrag } from './useLibraryDrag';

const OVERSCAN = 12;
const PAGE = 10;
/** Rows drawn before the real size is measured (and in tests, where nothing is measured). */
const INITIAL_RECT = { width: 280, height: 640 };

interface LibraryTreeProps {
  rows: readonly LibraryRow[];
  library: Library;
  label: string;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  treeRef?: Ref<HTMLDivElement>;
}

function toggle(row: LibraryRow): void {
  const ui = useLibraryUi.getState();
  if (row.type === 'folder') ui.setFolded(row.folder.id, row.expanded);
  else if (row.type === 'builtinHeader') ui.setBuiltinOpen(!row.expanded);
}

function setExpanded(row: LibraryRow, expanded: boolean): void {
  if ((row.type === 'folder' || row.type === 'builtinHeader') && row.expanded !== expanded) {
    toggle(row);
  }
}

/**
 * The library as a flat virtualized list (ARIA `tree`): folders, queries and the built-in
 * snippets. The tree keeps the focus and names the active row with `aria-activedescendant`, so
 * that a row scrolled out of the window stays the active one.
 */
export function LibraryTree({ rows, library, label, empty, treeRef }: LibraryTreeProps) {
  const baseId = useId();
  const rowHeight = useRowHeight();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedKey = useLibraryUi((state) => state.selectedKey);
  const renamingKey = useLibraryUi((state) => state.renamingKey);
  const { drag, rootDrop, dropKey } = useLibraryDrag(library);

  const shape = useMemo(() => treeShape(rows), [rows]);
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const activeIndex = selectedKey === null ? -1 : (indexByKey.get(selectedKey) ?? -1);

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are not memoized children
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    initialRect: INITIAL_RECT,
    // An element that reports no size (not laid out yet, or jsdom) keeps the initial one.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb(rect.height === 0 ? INITIAL_RECT : rect);
      }),
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const setRefs = (element: HTMLDivElement | null) => {
    scrollRef.current = element;
    if (typeof treeRef === 'function') treeRef(element);
    else if (treeRef) treeRef.current = element;
  };

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    useLibraryUi.getState().select(row.key);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  // A row being renamed (a new folder) is brought into view.
  useEffect(() => {
    if (renamingKey === null) return;
    const index = indexByKey.get(renamingKey);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' });
    // Only when the renamed row changes, not on every render of the virtualizer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingKey]);

  const select = (index: number) => {
    const row = rows[index];
    if (row) useLibraryUi.getState().select(row.key);
  };

  const openMenuFromKeyboard = (index: number) => {
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${String(index)}"]`,
    );
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 24,
        clientY: rect.bottom - 2,
      }),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = activeIndex >= 0 ? rows[activeIndex] : undefined;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (matchShortcut(event.nativeEvent, 'Mod+Enter')) {
      stop();
      if (row?.type === 'query') void insertSaved(row.query);
      else if (row?.type === 'builtin') insertBuiltin(row.snippet);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const last = rows.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        stop();
        moveTo(Math.min(last, activeIndex + 1));
        return;
      case 'ArrowUp':
        stop();
        moveTo(Math.max(0, activeIndex < 0 ? last : activeIndex - 1));
        return;
      case 'Home':
        stop();
        moveTo(0);
        return;
      case 'End':
        stop();
        moveTo(last);
        return;
      case 'PageDown':
        stop();
        moveTo(Math.min(last, Math.max(0, activeIndex) + PAGE));
        return;
      case 'PageUp':
        stop();
        moveTo(Math.max(0, activeIndex - PAGE));
        return;
      case 'ArrowRight':
        stop();
        if (!row || (row.type !== 'folder' && row.type !== 'builtinHeader')) return;
        if (!row.expanded) setExpanded(row, true);
        else if (rows[activeIndex + 1] && shape.parent[activeIndex + 1] === activeIndex) {
          moveTo(activeIndex + 1);
        }
        return;
      case 'ArrowLeft':
        stop();
        if ((row?.type === 'folder' || row?.type === 'builtinHeader') && row.expanded) {
          setExpanded(row, false);
        } else if (activeIndex >= 0 && (shape.parent[activeIndex] ?? -1) >= 0) {
          moveTo(shape.parent[activeIndex] ?? 0);
        }
        return;
      case 'Enter':
        stop();
        if (!row) return;
        if (row.type === 'query') void openSaved(row.query);
        else if (row.type === 'builtin') insertBuiltin(row.snippet);
        else toggle(row);
        return;
      case 'F2':
        stop();
        if (row?.type === 'query' || row?.type === 'folder') {
          useLibraryUi.getState().startRename(row.key);
        }
        return;
      case 'Delete':
        stop();
        if (row?.type === 'query') void deleteSaved(row.query);
        else if (row?.type === 'folder') void deleteFolder(row.folder);
        return;
      case 'ContextMenu':
        stop();
        if (activeIndex >= 0) openMenuFromKeyboard(activeIndex);
        return;
      case 'F10':
        if (event.shiftKey) {
          stop();
          if (activeIndex >= 0) openMenuFromKeyboard(activeIndex);
        }
        return;
    }
  };

  const items = virtualizer.getVirtualItems();
  // The built-in snippets are always there: the empty message is about the user's own queries.
  const hasOwnRows = rows.some((row) => row.type === 'folder' || row.type === 'query');

  return (
    <div
      ref={setRefs}
      role="tree"
      aria-label={label}
      aria-multiselectable={false}
      tabIndex={0}
      aria-activedescendant={activeIndex >= 0 ? `${baseId}-${String(activeIndex)}` : undefined}
      className={styles.tree}
      data-drop-root={dropKey === ROOT_DROP || undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target !== event.currentTarget || activeIndex >= 0) return;
        const first = rows[0];
        if (first) useLibraryUi.getState().select(first.key);
      }}
      {...rootDrop}
    >
      {!hasOwnRows && empty}
      <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const common = {
            id: `${baseId}-${String(item.index)}`,
            index: item.index,
            active: item.index === activeIndex,
            posInSet: shape.posInSet[item.index] ?? 1,
            setSize: shape.setSize[item.index] ?? 1,
            offset: item.start,
            height: rowHeight,
            onSelect: select,
          };
          switch (row.type) {
            case 'folder':
              return (
                <FolderRow
                  key={row.key}
                  row={row}
                  {...common}
                  renaming={row.key === renamingKey}
                  dropping={row.key === dropKey}
                  drag={drag}
                  onToggle={toggle}
                />
              );
            case 'query':
              return (
                <QueryRow
                  key={row.key}
                  row={row}
                  {...common}
                  renaming={row.key === renamingKey}
                  dropping={row.key === dropKey}
                  drag={drag}
                />
              );
            case 'builtinHeader':
              return (
                <BuiltinHeaderRow
                  key={row.key}
                  row={row}
                  {...common}
                  onToggle={() => {
                    toggle(row);
                  }}
                />
              );
            case 'builtin':
              return <BuiltinRow key={row.key} row={row} {...common} />;
          }
        })}
      </div>
    </div>
  );
}

import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { useT } from '../../i18n/useT';
import { ExplorerRow } from '../explorer/ExplorerRow';
import { ConnectionRow } from './ConnectionRow';
import { GroupRow } from './GroupRow';
import styles from './SidebarTree.module.css';
import { openRow, refreshRow, rowLabel, setRowExpanded, toggleRow } from './sidebarActions';
import { treeShape, type SidebarTreeRow } from './sidebarRows';
import { useRevealRow } from './useRevealRow';
import { useRowHeight } from './useRowHeight';

const OVERSCAN = 12;
const PAGE = 10;
/** Pause that ends a run of typed letters, in ms. */
const TYPE_AHEAD_RESET_MS = 700;
/** Rows drawn before the real size is measured (and in tests, where nothing is measured). */
const INITIAL_RECT = { width: 280, height: 640 };

interface SidebarTreeProps {
  rows: readonly SidebarTreeRow[];
  label: string;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  treeRef?: Ref<HTMLDivElement>;
}

/**
 * The sidebar tree: connection folders, connections, and the explorer of the open ones, as one
 * flat virtualized list (ARIA `tree`). The tree itself keeps the focus and names the active row
 * with `aria-activedescendant`, so that a row scrolled out of the window stays the active one.
 */
export function SidebarTree({ rows, label, empty, treeRef }: SidebarTreeProps) {
  const t = useT();
  const baseId = useId();
  const rowHeight = useRowHeight();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const typed = useRef({ text: '', timer: 0 });

  const shape = useMemo(() => treeShape(rows), [rows]);
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);

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

  const found = activeKey === null ? undefined : indexByKey.get(activeKey);
  // The active row went away (its parent collapsed): stay about where it was.
  const activeIndex =
    found ??
    (rows.length === 0 || activeKey === null ? -1 : Math.min(lastIndex.current, rows.length - 1));
  if (activeIndex >= 0) lastIndex.current = activeIndex;

  const setRefs = (element: HTMLDivElement | null) => {
    scrollRef.current = element;
    if (typeof treeRef === 'function') treeRef(element);
    else if (treeRef) treeRef.current = element;
  };

  const moveTo = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setActiveKey(row.key);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  // "Reveal in explorer" (the palette): focus first, since focusing the tree activates its first
  // row when none is.
  useRevealRow(rows, (index) => {
    const row = rows[index];
    if (!row) return;
    scrollRef.current?.focus({ preventScroll: true });
    setActiveKey(row.key);
    virtualizer.scrollToIndex(index, { align: 'center' });
  });

  // Stable, so that the rows that did not change are not drawn again on every scroll.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const select = useCallback((index: number) => {
    const row = rowsRef.current[index];
    if (row) setActiveKey(row.key);
  }, []);

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

  const typeAhead = (char: string, from: number) => {
    window.clearTimeout(typed.current.timer);
    typed.current.text += char.toLowerCase();
    typed.current.timer = window.setTimeout(() => {
      typed.current.text = '';
    }, TYPE_AHEAD_RESET_MS);
    const { text } = typed.current;
    // The same letter again moves on to the next row that starts with it.
    const first = text.charAt(0);
    const repeated = text.length > 1 && text.split(first).join('') === '';
    const needle = repeated ? first : text;
    const start = text.length === 1 || repeated ? from + 1 : from;
    for (let step = 0; step < rows.length; step++) {
      const index = (start + step) % rows.length;
      const row = rows[index];
      if (row && rowLabel(row, t).toLowerCase().startsWith(needle)) {
        moveTo(index);
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = activeIndex >= 0 ? rows[activeIndex] : undefined;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (event.key.toLowerCase() === 'r' && row) {
        stop();
        refreshRow(row);
      }
      return;
    }
    if (event.altKey) return;
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
        if (!row?.expandable) return;
        if (!row.expanded) setRowExpanded(row, true);
        else if (rows[activeIndex + 1] && shape.parent[activeIndex + 1] === activeIndex) {
          moveTo(activeIndex + 1);
        }
        return;
      case 'ArrowLeft':
        stop();
        if (row?.expandable && row.expanded) setRowExpanded(row, false);
        else if (activeIndex >= 0 && (shape.parent[activeIndex] ?? -1) >= 0) {
          moveTo(shape.parent[activeIndex] ?? 0);
        }
        return;
      case 'Enter':
        stop();
        if (!row) return;
        if (row.type === 'status') refreshRow(row);
        else if (!openRow(row)) toggleRow(row);
        return;
      case ' ':
        stop();
        // Part of a name being typed, else the key that opens and closes a node.
        if (typed.current.text !== '') typeAhead(' ', Math.max(0, activeIndex));
        else if (row) toggleRow(row);
        return;
      case 'F5':
        stop();
        if (row) refreshRow(row);
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
      default:
        if (event.key.length === 1) {
          stop();
          typeAhead(event.key, Math.max(0, activeIndex));
        }
    }
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={setRefs}
      role="tree"
      aria-label={label}
      aria-multiselectable={false}
      tabIndex={0}
      aria-activedescendant={activeIndex >= 0 ? `${baseId}-${String(activeIndex)}` : undefined}
      className={styles.tree}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target !== event.currentTarget || activeIndex >= 0) return;
        const first = rows[0];
        if (first) setActiveKey(first.key);
      }}
    >
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
            case 'group':
              return <GroupRow key={row.key} row={row} {...common} onToggle={toggleRow} />;
            case 'connection':
              return (
                <ConnectionRow
                  key={row.key}
                  row={row}
                  {...common}
                  onToggle={toggleRow}
                  onOpen={openRow}
                  onRefresh={refreshRow}
                />
              );
            default:
              return (
                <ExplorerRow
                  key={row.key}
                  row={row}
                  {...common}
                  onToggle={toggleRow}
                  onOpen={openRow}
                  onRefresh={refreshRow}
                />
              );
          }
        })}
      </div>
      {rows.length === 0 && empty}
    </div>
  );
}

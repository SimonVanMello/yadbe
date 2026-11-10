import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';

import { findAction } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { activateItem, primaryHint, secondaryHint } from './activateItem';
import styles from './CommandPalette.module.css';
import {
  isScriptable,
  KIND_PREFIX,
  MODE_HINTS,
  type PaletteItem,
  type PaletteKind,
} from './paletteItems';
import { PaletteRow } from './PaletteRow';
import { usePaletteStore } from './paletteStore';
import { usePaletteData } from './usePaletteData';
import { usePxToken } from './usePxToken';

const OVERSCAN = 3;
const PAGE = 8;
/** Rows drawn before the real size is measured (and in tests, where nothing is measured). */
const INITIAL_RECT = { width: 600, height: 408 };
const MODES: readonly PaletteKind[] = ['action', 'object', 'tab', 'history', 'connection'];

interface PaletteBodyProps {
  /** An item was chosen: the palette closes and the item runs. */
  onChosen: (item: PaletteItem) => void;
}

/** The palette's content: search field, mode chips, virtualized grouped results, footer. */
export function PaletteBody({ onChosen }: PaletteBodyProps) {
  const t = useT();
  const listId = useId();
  const [raw, setRaw] = useState(() => usePaletteStore.getState().initialQuery);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = usePxToken('--palette-row-height', 34);
  const headerHeight = usePxToken('--palette-header-height', 26);

  // Typing stays instant: the field follows the keys, the results follow when React can, and a
  // new key abandons the render of the previous one.
  const query = useDeferredValue(raw);
  const { mode, text, results, loading, loadingObjects, hasObjects, connectedCount } =
    usePaletteData(query);
  const { rows } = results;

  // Options only (headings are not options): their order drives the keyboard.
  const options = useMemo(() => {
    const list: { rowIndex: number; item: PaletteItem }[] = [];
    rows.forEach((row, rowIndex) => {
      if (row.type === 'item') list.push({ rowIndex, item: row.item });
    });
    return list;
  }, [rows]);
  const found = options.findIndex((option) => option.item.key === activeKey);
  // The active item went away (new results): the first one takes over.
  const activeOption = found >= 0 ? found : 0;
  const active = options[activeOption];
  const activeItemKey = active?.item.key;

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are not memoized children
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? headerHeight : rowHeight),
    overscan: OVERSCAN,
    initialRect: INITIAL_RECT,
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb(rect.height === 0 ? INITIAL_RECT : rect);
      }),
    getItemKey: (index) => {
      const row = rows[index];
      return row?.type === 'item' ? row.item.key : (row?.key ?? index);
    },
  });

  // Keeps the active row in view; the first one scrolls to the very top, heading included.
  useEffect(() => {
    if (!active) return;
    virtualizer.scrollToIndex(activeOption === 0 ? 0 : active.rowIndex, { align: 'auto' });
    // Only when the active item changes, not on every render of the virtualizer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItemKey]);

  const choose = (item: PaletteItem, secondary: boolean, openData = false) => {
    if (item.kind === 'action' && item.disabledReason !== null) return;
    if (item.kind !== 'history') usePaletteStore.getState().remember(item.key);
    onChosen(item);
    usePaletteStore.getState().hide();
    // After the dialog unmounted, so that closing it cannot take back what the item focuses.
    setTimeout(() => {
      activateItem(item, secondary, openData);
    }, 0);
  };

  // Enter pressed before the results caught up with the field would pick from the previous
  // query's list: it waits for them and picks then.
  const enterPending = useRef<{ secondary: boolean; openData: boolean } | null>(null);
  const latest = useRef({ choose, active, caughtUp: true });
  useEffect(() => {
    latest.current = { choose, active, caughtUp: raw === query };
  });
  useEffect(() => {
    const pending = enterPending.current;
    const { choose: pick, active: item, caughtUp } = latest.current;
    if (!pending || !caughtUp) return;
    enterPending.current = null;
    if (item) pick(item.item, pending.secondary, pending.openData);
  }, [query, raw]);

  const move = (to: number) => {
    const option = options[Math.max(0, Math.min(options.length - 1, to))];
    if (option) setActiveKey(option.item.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The global shortcuts stand down while a dialog is open: toggling back is ours.
    const action = findAction(event.nativeEvent);
    if (action === 'palette.open') {
      event.preventDefault();
      usePaletteStore.getState().hide();
      return;
    }
    if (action === 'palette.commands') {
      event.preventDefault();
      setRaw('>');
      setActiveKey(null);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        move(activeOption >= options.length - 1 ? 0 : activeOption + 1);
        break;
      case 'ArrowUp':
        move(activeOption <= 0 ? options.length - 1 : activeOption - 1);
        break;
      case 'PageDown':
        move(activeOption + PAGE);
        break;
      case 'PageUp':
        move(activeOption - PAGE);
        break;
      case 'Home':
        if (event.currentTarget.value !== '') return;
        move(0);
        break;
      case 'End':
        if (event.currentTarget.value !== '') return;
        move(options.length - 1);
        break;
      case 'Enter': {
        const secondary = event.ctrlKey || event.metaKey;
        // `Shift+Enter` on a table or view: its rows in a table tab.
        const openData = event.shiftKey && !secondary;
        if (raw !== query) enterPending.current = { secondary, openData };
        else if (active) choose(active.item, secondary, openData);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setRaw(event.target.value);
    setActiveKey(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const pickMode = (kind: PaletteKind) => {
    setRaw(mode === kind ? '' : KIND_PREFIX[kind]);
    setActiveKey(null);
    document.getElementById(`${listId}-input`)?.focus();
  };

  const optionId = (key: string) => `${listId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const posInSet = useMemo(() => {
    const positions = new Map<number, number>();
    options.forEach((option, position) => positions.set(option.rowIndex, position + 1));
    return positions;
  }, [options]);

  const empty = rows.length === 0;
  const noObjectsHint = empty && mode === 'object' && !hasObjects && !loadingObjects;
  const secondary = active ? secondaryHint(active.item) : null;

  return (
    <>
      <div className={styles.search}>
        <Icon name="search" />
        <input
          id={`${listId}-input`}
          type="text"
          role="combobox"
          className={styles.input}
          value={raw}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.title')}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeItemKey === undefined ? undefined : optionId(activeItemKey)}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        {loading && <Spinner />}
      </div>
      <div className={styles.modes}>
        {MODES.map((kind) => (
          <button
            key={kind}
            type="button"
            tabIndex={-1}
            className={styles.mode}
            aria-pressed={mode === kind}
            onClick={() => {
              pickMode(kind);
            }}
          >
            <Kbd shortcut={KIND_PREFIX[kind]} />
            {t(MODE_HINTS[kind])}
          </button>
        ))}
      </div>
      {empty ? (
        <div className={styles.empty} role="status">
          {noObjectsHint
            ? connectedCount === 0
              ? t('palette.noConnection')
              : t('palette.noObjects')
            : loading
              ? t('palette.loading')
              : t('palette.empty', { query: text })}
        </div>
      ) : (
        <div
          ref={scrollRef}
          id={listId}
          role="listbox"
          aria-label={t('palette.title')}
          className={styles.list}
        >
          <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtual) => {
              const row = rows[virtual.index];
              if (!row) return null;
              if (row.type === 'header') {
                return (
                  <div
                    key={row.key}
                    role="presentation"
                    className={styles.header}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: headerHeight,
                      transform: `translateY(${String(virtual.start)}px)`,
                    }}
                  >
                    {t(row.label)}
                    <span className={styles.count}>{row.count}</span>
                  </div>
                );
              }
              return (
                <PaletteRow
                  key={row.item.key}
                  item={row.item}
                  indices={row.indices}
                  id={optionId(row.item.key)}
                  index={virtual.index}
                  active={row.item.key === activeItemKey}
                  posInSet={posInSet.get(virtual.index) ?? 1}
                  setSize={options.length}
                  offset={virtual.start}
                  height={rowHeight}
                  onChoose={choose}
                  onHover={setActiveKey}
                />
              );
            })}
          </div>
        </div>
      )}
      <div className={styles.footer}>
        <span className={styles.footerHint}>
          <Kbd shortcut="↑" />
          <Kbd shortcut="↓" />
        </span>
        {active && (
          <span className={styles.footerHint}>
            <Kbd shortcut="Enter" />
            {t(primaryHint(active.item))}
          </span>
        )}
        {secondary && (
          <span className={styles.footerHint}>
            <Kbd shortcut="Mod+Enter" />
            {t(secondary)}
          </span>
        )}
        {active && isScriptable(active.item) && (
          <span className={styles.footerHint}>
            <Kbd shortcut="Shift+Enter" />
            {t('palette.hint.openData')}
          </span>
        )}
        <span className={styles.spacer} />
        <span className={styles.status} aria-live="polite" data-query={query}>
          {t('palette.results', { count: results.total })}
        </span>
      </div>
    </>
  );
}

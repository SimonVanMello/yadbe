import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YadbeIpcError } from '../../ipc';
import { useYadbeEvent } from '../../ipc/useYadbeEvent';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { matchShortcut } from '../../ui/shortcuts';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { useNow } from '../../ui/useNow';
import { useConnections } from '../connections/connectionStore';
import { ClearHistoryDialog } from './ClearHistoryDialog';
import { HistoryDetail } from './HistoryDetail';
import { HistoryFilterFields } from './HistoryFilterFields';
import { HistoryRow } from './HistoryRow';
import styles from './HistoryPanel.module.css';
import { deleteEntry, insertEntry, openEntry } from './historyActions';
import { activeFilterCount, dayDistance, groupByDay, isFiltered } from './historyModel';
import { useHistoryUi } from './historyStore';
import { LOAD_MORE_MARGIN, noteNewHistory, useHistoryList } from './useHistory';

const SEARCH_DELAY_MS = 200;
const ROW_ESTIMATE = 58;
const DAY_ESTIMATE = 26;

/** The History view of the sidebar (F-101): every statement run, searchable and filterable. */
export function HistoryPanel() {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const filters = useHistoryUi((state) => state.filters);
  const filtersOpen = useHistoryUi((state) => state.filtersOpen);
  const selectedId = useHistoryUi((state) => state.selectedId);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The search runs once the user pauses; what is shown (and emphasized) is what ran.
  const searched = useDebouncedValue(filters.text, SEARCH_DELAY_MS);
  const queryFilters = useMemo(() => ({ ...filters, text: searched }), [filters, searched]);
  const { query, entries, behind, catchUp } = useHistoryList(queryFilters);
  useYadbeEvent('historyChanged', () => {
    void noteNewHistory();
  });

  const items = useMemo(() => groupByDay(entries), [entries]);
  const connections = useConnections();
  const byId = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === 'day' ? DAY_ESTIMATE : ROW_ESTIMATE),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Older statements load as the end of what is loaded comes into view.
  const lastVisible = virtualItems.at(-1)?.index ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastVisible >= items.length - LOAD_MORE_MARGIN) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastVisible, items.length]);

  // A list scrolled into older pages when statements ran catches up once back at the top.
  const firstVisible = virtualItems[0]?.index ?? 0;
  useEffect(() => {
    if (behind && firstVisible === 0) void catchUp();
  }, [behind, firstVisible, catchUp]);

  // A new search starts from the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [queryFilters]);

  const select = (id: number | null) => {
    useHistoryUi.getState().select(id);
  };

  const move = (to: 'next' | 'previous' | 'first' | 'last') => {
    if (entries.length === 0) return;
    const at = entries.findIndex((entry) => entry.id === selectedId);
    const index =
      to === 'first'
        ? 0
        : to === 'last'
          ? entries.length - 1
          : Math.min(entries.length - 1, Math.max(0, at + (to === 'next' ? 1 : -1)));
    const target = entries[index];
    if (!target) return;
    select(target.id);
    const itemIndex = items.findIndex(
      (item) => item.kind === 'entry' && item.entry.id === target.id,
    );
    if (itemIndex !== -1) virtualizer.scrollToIndex(itemIndex, { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (matchShortcut(event.nativeEvent, 'Mod+Enter')) {
      if (selected) void insertEntry(selected);
    } else if (event.key === 'Enter') {
      if (selected) void openEntry(selected);
    } else if (event.key === 'ArrowDown') move('next');
    else if (event.key === 'ArrowUp') move('previous');
    else if (event.key === 'Home') move('first');
    else if (event.key === 'End') move('last');
    else if (event.key === 'Delete') {
      if (selected) void deleteEntry(selected);
    } else return;
    event.preventDefault();
  };

  const filterCount = activeFilterCount(filters);
  const filtered = isFiltered(filters);
  // While a new search loads, the previous result (placeholder data) counts as a success.
  const showList = query.isSuccess;

  return (
    <section className={styles.panel} aria-label={t('history.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('history.title')}</h2>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={filtersOpen}
            data-active={filterCount > 0 || undefined}
            onClick={() => {
              useHistoryUi.getState().setFiltersOpen(!filtersOpen);
            }}
          >
            {filterCount > 0
              ? t('history.filters.count', { count: filterCount })
              : t('history.filters')}
          </Button>
          <IconButton
            icon="trash"
            size="sm"
            label={t('history.clear')}
            onClick={() => {
              setClearing(true);
            }}
          />
        </div>
      </header>
      <div className={styles.search}>
        <Icon name="search" className={styles.searchIcon} />
        <TextInput
          className={styles.searchInput}
          data-history-search=""
          value={filters.text}
          placeholder={t('history.search.placeholder')}
          aria-label={t('history.search')}
          onChange={(event) => {
            useHistoryUi.getState().patchFilters({ text: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') useHistoryUi.getState().patchFilters({ text: '' });
            else if (event.key === 'ArrowDown') {
              event.preventDefault();
              scrollRef.current?.focus();
              move(selectedId === null ? 'first' : 'next');
            }
          }}
        />
      </div>
      {filtersOpen && <HistoryFilterFields />}

      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        tabIndex={0}
        aria-label={t('history.list')}
        aria-activedescendant={
          selectedId === null ? undefined : `history-row-${String(selectedId)}`
        }
        aria-busy={query.isFetching}
        onKeyDown={onKeyDown}
      >
        {query.isPending && (
          <div className={styles.state}>
            <Spinner />
          </div>
        )}
        {query.isError && (
          <div className={styles.error}>
            {query.error instanceof YadbeIpcError ? (
              <ErrorPanel
                compact
                title={t('history.loadFailed')}
                error={query.error.error}
                context={{
                  retry: () => {
                    void query.refetch();
                  },
                }}
              />
            ) : (
              <p className={styles.empty}>{t('history.loadFailed')}</p>
            )}
          </div>
        )}
        {showList && entries.length === 0 && (
          <div className={styles.state}>
            <p className={styles.empty}>
              {filtered ? t('history.emptyFiltered') : t('history.empty')}
            </p>
            {filtered && (
              <Button
                size="sm"
                onClick={() => {
                  useHistoryUi.getState().resetFilters();
                }}
              >
                {t('history.filters.reset')}
              </Button>
            )}
          </div>
        )}
        {showList && entries.length > 0 && (
          <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtual) => {
              const item = items[virtual.index];
              if (!item) return null;
              if (item.kind === 'day') {
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={virtual.index}
                    role="presentation"
                    className={styles.day}
                    style={{ transform: `translateY(${String(virtual.start)}px)` }}
                  >
                    {dayLabel(item.start, now, locale, t)}
                  </div>
                );
              }
              return (
                <HistoryRow
                  key={item.key}
                  entry={item.entry}
                  connection={byId.get(item.entry.connectionId)}
                  selected={item.entry.id === selectedId}
                  search={searched}
                  now={now}
                  locale={locale}
                  index={virtual.index}
                  offset={virtual.start}
                  measureRef={virtualizer.measureElement}
                  domId={`history-row-${String(item.entry.id)}`}
                  onSelect={() => {
                    select(item.entry.id);
                  }}
                  onOpen={() => {
                    void openEntry(item.entry);
                  }}
                />
              );
            })}
          </div>
        )}
        {isFetchingNextPage && (
          <div className={styles.more} role="status" aria-label={t('history.loadingMore')}>
            <Spinner />
          </div>
        )}
      </div>
      {selected && <HistoryDetail key={selected.id} entry={selected} search={searched} />}
      {clearing && (
        <ClearHistoryDialog
          onClose={() => {
            setClearing(false);
          }}
        />
      )}
    </section>
  );
}

function dayLabel(start: number, now: number, locale: string, t: ReturnType<typeof useT>): string {
  const distance = dayDistance(start, now);
  if (distance === 0) return t('history.day.today');
  if (distance === 1) return t('history.day.yesterday');
  const sameYear = new Date(start).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(start));
}

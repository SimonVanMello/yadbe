import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import type { ActivitySession } from '../../ipc';
import { Tooltip } from '../../ui/Tooltip';
import styles from './ActivityList.module.css';
import { displayState, formatDuration } from './activityModel';

/** Rows past this count are drawn only while they scroll into view. */
const OVERSCAN = 12;

interface SessionsListProps {
  sessions: readonly ActivitySession[];
  selectedId: string | null;
  /** How many sessions each session blocks directly, by id. */
  blocking: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
}

/**
 * The sessions of the server, one per line, virtualized: a busy server lists thousands. The
 * selection is a row of the grid (arrows, Home, End) and drives the detail below it.
 */
export function SessionsList({ sessions, selectedId, blocking, onSelect }: SessionsListProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    getItemKey: (index) => sessions[index]?.id ?? index,
    overscan: OVERSCAN,
  });

  // The selected session leaves the list (filtered, ended): nothing stays selected.
  const selectedIndex = sessions.findIndex((s) => s.id === selectedId);
  const lastScrolled = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId !== null && selectedIndex >= 0 && lastScrolled.current !== selectedId) {
      lastScrolled.current = selectedId;
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    }
  }, [selectedId, selectedIndex, virtualizer]);

  const move = (to: 'next' | 'previous' | 'first' | 'last') => {
    if (sessions.length === 0) return;
    const index =
      to === 'first'
        ? 0
        : to === 'last'
          ? sessions.length - 1
          : Math.min(sessions.length - 1, Math.max(0, selectedIndex + (to === 'next' ? 1 : -1)));
    const target = sessions[index];
    if (!target) return;
    lastScrolled.current = target.id;
    onSelect(target.id);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') move('next');
    else if (event.key === 'ArrowUp') move('previous');
    else if (event.key === 'Home') move('first');
    else if (event.key === 'End') move('last');
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={scrollRef}
      className={styles.list}
      role="grid"
      tabIndex={0}
      aria-label={t('activity.list')}
      aria-rowcount={sessions.length + 1}
      aria-activedescendant={selectedIndex >= 0 ? `session-${selectedId ?? ''}` : undefined}
      onKeyDown={onKeyDown}
    >
      <div role="row" aria-rowindex={1} className={`${styles.head} ${styles.sessions}`}>
        <span role="columnheader">{t('activity.column.id')}</span>
        <span role="columnheader">{t('activity.column.user')}</span>
        <span role="columnheader">{t('activity.column.database')}</span>
        <span role="columnheader">{t('activity.column.client')}</span>
        <span role="columnheader">{t('activity.column.state')}</span>
        <span role="columnheader">{t('activity.column.duration')}</span>
        <span role="columnheader">{t('activity.column.transaction')}</span>
        <span role="columnheader">{t('activity.column.statement')}</span>
      </div>
      <div role="rowgroup" className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const session = sessions[virtual.index];
          if (!session) return null;
          return (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedId}
              blocks={blocking.get(session.id) ?? 0}
              index={virtual.index}
              offset={virtual.start}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: ActivitySession;
  selected: boolean;
  blocks: number;
  index: number;
  offset: number;
  onSelect: (id: string) => void;
}

function SessionRow({ session, selected, blocks, index, offset, onSelect }: SessionRowProps) {
  const t = useT();
  const state = displayState(session);
  const stateLabel =
    state === 'blocked'
      ? `${t('activity.state.blocked')} · ${session.blockedBy.join(', ')}`
      : t(`activity.state.${state}`);
  const statement = session.statement?.replace(/\s+/g, ' ').trim() ?? '';
  return (
    <div
      role="row"
      id={`session-${session.id}`}
      aria-rowindex={index + 2}
      aria-selected={selected}
      className={`${styles.row} ${styles.sessions}`}
      style={{ transform: `translateY(${String(offset)}px)` }}
      data-display={state}
      data-blocker={(blocks > 0 && state !== 'blocked') || undefined}
      data-system={session.system || undefined}
      onClick={() => {
        onSelect(session.id);
      }}
    >
      <span role="gridcell" className={`${styles.cell} ${styles.mono}`}>
        {session.id}
      </span>
      <span role="gridcell" className={styles.cell} title={session.user ?? undefined}>
        {session.user ?? ''}
      </span>
      <span role="gridcell" className={styles.cell} title={session.database ?? undefined}>
        {session.database ?? ''}
      </span>
      <span
        role="gridcell"
        className={`${styles.cell} ${styles.muted}`}
        title={session.application ?? session.client ?? undefined}
      >
        {session.client ?? ''}
      </span>
      <span role="gridcell" className={styles.cell}>
        <span className={styles.state}>
          <span className={styles.dot} data-display={state} aria-hidden="true" />
          <span className={styles.stateText} title={session.wait ?? session.stateText ?? undefined}>
            {stateLabel}
          </span>
          {blocks > 0 && (
            <span className={styles.tag} data-kind="blocker">
              {t('activity.blocking', { count: blocks })}
            </span>
          )}
          {session.isSelf && (
            <Tooltip content={t('activity.self.hint')}>
              <span className={styles.tag}>{t('activity.self')}</span>
            </Tooltip>
          )}
          {session.system && <span className={styles.tag}>{t('activity.system')}</span>}
        </span>
      </span>
      <span role="gridcell" className={`${styles.cell} ${styles.mono}`}>
        {formatDuration(session.runningSecs)}
      </span>
      <span role="gridcell" className={`${styles.cell} ${styles.mono}`}>
        {formatDuration(session.transactionSecs)}
      </span>
      <span
        role="gridcell"
        className={`${styles.cell} ${styles.mono} ${styles.statement}`}
        title={statement || undefined}
      >
        {statement}
      </span>
    </div>
  );
}

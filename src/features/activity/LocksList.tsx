import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

import { useT } from '../../i18n/useT';
import type { ActivityLock } from '../../ipc';
import styles from './ActivityList.module.css';

interface LocksListProps {
  locks: readonly ActivityLock[];
  /** Opens the session a lock belongs to in the sessions view. */
  onSelectSession: (id: string) => void;
}

/** The locks of the server, those that wait first (F-140), virtualized like the sessions. */
export function LocksList({ locks, onSelectSession }: LocksListProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: locks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 12,
  });
  return (
    <div
      ref={scrollRef}
      className={styles.list}
      role="grid"
      tabIndex={0}
      aria-label={t('activity.locks.list')}
      aria-rowcount={locks.length + 1}
    >
      <div role="row" aria-rowindex={1} className={`${styles.head} ${styles.locks}`}>
        <span role="columnheader">{t('activity.locks.column.session')}</span>
        <span role="columnheader">{t('activity.locks.column.type')}</span>
        <span role="columnheader">{t('activity.locks.column.mode')}</span>
        <span role="columnheader">{t('activity.locks.column.status')}</span>
        <span role="columnheader">{t('activity.locks.column.object')}</span>
      </div>
      <div role="rowgroup" className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const lock = locks[virtual.index];
          if (!lock) return null;
          return (
            <div
              key={virtual.key}
              role="row"
              aria-rowindex={virtual.index + 2}
              className={`${styles.row} ${styles.locks}`}
              style={{ transform: `translateY(${String(virtual.start)}px)` }}
              data-display={lock.granted ? undefined : 'blocked'}
              onClick={() => {
                onSelectSession(lock.sessionId);
              }}
            >
              <span role="gridcell" className={`${styles.cell} ${styles.mono}`}>
                {lock.sessionId}
              </span>
              <span role="gridcell" className={styles.cell}>
                {lock.lockType}
              </span>
              <span role="gridcell" className={styles.cell}>
                {lock.mode}
              </span>
              <span
                role="gridcell"
                className={`${styles.cell} ${lock.granted ? '' : styles.waiting}`}
              >
                {lock.granted ? t('activity.locks.granted') : t('activity.locks.waiting')}
              </span>
              <span
                role="gridcell"
                className={`${styles.cell} ${styles.mono}`}
                title={lock.object ?? undefined}
              >
                {lock.object ?? ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

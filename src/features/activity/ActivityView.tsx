import { useMemo, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YadbeIpcError, type KillMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { useEngineInfo } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import styles from './ActivityView.module.css';
import listStyles from './ActivityList.module.css';
import { killWithConfirmation } from './activityActions';
import {
  DEFAULT_FILTERS,
  blockingCounts,
  filterLocks,
  filterSessions,
  isFiltered,
  killAvailability,
  sortSessions,
  summarize,
  type ActivityFilters,
  type StateFilter,
} from './activityModel';
import { LocksList } from './LocksList';
import { SessionDetail } from './SessionDetail';
import { SessionsList } from './SessionsList';
import { useActivity, type RefreshInterval } from './useActivity';

type View = 'sessions' | 'locks';

const SEARCH_DELAY_MS = 200;
const INTERVALS = [null, 2000, 5000, 10_000, 30_000] as const;
const INTERVAL_KEY = 'yadbe.activity.interval';
const DEFAULT_INTERVAL: RefreshInterval = 5000;

function intervalValue(interval: RefreshInterval): string {
  return interval === null ? 'off' : String(interval / 1000);
}

function readInterval(): RefreshInterval {
  try {
    const stored = localStorage.getItem(INTERVAL_KEY);
    const match = INTERVALS.find((candidate) => intervalValue(candidate) === stored);
    return match === undefined ? DEFAULT_INTERVAL : match;
  } catch {
    return DEFAULT_INTERVAL;
  }
}

function rememberInterval(interval: RefreshInterval): void {
  try {
    localStorage.setItem(INTERVAL_KEY, intervalValue(interval));
  } catch {
    // Storage unavailable: the choice lasts as long as the tab.
  }
}

/**
 * The activity monitor of a connected server (F-140): a summary and the refresh controls on
 * top, a filter, the sessions or the locks, and the detail of the selected session below.
 * Refresh is manual or timed; a read in flight is cancelled when the tab goes away.
 */
export function ActivityView({ connection }: { connection: ConnectionSummary }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const engine = useEngineInfo(connection.engine);
  const [interval, setIntervalValue] = useState<RefreshInterval>(readInterval);
  const [view, setView] = useState<View>('sessions');
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  // The session is known by its fingerprint too: an id the server gives again is not it.
  const [selection, setSelection] = useState<{ id: string; fingerprint: string } | null>(null);
  const searched = useDebouncedValue(filters.text, SEARCH_DELAY_MS);

  const activity = useActivity(connection.id, interval);
  // A failed read replaces the list: sessions that may have ended are not offered for a kill.
  const snapshot = activity.isError ? undefined : activity.data;

  const visible = useMemo(
    () =>
      snapshot
        ? sortSessions(filterSessions(snapshot.sessions, { ...filters, text: searched }))
        : [],
    [snapshot, filters, searched],
  );
  const blocking = useMemo(() => blockingCounts(snapshot?.sessions ?? []), [snapshot]);
  const summary = useMemo(
    () => (snapshot ? summarize(snapshot.sessions, filters.showSystem) : null),
    [snapshot, filters.showSystem],
  );
  const locks = useMemo(
    () => (snapshot ? filterLocks(snapshot.locks, searched) : []),
    [snapshot, searched],
  );
  const selected =
    snapshot?.sessions.find(
      (session) => session.id === selection?.id && session.fingerprint === selection.fingerprint,
    ) ?? null;
  const selectedId = selected?.id ?? null;
  const select = (id: string) => {
    const session = snapshot?.sessions.find((candidate) => candidate.id === id);
    if (session) setSelection({ id, fingerprint: session.fingerprint });
  };
  const filtered = isFiltered({ ...filters, text: searched });

  const patch = (change: Partial<ActivityFilters>) => {
    setFilters((current) => ({ ...current, ...change }));
  };

  const kill = (mode: KillMode) => {
    if (!selected || !snapshot) return;
    void killWithConfirmation(connection, selected, mode, snapshot.sessions);
  };

  const updated = activity.dataUpdatedAt
    ? new Date(activity.dataUpdatedAt).toLocaleTimeString(locale)
    : null;
  const failure = activity.error instanceof YadbeIpcError ? activity.error.error : null;

  return (
    <div className={styles.body}>
      <header className={styles.strip}>
        <Icon name="activity" />
        <h2 className={styles.title}>{t('activity.title')}</h2>
        {summary && (
          <span className={styles.summary} role="status">
            {t('activity.summary', {
              count: summary.sessions,
              sessions: summary.sessions,
              running: summary.running,
              blocked: summary.blocked,
            })}
          </span>
        )}
        <span className={styles.spacer} />
        {updated && (
          <span className={styles.updated}>{t('activity.updated', { time: updated })}</span>
        )}
        <label className={styles.intervalLabel}>
          <span className={styles.srOnly}>{t('activity.interval.label')}</span>
          <Select
            value={intervalValue(interval)}
            aria-label={t('activity.interval.label')}
            options={INTERVALS.map((candidate) => ({
              value: intervalValue(candidate),
              label:
                candidate === null
                  ? t('activity.interval.off')
                  : t(`activity.interval.${String(candidate / 1000) as '2' | '5' | '10' | '30'}`),
            }))}
            onChange={(value) => {
              const next = INTERVALS.find((candidate) => intervalValue(candidate) === value);
              if (next === undefined) return;
              setIntervalValue(next);
              rememberInterval(next);
            }}
          />
        </label>
        <IconButton
          icon="retry"
          label={t('activity.refresh')}
          disabled={activity.isFetching}
          aria-busy={activity.isFetching}
          onClick={() => {
            void activity.refetch();
          }}
        />
      </header>

      <div className={styles.controls}>
        <SegmentedControl
          label={t('activity.view.label')}
          value={view}
          options={[
            { value: 'sessions', label: t('activity.view.sessions') },
            { value: 'locks', label: t('activity.view.locks') },
          ]}
          onChange={setView}
        />
        <div className={styles.search}>
          <Icon name="search" className={styles.searchIcon} />
          <TextInput
            className={styles.searchInput}
            value={filters.text}
            placeholder={t('activity.filter.placeholder')}
            aria-label={t('activity.filter.label')}
            onChange={(event) => {
              patch({ text: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') patch({ text: '' });
            }}
          />
        </div>
        {view === 'sessions' && (
          <>
            <SegmentedControl<StateFilter>
              label={t('activity.filter.state.label')}
              value={filters.state}
              options={[
                { value: 'all', label: t('activity.filter.state.all') },
                { value: 'running', label: t('activity.filter.state.running') },
                {
                  value: 'idleInTransaction',
                  label: t('activity.filter.state.idleInTransaction'),
                },
                { value: 'blocked', label: t('activity.filter.state.blocked') },
              ]}
              onChange={(value) => {
                patch({ state: value });
              }}
            />
            <Switch
              checked={filters.showSystem}
              label={t('activity.showSystem')}
              onCheckedChange={(showSystem) => {
                patch({ showSystem });
              }}
            />
          </>
        )}
      </div>

      {snapshot?.notes.map((note) => (
        <p key={note} className={styles.note} role="note">
          <Icon name="info" />
          {t(`activity.note.${note}`)}
        </p>
      ))}

      {activity.isPending && (
        <div className={listStyles.stateMessage}>
          <Spinner />
          {t('activity.reading')}
        </div>
      )}
      {activity.isError && (
        <div className={styles.failure}>
          {failure ? (
            <ErrorPanel
              title={t('activity.error.title')}
              error={failure}
              context={{
                connectionId: connection.id,
                retry: () => {
                  void activity.refetch();
                },
              }}
            />
          ) : (
            <p>{t('activity.error.title')}</p>
          )}
        </div>
      )}

      {snapshot && view === 'sessions' && (
        <>
          {visible.length === 0 ? (
            <div className={listStyles.empty}>
              <p>{filtered ? t('activity.empty') : t('activity.emptyAll')}</p>
              {filtered && (
                <Button
                  size="sm"
                  onClick={() => {
                    patch({ text: '', state: 'all' });
                  }}
                >
                  {t('activity.filters.reset')}
                </Button>
              )}
            </div>
          ) : (
            <SessionsList
              sessions={visible}
              selectedId={selectedId}
              blocking={blocking}
              onSelect={select}
            />
          )}
          {selected && (
            <SessionDetail
              key={selected.id}
              connection={connection}
              snapshot={snapshot}
              session={selected}
              kill={killAvailability(selected, {
                readOnly: connection.definition.readOnly,
                cancelQuery: engine?.capabilities.activityCancelQuery ?? false,
              })}
              onKill={kill}
              onSelect={select}
            />
          )}
        </>
      )}

      {snapshot && view === 'locks' && (
        <>
          {locks.length === 0 ? (
            <div className={listStyles.empty}>
              <p>{filtered ? t('activity.locks.empty') : t('activity.locks.emptyAll')}</p>
            </div>
          ) : (
            <LocksList
              locks={locks}
              onSelectSession={(id) => {
                select(id);
                setView('sessions');
              }}
            />
          )}
          {snapshot.locksTruncated && (
            <p className={listStyles.truncated}>
              {t('activity.locks.truncated', { count: snapshot.locks.length })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

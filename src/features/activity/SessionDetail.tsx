import { useT } from '../../i18n/useT';
import type { ActivityLock, ActivitySession, ActivitySnapshot, KillMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import type { ConnectionSummary } from '../connections/model';
import { SqlView } from '../table-data/SqlView';
import styles from './SessionDetail.module.css';
import { copyStatement } from './activityActions';
import { displayState, formatDuration, relatives, type KillAvailability } from './activityModel';

interface SessionDetailProps {
  connection: ConnectionSummary;
  snapshot: ActivitySnapshot;
  session: ActivitySession;
  kill: KillAvailability;
  onKill: (mode: KillMode) => void;
  onSelect: (id: string) => void;
}

/** What the selected session runs, who it waits for and blocks, and what can be done to it. */
export function SessionDetail({
  connection,
  snapshot,
  session,
  kill,
  onKill,
  onSelect,
}: SessionDetailProps) {
  const t = useT();
  const { waitingFor, blocking } = relatives(snapshot, session);
  const locks = snapshot.locks.filter((lock) => lock.sessionId === session.id);
  const state = displayState(session);
  const who = [session.user, session.client].filter(Boolean).join(' · ');

  const action = (mode: KillMode, reason: KillAvailability['cancelQuery']) => {
    const label = t(
      mode === 'cancelQuery' ? 'activity.kill.cancelQuery' : 'activity.kill.terminate',
    );
    const button = (
      <Button
        size="sm"
        variant="danger"
        disabled={reason !== null}
        data-kill={mode}
        onClick={() => {
          onKill(mode);
        }}
      >
        <Icon name={mode === 'cancelQuery' ? 'stop' : 'close'} />
        {label}
      </Button>
    );
    // A disabled button gets no pointer events: its wrapper carries the reason.
    return reason === null ? (
      button
    ) : (
      <Tooltip content={t(reason)}>
        <span className={styles.disabledWrap} tabIndex={0}>
          {button}
        </span>
      </Tooltip>
    );
  };

  return (
    <section className={styles.detail} aria-label={t('activity.detail.title', { id: session.id })}>
      <header className={styles.header}>
        <h3 className={styles.title}>{t('activity.detail.title', { id: session.id })}</h3>
        <span className={styles.who}>{who}</span>
        <span className={styles.state} data-display={state}>
          {state === 'blocked' ? t('activity.state.blocked') : t(`activity.state.${state}`)}
        </span>
        {session.stateText && <span className={styles.native}>{session.stateText}</span>}
        <span className={styles.spacer} />
        {action('cancelQuery', kill.cancelQuery)}
        {action('terminateSession', kill.terminate)}
      </header>
      <div className={styles.body}>
        <div className={styles.statement}>
          <div className={styles.statementHead}>
            <span className={styles.label}>{t('activity.detail.statement')}</span>
            {session.statementTruncated && (
              <span className={styles.hint}>{t('activity.detail.truncated')}</span>
            )}
            {session.statement && (
              <IconButton
                icon="copy"
                size="sm"
                label={t('activity.detail.copy')}
                onClick={() => {
                  void copyStatement(session.statement ?? '');
                }}
              />
            )}
          </div>
          {session.statement ? (
            <SqlView
              fill
              sql={session.statement}
              engine={connection.engine}
              label={t('activity.detail.statement')}
            />
          ) : (
            <p className={styles.none}>{t('activity.detail.noStatement')}</p>
          )}
        </div>
        <div className={styles.side}>
          <dl className={styles.facts}>
            {session.runningSecs !== null && (
              <>
                <dt>{t('activity.column.duration')}</dt>
                <dd>{formatDuration(session.runningSecs)}</dd>
              </>
            )}
            {session.transactionSecs !== null && (
              <>
                <dt>{t('activity.column.transaction')}</dt>
                <dd>{formatDuration(session.transactionSecs)}</dd>
              </>
            )}
            {session.wait && (
              <>
                <dt>{t('activity.column.wait')}</dt>
                <dd>{session.wait}</dd>
              </>
            )}
            {session.application && (
              <>
                <dt>{t('activity.column.application')}</dt>
                <dd>{session.application}</dd>
              </>
            )}
            {session.database && (
              <>
                <dt>{t('activity.column.database')}</dt>
                <dd>{session.database}</dd>
              </>
            )}
          </dl>
          <Relatives
            label={t('activity.detail.blockedBy')}
            sessions={waitingFor}
            ids={session.blockedBy}
            onSelect={onSelect}
          />
          <Relatives
            label={t('activity.detail.blocking')}
            sessions={blocking}
            ids={blocking.map((s) => s.id)}
            onSelect={onSelect}
          />
          <LockSummary locks={locks} />
        </div>
      </div>
    </section>
  );
}

function Relatives({
  label,
  sessions,
  ids,
  onSelect,
}: {
  label: string;
  sessions: readonly ActivitySession[];
  ids: readonly string[];
  onSelect: (id: string) => void;
}) {
  const t = useT();
  if (ids.length === 0) return null;
  return (
    <div className={styles.group}>
      <span className={styles.label}>{label}</span>
      <ul className={styles.chips}>
        {ids.map((id) => {
          const known = sessions.find((s) => s.id === id);
          return (
            <li key={id}>
              <button
                type="button"
                className={styles.chip}
                disabled={!known}
                aria-label={t('activity.detail.goTo', { id })}
                onClick={() => {
                  onSelect(id);
                }}
              >
                <span className={styles.mono}>{id}</span>
                {known?.user && <span className={styles.muted}>{known.user}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The locks of the session, those it waits for first, a few lines of them. */
function LockSummary({ locks }: { locks: readonly ActivityLock[] }) {
  const t = useT();
  const shown = [...locks].sort((a, b) => Number(a.granted) - Number(b.granted)).slice(0, 8);
  return (
    <div className={styles.group}>
      <span className={styles.label}>{t('activity.detail.locks')}</span>
      {shown.length === 0 ? (
        <p className={styles.none}>{t('activity.detail.noLocks')}</p>
      ) : (
        <ul className={styles.locks}>
          {shown.map((lock, index) => (
            <li key={`${lock.lockType}:${lock.mode}:${lock.object ?? ''}:${String(index)}`}>
              <span className={lock.granted ? styles.granted : styles.waiting}>
                {lock.granted ? t('activity.locks.granted') : t('activity.locks.waiting')}
              </span>
              <span className={styles.mono}>
                {lock.mode} · {lock.lockType}
                {lock.object ? ` · ${lock.object}` : ''}
              </span>
            </li>
          ))}
          {locks.length > shown.length && <li className={styles.muted}>…</li>}
        </ul>
      )}
    </div>
  );
}

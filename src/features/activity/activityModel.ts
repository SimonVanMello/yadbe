import type { MessageKey } from '../../i18n/i18n';
import type { ActivityLock, ActivitySession, ActivitySnapshot, SessionState } from '../../ipc';

export type StateFilter = 'all' | 'running' | 'idleInTransaction' | 'blocked';

export interface ActivityFilters {
  text: string;
  state: StateFilter;
  /** Background workers and system sessions of the server, hidden by default. */
  showSystem: boolean;
}

export const DEFAULT_FILTERS: ActivityFilters = { text: '', state: 'all', showSystem: false };

export function isFiltered(filters: ActivityFilters): boolean {
  return filters.text.trim() !== '' || filters.state !== 'all';
}

export function isBlocked(session: ActivitySession): boolean {
  return session.blockedBy.length > 0;
}

/** What a row shows as its state: a session that waits for another one is "blocked". */
export type DisplayState = 'blocked' | SessionState;

export function displayState(session: ActivitySession): DisplayState {
  return isBlocked(session) ? 'blocked' : session.state;
}

/** How many sessions each session blocks directly, by id of the blocker. */
export function blockingCounts(sessions: readonly ActivitySession[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const blocker of session.blockedBy) counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
  }
  return counts;
}

export interface ActivitySummary {
  sessions: number;
  running: number;
  blocked: number;
}

/** Counts of what the user sees (system sessions left out unless shown). */
export function summarize(
  sessions: readonly ActivitySession[],
  showSystem: boolean,
): ActivitySummary {
  const shown = showSystem ? sessions : sessions.filter((s) => !s.system);
  return {
    sessions: shown.length,
    running: shown.filter((s) => s.state === 'active' && !isBlocked(s)).length,
    blocked: shown.filter(isBlocked).length,
  };
}

function matchesState(session: ActivitySession, state: StateFilter): boolean {
  switch (state) {
    case 'all':
      return true;
    case 'running':
      return session.state === 'active' && !isBlocked(session);
    case 'idleInTransaction':
      return session.state === 'idleInTransaction';
    case 'blocked':
      return isBlocked(session);
  }
}

function haystack(session: ActivitySession): string {
  return [
    session.id,
    session.user,
    session.database,
    session.client,
    session.application,
    session.stateText,
    session.wait,
    session.statement,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join('\n')
    .toLowerCase();
}

/** Sessions that match the text (every word), the state and the system switch. */
export function filterSessions(
  sessions: readonly ActivitySession[],
  filters: ActivityFilters,
): ActivitySession[] {
  const words = filters.text.toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if (session.system && !filters.showSystem) return false;
    if (!matchesState(session, filters.state)) return false;
    if (words.length === 0) return true;
    const text = haystack(session);
    return words.every((word) => text.includes(word));
  });
}

function rank(session: ActivitySession, blocking: ReadonlyMap<string, number>): number {
  if (blocking.has(session.id) && !isBlocked(session)) return 0;
  if (isBlocked(session)) return 1;
  switch (session.state) {
    case 'active':
      return 2;
    case 'idleInTransaction':
      return 3;
    case 'idle':
      return 4;
    case 'other':
      return 5;
  }
}

function numericId(id: string): number {
  const n = Number(id);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * What matters first: the sessions that block others, then the ones that wait, then the ones
 * that run (longest first), then the ones that hold a transaction, then the rest.
 */
export function sortSessions(sessions: readonly ActivitySession[]): ActivitySession[] {
  const blocking = blockingCounts(sessions);
  return [...sessions].sort(
    (a, b) =>
      rank(a, blocking) - rank(b, blocking) ||
      (b.transactionSecs ?? -1) - (a.transactionSecs ?? -1) ||
      (b.runningSecs ?? -1) - (a.runningSecs ?? -1) ||
      numericId(a.id) - numericId(b.id),
  );
}

/** Locks that match the text (every word), those that wait first. */
export function filterLocks(locks: readonly ActivityLock[], text: string): ActivityLock[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = locks.filter((lock) => {
    if (words.length === 0) return true;
    const line = [lock.sessionId, lock.lockType, lock.mode, lock.object ?? '']
      .join('\n')
      .toLowerCase();
    return words.every((word) => line.includes(word));
  });
  return kept
    .map((lock, index) => ({ lock, index }))
    .sort((a, b) => Number(a.lock.granted) - Number(b.lock.granted) || a.index - b.index)
    .map(({ lock }) => lock);
}

/** `3m 07s`, `1h 02m`, `850 ms`: the length of a statement or a transaction. */
export function formatDuration(secs: number | null): string {
  if (secs === null) return '';
  if (secs < 1) return `${String(Math.round(secs * 1000))} ms`;
  if (secs < 10) return `${secs.toFixed(1)} s`;
  const whole = Math.floor(secs);
  if (whole < 60) return `${String(whole)} s`;
  const minutes = Math.floor(whole / 60);
  if (whole < 3600) return `${String(minutes)}m ${String(whole % 60).padStart(2, '0')}s`;
  const hours = Math.floor(whole / 3600);
  if (whole < 86_400) return `${String(hours)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${String(Math.floor(whole / 86_400))}d ${String(hours % 24)}h`;
}

export interface KillContext {
  /** The connection is read-only: the backend refuses a kill. */
  readOnly: boolean;
  /** The engine can stop a statement without ending the session. */
  cancelQuery: boolean;
}

export interface KillAvailability {
  /** Why the action is unavailable, `null` when it is available. */
  cancelQuery: MessageKey | null;
  terminate: MessageKey | null;
}

/** What can be done to a session, and why not when it cannot. */
export function killAvailability(session: ActivitySession, context: KillContext): KillAvailability {
  const common = context.readOnly
    ? 'activity.kill.disabled.readOnly'
    : session.isSelf
      ? 'activity.kill.disabled.self'
      : session.system
        ? 'activity.kill.disabled.system'
        : null;
  return {
    terminate: common,
    cancelQuery:
      common ??
      (!context.cancelQuery
        ? 'activity.kill.disabled.noCancel'
        : session.state !== 'active'
          ? 'activity.kill.disabled.notRunning'
          : null),
  };
}

/** The sessions a session waits for and the ones it blocks, by id. */
export function relatives(
  snapshot: Pick<ActivitySnapshot, 'sessions'>,
  session: ActivitySession,
): { waitingFor: ActivitySession[]; blocking: ActivitySession[] } {
  const byId = new Map(snapshot.sessions.map((s) => [s.id, s]));
  return {
    waitingFor: session.blockedBy.flatMap((id) => byId.get(id) ?? []),
    blocking: snapshot.sessions.filter((s) => s.blockedBy.includes(session.id)),
  };
}

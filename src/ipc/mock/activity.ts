import type {
  ActivityLock,
  ActivityNote,
  ActivitySession,
  ActivitySnapshot,
  Engine,
  KillMode,
  KillOutcome,
  KillRequest,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The activity commands the mock implements. */
export type ActivityCommands = Pick<Commands, 'getActivity' | 'killSession'>;

export interface ActivityDeps {
  session(connectionId: string): { engine: Engine; database: string } | null;
  readOnly(connectionId: string): boolean;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  latency(): number;
}

/** What a mock connection's server is doing, set by a test to show a state. */
export type ActivityFault = 'insufficientPrivilege' | null;

interface MockSession extends Omit<ActivitySession, 'runningSecs' | 'transactionSecs'> {
  /** Seconds in the current state when the mock started. */
  baseSecs: number | null;
  baseTransactionSecs: number | null;
}

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

const errors = {
  notSupported: (label: string): YadbeError => ({
    code: 'notSupported',
    message: {
      en: `${label} has no sessions to watch.`,
      fr: `${label} n'a pas de sessions à surveiller.`,
    },
    action: null,
    detail: null,
  }),
  readOnly: (what: string): YadbeError => ({
    code: 'readOnlyViolation',
    message: {
      en: `This connection is read-only: ${what} may change data or the schema. Nothing was run.`,
      fr: `Cette connexion est en lecture seule : ${what} peut modifier des données ou le schéma. Rien n'a été exécuté.`,
    },
    action: 'editConnection',
    detail: null,
  }),
  privilege: (privilege: string): YadbeError => ({
    code: 'insufficientPrivilege',
    message: {
      en: `The database user cannot see other sessions. The database user needs the privilege ${privilege}.`,
      fr: `L'utilisateur de la base ne peut pas voir les autres sessions. L'utilisateur de la base a besoin du privilège ${privilege}.`,
    },
    action: null,
    detail: null,
  }),
  changed: (): YadbeError => ({
    code: 'sessionChanged',
    message: {
      en: 'That session ended or was replaced since the list was read. Refresh the list and check again.',
      fr: "Cette session s'est terminée ou a été remplacée depuis la lecture de la liste. Actualisez la liste et vérifiez à nouveau.",
    },
    action: 'retry',
    detail: null,
  }),
  self: (): YadbeError => ({
    code: 'invalidArgument',
    message: {
      en: 'This is the session yadbe reads the monitor with: stopping it would blind the monitor.',
      fr: "C'est la session que yadbe utilise pour lire le moniteur : l'arrêter l'aveuglerait.",
    },
    action: null,
    detail: null,
  }),
  cancelUnsupported: (): YadbeError => ({
    code: 'notSupported',
    message: {
      en: 'SQL Server cannot cancel another session’s statement without ending the session.',
      fr: 'SQL Server ne peut pas annuler l’instruction d’une autre session sans terminer la session.',
    },
    action: null,
    detail: null,
  }),
};

const REPORT_SQL = `SELECT c.email, date_trunc('month', o.created_at) AS month, sum(o.total) AS revenue
FROM shop.orders o
JOIN shop.customers c ON c.id = o.customer_id
WHERE o.created_at >= now() - interval '5 years'
GROUP BY 1, 2
ORDER BY 3 DESC`;

const UPDATE_SQL = `UPDATE shop.orders SET status = 'shipped' WHERE id = 1042`;

/** The sessions of a mock server: a blocker, the session it blocks, a long report, idle apps. */
function seedSessions(engine: Engine, database: string): MockSession[] {
  const word = {
    active: engine === 'mssql' ? 'running' : engine === 'mysql' ? 'Query' : 'active',
    idle: engine === 'mssql' ? 'sleeping' : engine === 'mysql' ? 'Sleep' : 'idle',
    open: engine === 'postgres' ? 'idle in transaction' : engine === 'mssql' ? 'sleeping' : 'Sleep',
  };
  const base = {
    database,
    system: false,
    isSelf: false,
    statementTruncated: false,
    blockedBy: [] as string[],
  };
  const sessions: MockSession[] = [
    {
      ...base,
      id: '4821',
      fingerprint: 'fp-4821',
      user: 'shop_app',
      client: '10.0.4.17:51234',
      application: 'orders-api',
      state: 'idleInTransaction',
      stateText: word.open,
      wait: null,
      statement: `SELECT * FROM shop.orders WHERE id = 1042 FOR UPDATE`,
      baseSecs: 212,
      baseTransactionSecs: 214,
    },
    {
      ...base,
      id: '4902',
      fingerprint: 'fp-4902',
      user: 'shop_app',
      client: '10.0.4.18:40872',
      application: 'orders-api',
      state: 'active',
      stateText: word.active,
      wait:
        engine === 'mssql' ? 'LCK_M_X' : engine === 'mysql' ? 'lock wait' : 'Lock: transactionid',
      statement: UPDATE_SQL,
      baseSecs: 187,
      baseTransactionSecs: 187,
      blockedBy: ['4821'],
    },
    {
      ...base,
      id: '4950',
      fingerprint: 'fp-4950',
      user: 'analyst',
      client: '10.0.9.3:60113',
      application: engine === 'mssql' ? 'Microsoft SQL Server Management Studio' : 'DBeaver 24',
      state: 'active',
      stateText: word.active,
      wait: engine === 'mssql' ? 'CXPACKET' : engine === 'mysql' ? null : 'IO: DataFileRead',
      statement: REPORT_SQL,
      baseSecs: 83.4,
      baseTransactionSecs: 83.4,
    },
    {
      ...base,
      id: '5003',
      fingerprint: 'fp-5003',
      user: 'shop_app',
      client: '10.0.4.17:51240',
      application: 'orders-api',
      state: 'idle',
      stateText: word.idle,
      wait: null,
      statement: 'SELECT id, status FROM shop.orders WHERE customer_id = 9',
      baseSecs: 4.2,
      baseTransactionSecs: null,
    },
    {
      ...base,
      id: '5004',
      fingerprint: 'fp-5004',
      user: 'shop_app',
      client: '10.0.4.19:38211',
      application: 'orders-api',
      state: 'idle',
      stateText: word.idle,
      wait: null,
      statement: 'COMMIT',
      baseSecs: 0.8,
      baseTransactionSecs: null,
    },
    {
      ...base,
      id: '5120',
      fingerprint: 'fp-5120',
      user: 'metabase',
      client: '10.0.7.2:44002',
      application: 'Metabase v0.50',
      state: 'idle',
      stateText: word.idle,
      wait: null,
      statement: 'select count(*) from shop.customers',
      baseSecs: 31,
      baseTransactionSecs: null,
    },
    {
      ...base,
      id: '5200',
      fingerprint: 'fp-5200',
      user: 'yadbe',
      client: '127.0.0.1:52100',
      application: 'yadbe',
      isSelf: true,
      state: 'active',
      stateText: word.active,
      wait: null,
      statement: 'SELECT pid, … FROM pg_stat_activity',
      baseSecs: 0.001,
      baseTransactionSecs: null,
    },
  ];
  if (engine === 'postgres') {
    sessions.push(
      {
        ...base,
        id: '61',
        fingerprint: 'fp-61',
        user: null,
        database: null,
        client: null,
        application: null,
        system: true,
        state: 'other',
        stateText: 'autovacuum launcher',
        wait: 'Activity: AutoVacuumMain',
        statement: null,
        baseSecs: null,
        baseTransactionSecs: null,
      },
      {
        ...base,
        id: '63',
        fingerprint: 'fp-63',
        user: 'postgres',
        database: null,
        client: null,
        application: null,
        system: true,
        state: 'other',
        stateText: 'logical replication launcher',
        wait: 'Activity: LogicalLauncherMain',
        statement: null,
        baseSecs: null,
        baseTransactionSecs: null,
      },
    );
  }
  return sessions;
}

function seedLocks(): ActivityLock[] {
  return [
    {
      sessionId: '4902',
      lockType: 'transactionid',
      mode: 'ShareLock',
      granted: false,
      object: null,
    },
    {
      sessionId: '4821',
      lockType: 'relation',
      mode: 'RowShareLock',
      granted: true,
      object: 'shop.orders',
    },
    {
      sessionId: '4821',
      lockType: 'tuple',
      mode: 'ExclusiveLock',
      granted: true,
      object: 'shop.orders',
    },
    {
      sessionId: '4902',
      lockType: 'relation',
      mode: 'RowExclusiveLock',
      granted: true,
      object: 'shop.orders',
    },
    {
      sessionId: '4950',
      lockType: 'relation',
      mode: 'AccessShareLock',
      granted: true,
      object: 'shop.customers',
    },
    {
      sessionId: '4950',
      lockType: 'relation',
      mode: 'AccessShareLock',
      granted: true,
      object: 'shop.orders',
    },
  ];
}

/** The mock of the activity monitor: one simulated server per connection. */
export function createMockActivity(deps: ActivityDeps) {
  const servers = new Map<string, { sessions: MockSession[]; locks: ActivityLock[]; at: number }>();
  const faults = new Map<string, ActivityFault>();

  function server(connectionId: string, engine: Engine, database: string) {
    let found = servers.get(connectionId);
    if (!found) {
      found = { sessions: seedSessions(engine, database), locks: seedLocks(), at: Date.now() };
      servers.set(connectionId, found);
    }
    return found;
  }

  function snapshot(connectionId: string, engine: Engine, database: string): ActivitySnapshot {
    const found = server(connectionId, engine, database);
    const elapsed = (Date.now() - found.at) / 1000;
    // A user without `pg_read_all_stats` sees who else is there but not what they run.
    const hidden = deps.readOnly(connectionId) && engine === 'postgres';
    const notes: ActivityNote[] = [];
    if (hidden) notes.push('statementsHidden');
    if (engine === 'mysql') notes.push('locksUnavailable');
    const sessions = found.sessions.map(
      ({ baseSecs, baseTransactionSecs, ...session }): ActivitySession => {
        const visible = !hidden || session.isSelf;
        return {
          ...session,
          statement: visible ? session.statement : null,
          wait: visible ? session.wait : null,
          stateText: visible ? session.stateText : null,
          state: visible ? session.state : 'other',
          runningSecs: baseSecs === null ? null : baseSecs + elapsed,
          transactionSecs: baseTransactionSecs === null ? null : baseTransactionSecs + elapsed,
        };
      },
    );
    const live = new Set(sessions.map((s) => s.id));
    const locks = engine === 'mysql' ? [] : found.locks.filter((l) => live.has(l.sessionId));
    return { sessions, locks, locksTruncated: false, notes };
  }

  function release(connectionId: string, id: string): void {
    const found = servers.get(connectionId);
    if (!found) return;
    found.sessions = found.sessions.filter((s) => s.id !== id);
    found.locks = found.locks.filter((l) => l.sessionId !== id);
    for (const session of found.sessions) {
      session.blockedBy = session.blockedBy.filter((blocker) => blocker !== id);
      if (session.blockedBy.length === 0 && session.wait?.toLowerCase().includes('lock')) {
        session.wait = null;
        session.baseSecs = 0;
        session.state = 'idle';
        session.stateText = engineIdle(session.stateText);
      }
    }
  }

  function engineIdle(current: string | null): string | null {
    if (current === 'running') return 'sleeping';
    if (current === 'Query') return 'Sleep';
    return 'idle';
  }

  const commands: ActivityCommands = {
    getActivity: async (_requestId, connectionId) => {
      const session = deps.session(connectionId);
      if (!session) {
        return fail({
          code: 'notConnected',
          message: {
            en: 'The connection is not open.',
            fr: "La connexion n'est pas ouverte.",
          },
          action: 'reconnect',
          detail: null,
        });
      }
      await sleep(deps.latency());
      if (session.engine === 'sqlite') return fail(errors.notSupported('SQLite'));
      if (faults.get(connectionId) === 'insufficientPrivilege') {
        return fail(errors.privilege(session.engine === 'mssql' ? 'VIEW SERVER STATE' : 'PROCESS'));
      }
      return ok(snapshot(connectionId, session.engine, session.database));
    },

    killSession: async (connectionId: string, request: KillRequest): Result<KillOutcome> => {
      const session = deps.session(connectionId);
      if (!session) return fail(errors.changed());
      if (session.engine === 'sqlite') return fail(errors.notSupported('SQLite'));
      if (deps.readOnly(connectionId)) {
        return fail(
          errors.readOnly(
            request.mode === 'cancelQuery' ? "cancelling a session's query" : 'ending a session',
          ),
        );
      }
      if (request.mode === 'cancelQuery' && session.engine === 'mssql') {
        return fail(errors.cancelUnsupported());
      }
      await sleep(deps.latency());
      const found = server(connectionId, session.engine, session.database);
      const target = found.sessions.find((s) => s.id === request.sessionId);
      if (!target || target.fingerprint !== request.fingerprint) return fail(errors.changed());
      if (target.isSelf) return fail(errors.self());
      const statement = killStatement(session.engine, request.mode, request.sessionId);
      deps.logStatement(connectionId, statement);
      if (request.mode === 'terminateSession') {
        release(connectionId, target.id);
      } else {
        target.state = 'idle';
        target.stateText = engineIdle(target.stateText);
        target.wait = null;
        target.baseSecs = 0;
        target.blockedBy = [];
      }
      return ok({ statement });
    },
  };

  return {
    commands,
    /** A test shows the monitor of a user who lacks the privilege to see other sessions. */
    setFault(connectionId: string, fault: ActivityFault): void {
      faults.set(connectionId, fault);
    },
    /** What the server did behind the monitor's back: a session started a long statement. */
    startSession(connectionId: string, session: Partial<ActivitySession> & { id: string }): void {
      const current = deps.session(connectionId);
      if (!current) return;
      const found = server(connectionId, current.engine, current.database);
      found.sessions.push({
        database: current.database,
        system: false,
        isSelf: false,
        statementTruncated: false,
        blockedBy: [],
        fingerprint: `fp-${session.id}`,
        user: 'shop_app',
        client: null,
        application: null,
        state: 'active',
        stateText: 'active',
        wait: null,
        statement: 'SELECT pg_sleep(60)',
        ...session,
        baseSecs: session.runningSecs ?? 0,
        baseTransactionSecs: null,
      });
    },
    forgetConnection(connectionId: string): void {
      servers.delete(connectionId);
      faults.delete(connectionId);
    },
    reset(): void {
      servers.clear();
      faults.clear();
    },
  };
}

/** Mirror of the statements the drivers send (`db/drivers/<engine>/activity.rs`). */
export function killStatement(engine: Engine, mode: KillMode, id: string): string {
  switch (engine) {
    case 'postgres':
      return mode === 'cancelQuery'
        ? `SELECT pg_cancel_backend(${id})`
        : `SELECT pg_terminate_backend(${id})`;
    case 'mssql':
      return `KILL ${id}`;
    default:
      return mode === 'cancelQuery' ? `KILL QUERY ${id}` : `KILL ${id}`;
  }
}

export type MockActivity = ReturnType<typeof createMockActivity>;

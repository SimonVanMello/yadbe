import { useLayoutStore } from '../../app/layout/layoutStore';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { useConnection, useEngineInfo, useSession, stateOf } from '../connections/connectionStore';
import { StateDot } from '../connections/StateDot';
import { endpointOfHop } from '../connections/sshModel';
import { failedCount, isFailed, useStatementLog } from '../statement-log/statementLogStore';
import { CursorPosition } from './CursorPosition';
import { TableStatus } from '../table-data/TableStatus';
import { RunStatus } from './RunStatus';
import { ScriptRunStatus } from '../document/ScriptRunStatus';
import styles from './StatusBar.module.css';

/** Bottom bar (SPEC §4): state of the active tab's connection, the statement log toggle. */
export function StatusBar() {
  const t = useT();
  const activeConnectionId = useTabsStore((state) => selectActiveTab(state).connectionId);
  const connection = useConnection(activeConnectionId);
  const session = useSession(activeConnectionId);
  const engine = useEngineInfo(connection?.engine ?? null);
  const state = stateOf(session);
  const entries = useStatementLog((store) => store.entries);
  const logOpen = useLayoutStore((store) => !store.panels.bottom.collapsed);
  const failed = failedCount(entries);
  const last = entries.at(-1);

  return (
    <footer className={styles.statusbar}>
      <div className={styles.left}>
        <RunStatus />
        <ScriptRunStatus />
        <TableStatus />
        {connection ? (
          <>
            <StateDot state={state} decorative />
            <span>
              {connection.name} ·{' '}
              {session?.tunnel?.phase === 'opening' &&
              (state === 'connecting' || state === 'reconnecting')
                ? t('connection.state.openingTunnel')
                : t(`connection.state.${state}`)}
            </span>
            {state === 'connected' && session?.serverVersion && (
              <span className={styles.muted}>{session.serverVersion}</span>
            )}
            {connection.definition.ssh && (
              <Tooltip
                content={
                  <>
                    {connection.definition.ssh.jump
                      ? t('connection.tunnel.viaJump', {
                          endpoint: endpointOfHop(connection.definition.ssh.server),
                          jump: endpointOfHop(connection.definition.ssh.jump),
                        })
                      : t('connection.tunnel.via', {
                          endpoint: endpointOfHop(connection.definition.ssh.server),
                        })}
                    <br />
                    {t(`connection.tunnel.phase.${session?.tunnel?.phase ?? 'down'}`)}
                  </>
                }
              >
                <span className={styles.badge} tabIndex={0} data-testid="tunnel-badge">
                  {t('connection.tunnel.badge')}
                </span>
              </Tooltip>
            )}
            {connection.readOnly && (
              <Tooltip
                content={
                  engine && !engine.capabilities.readOnlySession
                    ? t('connection.readOnly.hintClassifierOnly', { engine: engine.label })
                    : t('connection.readOnly.hint')
                }
              >
                <span className={styles.badge} tabIndex={0} data-testid="read-only-badge">
                  {t('connection.readOnly')}
                </span>
              </Tooltip>
            )}
          </>
        ) : (
          <span className={styles.muted}>{t('statusbar.noConnection')}</span>
        )}
      </div>
      <div className={styles.right}>
        <CursorPosition />
        {last && (
          <span className={styles.last} title={last.sql}>
            {!isFailed(last) ? (
              <Icon name="check" />
            ) : (
              <Icon name="error" className={styles.failedIcon} />
            )}
            <code>{last.sql.replace(/\s+/g, ' ')}</code>
          </span>
        )}
        <button
          type="button"
          className={styles.logButton}
          aria-pressed={logOpen}
          onClick={() => {
            useLayoutStore.getState().togglePanel('bottom');
          }}
        >
          <Icon name="log" />
          {t('statusbar.log')}
          {failed > 0 && <span className={styles.failedBadge}>{failed}</span>}
        </button>
      </div>
    </footer>
  );
}

import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import type { ConnectionSummary } from '../connections/model';
import queryStyles from '../query/QueryControls.module.css';
import { useQueryTabStore } from '../query/queryTabStore';
import { runConsole, stopConsole } from './kvConsoleActions';
import { useKvConsole } from './kvConsoleStore';
import styles from './KvConsoleControls.module.css';

/**
 * The toolbar of a key-value console: run (the selected lines, else all), run the line under
 * the cursor, stop after the current command, and the database the console is on.
 */
export function KvConsoleControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const shortcutOf = useShortcutOf();
  const run = useKvConsole(tabId);
  const selection = useQueryTabStore((state) => state.tabs[tabId]?.selection);
  const hasSelection = selection !== undefined && selection.anchor !== selection.head;
  const database = run.database ?? (Number(connection.database) || 0);
  const runLabel = hasSelection ? t('keyValue.console.runSelection') : t('keyValue.console.runAll');

  return (
    <>
      <span className={queryStyles.group}>
        <Tooltip content={runLabel} shortcut={shortcutOf('query.run')}>
          <Button
            variant="primary"
            size="sm"
            disabled={run.running}
            onClick={() => {
              void runConsole(tabId, 'auto');
            }}
          >
            <Icon name="play" />
            {runLabel}
          </Button>
        </Tooltip>
        <Tooltip
          content={t('keyValue.console.runLine')}
          shortcut={shortcutOf('query.runStatement')}
        >
          <Button
            size="sm"
            disabled={run.running}
            onClick={() => {
              void runConsole(tabId, 'line');
            }}
          >
            <Icon name="terminal" />
            {t('keyValue.console.runLine')}
          </Button>
        </Tooltip>
      </span>
      <Tooltip content={t('keyValue.console.stopHint')} shortcut={shortcutOf('query.cancel')}>
        <Button
          size="sm"
          disabled={!run.running}
          onClick={() => {
            stopConsole(tabId);
          }}
        >
          <Icon name="stop" />
          {t('keyValue.console.stop')}
        </Button>
      </Tooltip>
      <span className={queryStyles.separator} />
      <span className={styles.database} title={t('keyValue.console.databaseHint')}>
        <Icon name="database" size="sm" />
        db{database}
      </span>
    </>
  );
}

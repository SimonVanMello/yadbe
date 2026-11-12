import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { cancelConsole, runConsole } from './consoleActions';
import { useConsoleTab } from './consoleStore';
import styles from './DocumentControls.module.css';

/** The toolbar of a document console tab: run, cancel, the chip. */
export function ConsoleControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const shortcutOf = useShortcutOf();
  const state = useConnectionState(connection.id);
  const { running } = useConsoleTab(tabId);
  return (
    <>
      <span className={styles.group} role="group" aria-label={t('mongo.console.toolbar')}>
        <IconButton
          icon="play"
          label={t('mongo.console.run')}
          shortcut={shortcutOf('query.run')}
          disabled={state !== 'connected' || running}
          onClick={() => {
            void runConsole(tabId);
          }}
        />
        <IconButton
          icon="stop"
          label={t('mongo.cancel')}
          disabled={!running}
          onClick={() => {
            cancelConsole(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={connection} state={state} />
    </>
  );
}

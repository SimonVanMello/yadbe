import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { cancelScript, runScript } from './scriptActions';
import { useScriptTab } from './scriptStore';
import styles from './DocumentControls.module.css';

/** The toolbar of a document query tab (mongosh): run, cancel, the chip. */
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
  const { running } = useScriptTab(tabId);
  return (
    <>
      <span className={styles.group} role="group" aria-label={t('mongo.console.toolbar')}>
        <IconButton
          icon="play"
          label={t('mongo.console.run')}
          shortcut={shortcutOf('query.run')}
          disabled={state !== 'connected' || running}
          onClick={() => {
            void runScript(tabId);
          }}
        />
        <IconButton
          icon="stop"
          label={t('mongo.cancel')}
          disabled={!running}
          onClick={() => {
            cancelScript(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={connection} state={state} />
    </>
  );
}

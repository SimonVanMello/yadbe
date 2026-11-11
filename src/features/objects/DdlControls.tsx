import { useT } from '../../i18n/useT';
import type { DdlTarget } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import styles from './DdlControls.module.css';
import { copyDdl, openDdlInQuery } from './ddlActions';
import { ddlTargetName, ddlTargetObject } from './objectsModel';
import { useDdl } from './useDdl';

/**
 * The DDL-tab part of the toolbar (F-024): open the text in a query tab, copy it, read it
 * again, and the connection chip. The tab is bound to its connection: the chip does not switch.
 */
export function DdlControls({
  target,
  connection,
}: {
  target: DdlTarget;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const ddl = useDdl(connection.id, target);
  const text = ddl.data?.sql ?? null;
  const shown = { ...connection, database: ddlTargetObject(target).database };

  return (
    <>
      <span
        className={styles.group}
        role="group"
        aria-label={t('objects.ddl.label', { name: ddlTargetName(target) })}
      >
        <Button
          size="sm"
          disabled={text === null}
          onClick={() => {
            if (text !== null) openDdlInQuery(connection.id, target, text);
          }}
        >
          <Icon name="terminal" />
          {t('objects.ddl.openInQuery')}
        </Button>
        <IconButton
          icon="copy"
          label={t('objects.ddl.copy')}
          disabled={text === null}
          onClick={() => {
            if (text !== null) void copyDdl(text);
          }}
        />
        <IconButton
          icon="retry"
          label={t('objects.ddl.reload')}
          disabled={state !== 'connected' || ddl.isFetching}
          onClick={() => {
            void ddl.refetch();
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={shown} state={state} />
    </>
  );
}

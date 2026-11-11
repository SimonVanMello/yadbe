import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { localize } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { YadbeIpcError, type DdlTarget } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../connections/connectionActions';
import { ConnectionChip } from '../connections/ConnectionChip';
import {
  useConnection,
  useConnectionList,
  useConnectionState,
} from '../connections/connectionStore';
import { SqlView } from '../table-data/SqlView';
import { tableLabel } from '../table-data/tableNames';
import styles from './DdlTabBody.module.css';
import { ddlTargetKind, ddlTargetName, ddlTargetObject, toolKindKey } from './objectsModel';
import { useDdl } from './useDdl';

/**
 * Body of a DDL tab (F-024): the definition of one object, read-only and highlighted like the
 * editor, with where the text comes from: the server's own, or rebuilt from the catalog.
 */
export function DdlTabBody({ tab, target }: { tab: ShellTab; target: DdlTarget }) {
  const t = useT();
  useI18nStore((state) => state.locale);
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);
  const connected = state === 'connected';
  const ddl = useDdl(tab.connectionId ?? '', target);
  const object = ddlTargetObject(target);
  const name = ddlTargetName(target);

  if (!connection) {
    if (list.isPending) {
      return (
        <div className={styles.placeholder}>
          <Spinner />
        </div>
      );
    }
    return (
      <div className={styles.placeholder}>
        <Icon name="warning" size="lg" className={styles.warning} />
        <p className={styles.title}>{t('tab.body.missing')}</p>
        <Button
          onClick={() => {
            useTabsStore.getState().closeTab(tab.id);
          }}
        >
          {t('tab.menu.close')}
        </Button>
      </div>
    );
  }

  if (!connected) {
    const busy = state === 'connecting' || state === 'reconnecting';
    return (
      <div className={styles.placeholder}>
        <ConnectionChip connection={connection} state={state} size="md" />
        <p className={styles.title}>{tableLabel({ schema: object.schema, name })}</p>
        <p className={styles.text}>{t('objects.ddl.noConnection')}</p>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            void connectTo(connection);
          }}
        >
          {busy ? <Spinner /> : <Icon name="database" />}
          {t('tableData.connect')}
        </Button>
      </div>
    );
  }

  const failure = ddl.error instanceof YadbeIpcError ? ddl.error.error : null;
  return (
    <div className={styles.body}>
      <div className={styles.strip}>
        <span className={styles.kind}>{t(toolKindKey(ddlTargetKind(target)))}</span>
        <span className={styles.name}>{tableLabel({ schema: object.schema, name })}</span>
        {ddl.data && (
          <span className={styles.source} data-source={ddl.data.source}>
            {t(
              ddl.data.source === 'catalog'
                ? 'objects.ddl.source.catalog'
                : 'objects.ddl.source.reconstructed',
            )}
          </span>
        )}
        <span className={styles.readOnly}>
          <Icon name="lock" />
          {t('objects.ddl.readOnly')}
        </span>
      </div>
      {ddl.isPending && (
        <div className={styles.loading}>
          <Spinner />
          {t('objects.ddl.loading')}
        </div>
      )}
      {ddl.isError && (
        <div className={styles.failure} role="alert">
          <Icon name="error" className={styles.errorIcon} />
          <p className={styles.title}>{t('objects.ddl.failed')}</p>
          <p className={styles.text}>{failure ? localize(failure.message) : String(ddl.error)}</p>
          {failure?.detail && <pre className={styles.detail}>{failure.detail}</pre>}
          <Button
            onClick={() => {
              void ddl.refetch();
            }}
          >
            <Icon name="retry" />
            {t('objects.ddl.reload')}
          </Button>
        </div>
      )}
      {ddl.data && (
        <SqlView
          fill
          sql={ddl.data.sql}
          engine={connection.engine}
          label={t('objects.ddl.label', { name })}
        />
      )}
    </div>
  );
}

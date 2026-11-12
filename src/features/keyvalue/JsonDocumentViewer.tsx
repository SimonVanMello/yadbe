import { useQuery } from '@tanstack/react-query';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError, type KvBytes } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { JsonView } from '../grid/JsonView';
import { tryParseJson } from '../grid/jsonTree';
import editStyles from './KeyEdit.module.css';
import styles from './KeyTab.module.css';
import { bytesId } from './kvBytes';
import { editJson } from './kvEditForms';
import { useTabEdits } from './kvEditStore';

/**
 * A RedisJSON document (`JSON.GET`), in the grid's JSON tree (numbers kept exact). Edited
 * whole or at a path (M4-6): the change is staged in the tab, the document shown as it will be
 * when the whole of it is replaced.
 */
export function JsonDocumentViewer({
  tabId,
  editable,
  connectionId,
  database,
  keyBytes,
}: {
  tabId: string;
  editable: boolean;
  connectionId: string;
  database: number;
  keyBytes: KvBytes;
}) {
  const t = useT();
  const edits = useTabEdits(tabId);
  const doc = useQuery({
    queryKey: ['kvJson', connectionId, database, bytesId(keyBytes)],
    queryFn: () => unwrap(ipc.commands.kvReadJson(connectionId, database, keyBytes)),
    staleTime: Infinity,
    gcTime: 0,
  });
  const staged = edits.flatMap((e) => (e.op === 'jsonSet' ? [e] : []));
  const whole = staged.find((e) => e.path === '$');
  const shown = whole ? whole.value : doc.data;
  const tree = shown === undefined ? null : tryParseJson(shown);

  if (doc.isPending) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (doc.isError) {
    return (
      <div className={styles.center}>
        {doc.error instanceof YadbeIpcError && (
          <ErrorPanel title={t('keyValue.tab.readFailed')} error={doc.error.error} />
        )}
      </div>
    );
  }
  const source = doc.data;
  return (
    <>
      {editable && (
        <div className={styles.toolbar}>
          <Button
            size="sm"
            onClick={() => {
              void editJson(tabId, keyBytes, source);
            }}
          >
            <Icon name="pencil" />
            {t('keyValue.json.edit')}
          </Button>
        </div>
      )}
      {staged.length > 0 && (
        <div className={editStyles.pendingValue} role="status">
          {t('keyValue.json.pending', {
            paths: staged.map((e) => e.path).join(', '),
          })}
        </div>
      )}
      {tree === null ? (
        <pre className={styles.content}>{shown}</pre>
      ) : (
        <div className={styles.json} data-testid="kv-json">
          <JsonView tree={tree} openness="auto" />
        </div>
      )}
    </>
  );
}

import { useT } from '../../i18n/useT';
import type { KvBytes } from '../../ipc';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { useConnection } from '../connections/connectionStore';
import { copyKey, createKey, deleteKeys, deleteNamespace, renameKey } from './kvEditForms';
import { clearMarks, markedKeys, useMarkCount } from './kvMarkStore';

type Target =
  | { kind: 'database'; database: number }
  | { kind: 'namespace'; database: number; prefix: KvBytes }
  | { kind: 'key'; database: number; key: KvBytes };

/**
 * The edit entries of a key-value explorer row's context menu (M4-6): create a key in a
 * database or a namespace, delete a namespace, rename, duplicate or delete a key (or the keys
 * marked with Ctrl / Cmd + click). Disabled with the reason on a read-only connection.
 */
export function KvEditMenuItems({
  connectionId,
  target,
}: {
  connectionId: string;
  target: Target;
}) {
  const t = useT();
  const connection = useConnection(connectionId);
  const readOnly = connection?.readOnly ?? true;
  const marked = useMarkCount(connectionId, target.database);
  const why = readOnly ? ` — ${t('keyValue.edit.readOnly')}` : '';
  switch (target.kind) {
    case 'database':
      return (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="plus"
            disabled={readOnly}
            onSelect={() => {
              void createKey(connectionId, target.database, '', true);
            }}
          >
            {t('keyValue.tree.createKey')}
            {why}
          </ContextMenuItem>
        </>
      );
    case 'namespace':
      return (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="plus"
            disabled={readOnly}
            onSelect={() => {
              void createKey(connectionId, target.database, target.prefix.text, true);
            }}
          >
            {t('keyValue.tree.createKeyHere')}
            {why}
          </ContextMenuItem>
          <ContextMenuItem
            icon="trash"
            disabled={readOnly}
            onSelect={() => {
              void deleteNamespace(connectionId, target.database, target.prefix);
            }}
          >
            {t('keyValue.tree.deleteNamespace')}
            {why}
          </ContextMenuItem>
        </>
      );
    case 'key': {
      const many = marked > 1;
      return (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="pencil"
            disabled={readOnly}
            onSelect={() => {
              void renameKey(connectionId, target.database, target.key);
            }}
          >
            {t('keyValue.tree.renameKey')}
            {why}
          </ContextMenuItem>
          <ContextMenuItem
            icon="copy"
            disabled={readOnly}
            onSelect={() => {
              void copyKey(connectionId, target.database, target.key);
            }}
          >
            {t('keyValue.tree.duplicateKey')}
            {why}
          </ContextMenuItem>
          <ContextMenuItem
            icon="trash"
            disabled={readOnly}
            onSelect={() => {
              const keys = many ? markedKeys(connectionId, target.database) : [target.key];
              void deleteKeys(connectionId, target.database, keys).then((done) => {
                if (done) clearMarks();
              });
            }}
          >
            {many
              ? t('keyValue.tree.deleteMarked', { count: marked })
              : t('keyValue.tree.deleteKey')}
            {why}
          </ContextMenuItem>
        </>
      );
    }
  }
}

import type { ObjectRef } from '../../ipc';
import { useConnection } from '../../features/connections/connectionStore';
import { CollectionTabBody } from '../../features/document/CollectionTabBody';
import { TableTabBody } from '../../features/table-data/TableTabBody';
import type { ShellTab } from './tabsStore';

/**
 * Body of a tab that browses one object's data, chosen by the connection's engine family like
 * the query tab's (`QueryTabBody`): a table or view's rows for SQL, a collection's documents for
 * the document family. While the connection list loads (or after the connection was deleted),
 * the table body shows what to say.
 */
export function DataTabBody({ tab, table }: { tab: ShellTab; table: ObjectRef }) {
  const connection = useConnection(tab.connectionId);
  switch (connection?.family) {
    case 'document':
      return <CollectionTabBody tab={tab} table={table} />;
    default:
      return <TableTabBody tab={tab} table={table} />;
  }
}

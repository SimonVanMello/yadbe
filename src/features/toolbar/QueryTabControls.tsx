import type { ConnectionSummary } from '../connections/model';
import { KvConsoleControls } from '../keyvalue/KvConsoleControls';
import { QueryControls } from '../query/QueryControls';

/**
 * The toolbar controls of a query tab, chosen by the connection's engine family like the tab's
 * body (`QueryTabBody`): run, cancel, transactions, plans and files for SQL.
 */
export function QueryTabControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  switch (connection.family) {
    case 'sql':
      return <QueryControls tabId={tabId} connection={connection} />;
    case 'keyValue':
      return <KvConsoleControls tabId={tabId} connection={connection} />;
    default:
      return null;
  }
}

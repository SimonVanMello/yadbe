import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';

/**
 * The tool-tab part of the toolbar (F-140, F-143): the connection chip, environment included. A
 * tool tab is bound to its connection, so the chip does not switch.
 */
export function ToolControls({ connection }: { connection: ConnectionSummary }) {
  const state = useConnectionState(connection.id);
  return <ConnectionChip connection={connection} state={state} />;
}

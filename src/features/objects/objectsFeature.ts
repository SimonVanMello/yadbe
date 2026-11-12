import { queryClient } from '../../app/queryClient';
import { ipc } from '../../ipc';
import { ddlKeys } from './useDdl';
import { usePinStore } from './pinStore';

let started = false;

/**
 * Wires the object tools into the shell, once per app launch: the pins are read, and the
 * definitions on screen are read again whenever the metadata they come from is refreshed.
 */
export function startObjectsFeature(): void {
  if (started) return;
  started = true;
  void usePinStore.getState().load();
  ipc.events.subscribe('metaRefreshed', ({ connectionId }) => {
    void queryClient.invalidateQueries({ queryKey: ddlKeys.connection(connectionId) });
  });
}

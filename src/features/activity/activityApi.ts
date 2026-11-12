import { ipc, unwrap, type ActivitySnapshot, type KillMode, type KillOutcome } from '../../ipc';
import { cancellableRead } from '../tools/cancellableRead';

/** Sessions, locks and blockers of the server (F-140). Rejects with a `YadbeIpcError`. */
export function fetchActivity(
  connectionId: string,
  signal?: AbortSignal,
): Promise<ActivitySnapshot> {
  return cancellableRead('activity', signal, (id) => ipc.commands.getActivity(id, connectionId));
}

/** Cancels the statement of a session or ends it, as the list showed it. */
export function killSession(
  connectionId: string,
  session: { id: string; fingerprint: string },
  mode: KillMode,
): Promise<KillOutcome> {
  return unwrap(
    ipc.commands.killSession(connectionId, {
      sessionId: session.id,
      fingerprint: session.fingerprint,
      mode,
    }),
  );
}

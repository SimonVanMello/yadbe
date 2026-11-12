import { ipc, type EfMigrations, type ObjectRef } from '../../ipc';
import { cancellableRead } from '../tools/cancellableRead';

/** The migrations recorded in a history table, oldest first (F-143). */
export function fetchMigrations(
  connectionId: string,
  table: ObjectRef,
  signal?: AbortSignal,
): Promise<EfMigrations> {
  return cancellableRead('migrations', signal, (id) =>
    ipc.commands.getEfMigrations(id, connectionId, table),
  );
}

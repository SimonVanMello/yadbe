import {
  ipc,
  unwrap,
  type DdlTarget,
  type IpcResult,
  type ObjectActionOutcome,
  type ObjectActionPlan,
  type ObjectActionRequest,
  type ObjectDdl,
  type ObjectKind,
  type ObjectProperties,
  type ObjectRef,
} from '../../ipc';

let counter = 0;

/**
 * Runs a read the backend can stop: aborting `signal` (the tab closed, the dialog was dismissed)
 * cancels it on the server.
 */
async function read<T>(
  signal: AbortSignal | undefined,
  call: (requestId: string) => Promise<IpcResult<T>>,
): Promise<T> {
  counter += 1;
  const requestId = `objects-${Date.now().toString(36)}-${counter.toString(36)}`;
  const cancel = () => {
    void ipc.commands.cancelMetaRequest(requestId).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await unwrap(call(requestId));
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** The definition of an object (F-024). Rejects with a `YadbeIpcError`. */
export function fetchDdl(
  connectionId: string,
  target: DdlTarget,
  signal?: AbortSignal,
): Promise<ObjectDdl> {
  return read(signal, (id) => ipc.commands.getObjectDdl(id, connectionId, target));
}

/** The facts the engine exposes about a table or view (F-025). */
export function fetchProperties(
  connectionId: string,
  object: ObjectRef,
  kind: ObjectKind,
  signal?: AbortSignal,
): Promise<ObjectProperties> {
  return read(signal, (id) => ipc.commands.getObjectProperties(id, connectionId, object, kind));
}

/** The statement of a drop, truncate or rename and what it affects; runs nothing (F-026). */
export function planAction(
  connectionId: string,
  request: ObjectActionRequest,
  signal?: AbortSignal,
): Promise<ObjectActionPlan> {
  return read(signal, (id) => ipc.commands.planObjectAction(id, connectionId, request));
}

export function runAction(
  connectionId: string,
  request: ObjectActionRequest,
): Promise<ObjectActionOutcome> {
  return read(undefined, (id) => ipc.commands.runObjectAction(id, connectionId, request));
}

import { ipc, unwrap, type IpcResult } from '../../ipc';

let counter = 0;

/**
 * Runs a read the backend can stop: aborting `signal` (the tab closed, a newer refresh took
 * over) cancels it on the server through the shared request-cancel command. `prefix` names the
 * feature in the request id.
 */
export async function cancellableRead<T>(
  prefix: string,
  signal: AbortSignal | undefined,
  call: (requestId: string) => Promise<IpcResult<T>>,
): Promise<T> {
  counter += 1;
  const requestId = `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
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

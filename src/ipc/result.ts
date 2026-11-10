import type { YadbeError } from './bindings';

export type IpcResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: YadbeError };

/** Thrown by `unwrap`, so TanStack Query and error boundaries get the typed backend error. */
export class YadbeIpcError extends Error {
  readonly error: YadbeError;

  constructor(error: YadbeError) {
    super(error.message.en);
    this.name = 'YadbeIpcError';
    this.error = error;
  }
}

/** Turns a command result into its data, or throws a `YadbeIpcError`. */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const value = await result;
  if (value.status === 'error') throw new YadbeIpcError(value.error);
  return value.data;
}

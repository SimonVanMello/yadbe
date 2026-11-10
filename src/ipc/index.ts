import type { YadbeClient } from './client';
import { mockBackend, mockClient, type MockBackend } from './mockClient';
import { tauriClient } from './tauriClient';

export type {
  YadbeClient,
  YadbeCommands,
  YadbeEventHandler,
  YadbeEventMap,
  YadbeEventName,
  YadbeEvents,
  Unsubscribe,
} from './client';
export type * from './bindings';
export { YadbeIpcError, unwrap, type IpcResult } from './result';

export const isMock = import.meta.env.VITE_MOCK === '1';

declare global {
  interface Window {
    /** Mock backend controls, exposed in mock mode for Playwright and manual testing. */
    __yadbeMock?: MockBackend;
  }
}

if (isMock) window.__yadbeMock = mockBackend;

/** The only entry point to the backend for the rest of the frontend. */
export const ipc: YadbeClient = isMock ? mockClient : tauriClient;

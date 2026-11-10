import type { AppInfo } from './bindings';
import type { YadbeClient, YadbeEventMap, YadbeEventName } from './client';
import { EventEmitter } from './emitter';

/** Version reported by the mock backend: the one of the app it stands in for. */
const MOCK_APP_INFO: AppInfo = { appVersion: '0.1.0', os: 'linux', arch: 'x86_64' };

/** In-memory backend for `pnpm dev`, Playwright and Vitest. Implements every command. */
function createMockBackend() {
  const events = new EventEmitter();
  let appInfo: AppInfo = MOCK_APP_INFO;

  const commands: YadbeClient['commands'] = {
    appInfo: () => Promise.resolve({ status: 'ok', data: appInfo }),
  };

  return {
    commands,
    events,
    /** Pushes a backend event to the subscribers, as the real backend would. */
    emit<K extends YadbeEventName>(name: K, payload: YadbeEventMap[K]): void {
      events.emit(name, payload);
    },
    /** Replaces what `appInfo` returns (tests). */
    setAppInfo(info: AppInfo): void {
      appInfo = info;
    },
    reset(): void {
      appInfo = MOCK_APP_INFO;
    },
  };
}

export type MockBackend = ReturnType<typeof createMockBackend>;

export const mockBackend: MockBackend = createMockBackend();

export const mockClient: YadbeClient = {
  commands: mockBackend.commands,
  events: mockBackend.events,
};

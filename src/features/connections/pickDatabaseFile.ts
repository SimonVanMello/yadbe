import { isMock } from '../../ipc';

/**
 * Whether the app can open a file picker. The real picker is a native dialog (Tauri dialog
 * plugin or a backend command), not wired yet: until then the path is typed or pasted, and
 * only the browser mock offers a stand-in.
 */
export const canPickDatabaseFile = isMock;

/** Asks for a database file; `null` when dismissed or unavailable. */
export function pickDatabaseFile(): Promise<string | null> {
  if (!canPickDatabaseFile) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sqlite,.sqlite3,.db,.db3,application/vnd.sqlite3';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      // A browser never reveals the real path: the mock makes one up from the name.
      resolve(file ? `/home/ana/data/${file.name}` : null);
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}

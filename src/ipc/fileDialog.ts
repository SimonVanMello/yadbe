import { open } from '@tauri-apps/plugin-dialog';

/** Labels of the picker, in the UI language (the native dialog shows them). */
export interface DatabaseFilePickerLabels {
  title: string;
  sqliteFiles: string;
  allFiles: string;
}

/**
 * Native file dialogs (SPEC §9: file access only through explicit open / save dialogs). Not part
 * of the generated contract: they go through Tauri's dialog plugin, with a browser stand-in in
 * mock mode.
 */
export interface FileDialog {
  /** Asks for an existing database file; `null` when dismissed. */
  pickDatabaseFile: (labels: DatabaseFilePickerLabels) => Promise<string | null>;
}

const SQLITE_EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'];

const tauriFileDialog: FileDialog = {
  async pickDatabaseFile(labels) {
    const path = await open({
      title: labels.title,
      multiple: false,
      directory: false,
      filters: [
        { name: labels.sqliteFiles, extensions: SQLITE_EXTENSIONS },
        { name: labels.allFiles, extensions: ['*'] },
      ],
    });
    return path;
  },
};

const browserFileDialog: FileDialog = {
  pickDatabaseFile: () =>
    new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = [...SQLITE_EXTENSIONS.map((ext) => `.${ext}`), 'application/vnd.sqlite3'].join(
        ',',
      );
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        // A browser never reveals the real path: the mock makes one up from the name.
        resolve(file ? `/home/ana/data/${file.name}` : null);
      });
      input.addEventListener('cancel', () => {
        resolve(null);
      });
      input.click();
    }),
};

export const fileDialog: FileDialog =
  import.meta.env.VITE_MOCK === '1' ? browserFileDialog : tauriFileDialog;

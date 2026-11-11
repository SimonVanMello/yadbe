import { open, save } from '@tauri-apps/plugin-dialog';

import { mockBackend } from './mockClient';

/** Labels of the picker, in the UI language (the native dialog shows them). */
export interface DatabaseFilePickerLabels {
  title: string;
  sqliteFiles: string;
  allFiles: string;
}

/** Labels of the open / save dialogs of SQL scripts. */
export interface SqlFilePickerLabels {
  title: string;
  sqlFiles: string;
  allFiles: string;
}

/** Labels of the open / save dialogs of a library file (JSON). */
export interface JsonFilePickerLabels {
  title: string;
  jsonFiles: string;
  allFiles: string;
}

/** Labels of the private key picker. */
export interface KeyFilePickerLabels {
  title: string;
  allFiles: string;
}

/**
 * Native file dialogs (SPEC §9: file access only through explicit open / save dialogs). Not part
 * of the generated contract: they go through Tauri's dialog plugin, with a browser stand-in in
 * mock mode. The files themselves are read and written by the `readTextFile` / `writeTextFile`
 * commands.
 */
export interface FileDialog {
  /** Asks for an existing database file; `null` when dismissed. */
  pickDatabaseFile: (labels: DatabaseFilePickerLabels) => Promise<string | null>;
  /** Asks for an existing SQL script; `null` when dismissed. */
  pickSqlFile: (labels: SqlFilePickerLabels) => Promise<string | null>;
  /** Asks where to save a SQL script; `null` when dismissed. */
  pickSqlSavePath: (labels: SqlFilePickerLabels, defaultName: string) => Promise<string | null>;
  /** Asks for an exported query library; `null` when dismissed. */
  pickJsonFile: (labels: JsonFilePickerLabels) => Promise<string | null>;
  /** Asks where to export the query library; `null` when dismissed. */
  pickJsonSavePath: (labels: JsonFilePickerLabels, defaultName: string) => Promise<string | null>;
  /** Asks for an SSH private key file (only its path is kept, never its content). */
  pickKeyFile: (labels: KeyFilePickerLabels) => Promise<string | null>;
}

const SQLITE_EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3'];
const SQL_EXTENSIONS = ['sql', 'ddl', 'dml', 'psql', 'pgsql', 'tsql', 'txt'];

const sqlFilters = (labels: SqlFilePickerLabels) => [
  { name: labels.sqlFiles, extensions: SQL_EXTENSIONS },
  { name: labels.allFiles, extensions: ['*'] },
];

const jsonFilters = (labels: JsonFilePickerLabels) => [
  { name: labels.jsonFiles, extensions: ['json'] },
  { name: labels.allFiles, extensions: ['*'] },
];

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
  async pickSqlFile(labels) {
    return open({
      title: labels.title,
      multiple: false,
      directory: false,
      filters: sqlFilters(labels),
    });
  },
  async pickSqlSavePath(labels, defaultName) {
    return save({ title: labels.title, defaultPath: defaultName, filters: sqlFilters(labels) });
  },
  async pickJsonFile(labels) {
    return open({
      title: labels.title,
      multiple: false,
      directory: false,
      filters: jsonFilters(labels),
    });
  },
  async pickJsonSavePath(labels, defaultName) {
    return save({ title: labels.title, defaultPath: defaultName, filters: jsonFilters(labels) });
  },
  async pickKeyFile(labels) {
    // Key files have no extension (id_ed25519) or various ones (.pem, .key, .ppk).
    return open({
      title: labels.title,
      multiple: false,
      directory: false,
      filters: [{ name: labels.allFiles, extensions: ['*'] }],
    });
  },
};

/** What a browser can offer: a file chooser, never a real path (the mock makes one up). */
function chooseBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}

const browserFileDialog: FileDialog = {
  async pickDatabaseFile() {
    const file = await chooseBrowserFile(
      [...SQLITE_EXTENSIONS.map((ext) => `.${ext}`), 'application/vnd.sqlite3'].join(','),
    );
    return file ? `/home/ana/data/${file.name}` : null;
  },
  async pickSqlFile() {
    const file = await chooseBrowserFile(SQL_EXTENSIONS.map((ext) => `.${ext}`).join(','));
    if (!file) return null;
    const path = `/home/ana/queries/${file.name}`;
    // The mock backend reads files from its own disk: put what was chosen there.
    mockBackend.setFile(path, await file.text());
    return path;
  },
  pickSqlSavePath(_labels, defaultName) {
    // No save dialog in a browser: the mock saves next to the other scripts.
    return Promise.resolve(`/home/ana/queries/${defaultName}`);
  },
  async pickJsonFile() {
    const file = await chooseBrowserFile('.json,application/json');
    if (!file) return null;
    const path = `/home/ana/exports/${file.name}`;
    mockBackend.setFile(path, await file.text());
    return path;
  },
  pickJsonSavePath(_labels, defaultName) {
    return Promise.resolve(`/home/ana/exports/${defaultName}`);
  },
  async pickKeyFile() {
    const file = await chooseBrowserFile('');
    return file ? `/home/ana/.ssh/${file.name}` : null;
  },
};

export const fileDialog: FileDialog =
  import.meta.env.VITE_MOCK === '1' ? browserFileDialog : tauriFileDialog;

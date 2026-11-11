import { open } from '@tauri-apps/plugin-dialog';

import { mockBackend } from './mockClient';

/** What the open dialog of an import shows, in the UI language. */
export interface ImportPickRequest {
  title: string;
  /** Name of the data file types, then "All files". */
  filterName: string;
  allFiles: string;
}

/** What the open dialog of a connections file shows, in the UI language. */
export interface ConnectionsPickRequest {
  title: string;
  filterName: string;
  allFiles: string;
  /** Extensions of the file type; `['*']` for any file (`.pgpass` has none). */
  extensions: string[];
}

/**
 * The native open dialogs of the imports (SPEC §9: file access only through explicit dialogs).
 * The backend reads the file itself; only its path crosses. `null` when dismissed.
 */
export interface ImportDialog {
  pickDataFile(request: ImportPickRequest): Promise<string | null>;
  pickConnectionsFile(request: ConnectionsPickRequest): Promise<string | null>;
}

const DATA_EXTENSIONS = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson'];

const tauriImportDialog: ImportDialog = {
  pickDataFile: (request) =>
    open({
      title: request.title,
      multiple: false,
      directory: false,
      filters: [
        { name: request.filterName, extensions: DATA_EXTENSIONS },
        { name: request.allFiles, extensions: ['*'] },
      ],
    }),
  pickConnectionsFile: (request) =>
    open({
      title: request.title,
      multiple: false,
      directory: false,
      filters: [
        { name: request.filterName, extensions: request.extensions },
        { name: request.allFiles, extensions: ['*'] },
      ],
    }),
};

/** A browser has a file chooser and no path: the mock gets the content under a made-up one. */
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

const mockImportDialog: ImportDialog = {
  async pickDataFile() {
    const file = await chooseBrowserFile(DATA_EXTENSIONS.map((ext) => `.${ext}`).join(','));
    if (!file) return null;
    const path = `/home/ana/imports/${file.name}`;
    mockBackend.setFile(path, await file.text());
    return path;
  },
  async pickConnectionsFile() {
    const file = await chooseBrowserFile('');
    if (!file) return null;
    const path = `/home/ana/imports/${file.name}`;
    mockBackend.setFile(path, await file.text());
    return path;
  },
};

export const importDialog: ImportDialog =
  import.meta.env.VITE_MOCK === '1' ? mockImportDialog : tauriImportDialog;

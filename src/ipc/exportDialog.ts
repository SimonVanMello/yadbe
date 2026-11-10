import { save } from '@tauri-apps/plugin-dialog';

/** What the save dialog of an export shows, in the UI language. */
export interface ExportPathRequest {
  title: string;
  defaultName: string;
  /** Name of the file type shown for `extensions`, then "All files". */
  filterName: string;
  allFiles: string;
  extensions: string[];
}

/**
 * The native save dialog of an export (SPEC §9: file access only through explicit dialogs).
 * The file itself is written by the backend (`startExport`). `null` when dismissed.
 */
export interface ExportDialog {
  pickPath(request: ExportPathRequest): Promise<string | null>;
}

const tauriExportDialog: ExportDialog = {
  pickPath: (request) =>
    save({
      title: request.title,
      defaultPath: request.defaultName,
      filters: [
        { name: request.filterName, extensions: request.extensions },
        { name: request.allFiles, extensions: ['*'] },
      ],
    }),
};

/** No save dialog in a browser: the mock exports next to the other downloads. */
const mockExportDialog: ExportDialog = {
  pickPath: (request) => Promise.resolve(`/home/ana/Downloads/${request.defaultName}`),
};

export const exportDialog: ExportDialog =
  import.meta.env.VITE_MOCK === '1' ? mockExportDialog : tauriExportDialog;

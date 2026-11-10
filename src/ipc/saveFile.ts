/** A file type offered by the save dialog. */
export interface SaveFilter {
  name: string;
  extensions: string[];
}

export interface SaveFileRequest {
  /** Dialog title, in the UI language. */
  title: string;
  defaultName: string;
  filters: SaveFilter[];
  /** Text is written as UTF-8; bytes as they are. */
  contents: string | Uint8Array;
}

/**
 * Saving content the frontend holds (a cell's value, F-064) to a file the user picks (SPEC §9:
 * file access only through explicit dialogs). Kept apart from `fileDialog.ts`.
 */
export interface FileSaver {
  /** `false` while the running backend cannot write files: the UI disables the action. */
  readonly available: boolean;
  /** Asks for a path and writes; the path written, `null` when the dialog was dismissed. */
  save(request: SaveFileRequest): Promise<string | null>;
}

/**
 * The browser stand-in of the mock: a download, like a browser saves. The path is made up (a
 * browser never reveals it).
 */
const browserFileSaver: FileSaver = {
  available: true,
  save(request) {
    const data =
      typeof request.contents === 'string'
        ? request.contents
        : new Uint8Array(request.contents).buffer;
    const url = URL.createObjectURL(new Blob([data]));
    const link = document.createElement('a');
    link.href = url;
    link.download = request.defaultName;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
    return Promise.resolve(`/home/ana/Downloads/${request.defaultName}`);
  },
};

/**
 * The app: the backend has no command to write a picked file yet (it needs the dialog's save
 * permission and a write command, see the M1-5 report), so the action stays disabled.
 */
const tauriFileSaver: FileSaver = {
  available: false,
  save: () => Promise.reject(new Error('Saving files is not available in this build.')),
};

export const fileSaver: FileSaver =
  import.meta.env.VITE_MOCK === '1' ? browserFileSaver : tauriFileSaver;

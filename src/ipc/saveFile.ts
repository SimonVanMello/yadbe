import { save } from '@tauri-apps/plugin-dialog';

import type { ValueFileEncoding } from './bindings';
import { ipc } from './index';
import { unwrap } from './result';

/** A file type offered by the save dialog. */
export interface SaveFilter {
  name: string;
  extensions: string[];
}

export interface SaveValueRequest {
  /** Dialog title, in the UI language. */
  title: string;
  defaultName: string;
  filters: SaveFilter[];
  /** UTF-8 text, or hexadecimal digits written as the bytes they spell (binary values). */
  contents: string;
  encoding: ValueFileEncoding;
}

/**
 * Saving a value the frontend holds (the cell viewer, F-064) to a file the user picks (SPEC §9:
 * file access only through explicit dialogs): the native save dialog, then `writeValueFile`.
 * Kept apart from `fileDialog.ts` (scripts).
 */
export interface FileSaver {
  /** Asks for a path and writes; the path written, `null` when the dialog was dismissed. */
  save(request: SaveValueRequest): Promise<string | null>;
}

async function write(path: string, request: SaveValueRequest): Promise<string> {
  await unwrap(ipc.commands.writeValueFile(path, request.contents, request.encoding));
  return path;
}

const tauriFileSaver: FileSaver = {
  async save(request) {
    const path = await save({
      title: request.title,
      defaultPath: request.defaultName,
      filters: request.filters,
    });
    return path === null ? null : write(path, request);
  },
};

/** The mock: no save dialog in a browser, the value goes to the mock backend's disk. */
const mockFileSaver: FileSaver = {
  save: (request) => write(`/home/ana/Downloads/${request.defaultName}`, request),
};

export const fileSaver: FileSaver =
  import.meta.env.VITE_MOCK === '1' ? mockFileSaver : tauriFileSaver;

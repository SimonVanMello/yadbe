import { create } from 'zustand';

import type { DocApplyOutcome, DocConflict, DocPreview, YadbeError } from '../../ipc';
import { NO_EDITS, type DocEdits, type EditRef, type Path, type Target } from './docEditModel';

/** Where the changes of the apply dialog come from. */
export type DocApplySource =
  { kind: 'tab'; tabId: string } | { kind: 'revert'; connectionId: string; entryId: number };

/** The apply dialog (M4-4): preview, outcome, conflicts. */
export interface DocApplyDialog {
  source: DocApplySource;
  connectionId: string;
  /** `database.collection`, for the title. */
  label: string;
  status: 'loading' | 'ready' | 'applying' | 'conflicted' | 'failed' | 'uncertain';
  preview: DocPreview | null;
  error: YadbeError | null;
  /** The last apply's outcome (what was applied before a stop). */
  outcome: DocApplyOutcome | null;
  conflicts: DocConflict[];
  /** Where each change of the previewed change set comes from. */
  refs: EditRef[];
}

/** The field editor: a value at a path, or a new field's name and value. */
export interface DocFieldForm {
  kind: 'field';
  tabId: string;
  target: Target;
  /** The field's path; for a new field, the document (or sub-document) it goes into. */
  path: Path;
  /** A new field: its name is typed. */
  adding: boolean;
  /** The value now (with the pending changes), Extended JSON; `null`: missing. */
  current: string | null;
}

/** The JSON editor: a whole document (new or existing) or a value. */
export interface DocJsonForm {
  kind: 'json';
  tabId: string;
  mode: 'insert' | 'replace' | 'value';
  /** `replace` / `value`: the document. */
  target: Target | null;
  /** `value`: where the value is. */
  path: Path;
  /** A pending new document being edited again. */
  insertKey: number | null;
  /** The text to start from. */
  text: string;
}

export type DocForm = DocFieldForm | DocJsonForm;

interface DocEditStore {
  /** Pending edits by collection tab. */
  tabs: Record<string, DocEdits | undefined>;
  form: DocForm | null;
  dialog: DocApplyDialog | null;
}

export const useDocEditStore = create<DocEditStore>()(() => ({
  tabs: {},
  form: null,
  dialog: null,
}));

export function tabDocEdits(tabId: string): DocEdits {
  return useDocEditStore.getState().tabs[tabId] ?? NO_EDITS;
}

export function setTabDocEdits(tabId: string, edits: DocEdits): void {
  useDocEditStore.setState((state) => ({ tabs: { ...state.tabs, [tabId]: edits } }));
}

export function dropTabDocEdits(tabId: string): void {
  useDocEditStore.setState((state) => ({
    tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)),
  }));
}

export function patchDocDialog(patch: Partial<DocApplyDialog>): void {
  useDocEditStore.setState((state) =>
    state.dialog ? { dialog: { ...state.dialog, ...patch } } : state,
  );
}

/** The pending edits of a collection tab (none before any). */
export function useTabDocEdits(tabId: string): DocEdits {
  return useDocEditStore((state) => state.tabs[tabId] ?? NO_EDITS);
}

import { create } from 'zustand';

/** What is wrong between a tab and the file it is bound to (F-045: external change detection). */
export type FileIssue =
  /** The file's text is not what the tab last read or wrote: `diskText` is what it holds now. */
  | { kind: 'modified'; diskText: string }
  /** The file is gone. */
  | { kind: 'missing' };

interface FileIssueStore {
  issues: Record<string, FileIssue>;
  set: (tabId: string, issue: FileIssue | null) => void;
}

export const useFileIssues = create<FileIssueStore>()((set) => ({
  issues: {},
  set: (tabId, issue) => {
    set((store) => {
      const rest = Object.fromEntries(Object.entries(store.issues).filter(([id]) => id !== tabId));
      return { issues: issue === null ? rest : { ...rest, [tabId]: issue } };
    });
  },
}));

export function useFileIssue(tabId: string): FileIssue | undefined {
  return useFileIssues((store) => store.issues[tabId]);
}

/** Line breaks as the editor holds them: CodeMirror reads `\r\n` and `\r` as `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

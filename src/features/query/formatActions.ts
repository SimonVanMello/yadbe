import { lazyModule } from '../../app/lazyModule';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { translate, useI18nStore, type MessageKey } from '../../i18n/i18n';
import { toast } from '../../ui/toastStore';
import { getPreference } from '../preferences/preferenceStore';
import { findConnection } from './connectionLookup';
import { getEditor } from './editorRegistry';
import type { FormatOptions } from './sqlFormat';

/** The formatter is loaded after startup (P-01); it is there long before the first format. */
const formatter = lazyModule(() => import('./sqlFormat').then((m) => m.formatSql));

declare global {
  interface Window {
    /** Durations (ms) of each format, recorded while an array is set here. */
    __yadbeFormatTimings?: number[];
  }
}

function t(key: MessageKey): string {
  return translate(useI18nStore.getState().locale, key);
}

const INDENTS = { two: '  ', four: '    ', tab: '\t' } as const;

/** The formatter's options for a tab: its engine, and the preferences (F-049). */
export function formatOptions(tabId: string): FormatOptions {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  return {
    engine: findConnection(tab?.connectionId ?? null)?.engine ?? 'postgres',
    keywordCase: getPreference('formatKeywordCase'),
    indent: INDENTS[getPreference('formatIndent')],
  };
}

/** Formats the tab's selection, or its whole text (F-049), as one undoable edit. */
export function formatTab(tabId: string): void {
  const formatSql = formatter.current();
  if (!formatSql) {
    formatter.load().then(
      () => {
        formatTab(tabId);
      },
      (error: unknown) => {
        console.warn('Could not load the formatter', error);
      },
    );
    return;
  }
  const editor = getEditor(tabId);
  if (!editor) return;
  const options = formatOptions(tabId);
  const changed = editor.format((text) => {
    const started = performance.now();
    const out = formatSql(text, options);
    window.__yadbeFormatTimings?.push(performance.now() - started);
    return out;
  });
  if (!changed) toast({ variant: 'info', title: t('query.format.unchanged') });
}

/** Reveals in the explorer (or opens the data of) the object named at the cursor (F-052). */
export async function goToDefinition(tabId: string, action: 'reveal' | 'open'): Promise<void> {
  const editor = getEditor(tabId);
  if (!editor) return;
  if (!(await editor.definitionAtCursor(action))) {
    toast({ variant: 'info', title: t('hover.nothing') });
  }
}

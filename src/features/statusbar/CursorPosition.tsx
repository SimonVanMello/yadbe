import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { formatCount } from '../grid/formatCount';
import { useEditorCursorStore } from '../query/editorCursorStore';
import styles from './StatusBar.module.css';

/** `Ln 3, Col 12` of the active tab's editor (SPEC §4), and the size of its selection. */
export function CursorPosition() {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const tabId = useTabsStore((state) => selectActiveTab(state).id);
  const cursor = useEditorCursorStore((state) => state.cursors[tabId]);
  if (!cursor) return null;
  return (
    <span className={styles.cursor} data-testid="statusbar-cursor">
      {t('statusbar.cursor', { line: cursor.line, column: cursor.column })}
      {cursor.selected > 0 && (
        <span className={styles.muted}>
          {' '}
          ({formatCount(locale, 'statusbar.selected', cursor.selected)})
        </span>
      )}
    </span>
  );
}

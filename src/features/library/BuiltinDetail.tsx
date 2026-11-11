import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import type { BuiltinSnippet } from './builtinSnippets';
import styles from './LibraryDetail.module.css';
import { copyBuiltin, insertBuiltin } from './libraryActions';

/** The template of the selected built-in snippet: read-only, to insert or to copy and customize. */
export function BuiltinDetail({ snippet, name }: { snippet: BuiltinSnippet; name: string }) {
  const t = useT();
  return (
    <aside className={styles.detail} aria-label={t('library.detail')}>
      <div className={styles.header}>
        <h3 className={styles.name}>{name}</h3>
        <div className={styles.actions}>
          <IconButton
            icon="terminal"
            size="sm"
            label={t('library.menu.insert')}
            onClick={() => {
              insertBuiltin(snippet);
            }}
          />
          <IconButton
            icon="copy"
            size="sm"
            label={t('library.builtin.copy')}
            onClick={() => {
              copyBuiltin(snippet);
            }}
          />
        </div>
      </div>
      <p className={styles.facts}>{t('library.builtin.readOnly')}</p>
      <pre className={styles.sql}>{snippet.template}</pre>
    </aside>
  );
}

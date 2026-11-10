import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import styles from './FileIssueBanner.module.css';
import { useFileIssue } from './fileIssues';
import { keepMine, reloadFromDisk } from './queryActions';
import { fileNameOf, useQueryTabState } from './queryTabStore';

/** Tells the user that the file of the tab changed or disappeared behind their back (F-045). */
export function FileIssueBanner({ tabId }: { tabId: string }) {
  const t = useT();
  const issue = useFileIssue(tabId);
  const { filePath } = useQueryTabState(tabId);
  if (!issue || filePath === null) return null;
  const name = fileNameOf(filePath);
  return (
    <div className={styles.banner} role="alert">
      <Icon name="warning" />
      <span className={styles.text}>
        {issue.kind === 'modified'
          ? t('query.file.changed', { name })
          : t('query.file.missing', { name })}
      </span>
      {issue.kind === 'modified' && (
        <Button
          size="sm"
          onClick={() => {
            reloadFromDisk(tabId);
          }}
        >
          {t('query.file.reload')}
        </Button>
      )}
      <Button
        size="sm"
        onClick={() => {
          keepMine(tabId);
        }}
      >
        {issue.kind === 'modified' ? t('query.file.keepMine') : t('query.file.keepUntitled')}
      </Button>
    </div>
  );
}

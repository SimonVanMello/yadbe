import { useState } from 'react';

import { localize, resolveErrorAction } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { StatementFailure } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { ChangeTarget } from './pendingChanges';
import { applyChanges, dismissFailure, revealFailure, revertFailure } from './tableActions';
import styles from './TableView.module.css';

interface FailureBannerProps {
  tabId: string;
  failure: StatementFailure;
  target: ChangeTarget | null;
}

/**
 * A rolled-back apply (F-085): nothing was changed and nothing is lost. Says which change
 * failed and why (the typed error, the constraint), with what to do: show it, revert it,
 * or try again.
 */
export function FailureBanner({ tabId, failure, target }: FailureBannerProps) {
  const t = useT();
  const [showSql, setShowSql] = useState(false);
  const { error, violation, statementIndex } = failure;
  const action = resolveErrorAction(error.action, {
    retry: () => {
      void applyChanges(tabId);
    },
  });
  const what =
    statementIndex === null
      ? t('tableData.failure.commit')
      : t('tableData.failure.statement', { number: statementIndex + 1 });

  return (
    <div className={styles.failure} role="alert" data-testid="table-failure">
      <Icon name="error" className={styles.failureIcon} />
      <div className={styles.failureText}>
        <p className={styles.failureTitle}>
          {t('tableData.failure.title')} · {what}
        </p>
        <p className={styles.failureMessage}>{localize(error.message)}</p>
        {violation && (
          <p className={styles.failureDetail}>
            {t(`tableData.violation.${violation.kind}`)}
            {violation.name && (
              <>
                {' · '}
                <code>{violation.name}</code>
              </>
            )}
            {violation.column && (
              <>
                {' · '}
                {t('tableData.failure.column')} <code>{violation.column}</code>
              </>
            )}
          </p>
        )}
        {showSql && <code className={styles.failureSql}>{failure.sql}</code>}
      </div>
      <div className={styles.failureActions}>
        {target && (
          <Button
            size="sm"
            onClick={() => {
              revealFailure(tabId);
            }}
          >
            {t('tableData.failure.show')}
          </Button>
        )}
        {target && (
          <Button
            size="sm"
            onClick={() => {
              revertFailure(tabId);
            }}
          >
            <Icon name="undo" />
            {t('tableData.failure.revert')}
          </Button>
        )}
        {action && (
          <Button size="sm" onClick={action.run}>
            {action.label}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={showSql}
          onClick={() => {
            setShowSql((shown) => !shown);
          }}
        >
          {t('tableData.failure.sql')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dismissFailure(tabId);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
    </div>
  );
}

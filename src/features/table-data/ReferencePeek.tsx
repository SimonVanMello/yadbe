import { Popover as RadixPopover } from 'radix-ui';

import { shortcutOf } from '../../app/actions';
import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { usePreference } from '../preferences/preferenceStore';
import { describeKey } from './fkModel';
import { closePeek, openPeekInTable, type PeekState } from './fkNavigation';
import styles from './ForeignKeys.module.css';
import { gridOf } from './tableActions';
import { tableLabel } from './tableNames';

/** Over a cell, the peek of the row its foreign key value references (F-088). */
export function ReferencePeek({ peek }: { peek: PeekState }) {
  const t = useT();
  const nullText = usePreference('nullText');
  const table = tableLabel(peek.fk.referencedTable);
  const keyText = describeKey(peek.key);
  const data = peek.data;
  const keyColumns = new Set(peek.key.map((part) => part.column));

  return (
    <RadixPopover.Root
      open
      onOpenChange={(open) => {
        if (!open) closePeek();
      }}
    >
      <RadixPopover.Anchor asChild>
        {/* The anchor covers the cell without taking its clicks. */}
        <span className={styles.anchor} style={{ pointerEvents: 'none' }} />
      </RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={`${styles.panel} ${styles.peek}`}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={t('tableData.fk.peek.label', { table })}
          data-testid="fk-peek"
          // A portal: React would bubble its right clicks to the grid's own menu.
          onContextMenu={(event) => {
            event.stopPropagation();
          }}
          onCloseAutoFocus={(event) => {
            // Back to the grid, where the peek was opened from.
            event.preventDefault();
            gridOf(peek.tabId)?.focus();
          }}
        >
          <div className={styles.header}>
            <div className={styles.title}>
              <Icon name="link" className={styles.titleIcon} />
              <span>{table}</span>
            </div>
            <div className={styles.subtitle} title={keyText}>
              {keyText}
            </div>
          </div>
          <div className={styles.body}>
            {peek.status === 'loading' && (
              <div className={styles.state} role="status">
                <Spinner />
                {t('tableData.fk.peek.loading')}
                <Button size="sm" variant="ghost" onClick={closePeek}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
            {peek.status === 'failed' && (
              <div className={`${styles.state} ${styles.error}`} role="alert">
                <Icon name="error" />
                <span>
                  {peek.error ? localize(peek.error.message) : t('tableData.fk.peek.failed')}
                </span>
              </div>
            )}
            {data && data.matches === 0 && (
              <div className={styles.state} role="status">
                <Icon name="info" />
                {t('tableData.fk.peek.missing', { table, key: keyText })}
              </div>
            )}
            {data && data.matches > 1 && (
              <div className={styles.state} role="status">
                <Icon name="warning" />
                {t('tableData.fk.peek.several')}
              </div>
            )}
            {data && data.matches > 0 && (
              <dl className={styles.fields}>
                {data.columns.map((column, c) => {
                  const window = data.window.columns[c];
                  const text = window?.values[0] ?? null;
                  const truncated = window?.truncated.includes(0) ?? false;
                  return (
                    <div key={column.name} className={styles.field}>
                      <dt className={styles.fieldName} title={column.typeName}>
                        {column.primaryKey && <Icon name="key" aria-hidden="true" />}
                        {column.name}
                      </dt>
                      <dd
                        className={styles.fieldValue}
                        data-key={keyColumns.has(column.name) || undefined}
                        title={
                          text === null
                            ? undefined
                            : truncated
                              ? `${text}…\n${t('tableData.fk.peek.truncated')}`
                              : text
                        }
                      >
                        {text === null ? (
                          <span className={styles.null}>{nullText}</span>
                        ) : truncated ? (
                          `${text}…`
                        ) : (
                          text
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>
          <div className={styles.footer}>
            <span className={styles.footerHint}>
              <Kbd shortcut={shortcutOf('table.goToReference')} />
            </span>
            <Button size="sm" variant="ghost" onClick={closePeek}>
              {t('common.close')}
            </Button>
            <Button size="sm" variant="primary" autoFocus onClick={openPeekInTable}>
              <Icon name="external" />
              {t('tableData.fk.peek.open')}
            </Button>
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

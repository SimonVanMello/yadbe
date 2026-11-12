import { useQuery } from '@tanstack/react-query';
import { useId, type KeyboardEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useShortcutOf } from '../../app/useShortcutOf';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextArea } from '../../ui/TextArea';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { requestKey } from '../explorer/metaKeys';
import { useQueryTabStore } from '../query/queryTabStore';
import type { DocumentViewMode } from './collectionStore';
import {
  cancelConsole,
  confirmConsole,
  consoleDatabase,
  dismissConfirm,
  runConsole,
} from './consoleActions';
import { useConsoleStore, useConsoleTab } from './consoleStore';
import { DangerDialog } from './DangerDialog';
import styles from './DocumentConsole.module.css';
import { DocumentResults } from './DocumentResults';

const EXAMPLE = '{ "find": "orders", "filter": { "status": "paid" }, "limit": 20 }';

/**
 * The query tab of a document connection, for now: a console that sends one JSON command
 * (`runCommand`) as written to a database, its documents shown as a grid or as trees. The full
 * shell language comes later (M4-3). Commands are checked by the backend's gate (read-only,
 * dangerous commands confirmed with their effect) and recorded in the history.
 */
export function DocumentConsole({
  tab,
  connection,
}: {
  tab: ShellTab;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const id = useId();
  const locale = useI18nStore((state) => state.locale);
  const shortcutOf = useShortcutOf();
  const state = useConnectionState(connection.id);
  const text = useQueryTabStore((store) => store.tabs[tab.id]?.content ?? '');
  const chosen = useQueryTabStore((store) => store.tabs[tab.id]?.database ?? null);
  const console = useConsoleTab(tab.id);
  const connected = state === 'connected';
  const database = chosen ?? consoleDatabase(tab.id);
  // The explorer's list, from the same cache: opening the console does not read it twice.
  const databases = useQuery({
    queryKey: requestKey(connection.id, { type: 'docDatabases' }),
    queryFn: () => unwrap(ipc.commands.mongoListDatabases(connection.id)),
    enabled: connected,
    staleTime: Infinity,
  });
  const names = [...new Set([database, ...(databases.data ?? []).map((info) => info.name)])].sort();

  const setText = (content: string) => {
    useQueryTabStore.getState().ensure(tab.id);
    useQueryTabStore.getState().setContent(tab.id, content);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void runConsole(tab.id);
    } else if (event.key === 'Escape' && console.running) {
      event.preventDefault();
      cancelConsole(tab.id);
    }
  };
  const { outcome, error, running, view } = console;

  return (
    <div className={styles.view} data-testid="document-console">
      <div className={styles.editor}>
        <div className={styles.bar}>
          <label className={styles.database} htmlFor={`${id}-database`}>
            <Icon name="database" />
            <Select
              id={`${id}-database`}
              aria-label={t('mongo.console.database')}
              value={database}
              options={names.map((name) => ({ value: name, label: name }))}
              onChange={(name) => {
                useQueryTabStore.getState().ensure(tab.id);
                useQueryTabStore.getState().setDatabase(tab.id, name);
              }}
            />
          </label>
          <span className={styles.hint}>{t('mongo.console.hint')}</span>
          <span className={styles.spacer} />
          {running ? (
            <Button
              size="sm"
              onClick={() => {
                cancelConsole(tab.id);
              }}
            >
              <Spinner />
              {t('mongo.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!connected || text.trim() === ''}
              onClick={() => {
                void runConsole(tab.id);
              }}
            >
              <Icon name="play" />
              {t('mongo.console.run')}
              <Kbd shortcut={shortcutOf('query.run')} />
            </Button>
          )}
        </div>
        <TextArea
          mono
          aria-label={t('mongo.console.command')}
          data-testid="console-command"
          className={styles.command}
          value={text}
          placeholder={EXAMPLE}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={styles.results}>
        {error ? (
          <div
            className={styles.error}
            role="alert"
            data-code={error.code}
            data-testid="console-error"
          >
            <Icon name={error.code === 'readOnlyViolation' ? 'lock' : 'warning'} />
            <div className={styles.errorText}>
              <p className={styles.errorTitle}>{localize(error.message)}</p>
              {error.detail && <code className={styles.detail}>{error.detail}</code>}
            </div>
          </div>
        ) : outcome ? (
          <>
            <div className={styles.status}>
              <SegmentedControl<DocumentViewMode>
                label={t('mongo.view.label')}
                value={view}
                options={[
                  { value: 'grid', label: t('mongo.view.grid') },
                  { value: 'documents', label: t('mongo.view.documents') },
                ]}
                onChange={(next) => {
                  useConsoleStore.getState().patch(tab.id, { view: next });
                }}
              />
              <span className={styles.summary} data-testid="console-summary">
                {outcome.cursor
                  ? t('mongo.console.documents', { count: outcome.documents.count })
                  : t('mongo.console.reply')}
                {outcome.truncated && ` · ${t('mongo.console.truncated')}`}
                {outcome.durationMs !== null &&
                  ` · ${t('mongo.console.duration', { ms: formatNumber(locale, outcome.durationMs) })}`}
              </span>
            </div>
            <div className={styles.result}>
              <DocumentResults
                key={outcome.documents.documentsId}
                result={outcome.documents}
                view={view}
                label={t('mongo.console.result')}
              />
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            {running ? <Spinner /> : <p>{t('mongo.console.empty')}</p>}
          </div>
        )}
      </div>
      <DangerDialog
        danger={console.confirm?.danger ?? null}
        onCancel={() => {
          dismissConfirm(tab.id);
        }}
        onConfirm={() => {
          void confirmConsole(tab.id);
        }}
      />
    </div>
  );
}

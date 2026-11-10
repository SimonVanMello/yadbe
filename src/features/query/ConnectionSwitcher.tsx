import { useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Popover } from '../../ui/Popover';
import { TextInput } from '../../ui/TextInput';
import { Tooltip } from '../../ui/Tooltip';
import { ConnectionChip } from '../connections/ConnectionChip';
import { EngineBadge } from '../connections/EngineBadge';
import { EnvTag } from '../connections/EnvTag';
import { useConnectionState, useConnections, useEngineInfo } from '../connections/connectionStore';
import { tintOf, type ConnectionSummary } from '../connections/model';
import { useDatabaseList } from './databaseList';
import { switchConnection, switchDatabase } from './queryActions';
import { useQueryTabState } from './queryTabStore';
import styles from './ConnectionSwitcher.module.css';

interface ConnectionSwitcherProps {
  tabId: string;
  connection: ConnectionSummary;
}

/**
 * The connection chip of the toolbar, as a switcher (F-046): pick another connection for the tab,
 * and, for engines that host several databases, the database its statements run in.
 */
export function ConnectionSwitcher({ tabId, connection }: ConnectionSwitcherProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const state = useConnectionState(connection.id);
  const { database } = useQueryTabState(tabId);
  // The chip shows where the next run goes: the tab's database when it has its own.
  const shown = { ...connection, database: database ?? connection.database };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-label={t('query.switcher.label', { name: connection.name })}
          data-testid="connection-switcher"
        >
          <ConnectionChip connection={shown} state={state} />
          <Icon name="chevronDown" className={styles.chevron} />
        </button>
      }
    >
      <SwitcherPanel
        tabId={tabId}
        connection={connection}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Popover>
  );
}

function SwitcherPanel({
  tabId,
  connection,
  onDone,
}: ConnectionSwitcherProps & { onDone: () => void }) {
  const t = useT();
  const connections = useConnections();
  const info = useEngineInfo(connection.engine);
  const known = useDatabaseList(connection.id);
  const { database } = useQueryTabState(tabId);
  const [typed, setTyped] = useState(database ?? '');
  const multipleDatabases = info?.capabilities.multipleDatabases ?? false;

  return (
    <div className={styles.panel}>
      <p className={styles.heading}>{t('query.switcher.connection')}</p>
      <div role="radiogroup" aria-label={t('query.switcher.connection')} className={styles.list}>
        {connections.map((candidate) => {
          const current = candidate.id === connection.id;
          const tint = tintOf(candidate);
          return (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={current}
              className={styles.item}
              data-current={current || undefined}
              onClick={() => {
                if (!current) void switchConnection(tabId, candidate.id);
                onDone();
              }}
            >
              <EngineBadge engine={candidate.engine} />
              <span className={styles.name}>{candidate.name}</span>
              {candidate.environment && (
                <EnvTag
                  environment={candidate.environment}
                  label={candidate.environmentLabel}
                  tint={tint}
                />
              )}
              {current && <Icon name="check" className={styles.check} />}
            </button>
          );
        })}
      </div>

      {multipleDatabases && (
        <>
          <p className={styles.heading}>{t('query.switcher.database')}</p>
          {known && (
            <div
              role="radiogroup"
              aria-label={t('query.switcher.database')}
              className={styles.list}
            >
              {known.map((name) => {
                const current = name === (database ?? connection.database);
                return (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={current}
                    className={styles.item}
                    data-current={current || undefined}
                    onClick={() => {
                      void switchDatabase(tabId, name);
                      onDone();
                    }}
                  >
                    <Icon name="database" />
                    <span className={styles.name}>{name}</span>
                    {current && <Icon name="check" className={styles.check} />}
                  </button>
                );
              })}
            </div>
          )}
          <form
            className={styles.databaseForm}
            onSubmit={(event) => {
              event.preventDefault();
              void switchDatabase(tabId, typed);
              onDone();
            }}
          >
            <TextInput
              mono
              value={typed}
              placeholder={connection.database || t('query.switcher.databasePlaceholder')}
              aria-label={t('query.switcher.databaseName')}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
            <Tooltip content={t('query.switcher.databaseHint')}>
              <Button type="submit" size="sm">
                {t('query.switcher.apply')}
              </Button>
            </Tooltip>
          </form>
        </>
      )}
    </div>
  );
}

import { useId, useMemo, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShortcutOf } from '../../app/useShortcutOf';
import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { YadbeIpcError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { openQuery } from '../connections/connectionActions';
import { byRecency, searchConnections } from '../connections/connectionRows';
import { refreshConnections, useConnectionList } from '../connections/connectionStore';
import { useConnectionTransfer } from '../connections/connectionTransferStore';
import { pickDatabaseFile } from '../connections/pickDatabaseFile';
import type { ConnectionSummary } from '../connections/model';
import { WelcomeRow } from './WelcomeRow';
import styles from './WelcomeScreen.module.css';

/** Recent connections listed when the search field is empty. */
const RECENTS_SHOWN = 8;

interface ActionTileProps {
  icon: IconName;
  title: string;
  description: string;
  shortcut?: string;
  onClick: () => void;
}

function ActionTile({ icon, title, description, shortcut, onClick }: ActionTileProps) {
  return (
    <button type="button" className={styles.tile} onClick={onClick}>
      <span className={styles.tileIcon}>
        <Icon name={icon} size="md" />
      </span>
      <span className={styles.tileText}>
        <span className={styles.tileTitle}>{title}</span>
        <span className={styles.tileDescription}>{description}</span>
      </span>
      {shortcut && <Kbd shortcut={shortcut} className={styles.tileKbd} />}
    </button>
  );
}

/** New tab / welcome screen (F-123): favorite and recent connections, fuzzy search, new connection. */
export function WelcomeScreen() {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const listId = useId();
  const now = useNow();
  const list = useConnectionList();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [highlighted, setHighlighted] = useState(false);

  const connections = list.data?.connections;
  const searching = query.trim() !== '';
  const { favorites, recents, total } = useMemo(() => {
    const all = connections ?? [];
    if (searching) {
      const matches = searchConnections(all, query);
      return { favorites: [], recents: matches, total: all.length };
    }
    return {
      favorites: all.filter((c) => c.favorite).sort(byRecency),
      recents: all
        .filter((c) => !c.favorite)
        .sort(byRecency)
        .slice(0, RECENTS_SHOWN)
        .map((connection) => ({ connection, nameIndices: [] as number[] })),
      total: all.length,
    };
  }, [connections, query, searching]);

  const favoriteEntries = favorites.map((connection) => ({
    connection,
    nameIndices: [] as number[],
  }));
  // Keyboard order follows the visual order: favorites first.
  const ordered = [...favoriteEntries, ...recents];
  const current = Math.min(selected, ordered.length - 1);

  const open = (connection: ConnectionSummary) => {
    openQuery(connection);
  };
  const newConnection = () => {
    useShellStore.getState().openConnectionDialog({ connectionId: null });
  };
  const openFile = () => {
    void pickDatabaseFile().then((filePath) => {
      useShellStore.getState().openConnectionDialog({
        connectionId: null,
        engine: 'sqlite',
        ...(filePath ? { filePath } : {}),
      });
    });
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(ordered.length - 1, current + step));
      setSelected(next);
      setHighlighted(true);
      document.getElementById(`${listId}-${String(next)}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const entry = ordered[current];
      if (entry) open(entry.connection);
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    }
  };

  const renderRows = (entries: typeof ordered, offset: number) =>
    entries.map((entry, index) => (
      <WelcomeRow
        key={entry.connection.id}
        id={`${listId}-${String(offset + index)}`}
        connection={entry.connection}
        selected={offset + index === current}
        active={highlighted && offset + index === current}
        nameIndices={entry.nameIndices}
        now={now}
        onOpen={() => {
          open(entry.connection);
        }}
        onHover={() => {
          setSelected(offset + index);
          setHighlighted(true);
        }}
        onLeave={() => {
          setHighlighted(false);
        }}
      />
    ));

  let body;
  if (list.isPending) {
    body = (
      <div className={styles.placeholder}>
        <Spinner /> {t('welcome.loading')}
      </div>
    );
  } else if (list.error) {
    body = (
      <ErrorPanel
        compact
        title={t('welcome.loadFailed')}
        error={
          list.error instanceof YadbeIpcError
            ? list.error.error
            : {
                code: 'internal',
                message: { en: list.error.message, fr: list.error.message },
                action: null,
                detail: null,
              }
        }
      >
        <Button
          size="sm"
          onClick={() => {
            void refreshConnections();
          }}
        >
          <Icon name="retry" />
          {t('error.action.retry')}
        </Button>
      </ErrorPanel>
    );
  } else if (total === 0) {
    body = (
      <div className={styles.empty}>
        <Icon name="database" size="lg" />
        <p>{t('welcome.empty')}</p>
        <Button variant="primary" onClick={newConnection}>
          <Icon name="plus" />
          {t('connection.new')}
        </Button>
        <Button
          onClick={() => {
            useConnectionTransfer.getState().openImport();
          }}
        >
          <Icon name="download" />
          {t('action.connection.import')}
        </Button>
      </div>
    );
  } else if (ordered.length === 0) {
    body = <div className={styles.placeholder}>{t('welcome.noMatch', { query })}</div>;
  } else {
    body = (
      <div id={listId} role="listbox" aria-label={t('welcome.connections')} className={styles.list}>
        {favoriteEntries.length > 0 && (
          <div role="group" aria-label={t('welcome.favorites')} className={styles.group}>
            <div className={styles.groupTitle} aria-hidden="true">
              {t('welcome.favorites')}
            </div>
            {renderRows(favoriteEntries, 0)}
          </div>
        )}
        <div
          role="group"
          aria-label={searching ? t('welcome.results') : t('welcome.recents')}
          className={styles.group}
        >
          {recents.length > 0 && (
            <div className={styles.groupTitle} aria-hidden="true">
              {searching ? t('welcome.results') : t('welcome.recents')}
            </div>
          )}
          {renderRows(recents, favoriteEntries.length)}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <header className={styles.header}>
          <span className={styles.logo} aria-hidden="true">
            <Icon name="database" size="lg" />
          </span>
          <div>
            <h1 className={styles.title}>{t('welcome.title')}</h1>
            <p className={styles.subtitle}>{t('welcome.subtitle')}</p>
          </div>
        </header>

        <div className={styles.tiles}>
          <ActionTile
            icon="plus"
            title={t('connection.new')}
            description={t('welcome.new.description')}
            shortcut={shortcutOf('connection.new')}
            onClick={newConnection}
          />
          <ActionTile
            icon="file"
            title={t('welcome.openFile')}
            description={t('welcome.openFile.description')}
            onClick={openFile}
          />
        </div>

        {total > 0 && (
          <div className={styles.search}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              // The search field is the main entry point of the screen.
              autoFocus
              data-welcome-search
              type="search"
              role="combobox"
              aria-expanded={ordered.length > 0}
              aria-controls={listId}
              aria-activedescendant={
                ordered.length > 0 ? `${listId}-${String(current)}` : undefined
              }
              aria-label={t('welcome.search')}
              placeholder={t('welcome.search')}
              className={styles.searchInput}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
                setHighlighted(false);
              }}
              onKeyDown={onSearchKeyDown}
            />
            {ordered.length > 0 && <Kbd shortcut="Enter" className={styles.searchKbd} />}
          </div>
        )}

        {body}
      </div>
    </div>
  );
}

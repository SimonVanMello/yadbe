import { useMemo, useRef } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { isQueryTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { YadbeIpcError } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { useConnection } from '../connections/connectionStore';
import { BuiltinDetail } from './BuiltinDetail';
import { builtinSnippetsFor } from './builtinSnippets';
import { LibraryDetail } from './LibraryDetail';
import styles from './LibraryPanel.module.css';
import { LibraryTree } from './LibraryTree';
import {
  createFolder,
  exportLibrary,
  importLibrary,
  openSaved,
  saveEditorToLibrary,
} from './libraryActions';
import {
  buildBuiltinRows,
  buildLibraryRows,
  isFiltering,
  type LibraryFilter,
  type LibraryRow,
} from './libraryModel';
import { useLibraryUi, type LibraryScope } from './libraryStore';
import { refreshLibrary, useSavedLibrary, useSavedSearch } from './useLibrary';

const SEARCH_DELAY_MS = 200;

/** The Saved view of the sidebar (F-050): the query library as folders, with search and detail. */
export function LibraryPanel() {
  const t = useT();
  const { query, library } = useSavedLibrary();
  const text = useLibraryUi((state) => state.text);
  const scope = useLibraryUi((state) => state.scope);
  const collapsed = useLibraryUi((state) => state.collapsed);
  const builtinOpen = useLibraryUi((state) => state.builtinOpen);
  const selectedKey = useLibraryUi((state) => state.selectedKey);
  const treeRef = useRef<HTMLDivElement>(null);

  const activeTab = useTabsStore(selectActiveTab);
  const activeConnection = useConnection(activeTab.connectionId);
  const connectionId = scope === 'connection' ? (activeTab.connectionId ?? null) : null;

  // The full-text search runs once the user pauses; the fuzzy match on names follows each key.
  const searched = useDebouncedValue(text, SEARCH_DELAY_MS);
  const { ids } = useSavedSearch(searched, connectionId);
  const filter = useMemo<LibraryFilter>(
    () => ({ text, textIds: ids, connectionId }),
    [text, ids, connectionId],
  );
  const filtering = isFiltering(filter);

  const builtins = useMemo(
    () => builtinSnippetsFor(activeConnection?.engine ?? 'postgres'),
    [activeConnection?.engine],
  );
  const rows = useMemo<LibraryRow[]>(() => {
    const own = buildLibraryRows(library, collapsed, filter);
    const extra = buildBuiltinRows(builtins, (snippet) => t(snippet.name), text, builtinOpen);
    return [...own.rows, ...extra];
  }, [library, collapsed, filter, builtins, text, builtinOpen, t]);

  const selectedRow =
    selectedKey === null ? undefined : rows.find((row) => row.key === selectedKey);
  const canSaveCurrent = isQueryTab(activeTab);
  const empty = library.queries.length === 0 && library.folders.length === 0;

  const focusTree = () => {
    const tree = treeRef.current;
    if (!tree) return;
    tree.focus();
    const first = rows[0];
    if (first && selectedRow === undefined) useLibraryUi.getState().select(first.key);
  };

  return (
    <section className={styles.panel} aria-label={t('library.title')}>
      <header className={styles.header}>
        <h2 className={styles.title}>{t('library.title')}</h2>
        <div className={styles.actions}>
          <IconButton
            icon="plus"
            size="sm"
            label={t('library.action.saveCurrent')}
            disabled={!canSaveCurrent}
            onClick={() => {
              saveEditorToLibrary(activeTab.id);
            }}
          />
          <IconButton
            icon="folder"
            size="sm"
            label={t('library.action.newFolder')}
            onClick={() => {
              void createFolder(null);
            }}
          />
          <Menu
            align="end"
            trigger={<IconButton icon="more" size="sm" label={t('library.action.more')} />}
          >
            <MenuItem
              icon="download"
              onSelect={() => {
                void importLibrary();
              }}
            >
              {t('library.action.import')}
            </MenuItem>
            <MenuItem
              icon="external"
              disabled={empty}
              onSelect={() => {
                void exportLibrary();
              }}
            >
              {t('library.action.export')}
            </MenuItem>
            <MenuItem
              icon="chevronRight"
              disabled={library.folders.length === 0}
              onSelect={() => {
                useLibraryUi.getState().setAllFolded(
                  library.folders.map((folder) => folder.id),
                  true,
                );
              }}
            >
              {t('library.action.collapseAll')}
            </MenuItem>
            <MenuItem
              icon="chevronDown"
              disabled={library.folders.length === 0}
              onSelect={() => {
                useLibraryUi.getState().setAllFolded(
                  library.folders.map((folder) => folder.id),
                  false,
                );
              }}
            >
              {t('library.action.expandAll')}
            </MenuItem>
          </Menu>
        </div>
      </header>
      <div className={styles.search}>
        <Icon name="search" className={styles.searchIcon} />
        <TextInput
          className={styles.searchInput}
          data-library-search=""
          value={text}
          placeholder={t('library.search.placeholder')}
          aria-label={t('library.search')}
          onChange={(event) => {
            useLibraryUi.getState().setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') useLibraryUi.getState().setText('');
            else if (event.key === 'ArrowDown' && rows.length > 0) {
              event.preventDefault();
              focusTree();
            } else if (event.key === 'Enter' && text.trim() !== '') {
              const first = rows.find((row) => row.type === 'query');
              if (first?.type === 'query') void openSaved(first.query);
            }
          }}
        />
      </div>
      <div className={styles.scope}>
        <SegmentedControl<LibraryScope>
          label={t('library.scope.label')}
          value={scope}
          options={[
            { value: 'all', label: t('library.scope.all') },
            { value: 'connection', label: t('library.scope.connection') },
          ]}
          onChange={(next) => {
            useLibraryUi.getState().setScope(next);
          }}
        />
      </div>

      {query.isPending && (
        <div className={styles.state}>
          <Spinner />
        </div>
      )}
      {query.isError && (
        <div className={styles.error}>
          {query.error instanceof YadbeIpcError ? (
            <ErrorPanel
              compact
              title={t('library.loadFailed')}
              error={query.error.error}
              context={{
                retry: () => {
                  void refreshLibrary();
                },
              }}
            />
          ) : (
            <p className={styles.empty}>{t('library.loadFailed')}</p>
          )}
        </div>
      )}
      {query.isSuccess && (
        <LibraryTree
          rows={rows}
          library={library}
          label={t('library.list')}
          treeRef={treeRef}
          empty={
            <div className={styles.state}>
              <p className={styles.empty}>
                {filtering && !empty ? t('library.emptyFiltered') : t('library.empty')}
              </p>
            </div>
          }
        />
      )}
      {selectedRow?.type === 'query' && (
        <LibraryDetail key={selectedRow.query.id} query={selectedRow.query} search={text} />
      )}
      {selectedRow?.type === 'builtin' && (
        <BuiltinDetail
          key={selectedRow.key}
          snippet={selectedRow.snippet}
          name={selectedRow.name}
        />
      )}
    </section>
  );
}

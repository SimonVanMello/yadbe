import { memo, useEffect, useState, type CSSProperties } from 'react';

import { ConnectionDialog } from '../features/connections/ConnectionDialog';
import { useConnection } from '../features/connections/connectionStore';
import { GroupDialog } from '../features/connections/GroupDialog';
import { tintOf } from '../features/connections/model';
import { HostKeyDialog } from '../features/connections/HostKeyDialog';
import { PasswordPromptDialog } from '../features/connections/PasswordPromptDialog';
import { refreshNode } from '../features/explorer/explorerActions';
import { useExplorerStore } from '../features/explorer/explorerStore';
import { useHistoryActions } from '../features/history/useHistoryActions';
import { SaveQueryDialog } from '../features/library/SaveQueryDialog';
import { useLibraryActions } from '../features/library/useLibraryActions';
import { useJournalActions } from '../features/journal/useJournalActions';
import { ConnectionExportDialog } from '../features/connections/ConnectionExportDialog';
import { ConnectionImportDialog } from '../features/connections/ConnectionImportDialog';
import { useConnectionTransferActions } from '../features/connections/useConnectionTransferActions';
import { ExportDialog } from '../features/export/ExportDialog';
import { ObjectActionDialog } from '../features/objects/ObjectActionDialog';
import { PropertiesDialog } from '../features/objects/PropertiesDialog';
import { useExportActions } from '../features/export/useExportActions';
import { ImportDialog } from '../features/import/ImportDialog';
import { useImportActions } from '../features/import/useImportActions';
import { CommandPalette } from '../features/palette/CommandPalette';
import { PreferencesDialog } from '../features/preferences/PreferencesDialog';
import { usePaletteActions } from '../features/palette/usePaletteActions';
import { useSidebarView } from '../features/sidebar/sidebarViewStore';
import { useQueryActions } from '../features/query/useQueryActions';
import { useTableActions } from '../features/table-data/useTableActions';
import { SidebarViews } from '../features/sidebar/SidebarViews';
import { StatementLogPanel } from '../features/statement-log/StatementLogPanel';
import { StatusBar } from '../features/statusbar/StatusBar';
import { useI18nStore } from '../i18n/i18n';
import { nativeWindow } from '../ipc/nativeWindow';
import { useThemeStore } from '../theme/themeStore';
import { registerActions } from './actions';
import { useLayoutStore } from './layout/layoutStore';
import { PanelResizer } from './layout/PanelResizer';
import { CENTER_MIN_HEIGHT, CENTER_MIN_WIDTH, fitPanel } from './layout/panels';
import { useElementSize } from './layout/useElementSize';
import styles from './Shell.module.css';
import { useShellStore } from './shellStore';
import { startup } from './startup';
import { TabContent } from './tabs/TabContent';
import { openNewTab, selectActiveTab, useTabsStore } from './tabs/tabsStore';
import { ActiveToolbar } from './ActiveToolbar';
import { TitleBar } from './titlebar/TitleBar';
import { useShortcuts } from './useShortcuts';
import { WindowTitleSync } from './WindowTitleSync';

/** Longest wait for the restored session before showing the (hidden) window anyway. */
const SHOW_WINDOW_TIMEOUT_MS = 1500;

function useStartup(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      // The window starts hidden (tauri.conf.json) so it never flashes an unstyled frame.
      void nativeWindow.show().catch((error: unknown) => {
        console.warn('Could not show the window', error);
      });
    };
    const timer = setTimeout(show, SHOW_WINDOW_TIMEOUT_MS);
    void startup().finally(() => {
      setReady(true);
      clearTimeout(timer);
      // Let React commit the restored tabs before the first visible frame.
      setTimeout(show, 0);
    });
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return ready;
}

/** Registers what the keyboard shortcuts do (F-121). */
function useShellActions(): void {
  useEffect(
    () =>
      registerActions({
        'tab.new': openNewTab,
        'tab.close': () => {
          const { activeTabId, closeTab } = useTabsStore.getState();
          closeTab(activeTabId);
        },
        'tab.reopenClosed': () => {
          useTabsStore.getState().reopenClosedTab();
        },
        'tab.next': () => {
          useTabsStore.getState().activateRelative(1);
        },
        'tab.previous': () => {
          useTabsStore.getState().activateRelative(-1);
        },
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `tab.select${String(index + 1)}`,
            () => {
              useTabsStore.getState().activateIndex(index);
            },
          ]),
        ),
        'connection.new': () => {
          useShellStore.getState().openConnectionDialog({ connectionId: null });
        },
        'preferences.open': () => {
          useShellStore.getState().openPreferences();
        },
        'view.toggleSidebar': () => {
          useLayoutStore.getState().togglePanel('sidebar');
        },
        'view.toggleStatementLog': () => {
          useLayoutStore.getState().togglePanel('bottom');
        },
        'view.connections': () => {
          useSidebarView.getState().setView('connections');
          useLayoutStore.getState().setCollapsed('sidebar', false);
        },
        'explorer.refresh': () => {
          const { connectionId } = selectActiveTab(useTabsStore.getState());
          if (connectionId !== null) void refreshNode(connectionId, { level: 'connection' });
        },
        'explorer.toggleSystem': () => {
          const explorer = useExplorerStore.getState();
          explorer.setShowSystem(!explorer.showSystem);
        },
        'tab.togglePin': () => {
          const { activeTabId, tabs, setPinned } = useTabsStore.getState();
          const tab = tabs.find((candidate) => candidate.id === activeTabId);
          if (tab && tab.connectionId !== null) setPinned(tab.id, !tab.pinned);
        },
        'theme.light': () => {
          useThemeStore.getState().setPreference('light');
        },
        'theme.dark': () => {
          useThemeStore.getState().setPreference('dark');
        },
        'theme.system': () => {
          useThemeStore.getState().setPreference('system');
        },
        'language.en': () => {
          useI18nStore.getState().setLocale('en');
        },
        'language.fr': () => {
          useI18nStore.getState().setLocale('fr');
        },
      }),
    [],
  );
}

/**
 * The parts of the shell that do not depend on what the shell renders: a switch to a tab of
 * another connection re-renders the shell (tint), and these stay as they are.
 */
const StableTitleBar = memo(TitleBar);
const StableSidebar = memo(SidebarViews);
const StableStatusBar = memo(StatusBar);
const StableLog = memo(StatementLogPanel);

/** Main window: title bar with tabs, toolbar, sidebar, active tab, bottom panel, status bar. */
export function Shell() {
  useShortcuts();
  useShellActions();
  useQueryActions();
  useTableActions();
  useExportActions();
  useImportActions();
  useConnectionTransferActions();
  useHistoryActions();
  useLibraryActions();
  useJournalActions();
  usePaletteActions();
  const ready = useStartup();
  // Only the connection, not the tab: a tab switch must not re-render the whole shell.
  const connectionId = useTabsStore((state) => selectActiveTab(state).connectionId);
  const connection = useConnection(connectionId);
  const panels = useLayoutStore((state) => state.panels);
  const [mainRef, size] = useElementSize<HTMLDivElement>();

  const sidebarWidth = fitPanel('sidebar', panels.sidebar, size.width);
  const bottomHeight = fitPanel('bottom', panels.bottom, size.height);
  const tint = connection ? tintOf(connection) : null;

  return (
    <div
      className={styles.shell}
      data-environment={connection?.environment ?? undefined}
      style={{ '--shell-tint': tint ?? 'transparent' } as CSSProperties}
    >
      <WindowTitleSync />
      <StableTitleBar />
      <ActiveToolbar />
      <div ref={mainRef} className={styles.main}>
        {sidebarWidth > 0 && (
          <div className={styles.sidebar} style={{ width: sidebarWidth }}>
            <StableSidebar />
          </div>
        )}
        <PanelResizer
          panel="sidebar"
          state={panels.sidebar}
          maxSize={size.width - CENTER_MIN_WIDTH}
        />
        <div className={styles.center}>
          <div className={styles.content}>{ready && <TabContent />}</div>
          <PanelResizer
            panel="bottom"
            state={panels.bottom}
            maxSize={size.height - CENTER_MIN_HEIGHT}
          />
          {bottomHeight > 0 && (
            <div className={styles.bottom} style={{ height: bottomHeight }}>
              <StableLog />
            </div>
          )}
        </div>
      </div>
      <StableStatusBar />
      <ConnectionDialog />
      <PasswordPromptDialog />
      <HostKeyDialog />
      <GroupDialog />
      <ExportDialog />
      <ObjectActionDialog />
      <PropertiesDialog />
      <ImportDialog />
      <ConnectionImportDialog />
      <ConnectionExportDialog />
      <SaveQueryDialog />
      <CommandPalette />
      <PreferencesDialog />
    </div>
  );
}

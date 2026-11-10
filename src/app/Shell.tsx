import { useEffect, useState, type CSSProperties } from 'react';

import { ConnectionDialog } from '../features/connections/ConnectionDialog';
import { useConnection } from '../features/connections/connectionStore';
import { GroupDialog } from '../features/connections/GroupDialog';
import { tintOf } from '../features/connections/model';
import { PasswordPromptDialog } from '../features/connections/PasswordPromptDialog';
import { ConnectionSidebar } from '../features/sidebar/ConnectionSidebar';
import { StatementLogPanel } from '../features/statement-log/StatementLogPanel';
import { StatusBar } from '../features/statusbar/StatusBar';
import { Toolbar } from '../features/toolbar/Toolbar';
import { nativeWindow } from '../ipc/nativeWindow';
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
import { TitleBar } from './titlebar/TitleBar';
import { useShortcuts } from './useShortcuts';
import { useWindowTitle } from './useWindowTitle';

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
        'view.toggleSidebar': () => {
          useLayoutStore.getState().togglePanel('sidebar');
        },
        'view.toggleStatementLog': () => {
          useLayoutStore.getState().togglePanel('bottom');
        },
      }),
    [],
  );
}

/** Main window: title bar with tabs, toolbar, sidebar, active tab, bottom panel, status bar. */
export function Shell() {
  useShortcuts();
  useShellActions();
  useWindowTitle();
  const ready = useStartup();
  const tab = useTabsStore(selectActiveTab);
  const connection = useConnection(tab.connectionId);
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
      <TitleBar />
      {tab.connectionId !== null && <Toolbar connection={connection} />}
      <div ref={mainRef} className={styles.main}>
        {sidebarWidth > 0 && (
          <div className={styles.sidebar} style={{ width: sidebarWidth }}>
            <ConnectionSidebar />
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
              <StatementLogPanel />
            </div>
          )}
        </div>
      </div>
      <StatusBar />
      <ConnectionDialog />
      <PasswordPromptDialog />
      <GroupDialog />
    </div>
  );
}

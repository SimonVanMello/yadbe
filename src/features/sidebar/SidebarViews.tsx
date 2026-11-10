import type { KeyboardEvent } from 'react';

import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { Icon, type IconName } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { HistoryPanel } from '../history/HistoryPanel';
import { ConnectionSidebar } from './ConnectionSidebar';
import styles from './SidebarViews.module.css';
import { useSidebarView, type SidebarView } from './sidebarViewStore';

const VIEWS: readonly { view: SidebarView; icon: IconName }[] = [
  { view: 'connections', icon: 'database' },
  { view: 'history', icon: 'history' },
];

/** The sidebar: a switcher between its views (connections, history) and the view itself. */
export function SidebarViews() {
  const t = useT();
  const current = useSidebarView((state) => state.view);
  const setView = useSidebarView((state) => state.setView);

  const labels: Record<SidebarView, string> = {
    connections: t('sidebar.connections'),
    history: t('history.title'),
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = VIEWS.findIndex((candidate) => candidate.view === current);
    const next =
      VIEWS[(index + (event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length];
    if (next) setView(next.view);
  };

  return (
    <div className={styles.views}>
      <div
        role="tablist"
        aria-label={t('history.view.label')}
        className={styles.switcher}
        onKeyDown={onKeyDown}
      >
        {VIEWS.map(({ view, icon }) => {
          const selected = view === current;
          const tab = (
            <button
              key={view}
              type="button"
              role="tab"
              id={`sidebar-tab-${view}`}
              aria-selected={selected}
              aria-controls="sidebar-view"
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => {
                setView(view);
              }}
            >
              <Icon name={icon} />
              {labels[view]}
            </button>
          );
          return view === 'history' ? (
            <Tooltip key={view} content={t('history.show')} shortcut={shortcutOf('view.history')}>
              {tab}
            </Tooltip>
          ) : (
            tab
          );
        })}
      </div>
      <div
        id="sidebar-view"
        role="tabpanel"
        aria-labelledby={`sidebar-tab-${current}`}
        className={styles.view}
      >
        {current === 'connections' ? <ConnectionSidebar /> : <HistoryPanel />}
      </div>
    </div>
  );
}

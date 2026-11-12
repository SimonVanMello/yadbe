import { WelcomeScreen } from '../../features/welcome/WelcomeScreen';
import {
  LazyActivityTabBody,
  LazyDdlTabBody,
  LazyKeyTabBody,
  LazyMigrationsTabBody,
} from '../lazyViews';
import { DataTabBody } from './DataTabBody';
import { QueryTabBody } from './QueryTabBody';
import styles from './TabContent.module.css';
import { selectActiveTab, useTabsStore } from './tabsStore';

/** Body of the active tab: the welcome screen of a new tab, its rows for a table tab, a definition for a DDL tab, a tool for a tool tab, else its query tab. */
export function TabContent() {
  const tab = useTabsStore(selectActiveTab);
  return (
    <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab.id}`} className={styles.panel}>
      {tab.connectionId === null ? (
        <WelcomeScreen key={tab.id} />
      ) : tab.table ? (
        <DataTabBody key={tab.id} tab={tab} table={tab.table} />
      ) : tab.ddl ? (
        <LazyDdlTabBody key={tab.id} tab={tab} target={tab.ddl} />
      ) : tab.tool?.type === 'activity' ? (
        <LazyActivityTabBody key={tab.id} tab={tab} />
      ) : tab.tool?.type === 'migrations' ? (
        <LazyMigrationsTabBody key={tab.id} tab={tab} table={tab.tool.table} />
      ) : tab.tool?.type === 'kvKey' ? (
        <LazyKeyTabBody key={tab.id} tab={tab} target={tab.tool} />
      ) : (
        <QueryTabBody tab={tab} />
      )}
    </div>
  );
}

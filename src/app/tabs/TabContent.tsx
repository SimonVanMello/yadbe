import { ActivityTabBody } from '../../features/activity/ActivityTabBody';
import { MigrationsTabBody } from '../../features/migrations/MigrationsTabBody';
import { DdlTabBody } from '../../features/objects/DdlTabBody';
import { TableTabBody } from '../../features/table-data/TableTabBody';
import { WelcomeScreen } from '../../features/welcome/WelcomeScreen';
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
        <TableTabBody key={tab.id} tab={tab} table={tab.table} />
      ) : tab.ddl ? (
        <DdlTabBody key={tab.id} tab={tab} target={tab.ddl} />
      ) : tab.tool?.type === 'activity' ? (
        <ActivityTabBody key={tab.id} tab={tab} />
      ) : tab.tool?.type === 'migrations' ? (
        <MigrationsTabBody key={tab.id} tab={tab} table={tab.tool.table} />
      ) : (
        <QueryTabBody tab={tab} />
      )}
    </div>
  );
}

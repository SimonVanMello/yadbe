import { WelcomeScreen } from '../../features/welcome/WelcomeScreen';
import { QueryTabBody } from './QueryTabBody';
import styles from './TabContent.module.css';
import { selectActiveTab, useTabsStore } from './tabsStore';

/** Body of the active tab: the welcome screen of a new tab, else its query tab. */
export function TabContent() {
  const tab = useTabsStore(selectActiveTab);
  return (
    <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab.id}`} className={styles.panel}>
      {tab.connectionId === null ? <WelcomeScreen key={tab.id} /> : <QueryTabBody tab={tab} />}
    </div>
  );
}

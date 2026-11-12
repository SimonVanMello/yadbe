import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import type { ConnectionSummary } from '../connections/model';
import queryStyles from '../query/QueryControls.module.css';
import { useQueryTabStore } from '../query/queryTabStore';
import { runSearchConsole, stopSearchConsole } from './searchConsoleActions';
import { useSearchConsole } from './searchConsoleStore';

/**
 * The toolbar of a search console: run the request under the cursor (or the selected ones),
 * run them all, and stop (the request is dropped and its server task cancelled).
 */
export function SearchConsoleControls({ tabId }: { tabId: string; connection: ConnectionSummary }) {
  const t = useT();
  const shortcutOf = useShortcutOf();
  const run = useSearchConsole(tabId);
  const selection = useQueryTabStore((state) => state.tabs[tabId]?.selection);
  const hasSelection = selection !== undefined && selection.anchor !== selection.head;
  const runLabel = hasSelection ? t('search.console.runSelection') : t('search.console.runOne');

  return (
    <>
      <span className={queryStyles.group}>
        <Tooltip content={runLabel} shortcut={shortcutOf('query.run')}>
          <Button
            variant="primary"
            size="sm"
            disabled={run.running}
            onClick={() => {
              void runSearchConsole(tabId);
            }}
          >
            <Icon name="play" />
            {runLabel}
          </Button>
        </Tooltip>
        <Button
          size="sm"
          disabled={run.running}
          onClick={() => {
            void runSearchConsole(tabId, true);
          }}
        >
          <Icon name="list" />
          {t('search.console.runAll')}
        </Button>
      </span>
      <Tooltip content={t('search.console.stopHint')} shortcut={shortcutOf('query.cancel')}>
        <Button
          size="sm"
          disabled={!run.running}
          onClick={() => {
            stopSearchConsole(tabId);
          }}
        >
          <Icon name="stop" />
          {t('search.console.stop')}
        </Button>
      </Tooltip>
    </>
  );
}

import { useEffect, useState } from 'react';

import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { formatCount } from '../grid/formatCount';
import { formatDuration } from '../query/format';
import statusStyles from '../statusbar/StatusBar.module.css';
import { useScriptTab } from './scriptStore';

/** Milliseconds since `startedAt`, refreshed ten times a second while `active`. */
function useRunningMs(startedAt: number | null, active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setNow(performance.now());
    }, 100);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/**
 * The active mongosh tab's run in the status bar, like a SQL tab's: live while the script runs,
 * then how it ended, its documents and its duration.
 */
export function ScriptRunStatus() {
  const tabId = useTabsStore((state) => selectActiveTab(state).id);
  const run = useScriptTab(tabId);
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const elapsed = useRunningMs(run.startedAt, run.running);
  if (!run.running && run.outcome === null) return null;
  let icon = null;
  let text: string;
  if (run.running) {
    icon = <Spinner />;
    text = t('mongo.script.status.running', { time: formatDuration(elapsed) });
  } else if (run.outcome) {
    const time = formatDuration(run.outcome.durationMs ?? 0);
    const failure = run.outcome.failure;
    if (failure?.error.code === 'cancelled') {
      text = t('mongo.script.status.cancelled', { time });
    } else if (failure) {
      icon = <Icon name="error" className={statusStyles.failedIcon} />;
      text = t('mongo.script.status.failed', { time });
    } else {
      icon = <Icon name="check" />;
      const result = run.outcome.result;
      text =
        result?.kind === 'documents' && !result.single
          ? `${formatCount(locale, 'mongo.console.documents', result.documents.count)} · ${time}`
          : t('mongo.script.status.succeeded', { time });
    }
  } else {
    return null;
  }
  return (
    <span className={statusStyles.run} data-testid="statusbar-script">
      {icon}
      <span>{text}</span>
    </span>
  );
}

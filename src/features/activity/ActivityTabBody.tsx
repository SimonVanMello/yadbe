import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ToolTabGuard } from '../tools/ToolTabGuard';
import { ActivityView } from './ActivityView';

/**
 * Body of an activity tab (F-140): what the connection's server is doing, sessions and locks,
 * with the ability to stop a statement or a session. Needs the connection to be open.
 */
export function ActivityTabBody({ tab }: { tab: ShellTab }) {
  const t = useT();
  return (
    <ToolTabGuard
      tab={tab}
      title={t('activity.title')}
      needsConnection={t('activity.noConnection')}
    >
      {(connection) => <ActivityView connection={connection} />}
    </ToolTabGuard>
  );
}

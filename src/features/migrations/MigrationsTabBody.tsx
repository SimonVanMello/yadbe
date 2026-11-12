import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import type { ObjectRef } from '../../ipc';
import { ToolTabGuard } from '../tools/ToolTabGuard';
import { MigrationsView } from './MigrationsView';

/**
 * Body of a migrations tab (F-143): the history table of EF Core as a timeline. Needs the
 * connection to be open.
 */
export function MigrationsTabBody({ tab, table }: { tab: ShellTab; table: ObjectRef }) {
  const t = useT();
  return (
    <ToolTabGuard
      tab={tab}
      title={t('migrations.title')}
      needsConnection={t('migrations.noConnection')}
    >
      {(connection) => <MigrationsView connection={connection} table={table} />}
    </ToolTabGuard>
  );
}

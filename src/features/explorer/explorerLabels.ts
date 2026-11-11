import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { ObjectKind } from '../../ipc';
import type { IconName } from '../../ui/Icon';
import { localize } from '../../app/errors/presentError';
import type { DetailGroup, ExplorerRow, StatusSubject } from './explorerRows';

type Translate = (key: MessageKey, params?: MessageParams) => string;

const KIND_LABELS: Record<ObjectKind, MessageKey> = {
  table: 'explorer.kind.table',
  view: 'explorer.kind.view',
  materializedView: 'explorer.kind.materializedView',
  function: 'explorer.kind.function',
  procedure: 'explorer.kind.procedure',
  sequence: 'explorer.kind.sequence',
  type: 'explorer.kind.type',
};

const GROUP_LABELS: Record<DetailGroup, MessageKey> = {
  columns: 'explorer.group.columns',
  keys: 'explorer.group.keys',
  foreignKeys: 'explorer.group.foreignKeys',
  indexes: 'explorer.group.indexes',
  constraints: 'explorer.group.constraints',
  triggers: 'explorer.group.triggers',
};

const EMPTY_LABELS: Record<StatusSubject, MessageKey> = {
  connecting: 'explorer.status.loading',
  databases: 'explorer.status.empty.databases',
  schemas: 'explorer.status.empty.schemas',
  kinds: 'explorer.status.empty.kinds',
  objects: 'explorer.status.empty.objects',
  details: 'explorer.status.empty.details',
};

export const KIND_ICONS: Record<ObjectKind, IconName> = {
  table: 'table',
  view: 'view',
  materializedView: 'matView',
  function: 'routine',
  procedure: 'routine',
  sequence: 'sequence',
  type: 'tag',
};

export const GROUP_ICONS: Record<DetailGroup, IconName> = {
  columns: 'columns',
  keys: 'key',
  foreignKeys: 'link',
  indexes: 'index',
  constraints: 'checkSquare',
  triggers: 'bolt',
};

export const kindLabel = (t: Translate, kind: ObjectKind) => t(KIND_LABELS[kind]);
export const groupLabel = (t: Translate, group: DetailGroup) => t(GROUP_LABELS[group]);

/** Name of a foreign key, or the columns it covers when it has none. */
function foreignKeyName(row: Extract<ExplorerRow, { type: 'foreignKey' }>): string {
  const { foreignKey } = row;
  return foreignKey.name ?? foreignKey.columns.join(', ');
}

/** Text of a row without its decorations: for the type-ahead and the accessible name. */
export function explorerRowLabel(row: ExplorerRow, t: Translate): string {
  switch (row.type) {
    case 'database':
      return row.database.name;
    case 'schema':
      return row.schema.name;
    case 'kind':
      return `${kindLabel(t, row.kind)} (${String(row.count)})`;
    case 'object':
      return row.object.name;
    case 'pinnedGroup':
      return `${t('explorer.pinned')} (${String(row.count)})`;
    case 'pinned':
      return row.pin.name;
    case 'detailGroup':
      return `${groupLabel(t, row.group)} (${String(row.count)})`;
    case 'column':
      return row.column.name;
    case 'key':
      return row.name ?? row.columns.join(', ');
    case 'foreignKey':
      return foreignKeyName(row);
    case 'index':
      return row.index.name;
    case 'check':
      return row.check.name ?? row.check.expression;
    case 'trigger':
      return row.trigger.name;
    case 'status':
      if (row.status === 'error') {
        return row.error ? localize(row.error.message) : t('explorer.status.failed');
      }
      if (row.status === 'loading') {
        return t(
          row.subject === 'connecting' ? 'explorer.status.connecting' : 'explorer.status.loading',
        );
      }
      return t(EMPTY_LABELS[row.subject]);
  }
}

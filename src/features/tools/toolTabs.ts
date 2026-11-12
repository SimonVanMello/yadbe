import type { ToolTarget } from '../../app/tabs/tabsStore';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { IconName } from '../../ui/Icon';
import { tableLabel } from '../table-data/tableNames';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The name a tool tab carries in the strip, the window title and the palette. */
export function toolTabName(tool: ToolTarget, t: Translate): string {
  return tool.type === 'activity' ? t('tab.tool.activity') : t('tab.tool.migrations');
}

/** What the tooltip of a tool tab says about it. */
export function toolTabTooltip(tool: ToolTarget, t: Translate): string {
  return tool.type === 'activity'
    ? t('tab.tool.activityTooltip')
    : t('tab.tool.migrationsTooltip', { name: tableLabel(tool.table) });
}

export function toolTabIcon(tool: ToolTarget): IconName {
  return tool.type === 'activity' ? 'activity' : 'timeline';
}

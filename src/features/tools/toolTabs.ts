import type { ToolTarget } from '../../app/tabs/tabsStore';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { IconName } from '../../ui/Icon';
import { tableLabel } from '../table-data/tableNames';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The name a tool tab carries in the strip, the window title and the palette. */
export function toolTabName(tool: ToolTarget, t: Translate): string {
  switch (tool.type) {
    case 'activity':
      return t('tab.tool.activity');
    case 'migrations':
      return t('tab.tool.migrations');
    case 'kvKey':
      return tool.key.text;
  }
}

/** What the tooltip of a tool tab says about it. */
export function toolTabTooltip(tool: ToolTarget, t: Translate): string {
  switch (tool.type) {
    case 'activity':
      return t('tab.tool.activityTooltip');
    case 'migrations':
      return t('tab.tool.migrationsTooltip', { name: tableLabel(tool.table) });
    case 'kvKey':
      return t('keyValue.tab.tooltip', { key: tool.key.text, database: tool.database });
  }
}

export function toolTabIcon(tool: ToolTarget): IconName {
  switch (tool.type) {
    case 'activity':
      return 'activity';
    case 'migrations':
      return 'timeline';
    case 'kvKey':
      return 'key';
  }
}

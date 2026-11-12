import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { ContextMenuCheckboxItem } from '../../ui/ContextMenuCheckboxItem';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import type { ReactNode } from 'react';

import { COPY_FORMATS, type CopyFormat } from './copyFormats';
import { setPreference, usePreference } from '../preferences/preferenceStore';

interface GridMenuProps {
  hasSelection: boolean;
  viewerOpen: boolean;
  onCopy: (format: CopyFormat, headers: boolean) => void;
  onSelectAll: () => void;
  onViewCell: () => void;
  /** Opens (or closes) the row detail panel (F-068). */
  onRowDetail: () => void;
  rowDetailOpen: boolean;
  /** Present when the grid can be exported. */
  onExport: (() => void) | undefined;
  /** Set when the menu opened on a column header. */
  onAutoFit: (() => void) | null;
  /** Entries of the grid's owner (table editing), after the grid's own. */
  extras?: ReactNode;
}

/** Content of the grid's context menu (F-063). */
export function GridMenu({
  hasSelection,
  viewerOpen,
  onCopy,
  onSelectAll,
  onViewCell,
  onRowDetail,
  rowDetailOpen,
  onExport,
  onAutoFit,
  extras,
}: GridMenuProps) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const copyHeaders = usePreference('copyHeaders');
  return (
    <>
      <ContextMenuItem
        icon="copy"
        shortcut="Mod+C"
        disabled={!hasSelection}
        onSelect={() => {
          onCopy('tsv', false);
        }}
      >
        {t('grid.menu.copy')}
      </ContextMenuItem>
      <ContextMenuItem
        shortcut="Mod+Shift+C"
        disabled={!hasSelection}
        onSelect={() => {
          onCopy('tsv', true);
        }}
      >
        {t('grid.menu.copyHeaders')}
      </ContextMenuItem>
      <ContextMenuSub label={t('grid.menu.copyAs')} disabled={!hasSelection}>
        {COPY_FORMATS.map((format) => (
          <ContextMenuItem
            key={format}
            onSelect={() => {
              onCopy(format, copyHeaders);
            }}
          >
            {t(`grid.format.${format}`)}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem
          checked={copyHeaders}
          onCheckedChange={(checked) => {
            setPreference('copyHeaders', checked);
          }}
        >
          {t('grid.menu.includeHeaders')}
        </ContextMenuCheckboxItem>
      </ContextMenuSub>
      {onExport && (
        <ContextMenuItem shortcut={shortcutOf('result.export')} onSelect={onExport}>
          {t('export.menu')}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem shortcut="Mod+A" onSelect={onSelectAll}>
        {t('grid.menu.selectAll')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="panelRight"
        shortcut="Space"
        disabled={!hasSelection}
        onSelect={onViewCell}
      >
        {viewerOpen ? t('grid.viewer.hide') : t('grid.menu.viewCell')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="list"
        shortcut={shortcutOf('result.rowDetail')}
        disabled={!hasSelection}
        onSelect={onRowDetail}
      >
        {rowDetailOpen ? t('grid.row.hide') : t('grid.menu.rowDetail')}
      </ContextMenuItem>
      {onAutoFit && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onAutoFit}>{t('grid.menu.autoFit')}</ContextMenuItem>
        </>
      )}
      {extras}
    </>
  );
}

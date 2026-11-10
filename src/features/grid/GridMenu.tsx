import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { ContextMenuCheckboxItem } from '../../ui/ContextMenuCheckboxItem';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import { COPY_FORMATS, type CopyFormat } from './copyFormats';
import { useGridPrefs } from './gridPrefsStore';

interface GridMenuProps {
  hasSelection: boolean;
  viewerOpen: boolean;
  onCopy: (format: CopyFormat, headers: boolean) => void;
  onSelectAll: () => void;
  onViewCell: () => void;
  /** Present when the grid can be exported. */
  onExport: (() => void) | undefined;
  /** Set when the menu opened on a column header. */
  onAutoFit: (() => void) | null;
}

/** Content of the grid's context menu (F-063). */
export function GridMenu({
  hasSelection,
  viewerOpen,
  onCopy,
  onSelectAll,
  onViewCell,
  onExport,
  onAutoFit,
}: GridMenuProps) {
  const t = useT();
  const copyHeaders = useGridPrefs((state) => state.copyHeaders);
  const setCopyHeaders = useGridPrefs((state) => state.setCopyHeaders);
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
        <ContextMenuCheckboxItem checked={copyHeaders} onCheckedChange={setCopyHeaders}>
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
      {onAutoFit && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onAutoFit}>{t('grid.menu.autoFit')}</ContextMenuItem>
        </>
      )}
    </>
  );
}

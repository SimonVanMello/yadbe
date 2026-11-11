import { Popover as RadixPopover } from 'radix-ui';

import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { setReferencingOpen, useFkStore } from './fkNavigation';
import styles from './ForeignKeys.module.css';
import { ReferencingRows } from './ReferencingRows';
import { gridOf } from './tableActions';

/**
 * The strip button of "rows referencing this row" (F-088); the grid's menu and `Shift+F12`
 * open the same panel, anchored here.
 */
export function ReferencingButton({ tabId }: { tabId: string }) {
  const t = useT();
  const open = useFkStore((state) => state.referencing[tabId] ?? false);
  const label = t('tableData.fk.referencing.button');
  return (
    <RadixPopover.Root
      open={open}
      onOpenChange={(next) => {
        setReferencingOpen(tabId, next);
      }}
    >
      <RadixPopover.Trigger asChild>
        <IconButton
          icon="link"
          size="sm"
          label={label}
          shortcut={shortcutOf('table.referencingRows')}
          data-testid="fk-referencing-button"
        />
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={`${styles.panel} ${styles.referencing}`}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            gridOf(tabId)?.focus();
          }}
        >
          {open && <ReferencingRows tabId={tabId} />}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

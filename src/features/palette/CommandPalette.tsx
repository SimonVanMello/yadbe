import { Dialog, VisuallyHidden } from 'radix-ui';
import { useRef } from 'react';

import { useT } from '../../i18n/useT';
import styles from './CommandPalette.module.css';
import { PaletteBody } from './PaletteBody';
import { usePaletteStore } from './paletteStore';

/**
 * The command palette (F-120): one field to run an action, open a connection, jump to a
 * database object, switch tab or find a statement in the history. The content is only mounted
 * while the palette is open, so nothing is fetched or indexed before it is asked for.
 */
export function CommandPalette() {
  const t = useT();
  const open = usePaletteStore((state) => state.open);
  // Closing hands the focus back to where it was, except when the chosen item moves it itself
  // (reveal in the explorer, a tab, an editor).
  const restoreFocus = useRef(true);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) usePaletteStore.getState().show();
        else usePaletteStore.getState().hide();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          data-modal=""
          onCloseAutoFocus={(event) => {
            if (!restoreFocus.current) event.preventDefault();
            restoreFocus.current = true;
          }}
        >
          <VisuallyHidden.Root asChild>
            <Dialog.Title>{t('palette.title')}</Dialog.Title>
          </VisuallyHidden.Root>
          <PaletteBody
            onChosen={(item) => {
              restoreFocus.current = item.kind === 'action';
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

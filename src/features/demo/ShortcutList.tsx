import { Fragment } from 'react';

import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/i18n';
import { Kbd } from '../../ui/Kbd';
import styles from './ShortcutList.module.css';

const SHORTCUTS: readonly { label: MessageKey; shortcut: string }[] = [
  { label: 'demo.kbd.palette', shortcut: 'Mod+K' },
  { label: 'demo.kbd.run', shortcut: 'Mod+Enter' },
  { label: 'demo.kbd.newTab', shortcut: 'Mod+T' },
];

export function ShortcutList() {
  const t = useT();
  return (
    <dl className={styles.list}>
      {SHORTCUTS.map(({ label, shortcut }) => (
        <Fragment key={label}>
          <dt>{t(label)}</dt>
          <dd>
            <Kbd shortcut={shortcut} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

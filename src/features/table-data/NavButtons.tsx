import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { moveInTrail, useFkStore } from './fkNavigation';
import styles from './ForeignKeys.module.css';
import { canMove } from './navTrail';

/**
 * Back and forward along the trail of foreign key jumps (F-088), shown in a tab the trail
 * stands in: the same as `Alt+←` / `Alt+→`.
 */
export function NavButtons({ tabId }: { tabId: string }) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const back = useFkStore((state) => canMove(state.trail, tabId, -1));
  const forward = useFkStore((state) => canMove(state.trail, tabId, 1));
  if (!back && !forward) return null;
  return (
    <span className={styles.navButtons} data-testid="fk-nav">
      <IconButton
        icon="back"
        size="sm"
        label={t('action.table.navigateBack')}
        shortcut={shortcutOf('table.navigateBack')}
        disabled={!back}
        onClick={() => {
          moveInTrail(-1);
        }}
      />
      <IconButton
        icon="forward"
        size="sm"
        label={t('action.table.navigateForward')}
        shortcut={shortcutOf('table.navigateForward')}
        disabled={!forward}
        onClick={() => {
          moveInTrail(1);
        }}
      />
    </span>
  );
}

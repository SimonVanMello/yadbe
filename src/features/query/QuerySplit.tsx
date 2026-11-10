import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';

import { useT } from '../../i18n/useT';
import styles from './QuerySplit.module.css';
import { MAX_RESULTS_RATIO, MIN_RESULTS_RATIO, clampRatio, useQueryUiStore } from './queryUiStore';

const KEYBOARD_STEP = 0.03;

/**
 * Handle between the editor and the results area. The share of the tab the results take is
 * remembered (`queryUiStore`); drag, or use the arrow keys.
 */
export function QuerySplit({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const ratio = useQueryUiStore((state) => state.resultsRatio);
  const setRatio = useQueryUiStore((state) => state.setResultsRatio);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !container.current) return;
    event.preventDefault();
    const box = container.current.getBoundingClientRect();
    document.body.dataset['resizing'] = 'row';
    const onMove = (move: PointerEvent) => {
      // The results grow upwards: the share is what lies below the pointer.
      setRatio((box.bottom - move.clientY) / box.height);
    };
    const onUp = () => {
      delete document.body.dataset['resizing'];
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp') setRatio(clampRatio(ratio + KEYBOARD_STEP));
    else if (event.key === 'ArrowDown') setRatio(clampRatio(ratio - KEYBOARD_STEP));
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('query.split.label')}
      aria-valuemin={Math.round(MIN_RESULTS_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RESULTS_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      className={styles.split}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

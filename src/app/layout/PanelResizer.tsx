import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { useT } from '../../i18n/useT';
import { useLayoutStore } from './layoutStore';
import styles from './PanelResizer.module.css';
import { PANEL_LIMITS, clampPanelSize, type PanelId, type PanelState } from './panels';

const KEYBOARD_STEP = 16;

interface PanelResizerProps {
  panel: PanelId;
  state: PanelState;
  /** Largest size that still leaves the center its minimum. */
  maxSize: number;
}

/**
 * Drag handle between the center and a panel (the sidebar on its left, the bottom panel below).
 * Arrows resize, Enter or double click collapses.
 */
export function PanelResizer({ panel, state, maxSize }: PanelResizerProps) {
  const t = useT();
  const setPanel = useLayoutStore((store) => store.setPanel);
  const limits = PANEL_LIMITS[panel];
  const vertical = panel === 'bottom';
  const clamp = (size: number) =>
    Math.min(clampPanelSize(panel, size), Math.max(limits.min, maxSize));
  const label = t(vertical ? 'layout.resizeBottom' : 'layout.resizeSidebar');

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = vertical ? event.clientY : event.clientX;
    const startSize = state.collapsed ? 0 : state.size;
    // The sidebar grows to the right, the bottom panel upwards.
    const direction = vertical ? -1 : 1;
    document.body.dataset.resizing = vertical ? 'row' : 'col';
    const onMove = (move: PointerEvent) => {
      const delta = (vertical ? move.clientY : move.clientX) - start;
      const size = startSize + delta * direction;
      // Dragging well below the minimum collapses the panel, like most IDEs.
      if (size < limits.min / 2) setPanel(panel, { collapsed: true });
      else setPanel(panel, { collapsed: false, size: clamp(size) });
    };
    const onUp = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? 'ArrowUp' : 'ArrowRight';
    const shrink = vertical ? 'ArrowDown' : 'ArrowLeft';
    if (event.key === grow || event.key === shrink) {
      const delta = event.key === grow ? KEYBOARD_STEP : -KEYBOARD_STEP;
      setPanel(panel, { collapsed: false, size: clamp(state.size + delta) });
    } else if (event.key === 'Enter' || event.key === ' ') {
      setPanel(panel, { collapsed: !state.collapsed });
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limits.max}
      aria-valuenow={state.collapsed ? 0 : state.size}
      tabIndex={0}
      className={styles.resizer}
      data-orientation={vertical ? 'horizontal' : 'vertical'}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setPanel(panel, { collapsed: !state.collapsed });
      }}
    />
  );
}

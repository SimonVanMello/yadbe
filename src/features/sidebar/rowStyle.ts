import type { CSSProperties } from 'react';

/** Where a virtualized row sits: all rows are laid out from the top, moved down by their offset. */
export function rowStyle(offset: number, height: number): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height,
    transform: `translateY(${String(offset)}px)`,
  };
}

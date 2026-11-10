import { useState } from 'react';

/** A size token (`--palette-row-height`) in px, read once when the component mounts. */
export function usePxToken(name: string, fallback: number): number {
  const [value] = useState(() => {
    const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(px) && px > 0 ? px : fallback;
  });
  return value;
}

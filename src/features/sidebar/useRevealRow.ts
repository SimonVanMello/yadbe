import { useEffect, useRef } from 'react';

import { REVEAL_TIMEOUT_MS, useRevealStore, type RevealRequest } from '../explorer/revealStore';
import type { SidebarTreeRow } from './sidebarRows';

function isRevealed(row: SidebarTreeRow, { connectionId, target }: RevealRequest): boolean {
  return (
    row.type === 'object' &&
    row.connectionId === connectionId &&
    row.object.kind === target.kind &&
    row.ref.name === target.name &&
    row.ref.database === target.database &&
    row.ref.schema === target.schema
  );
}

/**
 * Carries out a pending `revealInExplorer`: once the row of the object is listed (its parents
 * are expanded and loaded), `onFound` gets its index, and the request is done. A request whose
 * row never shows up is dropped after a while.
 */
export function useRevealRow(
  rows: readonly SidebarTreeRow[],
  onFound: (index: number) => void,
): void {
  const request = useRevealStore((store) => store.request);
  const found = useRef(onFound);
  useEffect(() => {
    found.current = onFound;
  });

  useEffect(() => {
    if (!request) return;
    const { clear } = useRevealStore.getState();
    const remaining = request.at + REVEAL_TIMEOUT_MS - Date.now();
    if (remaining <= 0) {
      clear();
      return;
    }
    const index = rows.findIndex((row) => isRevealed(row, request));
    if (index >= 0) {
      found.current(index);
      clear();
      return;
    }
    const timer = setTimeout(clear, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [request, rows]);
}

import { useEffect, useState } from 'react';

/**
 * Whether something running since `since` (ms) has run for `delayMs`: progress shows only for
 * what takes long enough to notice (SPEC §6: after 150 ms). `null`: nothing runs.
 */
export function useShownAfter(since: number | null, delayMs: number): boolean {
  const [shownFor, setShownFor] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(
      () => {
        setShownFor(since);
      },
      Math.max(0, since + delayMs - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [since, delayMs]);
  return since !== null && shownFor === since;
}

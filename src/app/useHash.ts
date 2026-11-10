import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
}

/** Current `location.hash` (`#primitives`), re-rendering on change. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

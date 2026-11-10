import { useEffect } from 'react';

import { findActions, runAction } from './actions';

/** True while a modal dialog is open: global shortcuts must not act behind it. */
export function modalOpen(): boolean {
  return document.querySelector('[data-modal]') !== null;
}

/** Global keyboard shortcuts (F-121), as bound in `actions.ts`. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.repeat && event.key !== 'Tab')) return;
      if (modalOpen()) return;
      // Actions of different tab kinds can share a key: the first that applies runs.
      for (const id of findActions(event)) {
        if (runAction(id)) {
          event.preventDefault();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

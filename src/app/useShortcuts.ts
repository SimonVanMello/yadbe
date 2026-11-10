import { useEffect } from 'react';

import { findAction, runAction } from './actions';

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
      const id = findAction(event);
      if (id === null) return;
      if (runAction(id)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

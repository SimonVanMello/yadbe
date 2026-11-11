import { useWindowTitle } from './useWindowTitle';

/** Keeps the OS window title on the active tab, in a component of its own so the shell does not follow the tab. */
export function WindowTitleSync() {
  useWindowTitle();
  return null;
}

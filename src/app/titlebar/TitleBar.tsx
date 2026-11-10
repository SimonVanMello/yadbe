import { nativeWindow } from '../../ipc/nativeWindow';
import { platform } from '../../ui/platform';
import { AppearanceMenu } from './AppearanceMenu';
import { TabStrip } from './TabStrip';
import styles from './TitleBar.module.css';
import { WindowControls } from './WindowControls';

/**
 * Title bar holding the tabs (F-122). Window buttons follow the OS (spec §6): native traffic
 * lights on macOS (overlay title bar), app-drawn buttons on the right elsewhere.
 */
export function TitleBar() {
  const macNative = platform === 'mac' && nativeWindow.isNative;
  // In the browser (mock), the window has no buttons of its own to draw.
  const drawControls = platform !== 'mac' && nativeWindow.isNative;
  return (
    <header className={styles.titlebar} data-tauri-drag-region>
      {macNative && <div className={styles.trafficLights} data-tauri-drag-region />}
      <TabStrip />
      <div className={styles.spacer} data-tauri-drag-region />
      <div className={styles.actions}>
        <AppearanceMenu />
      </div>
      {drawControls && <WindowControls />}
    </header>
  );
}

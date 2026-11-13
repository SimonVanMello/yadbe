import { showYadbeError } from '../../app/errors/presentError';
import { useShellStore } from '../../app/shellStore';
import { translate, useI18nStore, type MessageKey, type MessageParams } from '../../i18n/i18n';
import { ipc, type UpdateInfo, type UpdateStatus } from '../../ipc';
import { toast, useToastStore } from '../../ui/toastStore';
import { getPreference, setPreference } from '../preferences/preferenceStore';
import {
  setUpdatePhase,
  setUpdateStatus,
  showUpdate,
  useUpdateStore,
  type UpdatePhase,
} from './updateStore';

function t(key: MessageKey, params?: MessageParams): string {
  return translate(useI18nStore.getState().locale, key, params);
}

/** What the backend says about this build: no network call. `null` when it cannot answer. */
export async function loadUpdateStatus(): Promise<UpdateStatus | null> {
  const known = useUpdateStore.getState().status;
  if (known) return known;
  const result = await ipc.commands.updateStatus();
  if (result.status === 'error') {
    console.warn('Update status unavailable', result.error);
    return null;
  }
  setUpdateStatus(result.data);
  return result.data;
}

/** Opens the page of the newest release in the browser. */
export async function openReleasePage(): Promise<void> {
  const result = await ipc.commands.openReleasePage();
  if (result.status === 'error') showYadbeError(result.error);
}

/** The answer of a build that cannot update itself (no updater public key). */
function notConfigured(): void {
  toast({
    title: t('updates.notConfigured'),
    description: t('updates.notConfigured.hint'),
    action: { label: t('updates.releasePage'), onClick: () => void openReleasePage() },
    duration: Infinity,
  });
}

/** The notice of a newer version found at startup: the dialog opens from it. */
function notice(info: UpdateInfo): void {
  const id = toast({
    title: t('updates.available', { version: info.version }),
    description: t('updates.notice', { current: info.currentVersion }),
    action: {
      label: t('updates.notice.view'),
      onClick: () => {
        useToastStore.getState().dismiss(id);
        showUpdate(info);
      },
    },
    duration: Infinity,
  });
}

/** Asks GitHub for a newer version at once (palette, preferences): every outcome gets an answer. */
export async function checkForUpdatesNow(): Promise<void> {
  const status = await loadUpdateStatus();
  if (status && !status.configured) {
    notConfigured();
    return;
  }
  const result = await ipc.commands.checkForUpdate();
  if (result.status === 'error') {
    if (result.error.code === 'updatesNotConfigured') {
      notConfigured();
      return;
    }
    showYadbeError(result.error, { retry: () => void checkForUpdatesNow() });
    return;
  }
  if (result.data) {
    // Asked from the preferences: the update takes their place rather than stacking on them.
    useShellStore.getState().closePreferences();
    showUpdate(result.data);
  } else {
    toast({
      variant: 'success',
      title: t('updates.upToDate'),
      description: status
        ? t('updates.upToDate.hint', { current: status.currentVersion })
        : undefined,
    });
  }
}

/** The one-time question: the check is opt-in (SPEC §1), nothing is sent before a yes. */
function askOnce(): void {
  // Asked once: ignoring the question leaves the check off, the preferences can turn it on.
  setPreference('checkUpdates', 'off');
  const id = toast({
    title: t('updates.optIn'),
    description: t('updates.optIn.hint'),
    action: {
      label: t('updates.optIn.enable'),
      onClick: () => {
        useToastStore.getState().dismiss(id);
        setPreference('checkUpdates', 'on');
        // The user asked for it just now: answer like a manual check, "up to date" included.
        void checkForUpdatesNow();
      },
    },
    duration: Infinity,
  });
}

/** A silent check: being offline at startup is not worth a message. */
async function checkAtStartup(): Promise<void> {
  const result = await ipc.commands.checkForUpdate();
  if (result.status === 'error') {
    console.warn('Update check failed', result.error);
    return;
  }
  if (result.data) notice(result.data);
}

/**
 * Runs once per launch, after the preferences are back. A build without the updater key never
 * asks nor checks; otherwise the preference decides, and nothing reaches the network while it
 * is off.
 */
export async function checkForUpdatesAtStartup(): Promise<void> {
  const status = await loadUpdateStatus();
  if (!status?.configured) return;
  const preference = getPreference('checkUpdates');
  if (preference === 'on') await checkAtStartup();
  else if (preference === 'ask') askOnce();
}

/** Progress of the download under way, while the dialog waits for the backend. */
function followProgress(): () => void {
  return ipc.events.subscribe('updateProgress', ({ percent }) => {
    if (useUpdateStore.getState().phase.kind === 'downloading') {
      setUpdatePhase({ kind: 'downloading', percent });
    }
  });
}

const DOWNLOADING: UpdatePhase = { kind: 'downloading', percent: null };

/** Downloads, verifies and installs the update; the app restarts when it is done. */
export async function installUpdate(): Promise<void> {
  setUpdatePhase(DOWNLOADING);
  const unsubscribe = followProgress();
  try {
    const result = await ipc.commands.installUpdate();
    // On success the app restarts: only macOS (while it exits) and the mock backend get here.
    setUpdatePhase(
      result.status === 'error' ? { kind: 'failed', error: result.error } : { kind: 'restarting' },
    );
  } finally {
    unsubscribe();
  }
}

/** A package-manager copy: downloads and checks the package, then shows the command to run. */
export async function preparePackageUpgrade(): Promise<void> {
  setUpdatePhase(DOWNLOADING);
  const unsubscribe = followProgress();
  try {
    const result = await ipc.commands.preparePackageUpgrade();
    setUpdatePhase(
      result.status === 'error'
        ? { kind: 'failed', error: result.error }
        : { kind: 'ready', upgrade: result.data },
    );
  } finally {
    unsubscribe();
  }
}

export async function copyUpgradeCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    toast({ variant: 'success', title: t('updates.copied') });
  } catch (error) {
    console.warn('Clipboard unavailable', error);
  }
}

/** Restarts on the version the package manager installed. */
export function restartApp(): void {
  void ipc.commands.restartApp();
}

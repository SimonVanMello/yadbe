import { beforeEach, describe, expect, it } from 'vitest';

import { loadLocale, useI18nStore } from '../../i18n/i18n';
import { mockBackend } from '../../ipc/mockClient';
import { mockErrors } from '../../ipc/mockErrors';
import type { MockUpdateSetup } from '../../ipc/mock/updates';
import { useToastStore } from '../../ui/toastStore';
import { getPreference, setPreference } from '../preferences/preferenceStore';
import {
  checkForUpdatesAtStartup,
  checkForUpdatesNow,
  installUpdate,
  preparePackageUpgrade,
} from './updates';
import {
  closeUpdate,
  resetUpdateStore,
  showUpdate,
  updateBusy,
  useUpdateStore,
} from './updateStore';

const toasts = () => useToastStore.getState().toasts;
const counts = () => mockBackend.updates.counts;

function setup(update: MockUpdateSetup): void {
  (globalThis as { __YADBE_MOCK_UPDATES__?: MockUpdateSetup }).__YADBE_MOCK_UPDATES__ = update;
}

/** Lets the mock's chained promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
  mockBackend.reset();
  resetUpdateStore();
  useToastStore.setState({ toasts: [] });
  setPreference('checkUpdates', 'ask');
  await loadLocale('en');
  useI18nStore.getState().setLocale('en');
});

describe('at startup', () => {
  it('a build without the updater key neither asks nor checks', async () => {
    await checkForUpdatesAtStartup();
    expect(toasts()).toEqual([]);
    expect(getPreference('checkUpdates')).toBe('ask');
    expect(counts().checks).toBe(0);
    expect(useUpdateStore.getState().status).toMatchObject({ configured: false });
  });

  it('asks once and checks nothing before a yes', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0' });
    await checkForUpdatesAtStartup();
    const [question] = toasts();
    expect(question?.title).toBe('Check for updates at startup?');
    // Ignored, the question leaves the check off: it is not asked again.
    expect(getPreference('checkUpdates')).toBe('off');
    expect(counts().checks).toBe(0);

    question?.action?.onClick();
    await settle();
    expect(getPreference('checkUpdates')).toBe('on');
    expect(counts().checks).toBe(1);
    // Asked for just now: the update opens at once.
    expect(useUpdateStore.getState().update?.version).toBe('0.2.0');
  });

  it('checks nothing while the preference is off', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0' });
    setPreference('checkUpdates', 'off');
    await checkForUpdatesAtStartup();
    expect(toasts()).toEqual([]);
    expect(counts().checks).toBe(0);
  });

  it('announces a newer version with a notice that opens the dialog', async () => {
    setup({ configured: true, channel: 'deb', latest: '0.2.0' });
    setPreference('checkUpdates', 'on');
    await checkForUpdatesAtStartup();
    expect(counts().checks).toBe(1);
    const [notice] = toasts();
    expect(notice?.title).toBe('yadbe 0.2.0 is available');
    expect(notice?.description).toBe('You have 0.1.0.');
    expect(useUpdateStore.getState().update).toBeNull();
    notice?.action?.onClick();
    expect(useUpdateStore.getState().update).toMatchObject({ version: '0.2.0', channel: 'deb' });
    expect(toasts()).toEqual([]);
  });

  it('stays silent when the check fails or finds nothing', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: null });
    setPreference('checkUpdates', 'on');
    mockBackend.updates.failNext(mockErrors.updateCheckFailed('offline'));
    await checkForUpdatesAtStartup();
    expect(toasts()).toEqual([]);
    expect(counts().checks).toBe(1);
  });
});

describe('a check on demand', () => {
  it('says when this build cannot update itself, without a request', async () => {
    await checkForUpdatesNow();
    expect(toasts()[0]?.title).toBe('Updates are not available in this build');
    expect(counts().checks).toBe(0);
    toasts()[0]?.action?.onClick();
    await settle();
    expect(counts().releasePageOpens).toBe(1);
  });

  it('answers "up to date", or opens the update, whatever the preference', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: null });
    setPreference('checkUpdates', 'off');
    await checkForUpdatesNow();
    expect(toasts()[0]).toMatchObject({ variant: 'success', title: 'yadbe is up to date' });

    setup({ latest: '0.3.0' });
    resetUpdateStore();
    await checkForUpdatesNow();
    expect(useUpdateStore.getState().update?.version).toBe('0.3.0');
    expect(counts().checks).toBe(2);
  });

  it('shows a failed check with a retry', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0' });
    mockBackend.updates.failNext(mockErrors.updateCheckFailed('HTTP 503'));
    await checkForUpdatesNow();
    const [error] = toasts();
    expect(error).toMatchObject({ variant: 'error', title: 'Could not check for updates.' });
    error?.action?.onClick();
    await settle();
    expect(useUpdateStore.getState().update?.version).toBe('0.2.0');
  });
});

describe('the dialog', () => {
  it('follows the download of the updater, then waits for the restart', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0', holdDownloads: true });
    await checkForUpdatesNow();
    const install = installUpdate();
    await settle();
    expect(useUpdateStore.getState().phase).toEqual({ kind: 'downloading', percent: 42 });
    expect(updateBusy(useUpdateStore.getState().phase)).toBe(true);
    // Busy: closing is refused.
    closeUpdate();
    expect(useUpdateStore.getState().update).not.toBeNull();
    mockBackend.updates.finishDownload();
    await install;
    expect(useUpdateStore.getState().phase).toEqual({ kind: 'restarting' });
    expect(counts().installs).toBe(1);
  });

  it('gives a package-manager copy its checked package and the command', async () => {
    setup({ configured: true, channel: 'rpm', latest: '0.2.0' });
    await checkForUpdatesNow();
    await preparePackageUpgrade();
    const { phase } = useUpdateStore.getState();
    expect(phase).toMatchObject({
      kind: 'ready',
      upgrade: {
        command:
          'sudo dnf install /home/me/.cache/dev.tropico.yadbe/update/yadbe-0.2.0-1.x86_64.rpm',
      },
    });
    closeUpdate();
    expect(useUpdateStore.getState().update).toBeNull();
  });

  it('shows a failed install, and a retry starts again', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0' });
    await checkForUpdatesNow();
    mockBackend.updates.failNext(mockErrors.updateInstallFailed('signature mismatch'));
    await installUpdate();
    expect(useUpdateStore.getState().phase).toMatchObject({
      kind: 'failed',
      error: { code: 'updateInstallFailed', detail: 'signature mismatch' },
    });
    await installUpdate();
    expect(useUpdateStore.getState().phase).toEqual({ kind: 'restarting' });
  });

  it('a second check does not reset an update under way', async () => {
    setup({ configured: true, channel: 'selfUpdate', latest: '0.2.0', holdDownloads: true });
    await checkForUpdatesNow();
    const install = installUpdate();
    await settle();
    showUpdate({ ...(useUpdateStore.getState().update ?? never()), version: '0.2.1' });
    expect(useUpdateStore.getState().update?.version).toBe('0.2.0');
    mockBackend.updates.finishDownload();
    await install;
  });
});

function never(): never {
  throw new Error('no update in the dialog');
}

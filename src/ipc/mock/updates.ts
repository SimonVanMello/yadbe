import type {
  InstallChannel,
  PackageUpgrade,
  UpdateInfo,
  UpdateProgress,
  UpdateStatus,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

/**
 * What a test sets before the app starts (`page.addInitScript`): the build is configured (it has
 * the updater public key), how it was installed, and the update the manifest announces.
 */
export interface MockUpdateSetup {
  configured?: boolean;
  channel?: InstallChannel;
  /** Version the manifest announces; `null`: this version is the newest. */
  latest?: string | null;
  /** Downloads stop halfway until `finishDownload()` (a capture of the progress). */
  holdDownloads?: boolean;
}

const injected = globalThis as { __YADBE_MOCK_UPDATES__?: MockUpdateSetup };

const CURRENT_VERSION = '0.1.0';
const CACHE = '/home/me/.cache/dev.tropico.yadbe/update';

/** The command `prepare_package_upgrade` would return for `channel`. */
export function mockPackageUpgrade(
  channel: InstallChannel,
  version: string,
): PackageUpgrade | null {
  switch (channel) {
    case 'aur':
      return { command: 'yay -S yadbe-bin', package: null };
    case 'deb': {
      const file = `${CACHE}/yadbe_${version}_amd64.deb`;
      return { command: `sudo apt install ${file}`, package: file };
    }
    case 'rpm': {
      const file = `${CACHE}/yadbe-${version}-1.x86_64.rpm`;
      return { command: `sudo dnf install ${file}`, package: file };
    }
    case 'selfUpdate':
    case 'manual':
      return null;
  }
}

/**
 * The update commands of the mock backend. By default the build is not configured, like a
 * build from the repository: no question at startup, no check.
 */
export function createMockUpdates(emit: (payload: UpdateProgress) => void) {
  let configured = false;
  let channel: InstallChannel = 'manual';
  let latest: string | null = null;
  let holdDownloads = false;
  let failure: YadbeError | null = null;
  let release: (() => void) | null = null;
  const counts = { checks: 0, installs: 0, prepares: 0, releasePageOpens: 0, restarts: 0 };

  /** A test's setup (`window.__YADBE_MOCK_UPDATES__`, set before the app loads), read once. */
  function applySetup(): void {
    const setup = injected.__YADBE_MOCK_UPDATES__;
    if (!setup) return;
    injected.__YADBE_MOCK_UPDATES__ = undefined;
    configured = setup.configured ?? configured;
    channel = setup.channel ?? channel;
    latest = setup.latest === undefined ? latest : setup.latest;
    holdDownloads = setup.holdDownloads ?? holdDownloads;
  }

  function available(): UpdateInfo | null {
    if (latest === null) return null;
    return {
      currentVersion: CURRENT_VERSION,
      version: latest,
      notes: `https://github.com/SimonVanMello/yadbe/releases/tag/v${latest}`,
      date: '2026-11-20T10:00:00Z',
      channel,
    };
  }

  function takeFailure(): YadbeError | null {
    const taken = failure;
    failure = null;
    return taken;
  }

  /** Progress at 0 then 42 %, then either the end at once or a wait for `finishDownload()`. */
  async function download(): Promise<void> {
    emit({ percent: 0 });
    await Promise.resolve();
    emit({ percent: 42 });
    if (holdDownloads) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    emit({ percent: 100 });
  }

  const commands: Pick<
    YadbeClient['commands'],
    | 'updateStatus'
    | 'checkForUpdate'
    | 'installUpdate'
    | 'preparePackageUpgrade'
    | 'openReleasePage'
    | 'restartApp'
  > = {
    updateStatus: () => {
      applySetup();
      const status: UpdateStatus = { configured, channel, currentVersion: CURRENT_VERSION };
      return ok(status);
    },
    checkForUpdate: () => {
      applySetup();
      if (!configured) return fail(mockErrors.updatesNotConfigured());
      counts.checks += 1;
      const error = takeFailure();
      return error ? fail(error) : ok(available());
    },
    installUpdate: async () => {
      if (!configured) return fail(mockErrors.updatesNotConfigured());
      const error = takeFailure();
      if (error) return fail(error);
      if (channel !== 'selfUpdate' || latest === null) {
        return fail(mockErrors.updateInstallFailed('this copy is not replaced by the updater'));
      }
      counts.installs += 1;
      await download();
      // The real backend restarts the app here; only macOS (while it exits) answers.
      return { status: 'ok', data: null };
    },
    preparePackageUpgrade: async () => {
      if (!configured) return fail(mockErrors.updatesNotConfigured());
      const error = takeFailure();
      if (error) return fail(error);
      const upgrade = latest === null ? null : mockPackageUpgrade(channel, latest);
      if (!upgrade) {
        return fail(
          mockErrors.updateInstallFailed('this copy is not upgraded by a package manager'),
        );
      }
      counts.prepares += 1;
      if (upgrade.package !== null) await download();
      return { status: 'ok', data: upgrade };
    },
    openReleasePage: () => {
      counts.releasePageOpens += 1;
      return ok(null);
    },
    restartApp: () => {
      counts.restarts += 1;
      return Promise.resolve();
    },
  };

  return {
    commands,
    counts,
    /** The next check, install or download fails with `error`. */
    failNext: (error: YadbeError): void => {
      failure = error;
    },
    /** Ends a download held by `holdDownloads`. */
    finishDownload: (): void => {
      release?.();
      release = null;
    },
    reset(): void {
      configured = false;
      channel = 'manual';
      latest = null;
      holdDownloads = false;
      failure = null;
      release = null;
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
  };
}

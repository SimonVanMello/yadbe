import { create } from 'zustand';

import type { PackageUpgrade, UpdateInfo, UpdateStatus, YadbeError } from '../../ipc';

/** Where the update shown in the dialog stands. */
export type UpdatePhase =
  /** The offer: nothing started. */
  | { kind: 'offer' }
  /** The installer bundle or the package is downloading (`percent` once its size is known). */
  | { kind: 'downloading'; percent: number | null }
  /** Installed by the updater: the app restarts (only macOS and the mock get to show it). */
  | { kind: 'restarting' }
  /** A package-manager copy: the command to run in a terminal, then a restart. */
  | { kind: 'ready'; upgrade: PackageUpgrade }
  | { kind: 'failed'; error: YadbeError };

interface UpdateState {
  /** What the backend said about this build (`updateStatus`); `null` until it answered. */
  status: UpdateStatus | null;
  /** The update the dialog shows; `null` when it is closed. */
  update: UpdateInfo | null;
  phase: UpdatePhase;
}

const OFFER: UpdatePhase = { kind: 'offer' };

export const useUpdateStore = create<UpdateState>()(() => ({
  status: null,
  update: null,
  phase: OFFER,
}));

/** While the backend downloads or installs, the dialog cannot be closed. */
export function updateBusy(phase: UpdatePhase): boolean {
  return phase.kind === 'downloading' || phase.kind === 'restarting';
}

export function setUpdateStatus(status: UpdateStatus): void {
  useUpdateStore.setState({ status });
}

export function showUpdate(update: UpdateInfo): void {
  // A dialog already busy with an update keeps going: a second check does not reset it.
  const current = useUpdateStore.getState();
  if (current.update && updateBusy(current.phase)) return;
  useUpdateStore.setState({ update, phase: OFFER });
}

export function setUpdatePhase(phase: UpdatePhase): void {
  if (useUpdateStore.getState().update) useUpdateStore.setState({ phase });
}

export function closeUpdate(): void {
  if (updateBusy(useUpdateStore.getState().phase)) return;
  useUpdateStore.setState({ update: null, phase: OFFER });
}

/** Tests only. */
export function resetUpdateStore(): void {
  useUpdateStore.setState({ status: null, update: null, phase: OFFER });
}

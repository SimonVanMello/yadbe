import { create } from 'zustand';

import type { TunnelFailure } from '../../ipc';

interface PendingHostKey {
  failure: TunnelFailure;
  resolve: (trusted: boolean) => void;
}

interface HostKeyPromptStore {
  pending: PendingHostKey | null;
  settle: (trusted: boolean) => void;
}

export const useHostKeyPrompt = create<HostKeyPromptStore>()((set, get) => ({
  pending: null,
  settle: (trusted) => {
    get().pending?.resolve(trusted);
    set({ pending: null });
  },
}));

/**
 * Shows an unknown SSH host key (`sshHostKeyUnknown`) with its fingerprint; resolves `true` once
 * the user trusted it and the backend stored it.
 */
export function askTrustHostKey(failure: TunnelFailure): Promise<boolean> {
  useHostKeyPrompt.getState().settle(false);
  return new Promise((resolve) => {
    useHostKeyPrompt.setState({ pending: { failure, resolve } });
  });
}

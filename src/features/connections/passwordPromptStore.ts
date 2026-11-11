import { create } from 'zustand';

import type { SecretKind } from '../../ipc';
import type { ConnectionSummary } from './model';

/** Password typed in the prompt, and whether it goes to the keychain once it works. */
export interface PromptedPassword {
  password: string;
  remember: boolean;
}

/** An SSH password or key passphrase to ask for instead of the database password. */
export interface PromptedSecretRequest {
  kind: SecretKind;
  /** `user@host:port` (or `host:port`) of the SSH server that asks. */
  endpoint: string;
}

interface PendingPrompt {
  connection: ConnectionSummary;
  secret: PromptedSecretRequest | null;
  resolve: (secret: PromptedPassword | null) => void;
}

interface PasswordPromptStore {
  pending: PendingPrompt | null;
  settle: (secret: PromptedPassword | null) => void;
}

export const usePasswordPrompt = create<PasswordPromptStore>()((set, get) => ({
  pending: null,
  settle: (secret) => {
    get().pending?.resolve(secret);
    set({ pending: null });
  },
}));

/**
 * Asks for the password of a connection that has none stored (or, with `secret`, one of its SSH
 * secrets); `null` when dismissed.
 */
export function askPassword(
  connection: ConnectionSummary,
  secret: PromptedSecretRequest | null = null,
): Promise<PromptedPassword | null> {
  usePasswordPrompt.getState().settle(null);
  return new Promise((resolve) => {
    usePasswordPrompt.setState({ pending: { connection, secret, resolve } });
  });
}

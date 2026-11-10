import { create } from 'zustand';

import type { ConnectionSummary } from './model';

/** Password typed in the prompt, and whether it goes to the keychain once it works. */
export interface PromptedPassword {
  password: string;
  remember: boolean;
}

interface PendingPrompt {
  connection: ConnectionSummary;
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

/** Asks for the password of a connection that has none stored; `null` when dismissed. */
export function askPassword(connection: ConnectionSummary): Promise<PromptedPassword | null> {
  usePasswordPrompt.getState().settle(null);
  return new Promise((resolve) => {
    usePasswordPrompt.setState({ pending: { connection, resolve } });
  });
}

import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  description: string;
  /** Exact statement that will run, shown for transparency. */
  statement?: string;
  confirmLabel: string;
  danger?: boolean;
  /** Concrete effect of the action (e.g. the connections that will be deleted). */
  items?: ConfirmItem[];
}

export interface ConfirmItem {
  label: string;
  /** What happens to this entry ("will be deleted"), shown after the label. */
  note?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmStore {
  pending: PendingConfirm | null;
  settle: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>()((set, get) => ({
  pending: null,
  settle: (confirmed) => {
    get().pending?.resolve(confirmed);
    set({ pending: null });
  },
}));

/** Asks for confirmation in a modal dialog; resolves `false` if dismissed. */
export function confirm(request: ConfirmRequest): Promise<boolean> {
  useConfirmStore.getState().settle(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { ...request, resolve } });
  });
}

import { create } from 'zustand';

import { showError } from '../../app/errors/presentError';
import { translate, useI18nStore } from '../../i18n/i18n';
import { ipc, unwrap, type PinnedObject } from '../../ipc';
import { samePin } from './objectsModel';

interface PinStore {
  /** Every pin of every connection, in the order they were pinned. */
  pins: readonly PinnedObject[];
  /** Reads the pins from the backend (startup, after a rename moved one). */
  load: () => Promise<void>;
  /** Pins an object now and tells the backend; a refusal puts things back. */
  pin: (pin: PinnedObject) => Promise<void>;
  unpin: (pin: PinnedObject) => Promise<void>;
  toggle: (pin: PinnedObject) => Promise<void>;
  /** The pins of a connection that was deleted go with it (the backend deleted them). */
  forgetConnection: (connectionId: string) => void;
}

function failed(error: unknown): void {
  const locale = useI18nStore.getState().locale;
  showError(error, { title: translate(locale, 'explorer.pinned.failed') });
}

export const usePinStore = create<PinStore>()((set, get) => ({
  pins: [],

  load: async () => {
    try {
      set({ pins: await unwrap(ipc.commands.listPinnedObjects()) });
    } catch (error) {
      console.warn('Pinned objects unavailable', error);
    }
  },

  pin: async (pin) => {
    const before = get().pins;
    if (before.some((p) => samePin(p, pin))) return;
    set({ pins: [...before, pin] });
    try {
      await unwrap(ipc.commands.pinObject(pin));
    } catch (error) {
      set({ pins: before });
      failed(error);
    }
  },

  unpin: async (pin) => {
    const before = get().pins;
    if (!before.some((p) => samePin(p, pin))) return;
    set({ pins: before.filter((p) => !samePin(p, pin)) });
    try {
      await unwrap(ipc.commands.unpinObject(pin));
    } catch (error) {
      set({ pins: before });
      failed(error);
    }
  },

  toggle: (pin) => (get().pins.some((p) => samePin(p, pin)) ? get().unpin(pin) : get().pin(pin)),

  forgetConnection: (connectionId) => {
    set((state) => ({ pins: state.pins.filter((p) => p.connectionId !== connectionId) }));
  },
}));

const NO_PINS: readonly PinnedObject[] = [];

/** The pins of one connection, in order. */
export function pinsOfConnection(
  pins: readonly PinnedObject[],
  connectionId: string,
): readonly PinnedObject[] {
  const own = pins.filter((pin) => pin.connectionId === connectionId);
  return own.length === 0 ? NO_PINS : own;
}

export function isPinned(pins: readonly PinnedObject[], pin: PinnedObject): boolean {
  return pins.some((p) => samePin(p, pin));
}

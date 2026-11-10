import { create } from 'zustand';

import type { ObjectKind } from '../../ipc';

/** An object the explorer was asked to show. */
export interface RevealTarget {
  database: string;
  /** `null` on engines without schemas. */
  schema: string | null;
  kind: ObjectKind;
  name: string;
}

export interface RevealRequest {
  connectionId: string;
  target: RevealTarget;
  /** Changes with every request, so that asking for the same object twice works. */
  seq: number;
  /** `Date.now()` of the request: one that never finds its row (the object is gone) expires. */
  at: number;
}

interface RevealStore {
  request: RevealRequest | null;
  ask: (connectionId: string, target: RevealTarget) => void;
  clear: () => void;
}

let seq = 0;

/** The pending "reveal in explorer": the sidebar tree consumes it once the row is listed. */
export const useRevealStore = create<RevealStore>()((set) => ({
  request: null,
  ask: (connectionId, target) => {
    seq += 1;
    set({ request: { connectionId, target, seq, at: Date.now() } });
  },
  clear: () => {
    set({ request: null });
  },
}));

/** A request older than this is dropped: its row never came (the object was dropped meanwhile). */
export const REVEAL_TIMEOUT_MS = 15_000;

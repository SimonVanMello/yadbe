import type { EventCallback } from '@tauri-apps/api/event';

import type { commands, events } from './bindings';

/** Every backend command, with the exact signatures of the generated bindings. */
export type YadbeCommands = typeof commands;

type GeneratedEvents = typeof events;

export type YadbeEventName = keyof GeneratedEvents;

/** Payload type of each backend event, derived from the generated bindings. */
export type YadbeEventMap = {
  [K in YadbeEventName]: Parameters<GeneratedEvents[K]['listen']>[0] extends EventCallback<infer P>
    ? P
    : never;
};

export type Unsubscribe = () => void;
export type YadbeEventHandler<K extends YadbeEventName> = (payload: YadbeEventMap[K]) => void;

export interface YadbeEvents {
  /** Synchronously returns an unsubscribe function, even if the underlying listen is async. */
  subscribe<K extends YadbeEventName>(name: K, handler: YadbeEventHandler<K>): Unsubscribe;
}

/**
 * Contract between the frontend and the backend, derived from the generated bindings.
 * Both the Tauri client and the mock client implement it, so a new Rust command or event
 * fails the typecheck until the mock supports it.
 */
export interface YadbeClient {
  commands: YadbeCommands;
  events: YadbeEvents;
}

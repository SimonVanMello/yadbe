import type { YadbeEventHandler, YadbeEventMap, YadbeEventName, YadbeEvents } from './client';

type Handlers = { [K in YadbeEventName]?: Set<YadbeEventHandler<K>> };

/** In-memory event bus implementing the event half of the contract (mock backend, tests). */
export class EventEmitter implements YadbeEvents {
  private handlers: Handlers = {};

  subscribe<K extends YadbeEventName>(name: K, handler: YadbeEventHandler<K>): () => void {
    const set: Set<YadbeEventHandler<K>> = this.handlers[name] ?? new Set();
    this.handlers[name] = set as Handlers[K];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit<K extends YadbeEventName>(name: K, payload: YadbeEventMap[K]): void {
    const set = this.handlers[name];
    set?.forEach((handler) => {
      handler(payload);
    });
  }

  listenerCount(name: YadbeEventName): number {
    return this.handlers[name]?.size ?? 0;
  }
}

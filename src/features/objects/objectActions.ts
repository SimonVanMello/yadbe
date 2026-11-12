import { isTableTab, useTabsStore } from '../../app/tabs/tabsStore';
import type {
  ObjectAction,
  ObjectActionOutcome,
  ObjectActionRequest,
  ObjectInfo,
  ObjectKind,
  ObjectRef,
} from '../../ipc';
import { openTable } from '../table-data/tableActions';
import { useObjectActionStore } from './objectActionStore';
import { pinOf, sameObject } from './objectsModel';
import { usePinStore } from './pinStore';

/** Asks for a drop, truncate or rename: the confirmation dialog opens (F-026). */
export function requestObjectAction(
  connectionId: string,
  object: ObjectRef,
  kind: ObjectKind,
  id: string,
  action: ObjectAction,
): void {
  const request: ObjectActionRequest = { object, kind, id, action };
  useObjectActionStore.getState().open({ connectionId, request });
}

/** The entry of an object of the explorer, for the request of an action on it. */
export function requestOnObject(
  connectionId: string,
  object: ObjectRef,
  info: Pick<ObjectInfo, 'kind' | 'id'>,
  action: ObjectAction,
): void {
  requestObjectAction(connectionId, object, info.kind, info.id, action);
}

/**
 * What an action that ran changes around the explorer: table tabs showing the object are told
 * (they follow a rename, read an emptied or dropped table again), and its pin follows it or
 * goes with it. The explorer itself is refreshed by the backend's `meta-refreshed`.
 */
export function afterObjectAction(
  connectionId: string,
  request: ObjectActionRequest,
  outcome: ObjectActionOutcome,
): void {
  const tabs = useTabsStore.getState();
  const showing = () =>
    useTabsStore
      .getState()
      .tabs.filter(
        (tab) =>
          isTableTab(tab) &&
          tab.connectionId === connectionId &&
          sameObject(tab.table, request.object),
      )
      .map((tab) => tab.id);
  switch (request.action.type) {
    case 'rename': {
      if (outcome.renamedTo) {
        for (const id of tabs.renameObject(connectionId, request.object, outcome.renamedTo)) {
          void openTable(id);
        }
      }
      // The backend moved the pin with its object.
      void usePinStore.getState().load();
      return;
    }
    case 'truncate':
      for (const id of showing()) void openTable(id);
      return;
    case 'drop': {
      const ids = showing();
      void usePinStore
        .getState()
        .unpin(pinOf(connectionId, request.object, request.kind, request.id));
      for (const id of ids) void openTable(id);
      return;
    }
  }
}

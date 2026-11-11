import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type ObjectKind, type PinnedObject } from '../../ipc';
import { metaKeys } from '../explorer/metaKeys';
import { pinOf } from './objectsModel';
import { usePinStore } from './pinStore';

/** What the palette knows about an object: the catalog's entry, not the explorer's. */
export interface PaletteObject {
  connectionId: string;
  database: string;
  schema: string | null;
  objectKind: ObjectKind;
  name: string;
  /** Argument types of a routine, as the catalog has them. */
  signature: string | null;
}

/** The pin of this object, when it is pinned (a routine: any overload of that name). */
export function pinnedAs(
  pins: readonly PinnedObject[],
  item: PaletteObject,
): PinnedObject | undefined {
  return pins.find(
    (pin) =>
      pin.connectionId === item.connectionId &&
      pin.database === item.database &&
      pin.schema === item.schema &&
      pin.kind === item.objectKind &&
      pin.name === item.name,
  );
}

/**
 * The pin an object of the palette would be: a relation is its name; a routine is told apart
 * by its argument types, which the explorer's list has (the catalog's text differs).
 */
async function pinOfItem(item: PaletteObject): Promise<PinnedObject> {
  const object = { database: item.database, schema: item.schema, name: item.name };
  if (item.signature === null) return pinOf(item.connectionId, object, item.objectKind);
  const list = await queryClient.query({
    queryKey: metaKeys.objects(item.connectionId, item.database, item.schema, item.objectKind),
    queryFn: () =>
      unwrap(
        ipc.commands.listObjects(
          null,
          item.connectionId,
          item.database,
          item.schema,
          item.objectKind,
        ),
      ),
    staleTime: Infinity,
  });
  const same = list.filter((entry) => entry.name === item.name);
  const exact = same.find(
    (entry) => entry.detail.type === 'routine' && entry.detail.arguments === item.signature,
  );
  const id = (exact ?? same[0])?.id ?? item.name;
  return pinOf(item.connectionId, object, item.objectKind, id);
}

/** Pins an object of the palette, or unpins it when it is pinned (F-027). */
export async function togglePaletteObjectPin(item: PaletteObject): Promise<void> {
  const store = usePinStore.getState();
  const existing = pinnedAs(store.pins, item);
  await store.toggle(existing ?? (await pinOfItem(item)));
}

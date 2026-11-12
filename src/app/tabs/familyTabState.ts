import {
  useCollectionStore,
  type CollectionTabState,
} from '../../features/document/collectionStore';
import { useIndexStore, type IndexTabState } from '../../features/search/indexStore';

/**
 * What a collection tab (document family) or an index tab (search family) saves with the tab: the
 * query it was showing, so a restored tab reads the same page. Rows, counts and pending edits are
 * never saved (the tab reads its page again once connected, with nothing pending).
 */
export type FamilyTabState =
  | { collection: Pick<CollectionTabState, 'applied' | 'pageSize' | 'view'> }
  | { index: Pick<IndexTabState, 'applied' | 'pageSize' | 'view'> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pageSizeOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50_000
    ? value
    : fallback;
}

/** The family state of a tab to save, `null` for a tab that has none (or none yet). */
export function familyStateOf(tabId: string): FamilyTabState | null {
  const collection = useCollectionStore.getState().tabs[tabId];
  if (collection) {
    const { applied, pageSize, view } = collection;
    return { collection: { applied, pageSize, view } };
  }
  const index = useIndexStore.getState().tabs[tabId];
  if (index) {
    const { applied, pageSize, view } = index;
    return { index: { applied, pageSize, view } };
  }
  return null;
}

/** Puts a saved family state back into its store; anything unreadable is ignored. */
export function hydrateFamilyState(tabId: string, ui: unknown): void {
  if (!isRecord(ui)) return;
  const collection = ui['collection'];
  if (isRecord(collection) && isRecord(collection['applied'])) {
    const applied = {
      filter: text(collection['applied']['filter']),
      projection: text(collection['applied']['projection']),
      sort: text(collection['applied']['sort']),
    };
    useCollectionStore.getState().patch(tabId, {
      draft: applied,
      applied,
      pageSize: pageSizeOf(collection['pageSize'], 100),
      view: collection['view'] === 'documents' ? 'documents' : 'grid',
    });
    return;
  }
  const index = ui['index'];
  if (isRecord(index) && isRecord(index['applied'])) {
    const a = index['applied'];
    const applied = {
      mode: a['mode'] === 'dsl' ? ('dsl' as const) : ('queryString' as const),
      text: text(a['text']),
      source: text(a['source']),
      sortField: text(a['sortField']),
      descending: a['descending'] === true,
    };
    useIndexStore.getState().patch(tabId, {
      draft: applied,
      applied,
      pageSize: pageSizeOf(index['pageSize'], 100),
      view: index['view'] === 'documents' ? 'documents' : 'grid',
    });
  }
}

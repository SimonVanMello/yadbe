import type { CompletionCatalog, Engine } from '../../ipc';
import { mockBackend, mockClient } from '../../ipc/mockClient';
import { unwrap } from '../../ipc/result';
import { MOCK_ENGINES } from '../../ipc/mockData';
import { CatalogIndex } from './catalogIndex';
import { analyze, type CompletionContext } from './completionContext';
import { relationColumns, suggest, type Suggestion } from './completionOptions';
import { quotingOf, type Quoting } from './identifierQuoting';
import { vocabularyOf } from './sqlVocabulary';

/** Test helpers: a catalog from the mock backend, and suggestions at a `|` in a statement. */

const PG = 'conn-local-pg';

export async function mockCatalog(large = false): Promise<CompletionCatalog> {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  if (large) mockBackend.setMetaCatalog('large');
  await unwrap(mockClient.commands.connect(PG, null));
  return unwrap(mockClient.commands.getCompletionCatalog(null, PG, 'app_dev', true));
}

export function quotingFor(engine: Engine): Quoting {
  const info = MOCK_ENGINES.find((candidate) => candidate.engine === engine);
  if (!info) throw new Error(`no mock engine ${engine}`);
  return quotingOf(info.capabilities);
}

export interface Probe {
  ctx: CompletionContext;
  items: Suggestion[];
  labels: string[];
}

/** Suggestions where `sql` has its `|` (the cursor), as the editor would compute them. */
export function probe(
  sql: string,
  index: CatalogIndex | null,
  engine: Engine = 'postgres',
  limit?: number,
): Probe {
  const quoting = quotingFor(engine);
  const cursor = sql.indexOf('|');
  const ctx = analyze({
    text: sql.replace('|', ''),
    base: 0,
    cursor,
    rules: quoting,
    columnsOf: (path) => relationColumns(index, path),
  });
  const items = suggest(ctx, index, vocabularyOf(engine), quoting, limit);
  return { ctx, items, labels: items.map((item) => item.label) };
}

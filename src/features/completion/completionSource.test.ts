import {
  CompletionContext,
  autocompletion,
  currentCompletions,
  startCompletion,
  type Completion,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '../../app/queryClient';
import { ipc, unwrap, type Engine } from '../../ipc';
import { mockBackend } from '../../ipc/mockClient';
import { startMetaFeed } from '../explorer/metaFeed';
import { ensureCatalog, resetCatalogStore } from './catalogStore';
import { sqlCompletionSource, type CompletionHost } from './completionSource';
import { quotingFor } from './completionTestKit';

const PG = 'conn-local-pg';

let host: CompletionHost;
let asYouType: boolean;
let connected: boolean;
let engine: Engine;

beforeEach(async () => {
  mockBackend.reset();
  mockBackend.setLatency(0);
  mockBackend.setMetaLatency(0);
  queryClient.clear();
  resetCatalogStore();
  // The app's invalidation of cached catalogs on `metaRefreshed` (once per launch).
  startMetaFeed();
  await unwrap(ipc.commands.connect(PG, null));
  asYouType = true;
  connected = true;
  engine = 'postgres';
  host = {
    engine: () => engine,
    quoting: () => quotingFor(engine),
    target: () => ({
      connectionId: PG,
      database: null,
      connectionDatabase: 'app_dev',
      connected,
    }),
    asYouType: () => asYouType,
    tableDetails: () => Promise.resolve(null),
  };
});

afterEach(() => {
  queryClient.clear();
  resetCatalogStore();
  vi.restoreAllMocks();
});

/** Asks the source about `sql`, whose `|` is the cursor, as CodeMirror does. */
async function ask(sql: string, explicit = false): Promise<CompletionResult | null> {
  const cursor = sql.indexOf('|');
  const state = EditorState.create({ doc: sql.replace('|', ''), selection: { anchor: cursor } });
  const result = await sqlCompletionSource(host)(new CompletionContext(state, cursor, explicit));
  return result instanceof Promise ? result : result;
}

const labels = (result: CompletionResult | null) =>
  (result?.options ?? []).map((option) => option.label);

/** Loads the catalog, as the first keystroke would have. */
const load = () => ensureCatalog(PG, 'app_dev');

describe('when it answers', () => {
  it('suggests while typing a word, and after a dot', async () => {
    await load();
    expect(labels(await ask('select * from ord|'))[0]).toBe('orders');
    expect(labels(await ask('select o.| from shop.orders o'))).toContain('customer_id');
  });

  it('stays quiet when nothing is being typed, unless asked', async () => {
    await load();
    expect(await ask('select * from |')).toBeNull();
    expect(await ask('select * |')).toBeNull();
    expect(labels(await ask('select * from |', true))).toContain('orders');
  });

  it('only on Ctrl+Space once as-you-type is off', async () => {
    await load();
    asYouType = false;
    expect(await ask('select * from ord|')).toBeNull();
    expect(await ask('select o.| from shop.orders o')).toBeNull();
    expect(labels(await ask('select * from ord|', true))[0]).toBe('orders');
  });

  it('says nothing inside a string or a comment, even when asked', async () => {
    await load();
    expect(await ask("select 'ord|'", true)).toBeNull();
    expect(await ask('select 1 -- ord|', true)).toBeNull();
    expect(await ask('-- from ord|', true)).toBeNull();
    expect(await ask('select 1;\n-- from ord|', true)).toBeNull();
  });

  it('leaves the order to the ranking: CodeMirror filters and sorts nothing', async () => {
    await load();
    const result = await ask('select * from ord|');
    expect(result?.filter).toBe(false);
    expect(result?.validFor).toBeUndefined();
    expect(result?.from).toBe('select * from '.length);
    expect(result?.to).toBe('select * from ord'.length);
  });
});

describe('the catalog', () => {
  it('is read on first need; until it is there, keywords only', async () => {
    const reads = vi.spyOn(ipc.commands, 'getCompletionCatalog');
    const first = await ask('select a, cou|');
    expect(labels(first)).toContain('count');
    expect(reads).toHaveBeenCalledTimes(1);
    // A relation is expected but the schema is not there: nothing to offer yet.
    resetCatalogStore();
    queryClient.clear();
    expect(await ask('select * from ord|')).toBeNull();
  });

  it('is asked for once for all the keystrokes while it loads', async () => {
    mockBackend.setMetaLatency(60);
    const reads = vi.spyOn(ipc.commands, 'getCompletionCatalog');
    await ask('sel|');
    await ask('sele|');
    await ask('selec|');
    expect(reads).toHaveBeenCalledTimes(1);
    await load();
    expect(labels(await ask('select * from ord|'))[0]).toBe('orders');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('is not read for a connection that is not open', async () => {
    connected = false;
    const reads = vi.spyOn(ipc.commands, 'getCompletionCatalog');
    expect(labels(await ask('sel|'))).toContain('select');
    expect(reads).not.toHaveBeenCalled();
  });

  it('is read again, in the background, after a refresh; the old one serves meanwhile', async () => {
    await load();
    await unwrap(ipc.commands.refreshMeta(PG, { level: 'database', database: 'app_dev' }));
    mockBackend.setMetaLatency(80);
    const reads = vi.spyOn(ipc.commands, 'getCompletionCatalog');
    expect(labels(await ask('select * from ord|'))[0]).toBe('orders');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('re-asks the editor once it arrives, if the cursor has not moved', async () => {
    mockBackend.setMetaLatency(30);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'select * from ord',
        selection: { anchor: 17 },
        extensions: autocompletion({ override: [sqlCompletionSource(host)] }),
      }),
      parent: document.body,
    });
    startCompletion(view);
    // Nothing to show while the schema is not there…
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(currentCompletions(view.state)).toEqual([]);
    // …and the list appears by itself when it is.
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).map((option) => option.label)[0]).toBe('orders');
    });
    view.destroy();
  });

  it('does not re-ask once the cursor has moved on', async () => {
    mockBackend.setMetaLatency(30);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'select * from ord',
        selection: { anchor: 17 },
        extensions: autocompletion({ override: [sqlCompletionSource(host)] }),
      }),
      parent: document.body,
    });
    startCompletion(view);
    await new Promise((resolve) => setTimeout(resolve, 5));
    view.dispatch({ selection: { anchor: 3 } });
    await load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(currentCompletions(view.state)).toEqual([]);
    view.destroy();
  });
});

describe('the statement under the cursor', () => {
  it('limits aliases to it', async () => {
    await load();
    const sql = 'select * from shop.customers c;\nselect c.| from shop.orders o';
    expect(labels(await ask(sql))).not.toContain('email');
    const same = 'select * from shop.customers c;\nselect c.| from shop.customers c';
    expect(labels(await ask(same))).toContain('email');
  });

  it('starts anew after a finished statement', async () => {
    await load();
    const result = await ask('select 1 from shop.orders;\nsel|');
    expect(labels(result)[0]).toBe('select');
    expect(labels(await ask('select * from shop.orders;\nselect * from ord|'))[0]).toBe('orders');
  });

  it('goes on across lines when there is no semicolon', async () => {
    await load();
    expect(labels(await ask('select o.|\nfrom shop.orders o'))).toContain('status');
    expect(labels(await ask('select *\nfrom shop.orders o\nwhere o.|'))).toContain('status');
  });

  it('falls back to the whole script when the splitter fails', async () => {
    await load();
    vi.spyOn(ipc.commands, 'statementAt').mockRejectedValue(new Error('no backend'));
    expect(labels(await ask('select o.| from shop.orders o'))).toContain('status');
  });

  it('falls back to the whole script when the splitter is slow', async () => {
    await load();
    vi.spyOn(ipc.commands, 'statementAt').mockImplementation(() => new Promise(() => undefined));
    const started = performance.now();
    expect(labels(await ask('select o.| from shop.orders o'))).toContain('status');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('asks the backend with the engine of the tab', async () => {
    await load();
    const spy = vi.spyOn(ipc.commands, 'statementAt');
    await ask('select 1|');
    await ask('select * from ord|');
    expect(spy).toHaveBeenCalledWith('postgres', 'select * from ord', 17);
    engine = 'mssql';
    await ask('select * from ord|');
    expect(spy).toHaveBeenLastCalledWith('mssql', 'select * from ord', 17);
  });
});

describe('accepting', () => {
  async function accept(sql: string, pick: (options: readonly Completion[]) => Completion) {
    await load();
    const cursor = sql.indexOf('|');
    const view = new EditorView({
      state: EditorState.create({ doc: sql.replace('|', ''), selection: { anchor: cursor } }),
      parent: document.body,
    });
    const result = await sqlCompletionSource(host)(
      new CompletionContext(view.state, cursor, true, view),
    );
    if (!result) throw new Error('no suggestions');
    const option = pick(result.options);
    if (typeof option.apply !== 'function') throw new Error('no apply');
    option.apply(view, option, result.from, result.to ?? cursor);
    const state = { text: view.state.doc.toString(), cursor: view.state.selection.main.head };
    view.destroy();
    return state;
  }

  it('replaces the word, schema and quotes included', async () => {
    const done = await accept('select * from Order|', (options) => {
      const found = options.find((option) => option.label === 'Order Notes');
      if (!found) throw new Error('missing');
      return found;
    });
    expect(done.text).toBe('select * from shop."Order Notes"');
    expect(done.cursor).toBe(done.text.length);
  });

  it('replaces the rest of the word too', async () => {
    const done = await accept('select * from ord|ers', (options) => options[0] as Completion);
    expect(done.text).toBe('select * from shop.orders');
  });

  it('puts the cursor inside the parentheses of a function', async () => {
    const done = await accept('select cou| from shop.orders', (options) => {
      const found = options.find((option) => option.label === 'count');
      if (!found) throw new Error('missing');
      return found;
    });
    expect(done.text).toBe('select count() from shop.orders');
    expect(done.cursor).toBe('select count('.length);
  });

  it('closes the quote it was inside of', async () => {
    const done = await accept(
      'select * from shop."Order N|',
      (options) => options[0] as Completion,
    );
    expect(done.text).toBe('select * from shop."Order Notes"');
  });

  it('writes the alias and goes on', async () => {
    const done = await accept('select o| from shop.orders o', (options) => {
      const found = options.find((option) => option.label === 'o');
      if (!found) throw new Error('missing');
      return found;
    });
    expect(done.text).toBe('select o. from shop.orders o');
  });
});

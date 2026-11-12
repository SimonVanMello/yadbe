import { describe, expect, it } from 'vitest';

import type { KvBytes } from '../bindings';
import { mockBackend, mockClient } from '../mockClient';
import { unwrap } from '../result';
import { MOCK_STALE_KEY } from './keyValueEdit';

const t = (text: string): KvBytes => ({ text, base64: null });

describe('the mock key-value edits', () => {
  const { commands } = mockClient;

  async function connected() {
    mockBackend.reset();
    mockBackend.setLatency(0);
    await unwrap(commands.connect('conn-cache', null));
  }

  it('previews, applies, journals and reverts a change set', async () => {
    await connected();
    const changes = {
      database: 0,
      edits: [
        {
          op: 'hashSet' as const,
          key: t('user:1:profile'),
          field: t('plan'),
          original: t('pro'),
          value: t('team'),
        },
      ],
    };
    const preview = await unwrap(commands.kvPreviewChanges('conn-cache', changes));
    expect(preview.lines.map((l) => l.text)).toEqual([
      'WATCH user:1:profile',
      'TYPE user:1:profile',
      'HGET user:1:profile plan',
      'MULTI',
      'HSET user:1:profile plan team',
      'EXEC',
    ]);
    const applied = await unwrap(commands.kvApplyChanges('conn-cache', changes, false));
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const page = await unwrap(
      commands.searchChangeJournal({
        text: null,
        connectionId: null,
        table: null,
        after: null,
        limit: null,
      }),
    );
    expect(page.entries[0]?.family).toBe('keyValue');
    expect(page.entries[0]?.targetKind).toBe('key');
    // Applying the same change again finds the value changed: a conflict, nothing applied.
    const again = await unwrap(commands.kvApplyChanges('conn-cache', changes, false));
    expect(again.status === 'conflicted' && again.conflicts[0]?.current).toEqual(t('team'));

    const revert = await unwrap(commands.kvApplyRevert('conn-cache', applied.journalId ?? 0));
    expect(revert.status).toBe('applied');
    const reread = await unwrap(commands.kvApplyChanges('conn-cache', changes, false));
    expect(reread.status).toBe('applied');
  });

  it('scripts a conflict on its stale key, refuses read-only and confirms many deletes', async () => {
    await connected();
    const stale = {
      database: 0,
      edits: [
        {
          op: 'hashSet' as const,
          key: t(MOCK_STALE_KEY),
          field: t('plan'),
          original: t('free'),
          value: t('pro'),
        },
      ],
    };
    const conflict = await unwrap(commands.kvApplyChanges('conn-cache', stale, false));
    expect(conflict.status === 'conflicted' && conflict.conflicts[0]?.current).toEqual(
      t('enterprise'),
    );

    const deletes = {
      database: 0,
      edits: Array.from({ length: 12 }, (_, i) => ({
        op: 'delete' as const,
        key: t(`session:${String(i)}`),
        guard: null,
      })),
    };
    const asked = await unwrap(commands.kvApplyChanges('conn-cache', deletes, false));
    expect(asked.status).toBe('needsConfirmation');

    const definition = (await unwrap(commands.listConnections())).find(
      (c) => c.id === 'conn-cache',
    )?.definition;
    if (!definition) throw new Error('no cache connection');
    await unwrap(commands.updateConnection('conn-cache', { ...definition, readOnly: true }));
    const refused = await commands.kvApplyChanges('conn-cache', stale, true);
    expect(refused.status === 'error' && refused.error.code).toBe('readOnlyViolation');
  });

  it('counts and deletes a namespace, restorable from the journal', async () => {
    await connected();
    const count = await unwrap(commands.kvNamespaceCount('conn-cache', 0, t('session:')));
    expect(count.keys).toBe(40);
    const deleted = await unwrap(commands.kvDeleteNamespace('conn-cache', 0, t('session:')));
    expect(deleted.deleted).toBe(40);
    expect((await unwrap(commands.kvNamespaceCount('conn-cache', 0, t('session:')))).keys).toBe(0);
    await unwrap(commands.kvApplyRevert('conn-cache', deleted.journalId ?? 0));
    expect((await unwrap(commands.kvNamespaceCount('conn-cache', 0, t('session:')))).keys).toBe(40);
  });
});

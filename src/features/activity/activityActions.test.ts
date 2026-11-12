import { beforeEach, describe, expect, it } from 'vitest';

import { useI18nStore } from '../../i18n/i18n';
import type { ActivitySession } from '../../ipc';
import { killConfirmation } from './activityActions';

function session(id: string, patch: Partial<ActivitySession> = {}): ActivitySession {
  return {
    id,
    fingerprint: `fp-${id}`,
    user: 'shop_app',
    database: 'shop',
    client: '10.0.4.18:40872',
    application: null,
    state: 'active',
    stateText: 'active',
    wait: null,
    statement: "UPDATE shop.orders SET status = 'shipped' WHERE id = 1042",
    statementTruncated: false,
    runningSecs: 187,
    transactionSecs: 190,
    blockedBy: [],
    isSelf: false,
    system: false,
    ...patch,
  };
}

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('killConfirmation', () => {
  const blocker = session('4821', { state: 'idleInTransaction', runningSecs: 212 });
  const blocked = session('4902', { blockedBy: ['4821'] });
  const sessions = [blocker, blocked];

  it('names the session, who it is, since when and what it runs', () => {
    const { title, items, confirmLabel } = killConfirmation(blocked, 'cancelQuery', sessions);
    expect(title).toBe('Cancel this query?');
    expect(confirmLabel).toBe('Cancel the query');
    expect(items.map((item) => item.label)).toEqual([
      'Session 4902',
      'Running for 3m 07s',
      "UPDATE shop.orders SET status = 'shipped' WHERE id = 1042",
    ]);
    expect(items[0]?.note).toBe('shop_app from 10.0.4.18:40872');
    expect(items[2]?.code).toBe(true);
  });

  it('says a session end rolls its transaction back and what it blocks', () => {
    const { title, description, items } = killConfirmation(blocker, 'terminateSession', sessions);
    expect(title).toBe('End this session?');
    expect(description).toContain('rolled back');
    const labels = items.map((item) => item.label);
    expect(labels).toContain('Idle in transaction for 3m 32s');
    expect(labels).toContain('Blocks 1 session: it goes on');
    // Cancelling a query leaves the transaction alone: nothing to warn about.
    const cancelled = killConfirmation(blocked, 'cancelQuery', sessions).items;
    expect(cancelled.find((item) => item.label.startsWith('Transaction open'))).toBeUndefined();
    const active = killConfirmation(blocked, 'terminateSession', sessions).items;
    expect(
      active.find((item) => item.label.startsWith('Transaction open for 3m 10s'))?.danger,
    ).toBe(true);
  });

  it('is written in French too, and cuts a very long statement', () => {
    useI18nStore.setState({ locale: 'fr' });
    const long = session('7', { statement: `SELECT ${'x, '.repeat(400)}1` });
    const { title, items } = killConfirmation(long, 'terminateSession', [long]);
    expect(title).toBe('Terminer cette session ?');
    const quoted = items.at(-1);
    expect(quoted?.code).toBe(true);
    expect(quoted?.label.length).toBeLessThanOrEqual(401);
    expect(quoted?.label.endsWith('…')).toBe(true);
  });
});

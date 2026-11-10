import { describe, expect, it } from 'vitest';

import { ACTION_IDS, type ActionId } from '../../app/actions';
import { disabledReason, type ActionContext } from './actionAvailability';

const idle: ActionContext = {
  queryTab: false,
  connected: false,
  running: false,
  transactionOpen: false,
  tabCount: 1,
  closedTabCount: 0,
  registered: new Set<ActionId>(ACTION_IDS),
};

describe('disabledReason', () => {
  it('lets the always-available actions run', () => {
    for (const id of ['connection.new', 'tab.new', 'view.history', 'theme.dark'] as const) {
      expect(disabledReason(id, idle)).toBeNull();
    }
  });

  it('asks for a query tab where the editor is needed', () => {
    expect(disabledReason('query.run', idle)).toBe('palette.disabled.noQueryTab');
    expect(disabledReason('query.run', { ...idle, queryTab: true })).toBeNull();
    expect(disabledReason('query.save', idle)).toBe('palette.disabled.noQueryTab');
  });

  it('follows the run and the transaction state', () => {
    expect(disabledReason('query.cancel', idle)).toBe('palette.disabled.notRunning');
    expect(disabledReason('query.cancel', { ...idle, running: true })).toBeNull();
    expect(disabledReason('query.commit', idle)).toBe('palette.disabled.noTransaction');
    expect(disabledReason('query.rollback', { ...idle, transactionOpen: true })).toBeNull();
  });

  it('follows the tabs', () => {
    expect(disabledReason('tab.reopenClosed', idle)).toBe('palette.disabled.noClosedTab');
    expect(disabledReason('tab.reopenClosed', { ...idle, closedTabCount: 2 })).toBeNull();
    expect(disabledReason('tab.next', idle)).toBe('palette.disabled.oneTab');
    expect(disabledReason('tab.next', { ...idle, tabCount: 3 })).toBeNull();
  });

  it('refreshes the explorer of a connected tab only', () => {
    expect(disabledReason('explorer.refresh', idle)).toBe('palette.disabled.notConnected');
    expect(disabledReason('explorer.refresh', { ...idle, connected: true })).toBeNull();
  });

  it('says so when nothing is registered for the action', () => {
    expect(disabledReason('tab.new', { ...idle, registered: new Set() })).toBe(
      'palette.disabled.unavailable',
    );
  });
});

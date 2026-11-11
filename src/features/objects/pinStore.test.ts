import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend, mockClient } from '../../ipc/mockClient';
import { pinOf } from './objectsModel';
import { isPinned, pinsOfConnection, usePinStore } from './pinStore';

const ORDERS = { database: 'app_dev', schema: 'shop', name: 'orders' };
const orders = pinOf('conn-local-pg', ORDERS, 'table');
const customers = pinOf('conn-local-pg', { ...ORDERS, name: 'customers' }, 'table');

beforeEach(() => {
  mockBackend.reset();
  usePinStore.setState({ pins: [] });
});

describe('pin store', () => {
  it('pins in order, then reads them back from the backend', async () => {
    await usePinStore.getState().pin(orders);
    await usePinStore.getState().pin(customers);
    await usePinStore.getState().pin(orders);
    expect(usePinStore.getState().pins).toEqual([orders, customers]);

    usePinStore.setState({ pins: [] });
    await usePinStore.getState().load();
    expect(usePinStore.getState().pins).toEqual([orders, customers]);
  });

  it('toggles a pin and tells which belong to a connection', async () => {
    await usePinStore.getState().toggle(orders);
    expect(isPinned(usePinStore.getState().pins, orders)).toBe(true);
    expect(pinsOfConnection(usePinStore.getState().pins, 'conn-local-pg')).toEqual([orders]);
    expect(pinsOfConnection(usePinStore.getState().pins, 'other')).toEqual([]);
    await usePinStore.getState().toggle(orders);
    expect(usePinStore.getState().pins).toEqual([]);
  });

  it('puts the list back when the backend refuses', async () => {
    const refuse = vi.spyOn(mockClient.commands, 'pinObject').mockResolvedValue({
      status: 'error',
      error: {
        code: 'connectionNotFound',
        message: { en: 'No such connection.', fr: 'Connexion inconnue.' },
        action: null,
        detail: null,
      },
    });
    await usePinStore.getState().pin(orders);
    expect(usePinStore.getState().pins).toEqual([]);
    refuse.mockRestore();
  });
});

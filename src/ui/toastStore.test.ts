import { beforeEach, describe, expect, it } from 'vitest';

import { toast, useToastStore } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('adds toasts with defaults and dismisses them', () => {
    const id = toast({ title: 'Fetched' });
    expect(useToastStore.getState().toasts).toEqual([
      { id, title: 'Fetched', variant: 'info', duration: 5000 },
    ]);
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('keeps errors until dismissed', () => {
    toast({ title: 'Push rejected', variant: 'error' });
    expect(useToastStore.getState().toasts[0]?.duration).toBe(Infinity);
  });
});

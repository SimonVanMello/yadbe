import { QueryClient } from '@tanstack/react-query';

/** Shared so non-React modules (event handlers) can update cached data. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

export const queryKeys = {
  appInfo: ['app-info'] as const,
};

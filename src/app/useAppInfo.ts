import { useQuery } from '@tanstack/react-query';

import { ipc, unwrap } from '../ipc';
import { queryKeys } from './queryClient';

export function useAppInfo() {
  return useQuery({
    queryKey: queryKeys.appInfo,
    queryFn: () => unwrap(ipc.commands.appInfo()),
    staleTime: Infinity,
  });
}

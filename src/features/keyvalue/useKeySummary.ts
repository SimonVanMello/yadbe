import { useQuery } from '@tanstack/react-query';

import { ipc, unwrap, type KvBytes, type KvKeySummary } from '../../ipc';
import { bytesId } from './kvBytes';
import { kvKeys } from './kvKeys';

/** Keys asked together; the backend takes at most 500 per call. */
const BATCH_MAX = 200;
/** Wait for the other rows of the same frame before asking. */
const BATCH_DELAY_MS = 16;

interface Waiting {
  key: KvBytes;
  resolve: (summary: KvKeySummary | null) => void;
  reject: (error: unknown) => void;
}

const queues = new Map<string, { waiting: Waiting[]; timer: number }>();

function flush(queueId: string, connectionId: string, database: number): void {
  const queue = queues.get(queueId);
  queues.delete(queueId);
  if (!queue) return;
  for (let start = 0; start < queue.waiting.length; start += BATCH_MAX) {
    const batch = queue.waiting.slice(start, start + BATCH_MAX);
    unwrap(
      ipc.commands.kvKeySummaries(
        connectionId,
        database,
        batch.map((w) => w.key),
      ),
    ).then(
      (summaries) => {
        const byId = new Map(summaries.map((s) => [bytesId(s.key), s]));
        for (const waiting of batch) waiting.resolve(byId.get(bytesId(waiting.key)) ?? null);
      },
      (error: unknown) => {
        for (const waiting of batch) waiting.reject(error);
      },
    );
  }
}

/** The summary of one key, asked with the other keys that appeared in the same frame. */
function fetchSummary(
  connectionId: string,
  database: number,
  key: KvBytes,
): Promise<KvKeySummary | null> {
  const queueId = `${connectionId}\u001f${String(database)}`;
  return new Promise((resolve, reject) => {
    let queue = queues.get(queueId);
    if (!queue) {
      queue = {
        waiting: [],
        timer: window.setTimeout(() => {
          flush(queueId, connectionId, database);
        }, BATCH_DELAY_MS),
      };
      queues.set(queueId, queue);
    }
    queue.waiting.push({ key, resolve, reject });
  });
}

/**
 * Type, time to live and memory of a key shown in the tree. Only the rows on screen mount, so
 * only their keys are asked (`TYPE`, `PTTL`, `MEMORY USAGE` in one round trip per frame).
 */
export function useKeySummary(connectionId: string, database: number, key: KvBytes) {
  return useQuery({
    queryKey: kvKeys.summary(connectionId, database, key),
    queryFn: () => fetchSummary(connectionId, database, key),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

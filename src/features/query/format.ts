/** A duration for a status line: `38 ms`, `1.2 s`, `2 min 03 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1) return '< 1 ms';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

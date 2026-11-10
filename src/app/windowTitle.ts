/** Window title: the active tab and its connection, then the app name. */
export function windowTitle(parts: { tab: string | null; connection: string | null }): string {
  const head = [parts.tab, parts.connection].filter(Boolean).join(' · ');
  return head ? `${head} — yadbe` : 'yadbe';
}

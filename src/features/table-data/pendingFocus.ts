/**
 * The cell a table tab focuses once its next page is on screen (a foreign key jump lands on
 * the referenced row; going back returns to the row it left). Consumed by `tableActions`.
 */
export interface PendingFocus {
  row: number;
  column: string;
}

const pending = new Map<string, PendingFocus>();

export function setPendingFocus(tabId: string, focus: PendingFocus | null): void {
  if (focus) pending.set(tabId, focus);
  else pending.delete(tabId);
}

export function peekPendingFocus(tabId: string): PendingFocus | undefined {
  return pending.get(tabId);
}

export function clearPendingFocus(tabId: string): void {
  pending.delete(tabId);
}

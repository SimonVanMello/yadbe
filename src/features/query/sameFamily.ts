import { findConnection } from './connectionLookup';

/**
 * Whether text written for `sourceConnectionId` (a history entry, a saved query) can go into an
 * editor on `targetConnectionId`: SQL is never offered to a mongosh, Redis or search console, nor
 * their text to a SQL editor. An unknown connection (deleted, or a global saved query) cannot be
 * judged, so it is accepted.
 */
export function sameFamily(
  sourceConnectionId: string | null,
  targetConnectionId: string | null,
): boolean {
  const source = findConnection(sourceConnectionId);
  const target = findConnection(targetConnectionId);
  return source === undefined || target === undefined || source.family === target.family;
}

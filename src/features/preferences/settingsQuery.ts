import { createContext, useContext } from 'react';

/** The search of the preferences screen, trimmed; empty outside a search. */
export const SettingsQueryContext = createContext('');

export function useSettingsQuery(): string {
  return useContext(SettingsQueryContext);
}

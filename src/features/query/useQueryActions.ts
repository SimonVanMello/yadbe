import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import {
  activeQueryTabId,
  cancelQuery,
  commitTransaction,
  openScript,
  rollbackTransaction,
  runQuery,
  saveScript,
} from './queryActions';

/** Registers what the query shortcuts do (F-041, F-042, F-045) on the active query tab. */
export function useQueryActions(): void {
  useEffect(() => {
    const onActive = (act: (tabId: string) => void) => () => {
      const tabId = activeQueryTabId();
      if (tabId !== null) act(tabId);
    };
    return registerActions({
      'query.run': onActive((tabId) => {
        void runQuery(tabId, 'auto');
      }),
      'query.runStatement': onActive((tabId) => {
        void runQuery(tabId, 'statement');
      }),
      'query.cancel': onActive(cancelQuery),
      'query.open': onActive((tabId) => {
        void openScript(tabId);
      }),
      'query.save': onActive((tabId) => {
        void saveScript(tabId);
      }),
      'query.saveAs': onActive((tabId) => {
        void saveScript(tabId, true);
      }),
      'query.commit': onActive((tabId) => {
        void commitTransaction(tabId);
      }),
      'query.rollback': onActive((tabId) => {
        void rollbackTransaction(tabId);
      }),
    });
  }, []);
}

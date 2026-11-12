import { useEffect } from 'react';

import { registerActions } from '../../app/actions';
import { activeEditId } from '../table-data/tableActions';
import { getTableSession } from '../table-data/tableSessionStore';
import { explainQuery } from './explainActions';
import { formatTab, goToDefinition } from './formatActions';
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
    // `false` outside a query tab: a table tab's action bound to the same key runs instead.
    const onActive = (act: (tabId: string) => void) => () => {
      const tabId = activeQueryTabId();
      if (tabId === null) return false;
      act(tabId);
      return true;
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
      'query.save': () => {
        // `Mod+S` in a result grid with pending edits applies them (F-087): `table.apply`.
        const editing = activeEditId();
        if (editing !== null && getTableSession(editing).pendingCount > 0) return false;
        return onActive((tabId) => {
          void saveScript(tabId);
        })();
      },
      'query.saveAs': onActive((tabId) => {
        void saveScript(tabId, true);
      }),
      'query.commit': onActive((tabId) => {
        void commitTransaction(tabId);
      }),
      'query.rollback': onActive((tabId) => {
        void rollbackTransaction(tabId);
      }),
      'query.runSameParameters': onActive((tabId) => {
        void runQuery(tabId, 'auto', { sameValues: true });
      }),
      'query.format': onActive(formatTab),
      'query.explain': onActive((tabId) => {
        void explainQuery(tabId, false);
      }),
      'query.explainAnalyze': onActive((tabId) => {
        void explainQuery(tabId, true);
      }),
      'query.goToDefinition': onActive((tabId) => {
        void goToDefinition(tabId, 'reveal');
      }),
      'query.openDefinitionData': onActive((tabId) => {
        void goToDefinition(tabId, 'open');
      }),
    });
  }, []);
}

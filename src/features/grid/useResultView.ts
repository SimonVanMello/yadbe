import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { ipc, unwrap, type ResultViewInfo, type ResultViewSpec } from '../../ipc';
import type { ResultRowSource } from './resultRowSource';
import { EMPTY_VIEW, toSpec, type ResultViewState } from './resultViewModel';
import { useResultViewStore } from './resultViewStore';

/** The conditions settle before the backend is asked: typing does not send a request a key. */
const SETTLE_MS = 200;

const NO_VIEW: ResultViewSpec = { sort: [], filters: [], matchCase: false };

export interface ResultViewSync {
  view: ResultViewState;
  /** Rows shown and rows held while a view is in force, `null` without one. */
  info: ResultViewInfo | null;
}

/**
 * Keeps the backend's view of a result (its sort and filter, F-065) in step with what the user
 * asked for, and the grid's row source with the rows the view shows. The statement is never run
 * again: the backend orders and filters the rows it keeps. `onChange` runs when the rows behind
 * the grid's indices changed (the selection no longer means anything).
 */
export function useResultView(
  resultId: number,
  source: ResultRowSource,
  storedRows: number,
  columnCount: number,
  onChange: () => void,
): ResultViewSync {
  const view = useResultViewStore((state) => state.views[resultId]) ?? EMPTY_VIEW;
  const spec = useMemo(
    () => toSpec(view, columnCount),
    // The bar being open or closed changes nothing the backend needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.sort, view.conditions, view.matchCase, columnCount],
  );
  const [info, setInfo] = useState<ResultViewInfo | null>(null);
  const applied = useRef<ResultViewSpec | null>(null);
  const change = useRef(onChange);
  useLayoutEffect(() => {
    change.current = onChange;
  });

  // The user's sort or filter changed: the backend builds the view, the grid starts over.
  useEffect(() => {
    if (spec === null && applied.current === null) return;
    let current = true;
    const timer = setTimeout(
      () => {
        unwrap(ipc.commands.setResultView(resultId, spec ?? NO_VIEW)).then(
          (next) => {
            if (!current) return;
            applied.current = spec;
            setInfo(spec === null ? null : next);
            source.resetRows(next.rowCount);
            change.current();
          },
          (error: unknown) => {
            if (current) showError(error);
          },
        );
      },
      spec === null ? 0 : SETTLE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [spec, resultId, source]);

  // The result streamed more rows: the grid shows them at once, or, through a view, the rows the
  // view takes from them (a sorted one is built again).
  useLayoutEffect(() => {
    if (applied.current === null) source.setRowCount(storedRows);
  }, [storedRows, source]);
  useEffect(() => {
    const active = applied.current;
    if (active === null) return;
    let current = true;
    unwrap(ipc.commands.getResultView(resultId)).then(
      (next) => {
        if (!current) return;
        setInfo(next);
        if (active.sort.length > 0) source.resetRows(next.rowCount);
        else source.setRowCount(next.rowCount);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [storedRows, resultId, source]);

  return { view, info };
}

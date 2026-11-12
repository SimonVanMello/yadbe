import { useCallback } from 'react';

import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ConsoleResponse } from '../../ipc';
import { DocumentsView } from '../documents/DocumentsView';
import { ResultGrid } from '../grid/ResultGrid';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { HitsResults } from './HitsResults';
import { jsonDocument } from './jsonView';
import styles from './SearchConsole.module.css';
import type { ResponseView } from './searchConsoleStore';

interface ResponseBodyProps {
  response: ConsoleResponse;
  view: ResponseView;
  onView: (view: ResponseView) => void;
}

/**
 * What a console answer holds: its hits as a grid or as documents, an ES|QL / SQL table as a
 * grid, any JSON answer as a tree (aggregations, settings…) or its raw text, a text answer
 * (`_cat`) as text. Rows and documents stay in the backend.
 */
export function ResponseBody({ response, view, onView }: ResponseBodyProps) {
  const t = useT();
  const { body } = response;
  const documentId = body.kind === 'json' ? body.documentId : null;
  const loadAnswer = useCallback(
    async (offset: number, limit: number) =>
      documentId === null
        ? []
        : (await unwrap(ipc.commands.searchFetchDocuments(documentId, offset, limit))).map(
            jsonDocument,
          ),
    [documentId],
  );
  const label = `${response.method} ${response.path}`;

  switch (body.kind) {
    case 'empty':
      return <p className={styles.empty}>{t('search.console.noBody')}</p>;
    case 'text':
      return (
        <pre className={styles.text} data-testid="search-response-text">
          {body.text}
          {body.truncated && `\n${t('search.console.truncated')}`}
        </pre>
      );
    case 'json': {
      const rows = body.hits ? 'hits' : body.table ? 'table' : null;
      const views: ResponseView[] =
        rows === 'hits'
          ? ['grid', 'documents', 'json', 'raw']
          : rows === 'table'
            ? ['grid', 'json', 'raw']
            : ['json', 'raw'];
      const shown = views.includes(view) ? view : (views[0] ?? 'json');
      return (
        <div className={styles.body}>
          <div className={styles.views}>
            <SegmentedControl<ResponseView>
              label={t('search.view.label')}
              value={shown}
              options={views.map((value) => ({ value, label: t(`search.view.${value}`) }))}
              onChange={onView}
            />
          </div>
          <div className={styles.viewBody}>
            {shown === 'raw' ? (
              <pre className={styles.text} data-testid="search-response-raw">
                {body.raw}
                {body.truncated && `\n${t('search.console.truncated')}`}
              </pre>
            ) : shown === 'json' ? (
              <DocumentsView
                key={body.documentId}
                count={1}
                load={loadAnswer}
                label={t('search.console.answer', { request: label })}
              />
            ) : body.hits ? (
              <HitsResults
                result={body.hits}
                view={shown}
                label={t('search.console.hits', { request: label })}
              />
            ) : body.table ? (
              <ResultGrid
                resultId={body.table.resultId}
                summary={body.table}
                label={t('search.console.table', { request: label })}
              />
            ) : null}
          </div>
        </div>
      );
    }
  }
}

import type { ResultSummary } from '../../ipc';
import { ResultGridView } from './ResultGridView';

export interface ResultGridProps {
  resultId: number;
  /** The latest summary of the result; re-rendered as it streams. */
  summary: ResultSummary;
  /** Accessible name; defaults to "Result n" from the statement index. */
  label?: string;
}

/**
 * A backend result (M1-3 `ResultStore`) in the data grid: windows read on demand, rows appearing
 * while they stream (F-062), and the footer with the row count and Load more / Load all.
 */
export function ResultGrid(props: ResultGridProps) {
  // A new result is a new grid: selection, widths and caches start over.
  return <ResultGridView key={props.resultId} {...props} />;
}

import { useMemo } from 'react';

import type { Engine } from '../../ipc';
import matchStyles from './MatchText.module.css';
import { HIGHLIGHT_CHARS, highlightRuns, mergePieces } from './historyHighlight';
import { matchRanges } from './historyModel';

/**
 * The start of a statement coloured like its editor (the engine's language), with the words the
 * search matched emphasized on top. Static spans: no editor per row.
 */
export function HighlightedText({
  text,
  engine,
  search,
}: {
  text: string;
  engine: Engine;
  search: string;
}) {
  const truncated = text.length > HIGHLIGHT_CHARS;
  const pieces = useMemo(() => {
    const head = truncated ? text.slice(0, HIGHLIGHT_CHARS) : text;
    return mergePieces(head, highlightRuns(engine, head), matchRanges(head, search));
  }, [text, engine, search, truncated]);
  return (
    <>
      {pieces.map((piece, index) =>
        piece.match ? (
          // The match colour replaces the syntax one: a hit stays visible in any token.
          <mark key={index} className={matchStyles.mark}>
            {piece.text}
          </mark>
        ) : (
          <span key={index} className={piece.className ?? undefined}>
            {piece.text}
          </span>
        ),
      )}
      {truncated && '…'}
    </>
  );
}

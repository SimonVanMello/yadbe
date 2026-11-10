import { useMemo } from 'react';

import styles from './MatchText.module.css';
import { matchRanges, splitByRanges } from './historyModel';

/** `text` with the words the search matched emphasized. */
export function MatchText({ text, search }: { text: string; search: string }) {
  const parts = useMemo(() => splitByRanges(text, matchRanges(text, search)), [text, search]);
  if (parts.length <= 1 && !parts[0]?.match) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

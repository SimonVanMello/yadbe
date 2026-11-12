import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

import { useT } from '../../i18n/useT';
import type { ScriptMessage } from '../../ipc';
import styles from './ScriptConsole.module.css';

const LINE_ESTIMATE = 22;

/**
 * What a script printed (`print`, `printjson`, `console.*`) and what its shell commands
 * answered, in order. Virtualized: a script may print thousands of lines.
 */
export function ScriptMessages({
  messages,
  truncated,
}: {
  messages: readonly ScriptMessage[];
  truncated: boolean;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_ESTIMATE,
    overscan: 16,
  });
  if (messages.length === 0) {
    return <p className={styles.empty}>{t('mongo.script.noMessages')}</p>;
  }
  return (
    <div
      ref={scrollRef}
      className={styles.messages}
      role="log"
      aria-label={t('mongo.script.messages')}
      data-testid="script-messages"
    >
      <div className={styles.messageRows} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const message = messages[item.index];
          if (!message) return null;
          return (
            <pre
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              data-kind={message.kind}
              className={styles.message}
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              {message.text}
            </pre>
          );
        })}
      </div>
      {truncated && <p className={styles.truncated}>{t('mongo.script.messagesTruncated')}</p>}
    </div>
  );
}

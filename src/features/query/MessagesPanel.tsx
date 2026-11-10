import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';

import { localize, resolveErrorAction } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { QueryMessage, TextPosition } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { getEditor } from './editorRegistry';
import { jumpTarget } from './errorMarks';
import { isActive, type TabExecution } from './executionModel';
import { oneLine } from './dangerGuard';
import { formatDuration } from './format';
import styles from './MessagesPanel.module.css';

const ESTIMATED_ROW_PX = 32;

/** The message of a run that could not start, shaped like the backend's (it has no `seq`). */
function startFailure(execution: TabExecution): QueryMessage[] {
  return execution.startError
    ? [
        {
          seq: -1,
          statementIndex: null,
          atMs: 0,
          body: { kind: 'error', error: execution.startError, server: null, position: null },
        },
      ]
    : [];
}

interface MessagesPanelProps {
  tabId: string;
  execution: TabExecution;
}

/**
 * The Messages sub-tab (F-061): what each statement did (rows affected, timings), what the
 * server said (notices, `PRINT`, warnings) and the errors, with their position. Clicking an
 * error puts the cursor where the server located it in the editor.
 */
export function MessagesPanel({ tabId, execution }: MessagesPanelProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => [...execution.messages, ...startFailure(execution)], [execution]);
  const running = isActive(execution.status);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 8,
    getItemKey: (index) => rows[index]?.seq ?? index,
  });

  // Follow the tail while the run produces messages (a loop of `RAISE NOTICE`).
  const count = rows.length;
  useEffect(() => {
    if (running && count > 0) virtualizer.scrollToIndex(count - 1, { align: 'end' });
  }, [running, count, virtualizer]);

  if (rows.length === 0) {
    return (
      <p className={styles.empty}>
        {running ? t('query.messages.waiting') : t('query.messages.empty')}
      </p>
    );
  }

  return (
    <div
      ref={scroller}
      className={styles.scroller}
      role="log"
      aria-label={t('query.messages.label')}
      tabIndex={0}
    >
      <div className={styles.list} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const message = rows[item.index];
          if (!message) return null;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={styles.slot}
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              <MessageRow tabId={tabId} message={message} execution={execution} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function positionText(
  t: ReturnType<typeof useT>,
  position: TextPosition | null,
  statement: number | null,
): string | null {
  if (position)
    return t('query.messages.position', { line: position.line, column: position.column });
  return statement === null ? null : t('query.messages.atStatement', { number: statement + 1 });
}

function MessageRow({
  tabId,
  message,
  execution,
}: {
  tabId: string;
  message: QueryMessage;
  execution: TabExecution;
}) {
  const t = useT();
  const { body, statementIndex } = message;
  const statementRange = statementIndex === null ? undefined : execution.statements[statementIndex];
  const statementText =
    statementRange && execution.sourceText !== null
      ? oneLine(execution.sourceText.slice(statementRange.from, statementRange.to), 120)
      : null;
  const label =
    statementIndex === null ? null : t('query.messages.statement', { number: statementIndex + 1 });
  const time = message.seq >= 0 ? formatDuration(message.atMs) : null;

  if (body.kind === 'error') {
    const target = jumpTarget(message, execution.statements);
    const where = positionText(t, body.position, statementIndex);
    const serverText = body.server?.message;
    const mine = localize(body.error.message);
    // Only what needs no handler of ours (editing the connection) is offered here.
    const action = resolveErrorAction(body.error.action, {
      connectionId: execution.connectionId ?? undefined,
    });
    return (
      <div className={styles.row} data-kind="error" data-testid="message-error">
        <Icon name="error" className={styles.icon} />
        <div className={styles.content}>
          <p className={styles.text}>
            {label && <span className={styles.label}>{label}</span>}
            {serverText && serverText !== mine ? serverText : mine}
          </p>
          {serverText && serverText !== mine && <p className={styles.sub}>{mine}</p>}
          {body.server?.detail && <p className={styles.sub}>{body.server.detail}</p>}
          {body.server?.hint && (
            <p className={styles.sub}>
              {t('query.messages.hint')} {body.server.hint}
            </p>
          )}
          {body.error.detail && !body.server && <p className={styles.sub}>{body.error.detail}</p>}
          {statementText && <code className={styles.statement}>{statementText}</code>}
          {action && (
            <Button size="sm" onClick={action.run}>
              {action.label}
            </Button>
          )}
        </div>
        {target !== null && where && (
          <button
            type="button"
            className={styles.jump}
            onClick={() => {
              getEditor(tabId)?.jumpTo(target);
            }}
          >
            {where}
          </button>
        )}
        {time && <span className={styles.time}>{time}</span>}
      </div>
    );
  }

  if (body.kind === 'notice') {
    const warning = /^(warning|warn)/i.test(body.severity);
    return (
      <div className={styles.row} data-kind={warning ? 'warning' : 'notice'}>
        <Icon name={warning ? 'warning' : 'info'} className={styles.icon} />
        <div className={styles.content}>
          <p className={styles.text}>
            <span className={styles.severity}>{body.severity}</span>
            {body.message}
          </p>
          {body.detail && <p className={styles.sub}>{body.detail}</p>}
          {body.hint && (
            <p className={styles.sub}>
              {t('query.messages.hint')} {body.hint}
            </p>
          )}
        </div>
        {time && <span className={styles.time}>{time}</span>}
      </div>
    );
  }

  const summary =
    body.rowsAffected !== null
      ? t('query.messages.affected', { count: body.rowsAffected })
      : body.rowsReturned !== null
        ? t('query.messages.returned', { count: body.rowsReturned })
        : t('query.messages.completed');
  return (
    <div className={styles.row} data-kind="completed">
      <Icon name="check" className={styles.icon} />
      <div className={styles.content}>
        <p className={styles.text}>
          {label && <span className={styles.label}>{label}</span>}
          {summary}
          {body.durationMs !== null && (
            <span className={styles.duration}> · {formatDuration(body.durationMs)}</span>
          )}
        </p>
        {statementText && <code className={styles.statement}>{statementText}</code>}
      </div>
      {time && <span className={styles.time}>{time}</span>}
    </div>
  );
}

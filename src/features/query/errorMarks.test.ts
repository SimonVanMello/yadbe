import { describe, expect, it } from 'vitest';

import type { QueryMessage, YadbeError } from '../../ipc';
import { IDLE_EXECUTION, type TabExecution } from './executionModel';
import { errorMarks, errorRange, jumpTarget } from './errorMarks';

const error: YadbeError = {
  code: 'queryFailed',
  message: { en: 'The database rejected the statement.', fr: 'Le serveur a refusé.' },
  action: null,
  detail: null,
};

function failure(seq: number, offset: number | null, statementIndex: number | null): QueryMessage {
  return {
    seq,
    statementIndex,
    atMs: 12,
    body: {
      kind: 'error',
      error,
      server: null,
      position: offset === null ? null : { offset, line: 1, column: offset + 1 },
    },
  };
}

describe('errorRange', () => {
  const sql = 'select * from nowhere where "Order Id" = 1';

  it('underlines the word at the position', () => {
    expect(errorRange(sql, 14)).toEqual({ from: 14, to: 21 });
  });

  it('underlines a quoted name whole', () => {
    expect(errorRange(sql, sql.indexOf('"'))).toEqual({ from: 28, to: 38 });
  });

  it('takes one character when the position is on punctuation', () => {
    expect(errorRange('select (1', 7)).toEqual({ from: 7, to: 8 });
  });

  it('stays inside the text', () => {
    expect(errorRange('select', 99)).toEqual({ from: 5, to: 6 });
    expect(errorRange('', 3)).toEqual({ from: 0, to: 0 });
  });

  it('handles accented identifiers', () => {
    expect(errorRange('select état from t', 7)).toEqual({ from: 7, to: 11 });
  });
});

describe('errorMarks and jumpTarget', () => {
  const text = 'select 1;\nselect * from nowhere;';
  const execution: TabExecution = {
    ...IDLE_EXECUTION,
    executionId: 1,
    status: 'failed',
    sourceText: text,
    statements: [
      { from: 0, to: 8 },
      { from: 10, to: 31 },
    ],
    messages: [
      {
        seq: 0,
        statementIndex: 0,
        atMs: 1,
        body: {
          kind: 'statementCompleted',
          durationMs: 1,
          rowsAffected: null,
          rowsReturned: 1,
          resultId: 1,
        },
      },
      failure(1, 24, 1),
      failure(2, null, 1),
    ],
  };

  it('marks the errors that have a position', () => {
    expect(errorMarks(execution)).toEqual([{ seq: 1, from: 24, to: 31 }]);
  });

  it('marks nothing without the text the positions refer to', () => {
    expect(errorMarks({ ...execution, sourceText: null })).toEqual([]);
  });

  it('jumps to the position, else to the start of the statement, else nowhere', () => {
    const [, positioned, bare] = execution.messages;
    expect(jumpTarget(positioned as QueryMessage, execution.statements)).toBe(24);
    expect(jumpTarget(bare as QueryMessage, execution.statements)).toBe(10);
    expect(jumpTarget(failure(3, null, null), execution.statements)).toBeNull();
    expect(jumpTarget(execution.messages[0] as QueryMessage, execution.statements)).toBeNull();
  });
});

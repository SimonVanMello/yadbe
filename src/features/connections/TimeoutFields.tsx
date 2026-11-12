import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Field } from '../../ui/Field';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import type { ConnectionDraft } from './model';

interface TimeoutFieldsProps {
  draft: ConnectionDraft;
  /** A file engine has nothing to connect to or keep open: only the statement limit applies. */
  fileEngine: boolean;
  onChange: (patch: Partial<ConnectionDraft>) => void;
}

/** Connect timeout, statement timeout and keep-alive of a connection (F-014), in seconds. */
export function TimeoutFields({ draft, fileEngine, onChange }: TimeoutFieldsProps) {
  const t = useT();
  const id = useId();
  const number = (
    key: 'connectTimeout' | 'statementTimeout' | 'keepAlive',
    label: Parameters<typeof t>[0],
    hint: Parameters<typeof t>[0],
    placeholder: string,
    min: number,
    max: number,
  ) => (
    <Field label={t(label)} htmlFor={`${id}-${key}`} hint={t(hint)}>
      <TextInput
        id={`${id}-${key}`}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft[key]}
        placeholder={placeholder}
        onChange={(event) => {
          onChange({ [key]: event.target.value });
        }}
      />
    </Field>
  );
  return (
    <fieldset className={styles.timeouts} data-testid="timeout-fields">
      <legend className={styles.legend}>{t('connection.timeouts')}</legend>
      <div className={styles.timeoutRow}>
        {!fileEngine &&
          number(
            'connectTimeout',
            'connection.timeouts.connect',
            'connection.timeouts.connectHint',
            t('connection.timeouts.default', { seconds: 15 }),
            1,
            600,
          )}
        {number(
          'statementTimeout',
          'connection.timeouts.statement',
          'connection.timeouts.statementHint',
          t('connection.timeouts.none'),
          0,
          86_400,
        )}
        {!fileEngine &&
          number(
            'keepAlive',
            'connection.timeouts.keepAlive',
            'connection.timeouts.keepAliveHint',
            t('connection.timeouts.default', { seconds: 60 }),
            0,
            3_600,
          )}
      </div>
    </fieldset>
  );
}

import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { TextInput } from '../../ui/TextInput';
import styles from './ConnectionForm.module.css';
import type { ConnectionDraft, DraftErrors } from './model';

interface SqliteFieldsProps {
  draft: ConnectionDraft;
  errors: DraftErrors;
  onChange: (patch: Partial<ConnectionDraft>) => void;
  /** Opens the native file picker (the path can also be typed, e.g. for a new file). */
  onPickFile: () => void;
}

/** Field of a file database (SQLite): the path of the file (F-001, F-002). */
export function SqliteFields({ draft, errors, onChange, onPickFile }: SqliteFieldsProps) {
  const t = useT();
  const id = useId();
  return (
    <Field
      label={t('connection.file')}
      htmlFor={`${id}-file`}
      hint={t('connection.file.hint')}
      error={errors.filePath ? t('connection.error.fileRequired') : undefined}
    >
      <div className={styles.fileRow}>
        <TextInput
          id={`${id}-file`}
          data-field="file"
          mono
          value={draft.filePath}
          invalid={errors.filePath !== undefined}
          placeholder="/path/to/database.sqlite"
          onChange={(event) => {
            onChange({ filePath: event.target.value });
          }}
        />
        <Button onClick={onPickFile}>
          <Icon name="folderOpen" />
          {t('connection.file.browse')}
        </Button>
      </div>
    </Field>
  );
}

import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/i18n';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Select } from '../../ui/Select';
import { TextArea } from '../../ui/TextArea';
import { TextInput } from '../../ui/TextInput';
import { parseJson } from '../grid/jsonTree';
import { closeForm, stageField, stageJson } from './docEditActions';
import {
  editorText,
  FIELD_TYPES,
  fieldTypeOf,
  pathText,
  typedValue,
  type FieldType,
} from './docEditModel';
import { useDocEditStore, type DocFieldForm, type DocJsonForm } from './docEditStore';
import styles from './DocEdit.module.css';
import { ejsonDocument } from './ejsonView';

/** A value as the documents view writes it (`5`, `ObjectId('…')`, a document's JSON). */
function shownValue(text: string): string {
  const node = ejsonDocument(text);
  return node.type === 'scalar' ? node.text : text;
}

/** Renders the open field or JSON editor of document edits (M4-4). Mount once. */
export function DocFormDialog() {
  const form = useDocEditStore((state) => state.form);
  if (!form) return null;
  return form.kind === 'field' ? <FieldForm form={form} /> : <JsonForm form={form} />;
}

function FieldForm({ form }: { form: DocFieldForm }) {
  const t = useT();
  const id = useId();
  const node = form.current === null ? undefined : parseJson(form.current);
  const [type, setType] = useState<FieldType>(() => fieldTypeOf(node));
  const [value, setValue] = useState(() => editorText(node, fieldTypeOf(node)));
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = typedValue(type, value);
  const nameError =
    form.adding &&
    (name.trim() === '' || name.includes('.') || name.startsWith('$') || name === '_id');
  const where = pathText(form.path);

  const submit = () => {
    setTouched(true);
    if (!parsed.ok || nameError) return;
    const path = form.adding ? [...form.path, name.trim()] : form.path;
    if (stageField(form.tabId, form.target, path, parsed.json)) closeForm();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeForm();
      }}
      title={
        form.adding ? t('mongo.edit.addFieldTitle') : t('mongo.edit.fieldTitle', { path: where })
      }
      description={
        form.adding && where !== ''
          ? t('mongo.edit.addFieldInside', { path: where })
          : t('mongo.edit.fieldDescription')
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeForm}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={touched && (!parsed.ok || nameError)}
          >
            <Icon name="check" />
            {t('mongo.edit.stage')}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        data-testid="doc-field-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {form.adding && (
          <Field
            label={t('mongo.edit.fieldName')}
            htmlFor={`${id}-name`}
            error={touched && nameError ? t('mongo.edit.invalid.name') : undefined}
          >
            <TextInput
              id={`${id}-name`}
              mono
              autoFocus
              value={name}
              invalid={touched && nameError}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
        )}
        <Field label={t('mongo.edit.type')} htmlFor={`${id}-type`}>
          <Select
            id={`${id}-type`}
            value={type}
            options={FIELD_TYPES.map((value) => ({
              value,
              label: t(`mongo.edit.types.${value}` as MessageKey),
            }))}
            onChange={(next) => {
              // The text follows when it still reads as the new type (5 → 5.0 stays 5).
              if (next === 'bool' && value !== 'true') setValue('false');
              if (next === 'json' && !typedValue('json', value).ok) setValue(JSON.stringify(value));
              setType(next);
            }}
          />
        </Field>
        {type !== 'null' && (
          <Field
            label={t('mongo.edit.value')}
            htmlFor={`${id}-value`}
            hint={t(`mongo.edit.hint.${type}` as MessageKey)}
            error={touched && !parsed.ok ? t(parsed.error as MessageKey) : undefined}
          >
            {type === 'bool' ? (
              <Select
                id={`${id}-value`}
                value={value === 'true' ? 'true' : 'false'}
                options={[
                  { value: 'true', label: 'true' },
                  { value: 'false', label: 'false' },
                ]}
                onChange={setValue}
              />
            ) : type === 'string' || type === 'json' ? (
              <TextArea
                id={`${id}-value`}
                mono
                rows={type === 'json' ? 8 : 3}
                autoFocus={!form.adding}
                value={value}
                invalid={touched && !parsed.ok}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            ) : (
              <TextInput
                id={`${id}-value`}
                mono
                autoFocus={!form.adding}
                value={value}
                invalid={touched && !parsed.ok}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            )}
          </Field>
        )}
        {form.current !== null && (
          <p className={styles.note}>{t('mongo.edit.was', { value: shownValue(form.current) })}</p>
        )}
      </form>
    </Dialog>
  );
}

function JsonForm({ form }: { form: DocJsonForm }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(form.text);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      const node = parseJson(text);
      if (form.mode !== 'value' && node.type !== 'object') {
        setError(t('mongo.edit.invalid.document'));
        return;
      }
      if (stageJson({ ...form, text })) closeForm();
    } catch {
      setError(t('mongo.edit.invalid.json'));
    }
  };

  const title =
    form.mode === 'insert'
      ? form.insertKey === null
        ? t('mongo.edit.insertTitle')
        : t('mongo.edit.insertAgainTitle')
      : form.mode === 'replace'
        ? t('mongo.edit.replaceTitle')
        : t('mongo.edit.fieldTitle', { path: pathText(form.path) });

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeForm();
      }}
      title={title}
      description={
        form.mode === 'insert'
          ? t('mongo.edit.insertDescription')
          : form.mode === 'replace'
            ? t('mongo.edit.replaceDescription')
            : t('mongo.edit.valueDescription')
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeForm}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit}>
            <Icon name="check" />
            {t('mongo.edit.stage')}
          </Button>
        </>
      }
    >
      <div className={styles.form} data-testid="doc-json-form">
        <Field
          label={t('mongo.edit.json')}
          htmlFor={`${id}-json`}
          hint={t('mongo.edit.jsonHint')}
          error={error ?? undefined}
        >
          <TextArea
            id={`${id}-json`}
            className={styles.json}
            mono
            rows={16}
            autoFocus
            value={text}
            invalid={error !== null}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}

import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextArea } from '../../ui/TextArea';
import { TextInput } from '../../ui/TextInput';
import styles from './KeyEdit.module.css';
import { useKvFormStore, type KvFormValues } from './kvFormStore';

/** The fields of the pending form; remounted for each request. */
export function KvFormBody() {
  const t = useT();
  const id = useId();
  const pending = useKvFormStore((state) => state.pending);
  const settle = useKvFormStore((state) => state.settle);
  const [values, setValues] = useState<KvFormValues>(() =>
    Object.fromEntries((pending?.fields ?? []).map((f) => [f.name, f.value])),
  );
  const [tried, setTried] = useState(false);
  if (!pending) return null;
  const error = pending.validate?.(values) ?? null;
  const submit = () => {
    setTried(true);
    if (error === null) settle(values);
  };
  const set = (name: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [name]: value }));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
      title={pending.title}
      description={pending.description}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={pending.danger ? 'danger' : 'primary'}
            disabled={tried && error !== null}
            onClick={submit}
          >
            {pending.submitLabel}
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        data-testid="kv-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {pending.fields
          .filter((field) => field.visible?.(values) ?? true)
          .map((field, index) => {
            const fieldId = `${id}-${field.name}`;
            const value = values[field.name];
            switch (field.kind) {
              case 'switch':
                return (
                  <Switch
                    key={field.name}
                    checked={value === true}
                    onCheckedChange={(checked) => {
                      set(field.name, checked);
                    }}
                    label={field.label}
                    hint={field.hint}
                  />
                );
              case 'select':
                return (
                  <Field key={field.name} label={field.label} htmlFor={fieldId} hint={field.hint}>
                    <Select<string>
                      id={fieldId}
                      value={typeof value === 'string' ? value : ''}
                      options={field.options ?? []}
                      onChange={(next) => {
                        set(field.name, next);
                      }}
                    />
                  </Field>
                );
              case 'textarea':
                return (
                  <Field key={field.name} label={field.label} htmlFor={fieldId} hint={field.hint}>
                    <TextArea
                      id={fieldId}
                      mono={field.mono}
                      rows={6}
                      autoFocus={index === 0}
                      placeholder={field.placeholder}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => {
                        set(field.name, event.target.value);
                      }}
                    />
                  </Field>
                );
              case 'text':
                return (
                  <Field key={field.name} label={field.label} htmlFor={fieldId} hint={field.hint}>
                    <TextInput
                      id={fieldId}
                      mono={field.mono}
                      autoFocus={index === 0}
                      placeholder={field.placeholder}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => {
                        set(field.name, event.target.value);
                      }}
                    />
                  </Field>
                );
            }
          })}
        {tried && error !== null && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

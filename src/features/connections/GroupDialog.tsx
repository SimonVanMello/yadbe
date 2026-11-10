import { useState, type SubmitEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { TextInput } from '../../ui/TextInput';
import { saveGroup } from './groupActions';
import { useGroupDialog, type GroupDialogRequest } from './groupDialogStore';

function GroupForm({ request, onClose }: { request: GroupDialogRequest; onClose: () => void }) {
  const t = useT();
  const { group } = request;
  const [name, setName] = useState(group?.name ?? '');
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!trimmed || saving) return;
    setSaving(true);
    void saveGroup(trimmed, request).then((saved) => {
      setSaving(false);
      if (saved) onClose();
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={group ? t('group.rename.title') : t('group.new.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="group-form" disabled={!trimmed || saving}>
            {group ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit}>
        <Field label={t('group.name')} htmlFor="group-name">
          <TextInput
            id="group-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Create / rename dialog of a folder of connections (F-007). Mount once at the app root. */
export function GroupDialog() {
  const request = useGroupDialog((state) => state.request);
  const close = useGroupDialog((state) => state.close);
  if (!request) return null;
  return (
    <GroupForm
      key={request.group?.id ?? request.parentId ?? 'new'}
      request={request}
      onClose={close}
    />
  );
}

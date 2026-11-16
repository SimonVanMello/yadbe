import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Field } from '../../ui/Field';
import { Disclosure } from '../../ui/Disclosure';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './SshFields.module.css';
import { SshHopFields } from './SshHopFields';
import {
  describeTunnel,
  secretKindOf,
  toSshTunnel,
  type SshDraft,
  type SshDraftErrors,
  type SshHopDraft,
  type SshHopName,
  type SshSecretLocations,
} from './sshModel';

interface SshFieldsProps {
  ssh: SshDraft;
  errors: SshDraftErrors;
  secretLocations: SshSecretLocations;
  keychainAvailable: boolean;
  onChange: (ssh: SshDraft) => void;
  onPickKey: (hop: SshHopName) => void;
}

/** The `data-field` names of the SSH section, to open it on demand. */
const SSH_FIELDS = (['server', 'jump'] as const).flatMap((hop) =>
  ['host', 'user', 'key', 'secret'].map((field) => `ssh-${hop}-${field}`),
);

/** The "SSH tunnel" section of the connection form (F-010), closed until opened. */
export function SshFields({
  ssh,
  errors,
  secretLocations,
  keychainAvailable,
  onChange,
  onPickKey,
}: SshFieldsProps) {
  const t = useT();
  const id = useId();
  // An endpoint still being typed (no host yet) reads "On" rather than "@:22".
  const summary = !ssh.enabled
    ? t('connection.ssh.off')
    : ssh.server.host.trim() === ''
      ? t('connection.section.on')
      : (describeTunnel(toSshTunnel(ssh)) ?? t('connection.section.on'));

  const patchHop = (name: SshHopName) => (patch: Partial<SshHopDraft>) => {
    onChange({ ...ssh, [name]: { ...ssh[name], ...patch } });
  };
  const locationOf = (name: SshHopName, hop: SshHopDraft) => {
    const kind = secretKindOf(name, hop.auth);
    return kind === null ? null : (secretLocations[kind] ?? null);
  };

  return (
    <Disclosure
      title={t('connection.ssh')}
      icon="tunnel"
      summary={<span className={styles.summary}>{summary}</span>}
      summaryText={summary}
      modified={ssh.enabled}
      modifiedLabel={t('connection.section.modified')}
      // A field to fix is never hidden.
      forceOpen={Object.keys(errors).length > 0}
      fields={SSH_FIELDS}
      data-testid="ssh-section"
    >
      <Switch
        checked={ssh.enabled}
        onCheckedChange={(enabled) => {
          onChange({ ...ssh, enabled });
        }}
        label={t('connection.ssh.enable')}
        hint={t('connection.ssh.enable.hint')}
      />
      {ssh.enabled && (
        <>
          <SshHopFields
            name="server"
            hop={ssh.server}
            errors={errors}
            secretLocation={locationOf('server', ssh.server)}
            keychainAvailable={keychainAvailable}
            onChange={patchHop('server')}
            onPickKey={() => {
              onPickKey('server');
            }}
          />
          <Field
            label={t('connection.ssh.keepalive')}
            htmlFor={`${id}-keepalive`}
            hint={t('connection.ssh.keepalive.hint')}
            error={errors.keepalive ? t('connection.ssh.error.keepaliveInvalid') : undefined}
          >
            <TextInput
              id={`${id}-keepalive`}
              className={styles.short}
              mono
              inputMode="numeric"
              placeholder="30"
              value={ssh.keepaliveSecs}
              invalid={errors.keepalive !== undefined}
              onChange={(event) => {
                onChange({ ...ssh, keepaliveSecs: event.target.value });
              }}
            />
          </Field>
          <div className={styles.jump}>
            <Switch
              checked={ssh.jumpEnabled}
              onCheckedChange={(jumpEnabled) => {
                onChange({ ...ssh, jumpEnabled });
              }}
              label={t('connection.ssh.jump.enable')}
              hint={t('connection.ssh.jump.hint')}
            />
            {ssh.jumpEnabled && (
              <div className={styles.jumpBody} role="group" aria-label={t('connection.ssh.jump')}>
                <SshHopFields
                  name="jump"
                  hop={ssh.jump}
                  errors={errors}
                  secretLocation={locationOf('jump', ssh.jump)}
                  keychainAvailable={keychainAvailable}
                  onChange={patchHop('jump')}
                  onPickKey={() => {
                    onPickKey('jump');
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </Disclosure>
  );
}

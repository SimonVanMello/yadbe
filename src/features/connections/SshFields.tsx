import { useId, useState } from 'react';

import { useT } from '../../i18n/useT';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
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

/** The "SSH tunnel" section of the connection form (F-010), collapsed until opened. */
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
  // Collapsed by default; a connection that has a tunnel shows it.
  const [open, setOpen] = useState(ssh.enabled);
  // A field to fix is never hidden.
  const expanded = open || Object.keys(errors).length > 0;
  const summary = ssh.enabled
    ? (describeTunnel(toSshTunnel(ssh)) ?? t('connection.ssh.off'))
    : t('connection.ssh.off');

  const patchHop = (name: SshHopName) => (patch: Partial<SshHopDraft>) => {
    onChange({ ...ssh, [name]: { ...ssh[name], ...patch } });
  };
  const locationOf = (name: SshHopName, hop: SshHopDraft) => {
    const kind = secretKindOf(name, hop.auth);
    return kind === null ? null : (secretLocations[kind] ?? null);
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <button
        type="button"
        id={`${id}-title`}
        className={styles.header}
        aria-expanded={expanded}
        aria-controls={`${id}-body`}
        onClick={() => {
          setOpen(!expanded);
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
        <Icon name="tunnel" />
        <span className={styles.title}>{t('connection.ssh')}</span>
        <span className={styles.summary} data-enabled={ssh.enabled || undefined}>
          {summary}
        </span>
      </button>
      {expanded && (
        <div id={`${id}-body`} className={styles.body}>
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
                  <div
                    className={styles.jumpBody}
                    role="group"
                    aria-label={t('connection.ssh.jump')}
                  >
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
        </div>
      )}
    </section>
  );
}

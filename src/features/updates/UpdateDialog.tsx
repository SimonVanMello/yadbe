import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { InstallChannel, UpdateInfo } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import {
  copyUpgradeCommand,
  installUpdate,
  openReleasePage,
  preparePackageUpgrade,
  restartApp,
} from './updates';
import styles from './UpdateDialog.module.css';
import { closeUpdate, updateBusy, useUpdateStore, type UpdatePhase } from './updateStore';

/** A release date in the UI language, `null` when the manifest has none or a broken one. */
function publishedOn(date: string | null, locale: string): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(parsed);
}

/** Notes that are not just the address of the release page: shown as they are. */
function notesText(notes: string | null): string | null {
  if (!notes) return null;
  const text = notes.trim();
  return /^https:\/\/\S+$/.test(text) ? null : text;
}

function isPackageChannel(channel: InstallChannel): boolean {
  return channel === 'deb' || channel === 'rpm' || channel === 'aur';
}

/**
 * A newer version (F-127): version, date and notes, then how this copy gets it: the updater
 * downloads, verifies and installs it and restarts; a package-manager copy gets its checked
 * package and the command to run; anything else, the release page.
 */
export function UpdateDialog() {
  const t = useT();
  const update = useUpdateStore((state) => state.update);
  const phase = useUpdateStore((state) => state.phase);
  const locale = useI18nStore((state) => state.locale);
  if (!update) return null;
  const busy = updateBusy(phase);
  const date = publishedOn(update.date, locale);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeUpdate();
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      title={t('updates.available', { version: update.version })}
      description={
        date
          ? t('updates.dated', { date, current: update.currentVersion })
          : t('updates.notice', { current: update.currentVersion })
      }
      footer={<Footer update={update} phase={phase} />}
    >
      <div className={styles.body}>
        <Notes notes={notesText(update.notes)} />
        <p className={styles.channel}>{t(`updates.channel.${update.channel}`)}</p>
        <PhaseView phase={phase} />
      </div>
    </Dialog>
  );
}

function Notes({ notes }: { notes: string | null }) {
  const t = useT();
  return (
    <div className={styles.notes}>
      {notes && <pre className={styles.notesText}>{notes}</pre>}
      <Button size="sm" variant="ghost" onClick={() => void openReleasePage()}>
        <Icon name="external" size="sm" />
        {t('updates.notes')}
      </Button>
    </div>
  );
}

function PhaseView({ phase }: { phase: UpdatePhase }) {
  const t = useT();
  switch (phase.kind) {
    case 'offer':
      return null;
    case 'downloading':
      return (
        <div className={styles.progress} role="status">
          <span>
            {phase.percent === null
              ? t('updates.starting')
              : t('updates.downloading', { percent: phase.percent })}
          </span>
          <progress
            className={styles.bar}
            max={100}
            {...(phase.percent === null ? {} : { value: phase.percent })}
            aria-label={t('updates.progressLabel')}
          />
        </div>
      );
    case 'restarting':
      return (
        <p className={styles.progress} role="status">
          {t('updates.restarting')}
        </p>
      );
    case 'ready':
      return (
        <div className={styles.ready}>
          <span className={styles.label}>{t('updates.command.label')}</span>
          <div className={styles.command}>
            <code className={styles.code} data-testid="upgrade-command">
              {phase.upgrade.command}
            </code>
            <Button
              size="sm"
              onClick={() => void copyUpgradeCommand(phase.upgrade.command)}
              aria-label={t('updates.copy')}
            >
              <Icon name="copy" size="sm" />
              {t('updates.copy')}
            </Button>
          </div>
          {phase.upgrade.package && (
            <span className={styles.hint}>
              {t('updates.command.checked', { path: phase.upgrade.package })}
            </span>
          )}
          <span className={styles.hint}>{t('updates.command.hint')}</span>
        </div>
      );
    case 'failed':
      return <ErrorPanel compact title={t('updates.failed')} error={phase.error} />;
  }
}

function Footer({ update, phase }: { update: UpdateInfo; phase: UpdatePhase }) {
  const t = useT();
  const busy = updateBusy(phase);
  const later = (
    <Button variant="ghost" disabled={busy} onClick={closeUpdate}>
      {t(phase.kind === 'offer' ? 'updates.later' : 'common.close')}
    </Button>
  );
  const start = () => {
    if (update.channel === 'selfUpdate') void installUpdate();
    else if (isPackageChannel(update.channel)) void preparePackageUpgrade();
    else void openReleasePage();
  };
  if (phase.kind === 'failed') {
    return (
      <>
        {later}
        <Button variant="primary" onClick={start}>
          {t('error.action.retry')}
        </Button>
      </>
    );
  }
  if (phase.kind === 'ready') {
    return (
      <>
        {later}
        <Button variant="primary" onClick={restartApp}>
          {t('updates.restart')}
        </Button>
      </>
    );
  }
  const label =
    update.channel === 'selfUpdate'
      ? 'updates.install'
      : update.channel === 'aur'
        ? 'updates.showCommand'
        : isPackageChannel(update.channel)
          ? 'updates.download'
          : 'updates.releasePage';
  return (
    <>
      {later}
      <Button variant="primary" disabled={busy} autoFocus onClick={start}>
        {t(label)}
      </Button>
    </>
  );
}

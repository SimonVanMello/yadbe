import { useState } from 'react';

import { AppearanceControls } from '../../app/AppearanceControls';
import { useAppInfo } from '../../app/useAppInfo';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { MenuLabel } from '../../ui/MenuLabel';
import { MenuSeparator } from '../../ui/MenuSeparator';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { DemoSection } from './DemoSection';
import styles from './PrimitivesDemo.module.css';
import { ShortcutList } from './ShortcutList';

/** Unbreakable string longer than a tooltip's max width: it must wrap inside the box. */
const LONG_NAME = 'public.nyx_rest_acme_external_integration_service_audit_log_partitioned_2026';

const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
const CELL_STATES = ['modified', 'inserted', 'deleted', 'null'] as const;

/** Showcase of the `ui/` primitives and of the yadbe tokens, for visual tests. */
export function PrimitivesDemo() {
  const t = useT();
  const appInfo = useAppInfo();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(true);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>{t('demo.title')}</h1>
          <p className={styles.subtitle}>{t('demo.subtitle')}</p>
        </div>
        <div className={styles.settings}>
          <AppearanceControls />
          <a className={styles.back} href="#">
            {t('app.back')}
          </a>
        </div>
      </header>

      <main className={styles.content}>
        <p className={styles.appInfo} data-testid="app-info">
          {appInfo.data
            ? t('app.version', {
                appVersion: appInfo.data.appVersion,
                os: appInfo.data.os,
                arch: appInfo.data.arch,
              })
            : t('app.loading')}
        </p>

        <DemoSection title={t('demo.section.buttons')}>
          <Button variant="primary">
            <Icon name="play" />
            {t('demo.button.primary')}
          </Button>
          <Button variant="secondary">{t('demo.button.secondary')}</Button>
          <Button variant="ghost">{t('demo.button.ghost')}</Button>
          <Button variant="danger">{t('demo.button.danger')}</Button>
          <Button variant="primary" disabled>
            {t('demo.button.disabled')}
          </Button>
          <Button variant="secondary" size="sm">
            {t('demo.button.small')}
          </Button>
        </DemoSection>

        <DemoSection title={t('demo.section.iconButtons')}>
          <IconButton icon="play" label={t('demo.icon.run')} shortcut="Mod+Enter" />
          <IconButton icon="retry" label={t('demo.icon.refresh')} shortcut="Mod+R" />
          <IconButton icon="check" label={t('demo.icon.save')} shortcut="Mod+S" />
          <IconButton icon="database" label={t('demo.icon.database')} />
          <IconButton icon="settings" label={t('demo.icon.settings')} aria-pressed />
          <IconButton icon="trash" label={t('demo.button.danger')} size="sm" disabled />
          <IconButton icon="table" label={LONG_NAME} shortcut="Mod+Shift+O" />
        </DemoSection>

        <DemoSection title={t('demo.section.kbd')}>
          <ShortcutList />
        </DemoSection>

        <DemoSection title={t('demo.section.fields')}>
          <Field label={t('demo.field.label')} htmlFor="demo-host" hint={t('demo.field.hint')}>
            <TextInput id="demo-host" mono placeholder={t('demo.field.placeholder')} />
          </Field>
          <Switch label={t('demo.switch.label')} checked={readOnly} onCheckedChange={setReadOnly} />
          <span className={styles.spinner}>
            <Spinner />
            {t('demo.spinner.label')}
          </span>
        </DemoSection>

        <DemoSection title={t('demo.section.overlays')}>
          <Menu
            trigger={
              <Button variant="secondary">
                {t('demo.menu.open')}
                <Icon name="chevronDown" />
              </Button>
            }
          >
            <MenuLabel>{t('demo.menu.label')}</MenuLabel>
            <MenuItem icon="table" hint="SELECT TOP 1000 * FROM orders" shortcut="Mod+Enter">
              {t('demo.menu.select')}
            </MenuItem>
            <MenuItem icon="copy">{t('demo.menu.copy')}</MenuItem>
            <MenuItem icon="minus" disabled>
              {t('demo.menu.truncate')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" danger>
              {t('demo.menu.drop')}
            </MenuItem>
          </Menu>

          <ContextMenu
            content={
              <>
                <ContextMenuItem icon="copy">{t('demo.menu.copy')}</ContextMenuItem>
                <ContextMenuItem icon="trash" danger>
                  {t('demo.menu.drop')}
                </ContextMenuItem>
              </>
            }
          >
            <div className={styles.contextArea}>{t('demo.context.area')}</div>
          </ContextMenu>

          <Button
            variant="secondary"
            onClick={() => {
              setDialogOpen(true);
            }}
          >
            {t('demo.dialog.open')}
          </Button>
          <Dialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            title={t('demo.dialog.title')}
            description={t('demo.dialog.description')}
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setDialogOpen(false);
                  }}
                >
                  {t('demo.dialog.confirm')}
                </Button>
              </>
            }
          />

          <Button
            variant="secondary"
            onClick={() => {
              toast({
                variant: 'success',
                title: t('demo.toast.title'),
                description: t('demo.toast.description'),
              });
            }}
          >
            {t('demo.toast.open')}
          </Button>
        </DemoSection>

        <DemoSection title={t('demo.section.tokens')}>
          <div className={styles.chips}>
            {ENVIRONMENTS.map((env) => (
              <span key={env} className={`${styles.chip} ${styles[env]}`} data-env={env}>
                {t(`demo.env.${env}`)}
              </span>
            ))}
          </div>
          <div className={styles.chips}>
            {CELL_STATES.map((state) => (
              <span key={state} className={`${styles.cell} ${styles[state]}`} data-cell={state}>
                {t(`demo.cell.${state}`)}
              </span>
            ))}
          </div>
        </DemoSection>
      </main>
    </div>
  );
}

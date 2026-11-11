import { useEffect, useId, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import {
  YadbeIpcError,
  type ObjectActionPlan,
  type ObjectActionRequest,
  type YadbeError,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { toast } from '../../ui/toastStore';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection, useEngineInfo } from '../connections/connectionStore';
import { KIND_ICONS } from '../explorer/explorerLabels';
import { SqlView } from '../table-data/SqlView';
import { tableLabel } from '../table-data/tableNames';
import styles from './ObjectActionDialog.module.css';
import { afterObjectAction } from './objectActions';
import { useObjectActionStore } from './objectActionStore';
import { planAction, runAction } from './objectsApi';
import { dependencyKey, nameConfirmed, needsTypedName, toolKindKey } from './objectsModel';

type Plan =
  | { status: 'loading' }
  | { status: 'ready'; plan: ObjectActionPlan }
  | { status: 'failed'; error: YadbeError };

function asError(error: unknown): YadbeError {
  return error instanceof YadbeIpcError
    ? error.error
    : {
        code: 'internal',
        message: { en: String(error), fr: String(error) },
        action: null,
        detail: null,
      };
}

/**
 * The confirmation of a drop, truncate or rename (F-026): the exact statement, what it affects
 * (rows, what depends on the object) and, on a production connection, the object's name to type.
 * Nothing runs before the button; `CASCADE` is never implied.
 */
export function ObjectActionDialog() {
  const pending = useObjectActionStore((state) => state.pending);
  if (!pending) return null;
  return (
    <ConfirmAction
      key={JSON.stringify(pending.request)}
      connectionId={pending.connectionId}
      request={pending.request}
    />
  );
}

function ConfirmAction({
  connectionId,
  request,
}: {
  connectionId: string;
  request: ObjectActionRequest;
}) {
  const t = useT();
  const inputId = useId();
  const connection = useConnection(connectionId);
  const engine = useEngineInfo(connection?.engine ?? null);
  const [plan, setPlan] = useState<Plan>({ status: 'loading' });
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<YadbeError | null>(null);
  const [typed, setTyped] = useState('');
  const { action, object, kind } = request;
  const close = () => {
    useObjectActionStore.getState().close();
  };

  useEffect(() => {
    const controller = new AbortController();
    planAction(connectionId, request, controller.signal).then(
      (result) => {
        setPlan({ status: 'ready', plan: result });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setPlan({ status: 'failed', error: asError(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [connectionId, request]);

  const name = tableLabel(object);
  const typedName = needsTypedName(connection?.environment ?? null, action.type);
  const confirmed = !typedName || nameConfirmed(typed, object.name);
  const ready = plan.status === 'ready';
  const danger = action.type !== 'rename';

  const run = async () => {
    setRunning(true);
    setFailure(null);
    try {
      const outcome = await runAction(connectionId, request);
      afterObjectAction(connectionId, request, outcome);
      toast({
        variant: 'success',
        title: t(`objects.action.done.${action.type}`, {
          name: tableLabel(outcome.renamedTo ?? object),
        }),
      });
      close();
    } catch (error) {
      setRunning(false);
      setFailure(asError(error));
    }
  };

  const effect =
    action.type === 'drop'
      ? t('objects.action.effect.drop', { name })
      : action.type === 'truncate'
        ? t('objects.action.effect.truncate')
        : t('objects.action.effect.rename', { kind: t(toolKindKey(kind)) });

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open && !running) close();
      }}
      title={t(`objects.action.${action.type}.title`, { name })}
      description={effect}
      notice={
        failure ? (
          <span className={styles.failure} role="alert">
            <Icon name="error" />
            {t(`objects.action.failed.${action.type}`, { name })}: {localize(failure.message)}
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" disabled={running} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ready || !confirmed || running}
            onClick={() => {
              void run();
            }}
          >
            {running ? <Spinner /> : <Icon name={danger ? 'trash' : 'pencil'} />}
            {t(`objects.action.${action.type}.confirm`)}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {connection && <ConnectionBanner connection={{ ...connection, database: object.database }} />}
        {plan.status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('objects.action.planning')}
          </div>
        )}
        {plan.status === 'failed' && (
          <p className={styles.error} role="alert">
            {t('objects.action.planFailed')}: {localize(plan.error.message)}
          </p>
        )}
        {plan.status === 'ready' && connection && (
          <>
            <div className={styles.section}>
              <span className={styles.heading}>{t('objects.action.statement')}</span>
              <SqlView
                sql={plan.plan.sql}
                engine={connection.engine}
                label={t('objects.action.statementLabel')}
              />
            </div>
            {plan.plan.rowEstimate !== null && action.type !== 'rename' && (
              <p className={styles.rows} data-testid="action-rows">
                <Icon name="table" />
                {t('objects.action.rows', {
                  count: Math.round(plan.plan.rowEstimate),
                })}
              </p>
            )}
            {action.type !== 'rename' && (
              <div className={styles.section}>
                <span className={styles.heading}>{t('objects.action.dependents')}</span>
                {plan.plan.dependents.items.length > 0 ? (
                  <ul className={styles.dependents} data-testid="action-dependents">
                    {plan.plan.dependents.items.map((dependent, index) => {
                      const key = dependencyKey(dependent.via);
                      return (
                        <li key={index}>
                          <Icon name={KIND_ICONS[dependent.kind]} />
                          <span className={styles.dependentName}>
                            {tableLabel(dependent.object)}
                          </span>
                          {dependent.via && key && (
                            <span className={styles.via}>
                              {t(key, { name: dependent.via.name })}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  plan.plan.dependents.complete && (
                    <p className={styles.muted}>{t('objects.action.dependents.none')}</p>
                  )
                )}
                {!plan.plan.dependents.complete && (
                  <p className={styles.muted}>
                    {t('objects.action.dependents.incomplete', {
                      engine: engine?.label ?? '',
                    })}
                  </p>
                )}
                <p className={styles.muted}>{t('objects.action.noCascade')}</p>
              </div>
            )}
            {typedName && (
              <Field
                label={t('objects.action.typeNameLabel')}
                htmlFor={inputId}
                hint={t('objects.action.typeName')}
              >
                <TextInput
                  id={inputId}
                  mono
                  autoFocus
                  value={typed}
                  placeholder={object.name}
                  invalid={typed !== '' && !confirmed}
                  onChange={(event) => {
                    setTyped(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && confirmed && !running) {
                      event.preventDefault();
                      void run();
                    }
                  }}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

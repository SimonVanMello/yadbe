import { useQuery } from '@tanstack/react-query';

import { localize } from '../../app/errors/presentError';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection } from '../connections/connectionStore';
import { metaKeys } from '../explorer/metaKeys';
import { tableLabel } from '../table-data/tableNames';
import { showObjectDdl } from './ddlActions';
import { fetchProperties } from './objectsApi';
import { factsOf, structureOf, toolKindKey } from './objectsModel';
import styles from './PropertiesDialog.module.css';
import { usePropertiesStore, type PropertiesTarget } from './propertiesStore';

/**
 * The properties of a table or view (F-025): the facts the engine exposes (size, estimate,
 * owner, dates…, the missing ones left out) and a summary of its columns, keys and indexes.
 */
export function PropertiesDialog() {
  const target = usePropertiesStore((state) => state.target);
  if (!target) return null;
  return <Properties key={JSON.stringify(target)} target={target} />;
}

function Properties({ target }: { target: PropertiesTarget }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { connectionId, object, kind } = target;
  const connection = useConnection(connectionId);
  const properties = useQuery({
    queryKey: ['properties', connectionId, object, kind],
    queryFn: ({ signal }) => fetchProperties(connectionId, object, kind, signal),
    gcTime: 0,
    retry: false,
  });
  // The same read as the explorer's: usually already cached.
  const details = useQuery({
    queryKey: metaKeys.table(connectionId, object, kind),
    queryFn: () => unwrap(ipc.commands.getTableDetails(null, connectionId, object)),
    staleTime: Infinity,
  });
  const close = () => {
    usePropertiesStore.getState().close();
  };
  const name = tableLabel(object);
  const facts = properties.data
    ? factsOf(properties.data, locale, (n) => formatNumber(locale, n))
    : [];
  const structure = details.data ? structureOf(details.data) : [];
  const failure = properties.error instanceof YadbeIpcError ? properties.error.error : null;

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t('objects.props.title', { name })}
      description={t('objects.props.description', { name: t(toolKindKey(kind)) })}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              showObjectDdl(connectionId, object, kind);
              close();
            }}
          >
            <Icon name="file" />
            {t('objects.props.showDdl')}
          </Button>
          <Button onClick={close}>{t('common.close')}</Button>
        </>
      }
    >
      <div className={styles.body}>
        {connection && (
          <ConnectionBanner connection={{ ...connection, database: object.database }} />
        )}
        {properties.isPending && (
          <div className={styles.loading}>
            <Spinner />
            {t('objects.props.loading')}
          </div>
        )}
        {properties.isError && (
          <p className={styles.error} role="alert">
            {t('objects.props.failed')}: {failure ? localize(failure.message) : String(properties.error)}
          </p>
        )}
        {properties.data && (
          <section className={styles.section} aria-label={t('objects.props.facts')}>
            <h3 className={styles.heading}>{t('objects.props.facts')}</h3>
            {facts.length > 0 ? (
              <dl className={styles.facts} data-testid="properties-facts">
                {facts.map((fact) => (
                  <div key={fact.key} className={styles.fact}>
                    <dt>{t(fact.key)}</dt>
                    <dd title={fact.hint ? t(fact.hint) : undefined}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={styles.muted}>{t('objects.props.noFacts')}</p>
            )}
          </section>
        )}
        {structure.length > 0 && (
          <section className={styles.section} aria-label={t('objects.props.structure')}>
            <h3 className={styles.heading}>{t('objects.props.structure')}</h3>
            <dl className={styles.facts} data-testid="properties-structure">
              {structure.map((line) => (
                <div key={line.key} className={styles.fact}>
                  <dt>
                    {t(line.key)} <span className={styles.count}>{line.count}</span>
                  </dt>
                  <dd className={styles.names}>{line.names.join(', ')}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Dialog>
  );
}

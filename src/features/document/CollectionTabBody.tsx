import { useEffect, useId, type KeyboardEvent } from 'react';

import { localize } from '../../app/errors/presentError';
import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ObjectRef } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { connectTo } from '../connections/connectionActions';
import { ConnectionChip } from '../connections/ConnectionChip';
import {
  useConnection,
  useConnectionList,
  useConnectionState,
} from '../connections/connectionStore';
import {
  applyQuery,
  cancelCollection,
  countExactly,
  fetchPage,
  openCollection,
  setDraft,
  setPageSize,
} from './collectionActions';
import styles from './CollectionTabBody.module.css';
import {
  PAGE_SIZES,
  useCollectionStore,
  useCollectionTab,
  type DocumentViewMode,
  type QueryFields,
} from './collectionStore';
import { editBlockOf } from './docEditActions';
import { DocEditBar } from './DocEditBar';
import { EditableDocuments } from './EditableDocuments';

/**
 * Body of a collection tab (a table tab of a document connection): filter, projection and sort
 * in Extended JSON, pages that follow `_id`, the estimated count at once and the exact one on
 * request, and the documents as a grid or as trees. A restored tab does not connect by itself.
 */
export function CollectionTabBody({ tab, table }: { tab: ShellTab; table: ObjectRef }) {
  const t = useT();
  const id = useId();
  const locale = useI18nStore((state) => state.locale);
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);
  const collection = useCollectionTab(tab.id);
  const connected = state === 'connected';
  const { phase } = collection;

  useEffect(() => {
    if (!connected) {
      if (useCollectionStore.getState().tabs[tab.id]?.phase === 'ready') {
        useCollectionStore.getState().patch(tab.id, { phase: 'idle' });
      }
      return;
    }
    if (phase === 'idle') void openCollection(tab.id);
  }, [connected, phase, tab.id]);

  const label = `${table.database}.${table.name}`;

  if (!connection) {
    if (list.isPending) {
      return (
        <div className={styles.placeholder}>
          <Spinner />
        </div>
      );
    }
    return (
      <div className={styles.placeholder}>
        <Icon name="warning" size="lg" />
        <p className={styles.title}>{t('tab.body.missing')}</p>
        <Button
          onClick={() => {
            useTabsStore.getState().closeTab(tab.id);
          }}
        >
          {t('tab.menu.close')}
        </Button>
      </div>
    );
  }

  if (!connected && phase !== 'ready') {
    const busy = state === 'connecting' || state === 'reconnecting';
    return (
      <div className={styles.placeholder}>
        <ConnectionChip connection={connection} state={state} size="md" />
        <p className={styles.title}>{label}</p>
        <p className={styles.text}>{t('tableData.connectFirst')}</p>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            void connectTo(connection);
          }}
        >
          {busy ? <Spinner /> : <Icon name="database" />}
          {t('tableData.connect')}
        </Button>
      </div>
    );
  }

  const { info, page, draft, loading, counting, exactCount, error, view } = collection;
  const onField = (field: keyof QueryFields) => (value: string) => {
    setDraft(tab.id, { [field]: value });
  };
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void applyQuery(tab.id);
    }
  };
  const block = phase === 'ready' ? editBlockOf(tab.id, connection.readOnly) : null;
  const first = page ? page.page * collection.pageSize : 0;
  const shown = page?.documents.count ?? 0;

  return (
    <div className={styles.view} data-testid="collection-tab">
      <div className={styles.query} role="search" aria-label={t('mongo.collection.query')}>
        {(
          [
            ['filter', 'mongo.collection.filter', '{ "status": "paid" }'],
            ['projection', 'mongo.collection.projection', '{ "name": 1 }'],
            ['sort', 'mongo.collection.sort', '{ "_id": -1 }'],
          ] as const
        ).map(([field, key, placeholder]) => (
          <label
            key={field}
            className={field === 'filter' ? styles.filterField : styles.optionField}
            htmlFor={`${id}-${field}`}
          >
            <span className={styles.fieldLabel}>{t(key)}</span>
            <TextInput
              id={`${id}-${field}`}
              data-field={field}
              mono
              value={draft[field]}
              placeholder={placeholder}
              spellCheck={false}
              invalid={error?.code === 'invalidArgument' && error.message.en.includes(field)}
              onChange={(event) => {
                onField(field)(event.target.value);
              }}
              onKeyDown={onEnter}
            />
          </label>
        ))}
        <Button
          variant="primary"
          size="sm"
          disabled={loading}
          onClick={() => {
            void applyQuery(tab.id);
          }}
        >
          {loading ? <Spinner /> : <Icon name="play" />}
          {t('mongo.collection.apply')}
        </Button>
      </div>
      <div className={styles.bar}>
        <SegmentedControl<DocumentViewMode>
          label={t('mongo.view.label')}
          value={view}
          options={[
            { value: 'grid', label: t('mongo.view.grid') },
            { value: 'documents', label: t('mongo.view.documents') },
          ]}
          onChange={(next) => {
            useCollectionStore.getState().patch(tab.id, { view: next });
          }}
        />
        <span className={styles.separator} aria-hidden="true" />
        <IconButton
          icon="chevronLeft"
          size="sm"
          label={t('mongo.page.previous')}
          disabled={loading || !page || page.page === 0}
          onClick={() => {
            if (page) void fetchPage(tab.id, page.page - 1);
          }}
        />
        <span className={styles.range} data-testid="collection-range">
          {shown === 0
            ? t('mongo.page.none')
            : t('mongo.page.range', {
                from: formatNumber(locale, first + 1),
                to: formatNumber(locale, first + shown),
              })}
        </span>
        <IconButton
          icon="chevronRight"
          size="sm"
          label={t('mongo.page.next')}
          disabled={loading || !page?.hasMore}
          onClick={() => {
            if (page) void fetchPage(tab.id, page.page + 1);
          }}
        />
        <Select
          className={styles.pageSize}
          aria-label={t('mongo.page.size')}
          value={String(collection.pageSize)}
          options={PAGE_SIZES.map((size) => ({
            value: String(size),
            label: t('mongo.page.perPage', { count: formatNumber(locale, size) }),
          }))}
          onChange={(size) => {
            void setPageSize(tab.id, Number(size));
          }}
        />
        <span className={styles.separator} aria-hidden="true" />
        <span className={styles.count} data-testid="collection-count">
          {exactCount !== null
            ? t('mongo.count.exact', { count: exactCount })
            : info?.estimatedCount != null && collection.applied.filter.trim() === ''
              ? t('mongo.count.estimated', { count: info.estimatedCount })
              : null}
        </span>
        {counting ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              cancelCollection(tab.id);
            }}
          >
            <Spinner />
            {t('mongo.count.cancel')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={phase !== 'ready'}
            onClick={() => {
              void countExactly(tab.id);
            }}
          >
            {t('mongo.count.button')}
          </Button>
        )}
        <span className={styles.spacer} />
        {phase === 'ready' && <DocEditBar tabId={tab.id} block={block} />}
        {page && (
          <span className={styles.command} title={page.command}>
            {page.keyset ? t('mongo.page.keyset') : t('mongo.page.skip')}
          </span>
        )}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <Icon name="warning" />
          <span>{localize(error.message)}</span>
          {error.detail && <code className={styles.detail}>{error.detail}</code>}
        </div>
      )}
      <div className={styles.results}>
        {loading && !page ? (
          <div className={styles.placeholder}>
            <Spinner />
          </div>
        ) : page ? (
          <EditableDocuments
            tabId={tab.id}
            page={page}
            view={view}
            label={t('mongo.collection.results', { name: label })}
            block={block}
            capped={info?.capped ?? false}
          />
        ) : null}
        {loading && page && (
          <div className={styles.busy}>
            <Spinner />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                cancelCollection(tab.id);
              }}
            >
              {t('mongo.cancel')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

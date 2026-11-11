import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { formatNumber, useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ExplainResult, PlanNode } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { toast } from '../../ui/toastStore';
import { explainQuery } from './explainActions';
import { formatDuration } from './format';
import { cancelQuery } from './queryActions';
import { useTabPlan } from './planStore';
import { heatOf, misestimate, parentsOf, visibleNodes, weightOf } from './planTree';
import styles from './PlanView.module.css';

/** Row height in px: `--plan-row-height`, read by the virtualizer. */
const ROW_HEIGHT = 26;

function amount(locale: Locale, value: number | null, digits = 0): string {
  if (value === null) return '';
  if (digits === 0 || Number.isInteger(value)) return formatNumber(locale, Math.round(value));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
}

/**
 * The plan of a tab's explain (F-053) in the results area: a tree of the operations with their
 * estimated and actual figures, the costly ones highlighted, the selected one's facts on the
 * side; or the plan as the engine sent it.
 */
export function PlanView({ tabId }: { tabId: string }) {
  const t = useT();
  const plan = useTabPlan(tabId);
  if (!plan) return null;
  if (plan.status === 'running') {
    return (
      <div className={styles.state} role="status">
        <Spinner />
        <span>{t(plan.analyze ? 'query.plan.runningAnalyze' : 'query.plan.running')}</span>
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            cancelQuery(tabId);
          }}
        >
          {t('toolbar.cancel')}
        </button>
      </div>
    );
  }
  if (plan.status === 'failed') {
    return (
      <div className={styles.state}>
        <ErrorPanel
          compact
          title={t('query.plan.failed')}
          error={plan.error}
          context={{
            retry: () => {
              void explainQuery(tabId, plan.analyze);
            },
          }}
        />
      </div>
    );
  }
  return <PlanBody key={plan.result.sent} result={plan.result} />;
}

function PlanBody({ result }: { result: ExplainResult }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { plan } = result;
  const [view, setView] = useState<'tree' | 'raw'>('tree');
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const hottest = [...plan.nodes].sort((a, b) => weightOf(b) - weightOf(a))[0];
    return hottest?.id ?? null;
  });
  const parents = useMemo(() => parentsOf(plan.nodes), [plan.nodes]);
  const rows = useMemo(() => visibleNodes(plan.nodes, collapsed), [plan.nodes, collapsed]);
  const selected = plan.nodes.find((node) => node.id === selectedId) ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const toggle = (id: number) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.id === selectedId);
    const current = rows[index];
    let next: PlanNode | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = rows[Math.min(rows.length - 1, index + 1)];
        break;
      case 'ArrowUp':
        next = rows[Math.max(0, index - 1)];
        break;
      case 'ArrowLeft':
        if (current && parents.has(current.id) && !collapsed.has(current.id)) toggle(current.id);
        else if (current?.parent != null) next = plan.nodes[current.parent];
        break;
      case 'ArrowRight':
        if (current && collapsed.has(current.id)) toggle(current.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) {
      setSelectedId(next.id);
      virtualizer.scrollToIndex(rows.indexOf(next));
    }
  };

  const copyRaw = () => {
    void navigator.clipboard.writeText(plan.raw).then(
      () => {
        toast({ variant: 'success', title: t('query.plan.copied') });
      },
      () => {
        toast({ variant: 'error', title: t('query.plan.copyFailed') });
      },
    );
  };

  const basisKey =
    plan.weightBasis === 'time'
      ? 'query.plan.basis.time'
      : plan.weightBasis === 'cost'
        ? 'query.plan.basis.cost'
        : plan.weightBasis === 'heuristic'
          ? 'query.plan.basis.heuristic'
          : 'query.plan.basis.none';

  return (
    <div className={styles.plan} data-testid="plan-view">
      <div className={styles.toolbar}>
        <span className={styles.kind} data-analyzed={plan.analyzed}>
          {t(plan.analyzed ? 'query.plan.actual' : 'query.plan.estimated')}
        </span>
        <span className={styles.meta}>
          {[
            t('query.plan.nodes', { count: plan.nodes.length }),
            t(basisKey),
            formatDuration(result.durationMs ?? 0),
          ].join(' · ')}
        </span>
        <span className={styles.summary}>
          {plan.summary.slice(0, 4).map((fact) => (
            <span key={`${fact.label}=${fact.value}`} className={styles.fact}>
              <span className={styles.factLabel}>{fact.label}</span> {fact.value}
            </span>
          ))}
        </span>
        <SegmentedControl
          label={t('query.plan.view')}
          value={view}
          options={[
            { value: 'tree', label: t('query.plan.view.tree') },
            { value: 'raw', label: t('query.plan.view.raw') },
          ]}
          onChange={setView}
        />
        <IconButton icon="copy" size="sm" label={t('query.plan.copyRaw')} onClick={copyRaw} />
      </div>
      {view === 'raw' ? (
        <pre className={styles.raw} data-testid="plan-raw">
          <code>{`-- ${result.sent}\n\n${plan.raw}`}</code>
        </pre>
      ) : (
        <div className={styles.body}>
          <div className={styles.treePane}>
            <div className={styles.header} aria-hidden="true">
              <span>{t('query.plan.col.operation')}</span>
              <span className={styles.num}>{t('query.plan.col.estRows')}</span>
              <span className={styles.num}>{plan.analyzed ? t('query.plan.col.rows') : ''}</span>
              <span className={styles.num}>
                {plan.analyzed ? t('query.plan.col.time') : t('query.plan.col.cost')}
              </span>
              <span className={styles.num}>{t('query.plan.col.share')}</span>
            </div>
            <div
              ref={scrollRef}
              className={styles.scroller}
              role="tree"
              aria-label={t('query.plan.label')}
              tabIndex={0}
              onKeyDown={onKeyDown}
            >
              <div className={styles.list} style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const node = rows[item.index];
                  if (!node) return null;
                  return (
                    <PlanRow
                      key={node.id}
                      node={node}
                      top={item.start}
                      locale={locale}
                      analyzed={plan.analyzed}
                      expandable={parents.has(node.id)}
                      expanded={!collapsed.has(node.id)}
                      selected={node.id === selectedId}
                      onSelect={() => {
                        setSelectedId(node.id);
                      }}
                      onToggle={() => {
                        toggle(node.id);
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <NodeFacts node={selected} locale={locale} />
        </div>
      )}
    </div>
  );
}

interface RowProps {
  node: PlanNode;
  top: number;
  locale: Locale;
  analyzed: boolean;
  expandable: boolean;
  expanded: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}

function PlanRow(props: RowProps) {
  const { node, locale, analyzed } = props;
  const t = useT();
  const weight = weightOf(node);
  const heat = heatOf(weight);
  const off = misestimate(node);
  const target = [node.relation, node.index && `(${node.index})`].filter(Boolean).join(' ');
  return (
    <div
      className={styles.row}
      style={{ transform: `translateY(${String(props.top)}px)` }}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={props.selected}
      aria-expanded={props.expandable ? props.expanded : undefined}
      data-heat={heat}
      data-testid="plan-row"
      onClick={props.onSelect}
    >
      <span
        className={styles.operation}
        style={{ paddingInlineStart: `calc(var(--plan-indent) * ${String(node.depth)})` }}
      >
        {props.expandable ? (
          <button
            type="button"
            className={styles.twisty}
            tabIndex={-1}
            aria-label={t(props.expanded ? 'query.plan.collapse' : 'query.plan.expand')}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle();
            }}
          >
            <Icon name={props.expanded ? 'chevronDown' : 'chevronRight'} />
          </button>
        ) : (
          <span className={styles.twisty} />
        )}
        <span className={styles.op}>{node.operation}</span>
        {target && <span className={styles.target}>{target}</span>}
        {node.detail && (
          <span className={styles.detail} title={node.detail}>
            {node.detail}
          </span>
        )}
      </span>
      <span className={styles.num}>{amount(locale, node.estimatedRows)}</span>
      <span className={styles.num} data-off={off !== null || undefined}>
        {analyzed ? amount(locale, node.actualRows) : ''}
        {off !== null && (
          <span className={styles.off} title={t('query.plan.misestimate', { ratio: off })}>
            ×{off}
          </span>
        )}
      </span>
      <span className={styles.num}>
        {analyzed
          ? node.actualTimeMs === null
            ? ''
            : formatDuration(node.actualTimeMs)
          : amount(locale, node.estimatedCost, 2)}
      </span>
      <span className={styles.share}>
        <span className={styles.bar} style={{ width: `${String(Math.round(weight * 100))}%` }} />
        <span className={styles.percent}>
          {weight > 0 ? `${String(Math.round(weight * 100))}%` : ''}
        </span>
      </span>
    </div>
  );
}

function NodeFacts({ node, locale }: { node: PlanNode | null; locale: Locale }) {
  const t = useT();
  if (!node) return <aside className={styles.facts} />;
  const figures: [string, string][] = [
    [t('query.plan.col.estRows'), amount(locale, node.estimatedRows, 2)],
    [t('query.plan.col.rows'), amount(locale, node.actualRows, 2)],
    [t('query.plan.loops'), amount(locale, node.loops)],
    [t('query.plan.col.cost'), amount(locale, node.estimatedCost, 4)],
    [t('query.plan.col.time'), node.actualTimeMs === null ? '' : formatDuration(node.actualTimeMs)],
  ];
  return (
    <aside className={styles.facts} aria-label={t('query.plan.details')} data-testid="plan-facts">
      <h3 className={styles.factsTitle}>{node.operation}</h3>
      {node.relation && (
        <p className={styles.factsTarget}>
          {node.relation}
          {node.index && ` · ${node.index}`}
        </p>
      )}
      {node.detail && <pre className={styles.condition}>{node.detail}</pre>}
      <dl className={styles.factList}>
        {[...figures, ...node.facts.map((f): [string, string] => [f.label, f.value])]
          .filter(([, value]) => value !== '')
          .map(([label, value]) => (
            <div key={label} className={styles.factRow}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </aside>
  );
}

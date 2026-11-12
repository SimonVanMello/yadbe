import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ACTION_IDS,
  ACTION_LABELS,
  TAB_SCOPES,
  defaultShortcutOf,
  effectiveBindings,
  type ActionId,
} from '../../app/actions';
import { captureShortcut, clashesWith, findConflicts } from '../../app/keybindingsLogic';
import { useKeybindingsStore } from '../../app/keybindingsStore';
import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { platform } from '../../ui/platform';
import { TextInput } from '../../ui/TextInput';
import styles from './KeybindingsSetting.module.css';

const GROUPS = ['general', 'tabs', 'connections', 'query', 'table'] as const;
type Group = (typeof GROUPS)[number];

const GROUP_LABELS: Record<Group, MessageKey> = {
  general: 'keybindings.group.general',
  tabs: 'keybindings.group.tabs',
  connections: 'keybindings.group.connections',
  query: 'keybindings.group.query',
  table: 'keybindings.group.table',
};

/** The part of the registry an action is listed under. */
export function groupOf(id: ActionId): Group {
  const prefix = id.split('.')[0];
  if (prefix === 'tab') return 'tabs';
  if (prefix === 'connection') return 'connections';
  if (prefix === 'query' || prefix === 'result') return 'query';
  if (prefix === 'table') return 'table';
  return 'general';
}

/** What the row being edited is waiting for. */
type Editing =
  | { id: ActionId; kind: 'capture' }
  | { id: ActionId; kind: 'conflict'; shortcut: string; others: ActionId[] }
  | { id: ActionId; kind: 'invalid' };

/** The shortcut editor (F-121): press the keys, conflicts are shown, defaults come back. */
export function KeybindingsSetting({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  const overrides = useKeybindingsStore((state) => state.overrides);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);

  const effective = useMemo(() => effectiveBindings(overrides), [overrides]);
  const conflicts = useMemo(() => {
    const shared = findConflicts(effective, TAB_SCOPES);
    const perId = new Map<string, string[]>();
    for (const ids of shared.values()) {
      for (const id of ids)
        perId.set(
          id,
          ids.filter((other) => other !== id),
        );
    }
    return perId;
  }, [effective]);

  const name = (id: ActionId) => t(ACTION_LABELS[id]);
  const names = (ids: readonly string[]) => ids.map((id) => name(id as ActionId)).join(', ');
  const query = filter.trim().toLowerCase();
  const visible = ACTION_IDS.filter((id) => {
    if (!query) return true;
    return (
      name(id).toLowerCase().includes(query) ||
      id.toLowerCase().includes(query) ||
      (effective.get(id)?.toLowerCase().includes(query) ?? false)
    );
  });
  const changeCount = Object.keys(overrides).length;

  const onCapture = (id: ActionId, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const capture = captureShortcut(event.nativeEvent, platform);
    if (capture.kind === 'pending') return;
    if (capture.kind === 'cancel') {
      setEditing(null);
    } else if (capture.kind === 'invalid') {
      setEditing({ id, kind: 'invalid' });
    } else {
      const others = clashesWith(id, capture.shortcut, effective, TAB_SCOPES) as ActionId[];
      if (others.length > 0) {
        setEditing({ id, kind: 'conflict', shortcut: capture.shortcut, others });
      } else {
        setEditing(null);
        useKeybindingsStore.getState().set(id, capture.shortcut);
      }
    }
  };

  return (
    <div className={styles.setting} data-testid="keybindings">
      <div className={styles.heading}>
        <span className={styles.label}>{label}</span>
        <span className={styles.hint}>{hint}</span>
      </div>
      <div className={styles.toolbar}>
        <TextInput
          className={styles.filter}
          value={filter}
          placeholder={t('keybindings.filter')}
          aria-label={t('keybindings.filter')}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <Button
          disabled={changeCount === 0}
          onClick={() => {
            setEditing(null);
            useKeybindingsStore.getState().resetAll();
          }}
        >
          {t('keybindings.resetAll')}
        </Button>
      </div>
      <div className={styles.list}>
        {GROUPS.map((group) => {
          const items = visible.filter((id) => groupOf(id) === group);
          if (items.length === 0) return null;
          return (
            <section key={group} aria-labelledby={`kb-${group}`}>
              <h3 id={`kb-${group}`} className={styles.group}>
                {t(GROUP_LABELS[group])}
              </h3>
              {items.map((id) => {
                const shortcut = effective.get(id) ?? null;
                const changed = id in overrides;
                const edit = editing?.id === id ? editing : null;
                const clash = conflicts.get(id);
                return (
                  <div key={id} className={styles.row} data-binding-id={id}>
                    <div className={styles.text}>
                      <span className={styles.title}>{name(id)}</span>
                      {clash && !edit && (
                        <span className={styles.warning} role="status">
                          <Icon name="warning" />{' '}
                          {t('keybindings.conflict', { names: names(clash) })}
                        </span>
                      )}
                      {edit?.kind === 'invalid' && (
                        <span className={styles.warning} role="status">
                          {t('keybindings.invalid')}
                        </span>
                      )}
                      {edit?.kind === 'conflict' && (
                        <span className={styles.warning} role="status">
                          <Icon name="warning" />{' '}
                          {t('keybindings.conflict.pick', { names: names(edit.others) })}
                        </span>
                      )}
                    </div>
                    <div className={styles.controls}>
                      {edit?.kind === 'conflict' ? (
                        <>
                          <Kbd shortcut={edit.shortcut} />
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                              const changes: Record<string, string | null> = {
                                [id]: edit.shortcut,
                              };
                              for (const other of edit.others) changes[other] = null;
                              setEditing(null);
                              useKeybindingsStore.getState().setMany(changes);
                            }}
                          >
                            {t('keybindings.reassign')}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              setEditing(null);
                            }}
                          >
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : edit ? (
                        <CaptureField
                          label={t('keybindings.capture')}
                          onKeyDown={(event) => {
                            onCapture(id, event);
                          }}
                          onBlur={() => {
                            setEditing(null);
                          }}
                        />
                      ) : (
                        <>
                          <span className={styles.shortcut} data-changed={changed || undefined}>
                            {shortcut ? (
                              <Kbd shortcut={shortcut} />
                            ) : (
                              <span className={styles.unbound}>{t('keybindings.unbound')}</span>
                            )}
                          </span>
                          <Button
                            size="sm"
                            aria-label={t('keybindings.change', { name: name(id) })}
                            onClick={() => {
                              setEditing({ id, kind: 'capture' });
                            }}
                          >
                            {t('keybindings.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={shortcut === null}
                            aria-label={t('keybindings.clear', { name: name(id) })}
                            onClick={() => {
                              useKeybindingsStore.getState().set(id, null);
                            }}
                          >
                            {t('keybindings.remove')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!changed}
                            aria-label={t('keybindings.reset', {
                              name: name(id),
                              shortcut: defaultShortcutOf(id) ?? t('keybindings.unbound'),
                            })}
                            onClick={() => {
                              useKeybindingsStore.getState().reset(id);
                            }}
                          >
                            {t('keybindings.default')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
        {visible.length === 0 && <p className={styles.empty}>{t('keybindings.empty')}</p>}
      </div>
    </div>
  );
}

interface CaptureFieldProps {
  label: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onBlur: () => void;
}

/** A focused box that turns the next key press into a shortcut. */
function CaptureField({ label, onKeyDown, onBlur }: CaptureFieldProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className={styles.capture}
      data-capturing
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {label}
    </button>
  );
}

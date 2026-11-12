import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { matchShortcut } from '../../ui/shortcuts';
import type { PreferenceKey } from './preferenceSchema';
import styles from './PreferencesDialog.module.css';
import { SettingRow } from './SettingRow';
import {
  SECTIONS,
  SETTINGS,
  countBySection,
  isSectionId,
  searchSettings,
  settingsOf,
  type SectionId,
  type SectionInfo,
} from './settingsIndex';
import { resetAll, useAllDefault } from './useSetting';

const DEFAULT_SECTION: SectionId = 'appearance';

function sectionInfo(id: SectionId): SectionInfo {
  return SECTIONS.find((section) => section.id === id) ?? (SECTIONS[0] as SectionInfo);
}

function keysOf(section: SectionId): PreferenceKey[] {
  return settingsOf(section).flatMap((setting) => (setting.key === null ? [] : [setting.key]));
}

/**
 * Preferences (F-125): sections in a sidebar, a search over every setting, each change applied
 * and saved at once, and a reset to default per setting and per section.
 */
export function PreferencesDialog() {
  const request = useShellStore((state) => state.preferences);
  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) useShellStore.getState().closePreferences();
      }}
    >
      {request !== null && <PreferencesContent requested={request.section} />}
    </Dialog.Root>
  );
}

function PreferencesContent({ requested }: { requested: string | null }) {
  const t = useT();
  const [section, setSection] = useState<SectionId>(
    isSectionId(requested) ? requested : DEFAULT_SECTION,
  );
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const found = useMemo(() => searchSettings(trimmed, t), [trimmed, t]);
  const counts = useMemo(() => (found ? countBySection(found) : null), [found]);

  const searching = found !== null;
  // A new page starts at the top.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [section, searching]);

  const info = sectionInfo(section);
  const resetKeys = keysOf(section);
  const allDefault = useAllDefault(resetKeys);

  return (
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} />
      <Dialog.Content
        className={styles.content}
        data-modal=""
        onKeyDown={(event) => {
          if (matchShortcut(event.nativeEvent, 'Mod+F')) {
            event.preventDefault();
            event.stopPropagation();
            searchRef.current?.focus();
            searchRef.current?.select();
          }
        }}
        onEscapeKeyDown={(event) => {
          // Escape cancels the shortcut being captured, not the screen.
          if (document.activeElement?.hasAttribute('data-capturing')) {
            event.preventDefault();
            return;
          }
          // Escape first clears the search, a second one closes the screen.
          if (query !== '' && document.activeElement === searchRef.current) {
            event.preventDefault();
            setQuery('');
          }
        }}
      >
        <nav className={styles.nav} aria-label={t('preferences.sections')}>
          <Dialog.Title className={styles.title}>{t('preferences.title')}</Dialog.Title>
          <div className={styles.search}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              ref={searchRef}
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder={t('preferences.search.placeholder')}
              aria-label={t('preferences.search')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            {query ? (
              <button
                type="button"
                className={styles.clear}
                aria-label={t('preferences.search.clear')}
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            ) : (
              <Kbd shortcut="Mod+F" />
            )}
          </div>
          <div className={styles.items}>
            {SECTIONS.map((entry) => {
              const count = counts?.get(entry.id) ?? 0;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.item}
                  aria-current={!found && entry.id === section ? 'page' : undefined}
                  data-dim={found && count === 0 ? '' : undefined}
                  onClick={() => {
                    setQuery('');
                    setSection(entry.id);
                  }}
                >
                  <Icon name={entry.icon} />
                  <span className={styles.itemLabel}>{t(entry.label)}</span>
                  {found && count > 0 && <span className={styles.count}>{count}</span>}
                </button>
              );
            })}
          </div>
          <Dialog.Description className={styles.footnote}>
            {t('preferences.description')}
          </Dialog.Description>
        </nav>
        <section className={styles.pane} aria-labelledby="preferences-pane-title">
          <header className={styles.header}>
            <h2 id="preferences-pane-title" className={styles.paneTitle}>
              {found ? t('preferences.search.results') : t(info.label)}
            </h2>
            <span className={styles.spacer} />
            {!found && resetKeys.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={allDefault}
                onClick={() => {
                  resetAll(resetKeys);
                }}
              >
                {t('preferences.reset.section')}
              </Button>
            )}
            <Dialog.Close className={styles.close} aria-label={t('common.close')}>
              <Icon name="close" size="md" />
            </Dialog.Close>
          </header>
          <div ref={bodyRef} className={styles.body}>
            <div className={styles.inner}>
              {found ? (
                <SearchResults query={trimmed} found={found} />
              ) : (
                <>
                  <p className={styles.description}>{t(info.description)}</p>
                  <div className={styles.list}>
                    {settingsOf(section).map((setting) => (
                      <SettingRow key={setting.id} spec={setting} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function SearchResults({
  query,
  found,
}: {
  query: string;
  found: ReadonlySet<(typeof SETTINGS)[number]['id']>;
}) {
  const t = useT();
  if (found.size === 0) {
    return <p className={styles.description}>{t('preferences.search.empty', { query })}</p>;
  }
  return (
    <>
      <p className={styles.description} role="status">
        {t('preferences.search.count', { count: found.size, query })}
      </p>
      {SECTIONS.map((entry) => {
        const matching = settingsOf(entry.id).filter((setting) => found.has(setting.id));
        if (matching.length === 0) return null;
        return (
          <section key={entry.id} className={styles.result} aria-label={t(entry.label)}>
            <div className={styles.resultPath}>{t(entry.label)}</div>
            <div className={styles.list}>
              {matching.map((setting) => (
                <SettingRow key={setting.id} spec={setting} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

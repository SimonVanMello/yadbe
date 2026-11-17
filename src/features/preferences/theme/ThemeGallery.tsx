import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { MessageKey } from '../../../i18n/i18n';
import { useT } from '../../../i18n/useT';
import { THEMES, themeInfo, themesByFamily, type ThemeInfo } from '../../../theme/catalog';
import { useThemeStore } from '../../../theme/themeStore';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { TextInput } from '../../../ui/TextInput';
import { foldText } from '../settingsIndex';
import { useSettingsQuery } from '../settingsQuery';
import { ThemeSlots } from './ThemeSlots';
import { ThemeSwatch } from './ThemeSwatch';
import styles from './ThemeGallery.module.css';

type Kind = 'all' | 'dark' | 'light';

/** Hovering across the grid must not flash every theme it crosses. */
const PREVIEW_DELAY_MS = 120;

/** Searchable text of a theme: its name and its family. */
export function themeSearchText(theme: ThemeInfo, familyLabel: string): string {
  return `${theme.name} ${familyLabel}`;
}

/** Whether `query` names one of the themes (a search of the dialog then filters the gallery). */
export function namesMatch(query: string, names: readonly string[]): boolean {
  const folded = foldText(query.trim());
  return folded !== '' && names.some((name) => foldText(name).includes(folded));
}

/**
 * The color themes as cards drawn with their own colors. Hovering or focusing a card
 * previews the theme on the whole app; a click or Enter applies it; leaving the gallery or
 * Esc comes back to the current theme.
 */
export function ThemeGallery() {
  const t = useT();
  const dialogQuery = useSettingsQuery();
  const preference = useThemeStore((state) => state.preference);
  const lightTheme = useThemeStore((state) => state.lightTheme);
  const darkTheme = useThemeStore((state) => state.darkTheme);
  const resolved = useThemeStore((state) => state.resolved);
  const preview = useThemeStore((state) => state.preview);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set by a click: applying a theme can move the cards (the boxes of the two modes come and
   * go), and the card that slides under a still pointer must not start a preview.
   */
  const waitForMove = useRef(false);
  const following = preference === 'system';

  const familyLabel = (family: ThemeInfo['family']) =>
    t(`preferences.theme.family.${family}` as MessageKey);
  // A search of the dialog that names themes ("dracula") filters the gallery too.
  const names = useMemo(
    () =>
      THEMES.map((theme) => themeSearchText(theme, t(`preferences.theme.family.${theme.family}`))),
    [t],
  );
  const query = foldText(text.trim() || (namesMatch(dialogQuery, names) ? dialogQuery : ''));
  const shown = THEMES.filter(
    (theme) =>
      (kind === 'all' || theme.dark === (kind === 'dark')) &&
      foldText(themeSearchText(theme, familyLabel(theme.family))).includes(query),
  );

  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const previewLater = (id: string) => {
    cancelPending();
    timer.current = setTimeout(() => {
      useThemeStore.getState().setPreview(id);
    }, PREVIEW_DELAY_MS);
  };
  const stopPreview = () => {
    cancelPending();
    useThemeStore.getState().setPreview(null);
  };
  // Closing the dialog or leaving the section ends the preview.
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current) clearTimeout(pending.current);
      useThemeStore.getState().setPreview(null);
    };
  }, []);

  const badge = (theme: ThemeInfo): string | null => {
    if (!following) return theme.id === resolved ? t('preferences.theme.active') : null;
    if (theme.id === lightTheme) return t('preferences.theme.slot.light');
    if (theme.id === darkTheme) return t('preferences.theme.slot.dark');
    return null;
  };
  const isActive = (theme: ThemeInfo) =>
    following ? theme.id === lightTheme || theme.id === darkTheme : theme.id === resolved;

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-theme-id]')];
    const current = cards.findIndex((card) => card === document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const top = cards[current]?.offsetTop;
    const row = cards.filter((card) => card.offsetTop === top);
    const columns = Math.max(1, row.length);
    const next = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current + columns,
      ArrowUp: current - columns,
      Home: 0,
      End: cards.length - 1,
    }[event.key];
    const target = cards[Math.max(0, Math.min(cards.length - 1, next ?? current))];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };

  const previewing = preview !== null && preview !== resolved ? themeInfo(preview) : undefined;
  const current = themeInfo(resolved);

  return (
    <div className={styles.gallery}>
      {following && <ThemeSlots />}
      <div className={styles.toolbar}>
        <TextInput
          className={styles.filter}
          value={text}
          placeholder={t('preferences.theme.filter')}
          aria-label={t('preferences.theme.filter')}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <SegmentedControl<Kind>
          label={t('preferences.theme.kind')}
          value={kind}
          options={[
            { value: 'all', label: t('preferences.theme.kind.all') },
            { value: 'dark', label: t('preferences.theme.kind.dark') },
            { value: 'light', label: t('preferences.theme.kind.light') },
          ]}
          onChange={setKind}
        />
        <span className={styles.count} aria-live="polite">
          {t('preferences.theme.count', { count: shown.length })}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className={styles.empty}>{t('preferences.theme.empty')}</p>
      ) : (
        <div
          className={styles.families}
          onKeyDown={onGridKeyDown}
          onPointerLeave={stopPreview}
          onPointerMove={(event) => {
            if (!waitForMove.current) return;
            waitForMove.current = false;
            const card = (event.target as Element).closest<HTMLElement>('[data-theme-id]');
            if (card?.dataset.themeId) previewLater(card.dataset.themeId);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) stopPreview();
          }}
        >
          {themesByFamily(shown).map(({ family, themes }) => (
            <section key={family} className={styles.family} aria-label={familyLabel(family)}>
              <h4 className={styles.familyTitle}>{familyLabel(family)}</h4>
              <div className={styles.grid}>
                {themes.map((theme) => {
                  const label = badge(theme);
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      className={styles.card}
                      data-theme-id={theme.id}
                      data-active={isActive(theme) ? '' : undefined}
                      aria-pressed={isActive(theme)}
                      onPointerEnter={() => {
                        if (!waitForMove.current) previewLater(theme.id);
                      }}
                      onFocus={(event) => {
                        // A click focuses too: only the keyboard previews on focus.
                        if (event.currentTarget.matches(':focus-visible')) {
                          cancelPending();
                          useThemeStore.getState().setPreview(theme.id);
                        }
                      }}
                      onClick={() => {
                        cancelPending();
                        waitForMove.current = true;
                        useThemeStore.getState().chooseTheme(theme.id);
                      }}
                    >
                      <ThemeSwatch theme={theme.id} />
                      <span className={styles.caption}>
                        <span className={styles.name}>{theme.name}</span>
                        {label && <span className={styles.badge}>{label}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {previewing && current && (
        <div className={styles.preview} role="status">
          {t('preferences.theme.preview', { name: previewing.name, current: current.name })}
        </div>
      )}
    </div>
  );
}

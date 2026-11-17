import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { findAction } from '../../app/actions';

import type { MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { THEMES, type ThemeInfo } from '../../theme/catalog';
import { useThemeStore } from '../../theme/themeStore';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { foldText } from '../preferences/settingsIndex';
import styles from './CommandPalette.module.css';
import { usePaletteStore } from './paletteStore';

const LIST_ID = 'palette-themes';

function optionId(id: string): string {
  return `palette-theme-${id}`;
}

/**
 * The color themes in the palette, like VS Code's "Color Theme" picker: moving through the
 * list previews each theme on the whole app, Enter applies it, Esc goes back to the current one.
 */
export function ThemePicker() {
  const t = useT();
  const resolved = useThemeStore((state) => state.resolved);
  const [raw, setRaw] = useState('');
  const familyLabel = (theme: ThemeInfo) =>
    t(`preferences.theme.family.${theme.family}` as MessageKey);

  const query = foldText(raw.trim());
  const groups = useMemo(() => {
    const match = (theme: ThemeInfo) =>
      foldText(
        `${theme.name} ${t(`preferences.theme.family.${theme.family}` as MessageKey)}`,
      ).includes(query);
    return [
      { label: t('palette.theme.dark'), themes: THEMES.filter((th) => th.dark && match(th)) },
      { label: t('palette.theme.light'), themes: THEMES.filter((th) => !th.dark && match(th)) },
    ].filter((group) => group.themes.length > 0);
  }, [query, t]);
  const items = groups.flatMap((group) => group.themes);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      items.findIndex((theme) => theme.id === resolved),
    ),
  );
  const activeIndex = Math.min(active, items.length - 1);
  const activeId = items[activeIndex]?.id;

  useEffect(() => {
    useThemeStore.getState().setPreview(activeId ?? null);
    const element = activeId ? document.getElementById(optionId(activeId)) : null;
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
  }, [activeId]);
  // Closing without a choice (Esc, a click outside) comes back to the current theme.
  useEffect(
    () => () => {
      useThemeStore.getState().setPreview(null);
    },
    [],
  );

  const choose = (theme: ThemeInfo) => {
    useThemeStore.getState().chooseTheme(theme.id);
    usePaletteStore.getState().hide();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The global shortcuts stand down while a dialog is open: toggling back is ours.
    const action = findAction(event.nativeEvent);
    if (action === 'palette.open' || action === 'palette.commands') {
      event.preventDefault();
      usePaletteStore.getState().hide();
      return;
    }
    const last = items.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        setActive(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
        setActive(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case 'PageDown':
        setActive(Math.min(last, activeIndex + 8));
        break;
      case 'PageUp':
        setActive(Math.max(0, activeIndex - 8));
        break;
      case 'Enter': {
        const theme = items[activeIndex];
        if (theme) choose(theme);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <>
      <div className={styles.search}>
        <Icon name="palette" />
        <input
          type="text"
          role="combobox"
          className={styles.input}
          value={raw}
          placeholder={t('palette.theme.placeholder')}
          aria-label={t('palette.theme.title')}
          aria-expanded
          aria-controls={LIST_ID}
          aria-activedescendant={activeId ? optionId(activeId) : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(event) => {
            setRaw(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {items.length === 0 ? (
        <div className={styles.empty} role="status">
          {t('palette.theme.empty', { query: raw.trim() })}
        </div>
      ) : (
        <ul
          id={LIST_ID}
          role="listbox"
          aria-label={t('palette.theme.title')}
          className={`${styles.list} ${styles.themeList}`}
        >
          {groups.map((group) => (
            <li key={group.label} role="presentation">
              <div className={styles.groupLabel} aria-hidden="true">
                {group.label}
              </div>
              <ul role="group" aria-label={group.label} className={styles.groupList}>
                {group.themes.map((theme) => {
                  const index = items.indexOf(theme);
                  return (
                    <li
                      key={theme.id}
                      id={optionId(theme.id)}
                      role="option"
                      aria-selected={index === activeIndex}
                      data-active={index === activeIndex ? '' : undefined}
                      className={`${styles.option} ${styles.themeOption}`}
                      onMouseMove={() => {
                        if (index !== activeIndex) setActive(index);
                      }}
                      onClick={() => {
                        choose(theme);
                      }}
                    >
                      <span className={styles.themeDot} data-theme={theme.id} aria-hidden="true" />
                      <span className={styles.label}>{theme.name}</span>
                      <span className={styles.detail}>{familyLabel(theme)}</span>
                      {theme.id === resolved && (
                        <span className={styles.aside}>{t('palette.theme.current')}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.footer}>
        <span className={styles.footerHint}>
          <Kbd shortcut="↑" />
          <Kbd shortcut="↓" />
        </span>
        <span className={styles.footerHint}>
          <Kbd shortcut="Enter" />
          {t('palette.theme.hint')}
        </span>
      </div>
    </>
  );
}

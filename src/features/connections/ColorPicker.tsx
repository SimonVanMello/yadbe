import type { CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { useThemeStore } from '../../theme/themeStore';
import { Icon } from '../../ui/Icon';
import styles from './ColorPicker.module.css';
import { TAG_COLORS, resolveTagColor } from './tagColors';

interface ColorPickerProps {
  /** `#rrggbb` of the chosen color. */
  value: string | null;
  onChange: (value: string) => void;
  label: string;
}

/**
 * Swatches of the connection colors (`--tag-n` of the theme). A custom environment keeps the
 * color it was given as `#rrggbb`, so the swatch stores the token's current value.
 */
export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const t = useT();
  // The tokens change with the theme: render again when it does.
  useThemeStore((state) => state.theme);

  return (
    <div role="radiogroup" aria-label={label} className={styles.picker}>
      {TAG_COLORS.map((color) => {
        const hex = resolveTagColor(color) ?? '';
        const selected = value !== null && value.toLowerCase() === hex.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t(`connection.color.${color}`)}
            title={t(`connection.color.${color}`)}
            className={styles.swatch}
            style={{ '--swatch': `var(--tag-${String(color)})` } as CSSProperties}
            onClick={() => {
              if (hex) onChange(hex);
            }}
          >
            {selected && <Icon name="check" />}
          </button>
        );
      })}
    </div>
  );
}

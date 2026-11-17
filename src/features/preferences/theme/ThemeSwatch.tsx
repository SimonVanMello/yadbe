import styles from './ThemeSwatch.module.css';

/** Lines of the miniature SQL editor: the token color and the length of each token. */
const LINES = [
  [
    ['keyword', 0.5],
    ['text', 0.9],
  ],
  [
    ['keyword', 0.6],
    ['function', 0.7],
  ],
  [
    ['keyword', 0.4],
    ['text', 0.4],
    ['string', 0.8],
  ],
] as const;

/** Cells of the miniature grid: the second row is selected, two cells carry pending edits. */
const ROWS = [
  [null, null, null],
  [null, null, null],
  [null, 'modified', null],
  [null, null, 'inserted'],
] as const;

interface ThemeSwatchProps {
  theme: string;
  size?: 'md' | 'sm';
}

/**
 * A miniature of the app in `theme`: titlebar, explorer, SQL editor and data grid. It reads the
 * theme's own tokens (`data-theme` on the element), so it is exactly what the theme will show.
 */
export function ThemeSwatch({ theme, size = 'md' }: ThemeSwatchProps) {
  return (
    <div className={styles.swatch} data-theme={theme} data-size={size} aria-hidden="true">
      <div className={styles.titlebar} />
      <div className={styles.sidebar}>
        <i />
        <i data-on="" />
        <i data-short="" />
        <i />
        <i data-short="" />
      </div>
      <div className={styles.editor}>
        {LINES.map((tokens, index) => (
          <div key={index} className={styles.line}>
            {tokens.map(([kind, length], position) => (
              <span key={position} data-kind={kind} style={{ flexGrow: length }} />
            ))}
          </div>
        ))}
      </div>
      <div className={styles.grid}>
        <div className={styles.header}>
          <span />
          <span />
          <span />
        </div>
        {ROWS.map((cells, index) => (
          <div key={index} className={styles.row} data-selected={index === 1 ? '' : undefined}>
            {cells.map((state, column) => (
              <span key={column} data-state={state ?? undefined} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

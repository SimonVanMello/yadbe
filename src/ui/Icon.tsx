import type { SVGProps } from 'react';

// Minimal stroke icon set (24×24 grid), drawn to match the mockups.
const PATHS = {
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.3a7.5 7.5 0 0 0-2.2 1.3l-2.4-.9-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.2 1.3l.4 2.3h4l.4-2.3a7.5 7.5 0 0 0 2.2-1.3l2.4.9 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  check: 'm5 12 5 5 9-10',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Zm9.5-13.5 4 4',
  chevronDown: 'm6 9 6 6 6-6',
  back: 'M19 12H5m0 0 6-6m-6 6 6 6',
  forward: 'M5 12h14m0 0-6-6m6 6-6 6',
  file: 'M14 3H6v18h12V7l-4-4Zm0 0v4h4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  tree: 'M4 4h6M7 4v14h5m-5-7h5m3-7h5m-5 7h5m-5 7h5',
  chevronUp: 'm6 15 6-6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  warning:
    'M12 9v4m0 4h.01M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  error: 'M12 8v5m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'm20 20-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  folderOpen:
    'M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1M3 17l2.6-6.1A1.5 1.5 0 0 1 7 10h13.2a1 1 0 0 1 .9 1.4L18.5 18a1.5 1.5 0 0 1-1.4 1H5a2 2 0 0 1-2-2Z',
  star: 'm12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h3',
  terminal: 'm5 8 4 4-4 4m6 0h8M3 4h18v16H3z',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  panelLeft: 'M4 5h16v14H4zM9 5v14',
  panelRight: 'M4 5h16v14H4zM15 5v14',
  panelBottom: 'M4 5h16v14H4zM4 14h16',
  log: 'M4 6h16M4 12h16M4 18h10',
  bell: 'M6 17v-6a6 6 0 1 1 12 0v6l1.5 1.5h-15L6 17Zm4 3.5a2 2 0 0 0 4 0',
  windowMinimize: 'M5 12h14',
  windowMaximize: 'M6 6h12v12H6z',
  windowRestore: 'M6 9h9v9H6zM9 9V6h9v9h-3',
  windowClose: 'M6 6l12 12M18 6 6 18',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  pin: 'M9 4h6m-5 0v5l-3 4h10l-3-4V4m-2 9v7',
  retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4M12 7v5l3 2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:
    'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  palette:
    'M12 3a9 9 0 1 0 0 18c.9 0 1.5-.6 1.5-1.4 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.4 1.5-1.4H16a5 5 0 0 0 5-5C21 6.6 17 3 12 3ZM7.5 11h.01M10 7.5h.01M14 7.5h.01M16.5 11h.01',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  shield: 'M12 3 4 6v6c0 4.5 3.4 7.9 8 9 4.6-1.1 8-4.5 8-9V6l-8-3Z',
  external: 'M14 4h6v6m0-6-9 9m7 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  play: 'M7 4v16l13-8L7 4Z',
  stop: 'M6 6h12v12H6z',
  database:
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  view: 'M4 5h16v14H4zM4 10h16M10 10v9',
  matView: 'M4 5h16v14H4zM4 10h16M10 10v9M15 14h3',
  routine:
    'M9 4C7 4 6 5 6 7v3c0 1.5-1 2-2 2 1 0 2 .5 2 2v3c0 2 1 3 3 3M15 4c2 0 3 1 3 3v3c0 1.5 1 2 2 2-1 0-2 .5-2 2v3c0 2-1 3-3 3',
  sequence: 'M4 7h2v4H4M4 17h3m-3 0 2.5-3a1.5 1.5 0 0 0-2.5-1M11 8h9M11 16h9',
  tag: 'M3 12V4h8l10 10-8 8L3 12Zm5-5h.01',
  key: 'M14.5 9.5a4.5 4.5 0 1 0-4 4.5l1 1H14v2h2v2h3l1-1v-3l-6.5-6.5ZM7.5 8.5h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  hash: 'M5 9h15M4 15h15M10 4 8 20M16 4l-2 16',
  formula: 'M16 5c-1.5 0-2.5.8-3 3l-1.5 8c-.5 2.2-1.5 3-3 3M8 11h8',
  columns: 'M4 5h16v14H4zM9.5 5v14M14.5 5v14',
  index: 'M3 6h12M3 12h8M3 18h5m9-10v10m0 0 3-3m-3 3-3-3',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6l1-8Z',
  checkSquare: 'M4 4h16v16H4zM8 12l3 3 5-6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  arrowUp: 'M12 19V5m0 0-6 6m6-6 6 6',
  arrowDown: 'M12 5v14m0 0-6-6m6 6 6-6',
  chevronLeft: 'm15 6-6 6 6 6',
  filter: 'M4 5h16l-6 7.5V19l-4 1v-7.5L4 5Z',
  download: 'M12 4v11m0 0-4-4m4 4 4-4M5 20h14',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  size?: 'sm' | 'md' | 'lg';
  /** Fills the shape with the current color (e.g. an active star). */
  filled?: boolean;
}

export function Icon({ name, size = 'sm', filled = false, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        width: `var(--icon-size-${size})`,
        height: `var(--icon-size-${size})`,
        flex: 'none',
      }}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

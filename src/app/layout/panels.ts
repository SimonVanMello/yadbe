/** Size (px) and visibility of a resizable panel. */
export interface PanelState {
  size: number;
  collapsed: boolean;
}

export type PanelId = 'sidebar' | 'bottom';
export type Panels = Record<PanelId, PanelState>;

/** Bounds of each panel, in px (spec §4: sidebar and bottom panel are resizable and collapsible). */
export const PANEL_LIMITS: Record<PanelId, { min: number; max: number; default: number }> = {
  sidebar: { min: 200, max: 520, default: 280 },
  bottom: { min: 120, max: 640, default: 240 },
};

/** The center keeps at least this width / height when the panels grow. */
export const CENTER_MIN_WIDTH = 360;
export const CENTER_MIN_HEIGHT = 160;

export const DEFAULT_PANELS: Panels = {
  sidebar: { size: PANEL_LIMITS.sidebar.default, collapsed: false },
  bottom: { size: PANEL_LIMITS.bottom.default, collapsed: true },
};

export function clampPanelSize(panel: PanelId, size: number): number {
  const { min, max } = PANEL_LIMITS[panel];
  return Math.round(Math.min(max, Math.max(min, size)));
}

function parsePanel(panel: PanelId, value: unknown): PanelState {
  const fallback = DEFAULT_PANELS[panel];
  if (typeof value !== 'object' || value === null) return fallback;
  const size = 'size' in value && typeof value.size === 'number' ? value.size : fallback.size;
  const collapsed =
    'collapsed' in value && typeof value.collapsed === 'boolean'
      ? value.collapsed
      : fallback.collapsed;
  return { size: clampPanelSize(panel, Number.isFinite(size) ? size : fallback.size), collapsed };
}

/** Reads the saved layout; tolerant to old, partial or corrupted data. */
export function parsePanels(value: unknown): Panels {
  if (typeof value !== 'object' || value === null) return DEFAULT_PANELS;
  return {
    sidebar: parsePanel('sidebar', 'sidebar' in value ? value.sidebar : undefined),
    bottom: parsePanel('bottom', 'bottom' in value ? value.bottom : undefined),
  };
}

/**
 * Displayed size of a panel for the space available on its axis. The saved size is kept, but
 * when the window is too small the panel shrinks down to its minimum so the center keeps its
 * minimum size. `0` means collapsed.
 */
export function fitPanel(panel: PanelId, state: PanelState, available: number): number {
  if (state.collapsed) return 0;
  // Before the first measure, show the saved size.
  if (available <= 0) return state.size;
  const centerMin = panel === 'sidebar' ? CENTER_MIN_WIDTH : CENTER_MIN_HEIGHT;
  return Math.max(PANEL_LIMITS[panel].min, Math.min(state.size, available - centerMin));
}

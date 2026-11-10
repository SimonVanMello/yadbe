import { describe, expect, it } from 'vitest';

import {
  CENTER_MIN_HEIGHT,
  CENTER_MIN_WIDTH,
  DEFAULT_PANELS,
  PANEL_LIMITS,
  clampPanelSize,
  fitPanel,
  parsePanels,
} from './panels';

describe('panel sizes', () => {
  it('clamps a size into the limits of its panel', () => {
    expect(clampPanelSize('sidebar', 10)).toBe(PANEL_LIMITS.sidebar.min);
    expect(clampPanelSize('sidebar', 5000)).toBe(PANEL_LIMITS.sidebar.max);
    expect(clampPanelSize('bottom', 200.4)).toBe(200);
  });

  it('round-trips the layout', () => {
    const panels = {
      sidebar: { size: 300, collapsed: true },
      bottom: { size: 180, collapsed: false },
    };
    expect(parsePanels(JSON.parse(JSON.stringify(panels)))).toEqual(panels);
  });

  it('falls back to the defaults on missing or corrupted data', () => {
    expect(parsePanels(undefined)).toEqual(DEFAULT_PANELS);
    expect(parsePanels(null)).toEqual(DEFAULT_PANELS);
    expect(parsePanels('text')).toEqual(DEFAULT_PANELS);
  });

  it('keeps what is valid and clamps what is out of bounds', () => {
    const panels = parsePanels({
      sidebar: { size: 9999 },
      bottom: { size: 'big', collapsed: false },
    });
    expect(panels.sidebar).toEqual({ size: PANEL_LIMITS.sidebar.max, collapsed: false });
    expect(panels.bottom).toEqual({ size: PANEL_LIMITS.bottom.default, collapsed: false });
  });
});

describe('fitPanel', () => {
  const sidebar = { size: 400, collapsed: false };

  it('shows the saved size before the first measure', () => {
    expect(fitPanel('sidebar', sidebar, 0)).toBe(400);
  });

  it('shrinks the panel so the center keeps its minimum, down to the panel minimum', () => {
    expect(fitPanel('sidebar', sidebar, 1000)).toBe(400);
    expect(fitPanel('sidebar', sidebar, CENTER_MIN_WIDTH + 300)).toBe(300);
    expect(fitPanel('sidebar', sidebar, 100)).toBe(PANEL_LIMITS.sidebar.min);
  });

  it('applies the height rule to the bottom panel and returns 0 when collapsed', () => {
    const bottom = { size: 300, collapsed: false };
    expect(fitPanel('bottom', bottom, CENTER_MIN_HEIGHT + 200)).toBe(200);
    expect(fitPanel('bottom', { ...bottom, collapsed: true }, 900)).toBe(0);
  });
});

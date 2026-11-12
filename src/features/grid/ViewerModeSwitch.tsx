import { useT } from '../../i18n/useT';
import { SegmentedControl } from '../../ui/SegmentedControl';

/** What the grid's side panel shows: the focused cell (F-064) or the focused row (F-068). */
export type ViewerPanel = 'cell' | 'row';

/** The Cell / Row choice at the top of both panels. */
export function ViewerModeSwitch({
  value,
  onChange,
}: {
  value: ViewerPanel;
  onChange: (mode: ViewerPanel) => void;
}) {
  const t = useT();
  return (
    <SegmentedControl<ViewerPanel>
      label={t('grid.viewer.panel')}
      value={value}
      options={[
        { value: 'cell', label: t('grid.viewer.panel.cell') },
        { value: 'row', label: t('grid.viewer.panel.row') },
      ]}
      onChange={onChange}
    />
  );
}

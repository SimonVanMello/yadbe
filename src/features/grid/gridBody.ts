import type { ValueKind } from '../../ipc';
import { describeCell } from './cellDisplay';
import { isNumericKind } from './cellJson';
import type { Range } from './gridMath';
import type { EditState, RowBlock, RowSource } from './rowSource';
import { isCellSelected, rowTouched, type Selection } from './selection';

/**
 * The rows area of the grid, drawn imperatively: a scroll frame never goes through React.
 * Row and cell elements are recycled (a row leaving the viewport is reused for the one
 * entering), each write is skipped when the element already shows it, and rows are placed with
 * a transform. Only visible rows × visible columns (plus a small overscan) exist in the DOM.
 */

export interface BodyLayout {
  /** Display index → data column. */
  order: readonly number[];
  /** x of each display column after the gutter; `lefts[n]` is the columns' total width. */
  lefts: Float64Array;
  gutterWidth: number;
  rowHeight: number;
}

export interface BodyFrame {
  rows: Range;
  /** Display columns. */
  cols: Range;
  /** A row's y in the rows area is `row * rowHeight - shift` (non-zero past the height cap). */
  shift: number;
  layout: BodyLayout;
  selection: Selection | null;
}

export interface BodyClasses {
  row: string;
  /** One element per run of consecutive rows still loading (a single animation each). */
  placeholder: string;
  gutter: string;
  cell: string;
  num: string;
  null: string;
  empty: string;
  mark: string;
}

export interface BodyLabels {
  null: string;
  empty: string;
  /** Shown instead of NULL in a cell the server will fill in (a new row's default). */
  default?: string;
}

interface CellView {
  el: HTMLDivElement;
  /** Display column. */
  col: number;
  dataCol: number;
  left: number;
  width: number;
  /** What the element shows: `undefined` before it shows a loaded value. */
  text: string | null | undefined;
  kind: ValueKind | null;
  truncated: boolean;
  selected: boolean | null;
  focused: boolean;
  /** Pending-change state shown (`data-state`) and hover text, for table editing. */
  state: EditState | null;
  title: string | null;
}

interface RowView {
  el: HTMLDivElement;
  gutter: HTMLDivElement;
  row: number;
  y: number;
  width: number;
  block: RowBlock | undefined | null;
  loading: boolean | null;
  touched: boolean | null;
  /** Pending-change state of the row (`data-state` on the row and its number). */
  state: EditState | null;
  layout: BodyLayout | null;
  cells: Map<number, CellView>;
  spare: CellView[];
}

export class GridBody {
  private readonly container: HTMLElement;
  private readonly gutters: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly source: RowSource;
  private readonly classes: BodyClasses;
  private readonly focusId: string;
  private labels: BodyLabels;
  private readonly active = new Map<number, RowView>();
  private readonly spare: RowView[] = [];
  private readonly placeholders: HTMLDivElement[] = [];
  private focusEl: HTMLElement | null = null;

  constructor(options: {
    container: HTMLElement;
    /**
     * Holds the row numbers: one sticky layer for the whole gutter (a sticky cell per row
     * costs a compositing layer each).
     */
    gutters: HTMLElement;
    grid: HTMLElement;
    source: RowSource;
    classes: BodyClasses;
    labels: BodyLabels;
    focusId: string;
  }) {
    this.container = options.container;
    this.gutters = options.gutters;
    this.grid = options.grid;
    this.source = options.source;
    this.classes = options.classes;
    this.labels = options.labels;
    this.focusId = options.focusId;
  }

  setLabels(labels: BodyLabels): void {
    if (
      labels.null === this.labels.null &&
      labels.empty === this.labels.empty &&
      labels.default === this.labels.default
    ) {
      return;
    }
    this.labels = labels;
    // Repaint the NULL / empty markers in the new language.
    for (const view of this.active.values()) view.block = null;
  }

  /** Rows currently in the DOM (for tests and measurements). */
  get renderedRows(): number {
    return this.active.size;
  }

  render(frame: BodyFrame): void {
    const { rows } = frame;
    for (const [row, view] of this.active) {
      if (row < rows.start || row >= rows.end) {
        this.active.delete(row);
        for (const cell of view.cells.values()) this.unfocus(cell);
        this.spare.push(view);
      }
    }
    let focusEl: HTMLElement | null = null;
    for (let row = rows.start; row < rows.end; row++) {
      let view = this.active.get(row);
      if (!view) {
        view = this.spare.pop() ?? this.createRow();
        if (view.el.hidden) {
          view.el.hidden = false;
          view.gutter.hidden = false;
        }
        view.row = row;
        view.block = null;
        view.gutter.textContent = String(row + 1);
        view.el.setAttribute('aria-rowindex', String(row + 2));
        this.active.set(row, view);
      }
      const found = this.renderRow(view, frame);
      if (found) focusEl = found;
    }
    for (const view of this.spare) {
      if (!view.el.hidden) {
        view.el.hidden = true;
        view.gutter.hidden = true;
      }
    }
    this.placeLoading(frame);
    this.setFocus(focusEl);
  }

  /** Covers each run of loading rows with one shimmering placeholder. */
  private placeLoading(frame: BodyFrame): void {
    const { rowHeight } = frame.layout;
    let used = 0;
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart < 0) return;
      let el = this.placeholders[used];
      if (!el) {
        el = document.createElement('div');
        el.className = this.classes.placeholder;
        el.setAttribute('aria-hidden', 'true');
        this.container.appendChild(el);
        this.placeholders.push(el);
      }
      used++;
      el.hidden = false;
      el.style.transform = `translateY(${String(runStart * rowHeight - frame.shift)}px)`;
      el.style.height = `${String((end - runStart) * rowHeight)}px`;
      runStart = -1;
    };
    for (let row = frame.rows.start; row < frame.rows.end; row++) {
      const loading = this.active.get(row)?.loading === true;
      if (loading && runStart < 0) runStart = row;
      else if (!loading) flush(row);
    }
    flush(frame.rows.end);
    for (let i = used; i < this.placeholders.length; i++) {
      const el = this.placeholders[i];
      if (el && !el.hidden) el.hidden = true;
    }
  }

  destroy(): void {
    this.active.clear();
    this.spare.length = 0;
    this.container.replaceChildren();
    this.gutters.replaceChildren();
    this.placeholders.length = 0;
    this.setFocus(null);
  }

  private createRow(): RowView {
    const el = document.createElement('div');
    el.className = this.classes.row;
    el.setAttribute('role', 'row');
    const gutter = document.createElement('div');
    gutter.className = this.classes.gutter;
    this.gutters.appendChild(gutter);
    this.container.appendChild(el);
    return {
      el,
      gutter,
      row: -1,
      y: NaN,
      width: NaN,
      block: null,
      loading: null,
      touched: null,
      state: null,
      layout: null,
      cells: new Map(),
      spare: [],
    };
  }

  /** Returns the focused cell's element when this row holds it. */
  private renderRow(view: RowView, frame: BodyFrame): HTMLElement | null {
    const { layout, cols, selection } = frame;
    const { rowHeight, lefts, gutterWidth, order } = layout;
    const y = view.row * rowHeight - frame.shift;
    if (y !== view.y) {
      view.y = y;
      const transform = `translateY(${String(y)}px)`;
      view.el.style.transform = transform;
      view.gutter.style.transform = transform;
    }
    const width = gutterWidth + (lefts[lefts.length - 1] ?? 0);
    if (width !== view.width) {
      view.width = width;
      view.el.style.width = `${String(width)}px`;
    }

    const block = this.source.block(view.row);
    const dataChanged = block !== view.block;
    const layoutChanged = layout !== view.layout;
    view.block = block;
    view.layout = layout;
    const loading = !block;
    if (loading !== view.loading) {
      view.loading = loading;
      view.el.toggleAttribute('data-loading', loading);
    }
    const rowState = block?.rowStates?.[view.row - block.offset] ?? null;
    if (rowState !== view.state) {
      view.state = rowState;
      if (rowState) {
        view.el.setAttribute('data-state', rowState);
        view.gutter.setAttribute('data-state', rowState);
      } else {
        view.el.removeAttribute('data-state');
        view.gutter.removeAttribute('data-state');
      }
    }
    const touched = rowTouched(selection, view.row);
    if (touched !== view.touched) {
      view.touched = touched;
      view.gutter.toggleAttribute('data-touched', touched);
    }

    for (const [col, cell] of view.cells) {
      if (col < cols.start || col >= cols.end) {
        view.cells.delete(col);
        this.unfocus(cell);
        cell.el.hidden = true;
        view.spare.push(cell);
      }
    }

    const index = block ? view.row - block.offset : 0;
    const focus = selection?.focus;
    let focusEl: HTMLElement | null = null;
    for (let col = cols.start; col < cols.end; col++) {
      let cell = view.cells.get(col);
      let fresh = false;
      if (!cell) {
        cell = view.spare.pop() ?? this.createCell(view);
        if (cell.el.hidden) cell.el.hidden = false;
        cell.col = col;
        cell.el.setAttribute('aria-colindex', String(col + 1));
        view.cells.set(col, cell);
        fresh = true;
      }
      if (fresh || layoutChanged) {
        const left = gutterWidth + (lefts[col] ?? 0);
        const cellWidth = (lefts[col + 1] ?? 0) - (lefts[col] ?? 0);
        if (left !== cell.left) {
          cell.left = left;
          cell.el.style.left = `${String(left)}px`;
        }
        if (cellWidth !== cell.width) {
          cell.width = cellWidth;
          cell.el.style.width = `${String(cellWidth)}px`;
        }
        const dataCol = order[col] ?? col;
        if (dataCol !== cell.dataCol) {
          cell.dataCol = dataCol;
          cell.text = undefined;
          cell.kind = null;
        }
      }
      if (fresh || dataChanged || layoutChanged) this.paintCell(cell, block, index);

      const selected = isCellSelected(selection, view.row, col);
      if (selected !== cell.selected) {
        cell.selected = selected;
        cell.el.setAttribute('aria-selected', selected ? 'true' : 'false');
      }
      const focused = !!focus && focus.row === view.row && focus.col === col;
      if (focused !== cell.focused) {
        cell.focused = focused;
        cell.el.toggleAttribute('data-focused', focused);
      }
      if (focused) focusEl = cell.el;
    }
    return focusEl;
  }

  private createCell(view: RowView): CellView {
    const el = document.createElement('div');
    el.className = this.classes.cell;
    el.setAttribute('role', 'gridcell');
    view.el.appendChild(el);
    return {
      el,
      col: -1,
      dataCol: -1,
      left: NaN,
      width: NaN,
      text: undefined,
      kind: null,
      truncated: false,
      selected: null,
      focused: false,
      state: null,
      title: null,
    };
  }

  private paintCell(cell: CellView, block: RowBlock | undefined, index: number): void {
    const { el } = cell;
    if (!block) {
      if (cell.text !== undefined || cell.kind !== null) {
        cell.text = undefined;
        cell.kind = null;
        el.className = this.classes.cell;
        el.textContent = '';
      }
      if (cell.truncated) {
        cell.truncated = false;
        el.removeAttribute('data-truncated');
      }
      this.paintState(cell, null, null);
      return;
    }
    const column = block.columns[cell.dataCol];
    const columnKind = this.source.columns[cell.dataCol]?.kind ?? 'text';
    const text = column?.values[index] ?? null;
    const kind = column?.kinds ? (column.kinds[index] ?? columnKind) : columnKind;
    const truncated = !!column && column.truncated.length > 0 && column.truncated.includes(index);
    if (truncated !== cell.truncated) {
      cell.truncated = truncated;
      el.toggleAttribute('data-truncated', truncated);
    }
    if (column?.states || cell.state !== null) {
      const wasDefault = cell.state === 'default';
      this.paintState(cell, column?.states?.[index] ?? null, column?.titles?.[index] ?? null);
      // The default marker is drawn like NULL with another word.
      if (wasDefault !== (cell.state === 'default')) cell.text = undefined;
    }
    if (text === cell.text && kind === cell.kind) return;
    cell.text = text;
    cell.kind = kind;
    const { classes } = this;
    const display = describeCell(text, kind);
    const base = isNumericKind(kind) ? `${classes.cell} ${classes.num}` : classes.cell;
    switch (display.type) {
      case 'null':
        el.className = `${base} ${classes.null}`;
        el.textContent =
          cell.state === 'default' ? (this.labels.default ?? this.labels.null) : this.labels.null;
        return;
      case 'empty':
        el.className = `${base} ${classes.empty}`;
        el.textContent = this.labels.empty;
        return;
      case 'plain':
        el.className = base;
        el.textContent = display.text;
        return;
      case 'marked': {
        el.className = base;
        const nodes = display.parts.map((part) => {
          if (!part.mark) return document.createTextNode(part.text);
          const span = document.createElement('span');
          span.className = classes.mark;
          span.textContent = part.text;
          return span;
        });
        el.replaceChildren(...nodes);
        return;
      }
    }
  }

  /** The pending-change mark of a cell (only sources that overlay edits have one). */
  private paintState(cell: CellView, state: EditState | null, title: string | null): void {
    if (state !== cell.state) {
      cell.state = state;
      if (state) cell.el.setAttribute('data-state', state);
      else cell.el.removeAttribute('data-state');
    }
    if (title !== cell.title) {
      cell.title = title;
      if (title === null) cell.el.removeAttribute('title');
      else cell.el.title = title;
    }
  }

  /** A recycled cell must not keep the focus mark of the cell it showed. */
  private unfocus(cell: CellView): void {
    if (!cell.focused) return;
    cell.focused = false;
    cell.el.removeAttribute('data-focused');
  }

  private setFocus(el: HTMLElement | null): void {
    if (el === this.focusEl) return;
    if (this.focusEl?.id === this.focusId) this.focusEl.removeAttribute('id');
    this.focusEl = el;
    if (el) {
      el.id = this.focusId;
      this.grid.setAttribute('aria-activedescendant', this.focusId);
    } else {
      this.grid.removeAttribute('aria-activedescendant');
    }
  }
}

/**
 * The documents view's model: a document is a tree of plain values, whatever store it came from
 * (MongoDB's Extended JSON is turned into this by `features/document/ejsonView.ts`, an
 * Elasticsearch `_source` would be by its own adapter). The view shows the documents as one flat
 * list of rows, opened and closed node by node, so that thousands of fields stay virtualized.
 */

/** How a scalar is shown and colored. */
export type DocScalarKind =
  'string' | 'number' | 'bool' | 'null' | 'date' | 'id' | 'binary' | 'other';

export type DocNode =
  | { type: 'object'; entries: [string, DocNode][] }
  | { type: 'array'; items: DocNode[] }
  | {
      type: 'scalar';
      kind: DocScalarKind;
      /** What the row shows (`ObjectId('…')`, `2025-01-06T09:30:00.000Z`, `"text"`). */
      text: string;
      /** A type shown beside the value when it is not obvious (`long`, `decimal`). */
      label: string | null;
      /** The value as JSON text, for a copy (`{"$oid":"…"}` for MongoDB's relaxed form). */
      json: string;
    };

/** One line of the view. */
export interface DocRow {
  /** Stable while the documents stay: `<document>` then the path of the node. */
  key: string;
  /** 0-based index of the document in the result. */
  document: number;
  /** Path segments from the document's root (array indexes as numbers). */
  path: (string | number)[];
  /** The field name or array index shown before the value; `null` for the document's own row. */
  label: string | null;
  depth: number;
  node: DocNode;
  /** Containers only: open (children follow), with how many children. */
  open: boolean;
  size: number;
}

/** A node's key in the open/closed state. */
export function nodeKey(document: number, path: readonly (string | number)[]): string {
  return JSON.stringify([document, ...path]);
}

function sizeOf(node: DocNode): number {
  switch (node.type) {
    case 'object':
      return node.entries.length;
    case 'array':
      return node.items.length;
    case 'scalar':
      return 0;
  }
}

/**
 * Which nodes are open: by default a document shows its top-level fields and nothing deeper;
 * `overrides` holds what the user opened or closed.
 */
export interface Openness {
  /** Depth opened when nothing says otherwise: 1 = the document's fields. */
  depth: number;
  overrides: ReadonlyMap<string, boolean>;
}

export function isOpen(openness: Openness, key: string, depth: number): boolean {
  return openness.overrides.get(key) ?? depth < openness.depth;
}

/**
 * The rows of `documents` (the first being document `offset`), as far as they are open. Missing
 * documents (a window not loaded yet) are skipped by the caller.
 */
export function flattenDocuments(
  documents: readonly (DocNode | undefined)[],
  offset: number,
  openness: Openness,
): DocRow[] {
  const rows: DocRow[] = [];
  const walk = (
    document: number,
    node: DocNode,
    path: (string | number)[],
    label: string | null,
    depth: number,
  ) => {
    const key = nodeKey(document, path);
    const container = node.type !== 'scalar';
    const open = container && isOpen(openness, key, depth);
    rows.push({ key, document, path, label, depth, node, open, size: sizeOf(node) });
    if (!open) return;
    if (node.type === 'object') {
      for (const [name, child] of node.entries)
        walk(document, child, [...path, name], name, depth + 1);
    } else {
      node.items.forEach((child, index) => {
        walk(document, child, [...path, index], String(index), depth + 1);
      });
    }
  };
  documents.forEach((node, index) => {
    if (node) walk(offset + index, node, [], null, 0);
  });
  return rows;
}

/** The dotted path of a node (`items.0.sku`), as MongoDB and most stores write it. */
export function pathText(path: readonly (string | number)[]): string {
  return path.map(String).join('.');
}

/** The JSON text of a node, compact or indented. Scalars keep their own JSON form. */
export function nodeJson(node: DocNode, indent = 0): string {
  const pad = (depth: number) => (indent > 0 ? `\n${' '.repeat(indent * depth)}` : '');
  const write = (current: DocNode, depth: number): string => {
    switch (current.type) {
      case 'scalar':
        return current.json;
      case 'array':
        if (current.items.length === 0) return '[]';
        return `[${current.items.map((item) => `${pad(depth + 1)}${write(item, depth + 1)}`).join(',')}${pad(depth)}]`;
      case 'object': {
        if (current.entries.length === 0) return '{}';
        const separator = indent > 0 ? ': ' : ':';
        return `{${current.entries
          .map(
            ([name, value]) =>
              `${pad(depth + 1)}${JSON.stringify(name)}${separator}${write(value, depth + 1)}`,
          )
          .join(',')}${pad(depth)}}`;
      }
    }
  };
  return write(node, 0);
}

/** A short preview of a closed container (`{ 3 fields }`, `[ 2 items ]` come from i18n). */
export function previewOf(node: DocNode, max = 60): string {
  const text = nodeJson(node);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

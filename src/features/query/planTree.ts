import type { PlanNode } from '../../ipc';

/** A node's share of its plan's own work, 0 when the engine gave nothing to weigh. */
export function weightOf(node: PlanNode): number {
  return node.weight ?? 0;
}

/** How much a node weighs in its plan, for the highlight (F-053). */
export type Heat = 'high' | 'medium' | 'low';

/** A node that does a quarter of the plan's own work or more stands out; a tenth is noted. */
export function heatOf(weight: number): Heat {
  if (weight >= 0.25) return 'high';
  if (weight >= 0.1) return 'medium';
  return 'low';
}

/** Which nodes have children (by id). */
export function parentsOf(nodes: readonly PlanNode[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const node of nodes) if (node.parent !== null) out.add(node.parent);
  return out;
}

/** The nodes to list: pre-order, without the descendants of collapsed ones. */
export function visibleNodes(
  nodes: readonly PlanNode[],
  collapsed: ReadonlySet<number>,
): PlanNode[] {
  const out: PlanNode[] = [];
  let hiddenBelow: number | null = null;
  for (const node of nodes) {
    if (hiddenBelow !== null) {
      if (node.depth > hiddenBelow) continue;
      hiddenBelow = null;
    }
    out.push(node);
    if (collapsed.has(node.id)) hiddenBelow = node.depth;
  }
  return out;
}

/** The nodes worth looking at first: the heaviest, most first. */
export function hottest(nodes: readonly PlanNode[], count: number): PlanNode[] {
  return [...nodes]
    .filter((node) => weightOf(node) > 0)
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, count);
}

/** Rows estimated against rows produced, when both are known: `×12` means 12 times more. */
export function misestimate(node: PlanNode): number | null {
  if (node.estimatedRows === null || node.actualRows === null) return null;
  const estimated = Math.max(node.estimatedRows, 1);
  const actual = Math.max(node.actualRows, 1);
  const ratio = Math.max(estimated / actual, actual / estimated);
  return ratio >= 10 ? Math.round(ratio) : null;
}

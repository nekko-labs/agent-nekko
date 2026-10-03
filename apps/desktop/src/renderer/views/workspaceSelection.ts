/** Modifier selection follows the visible sidebar order, not session recency. */
export function selectWorkspaceRows(current: string[], order: string[], id: string, anchor: string | null, range: boolean): string[] {
  if (range && anchor && order.includes(anchor) && order.includes(id)) {
    const a = order.indexOf(anchor), b = order.indexOf(id);
    return order.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  return current.includes(id) ? current.filter(x => x !== id) : [...current, id];
}

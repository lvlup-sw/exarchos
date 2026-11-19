/** Stable graph order is independent of the submitted claim order. */
export function taskGraphOrder(tasks: readonly string[], edges: readonly { readonly from: string; readonly to: string }[]): string[] {
  const authored = new Map(tasks.map((task, index) => [task, index]));
  const compare = (a: string, b: string) => (authored.get(a) ?? 0) - (authored.get(b) ?? 0);
  const pending = new Map(tasks.map(task => [task, 0]));
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!pending.has(edge.from) || !pending.has(edge.to)) throw new Error('Unknown dependency endpoint');
    pending.set(edge.to, (pending.get(edge.to) ?? 0) + 1);
    const next = children.get(edge.from) ?? [];
    next.push(edge.to); children.set(edge.from, next);
  }
  const ready = tasks.filter(task => pending.get(task) === 0).sort(compare);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const task = ready.shift();
    if (task === undefined) break;
    ordered.push(task);
    for (const child of children.get(task) ?? []) {
      const remaining = (pending.get(child) ?? 0) - 1;
      pending.set(child, remaining);
      if (remaining === 0) { ready.push(child); ready.sort(compare); }
    }
  }
  if (ordered.length !== tasks.length) throw new Error('Cyclic task graph');
  return ordered;
}

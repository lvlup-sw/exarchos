/**
 * Returns the value at a dot-path in an object, or undefined when the path does not exist.
 * A segment can use bracket notation, such as `tasks[0]`.
 */
export function resolveDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const segments = dotPath.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    const bracketMatch = segment.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      current = (current as Record<string, unknown>)[bracketMatch[1] ?? ''];
      if (!Array.isArray(current)) return undefined;
      current = current[parseInt(bracketMatch[2] ?? '0', 10)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

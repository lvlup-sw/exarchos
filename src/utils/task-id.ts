/**
 * Canonical form of a task ID. It removes a leading `T` or `T-` and leading
 * zeros, so every spelling of one task ID compares equal.
 *
 * This leaf module has no dependencies. The orchestrate layer and the views
 * layer both compare task IDs, and one must not import the other.
 */
export function canonicaliseTaskId(id: string): string {
  return id.replace(/^T-?/i, '').replace(/^0+/, '') || '0';
}

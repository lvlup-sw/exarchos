/**
 * Task-ID canonicalisation.
 *
 * Task IDs reach the system in mixed forms — `T-001`, `T001`, `001`, `1` — from
 * plan documents, event emitters, and caller arguments. Comparators must
 * collapse those forms identically or a wave addressed as `T-001` will not match
 * a projection holding `T001`.
 *
 * This is a dependency-free leaf module: both the orchestrate layer
 * (`task-decomposition`) and the views layer (`delegation-readiness-view`)
 * compare task IDs, and neither may import the other.
 */
export function canonicaliseTaskId(id: string): string {
  return id.replace(/^T-?/i, '').replace(/^0+/, '') || '0';
}

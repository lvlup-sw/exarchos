/**
 * The integration observation of a compiler 8-vcs settlement. It reads the tip of the pinned integration ref on the registered checkout of the capsule.
 * The reader is the operator-pinned Git observer of the verifier connector. It reads `scope.checkout` on the pinned ref and never the current branch.
 * A checkout that does not hold the pinned ref, and each refused or failed read, fail closed.
 */

import type { CapsuleScope } from '../../contract/capsule/exarchos-capsule.js';
import { createGitObserver } from '../../utils/git-observer.js';

/** One observation: the tip, the time of the read and each accepted head that is not an ancestor of the tip. Or a refusal with its reason. */
export type IntegrationObservation =
  | { readonly kind: 'observed'; readonly tip: string; readonly observedAt: string; readonly unmerged: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Observe the tip of `ref` on the registered checkout of `scope`, then the ancestry of each head against that tip.
 * The time of the observation is the time after the tip read. A head that is not an ancestor goes into `unmerged`.
 */
export async function observeIntegration(gitPath: string, scope: CapsuleScope, ref: string, heads: readonly string[]): Promise<IntegrationObservation> {
  let observer: Awaited<ReturnType<typeof createGitObserver>>;
  try { observer = await createGitObserver(gitPath); }
  catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }; }
  const input = { checkout: scope.checkout, repository: scope.repository, branch: ref };
  const selected = await observer.checkout(input);
  if (selected.kind !== 'observed') return { kind: 'refused', reason: selected.reason };
  const observedAt = new Date().toISOString();
  const tip = selected.value.head;
  const unmerged: string[] = [];
  for (const head of heads) {
    const relation = await observer.ancestry(input, head, tip);
    if (relation.kind !== 'observed') return { kind: 'refused', reason: relation.reason };
    if (!relation.value) unmerged.push(head);
  }
  return { kind: 'observed', tip, observedAt, unmerged };
}

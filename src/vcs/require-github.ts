/**
 * A guard for orchestrate handlers that run the `gh` CLI. If the configured VCS provider is not
 * GitHub, the guard returns a skipped result, so the handler does not fail with an unclear `gh`
 * error.
 */
import type { VcsProvider } from './provider.js';
import { UnsupportedOperationError } from './provider.js';
import type { ToolResult } from '../format.js';

/**
 * Returns a successful `ToolResult` with `skipped: true` and the `UnsupportedOperationError`
 * message when the VCS provider is not GitHub. It returns `null` when the provider is GitHub or
 * absent, and then the caller can run `gh`. An absent provider means an unconfigured context,
 * where GitHub is the default.
 *
 * ```ts
 * const guard = requiresGitHub(vcsProvider, 'check_pr_comments');
 * if (guard) return guard;
 * ```
 */
export function requiresGitHub(
  vcsProvider: VcsProvider | undefined,
  operation: string,
): ToolResult | null {
  if (!vcsProvider) return null;

  if (vcsProvider.name === 'github') return null;

  const err = new UnsupportedOperationError(vcsProvider.name, operation);
  return {
    success: true,
    data: {
      skipped: true,
      reason: err.message,
      provider: vcsProvider.name,
      operation,
    },
  };
}

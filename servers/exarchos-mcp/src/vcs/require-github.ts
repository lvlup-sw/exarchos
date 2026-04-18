// ─── GitHub Requirement Guard ──────────────���────────────────────────────────
//
// Utility for orchestrate handlers that shell out to `gh` CLI. These handlers
// are inherently GitHub-specific. When the configured VCS provider is not
// GitHub, this guard produces a graceful ToolResult instead of letting the
// handler crash with a confusing `gh: command not found` or unrelated error.
// ────────────────��──────────────────────────���────────────────────────────────

import type { VcsProvider } from './provider.js';
import { UnsupportedOperationError } from './provider.js';
import type { ToolResult } from '../format.js';

/**
 * Returns an `UnsupportedOperationError`-based ToolResult if the configured
 * VCS provider is not GitHub (or is absent). Returns `null` when the provider
 * is GitHub, signalling that the caller may proceed with `gh` CLI calls.
 *
 * Usage:
 * ```ts
 * const guard = requiresGitHub(vcsProvider, 'assess_stack');
 * if (guard) return guard;
 * // ... proceed with gh CLI calls
 * ```
 */
export function requiresGitHub(
  vcsProvider: VcsProvider | undefined,
  operation: string,
): ToolResult | null {
  // When vcsProvider is undefined, we're in an unconfigured context where
  // GitHub is the implicit default — allow the handler to proceed.
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

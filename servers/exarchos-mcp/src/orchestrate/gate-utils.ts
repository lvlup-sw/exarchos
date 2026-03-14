// ─── Gate Utils ──────────────────────────────────────────────────────────────
//
// Shared utility for emitting gate.executed events across gate handlers.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { resolveGateSeverity } from './gate-severity.js';

/**
 * Fetch the unified diff between baseBranch and HEAD.
 * Returns null on failure so callers can distinguish "no diff" from "error".
 */
export function getDiff(repoRoot: string, baseBranch: string): string | null {
  try {
    return execFileSync(
      'git',
      ['diff', `${baseBranch}...HEAD`],
      { cwd: repoRoot, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    return null;
  }
}

/**
 * Emit a gate.executed event to the event store.
 *
 * @param store - The event store to append to
 * @param streamId - The stream (feature) ID
 * @param gateName - Name of the gate (e.g. 'test-suite', 'typecheck', 'design-completeness')
 * @param layer - The workflow layer (e.g. 'CI', 'design', 'planning', 'testing', 'post-merge')
 * @param passed - Whether the gate passed
 * @param details - Optional details payload
 */
export async function emitGateEvent(
  store: EventStore,
  streamId: string,
  gateName: string,
  layer: string,
  passed: boolean,
  details?: Record<string, unknown>,
): Promise<void> {
  await store.append(streamId, {
    type: 'gate.executed',
    data: {
      gateName,
      layer,
      passed,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

// ─── Config-Aware Gate Wrapper ──────────────────────────────────────────────

/**
 * Wraps a gate handler with config-aware severity resolution.
 *
 * - **disabled**: Skips execution entirely, returns success with `skipped: true`
 * - **warning**: Executes handler; converts failures to success with a warning
 * - **blocking**: Executes handler; failures remain failures (default behaviour)
 *
 * When `config` is `undefined`, defaults to blocking (backwards compatible).
 */
export async function withConfigSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig | undefined,
  handler: () => Promise<ToolResult>,
): Promise<ToolResult> {
  // When no config, default to blocking (backwards compat)
  if (!config) {
    return handler();
  }

  const severity = resolveGateSeverity(gateName, dimension, config);

  if (severity === 'disabled') {
    return {
      success: true,
      data: { skipped: true, reason: `Gate '${gateName}' disabled by project config` },
    };
  }

  const result = await handler();

  // If gate passed, return as-is regardless of severity
  if (result.success) return result;

  // If severity is 'warning', convert failure to success with warning
  if (severity === 'warning') {
    return {
      success: true,
      data: result.data ?? result.error,
      warnings: [`Gate '${gateName}' failed but is configured as warning-only`],
    };
  }

  // Blocking: return failure as-is
  return result;
}

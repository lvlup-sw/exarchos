/**
 * Detects when the CLI and the Claude Code plugin resolve different event-store paths.
 * When the paths differ, workflow state that one surface writes is invisible to the other.
 * The check only detects the split. It does not move or merge databases.
 * The fix sets `WORKFLOW_STATE_DIR`, which wins the precedence in both modes.
 * The comparison reads `probes.env`, so the check does not change `process.env`.
 */

import { posix as pathPosix } from 'node:path';
import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';
import { computeStorePathDivergence } from '../../../utils/paths.js';

export async function storePathDivergence(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const start = Date.now();
  const base = { category: 'storage' as const, name: 'store-path-divergence' };

  const { cliPath, pluginPath, diverges } = computeStorePathDivergence({
    env: probes.env,
  });

  if (!diverges) {
    return {
      ...base,
      status: 'Pass',
      message: `CLI and Claude Code plugin resolve the same event store (${cliPath})`,
      durationMs: Date.now() - start,
    };
  }

  const suggestedDir = pathPosix.dirname(cliPath);
  return {
    ...base,
    status: 'Warning',
    message:
      `Divergent event-store paths: the CLI resolves ${cliPath} but the Claude Code plugin ` +
      `resolves ${pluginPath}. Workflow state written by one surface is invisible to the other.`,
    fix:
      `Pin both surfaces to one store by exporting WORKFLOW_STATE_DIR to a single absolute ` +
      `directory (it wins the precedence in CLI and plugin mode), e.g. ` +
      `export WORKFLOW_STATE_DIR="${suggestedDir}". Moving or merging existing databases is a ` +
      `separate migration step — this check only detects the split.`,
    durationMs: Date.now() - start,
  };
}

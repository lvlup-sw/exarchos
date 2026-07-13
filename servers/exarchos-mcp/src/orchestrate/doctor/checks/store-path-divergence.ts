/**
 * store-path-divergence (DR-11 B-5) — detect when the CLI surface and the
 * Claude Code plugin surface resolve DIFFERENT event-store paths on this
 * machine.
 *
 * Both surfaces run the ONE shared `resolveStorePath` cascade
 * (`utils/paths.ts`), so they can only diverge on the plugin-mode branch:
 * a bare CLI defaults to `~/.exarchos/state/exarchos.db` while the plugin
 * (launched with `CLAUDE_PLUGIN_ROOT` set) defaults to
 * `~/.claude/workflow-state/exarchos.db`. When they differ, workflow state
 * written by one surface is invisible to the other — a silent state split.
 *
 * This check is read-only detection + a documented remediation: the in-scope
 * floor (DR-11 B-5) is detection + precedence, NOT a store migration (moving
 * or merging existing databases is explicitly out of scope). The fix pins both
 * surfaces to one store via `WORKFLOW_STATE_DIR`, which wins the precedence in
 * both plugin and non-plugin mode.
 *
 * The comparison is computed over `probes.env` (the injected env snapshot) via
 * `computeStorePathDivergence`, so the check never mutates `process.env` and is
 * hermetically testable (DIM-4).
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

  // Suggest a single shared directory (the CLI default) as the unification
  // target. Setting WORKFLOW_STATE_DIR wins the precedence on BOTH surfaces.
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

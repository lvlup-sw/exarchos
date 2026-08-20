/**
 * env-variables — scan the injected env snapshot for EXARCHOS_* keys and
 * warn on any unknown names. The authoritative `KNOWN` list mirrors every
 * `process.env.EXARCHOS_*` lookup in the MCP server source tree; update
 * it when a new variable is introduced so this check stays accurate.
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

/**
 * Every `EXARCHOS_*` name the source reads from an environment.
 *
 * Hand-maintained, and it had drifted: seventeen variables the tree actually
 * looks up were absent, so `doctor` reported a SUPPORTED variable as unknown
 * and told the operator to remove it. A diagnostic that flags correct
 * configuration as a fault is worse than one that stays quiet, because the
 * suggested fix breaks a working setup.
 *
 * The list is kept sorted so an addition is a one-line diff at the right place
 * rather than an append that hides a duplicate.
 */
const KNOWN: ReadonlySet<string> = new Set([
  'EXARCHOS_ALLOW_STORE_DIVERGENCE',
  'EXARCHOS_API_TOKEN',
  'EXARCHOS_BUILD_VERSION',
  'EXARCHOS_CACHE_DIR',
  'EXARCHOS_CLI_ENVELOPE',
  'EXARCHOS_DIRECTIVE',
  'EXARCHOS_DISABLE_CACHE_HINTS',
  'EXARCHOS_EVAL_CAPTURE',
  'EXARCHOS_EVAL_CAPTURE_DIR',
  'EXARCHOS_EVENT_TYPE',
  'EXARCHOS_FAMILY',
  'EXARCHOS_FEATURE_ID',
  'EXARCHOS_INSTALL_STATE_DIR',
  'EXARCHOS_LINT_STRICT',
  'EXARCHOS_LOG_LEVEL',
  'EXARCHOS_MAX_CACHE_ENTRIES',
  'EXARCHOS_MAX_IDEMPOTENCY_KEYS',
  'EXARCHOS_MCP_ENTRY',
  'EXARCHOS_ORIENTATION',
  'EXARCHOS_ORIENTATION_AUTHORITY',
  'EXARCHOS_OUTPUT_ROOT',
  'EXARCHOS_OUTPUT_VALIDATE',
  'EXARCHOS_PACKAGE_NAME',
  'EXARCHOS_PHASE',
  'EXARCHOS_PLUGIN_ROOT',
  'EXARCHOS_PREFLIGHT_DEBUG',
  'EXARCHOS_PROJECT_ROOT',
  'EXARCHOS_RUNTIMES_FROM_DISK',
  'EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS',
  'EXARCHOS_SKIP_HOOKS',
  'EXARCHOS_SNAPSHOT_INTERVAL',
  'EXARCHOS_TASKS_DIR',
  'EXARCHOS_TASK_ID',
  'EXARCHOS_TEAMS_DIR',
  'EXARCHOS_TELEMETRY',
  'EXARCHOS_VCS_PROVIDER',
  'EXARCHOS_WORKFLOW_TYPE',
]);

export async function envVariables(
  probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  const base = { category: 'env' as const, name: 'variables', durationMs: 0 };
  const unknown = Object.keys(probes.env)
    .filter((k) => k.startsWith('EXARCHOS_') && !KNOWN.has(k))
    .sort();

  if (unknown.length === 0) {
    return { ...base, status: 'Pass', message: 'All EXARCHOS_* environment variables recognized' };
  }
  return {
    ...base,
    status: 'Warning',
    message: `Unknown variable ${unknown.join(', ')} set`,
    fix: 'Remove unknown variable or check documentation for supported EXARCHOS_* vars',
  };
}

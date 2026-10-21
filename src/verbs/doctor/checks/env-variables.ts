/**
 * Doctor check that warns on unknown `EXARCHOS_*` names in the environment snapshot.
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';
import { PLUGIN_MODE_ENV_KEYS, STORE_LOCATION_ENV_KEYS } from '../../../utils/paths.js';

/**
 * The `EXARCHOS_*` names that the source reads from the environment.
 * A missing name makes `doctor` tell the operator to remove a supported variable.
 * The store keys and the plugin-mode keys come from the lists of the path resolvers, so the two cannot drift.
 * Keep the literal names sorted, so that a duplicate is easy to see.
 */
const KNOWN: ReadonlySet<string> = new Set([
  ...[...Object.values(STORE_LOCATION_ENV_KEYS), ...PLUGIN_MODE_ENV_KEYS].filter((key) => key.startsWith('EXARCHOS_')),
  'EXARCHOS_ALLOW_STORE_DIVERGENCE',
  'EXARCHOS_BUILD_RELEASE_TAG',
  'EXARCHOS_BUILD_VERSION',
  'EXARCHOS_CLI_ENVELOPE',
  'EXARCHOS_DIRECTIVE',
  'EXARCHOS_DISABLE_CACHE_HINTS',
  'EXARCHOS_EVAL_CAPTURE',
  'EXARCHOS_EVAL_CAPTURE_DIR',
  'EXARCHOS_EVENT_TYPE',
  'EXARCHOS_FAMILY',
  'EXARCHOS_FEATURE_ID',
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
  'EXARCHOS_PREFLIGHT_DEBUG',
  'EXARCHOS_PROJECT_ROOT',
  'EXARCHOS_RUNTIMES_FROM_DISK',
  'EXARCHOS_SIDECAR_DRAIN_INTERVAL_MS',
  'EXARCHOS_SKIP_HOOKS',
  'EXARCHOS_SNAPSHOT_INTERVAL',
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

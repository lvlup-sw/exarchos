/**
 * env-variables — scan the injected env snapshot for EXARCHOS_* keys and
 * warn on any unknown names. The authoritative `KNOWN` list mirrors every
 * `process.env.EXARCHOS_*` lookup in the MCP server source tree; update
 * it when a new variable is introduced so this check stays accurate.
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

const KNOWN: ReadonlySet<string> = new Set([
  'EXARCHOS_PLUGIN_ROOT',
  'EXARCHOS_PROJECT_ROOT',
  'EXARCHOS_LOG_LEVEL',
  'EXARCHOS_TELEMETRY',
  'EXARCHOS_SKIP_HOOKS',
  'EXARCHOS_FEATURE_ID',
  'EXARCHOS_TASK_ID',
  'EXARCHOS_TEAMS_DIR',
  'EXARCHOS_TASKS_DIR',
  'EXARCHOS_API_TOKEN',
  'EXARCHOS_EVAL_CAPTURE',
  'EXARCHOS_EVAL_CAPTURE_DIR',
  'EXARCHOS_MAX_CACHE_ENTRIES',
  'EXARCHOS_SNAPSHOT_INTERVAL',
  'EXARCHOS_MAX_IDEMPOTENCY_KEYS',
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

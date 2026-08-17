/**
 * remote-mcp-stub — seeds the `remote` category in doctor output as an
 * intentionally deferred surface. Always Skipped until basileus integration
 * (#1081) ships, at which point this file will be replaced by a real
 * connectivity probe. Performs no work (durationMs: 0).
 */

import type { CheckResult } from '../schema.js';
import type { DoctorProbes } from '../probes.js';

export async function remoteMcpStub(
  _probes: DoctorProbes,
  _signal: AbortSignal,
): Promise<CheckResult> {
  return {
    category: 'remote',
    name: 'remote-mcp',
    status: 'Skipped',
    reason: 'Remote MCP not configured; basileus integration pending (#1081)',
    durationMs: 0,
    message: 'Remote MCP connectivity probe is deferred until basileus ships',
  };
}

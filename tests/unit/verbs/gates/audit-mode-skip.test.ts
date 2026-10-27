/**
 * The audit mode of the implement phase softens a failing verdict, and it never softens a skip.
 *
 * The subject is `withGateSeverity`. The workflow type of each call is `oneshot`, whose implement phase is in audit mode.
 * A skip with `passed: false` says that the gate did not run, so the wrapper keeps the carrier as the handler returned it.
 * The contrast is a failing verdict of the same call, which the audit mode makes advisory.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULTS, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { withGateSeverity } from '../../../../src/verbs/gates/gate-severity.js';
import { resolvePhaseMode } from '../../../../src/verbs/gates/gate-utils.js';

/** The descriptor of the static-analysis gate, as the wrapper reads it. It is the one gate that emits a skip with `passed: false`. */
const STATIC_ANALYSIS = { name: 'check_static_analysis', dimension: 'D2', signal: false };

/** The workflow type whose implement phase is in audit mode. */
const ONESHOT = 'oneshot';

/** The state directory of each call. The wrapper reads no store, because the workflow type comes from a stub. */
const UNUSED_STATE_DIR = '/unused-audit-mode-skip-state';

/** A config that makes the static analysis blocking, so only the audit mode can soften its verdict. */
const BLOCKING: ResolvedProjectConfig = {
  ...DEFAULTS,
  review: { ...DEFAULTS.review, gates: { check_static_analysis: { enabled: true, blocking: true, params: {} } } },
};

/** The skip of a static analysis that found no toolchain. The gate did not run, so the carrier does not pass. */
async function noToolchainSkip(): Promise<ToolResult> {
  return { success: true, data: { passed: false, skipped: true, discriminant: 'no-toolchain' } };
}

/** A failing verdict of a gate that ran. */
async function failingVerdict(): Promise<ToolResult> {
  return { success: true, data: { passed: false } };
}

/** Runs one handler through the wrapper, in a oneshot call under the given project config. */
async function inAuditMode(
  handler: () => Promise<ToolResult>,
  projectConfig: ResolvedProjectConfig,
): Promise<ToolResult> {
  const context: DispatchContext = {
    stateDir: UNUSED_STATE_DIR,
    eventStore: new EventStore(UNUSED_STATE_DIR),
    enableTelemetry: false,
    projectConfig,
  };
  const wrapped = withGateSeverity(STATIC_ANALYSIS, handler, async () => ONESHOT);
  return wrapped({ featureId: 'feat-audit-mode-skip' }, UNUSED_STATE_DIR, context);
}

describe('the audit mode of the implement phase never softens a skip', () => {
  /**
   * Under a blocking config, the skip keeps `passed: false` and gets no warning.
   * The failing verdict of the same call becomes advisory with the audit-mode warning.
   * The shipped defaults make a oneshot ladder gate warning-only, and the skip stays there too.
   */
  it('GateSeverity_AnAuditModeSkip_KeepsPassedFalseAndGetsNoWarning', async () => {
    expect(resolvePhaseMode('IMPLEMENT', ONESHOT)).toBe('audit');

    expect(await inAuditMode(noToolchainSkip, BLOCKING)).toEqual({
      success: true,
      data: { passed: false, skipped: true, discriminant: 'no-toolchain' },
    });
    expect(await inAuditMode(noToolchainSkip, DEFAULTS)).toEqual({
      success: true,
      data: { passed: false, skipped: true, discriminant: 'no-toolchain' },
    });

    expect(await inAuditMode(failingVerdict, BLOCKING)).toEqual({
      success: true,
      data: { passed: true },
      warnings: [
        "Gate 'check_static_analysis' failed but the implement phase is in audit mode (finding recorded, non-blocking)",
      ],
    });
  });
});

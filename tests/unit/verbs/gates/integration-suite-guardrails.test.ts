/**
 * Guardrails of `check_integration_suite`: its description says when not to use it, and its runner never reads a missing status as exit 1.
 *
 * The description case reads the registered action. The runner case replaces `runCommandSync` with a stub that throws.
 * The error of the stub has no numeric status. It also has no code of a command that did not start. So the runner gives no red exit.
 * The producer is a pass-through, so the runner case reads the carrier that the gate builds.
 *
 * @oracle-sources: ../../../../src/registry/actions/orchestrate/gates.ts, ../../../../src/verbs/gates/check-integration-suite.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/utils/process.js')>();
  return { ...actual, runCommandSync: vi.fn() };
});

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/durable-gate-producer.js')>();
  return {
    ...actual,
    runDurableGateProducer: (_scope: unknown, executeProvider: () => Promise<unknown>) => executeProvider(),
  };
});

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { gateActions } from '../../../../src/registry/actions/orchestrate/gates.js';
import { runCommandSync } from '../../../../src/utils/process.js';
import { execCommandRunner, handleCheckIntegrationSuite } from '../../../../src/verbs/gates/check-integration-suite.js';
import { NO_EXIT_STATUS } from '../../../../src/verbs/pure/integration-suite.js';
import type { CommandResult } from '../../../../src/verbs/pure/static-analysis.js';
import { isolatedSync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { integrationTerm, pinnedIntegrationProfile } from '../../../helpers/verification-profile.js';

/** The most characters that the description of the action can hold. */
const DESCRIPTION_MAX_CHARS = 560;

/** The errors that the stub runner throws. One has no code. The other has a code outside the codes of a command that did not start. */
const RUNNER_ERRORS: readonly (readonly [string, Error])[] = [
  ['no code', new Error('the runner failed')],
  ['a code outside the spawn set', Object.assign(new Error('the runner failed'), { code: 'EIO' })],
];

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  vi.mocked(runCommandSync).mockReset();
  stateDir = makeTempDir('integration-suite-guardrails-');
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** True for an object record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The carrier of a gate call that reads one run of the runner. The pin holds the suite of this repository, with the red code 1. */
async function carrierOfRun(run: CommandResult): Promise<Readonly<Record<string, unknown>>> {
  const pin = pinnedIntegrationProfile(4, integrationTerm(['npm', 'run', 'test:run']));
  const result: ToolResult = await handleCheckIntegrationSuite(
    { featureId: 'feat-integration-guardrails', repoRoot: '/repo', verificationProfile: pin },
    stateDir,
    store,
    () => run,
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isRecord(result.data)) throw new Error(`the gate returned no carrier: ${JSON.stringify(result)}`);
  return result.data;
}

describe('check_integration_suite guardrails', () => {
  /**
   * Each tool says when not to use it. The killing assertion: the description holds the clause that
   * sends the scoped tests of one task to `check_static_analysis` and `check_test_adequacy`.
   */
  it('IntegrationSuite_TheActionDescription_SaysWhenNotToUseIt', () => {
    const action = gateActions.find((candidate) => candidate.name === 'check_integration_suite');
    if (action === undefined) throw new Error('no check_integration_suite action is registered');

    expect(action.description).toMatch(/Do NOT use for one task's scoped tests: use check_static_analysis \/ check_test_adequacy\./);
    expect(action.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  /**
   * A thrown error with no numeric status and no spawn code gives no exit status. So the red code 1 cannot read it as a failure.
   * The task changes no code of this path, so this case is a twin of the description case.
   */
  it('IntegrationSuite_ARunnerErrorWithNoStatusAndNoSpawnCode_IsNeverExitOne', async () => {
    for (const [label, error] of RUNNER_ERRORS) {
      vi.mocked(runCommandSync).mockImplementation(() => {
        throw error;
      });

      const run = await isolatedSync(() => execCommandRunner('suite-runner', [], { cwd: stateDir }));

      expect(run.exitCode, label).not.toBe(1);
      expect(run.exitCode, label).toBe(NO_EXIT_STATUS);
      expect(await carrierOfRun(run), label).toMatchObject({ passed: false, verdict: 'indeterminate' });
    }
    expect(vi.mocked(runCommandSync)).toHaveBeenCalledTimes(RUNNER_ERRORS.length);
  });
});

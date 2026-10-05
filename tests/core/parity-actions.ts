/**
 * The action table and the per-action assertion helper of the CLI and MCP parity gate, so
 * `parity.test.ts` holds only the table loop. To cover one more workflow action, add its name to
 * {@link WORKFLOW_ACTIONS} and a spec to {@link ACTION_TABLE}. The test file fails when the two
 * lists differ.
 */

import { expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../../src/adapters/cli/cli.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../unit/parity-harness.js';

/**
 * The `exarchos_workflow` actions that the parity gate covers. The list is written by hand and
 * does not read the registry. `as const` gives the {@link WorkflowAction} union, so a spec with
 * another action name does not compile.
 */
export const WORKFLOW_ACTIONS = [
  'init',
  'get',
  'transition',
  'cancel',
  'cleanup',
  'reconcile',
  'checkpoint',
  'describe',
  'rehydrate',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/** The parity call of one action. A spec is a plain record, so one loop drives every action. */
export interface ActionSpec {
  readonly action: WorkflowAction;
  /** The Commander command name. It equals the MCP action name, except that `get` is `status`. */
  readonly cliActionFlag: string;
  /**
   * The arguments for both adapters. For the CLI arm, the harness turns an object value into a
   * JSON string. The MCP arm gets each value unchanged.
   */
  readonly args: Record<string, unknown>;
  /**
   * When true, an `init` call seeds each arm before the target action, because the action needs
   * existing state. The seed goes through MCP dispatch on the state directory of each arm.
   */
  readonly requiresInitSeed: boolean;
}

/** The fixture that the test file passes to {@link assertActionParity}. */
export interface ParityFixture {
  readonly cliDir: string;
  readonly mcpDir: string;
  readonly cliCtx: DispatchContext;
  readonly mcpCtx: DispatchContext;
}

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/**
 * Makes one temporary state directory for each arm, each with a fresh `EventStore` and with
 * telemetry off. {@link teardownFixture} removes them.
 */
export async function setupFixture(): Promise<ParityFixture> {
  const cliDir = await mkdtemp(path.join(tmpdir(), 'exarchos-parity-all-cli-'));
  const mcpDir = await mkdtemp(path.join(tmpdir(), 'exarchos-parity-all-mcp-'));
  return {
    cliDir,
    mcpDir,
    cliCtx: makeCtx(cliDir),
    mcpCtx: makeCtx(mcpDir),
  };
}

/** Removes the two temporary state directories. */
export async function teardownFixture(fixture: ParityFixture): Promise<void> {
  await rmrfAsync(fixture.cliDir);
  await rmrfAsync(fixture.mcpDir);
}

/**
 * Removes the values that differ between two runs.
 *
 * - `_perf` goes, because the two arms take different code paths and their durations differ.
 * - Timestamps and UUIDs become placeholders, so a missing field still shows as a diff.
 * - `minutesSinceActivity` becomes `<MINUTES>`, because the value can cross a minute boundary
 *   between the two calls.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
  });
}

/**
 * One spec with small valid arguments for each covered action.
 *
 * - `cancel` uses `dryRun: true`, so the compensation runs in dry-run mode and the phase does not
 *   change.
 * - `cleanup` uses `mergeVerified: true` and `dryRun: true`, so the call makes no terminal
 *   transition.
 * - `describe` takes no feature id and returns the schema of the named action.
 */
export const ACTION_TABLE: readonly ActionSpec[] = [
  {
    action: 'init',
    cliActionFlag: 'init',
    args: { featureId: 'parity-all-init', workflowType: 'feature' },
    requiresInitSeed: false,
  },
  {
    action: 'get',
    cliActionFlag: 'status',
    args: { featureId: 'parity-all-get', query: 'phase' },
    requiresInitSeed: true,
  },
  {
    /**
     * A feature workflow starts in `plan`, so this call targets the current phase. The gate
     * compares the two envelopes and needs no phase change.
     */
    action: 'transition',
    cliActionFlag: 'transition',
    args: {
      featureId: 'parity-all-transition',
      target: 'plan',
    },
    requiresInitSeed: true,
  },
  {
    action: 'cancel',
    cliActionFlag: 'cancel',
    args: { featureId: 'parity-all-cancel', dryRun: true },
    requiresInitSeed: true,
  },
  {
    action: 'cleanup',
    cliActionFlag: 'cleanup',
    args: {
      featureId: 'parity-all-cleanup',
      mergeVerified: true,
      dryRun: true,
    },
    requiresInitSeed: true,
  },
  {
    action: 'reconcile',
    cliActionFlag: 'reconcile',
    args: { featureId: 'parity-all-reconcile' },
    requiresInitSeed: true,
  },
  {
    action: 'checkpoint',
    cliActionFlag: 'checkpoint',
    args: { featureId: 'parity-all-checkpoint', summary: 'parity' },
    requiresInitSeed: true,
  },
  {
    action: 'describe',
    cliActionFlag: 'describe',
    args: { actions: ['init'] },
    requiresInitSeed: false,
  },
  {
    action: 'rehydrate',
    cliActionFlag: 'rehydrate',
    args: { featureId: 'parity-all-rehydrate' },
    requiresInitSeed: true,
  },
];

/**
 * Runs the target action through both adapters and asserts that the normalized envelopes are
 * equal. When `requiresInitSeed` is true, an `init` call for a `feature` workflow seeds each arm
 * first.
 *
 * The CLI exit code must agree with the MCP `success` flag: `SUCCESS` on both arms, or not
 * `SUCCESS` on both. That check finds an error code with a wrong mapping in `CLI_EXIT_CODES`.
 *
 * The harness results keep their inferred envelope type. A `ToolResult` annotation does not
 * typecheck, because the envelope has a wider `_eventHints`.
 */
export async function assertActionParity(
  fixture: ParityFixture,
  spec: ActionSpec,
): Promise<void> {
  if (spec.requiresInitSeed) {
    const featureId =
      typeof spec.args.featureId === 'string'
        ? spec.args.featureId
        : undefined;
    if (featureId === undefined) {
      throw new Error(
        `Spec for "${spec.action}" is marked requiresInitSeed but has no string featureId in args`,
      );
    }
    await harnessCallMcp(fixture.mcpCtx, 'exarchos_workflow', {
      action: 'init',
      featureId,
      workflowType: 'feature',
    });
    await harnessCallMcp(fixture.cliCtx, 'exarchos_workflow', {
      action: 'init',
      featureId,
      workflowType: 'feature',
    });
  }

  const mcpResult = await harnessCallMcp(
    fixture.mcpCtx,
    'exarchos_workflow',
    { action: spec.action, ...spec.args },
  );

  const { result: cliResult, exitCode } = await harnessCallCli(
    fixture.cliCtx,
    'wf',
    spec.cliActionFlag,
    spec.args,
  );

  if (mcpResult.success) {
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
  } else {
    expect(exitCode).not.toBe(CLI_EXIT_CODES.SUCCESS);
  }

  expect(normalize(cliResult)).toEqual(normalize(mcpResult));
}

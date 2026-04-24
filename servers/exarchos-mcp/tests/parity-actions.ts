/**
 * T045 — parity action table + per-action assertion helper.
 *
 * Keeps `parity.test.ts` declarative (data + a single for-loop) and
 * centralizes the invoke-both-arms-and-normalize flow here. Downstream
 * follow-ups that add a workflow action should add an entry to
 * {@link ACTION_TABLE}; the exhaustiveness sentinel in the test file
 * guarantees new actions surface as a named failure instead of silent
 * parity drift.
 */

import { expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { CLI_EXIT_CODES } from '../src/adapters/cli.js';
import type { DispatchContext } from '../src/core/dispatch.js';
import { EventStore } from '../src/event-store/store.js';
import type { ToolResult } from '../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../src/__tests__/parity-harness.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Canonical list of `exarchos_workflow` actions. Kept as a const so the
 * action-table's readonly spec type is exhaustive at the type level —
 * a new composite action will fail to compile here before it can silently
 * bypass the parity gate.
 */
export const WORKFLOW_ACTIONS = [
  'init',
  'get',
  'set',
  'cancel',
  'cleanup',
  'reconcile',
  'checkpoint',
  'describe',
  'rehydrate',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/**
 * Descriptor for a single action's parity invocation.
 *
 * Data-only: keeping per-action specs as plain records (rather than
 * individual test functions) lets the driver loop iterate uniformly and
 * keeps the failure report shape consistent across actions.
 */
export interface ActionSpec {
  readonly action: WorkflowAction;
  /**
   * CLI sub-command alias (Commander command name). Most actions share
   * their name with the MCP action; `get` is the exception (`wf status`).
   */
  readonly cliActionFlag: string;
  /**
   * Args passed to both adapters. For the CLI arm, objects are
   * JSON-stringified by the harness; for the MCP arm they flow through
   * unchanged.
   */
  readonly args: Record<string, unknown>;
  /**
   * When true, both arms are seeded with an `init` call before the target
   * action runs — the action needs existing state to operate on. Seeding
   * is done through the MCP dispatch path on each arm's own tmp state dir.
   */
  readonly requiresInitSeed: boolean;
}

/** Fixture shape the test file threads into {@link assertActionParity}. */
export interface ParityFixture {
  readonly cliDir: string;
  readonly mcpDir: string;
  readonly cliCtx: DispatchContext;
  readonly mcpCtx: DispatchContext;
}

// ─── Fixture lifecycle ──────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

/**
 * Allocate two isolated tmp state dirs (CLI arm + MCP arm) wired up with
 * fresh EventStores and telemetry disabled. Paired with {@link teardownFixture}.
 *
 * Kept here (not in the test file) so the per-suite `beforeEach`/`afterEach`
 * collapse to a single line each — the test file's role is to express
 * coverage, not fiddle with lifecycle.
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

/**
 * Release the two tmp state dirs. Uses `force: true` so a crash mid-run
 * during a later test doesn't chain-fail subsequent cleanup.
 */
export async function teardownFixture(fixture: ParityFixture): Promise<void> {
  await rm(fixture.cliDir, { recursive: true, force: true });
  await rm(fixture.mcpDir, { recursive: true, force: true });
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Drop jitter / non-deterministic fields.
 *
 * - `_perf` is dropped wholesale: `_perf.ms` is wall-clock measurement
 *   and the CLI and MCP arms run through different code paths (Commander
 *   vs direct dispatch), so durations naturally differ.
 * - Timestamps (ISO 8601) and UUIDs are placeholder-replaced (not dropped)
 *   so a shape-level mismatch (missing field vs. mistyped field) still
 *   surfaces as a diff.
 * - `minutesSinceActivity` is keyed out to `<MINUTES>`: the value is
 *   computed as `floor((now - activityTime) / 60_000)` and can cross a
 *   minute boundary between the two arm invocations on slow CI runners.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
    dropKeys: new Set(['_perf']),
  });
}

// ─── Action table ───────────────────────────────────────────────────────────

/**
 * Minimal-valid-args table for every workflow action.
 *
 * Seeded actions (`requiresInitSeed: true`) are primed with an `init` call
 * on both arms before the target action runs. The args chosen for each
 * action exercise a success path through the handler:
 *
 *   - `cancel` with `dryRun: true` — avoids the compensation-event cascade
 *     (which would make the fixture a saga test, not a parity gate).
 *   - `cleanup` with `mergeVerified: true` + `dryRun: true` — likewise
 *     skips terminal-transition side effects while still returning the
 *     non-error envelope shape the gate asserts on.
 *   - `set` with an `artifacts.*` dotted-path update — hits the field-merge
 *     branch without firing an HSM phase transition (phase transitions
 *     bring in guard-dependent payloads that would dominate the diff).
 *   - `describe` with `actions: ['init']` — no feature id; returns schema
 *     catalog for the named action.
 *   - `rehydrate` requires the rehydration reducer to be registered with
 *     the default projection registry. The test file handles that via a
 *     side-effect import.
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
    action: 'set',
    cliActionFlag: 'set',
    args: {
      featureId: 'parity-all-set',
      updates: { 'artifacts.design': 'docs/design.md' },
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

// ─── Parity assertion helper ────────────────────────────────────────────────

/**
 * Run the target action through both adapters against the shared fixture
 * and assert normalized byte-equality of the envelope.
 *
 * Seeding note: when `requiresInitSeed` is true, both arms are primed with
 * `init(featureId, 'feature')` against their own tmp state dirs. This
 * matches the T014 parity convention — we are asserting the target
 * action's envelope, and a deterministic init is the cheapest way to
 * establish the pre-state both arms need.
 *
 * Exit-code contract (DR-3): the CLI arm's exit code must agree with the
 * MCP arm's `success` discriminator. SUCCESS on both or not-SUCCESS on
 * both — never mixed. Collapsing to a single check keeps the gate simple
 * while still catching divergent exit-code mappings (which historically
 * shipped as bugs when new error codes weren't wired into CLI_EXIT_CODES).
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

  const mcpResult: ToolResult = await harnessCallMcp(
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

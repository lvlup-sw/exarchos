// ─── CLI ⇄ MCP differential fixtures (P03-05) ────────────────────────────────
//
// PROGRAM-03, API-005. The exit-proof's second half: "generated CLI and MCP
// results agree by construction." Both surfaces are projections of ONE contract
// handler (`dispatch`): the MCP wire renders a `ToolResult` via `toEnvelope`
// into `structuredContent`; the generated CLI client renders the SAME
// `ToolResult` via the SAME `toEnvelope` to stdout, and resolves its process
// exit code from the SAME frozen P03-02 exit-code authority (`exitCodeForError`,
// which `adapters/cli.resolveExitCode` now delegates to). So for any dispatched
// result the two surfaces cannot disagree — this table is the differential
// witness the co-located test drives through BOTH surfaces.
//
// Each case pins a `ToolResult` a real dispatch could return (success + one
// representative from every failure family + the two bounded-wait codes),
// together with a VALID CLI argv (passes the CLI-layer Zod so the mocked
// dispatch is actually reached) and the stable exit code the contract assigns.
// The exit-code mapping is action-independent, so error cases ride a single
// simple vehicle command (`wf status`); the success case rides `wf init`.
//
// Named `*-fixtures.ts` — the `test-fixtures` module-intent class (test-only
// data, not a production import target).
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import {
  exitCodeForError,
  CONTRACT_EXIT_CODES,
  type FailureLayer,
} from '../error-families.js';

/** One CLI⇄MCP differential case. */
export interface DifferentialCase {
  /** Stable case name (also the test label). */
  readonly name: string;
  /** The failure family exercised, or `'success'` for the happy path. */
  readonly family: FailureLayer | 'success';
  /**
   * The full CLI argv the user types (after the `node exarchos` prefix). Chosen
   * to pass CLI-layer validation so the (mocked) contract handler is reached.
   */
  readonly argv: readonly string[];
  /** The `ToolResult` the shared contract handler (`dispatch`) returns. */
  readonly result: ToolResult;
  /** The stable process exit code the contract assigns to `result`. */
  readonly expectedExit: number;
}

/**
 * The stable exit code the CONTRACT assigns to a dispatched result — the single
 * source both surfaces resolve against. Success is always 0; every failure maps
 * through the frozen registry via {@link exitCodeForError}. `adapters/cli`'s
 * `resolveExitCode` computes exactly this, so CLI ≡ contract by construction.
 */
export function contractExitForResult(result: ToolResult): number {
  if (result.success) return CONTRACT_EXIT_CODES.SUCCESS;
  return exitCodeForError(result.error?.code);
}

const VEHICLE_STATUS_ARGV = ['wf', 'status', '--feature-id', 'diff-demo'] as const;

/**
 * The differential witness set. Every failure family is represented at least
 * once, plus the two bounded-wait codes and the success path. Results carry only
 * stable, non-volatile fields so `toEnvelope(result)` is deterministic and the
 * CLI-emitted envelope compares byte-equal to the MCP `structuredContent`.
 */
export const DIFFERENTIAL_CASES: readonly DifferentialCase[] = Object.freeze([
  {
    name: 'success · wf init',
    family: 'success',
    argv: ['wf', 'init', '--feature-id', 'diff-demo', '--workflow-type', 'feature'],
    result: {
      success: true,
      data: { featureId: 'diff-demo', workflowType: 'feature', phase: 'init' },
    },
    expectedExit: CONTRACT_EXIT_CODES.SUCCESS, // 0
  },
  {
    name: 'protocol · INVALID_INPUT',
    family: 'protocol',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'INVALID_INPUT', message: 'bad field' } },
    expectedExit: CONTRACT_EXIT_CODES.INVALID_INPUT, // 1
  },
  {
    name: 'authorization · CAPABILITY_DENIED',
    family: 'authorization',
    argv: [...VEHICLE_STATUS_ARGV],
    result: {
      success: false,
      error: { code: 'CAPABILITY_DENIED', message: 'readonly caller', tool: 'exarchos_workflow', action: 'get' },
    },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR, // 2
  },
  {
    name: 'task · TASK_NOT_FOUND',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'TASK_NOT_FOUND', message: 'no such workflow' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR, // 2
  },
  {
    name: 'task · WAIT_TIMEOUT',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'WAIT_TIMEOUT', message: 'predicate never held' } },
    expectedExit: CONTRACT_EXIT_CODES.WAIT_TIMEOUT, // 17
  },
  {
    name: 'task · WAIT_FAILED',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'WAIT_FAILED', message: 'terminal cannot satisfy predicate' } },
    expectedExit: CONTRACT_EXIT_CODES.WAIT_FAILED, // 18
  },
  {
    name: 'handler · HANDLER_ERROR',
    family: 'handler',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'HANDLER_ERROR', message: 'handler blew up' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR, // 2
  },
  {
    name: 'output · OUTPUT_CONTRACT_VIOLATION',
    family: 'output',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'OUTPUT_CONTRACT_VIOLATION', message: 'shape drift' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR, // 2
  },
  {
    name: 'presenter · PRESENTER_ERROR',
    family: 'presenter',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'PRESENTER_ERROR', message: 'render failed' } },
    expectedExit: CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION, // 3
  },
]);

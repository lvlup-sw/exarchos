// ─── CLI ⇄ MCP differential fixtures (P03-05) ────────────────────────────────
//
// PROGRAM-03, API-005. The exit-proof's second half: "generated CLI and MCP
// results agree by construction." Both surfaces are projections of ONE contract
// handler (`dispatch`): the MCP wire renders a `ToolResult` via `toEnvelope`
// into `structuredContent`; the generated CLI client renders the SAME
// `ToolResult` via the SAME `toEnvelope` to stdout, and resolves its process
// exit code from the SAME frozen P03-02 exit-code authority
// (`exitCodeForResult`, which `adapters/cli/cli.resolveExitCode` delegates to). So
// for any dispatched result the two surfaces cannot disagree — this table is the
// differential witness the co-located test drives through BOTH surfaces, and
// each case's `expectedExit` is the independent expectation the authority is
// measured against.
//
// ─── SCOPE (DR-25 / T-34): this table is a RENDERING witness ─────────────────
//
// The co-located test drives these cases with `dispatch` REPLACED by `vi.mock`,
// so what it witnesses is that the two RENDERERS agree about a `ToolResult` the
// fixture itself supplies. It cannot witness HANDLER-level agreement, and must
// not be read as doing so — that over-reading is exactly the vacuity DR-25
// names. The real-handler witness (a registered composite driven over the real
// Commander tree AND the real MCP server, compared end to end) lives in
// `adapters/cli/cli.test.ts` → `Cli_GeneratedClient_AgreesWithMcpViaRealHandler`.
// The two are complementary: this table gives cheap breadth across every
// failure family; that test gives depth through the real seam.
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

// `contractExitForResult` used to live here with a body byte-identical to
// `adapters/cli.resolveExitCode` — one authority wearing two names, so the test
// that compared them proved nothing. Both now delegate to `exitCodeForResult` in
// `contract/error-families.ts`; the fixture's `expectedExit` below is the
// independent expectation the authority is measured against.

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
  {
    // The failure floor. `ToolResult` is not a discriminated union, so this
    // shape is type-legal for every one of the registered handlers, and the MCP
    // wire renders it as `isError: true` with an INTERNAL_ERROR stand-in. Before
    // the floor the CLI resolved it to 0 and the two surfaces disagreed about
    // the same value — the case the table had no witness for.
    name: 'handler · failure envelope carrying no error',
    family: 'handler',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR, // 2
  },
]);

// CLI and MCP differential cases. Both surfaces render the `ToolResult` of `dispatch` through `toEnvelope`.
// The CLI takes its exit code from `exitCodeForResult`, and each case gives an independent `expectedExit`.
// The test that drives this table mocks `dispatch`, so it proves only that the two renderers agree.
// The real-handler proof is `Cli_GeneratedClient_AgreesWithMcpViaRealHandler` in `tests/unit/adapters/cli/cli.test.ts`.
//
// Each case has a valid CLI argv, so the mocked dispatch receives the call.
// The exit-code mapping does not depend on the action, so error cases use `wf status`.
// This is test-only data in the `test-fixtures` module-intent class.

import type { ToolResult } from '../../format.js';
import {
  CONTRACT_EXIT_CODES,
  type FailureLayer,
} from '../error-families.js';

/** One CLI⇄MCP differential case. */
export interface DifferentialCase {
  /** Stable case name, which is also the test label. */
  readonly name: string;
  /** The failure family exercised, or `'success'` for the happy path. */
  readonly family: FailureLayer | 'success';
  /** The CLI argv after the `node exarchos` prefix. It passes CLI-layer validation, so the mocked handler receives the call. */
  readonly argv: readonly string[];
  /** The `ToolResult` the shared contract handler (`dispatch`) returns. */
  readonly result: ToolResult;
  /** The stable process exit code the contract assigns to `result`. */
  readonly expectedExit: number;
}

const VEHICLE_STATUS_ARGV = ['wf', 'status', '--feature-id', 'diff-demo'] as const;

/**
 * The differential cases: the success path, each failure family, and the two bounded-wait codes.
 * Results carry only stable fields, so the CLI envelope is byte-equal to the MCP `structuredContent`.
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
    expectedExit: CONTRACT_EXIT_CODES.SUCCESS,
  },
  {
    name: 'protocol · INVALID_INPUT',
    family: 'protocol',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'INVALID_INPUT', message: 'bad field' } },
    expectedExit: CONTRACT_EXIT_CODES.INVALID_INPUT,
  },
  {
    name: 'authorization · CAPABILITY_DENIED',
    family: 'authorization',
    argv: [...VEHICLE_STATUS_ARGV],
    result: {
      success: false,
      error: { code: 'CAPABILITY_DENIED', message: 'readonly caller', tool: 'exarchos_workflow', action: 'get' },
    },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR,
  },
  {
    name: 'task · TASK_NOT_FOUND',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'TASK_NOT_FOUND', message: 'no such workflow' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR,
  },
  {
    name: 'task · WAIT_TIMEOUT',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'WAIT_TIMEOUT', message: 'predicate never held' } },
    expectedExit: CONTRACT_EXIT_CODES.WAIT_TIMEOUT,
  },
  {
    name: 'task · WAIT_FAILED',
    family: 'task',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'WAIT_FAILED', message: 'terminal cannot satisfy predicate' } },
    expectedExit: CONTRACT_EXIT_CODES.WAIT_FAILED,
  },
  {
    name: 'handler · HANDLER_ERROR',
    family: 'handler',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'HANDLER_ERROR', message: 'handler blew up' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR,
  },
  {
    name: 'output · OUTPUT_CONTRACT_VIOLATION',
    family: 'output',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'OUTPUT_CONTRACT_VIOLATION', message: 'shape drift' } },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR,
  },
  {
    name: 'presenter · PRESENTER_ERROR',
    family: 'presenter',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false, error: { code: 'PRESENTER_ERROR', message: 'render failed' } },
    expectedExit: CONTRACT_EXIT_CODES.UNCAUGHT_EXCEPTION,
  },
  /**
   * The failure floor. `ToolResult` is not a discriminated union, so any handler can return this shape.
   * The MCP wire renders it as `isError: true` with an INTERNAL_ERROR stand-in, and the CLI exits with a handler error.
   */
  {
    name: 'handler · failure envelope carrying no error',
    family: 'handler',
    argv: [...VEHICLE_STATUS_ARGV],
    result: { success: false },
    expectedExit: CONTRACT_EXIT_CODES.HANDLER_ERROR,
  },
]);

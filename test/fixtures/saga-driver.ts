// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.2
import type { SpawnedMcpClient } from './mcp-client.js';

/**
 * A single MCP tool invocation in a saga script. The shape mirrors the
 * `client.callTool({ name, arguments })` SDK contract.
 */
export interface SagaCall {
  /** MCP tool name (e.g. 'exarchos_workflow', 'exarchos_event'). */
  readonly tool: string;
  /** Arguments object for the tool. */
  readonly arguments: Record<string, unknown>;
}

/**
 * One entry in the saga transcript, modeled as a discriminated union so
 * callers narrow on `kind` rather than probing optional fields. Pre-rev
 * the type used `result?` + `error?`, which type-permitted ambiguous
 * "both present" / "neither present" states.
 */
export type SagaStep =
  | { readonly kind: 'success'; readonly call: SagaCall; readonly result: unknown }
  | {
      readonly kind: 'error';
      readonly call: SagaCall;
      readonly error: { readonly message: string; readonly name: string };
    };

export interface SagaTranscript {
  readonly steps: ReadonlyArray<SagaStep>;
}

/**
 * Minimal client surface `driveSaga` actually uses. Accepting this instead
 * of the full `SpawnedMcpClient` keeps tests/stubs honest (no need to cast
 * a partial mock to a full client) without coupling to lifecycle methods
 * the helper does not invoke.
 */
export interface SagaToolClient {
  readonly client: Pick<SpawnedMcpClient['client'], 'callTool'>;
}

/**
 * Drive a sequential script of MCP `callTool` invocations against a connected
 * client and capture each step's outcome.
 *
 * Semantics (design §4.2 / §5.2):
 *   - Iterate `calls` in array order, awaiting each call before the next.
 *   - On a successful call: append `{ kind: 'success', call, result }` and
 *     proceed.
 *   - On a thrown error: append `{ kind: 'error', call, error: { message, name } }`
 *     and HALT — subsequent calls are not executed.
 *   - Returns the transcript even when no calls were provided (empty steps).
 *
 * `driveSaga` does not interpret the call result — it does not unwrap the
 * MCP `content[0].text` envelope, does not check tool-level success flags,
 * and does not re-throw. Callers compose `snapshotEventStream` or other
 * fixtures to assert post-conditions.
 */
export async function driveSaga(
  client: SagaToolClient,
  calls: ReadonlyArray<SagaCall>,
): Promise<SagaTranscript> {
  const steps: SagaStep[] = [];

  for (const call of calls) {
    try {
      const result = await client.client.callTool({
        name: call.tool,
        arguments: call.arguments,
      });
      steps.push({ kind: 'success', call, result });
    } catch (err) {
      // Capture a structural snapshot. Non-Error throws (objects, strings)
      // get coerced into name/message pairs so the transcript shape is
      // stable regardless of the thrower.
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : 'NonError';
      steps.push({ kind: 'error', call, error: { message, name } });
      break; // halt on throw
    }
  }

  return { steps };
}

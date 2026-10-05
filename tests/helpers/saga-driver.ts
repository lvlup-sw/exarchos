import type { SpawnedMcpClient } from './mcp-client.js';

/** One MCP tool call in a saga script. */
export interface SagaCall {
  /** The MCP tool name, for example `exarchos_workflow`. */
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * One entry of the saga transcript. A caller narrows on `kind`. A step holds
 * a result or an error, and the type permits no other combination.
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
 * The part of the client that `driveSaga` uses. A test can pass a stub that
 * has only `callTool`, with no cast to the full `SpawnedMcpClient`.
 */
export interface SagaToolClient {
  readonly client: Pick<SpawnedMcpClient['client'], 'callTool'>;
}

/**
 * Runs `calls` in order against a connected client and records the outcome of
 * each call. It awaits each call before the next one. When a call throws, it
 * records an `error` step and stops, so the later calls do not run. A thrown
 * value that is not an `Error` gets the name `NonError` and its string form as
 * the message. It does not interpret a result: it does not unwrap the MCP
 * envelope, does not read a tool-level success flag, and does not throw again.
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
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : 'NonError';
      steps.push({ kind: 'error', call, error: { message, name } });
      break;
    }
  }

  return { steps };
}

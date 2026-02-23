import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getOrCreateEventStore } from '../views/tools.js';
import { captureTrace } from '../evals/trace-capture.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { CommandResult } from '../cli.js';

/**
 * Handle the eval-capture CLI command.
 *
 * Captures workflow event traces from an event stream and converts them
 * into EvalCase JSONL files suitable for regression testing.
 */
export async function handleEvalCapture(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<CommandResult> {
  const stream = stdinData['stream'];
  if (typeof stream !== 'string' || stream.length === 0) {
    return {
      error: {
        code: 'MISSING_STREAM',
        message: 'Required field "stream" (event stream ID) is missing or empty.',
      },
    };
  }

  const skill = typeof stdinData['skill'] === 'string' ? stdinData['skill'] : undefined;
  const output = typeof stdinData['output'] === 'string' ? stdinData['output'] : undefined;

  // Query events from the event store
  const store = getOrCreateEventStore(stateDir);
  const events = await store.query(stream) as WorkflowEvent[];

  // Capture traces
  const cases = captureTrace(events, { skill });

  if (cases.length === 0) {
    return {
      captured: 0,
      message: 'No traces captured from the stream.',
    };
  }

  // Write JSONL output
  const jsonlContent = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';

  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, jsonlContent, 'utf-8');
  } else {
    process.stdout.write(jsonlContent);
  }

  return {
    captured: cases.length,
    output: output ?? '(stdout)',
    message: `Captured ${cases.length} eval case(s) from stream "${stream}".`,
  };
}

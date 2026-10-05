import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnMcpClient, type SpawnedMcpClient } from './mcp-client.js';
import { clear, listAlive } from './process-tracker.js';
import { driveSaga, type SagaCall, type SagaToolClient } from './saga-driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, '__helpers__', 'mock-mcp-server.mjs');

const activeClients: SpawnedMcpClient[] = [];
function track<T extends SpawnedMcpClient>(c: T): T {
  activeClients.push(c);
  return c;
}

describe('driveSaga', () => {
  /** Teardown is best effort: it ignores an error from `terminate` or from `kill`. */
  afterEach(async () => {
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      if (!c) continue;
      try {
        await c.terminate();
      } catch {
      }
    }
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    clear();
  });

  it('driveSaga_emptyCallList_returnsEmptyTranscript', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    const transcript = await driveSaga(spawned, []);
    expect(transcript.steps).toEqual([]);
  });

  /** The mock server returns `echo:hi` as a text content block. */
  it('driveSaga_singleCall_returnsSingleTranscriptEntry', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    const calls: SagaCall[] = [
      { tool: 'echo', arguments: { message: 'hi' } },
    ];
    const transcript = await driveSaga(spawned, calls);
    expect(transcript.steps).toHaveLength(1);
    const step = transcript.steps[0];
    if (!step) throw new Error('the saga recorded no step');
    expect(step.call).toEqual(calls[0]);
    expect(step.kind).toBe('success');
    if (step.kind !== 'success') throw new Error('unreachable');
    expect(step.result).toMatchObject({
      content: [{ type: 'text', text: 'echo:hi' }],
    });
  });

  it('driveSaga_multipleCalls_executesInOrder', async () => {
    const spawned = track(
      await spawnMcpClient({ command: 'node', args: [MOCK_SERVER] }),
    );
    const calls: SagaCall[] = [
      { tool: 'echo', arguments: { message: 'first' } },
      { tool: 'echo', arguments: { message: 'second' } },
      { tool: 'echo', arguments: { message: 'third' } },
    ];
    const transcript = await driveSaga(spawned, calls);
    expect(transcript.steps).toHaveLength(3);
    const messages = transcript.steps.map((s) => {
      if (s.kind !== 'success') throw new Error('expected success step');
      const r = s.result as { content?: Array<{ text?: string }> };
      return r.content?.[0]?.text;
    });
    expect(messages).toEqual(['echo:first', 'echo:second', 'echo:third']);
  });

  /**
   * The first call succeeds, the second throws, and the third does not run.
   * A stub client throws from `callTool`, because the MCP SDK returns
   * `isError: true` for an unknown tool and does not throw. The stub has the
   * `SagaToolClient` annotation, so the type checker proves that it fits and
   * gives `args` its type. The stub counts its calls, and a third call throws.
   */
  it('driveSaga_callThrows_haltsAndIncludesErrorInTranscript', async () => {
    let callIndex = 0;
    const stubClient: SagaToolClient = {
      client: {
        async callTool(args) {
          callIndex++;
          if (callIndex === 1) {
            return {
              content: [
                { type: 'text', text: `step1:${JSON.stringify(args)}` },
              ],
            };
          }
          if (callIndex === 2) {
            const err = new Error('synthetic transport failure');
            err.name = 'SyntheticTransportError';
            throw err;
          }
          throw new Error('driveSaga should have halted before call 3');
        },
      },
    };

    const calls: SagaCall[] = [
      { tool: 'echo', arguments: { message: 'before' } },
      { tool: 'echo', arguments: { message: 'will-throw' } },
      { tool: 'echo', arguments: { message: 'never executed' } },
    ];
    const transcript = await driveSaga(stubClient, calls);

    expect(transcript.steps).toHaveLength(2);
    expect(transcript.steps[0]?.kind).toBe('success');
    expect(transcript.steps[1]?.kind).toBe('error');

    const errorStep = transcript.steps[1];
    if (!errorStep) throw new Error('the saga recorded no second step');
    if (errorStep.kind !== 'error') throw new Error('unreachable');
    expect(errorStep.error.message).toBe('synthetic transport failure');
    expect(errorStep.error.name).toBe('SyntheticTransportError');

    expect(callIndex).toBe(2);
  });
});

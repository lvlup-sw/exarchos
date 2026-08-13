// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.2
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
  afterEach(async () => {
    while (activeClients.length > 0) {
      const c = activeClients.pop();
      if (!c) continue;
      try {
        await c.terminate();
      } catch {
        // ignore — teardown best effort
      }
    }
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
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
    // Mock server returns echo:hi as a text content block.
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

  it('driveSaga_callThrows_haltsAndIncludesErrorInTranscript', async () => {
    // Use a stub client so we can deterministically force `callTool` to
    // throw on the second invocation. The MCP SDK does NOT throw on
    // unknown-tool errors at the JSON-RPC layer (it returns isError:true),
    // so we synthesize a thrown rejection at the client boundary.
    let callIndex = 0;
    // Annotated, not merely shaped like it. The comment below used to claim
    // this stub satisfied `SagaToolClient` "directly, no cast needed" — a claim
    // nothing checked, because this file sat in no tsconfig. It did not: the
    // hand-written `callTool` signature was narrower than the SDK's. The
    // annotation makes the claim the checker's problem and types `args` from
    // the target rather than restating it.
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

    // First call succeeds, second throws, third never runs.
    expect(transcript.steps).toHaveLength(2);
    expect(transcript.steps[0]?.kind).toBe('success');
    expect(transcript.steps[1]?.kind).toBe('error');

    const errorStep = transcript.steps[1];
    if (!errorStep) throw new Error('the saga recorded no second step');
    if (errorStep.kind !== 'error') throw new Error('unreachable');
    expect(errorStep.error.message).toBe('synthetic transport failure');
    expect(errorStep.error.name).toBe('SyntheticTransportError');

    // Halt verification: the stub increments callIndex per call; if a third
    // call leaked through it would have thrown the "should have halted"
    // error above and propagated out of driveSaga.
    expect(callIndex).toBe(2);
  });
});

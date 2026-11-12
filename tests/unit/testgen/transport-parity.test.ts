import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectV2Client, connectV2Server, createV2Client, createV2LinkedTransportPair } from '../../../src/contract/sdk/seam.js';
import { runCli } from '../../../src/testgen/adapters/cli.js';
import { commandMetadata } from '../../../src/testgen/adapters/cli-metadata.js';
import { createTestgenServer } from '../../../src/testgen/adapters/mcp.js';
import { describeOperations, dispatch } from '../../../src/testgen/index.js';
import type { Emitter } from '../../../src/testgen/contract/operations.js';

it('derives CLI commands and errors from all operation definitions', () => {
  const { errors, operations } = describeOperations();
  expect(commandMetadata).toEqual({
    errors,
    operations: operations.map(({ name, description }) => ({ name, description })),
  });
});

it('carries the same result through the CLI and a connected MCP client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testgen space '));
  const file = join(dir, 'input file.json');
  const [serverTransport, clientTransport] = createV2LinkedTransportPair();
  const emit: Emitter = (input) => input.propertyRef === 'broken-emitter'
    ? { ok: true }
    : dispatch('predicate' in input ? 'generate_property_tests' : 'generate_metamorphic_tests', input);
  const server = createTestgenServer(emit);
  const client = createV2Client({ name: 'parity', version: '1' });
  try {
    await connectV2Server(server, serverTransport);
    await connectV2Client(client, clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual(commandMetadata.operations.map(({ name }) => name));
    for (const [fixture, name] of [
      ['property', 'generate_property_tests'],
      ['advance', 'generate_metamorphic_tests'],
    ] as const) {
      const input = JSON.parse(await readFile(new URL(`../../support/testgen/${fixture}.json`, import.meta.url), 'utf8'));
      for (const [patch, expectedExit] of [
        [{}, 0],
        [{ cases: [] }, 2],
        [{ framework: 'other' }, 3],
        [{ propertyRef: 'broken-emitter' }, 1],
      ] as const) {
        const payload = { ...input, ...patch };
        await writeFile(file, JSON.stringify(payload));
        let stdout = '';
        let stderr = '';
        const exit = await runCli([name, '--input', file, '--json'], (s) => { stdout += s; }, (s) => { stderr += s; },
          (action, data) => dispatch(action, data, emit));
        const mcp = await client.callTool({ name, arguments: payload });
        expect(exit).toBe(expectedExit);
        expect(mcp.structuredContent).toEqual(JSON.parse(stdout));
        expect(mcp.isError).toBe(exit !== 0);
        expect(stderr.length > 0).toBe(exit !== 0);
      }
    }
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

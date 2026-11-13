// @oracle-sources: ../../../src/testgen/contract/operations.ts, ../../support/testgen/typed-property.json, ../../support/testgen/stateful-ledger.json
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { dispatch, describeOperations } from '../../../src/testgen/index.js';
import { runCli } from '../../../src/testgen/adapters/cli.js';
import { createTestgenServer } from '../../../src/testgen/adapters/mcp.js';
import { connectV2Client, connectV2Server, createV2Client, createV2LinkedTransportPair } from '../../../src/contract/sdk/seam.js';

it.each(['tunit', 'vitest'])('scaffolds each supported method for %s with throwing stubs', (framework) => {
  for (const method of ['property', 'metamorphic', 'differential', 'stateful']) {
    const input = { name: 'Example', framework, method, ...(framework === 'tunit' ? { project: 'tests/Example.csproj' } : {}) };
    const result = dispatch('scaffold_tests', input);
    expect(result.ok).toBe(true);
    if (!result.ok || !('request' in result)) throw new Error('Expected scaffold.');
    expect(result.files).toHaveLength(2);
    expect(result.patch).toMatch(/throw new (Error|NotImplementedException)/);
    expect(dispatch(result.next.operation, result.request)).toMatchObject({ ok: true, contractVersion: 2 });
  }
});

it('derives capability methods and domains from the operation and domain contracts', () => {
  const { capabilities, operations } = describeOperations();
  expect(capabilities.domains).toEqual(['boolean', 'integer', 'number', 'string', 'enum', 'nullable', 'array', 'record']);
  expect(capabilities.methods.map(({ operation }) => operation)).toEqual(operations.filter(({ name }) => name.startsWith('generate_')).map(({ name }) => name));
  expect(capabilities.frameworks).toEqual([{ framework: 'tunit', version: '1.2.11' }, { framework: 'vitest', version: '3.2.7' }]);
});

it('replays concrete stateless and stateful records and rejects mismatched evidence', async () => {
  const request = JSON.parse(await readFile(new URL('../../support/testgen/typed-property.json', import.meta.url), 'utf8'));
  const fixture = { version: 2, propertyRef: request.propertyRef, method: 'property', signature: 'property/oracle-false', domain: request.domain, cases: ['a\r'] };
  const replay = dispatch('replay_tests', { request, fixture });
  expect(replay).toMatchObject({ ok: true, fixture: { cases: ['a\r'] }, generation: { seed: null, attempts: 0 } });
  for (const change of [{ propertyRef: 'another/property' }, { domain: { kind: 'boolean' } }, { signature: 'crash' }, { cases: ['outside-domain'] }]) {
    expect(dispatch('replay_tests', { request, fixture: { ...fixture, ...change } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }
  const stateful = JSON.parse(await readFile(new URL('../../support/testgen/stateful-ledger.json', import.meta.url), 'utf8'));
  const stateRecord = { version: 2, propertyRef: stateful.propertyRef, method: 'stateful', signature: 'stateful/claim/state-mismatch', operations: stateful.operations, histories: [stateful.histories[0]] };
  expect(dispatch('replay_tests', { request: stateful, fixture: stateRecord }))
    .toMatchObject({ ok: true, fixture: { scenarios: [{ mode: 'exact', requiredSteps: 4 }] } });
  expect(dispatch('replay_tests', { request, fixture: stateRecord })).toMatchObject({ ok: false });
});

it('uses the same scaffold and replay contracts through aliases and MCP', async () => {
  const directory = makeTempDir('testgen workflow ');
  const [serverTransport, clientTransport] = createV2LinkedTransportPair();
  const server = createTestgenServer();
  const client = createV2Client({ name: 'workflow-parity', version: '1' });
  try {
    await connectV2Server(server, serverTransport);
    await connectV2Client(client, clientTransport);
    let stdout = '';
    let stderr = '';
    const exit = await runCli(['init', 'Example', '--framework', 'vitest', '--json'],
      (value) => { stdout += value; }, (value) => { stderr += value; });
    expect(exit).toBe(0);
    expect(stderr).toBe('');
    const mcp = await client.callTool({ name: 'scaffold_tests', arguments: { name: 'Example', framework: 'vitest' } });
    expect(mcp.structuredContent).toEqual(JSON.parse(stdout));
    const scaffold = JSON.parse(stdout);
    const fixture = { version: 2, method: 'property', caseId: 'Case_1', signature: 'property/oracle-false', propertyRef: scaffold.request.propertyRef, domain: scaffold.request.domain, cases: ['ab'] };
    const inputPath = join(directory, 'request file.json');
    const fixturePath = join(directory, 'native log.txt');
    await writeFile(inputPath, JSON.stringify(scaffold.request));
    await writeFile(fixturePath, `native output\nTESTGEN_REPLAY ${JSON.stringify(fixture)}\n`);
    stdout = '';
    expect(await runCli(['replay', '--input', inputPath, '--fixture', fixturePath, '--case', 'Case_1', '--json'],
      (value) => { stdout += value; }, (value) => { stderr += value; })).toBe(0);
    const replay = await client.callTool({ name: 'replay_tests', arguments: { request: scaffold.request, fixture } });
    expect(replay.structuredContent).toEqual(JSON.parse(stdout));
    await writeFile(fixturePath, `TESTGEN_REPLAY ${JSON.stringify(fixture)}\nTESTGEN_REPLAY ${JSON.stringify({ ...fixture, caseId: 'Case_2' })}\n`);
    stdout = '';
    expect(await runCli(['replay', '--input', inputPath, '--fixture', fixturePath, '--json'],
      (value) => { stdout += value; }, () => {})).toBe(2);
    expect(JSON.parse(stdout).error.message).toMatch(/exactly one/);
  } finally {
    await client.close();
    await server.close();
    await rmrfAsync(directory);
  }
});

// @oracle-sources: the packaged exarchos binary on PATH, a PATH Git shim log, marker files, the state directory and the MCP tools/list reply
/**
 * Prove through the packaged binary that a retired action gets its closed refusal before any claim, configuration read, event append or process start.
 * Each run gets a scratch HOME and state directory. A PATH Git shim logs each Git start, and marker files show that no configured command ran.
 * The CLI refuses before it opens the state, so the state directory stays empty and no configuration warning reaches stderr.
 * The MCP server refuses before schema validation and dispatch, so an argument that the schema rejects still gets the refusal.
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';
import { record } from '../helpers/capsule/s6-process-race.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** The refusal of a mutation-adequacy call. */
const MUTATION_REFUSAL = {
  success: false,
  error: {
    code: 'MUTATION_TESTING_RETIRED',
    message: 'Exarchos retires mutation testing. A provisioned verifier runs no mutation adequacy check, and no local Stryker run replaces it.',
  },
};

/** Resolve one executable from the PATH of the test process, before any shim directory goes first. */
async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error(`The fixture requires ${name} on PATH`);
}

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * A scratch HOME, an empty state directory, a PATH Git shim that logs each call, and a checkout whose configuration runs marker scripts.
 * `cli` runs the packaged binary in the checkout, and `mcp` opens one session of the packaged MCP server.
 */
async function retiredFixture() {
  const root = makeTempDir('1928-retired-actions-');
  const home = join(root, 'home');
  const stateDir = join(root, 'state');
  const shim = join(root, 'shim');
  const markers = join(root, 'markers');
  const checkout = join(root, 'checkout');
  for (const directory of [home, stateDir, shim, markers, checkout]) await mkdir(directory, { mode: 0o700 });
  const gitLog = join(root, 'git.log');
  await writeFile(join(shim, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(gitLog)}\nexit 1\n`, { mode: 0o700 });
  const marker = (name: string) => join(markers, name);
  await writeFile(join(checkout, 'exarchos.config.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker('config'))}, 'ran');\nexport default {};\n`);
  await writeFile(join(checkout, '.exarchos.yml'), 'mutation: node mutate.cjs\n');
  await writeFile(join(checkout, 'mutate.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker('mutation'))}, 'ran');\n`);
  const binary = await onPath('exarchos');
  const shimmedPath = `${shim}${delimiter}${process.env.PATH ?? ''}`;
  const env: Record<string, string> = {
    HOME: home, USERPROFILE: home, WORKFLOW_STATE_DIR: stateDir, EXARCHOS_STATE_DIR: stateDir, EXARCHOS_TELEMETRY: 'false', PATH: shimmedPath,
  };
  const cli = (args: string[]) => runCli({ command: binary, args, cwd: checkout, env, timeout: 60_000 });
  const mcp = () => spawnMcpClient({ command: binary, args: ['mcp'], stateDir, env: { HOME: home, PATH: shimmedPath, EXARCHOS_TELEMETRY: 'false' } });
  const gitCalls = async () => (await exists(gitLog) ? (await readFile(gitLog, 'utf8')).split('\n').filter(line => line.length > 0) : []);
  return { root, stateDir, cli, mcp, gitCalls, marker, async close() { await rmrfAsync(root); } };
}

it.runIf(process.platform === 'linux')('RetiredAction_PackagedCli_RefusesBeforeStateConfigurationOrProcess', async () => {
  const f = await retiredFixture();
  try {
    for (const group of ['orch', 'orchestrate']) {
      const json = await f.cli([group, 'mutation-adequacy', '--feature-id', 'retired-mutation', '--base', 'main', '--json']);
      expect(json.exitCode, json.stderr).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject(MUTATION_REFUSAL);
      expect(json.stderr).not.toContain('executable-configuration-retired');
    }
    const plain = await f.cli(['orch', 'mutation-adequacy', '--unknown-flag']);
    expect(plain.exitCode).toBe(2);
    expect(plain.stdout).toBe('');
    expect(plain.stderr).toContain(`Error [MUTATION_TESTING_RETIRED]: ${MUTATION_REFUSAL.error.message}`);
    expect(await readdir(f.stateDir)).toEqual([]);
    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(f.marker('config'))).toBe(false);
    expect(await exists(f.marker('mutation'))).toBe(false);

    const live = await f.cli(['orch', 'task_claim', '--json']);
    expect(JSON.parse(live.stdout)).not.toMatchObject({ error: { code: 'MUTATION_TESTING_RETIRED' } });
  } finally {
    await f.close();
  }
}, 120_000);

it.runIf(process.platform === 'linux')('RetiredAction_PackagedMcp_RefusesBeforeSchemaValidationDispatchOrProcess', async () => {
  const f = await retiredFixture();
  try {
    const client = await f.mcp();
    try {
      const listed = await client.client.listTools();
      expect(JSON.stringify(listed)).toContain('check_mock_boundary');
      expect(JSON.stringify(listed)).not.toContain('mutation-adequacy');
      const refused = record(extractEnvelope(await client.client.callTool({
        name: 'exarchos_orchestrate',
        arguments: { action: 'mutation-adequacy', featureId: 'retired-mutation', base: 'main', notARegisteredField: true },
      }, { timeout: 35_000 })));
      expect(refused).toMatchObject(MUTATION_REFUSAL);
      const unknown = await client.client.callTool({
        name: 'exarchos_orchestrate',
        arguments: { action: 'not-an-action', featureId: 'retired-mutation' },
      }, { timeout: 35_000 });
      expect(JSON.stringify(unknown)).not.toContain('MUTATION_TESTING_RETIRED');
    } finally {
      await client.terminate();
    }
    const queried = await f.cli(['event', 'query', '--stream', 'retired-mutation', '--json']);
    expect(record(JSON.parse(queried.stdout))).toMatchObject({ success: true, data: { events: [], page: { total: 0 } } });
    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(f.marker('mutation'))).toBe(false);
  } finally {
    await f.close();
  }
}, 120_000);

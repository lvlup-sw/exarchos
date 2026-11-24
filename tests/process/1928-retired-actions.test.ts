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

/** The refusal of a retired provider write. One closed code and one message name the harness for all four writers. */
const PROVIDER_WRITE_REFUSAL = {
  success: false,
  error: {
    code: 'PROVIDER_WRITE_RETIRED',
    message: 'Exarchos retires pull request and issue writes. The harness opens, merges and comments on pull requests and opens issues with its own tools.',
  },
};

/** Each retired provider writer with arguments that its old schema accepted. */
const PROVIDER_WRITERS: readonly { readonly action: string; readonly cli: readonly string[]; readonly mcp: Record<string, unknown> }[] = [
  { action: 'create_pr', cli: ['--title', 't', '--body', 'b', '--base', 'main', '--head', 'feat/x'], mcp: { title: 't', body: 'b', base: 'main', head: 'feat/x' } },
  { action: 'merge_pr', cli: ['--pr-id', '42', '--strategy', 'squash'], mcp: { prId: '42', strategy: 'squash' } },
  { action: 'add_pr_comment', cli: ['--pr-id', '42', '--body', 'b'], mcp: { prId: '42', body: 'b' } },
  { action: 'create_issue', cli: ['--title', 't', '--body', 'b'], mcp: { title: 't', body: 'b' } },
];

/** The refusal of a retired provider read. One closed code and one message name the harness for all seven reads. */
const PROVIDER_READ_REFUSAL = {
  success: false,
  error: {
    code: 'PROVIDER_READ_RETIRED',
    message: 'Exarchos retires pull request, CI and review comment reads. The harness reads pull requests, CI checks and review comments with its own tools.',
  },
};

/** Each retired provider read with arguments that its old schema accepted. */
const PROVIDER_READS: readonly { readonly action: string; readonly cli: readonly string[]; readonly mcp: Record<string, unknown> }[] = [
  { action: 'check_ci', cli: ['--pr-id', '42'], mcp: { prId: '42' } },
  { action: 'list_prs', cli: ['--state', 'open'], mcp: { state: 'open' } },
  { action: 'get_pr_comments', cli: ['--pr-id', '42', '--limit', '5'], mcp: { prId: '42', limit: 5 } },
  { action: 'check_pr_comments', cli: ['--pr', '42', '--repo', 'acme/app'], mcp: { pr: 42, repo: 'acme/app' } },
  { action: 'check_coderabbit', cli: ['--owner', 'acme', '--repo', 'app', '--pr-numbers', '1,2'], mcp: { owner: 'acme', repo: 'app', prNumbers: [1, 2] } },
  { action: 'validate_pr_stack', cli: ['--feature-id', 'retired-stack', '--base-branch', 'main'], mcp: { featureId: 'retired-stack', baseBranch: 'main' } },
  { action: 'assess_stack', cli: ['--feature-id', 'retired-stack', '--pr-numbers', '1,2'], mcp: { featureId: 'retired-stack', prNumbers: [1, 2] } },
];

/** The refusal of a retired worktree provisioning action. It keeps the closed code of the provider writers, and its message names the harness. */
const WORKTREE_PROVISIONING_REFUSAL = {
  success: false,
  error: {
    code: 'PROVIDER_WRITE_RETIRED',
    message: 'Exarchos retires worktree provisioning. The harness creates task worktrees and removes them from disk with its own tools.',
  },
};

/** Each retired worktree provisioning action with arguments that its old schema accepted. */
const WORKTREE_PROVISIONERS: readonly { readonly action: string; readonly cli: readonly string[]; readonly mcp: Record<string, unknown> }[] = [
  { action: 'setup_worktree', cli: ['--repo-root', '.', '--task-id', 'T1', '--task-name', 'retired'], mcp: { repoRoot: '.', taskId: 'T1', taskName: 'retired' } },
  { action: 'prune_worktrees', cli: ['--repo-root', '.', '--dry-run', 'false'], mcp: { repoRoot: '.', dryRun: false } },
];

/** The refusal of a retired local merge action. It keeps the closed code of the provider writers, and its message names the harness landing. */
const MERGE_LANDING_REFUSAL = {
  success: false,
  error: {
    code: 'PROVIDER_WRITE_RETIRED',
    message: 'Exarchos retires local merges. The harness lands the task branch on the integration branch with its own tools, and the coordinator records that landing with a merge.executed event.',
  },
};

/** The flags of a `merge_orchestrate` call that its old schema accepted. The `merge-orchestrate` top-level verb took the same flags. */
const MERGE_ORCHESTRATE_CLI: readonly string[] = ['--feature-id', 'retired-mutation', '--source-branch', 'feat/x', '--target-branch', 'main', '--strategy', 'squash'];

/** Each retired local merge action with arguments that its old schema accepted. */
const MERGERS: readonly { readonly action: string; readonly cli: readonly string[]; readonly mcp: Record<string, unknown> }[] = [
  { action: 'merge_orchestrate', cli: MERGE_ORCHESTRATE_CLI, mcp: { sourceBranch: 'feat/x', targetBranch: 'main', strategy: 'squash' } },
  { action: 'serialize_merge', cli: ['--feature-id', 'retired-mutation', '--integration-ref', 'main', '--source-branch', 'feat/x', '--strategy', 'squash', '--dry-run', 'false'], mcp: { integrationRef: 'main', sourceBranch: 'feat/x', strategy: 'squash', dryRun: false } },
];

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
    for (const writer of PROVIDER_WRITERS) {
      for (const group of ['orch', 'orchestrate']) {
        const refused = await f.cli([group, writer.action, ...writer.cli, '--json']);
        expect(refused.exitCode, `${writer.action} ${refused.stderr}`).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject(PROVIDER_WRITE_REFUSAL);
        expect(refused.stderr).not.toContain('executable-configuration-retired');
      }
      const bare = await f.cli(['orch', writer.action, '--unknown-flag']);
      expect(bare.exitCode, writer.action).toBe(2);
      expect(bare.stdout).toBe('');
      expect(bare.stderr).toContain(`Error [PROVIDER_WRITE_RETIRED]: ${PROVIDER_WRITE_REFUSAL.error.message}`);
    }
    for (const read of PROVIDER_READS) {
      for (const group of ['orch', 'orchestrate']) {
        const refused = await f.cli([group, read.action, ...read.cli, '--json']);
        expect(refused.exitCode, `${read.action} ${refused.stderr}`).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject(PROVIDER_READ_REFUSAL);
        expect(refused.stderr).not.toContain('executable-configuration-retired');
      }
      const bare = await f.cli(['orch', read.action, '--unknown-flag']);
      expect(bare.exitCode, read.action).toBe(2);
      expect(bare.stdout).toBe('');
      expect(bare.stderr).toContain(`Error [PROVIDER_READ_RETIRED]: ${PROVIDER_READ_REFUSAL.error.message}`);
    }
    for (const provisioner of WORKTREE_PROVISIONERS) {
      for (const group of ['orch', 'orchestrate']) {
        const refused = await f.cli([group, provisioner.action, ...provisioner.cli, '--json']);
        expect(refused.exitCode, `${provisioner.action} ${refused.stderr}`).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject(WORKTREE_PROVISIONING_REFUSAL);
        expect(refused.stderr).not.toContain('executable-configuration-retired');
      }
      const bare = await f.cli(['orch', provisioner.action, '--unknown-flag']);
      expect(bare.exitCode, provisioner.action).toBe(2);
      expect(bare.stdout).toBe('');
      expect(bare.stderr).toContain(`Error [PROVIDER_WRITE_RETIRED]: ${WORKTREE_PROVISIONING_REFUSAL.error.message}`);
    }
    for (const merger of MERGERS) {
      for (const group of ['orch', 'orchestrate']) {
        const refused = await f.cli([group, merger.action, ...merger.cli, '--json']);
        expect(refused.exitCode, `${merger.action} ${refused.stderr}`).toBe(2);
        expect(JSON.parse(refused.stdout)).toMatchObject(MERGE_LANDING_REFUSAL);
        expect(refused.stderr).not.toContain('executable-configuration-retired');
      }
      const bare = await f.cli(['orch', merger.action, '--unknown-flag']);
      expect(bare.exitCode, merger.action).toBe(2);
      expect(bare.stdout).toBe('');
      expect(bare.stderr).toContain(`Error [PROVIDER_WRITE_RETIRED]: ${MERGE_LANDING_REFUSAL.error.message}`);
    }
    const topLevel = await f.cli(['merge-orchestrate', ...MERGE_ORCHESTRATE_CLI, '--json']);
    expect(topLevel.exitCode, topLevel.stderr).toBe(2);
    expect(JSON.parse(topLevel.stdout)).toMatchObject(MERGE_LANDING_REFUSAL);
    const topLevelBare = await f.cli(['merge-orchestrate', '--unknown-flag']);
    expect(topLevelBare.exitCode).toBe(2);
    expect(topLevelBare.stdout).toBe('');
    expect(topLevelBare.stderr).toContain(`Error [PROVIDER_WRITE_RETIRED]: ${MERGE_LANDING_REFUSAL.error.message}`);
    expect(await readdir(f.stateDir)).toEqual([]);
    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(f.marker('config'))).toBe(false);
    expect(await exists(f.marker('mutation'))).toBe(false);

    const live = await f.cli(['orch', 'task_claim', '--json']);
    expect(JSON.parse(live.stdout)).not.toMatchObject({ error: { code: 'MUTATION_TESTING_RETIRED' } });
    expect(JSON.parse(live.stdout)).not.toMatchObject({ error: { code: 'PROVIDER_WRITE_RETIRED' } });
    expect(JSON.parse(live.stdout)).not.toMatchObject({ error: { code: 'PROVIDER_READ_RETIRED' } });
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
      for (const writer of PROVIDER_WRITERS) {
        expect(JSON.stringify(listed)).not.toContain(writer.action);
        const writeRefused = record(extractEnvelope(await client.client.callTool({
          name: 'exarchos_orchestrate',
          arguments: { action: writer.action, ...writer.mcp, featureId: 'retired-mutation', notARegisteredField: true },
        }, { timeout: 35_000 })));
        expect(writeRefused).toMatchObject(PROVIDER_WRITE_REFUSAL);
      }
      for (const read of PROVIDER_READS) {
        expect(JSON.stringify(listed)).not.toContain(read.action);
        const readRefused = record(extractEnvelope(await client.client.callTool({
          name: 'exarchos_orchestrate',
          arguments: { action: read.action, ...read.mcp, featureId: 'retired-mutation', notARegisteredField: true },
        }, { timeout: 35_000 })));
        expect(readRefused).toMatchObject(PROVIDER_READ_REFUSAL);
      }
      for (const name of ['acquire_worktree', 'release_worktree', 'reconcile_worktrees']) {
        expect(JSON.stringify(listed)).toContain(name);
      }
      for (const provisioner of WORKTREE_PROVISIONERS) {
        expect(JSON.stringify(listed)).not.toContain(provisioner.action);
        const provisionRefused = record(extractEnvelope(await client.client.callTool({
          name: 'exarchos_orchestrate',
          arguments: { action: provisioner.action, ...provisioner.mcp, featureId: 'retired-mutation', notARegisteredField: true },
        }, { timeout: 35_000 })));
        expect(provisionRefused).toMatchObject(WORKTREE_PROVISIONING_REFUSAL);
      }
      for (const merger of MERGERS) {
        expect(JSON.stringify(listed)).not.toContain(merger.action);
        const mergeRefused = record(extractEnvelope(await client.client.callTool({
          name: 'exarchos_orchestrate',
          arguments: { action: merger.action, ...merger.mcp, featureId: 'retired-mutation', notARegisteredField: true },
        }, { timeout: 35_000 })));
        expect(mergeRefused).toMatchObject(MERGE_LANDING_REFUSAL);
      }
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
      expect(JSON.stringify(unknown)).not.toContain('PROVIDER_WRITE_RETIRED');
      expect(JSON.stringify(unknown)).not.toContain('PROVIDER_READ_RETIRED');
    } finally {
      await client.terminate();
    }
    const queried = await f.cli(['event', 'query', '--stream', 'retired-mutation', '--json']);
    expect(record(JSON.parse(queried.stdout))).toMatchObject({ success: true, data: { events: [], page: { total: 0 } } });
    const journal = await f.cli(['event', 'query', '--stream', 'vcs', '--json']);
    expect(record(JSON.parse(journal.stdout))).toMatchObject({ success: true, data: { events: [], page: { total: 0 } } });
    const worktrees = await f.cli(['event', 'query', '--stream', 'worktrees', '--json']);
    expect(record(JSON.parse(worktrees.stdout))).toMatchObject({ success: true, data: { events: [], page: { total: 0 } } });
    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(f.marker('mutation'))).toBe(false);
  } finally {
    await f.close();
  }
}, 120_000);

// @oracle-sources: the packaged exarchos binary on PATH, PATH shims that log each program start, a loopback listener, and the MCP tools/list reply
/**
 * Prove through the packaged binary that the governor is a local CLI on its normal path: prepare, a harness landing, settle and feedback.
 * The binary gets a PATH that holds only shims. The shims for git and node log and run the real program. The other shims log and fail.
 * The log shows no gh, glab or az start, no Git write or remote read and no other start by name. Node starts only the approved checks.
 *
 * A planted script proves that a remote tool, a Git merge and another program land in the log and fail the assertion. An absolute-path start is outside the log.
 *
 * Feedback names a retired upstream URL on a loopback listener, and the proxy variables name it too. The listener must get no connection.
 *
 * The MCP server lists the same four tools as before this work.
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path, { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { data, prepareRequest, record, settleArgs, TASKS, withRaceRepository, type RaceRepository } from '../helpers/capsule/s6-process-race.js';

/** The time cap of one case: three packaged calls, the Git steps of the fixture and the approved checks. */
const CASE_TIMEOUT_MS = 180_000;

/** The programs that the shims record. A start of any other program by name finds no executable. */
const SHIMMED = ['git', 'gh', 'glab', 'az', 'node'] as const;

/** The other programs that a catch-all shim logs and fails: shells, package managers, network clients and the command lookup. The binary must start none of them. */
const CATCH_ALL: ReadonlySet<string> = new Set(['sh', 'bash', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'curl', 'wget', 'ssh', 'which', 'python3']);

/** The remote-service command line tools. The binary must start none of them. */
const REMOTE_TOOLS: ReadonlySet<string> = new Set(['gh', 'glab', 'az']);

/**
 * The Git subcommands that only read the local repository in every form. Any other subcommand is a write or a remote read, unless a form rule below allows it.
 */
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  'rev-parse', 'cat-file', 'ls-tree', 'ls-files', 'merge-base', 'rev-list', 'show', 'log', 'diff', 'diff-tree',
  'diff-index', 'diff-files', 'for-each-ref', 'show-ref', 'name-rev', 'describe', 'check-ignore', 'check-attr',
  'status', 'var', 'version', 'count-objects',
]);

/** The `git config` options that read a value. A `git config` start with none of them writes. */
const GIT_CONFIG_READS: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);

/** The Git options that take the next argument as their value. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-c', '-C']);

/** The command of the fixture. Each mode exits 0. The integration mode reads the tip that it sees. */
const COMMAND = [
  "const cp=require('node:child_process');",
  "if(process.argv[2]==='integration'){cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'});}",
].join('');

/** One program start that a shim recorded. */
interface Start {
  readonly program: string;
  readonly args: readonly string[];
}

/** One packaged call: the exit code and the parsed envelope. */
interface Call {
  readonly exitCode: number;
  readonly envelope: Record<string, unknown>;
}

/** A launcher runs one packaged call with its arguments and gives its result. */
type Launch = (args: readonly string[]) => Promise<Call>;

/** Resolve one executable from the PATH of the test process. */
async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = path.resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error(`The fixture requires ${name} on PATH`);
}

/** The fixture configuration: the verification profile of the checks and the retired feedback block with `upstream`. */
function configWith(upstream: string): string {
  return JSON.stringify({
    verification: {
      staticAnalysis: { lint: 'node command.cjs static' },
      tests: { globs: ['tests/**/*.test.js'], probe: { command: 'node command.cjs probe', files: 'as-arguments', failureExitCodes: [1] } },
      integration: { command: 'node command.cjs integration' },
    },
    feedback: { upstream },
  });
}

/** Write one shim for each recorded and each catch-all program. A shim logs its arguments, then runs the real program or fails. */
async function writeShims(shimDir: string, log: string): Promise<void> {
  await mkdir(shimDir, { recursive: true });
  const real: Record<string, string | undefined> = { git: await onPath('git'), node: process.execPath };
  for (const program of [...SHIMMED, ...CATCH_ALL]) {
    const target = real[program];
    const tail = target === undefined ? 'exit 1' : `exec ${JSON.stringify(target)} "$@"`;
    await writeFile(path.join(shimDir, program), [
      '#!/bin/sh',
      `{ printf '%s' ${program}; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`,
      tail,
      '',
    ].join('\n'), { mode: 0o700 });
  }
}

/** Read the shim log as program starts. */
async function readStarts(log: string): Promise<Start[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter(line => line.length > 0).map((line) => {
    const [program = '', ...args] = line.split('\t');
    return { program, args };
  });
}

/** The Git subcommand of one argument list, after the global options and their values. */
function gitSubcommand(args: readonly string[]): readonly string[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (GIT_VALUE_OPTIONS.has(arg)) { index += 1; continue; }
    if (!arg.startsWith('-')) return args.slice(index, index + 2);
  }
  return [];
}

/**
 * True when one Git start writes a repository or reaches a remote. The rule allows only the read-only forms and refuses every other start.
 * A worktree, remote or stash subcommand counts unless it lists or reads. `git config` counts unless it reads a value, and `hash-object` counts when it writes the object.
 * `symbolic-ref` counts unless it names one reference and does not delete it. A start with no subcommand counts unless it asks for the version.
 */
function writesOrReaches(args: readonly string[]): boolean {
  const [subcommand = '', verb = ''] = gitSubcommand(args);
  if (subcommand === '') return !args.includes('--version');
  if (READ_ONLY_GIT.has(subcommand)) return false;
  if (subcommand === 'symbolic-ref') {
    const operands = args.slice(args.indexOf('symbolic-ref') + 1);
    return operands.some(arg => arg === '-d' || arg === '--delete') || operands.filter(arg => !arg.startsWith('-')).length > 1;
  }
  if (subcommand === 'worktree') return verb !== 'list';
  if (subcommand === 'remote') return verb !== 'get-url';
  if (subcommand === 'stash') return verb !== 'list';
  if (subcommand === 'config') return !args.some(arg => GIT_CONFIG_READS.has(arg)) && verb !== 'get';
  if (subcommand === 'hash-object') return args.includes('-w');
  return true;
}

/** Parse the JSON envelope of one packaged call. */
function callOf(result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): Call {
  try {
    return { exitCode: result.exitCode, envelope: record(JSON.parse(result.stdout)) };
  } catch (error) {
    throw new Error(`CLI exit ${result.exitCode}: ${result.stderr}\n${result.stdout}`, { cause: error });
  }
}

/** The environment of each packaged call: the state directory, the shim PATH and proxy variables that name `proxy`. */
function boundaryEnv(f: RaceRepository, shimDir: string, proxy: string): Record<string, string> {
  return {
    WORKFLOW_STATE_DIR: f.stateDir, EXARCHOS_STATE_DIR: f.stateDir, EXARCHOS_TELEMETRY: 'false', PATH: shimDir,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '',
  };
}

/**
 * Run the normal path through `launch`: a typed prepare, a commit in the task worktree, a harness landing and settle, then one feedback report.
 * The harness landing is a merge that the test runs with its own Git, outside the shims.
 */
async function normalPath(f: RaceRepository, launch: Launch): Promise<void> {
  const request = await prepareRequest(f, { workflowType: 'release-check' });
  const prepared = await launch(request.cli);
  expect(prepared.exitCode, JSON.stringify(prepared.envelope)).toBe(0);
  const capsuleVersion = data(prepared.envelope).capsuleVersion;
  const id = TASKS[0];
  const worktreePath = await f.repository.worktreeFor(id, { [`src/${id}.js`]: 'export const value = 2;\n' });
  await f.git(['merge', '-q', '--no-edit', `task/${id}`]);
  const settled = await launch(settleArgs(capsuleVersion, [{ taskId: id, fields: { worktreePath, files: [`src/${id}.js`] }, evidence: [] }], 'boundary'));
  expect(settled.exitCode, JSON.stringify(settled.envelope)).toBe(0);
  expect(data(settled.envelope)).toMatchObject({ outcome: 'settled', acceptedTasks: [id] });
  const feedback = await launch(['wf', 'feedback', '--message', 'governor boundary report']);
  expect(feedback.exitCode, JSON.stringify(feedback.envelope)).toBe(0);
  expect(data(feedback.envelope)).toMatchObject({ recorded: true, upstreamConfigured: false, configuredEndpoint: null, upstreamDelivered: false });
}

/** The recorded starts that the boundary refuses. These are a remote tool, a catch-all program, a Git write or remote read, and a node start that is not a check. */
function unapprovedStarts(starts: readonly Start[]): Start[] {
  return starts.filter(start => REMOTE_TOOLS.has(start.program) || CATCH_ALL.has(start.program)
    || (start.program === 'git' && writesOrReaches(start.args))
    || (start.program === 'node' && start.args[0] !== 'command.cjs'));
}

/** Assert the recorded starts: Git reads and the approved checks only, with no remote tool, no Git write and no catch-all program. */
function expectOnlyApprovedStarts(starts: readonly Start[]): void {
  expect(starts.filter(start => start.program === 'git').length).toBeGreaterThan(0);
  expect(unapprovedStarts(starts)).toEqual([]);
  const checks = starts.filter(start => start.program === 'node');
  expect(checks.map(start => start.args[1]).filter(mode => mode === 'integration')).toEqual(['integration']);
}

/** Start a TCP listener on a free loopback port that counts each connection. */
async function countingListener(): Promise<{ readonly server: Server; readonly url: string; readonly connections: () => number }> {
  let count = 0;
  const server = createServer((socket) => { count += 1; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The listener has no TCP address');
  return { server, url: `http://127.0.0.1:${address.port}`, connections: () => count };
}

describe('packaged CLI-only governor boundary', () => {
  /**
   * The direct case. Each packaged call runs with the shim PATH, and the retired upstream and the proxy variables name the loopback listener.
   * The listener gets no connection, and the shims record only Git reads and the approved checks.
   */
  it.runIf(process.platform === 'linux')('GovernorBoundary_NormalPath_StartsOnlyGitReadsAndApprovedChecksAndSendsNothing', async () => {
    const listener = await countingListener();
    try {
      await withRaceRepository(async (f) => {
        const shimDir = path.join(f.controls, 'shim');
        const log = path.join(f.controls, 'starts.log');
        await writeShims(shimDir, log);
        const binary = await onPath('exarchos');
        const env = boundaryEnv(f, shimDir, listener.url);
        const launch: Launch = async args => callOf(await runCli({ command: binary, args: [...args, '--json'], cwd: f.repository.checkout, env, timeout: 60_000 }));
        await normalPath(f, launch);
        expect(listener.connections()).toBe(0);
        expectOnlyApprovedStarts(await readStarts(log));
      }, { files: { 'command.cjs': COMMAND, '.exarchos.yml': configWith(`${listener.url}/report`) } });
    } finally {
      await new Promise<void>(resolve => listener.server.close(() => resolve()));
    }
  }, CASE_TIMEOUT_MS);

  /**
   * The control of the shim log. A planted node script starts programs by name through the same shim PATH, as the binary does.
   * The starts of gh, a Git merge, a Git config write, a symbolic-ref write and curl land in the log.
   * The boundary assertion fails on them. The log with them removed passes.
   */
  it.runIf(process.platform === 'linux')('GovernorBoundary_ShimLog_RecordsAndRefusesAPlantedRemoteToolGitMergeAndCatchAllStart', async () => {
    await withRaceRepository(async (f) => {
      const shimDir = path.join(f.controls, 'shim');
      const log = path.join(f.controls, 'starts.log');
      await writeShims(shimDir, log);
      await writeFile(path.join(f.controls, 'command.cjs'), '');
      const planted = path.join(f.controls, 'planted.cjs');
      await writeFile(planted, [
        "const { spawnSync } = require('node:child_process');",
        "for (const [program, ...args] of [['git', 'rev-parse', '--git-dir'], ['gh', 'pr', 'list'], ['git', 'merge', '--no-edit', 'task/x'], ['git', 'config', '--local', 'boundary.probe', 'true'], ['git', 'symbolic-ref', 'HEAD', 'refs/heads/x'], ['curl', 'http://192.0.2.1/'], ['node', 'command.cjs', 'integration']]) {",
        "  spawnSync(program, args, { stdio: 'ignore' });",
        "}",
      ].join('\n'));
      const result = await runCli({ command: process.execPath, args: [planted], cwd: f.controls, env: { PATH: shimDir }, timeout: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const starts = await readStarts(log);
      expect(unapprovedStarts(starts)).toEqual([
        { program: 'gh', args: ['pr', 'list'] },
        { program: 'git', args: ['merge', '--no-edit', 'task/x'] },
        { program: 'git', args: ['config', '--local', 'boundary.probe', 'true'] },
        { program: 'git', args: ['symbolic-ref', 'HEAD', 'refs/heads/x'] },
        { program: 'curl', args: ['http://192.0.2.1/'] },
      ]);
      expect(() => expectOnlyApprovedStarts(starts)).toThrow();
      expect(() => expectOnlyApprovedStarts(starts.filter(start => unapprovedStarts([start]).length === 0))).not.toThrow();
    });
  }, CASE_TIMEOUT_MS);

  /** This work adds no MCP surface: the packaged MCP server lists the same four composite tools. */
  it.runIf(process.platform === 'linux')('GovernorBoundary_McpToolList_IsTheFourCompositeTools', async () => {
    await withRaceRepository(async (f) => {
      const client = await spawnMcpClient({ command: await onPath('exarchos'), args: ['mcp'], stateDir: f.stateDir, env: { PATH: process.env.PATH ?? '', EXARCHOS_TELEMETRY: 'false' } });
      try {
        const listed = await client.client.listTools();
        expect(listed.tools.map(tool => tool.name).sort()).toEqual(['exarchos_event', 'exarchos_orchestrate', 'exarchos_view', 'exarchos_workflow']);
      } finally {
        await client.terminate();
      }
    });
  }, CASE_TIMEOUT_MS);
});

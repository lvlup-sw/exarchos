// @oracle-sources: the packaged exarchos binary on PATH, PATH shims that log each program start, a loopback listener, a trap in a private network namespace, and the MCP tools/list reply
/**
 * Prove through the packaged binary that the governor is a local CLI on its normal path: prepare, a harness landing, settle and feedback.
 * The binary gets a PATH that holds only recording shims for git, gh, glab, az and node. A start of any other program by name fails.
 * The shims show no gh, glab or az start, no Git merge, fetch, push or other write, and no node start except the approved checks.
 *
 * Feedback names a retired upstream URL on a loopback listener, and the proxy variables name it too. The listener must get no connection.
 * Where user namespaces work, the same path runs in a private network namespace. Every IPv4 and IPv6 address is local there,
 * and a trap listens on the DNS, SSH, HTTP, HTTPS, Git and proxy ports. The trap must get no packet and no connection.
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
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { data, prepareRequest, record, settleArgs, TASKS, withRaceRepository, type RaceRepository } from '../helpers/capsule/s6-process-race.js';

/** The time cap of one case: three packaged calls, the Git steps of the fixture and the approved checks. */
const CASE_TIMEOUT_MS = 180_000;

/** The programs that the shims record. A start of any other program by name finds no executable. */
const SHIMMED = ['git', 'gh', 'glab', 'az', 'node'] as const;

/** The remote-service command line tools. The binary must start none of them. */
const REMOTE_TOOLS: ReadonlySet<string> = new Set(['gh', 'glab', 'az']);

/** The Git subcommands that write a repository or reach a remote. The normal path runs none of them. */
const FORBIDDEN_GIT: ReadonlySet<string> = new Set([
  'merge', 'push', 'fetch', 'pull', 'clone', 'ls-remote', 'commit', 'checkout', 'switch', 'reset', 'rebase',
  'cherry-pick', 'branch', 'tag', 'update-ref', 'gc', 'maintenance', 'submodule', 'am', 'apply', 'restore',
]);

/** The Git options that take the next argument as their value. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-c', '-C']);

/** The ports that the namespace trap listens on: DNS, SSH, HTTP, HTTPS, the Git protocol and a proxy port. */
const TRAP_TCP_PORTS = [53, 22, 80, 443, 9418, 8080] as const;

/** The upstream URL of the namespace case. It names a trap port. */
const TRAP_UPSTREAM = 'http://127.0.0.1:8080/report';

/** The command of the fixture. Each mode exits 0. The integration mode reads the tip that it sees. */
const COMMAND = [
  "const cp=require('node:child_process');",
  "if(process.argv[2]==='integration'){cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'});}",
].join('');

/**
 * The runner of the namespace case. It makes every address local on the loopback device, starts the trap, and runs the binary.
 * It writes each connection and datagram that the trap sees to the report file, and exits with the exit code of the binary.
 */
const TRAP_RUNNER = `
import net from 'node:net';
import dgram from 'node:dgram';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [ip, report, command, ...args] = process.argv.slice(2);
execFileSync(ip, ['link', 'set', 'lo', 'up']);
execFileSync(ip, ['route', 'add', 'local', '0.0.0.0/0', 'dev', 'lo', 'table', 'local']);
execFileSync(ip, ['-6', 'route', 'add', 'local', '::/0', 'dev', 'lo', 'table', 'local']);
const seen = [];
const ready = [];
for (const port of ${JSON.stringify(TRAP_TCP_PORTS)}) {
  const server = net.createServer((socket) => { seen.push({ protocol: 'tcp', port }); socket.destroy(); });
  ready.push(new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '::', resolve); }));
}
for (const type of ['udp4', 'udp6']) {
  const socket = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
  socket.on('message', () => seen.push({ protocol: type, port: 53 }));
  ready.push(new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(53, resolve); }));
}
await Promise.all(ready);
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
child.on('close', (code) => {
  setTimeout(() => { writeFileSync(report, JSON.stringify(seen)); process.exit(code ?? 1); }, 200);
});
`;

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

/** True when this host can run a command in a private user and network namespace with the loopback device up. */
async function namespaceTrapAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await execFileAsync('unshare', ['-rn', 'ip', 'link', 'set', 'lo', 'up'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether the namespace cases run on this host. A host without user namespaces skips them, and the direct case still runs. */
const NAMESPACE_TRAP = await namespaceTrapAvailable();

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

/** Write one shim for each recorded program. A shim logs its arguments, then runs the real program or fails. */
async function writeShims(shimDir: string, log: string): Promise<void> {
  await mkdir(shimDir, { recursive: true });
  const real: Record<string, string | undefined> = { git: await onPath('git'), node: process.execPath };
  for (const program of SHIMMED) {
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

/** True when one Git start writes a repository or reaches a remote. A worktree or remote subcommand counts unless it lists or reads. */
function writesOrReaches(args: readonly string[]): boolean {
  const [subcommand = '', verb = ''] = gitSubcommand(args);
  if (FORBIDDEN_GIT.has(subcommand)) return true;
  if (subcommand === 'worktree') return verb !== 'list';
  if (subcommand === 'remote') return verb !== 'get-url';
  if (subcommand === 'stash') return verb !== 'list';
  return false;
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

/** Assert the recorded starts: Git reads and the approved checks only, with no remote tool and no Git write. */
function expectOnlyApprovedStarts(starts: readonly Start[]): void {
  expect(starts.filter(start => start.program === 'git').length).toBeGreaterThan(0);
  expect(starts.filter(start => REMOTE_TOOLS.has(start.program))).toEqual([]);
  expect(starts.filter(start => start.program === 'git' && writesOrReaches(start.args))).toEqual([]);
  const checks = starts.filter(start => start.program === 'node');
  expect(checks.map(start => start.args[1]).filter(mode => mode === 'integration')).toEqual(['integration']);
  expect(checks.filter(start => start.args[0] !== 'command.cjs')).toEqual([]);
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
   * The namespace case. Each packaged call runs in its own user and network namespace, where every address is local and the trap listens.
   * The normal path still settles and records feedback. The trap sees no DNS datagram and no connection.
   */
  it.runIf(NAMESPACE_TRAP)('GovernorBoundary_NormalPathInAPrivateNetworkNamespace_SendsNoPacket', async () => {
    await withRaceRepository(async (f) => {
      const shimDir = path.join(f.controls, 'shim');
      const log = path.join(f.controls, 'starts.log');
      await writeShims(shimDir, log);
      const runner = path.join(f.controls, 'trap-runner.mjs');
      await writeFile(runner, TRAP_RUNNER);
      const [binary, unshare, ip] = await Promise.all([onPath('exarchos'), onPath('unshare'), onPath('ip')]);
      const env = boundaryEnv(f, shimDir, 'http://127.0.0.1:8080');
      const seen: unknown[] = [];
      let calls = 0;
      const launch: Launch = async (args) => {
        calls += 1;
        const report = path.join(f.controls, `trap-${calls}.json`);
        const result = await runCli({
          command: unshare, args: ['-rn', process.execPath, runner, ip, report, binary, ...args, '--json'],
          cwd: f.repository.checkout, env, timeout: 60_000,
        });
        seen.push(...JSON.parse(await readFile(report, 'utf8')));
        return callOf(result);
      };
      await normalPath(f, launch);
      expect(calls).toBe(3);
      expect(seen).toEqual([]);
      expectOnlyApprovedStarts(await readStarts(log));
    }, { files: { 'command.cjs': COMMAND, '.exarchos.yml': configWith(TRAP_UPSTREAM) } });
  }, CASE_TIMEOUT_MS);

  /** The control of the namespace trap: a node client in the same kind of namespace reaches a trap port, and the trap records it. */
  it.runIf(NAMESPACE_TRAP)('GovernorBoundary_NamespaceTrap_RecordsAPlantedConnection', async () => {
    await withRaceRepository(async (f) => {
      const runner = path.join(f.controls, 'trap-runner.mjs');
      await writeFile(runner, TRAP_RUNNER);
      const report = path.join(f.controls, 'trap-control.json');
      const [unshare, ip] = await Promise.all([onPath('unshare'), onPath('ip')]);
      const client = "require('node:net').connect(443,'203.0.113.7').on('connect',function(){this.end()}).on('error',function(){})";
      const result = await runCli({ command: unshare, args: ['-rn', process.execPath, runner, ip, report, process.execPath, '-e', client], timeout: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(report, 'utf8'))).toEqual([{ protocol: 'tcp', port: 443 }]);
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

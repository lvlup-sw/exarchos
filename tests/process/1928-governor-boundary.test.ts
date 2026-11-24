// @oracle-sources: the packaged exarchos binary on PATH, PATH shims that log each program start, a loopback listener, a trap and the socket counters of a private network namespace, and the MCP tools/list reply
/**
 * Prove through the packaged binary that the governor is a local CLI on its normal path: prepare, a harness landing, settle and feedback.
 * The binary gets a PATH that holds only shims. The shims for git and node log and run the real program. The other shims log and fail.
 * The log shows no gh, glab or az start, no Git write or remote read and no other start by name. Node starts only the approved checks.
 *
 * A planted script proves that a remote tool, a Git merge and another program land in the log and fail the assertion. An absolute-path start is outside the log.
 *
 * Feedback names a retired upstream URL on a loopback listener, and the proxy variables name it too. The listener must get no connection.
 * On Linux the same path runs in a private network namespace where every address is local and a trap listens on common ports.
 * The socket counters of that namespace count a connection or datagram to any port. Both must stay zero.
 * A Linux host that cannot make the namespace fails, unless EXARCHOS_TEST_SKIP_NAMESPACE_TRAP=1 reports the cases as skipped.
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

/** The other programs that a catch-all shim logs and fails: shells, package managers, network clients and the command lookup. The binary must start none of them. */
const CATCH_ALL: ReadonlySet<string> = new Set(['sh', 'bash', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'curl', 'wget', 'ssh', 'which', 'python3']);

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

/** The variable that opts a Linux host out of the namespace cases. With it, the report shows the namespace gate as skipped. */
const NAMESPACE_OPT_OUT = process.env.EXARCHOS_TEST_SKIP_NAMESPACE_TRAP === '1';

/** The message of a Linux host that cannot run the namespace trap. */
const NAMESPACE_UNAVAILABLE = 'This Linux host cannot make a private user and network namespace. Enable unprivileged user namespaces, or set EXARCHOS_TEST_SKIP_NAMESPACE_TRAP=1 to report the namespace gate as not run.';

/** The command of the fixture. Each mode exits 0. The integration mode reads the tip that it sees. */
const COMMAND = [
  "const cp=require('node:child_process');",
  "if(process.argv[2]==='integration'){cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'});}",
].join('');

/**
 * The runner of the namespace case. It makes every address local on the loopback device, starts the trap, and runs the binary.
 * It reads the TCP active opens and the UDP and UDP6 datagrams sent of the namespace before and after the binary.
 * It writes the connections and datagrams that the trap sees and the counter deltas to the report file. It exits with the exit code of the binary.
 */
const TRAP_RUNNER = `
import net from 'node:net';
import dgram from 'node:dgram';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [ip, report, command, ...args] = process.argv.slice(2);
execFileSync(ip, ['link', 'set', 'lo', 'up']);
execFileSync(ip, ['route', 'add', 'local', '0.0.0.0/0', 'dev', 'lo', 'table', 'local']);
execFileSync(ip, ['-6', 'route', 'add', 'local', '::/0', 'dev', 'lo', 'table', 'local']);
const field = (lines, protocol, name) => {
  const rows = lines.filter(line => line.startsWith(protocol + ':'));
  const keys = rows[0].trim().split(/ +/);
  return Number(rows[1].trim().split(/ +/)[keys.indexOf(name)]);
};
const counters = () => {
  const snmp = readFileSync('/proc/net/snmp', 'utf8').split(String.fromCharCode(10));
  const six = readFileSync('/proc/net/snmp6', 'utf8').split(String.fromCharCode(10)).map(line => line.trim().split(/[ \t]+/));
  return {
    tcpActiveOpens: field(snmp, 'Tcp', 'ActiveOpens'),
    udpOutDatagrams: field(snmp, 'Udp', 'OutDatagrams'),
    udp6OutDatagrams: Number((six.find(row => row[0] === 'Udp6OutDatagrams') ?? [])[1]),
  };
};
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
const before = counters();
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
child.on('close', (code) => {
  setTimeout(() => {
    const after = counters();
    const delta = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
    writeFileSync(report, JSON.stringify({ seen, delta }));
    process.exit(code ?? 1);
  }, 200);
});
`;

/** The report of one namespace run: what the trap saw and the counter deltas of the namespace. */
interface TrapReport {
  readonly seen: readonly unknown[];
  readonly delta: Readonly<Record<string, number>>;
}

/** The counter deltas of a namespace run that opens no socket to any port. */
const NO_SOCKET = { tcpActiveOpens: 0, udpOutDatagrams: 0, udp6OutDatagrams: 0 };

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

/** Whether this host can run the namespace trap. A Linux host that cannot fails the namespace cases, unless it opts out. */
const NAMESPACE_TRAP = await namespaceTrapAvailable();

/** Read one namespace report. */
async function readTrapReport(report: string): Promise<TrapReport> {
  const parsed = record(JSON.parse(await readFile(report, 'utf8')));
  const { seen, delta } = parsed;
  if (!Array.isArray(seen)) throw new Error('The trap report has no seen list');
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record(delta))) {
    if (typeof value !== 'number') throw new Error(`The trap report has no number for ${key}`);
    counts[key] = value;
  }
  return { seen, delta: counts };
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
   * The namespace case. Each packaged call runs in its own user and network namespace, where every address is local and the trap listens.
   * The normal path still settles and records feedback. The trap sees no DNS datagram and no connection.
   */
  it.runIf(process.platform === 'linux' && !NAMESPACE_OPT_OUT)('GovernorBoundary_NormalPathInAPrivateNetworkNamespace_SendsNoPacket', async () => {
    expect(NAMESPACE_TRAP, NAMESPACE_UNAVAILABLE).toBe(true);
    await withRaceRepository(async (f) => {
      const shimDir = path.join(f.controls, 'shim');
      const log = path.join(f.controls, 'starts.log');
      await writeShims(shimDir, log);
      const runner = path.join(f.controls, 'trap-runner.mjs');
      await writeFile(runner, TRAP_RUNNER);
      const [binary, unshare, ip] = await Promise.all([onPath('exarchos'), onPath('unshare'), onPath('ip')]);
      const env = boundaryEnv(f, shimDir, 'http://127.0.0.1:8080');
      const seen: unknown[] = [];
      const deltas: Readonly<Record<string, number>>[] = [];
      let calls = 0;
      const launch: Launch = async (args) => {
        calls += 1;
        const report = path.join(f.controls, `trap-${calls}.json`);
        const result = await runCli({
          command: unshare, args: ['-rn', process.execPath, runner, ip, report, binary, ...args, '--json'],
          cwd: f.repository.checkout, env, timeout: 60_000,
        });
        const trap = await readTrapReport(report);
        seen.push(...trap.seen);
        deltas.push(trap.delta);
        return callOf(result);
      };
      await normalPath(f, launch);
      expect(calls).toBe(3);
      expect(seen).toEqual([]);
      expect(deltas).toEqual([NO_SOCKET, NO_SOCKET, NO_SOCKET]);
      expectOnlyApprovedStarts(await readStarts(log));
    }, { files: { 'command.cjs': COMMAND, '.exarchos.yml': configWith(TRAP_UPSTREAM) } });
  }, CASE_TIMEOUT_MS);

  /**
   * The control of the namespace trap. A node client in the same kind of namespace connects to a trap port and to a port with no listener, and sends one datagram.
   * The trap records the trap port only. The counters count both connection attempts and the datagram.
   */
  it.runIf(process.platform === 'linux' && !NAMESPACE_OPT_OUT)('GovernorBoundary_NamespaceTrap_RecordsAPlantedConnection', async () => {
    expect(NAMESPACE_TRAP, NAMESPACE_UNAVAILABLE).toBe(true);
    await withRaceRepository(async (f) => {
      const runner = path.join(f.controls, 'trap-runner.mjs');
      await writeFile(runner, TRAP_RUNNER);
      const report = path.join(f.controls, 'trap-control.json');
      const [unshare, ip] = await Promise.all([onPath('unshare'), onPath('ip')]);
      const client = [
        "const net=require('node:net');",
        "net.connect(443,'203.0.113.7').on('connect',function(){this.end()}).on('error',function(){});",
        "net.connect(4444,'198.51.100.9').on('error',function(){});",
        "const udp=require('node:dgram').createSocket('udp4');udp.send('x',5353,'192.0.2.1',function(){udp.close()});",
      ].join('');
      const result = await runCli({ command: unshare, args: ['-rn', process.execPath, runner, ip, report, process.execPath, '-e', client], timeout: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const trap = await readTrapReport(report);
      expect(trap.seen).toEqual([{ protocol: 'tcp', port: 443 }]);
      expect(trap.delta).toMatchObject({ tcpActiveOpens: 2, udpOutDatagrams: 1 });
    });
  }, CASE_TIMEOUT_MS);

  /**
   * The control of the shim log. A planted node script starts programs by name through the same shim PATH, as the binary does.
   * The starts of gh, a Git merge and curl land in the log, and the boundary assertion fails on them. The log with them removed passes.
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
        "for (const [program, ...args] of [['git', 'rev-parse', '--git-dir'], ['gh', 'pr', 'list'], ['git', 'merge', '--no-edit', 'task/x'], ['curl', 'http://192.0.2.1/'], ['node', 'command.cjs', 'integration']]) {",
        "  spawnSync(program, args, { stdio: 'ignore' });",
        "}",
      ].join('\n'));
      const result = await runCli({ command: process.execPath, args: [planted], cwd: f.controls, env: { PATH: shimDir }, timeout: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const starts = await readStarts(log);
      expect(unapprovedStarts(starts)).toEqual([
        { program: 'gh', args: ['pr', 'list'] },
        { program: 'git', args: ['merge', '--no-edit', 'task/x'] },
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

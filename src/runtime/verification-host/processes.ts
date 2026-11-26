/** The verifier alone starts fixed operator profiles inside an explicit Linux namespace boundary. */
import { execFile, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { stat, realpath } from 'node:fs/promises';
import { authorizeVerification, trustedSystemExecutable, type AuthorizedVerification } from './authorization.js';
import { verificationJson, type VerificationEvidence } from '../../contract/verification/harness-verification.js';

const namespaceFlags: readonly string[] = [
  '--die-with-parent', '--new-session', '--unshare-all', '--unshare-user',
  '--disable-userns', '--cap-drop', 'ALL', '--clearenv',
];

/** Prove the fixed namespace options before opening the operator socket. */
export async function confirmConfinement(path: string): Promise<void> {
  const bwrap = await trustedSystemExecutable(path, 'bwrap');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bwrap, [...namespaceFlags, '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--', '/usr/bin/true'],
    { env: {}, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Required Linux confinement is unavailable'));
    });
  });
}

/** Recheck captured mount identities immediately before starting the restricted process. */
export async function runVerificationProbe(authorized: AuthorizedVerification, signal: AbortSignal): Promise<VerificationEvidence['outcome']> {
  if (process.platform !== 'linux') return { status: 'unsupported', exitCode: null, reason: 'Linux confinement unavailable', stdoutBase64: '', stderrBase64: '' };
  await recheckVerification(authorized);
  return runConfinedProfile(authorized, signal);
}

/** Reobserve registered coordinates and external tool custody before an execution leg. */
export async function recheckVerification(authorized: AuthorizedVerification): Promise<void> {
  const refreshed = await authorizeVerification(authorized.policy, authorized.provisioningPath, authorized.request, false);
  if (verificationJson(refreshed.custody) !== verificationJson(authorized.custody) || refreshed.hostPolicyDigest !== authorized.hostPolicyDigest) throw new Error('Execution custody changed');
  for (const identity of authorized.identities) {
    const info = await stat(identity.path);
    if (await realpath(identity.path) !== identity.path || String(info.dev) !== identity.device || String(info.ino) !== identity.inode) throw new Error('Resource moved before execution');
  }
}

function immutableGitArgs(authorized: AuthorizedVerification, operands: readonly string[]): string[] {
  return [
    '--no-replace-objects', '--no-optional-locks', '--no-pager',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
    `--git-dir=${authorized.resource.gitDir}`, `--work-tree=${authorized.resource.checkout}`, ...operands,
  ];
}

const immutableGitEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C', LANG: 'C',
};

/** Read exact objects using an explicit Git directory and no worktree callbacks. */
export function readAdequacyGit(authorized: AuthorizedVerification, operands: readonly string[]) {
  return promisify(execFile)(authorized.gitPath, immutableGitArgs(authorized, operands), {
    encoding: 'buffer', cwd: authorized.resource.checkout, timeout: 5000, maxBuffer: 1024 * 1024,
    env: immutableGitEnvironment,
  }).then(result => result.stdout);
}

/** Read closed, finite blob IDs over one cat-file process and stop it on overflow or cancellation. */
export async function readAdequacyBlobs(
  authorized: AuthorizedVerification, ids: readonly string[], maxBytes: number, signal: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  if (ids.length === 0) return new Map();
  if (ids.some(id => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))) throw new Error('Noncanonical Git blob ID');
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(authorized.gitPath, immutableGitArgs(authorized, ['cat-file', '--batch']), {
      cwd: authorized.resource.checkout, env: immutableGitEnvironment,
      stdio: ['pipe', 'pipe', 'ignore'], signal,
    });
    const chunks: Buffer[] = [];
    let count = 0;
    let stopped = false;
    const stop = () => { stopped = true; child.kill('SIGKILL'); };
    const deadline = setTimeout(stop, 5000);
    child.stdin.once('error', stop);
    child.stdin.end(ids.join('\n') + '\n');
    child.stdout.on('data', (bytes: Buffer) => {
      count += bytes.length;
      if (count > maxBytes + ids.length * 100) stop();
      else if (!stopped) chunks.push(bytes);
    });
    child.once('error', () => { stopped = true; });
    child.once('close', code => {
      clearTimeout(deadline);
      if (code !== 0 || stopped) reject(new Error('Immutable Git blob read did not complete'));
      else resolve(Buffer.concat(chunks, count));
    });
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  for (const id of ids) {
    const newline = output.indexOf(0x0a, offset);
    const [returned, kind, encodedSize, extra] = output.toString('ascii', offset, newline).split(' ');
    const length = Number(encodedSize);
    if (newline < offset || newline - offset > 100 || returned !== id || kind !== 'blob' || extra !== undefined
      || encodedSize === undefined || !/^\d+$/.test(encodedSize) || !Number.isSafeInteger(length)
      || total + length > maxBytes || output[newline + 1 + length] !== 0x0a) {
      throw new Error('Malformed or oversized immutable Git blob response');
    }
    offset = newline + 1 + length;
    total += length;
    blobs.set(id, output.subarray(newline + 1, offset));
    offset++;
  }
  if (offset !== output.length) throw new Error('Unexpected immutable Git blob response bytes');
  return blobs;
}

/** The options of one confined child. The verifier alone selects each value from operator policy. */
export interface ConfinedOptions {
  readonly image?: string;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly writable?: boolean;
  readonly reporterFile?: string;
  readonly reportPath?: string;
  readonly hostsFile?: string;
  readonly runtimeMounts?: readonly (readonly [string, string])[];
  readonly outputLimit?: number;
  readonly timeoutMs?: number;
}

/** The raw bounded end of one confined child. */
export interface ConfinedRun {
  readonly code: number | null;
  readonly reason: string;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/**
 * Start one child in the fixed namespace boundary with an optional disposable image at the checkout path.
 * Private runtime copies mount over their approved paths after the image.
 * A child with an image finds only the pinned runner directory and /usr/bin on its search path.
 */
export function spawnConfined(authorized: AuthorizedVerification, signal: AbortSignal, options: ConfinedOptions = {}): Promise<ConfinedRun> {
  const { image, reporterFile, reportPath, runtimeMounts = [] } = options;
  const args: string[] = [...namespaceFlags, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/exarchos-home'];
  for (const path of authorized.runtimePaths) args.push('--ro-bind', path, path);
  args.push('--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64');
  args.push(image !== undefined && options.writable === true ? '--bind' : '--ro-bind', image ?? authorized.resource.checkout, authorized.resource.checkout);
  for (const [source, target] of runtimeMounts) args.push('--ro-bind', source, target);
  if (reporterFile !== undefined) args.push('--ro-bind', reporterFile, '/tmp/exarchos-adequacy-reporter.mjs');
  const hosts = options.hostsFile ?? (reporterFile === undefined ? undefined : join(dirname(reporterFile), 'hosts'));
  if (hosts !== undefined) args.push('--ro-bind', hosts, '/etc/hosts');
  if (reportPath !== undefined) args.push('--bind', reportPath, '/tmp/exarchos-adequacy-report');
  for (const path of new Set([authorized.resource.repository, authorized.resource.gitDir])) args.push('--ro-bind', path, path);
  const searchPath = image === undefined
    ? [...authorized.runtimePaths.map(path => path + '/bin'), '/usr/bin', '/bin']
    : [dirname(authorized.profile.executable), '/usr/bin'];
  if (image !== undefined && options.writable === true) args.push('--setenv', 'npm_config_globalconfig', '/dev/null');
  args.push('--chdir', authorized.resource.checkout, '--setenv', 'PATH', searchPath.join(':'),
    '--setenv', 'LANG', 'C', '--setenv', 'HOME', '/tmp/exarchos-home', '--setenv', 'XDG_STATE_HOME', '/tmp/state', '--',
    options.program ?? authorized.profile.executable, ...(options.args ?? authorized.profile.args));
  const outputLimit = options.outputLimit ?? (image === undefined ? 4096 : 64 * 1024);
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ code: null, reason: 'Host canceled before execution', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }); return; }
    const child = spawn(authorized.bwrap, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let reason = '';
    const stop = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const abort = () => { reason = 'Host canceled execution'; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { reason = 'Execution deadline exceeded'; stop(); }, options.timeoutMs ?? authorized.profile.timeoutMs);
    child.stdout.on('data', (bytes: Buffer) => { outBytes += bytes.length; if (outBytes > outputLimit) { reason = 'Output limit exceeded'; stop(); } else stdout.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { errBytes += bytes.length; if (errBytes > outputLimit) { reason = 'Output limit exceeded'; stop(); } else stderr.push(bytes); });
    child.once('error', () => { reason = 'Confinement process unavailable'; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ code, reason, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

/**
 * Mount an optional disposable worktree image at the same path for both legs.
 * Private runtime copies mount over their approved paths after the image.
 * An adequacy leg finds the pinned runner first on its search path and reads no runtime npm configuration.
 */
export async function runConfinedProfile(
  authorized: AuthorizedVerification, signal: AbortSignal, image?: string, profileArgs = authorized.profile.args, reporterFile?: string, reportPath?: string,
  runtimeMounts: readonly (readonly [string, string])[] = [],
): Promise<VerificationEvidence['outcome']> {
  const writable = image !== undefined && authorized.profile.adequacy?.reporter === 'vitest';
  const run = await spawnConfined(authorized, signal, {
    args: profileArgs, runtimeMounts, writable,
    ...(image === undefined ? {} : { image }),
    ...(reporterFile === undefined ? {} : { reporterFile }),
    ...(reportPath === undefined ? {} : { reportPath }),
  });
  const { code, reason } = run;
  return { status: code === 0 && !reason ? 'passed' : 'failed', exitCode: code,
    reason: reason || (code === 0 ? 'Approved probe completed' : 'Approved probe failed'),
    stdoutBase64: run.stdout.toString('base64'), stderrBase64: run.stderr.toString('base64') };
}

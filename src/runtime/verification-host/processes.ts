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
  const refreshed = await authorizeVerification(authorized.policy, authorized.provisioningPath, authorized.request);
  if (verificationJson(refreshed.custody) !== verificationJson(authorized.custody) || refreshed.hostPolicyDigest !== authorized.hostPolicyDigest) throw new Error('Execution custody changed');
  for (const identity of authorized.identities) {
    const info = await stat(identity.path);
    if (await realpath(identity.path) !== identity.path || String(info.dev) !== identity.device || String(info.ino) !== identity.inode) throw new Error('Resource moved before execution');
  }
}

function immutableGitArgs(authorized: AuthorizedVerification, operands: readonly string[]): string[] {
  return [
    '--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '--no-pager',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never',
    `--git-dir=${authorized.resource.gitDir}`, `--work-tree=${authorized.resource.checkout}`, ...operands,
  ];
}

const immutableGitEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', LANG: 'C',
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

/** Mount an optional disposable worktree image at the same path for both legs. */
export function runConfinedProfile(
  authorized: AuthorizedVerification, signal: AbortSignal, image?: string, profileArgs = authorized.profile.args, reporterFile?: string, reportPath?: string,
): Promise<VerificationEvidence['outcome']> {
  const args: string[] = [...namespaceFlags, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/exarchos-home'];
  for (const path of authorized.runtimePaths) args.push('--ro-bind', path, path);
  args.push('--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64');
  const imageMount = image !== undefined && authorized.profile.adequacy?.reporter === 'vitest' ? '--bind' : '--ro-bind';
  args.push(imageMount, image ?? authorized.resource.checkout, authorized.resource.checkout);
  if (image !== undefined && authorized.profile.adequacy?.dependencyRoot !== undefined) {
    args.push('--ro-bind', authorized.profile.adequacy.dependencyRoot, authorized.resource.checkout + '/node_modules');
  }
  if (reporterFile !== undefined) {
    args.push('--ro-bind', reporterFile, '/tmp/exarchos-adequacy-reporter.mjs');
    args.push('--ro-bind', join(dirname(reporterFile), 'hosts'), '/etc/hosts');
  }
  if (reportPath !== undefined) args.push('--bind', reportPath, '/tmp/exarchos-adequacy-report');
  for (const path of new Set([authorized.resource.repository, authorized.resource.gitDir])) args.push('--ro-bind', path, path);
  args.push('--chdir', authorized.resource.checkout, '--setenv', 'PATH', [...authorized.runtimePaths.map(path => path + '/bin'), '/usr/bin', '/bin'].join(':'),
    '--setenv', 'LANG', 'C', '--setenv', 'HOME', '/tmp/exarchos-home', '--setenv', 'XDG_STATE_HOME', '/tmp/state', '--', authorized.profile.executable, ...profileArgs);
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ status: 'failed', exitCode: null, reason: 'Host canceled before execution', stdoutBase64: '', stderrBase64: '' }); return; }
    const child = spawn(authorized.bwrap, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const outputLimit = image === undefined ? 4096 : 64 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let reason = '';
    const stop = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const abort = () => { reason = 'Host canceled execution'; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { reason = 'Execution deadline exceeded'; stop(); }, authorized.profile.timeoutMs);
    child.stdout.on('data', (bytes: Buffer) => { outBytes += bytes.length; if (outBytes > outputLimit) { reason = 'Output limit exceeded'; stop(); } else stdout.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { errBytes += bytes.length; if (errBytes > outputLimit) { reason = 'Output limit exceeded'; stop(); } else stderr.push(bytes); });
    child.once('error', () => { reason = 'Confinement process unavailable'; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ status: code === 0 && !reason ? 'passed' : 'failed', exitCode: code, reason: reason || (code === 0 ? 'Approved probe completed' : 'Approved probe failed'), stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64') });
    });
  });
}

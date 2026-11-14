/** The verifier alone starts fixed operator profiles inside an explicit Linux namespace boundary. */
import { spawn } from 'node:child_process';
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
  const refreshed = await authorizeVerification(authorized.policy, authorized.provisioningPath, authorized.request);
  if (verificationJson(refreshed.custody) !== verificationJson(authorized.custody) || refreshed.hostPolicyDigest !== authorized.hostPolicyDigest) throw new Error('Execution custody changed');
  for (const identity of authorized.identities) {
    const info = await stat(identity.path);
    if (await realpath(identity.path) !== identity.path || String(info.dev) !== identity.device || String(info.ino) !== identity.inode) throw new Error('Resource moved before execution');
  }
  const args: string[] = [...namespaceFlags, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  for (const path of authorized.runtimePaths) args.push('--ro-bind', path, path);
  args.push('--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64');
  args.push('--ro-bind', authorized.resource.checkout, authorized.resource.checkout);
  for (const path of new Set([authorized.resource.repository, authorized.resource.gitDir])) args.push('--ro-bind', path, path);
  args.push('--chdir', authorized.resource.checkout, '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C', '--', authorized.profile.executable, ...authorized.profile.args);
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ status: 'failed', exitCode: null, reason: 'Host canceled before execution', stdoutBase64: '', stderrBase64: '' }); return; }
    const child = spawn(authorized.bwrap, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let reason = '';
    const stop = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    const abort = () => { reason = 'Host canceled execution'; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { reason = 'Execution deadline exceeded'; stop(); }, authorized.profile.timeoutMs);
    child.stdout.on('data', (bytes: Buffer) => { outBytes += bytes.length; if (outBytes > 4096) { reason = 'Output limit exceeded'; stop(); } else stdout.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { errBytes += bytes.length; if (errBytes > 4096) { reason = 'Output limit exceeded'; stop(); } else stderr.push(bytes); });
    child.once('error', () => { reason = 'Confinement process unavailable'; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ status: code === 0 && !reason ? 'passed' : 'failed', exitCode: code, reason: reason || (code === 0 ? 'Approved probe completed' : 'Approved probe failed'), stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64') });
    });
  });
}

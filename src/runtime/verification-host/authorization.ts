/** Authorize exact configured subjects and disjoint resources before a durable execution claim. */
import { realpath, stat, open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { verificationJson, verificationKey, type VerificationRequest } from '../../contract/verification/harness-verification.js';
import { createGitObserver } from '../../utils/git-observer.js';
import type { HostProvisioning } from './provisioning.js';

/** Canonical path overlap is forbidden between every exposed mount and private control resource. */
export function pathsOverlap(a: string, b: string): boolean {
  const within = (parent: string, child: string) => {
    const suffix = relative(parent, child);
    return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
  };
  return within(a, b) || within(b, a);
}

/**
 * Git observation and confinement setup run outside the sandbox. Require
 * canonical system-owned executables and system-owned, non-writable ancestry.
 */
export async function trustedSystemExecutable(path: string, name: string): Promise<string> {
  if (!isAbsolute(path) || basename(path) !== name || await realpath(path) !== path) {
    throw new Error(`A canonical system executable is required for ${name}`);
  }
  const executable = await lstat(path);
  if (!executable.isFile() || executable.uid !== 0 || (executable.mode & 0o6022) !== 0
    || (executable.mode & 0o111) === 0) throw new Error(`Unsafe executable for ${name}`);
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const directory = await lstat(ancestor);
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) {
      throw new Error(`Unsafe executable ancestor for ${name}`);
    }
    if (ancestor === dirname(ancestor)) return path;
  }
}

/** Read every mount record, including short reads before EOF. */
async function readMounts() {
  const maximum = 1024 * 1024;
  const file = await open('/proc/self/mountinfo', 'r');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const bytes = Buffer.alloc(Math.min(8192, maximum - size + 1));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maximum) throw new Error('Unsupported mount table size');
      chunks.push(bytes.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  const raw = Buffer.concat(chunks, size).toString('utf8');
  if (raw.length === 0 || !raw.endsWith('\n')) throw new Error('Incomplete mount table');
  const unescape = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
  return raw.trimEnd().split('\n').map(line => {
    const [, , device, root, path] = line.split(' ');
    if (device === undefined || !/^\d+:\d+$/.test(device) || root === undefined
      || path === undefined || !isAbsolute(root) || !isAbsolute(path)) throw new Error('Invalid mount table entry');
    return { device, root: unescape(root), path: unescape(path) };
  });
}

/** Convert a canonical host path to its underlying location within the filesystem. */
function mountedLocation(mounts: Awaited<ReturnType<typeof readMounts>>, path: string) {
  const covers = mounts.filter(mount => mount.path === path || path.startsWith(mount.path === '/' ? '/' : mount.path + '/'));
  const mount = covers.reduce<(typeof covers)[number] | undefined>(
    (deepest, current) => deepest === undefined || current.path.length > deepest.path.length ? current : deepest, undefined);
  if (mount === undefined || covers.filter(entry => entry.path === mount.path).length !== 1) {
    throw new Error('Mount identity is ambiguous');
  }
  return { device: mount.device, path: join(mount.root, relative(mount.path, path)) };
}

/** Resolve operator policy into immutable resource identities and a fixed executable profile. */
export async function authorizeVerification(policy: HostProvisioning, provisioningPath: string, request: VerificationRequest) {
  const { key, ...rest } = request;
  if (key !== verificationKey(rest)) throw new Error('Noncanonical request key');
  const resource = policy.resources.find(value => value.id === request.resourceId);
  const profile = policy.profiles.find(value => value.id === request.profileId);
  if (!resource || !profile || policy.resources.filter(value => value.id === request.resourceId).length !== 1
    || policy.profiles.filter(value => value.id === request.profileId).length !== 1
    || verificationJson(resource.subject) !== verificationJson(request.subject) || profile.digest !== request.subject.profileDigest) throw new Error('Request does not match operator policy');
  const paths = [...new Set([resource.checkout, resource.repository, resource.gitDir])];
  const gitPath = await trustedSystemExecutable(policy.gitPath, 'git');
  const bwrap = await trustedSystemExecutable(policy.bwrapPath, 'bwrap');
  if (paths.some(path => pathsOverlap(path, bwrap) || pathsOverlap(path, gitPath))) {
    throw new Error('System executable overlaps an exposed checkout');
  }
  const observer = await createGitObserver(gitPath);
  const selected = await observer.checkout(resource);
  const ancestry = await observer.ancestry(resource, request.subject.baseCommit, request.subject.headCommit);
  if (selected.kind !== 'observed' || selected.value.gitDir !== resource.gitDir || selected.value.head !== request.subject.headCommit
    || ancestry.kind !== 'observed' || !ancestry.value) throw new Error('Registered Git coordinates differ');
  for (const blocker of request.subject.blockerHeads) {
    const result = await observer.ancestry(resource, blocker, request.subject.headCommit);
    if (result.kind !== 'observed' || !result.value) throw new Error('Blocker head differs');
  }
  const identities = [];
  for (const path of paths) {
    if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Canonical resource required');
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error('Directory resource required');
    identities.push({ path, device: String(info.dev), inode: String(info.ino) });
  }
  const controls = await Promise.all([policy.stateDir, dirname(policy.socketPath), dirname(policy.tokenPath), dirname(policy.privateKeyPath), dirname(provisioningPath)].map(path => realpath(path)));
  const controlIdentities = await Promise.all(controls.map(path => stat(path)));
  const runtimePaths = await Promise.all(policy.runtimePaths.map(path => realpath(path)));
  const executable = await realpath(profile.executable);
  const mounts = await readMounts();
  const controlLocations = controls.map(path => mountedLocation(mounts, path));
  for (const path of [policy.tokenPath, policy.privateKeyPath, provisioningPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Control file authority changed');
  }
  if (!runtimePaths.some(path => executable === path || executable.startsWith(`${path}${sep}`))) throw new Error('Executable is outside approved runtime mounts');
  for (const exposed of [...paths, ...runtimePaths]) {
    if (mounts.some(mount => mount.path !== exposed && mount.path.startsWith(`${exposed}${sep}`))) throw new Error('Nested resource mounts are unsupported');
    const info = await stat(exposed);
    const location = mountedLocation(mounts, exposed);
    if (controlLocations.some(control => control.device === location.device && pathsOverlap(location.path, control.path))) {
      throw new Error('Exposed mount source overlaps private control');
    }
    if (controlIdentities.some(control => control.dev === info.dev && control.ino === info.ino) || controls.some(control => pathsOverlap(exposed, control))) throw new Error('Control resources overlap exposed mounts');
  }
  for (const configured of policy.resources) {
    const other = await realpath(configured.checkout);
    if (other !== resource.checkout && pathsOverlap(other, resource.checkout)) throw new Error('Overlapping checkout authority');
  }
  const mountsAndTools = [...new Set([...paths, ...runtimePaths, bwrap, executable, gitPath])];
  const custody = await Promise.all(mountsAndTools.map(async path => {
    const info = await stat(path);
    return { path, canonical: await realpath(path), device: String(info.dev), inode: String(info.ino), mode: info.mode, uid: info.uid };
  }));
  const hostPolicyDigest = createHash('sha256').update(verificationJson({ profile, runtimePaths, bwrap, gitPath, custody })).digest('hex');
  return { custody, hostPolicyDigest, policy, provisioningPath, request, resource, profile: { ...profile, executable }, identities, runtimePaths: [...new Set(runtimePaths)], bwrap };
}
export type AuthorizedVerification = Awaited<ReturnType<typeof authorizeVerification>>;

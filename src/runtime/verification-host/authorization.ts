/** Authorize exact configured subjects and disjoint resources before a durable execution claim. */
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, stat, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, isAbsolute, posix, sep } from 'node:path';
import { verificationJson, verificationKey, verificationValueDigest, type VerificationRequest } from '../../contract/verification/harness-verification.js';
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

const maximumRuntimeFileBytes = 256 * 1024 * 1024;
const maximumClosureEntries = 65536;
const maximumClosureBytes = 1024 * 1024 * 1024;

/** Digest regular runtime bytes through a bounded, non-following file handle. */
async function readPinnedFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) throw new Error('Invalid pinned runtime file');
    const hash = createHash('sha256');
    let size = 0;
    const bytes = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = await file.read(bytes, 0, bytes.length, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
      if (size > before.size) throw new Error('Pinned runtime grew');
      hash.update(bytes.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Pinned runtime changed while the verifier read it');
    }
    return { digest: hash.digest('hex'), size, executable: (before.mode & 0o111) !== 0 };
  } finally { await file.close(); }
}

/** Check exact runtime bytes at a canonical path. */
async function requireRuntimeDigest(path: string, expected: string): Promise<void> {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('Canonical runner path required');
  if ((await readPinnedFile(path, maximumRuntimeFileBytes)).digest !== expected) throw new Error('Pinned runtime digest changed');
}

/** Copy one pinned runtime file into private scratch. Accept the copy only when its bytes match the pin. */
export async function copyPinnedRuntime(source: string, target: string, expected: string): Promise<void> {
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  if ((await readPinnedFile(target, maximumRuntimeFileBytes)).digest !== expected) throw new Error('Pinned runtime digest changed');
  await chmod(target, 0o500);
}

/**
 * Measure one approved runtime directory in depth-first order of sorted names.
 * The digest covers each relative path, entry kind, executable bit, file digest and link text.
 * With a copy target, the verifier copies each entry first and measures the private copy.
 * A link must be relative and must stay inside the directory. Other entry kinds refuse.
 */
export async function measureRuntimeClosure(root: string, copy?: string): Promise<string> {
  if (!isAbsolute(root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error('Canonical runtime directory required');
  }
  const entries: unknown[] = [];
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    if (entries.length >= maximumClosureEntries) throw new Error('Runtime closure exceeds its entry bound');
    const source = path === '' ? root : join(root, path);
    const target = copy === undefined ? undefined : path === '' ? copy : join(copy, path);
    const info = await lstat(source);
    if (info.isDirectory()) {
      entries.push([path, 'directory']);
      if (target !== undefined) await mkdir(target, { mode: 0o700 });
      for (const name of (await readdir(source)).sort()) await visit(path === '' ? name : `${path}/${name}`);
    } else if (info.isFile()) {
      if (target !== undefined) await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const measured = await readPinnedFile(target ?? source, maximumClosureBytes - bytes);
      bytes += measured.size;
      if (target !== undefined) await chmod(target, measured.executable ? 0o500 : 0o400);
      entries.push([path, 'file', measured.executable, measured.digest]);
    } else if (info.isSymbolicLink()) {
      const link = await readlink(source);
      const resolved = posix.normalize(posix.join(posix.dirname(path), link));
      if (posix.isAbsolute(link) || resolved === '..' || resolved.startsWith('../')) throw new Error('Runtime closure link leaves its directory');
      if (target !== undefined) await symlink(link, target);
      entries.push([path, 'link', link]);
    } else throw new Error('Unsupported runtime closure entry');
  };
  await visit('');
  return verificationValueDigest(entries);
}

/**
 * Resolve operator policy into immutable resource identities and a fixed executable profile.
 * The first authorization measures approved runtime closures to refuse a wrong pin before a claim.
 * A recheck skips that measurement, because each leg mounts a measured private copy.
 */
export async function authorizeVerification(
  policy: HostProvisioning, provisioningPath: string, request: VerificationRequest, measureClosures = true,
) {
  const { key, ...rest } = request;
  if (key !== verificationKey(rest)) throw new Error('Noncanonical request key');
  const resource = policy.resources.find(value => value.id === request.resourceId);
  const profile = policy.profiles.find(value => value.id === request.profileId);
  if (!resource || !profile || policy.resources.filter(value => value.id === request.resourceId).length !== 1
    || policy.profiles.filter(value => value.id === request.profileId).length !== 1
    || verificationJson(resource.subject) !== verificationJson(request.subject) || profile.digest !== request.subject.profileDigest) throw new Error('Request does not match operator policy');
  if (request.operation === 'adequacy' &&
      (profile.adequacy === undefined
      || verificationJson(profile.adequacy.selection) !== verificationJson(request.selection)
      || verificationValueDigest(request.selection) !== request.subject.testSelectionDigest
      || verificationValueDigest({ command: profile.adequacy.command, files: profile.adequacy.files }) !== request.commandDigest)) {
    throw new Error('Adequacy selection is not authorized');
  }
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
  const dependencies = profile.adequacy?.dependencyRoot;
  if (dependencies !== undefined &&
      (!isAbsolute(dependencies) || await realpath(dependencies) !== dependencies ||
      !runtimePaths.includes(dependencies) || !(await stat(dependencies)).isDirectory())) {
    throw new Error('Adequacy dependencies require an explicitly approved canonical runtime directory');
  }
  const mounts = await readMounts();
  const controlLocations = controls.map(path => mountedLocation(mounts, path));
  for (const path of [policy.tokenPath, policy.privateKeyPath, provisioningPath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Control file authority changed');
  }
  const mountedRuntime = (file: string) => runtimePaths.some(path => file.startsWith(path + sep));
  if (!mountedRuntime(executable)) throw new Error('Executable is outside approved runtime mounts');
  if (request.operation === 'adequacy') {
    const configured = profile.adequacy;
    if (configured === undefined || configured.controlPaths.length !== new Set(configured.controlPaths).size ||
      configured.controlPaths.some(path => request.selection.sources.includes(path))) {
      throw new Error('Adequacy control inputs must be frozen outside the source revert');
    }
    const node = configured.reporter !== 'vitest';
    const { npmRoot, npmEntry: entry } = configured;
    const supported = node
      ? verificationJson(configured.command) === verificationJson(['node', '--test']) &&
        configured.files === 'as-arguments' && verificationJson(profile.args) === verificationJson(['--test']) &&
        npmRoot === undefined && entry === undefined && dependencies === undefined
      : verificationJson(configured.command) === verificationJson(['npm', 'run', 'test:files']) &&
        configured.files === 'after-separator' && dependencies !== undefined &&
        configured.dependencyDigest !== undefined && configured.npmDigest !== undefined &&
        npmRoot !== undefined && isAbsolute(npmRoot) && await realpath(npmRoot) === npmRoot && mountedRuntime(npmRoot) &&
        entry !== undefined && entry.startsWith(npmRoot + sep) && await realpath(entry) === entry &&
        configured.controlPaths.includes('package.json') &&
        configured.controlPaths.includes('tools/test-helpers/run-test-files.mjs') &&
        configured.controlPaths.some(path => /^vitest\.config\.[cm]?[jt]s$/.test(path)) &&
        verificationJson(profile.args) === verificationJson([entry, 'run', 'test:files']);
    if (!supported || paths.some(path => pathsOverlap(path, executable) || (
      npmRoot !== undefined && pathsOverlap(path, npmRoot)
    ))) throw new Error('Unsupported hosted adequacy runner');
    await requireRuntimeDigest(executable, configured.runnerDigest);
    if (!node && measureClosures && (
      await measureRuntimeClosure(npmRoot ?? '') !== configured.npmDigest ||
      await measureRuntimeClosure(dependencies ?? '') !== configured.dependencyDigest)) {
      throw new Error('Approved npm or dependency closure differs from its pin');
    }
  }
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
  const npm = request.operation === 'adequacy' ? [profile.adequacy?.npmRoot, profile.adequacy?.npmEntry, dependencies] : [];
  const mountsAndTools = [...new Set([...paths, ...runtimePaths, bwrap, executable, gitPath,
    ...npm.filter(path => path !== undefined)])];
  const custody = await Promise.all(mountsAndTools.map(async path => {
    const info = await stat(path);
    return { path, canonical: await realpath(path), device: String(info.dev), inode: String(info.ino), mode: info.mode, uid: info.uid };
  }));
  const hostPolicyDigest = createHash('sha256').update(verificationJson({ profile, runtimePaths, bwrap, gitPath, custody })).digest('hex');
  return { custody, hostPolicyDigest, policy, provisioningPath, request, resource, gitPath, profile: { ...profile, executable }, identities, runtimePaths: [...new Set(runtimePaths)], bwrap };
}
export type AuthorizedVerification = Awaited<ReturnType<typeof authorizeVerification>>;

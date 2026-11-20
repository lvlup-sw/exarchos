/** Authorize exact configured subjects and disjoint resources before a durable execution claim. */
import { chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, stat, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, isAbsolute, posix, sep } from 'node:path';
import {
  checkPlanDigest, isHostedCheckRequest, verificationJson, verificationKey, verificationValueDigest, type VerificationRequest,
} from '../../contract/verification/harness-verification.js';
import { createGitObserver } from '../../utils/git-observer.js';
import type { HostCheckProfile, HostProvisioning } from './provisioning.js';

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

/**
 * Copy one regular runtime file through a handle that follows no link and does not block.
 * The verifier checks the type, size and identity of the source before it copies a byte.
 * The copy reads the checked open file through its descriptor link, so a reflink clone keeps large closures fast.
 * The target is a new private file, and a source change during the copy refuses.
 */
async function copyRuntimeFile(source: string, target: string, maximum: number): Promise<void> {
  const before = await lstat(source);
  if (!before.isFile() || before.size > maximum) throw new Error('Invalid pinned runtime source');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Pinned runtime source changed before its copy');
    }
    await copyFile(`/proc/self/fd/${input.fd}`, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const copied = await lstat(target);
    if (!copied.isFile() || copied.size !== opened.size) throw new Error('Pinned runtime copy differs in size');
    const after = await input.stat();
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== opened.size) {
      throw new Error('Pinned runtime source changed during its copy');
    }
  } finally { await input.close(); }
}

/** Copy one pinned runtime file into private scratch. Accept the copy only when its bytes match the pin. */
export async function copyPinnedRuntime(source: string, target: string, expected: string): Promise<void> {
  await copyRuntimeFile(source, target, maximumRuntimeFileBytes);
  if ((await readPinnedFile(target, maximumRuntimeFileBytes)).digest !== expected) throw new Error('Pinned runtime digest changed');
  await chmod(target, 0o500);
}

const closureConcurrency = 16;

/** Run at most a fixed number of filesystem tasks at once. Each waiting task starts when one task ends. */
function closureLimiter(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= size) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await task(); } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Measure one approved runtime directory in depth-first order of sorted names.
 * The digest covers each relative path, entry kind, executable bit, file digest and link text.
 * With a copy target, the verifier copies each entry first and measures the private copy.
 * A link must be relative and must stay inside the directory. Other entry kinds refuse.
 * Entries run concurrently under a fixed limit, and the digest keeps the sorted depth-first order.
 */
export async function measureRuntimeClosure(root: string, copy?: string): Promise<string> {
  if (!isAbsolute(root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
    throw new Error('Canonical runtime directory required');
  }
  const limit = closureLimiter(closureConcurrency);
  let count = 0;
  let bytes = 0;
  const visit = async (path: string): Promise<unknown[]> => {
    if (++count > maximumClosureEntries) throw new Error('Runtime closure exceeds its entry bound');
    const source = path === '' ? root : join(root, path);
    const target = copy === undefined ? undefined : path === '' ? copy : join(copy, path);
    const own = await limit(async (): Promise<{ entry: unknown; children?: string[] }> => {
      const info = await lstat(source);
      if (info.isDirectory()) {
        if (target !== undefined) await mkdir(target, { mode: 0o700 });
        return { entry: [path, 'directory'], children: (await readdir(source)).sort() };
      }
      if (info.isFile()) {
        if (target !== undefined) await copyRuntimeFile(source, target, maximumClosureBytes - bytes);
        const measured = await readPinnedFile(target ?? source, maximumClosureBytes - bytes);
        bytes += measured.size;
        if (bytes > maximumClosureBytes) throw new Error('Runtime closure exceeds its byte bound');
        if (target !== undefined) await chmod(target, measured.executable ? 0o500 : 0o400);
        return { entry: [path, 'file', measured.executable, measured.digest] };
      }
      if (info.isSymbolicLink()) {
        const link = await readlink(source);
        const resolved = posix.normalize(posix.join(posix.dirname(path), link));
        if (posix.isAbsolute(link) || resolved === '..' || resolved.startsWith('../')) throw new Error('Runtime closure link leaves its directory');
        if (target !== undefined) await symlink(link, target);
        return { entry: [path, 'link', link] };
      }
      throw new Error('Unsupported runtime closure entry');
    });
    if (own.children === undefined) return [own.entry];
    const nested = await Promise.all(own.children.map(name => visit(path === '' ? name : `${path}/${name}`)));
    return [own.entry, ...nested.flat()];
  };
  return verificationValueDigest(await visit(''));
}

/** A closure entry is a plain relative path that cannot leave its directory. */
function closurePath(path: string): boolean {
  return !path.includes('\\') && !/[\x00-\x1f\x7f]/.test(path) && !isAbsolute(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** The typed scope of an operator check profile, without its execution terms. */
export function checkPlanOf(profile: HostCheckProfile) {
  return {
    operation: profile.operation,
    legs: profile.legs.map(({ entry: _entry, executable: _executable, executableDigest: _digest, ...leg }) => leg),
    ...(profile.report === undefined ? {} : { report: profile.report }),
    ...(profile.files === undefined ? {} : { files: profile.files }),
    ...(profile.firstParty === undefined ? {} : { firstParty: profile.firstParty }),
    ...(profile.onTestFailure === undefined ? {} : { onTestFailure: profile.onTestFailure }),
  };
}

/**
 * Bind a check to its approved command policy, pinned runner, dependency closure and binaries.
 * The first authorization measures the closure. A recheck skips that measurement, because each leg mounts a measured private copy.
 */
async function authorizeCheck(
  request: Extract<VerificationRequest, { operation: 'static-analysis' | 'contract-drift' | 'integration-suite' | 'spec-coverage' | 'lifecycle' }>,
  configured: HostCheckProfile | undefined, executable: string, exposed: readonly string[],
  mountedRuntime: (file: string) => boolean, runtimePaths: readonly string[], measureClosures: boolean,
): Promise<string[]> {
  if (configured === undefined || configured.operation !== request.operation || checkPlanDigest(checkPlanOf(configured)) !== request.commandDigest) {
    throw new Error('Check command policy is not authorized');
  }
  if (request.operation === 'spec-coverage') {
    if (configured.selection === undefined || verificationJson(configured.selection) !== verificationJson(request.selection)
      || verificationValueDigest(request.selection) !== request.subject.testSelectionDigest) throw new Error('Declared test selection is not authorized');
  } else if (configured.selection !== undefined) throw new Error('A task check takes no declared test selection');
  if (request.operation === 'lifecycle'
    ? configured.legs.some(leg => leg.kind !== 'command' && leg.kind !== 'typecheck') : configured.onTestFailure !== undefined) {
    throw new Error('A lifecycle check runs only test and typecheck legs');
  }
  if (basename(executable) !== 'node' || exposed.some(path => pathsOverlap(path, executable))) throw new Error('A check runner must be the pinned node executable');
  await requireRuntimeDigest(executable, configured.runnerDigest);
  const { dependencyRoot, dependencyDigest } = configured;
  if ((dependencyRoot === undefined) !== (dependencyDigest === undefined)) throw new Error('A dependency closure requires its digest');
  if (dependencyRoot !== undefined) {
    if (!isAbsolute(dependencyRoot) || await realpath(dependencyRoot) !== dependencyRoot || !runtimePaths.includes(dependencyRoot)
      || !(await stat(dependencyRoot)).isDirectory() || exposed.some(path => pathsOverlap(path, dependencyRoot))) {
      throw new Error('Check dependencies require a separate approved canonical runtime directory');
    }
    if (measureClosures && await measureRuntimeClosure(dependencyRoot) !== dependencyDigest) throw new Error('Approved check closure differs from its pin');
  }
  const binaries: string[] = [];
  for (const leg of configured.legs) {
    if (leg.entry !== undefined && (leg.executable !== undefined || dependencyRoot === undefined || !closurePath(leg.entry))) {
      throw new Error('A check entry requires the pinned dependency closure');
    }
    if (leg.executable !== undefined) {
      const binary = leg.executable;
      if (leg.executableDigest === undefined || !isAbsolute(binary) || await realpath(binary) !== binary || !mountedRuntime(binary)
        || exposed.some(path => pathsOverlap(path, binary))) throw new Error('A check binary requires an approved pinned path');
      await requireRuntimeDigest(binary, leg.executableDigest);
      binaries.push(binary);
    } else if (leg.executableDigest !== undefined) throw new Error('A binary digest requires its binary');
    if (leg.entry === undefined && leg.executable === undefined && leg.argv[0] !== 'node') throw new Error('An unmapped check program is refused');
  }
  return dependencyRoot === undefined ? binaries : [dependencyRoot, ...binaries];
}

/**
 * A head-free checkout resource authorizes only the lifecycle check under its pinned profile.
 * Every other resource authorizes only an operation of another kind with an exactly equal subject and profile digest.
 */
function subjectAuthorized(pinned: HostProvisioning['resources'][number]['subject'], profileDigest: string, request: VerificationRequest): boolean {
  if ('scope' in pinned && pinned.scope === 'checkout') {
    return request.operation === 'lifecycle' && request.subject.scope === 'checkout' && pinned.profileId === request.profileId;
  }
  return request.operation !== 'lifecycle' && verificationJson(pinned) === verificationJson(request.subject) && profileDigest === request.subject.profileDigest;
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
    || !subjectAuthorized(resource.subject, profile.digest, request)) throw new Error('Request does not match operator policy');
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
  const subject = request.subject;
  const selected = await observer.checkout(resource);
  if (selected.kind !== 'observed' || selected.value.gitDir !== resource.gitDir || selected.value.head !== subject.headCommit) {
    throw new Error('Registered Git coordinates differ');
  }
  if (!('scope' in subject)) {
    const ancestry = await observer.ancestry(resource, subject.baseCommit, subject.headCommit);
    if (ancestry.kind !== 'observed' || !ancestry.value) throw new Error('Registered Git coordinates differ');
    for (const blocker of subject.blockerHeads) {
      const result = await observer.ancestry(resource, blocker, subject.headCommit);
      if (result.kind !== 'observed' || !result.value) throw new Error('Blocker head differs');
    }
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
      !runtimePaths.includes(dependencies) || !(await stat(dependencies)).isDirectory()
      || paths.some(path => pathsOverlap(path, dependencies)))) {
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
        npmRoot === undefined && entry === undefined && dependencies === undefined &&
        configured.npmDigest === undefined && configured.dependencyDigest === undefined
      : basename(executable) === 'node' &&
        verificationJson(configured.command) === verificationJson(['npm', 'run', 'test:files']) &&
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
  if (request.operation !== 'adequacy' && profile.adequacy !== undefined) throw new Error('An adequacy profile serves no other operation');
  if (!isHostedCheckRequest(request) && profile.check !== undefined) throw new Error('A check profile serves only its check operation');
  const checkTools = isHostedCheckRequest(request)
    ? await authorizeCheck(request, profile.check, executable, paths, mountedRuntime, runtimePaths, measureClosures) : [];
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
    ...npm.filter(path => path !== undefined), ...checkTools])];
  const custody = await Promise.all(mountsAndTools.map(async path => {
    const info = await stat(path);
    return { path, canonical: await realpath(path), device: String(info.dev), inode: String(info.ino), mode: info.mode, uid: info.uid };
  }));
  const hostPolicyDigest = createHash('sha256').update(verificationJson({ profile, runtimePaths, bwrap, gitPath, custody })).digest('hex');
  return { custody, hostPolicyDigest, policy, provisioningPath, request, resource, gitPath, profile: { ...profile, executable }, identities, runtimePaths: [...new Set(runtimePaths)], bwrap };
}
export type AuthorizedVerification = Awaited<ReturnType<typeof authorizeVerification>>;

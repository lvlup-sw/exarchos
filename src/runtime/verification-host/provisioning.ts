/** Protected operator provisioning is independent of checkout configuration and action inputs. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { AdequacySelection, VerificationSubject, verifierSignerId } from '../../contract/verification/harness-verification.js';

export const HostProvisioning = z.object({
  version: z.literal(1), socketPath: z.string(), stateDir: z.string(), tokenPath: z.string(), privateKeyPath: z.string(), publicKey: z.string().max(4096),
  bwrapPath: z.string(), gitPath: z.string(), runtimePaths: z.array(z.string()).min(1).max(16),
  profiles: z.array(z.object({ id: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), executable: z.string(), args: z.array(z.string().max(1024)).max(32), timeoutMs: z.number().int().min(100).max(30000),
    adequacy: z.object({
      command: z.array(z.string().min(1).max(1024)).min(1).max(32),
      selection: AdequacySelection,
      files: z.enum(['as-arguments', 'after-separator']),
      runnerDigest: z.string().regex(/^[a-f0-9]{64}$/),
      controlPaths: z.array(z.string().min(1).max(300)).max(40).refine(paths =>
        AdequacySelection.safeParse({ tests: paths, sources: [] }).success),
      reporter: z.enum(['node', 'vitest']).optional(),
      dependencyRoot: z.string().optional(),
      npmEntry: z.string().optional(),
      npmDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }).strict().optional(),
  }).strict()).min(1).max(32),
  resources: z.array(z.object({ id: z.string(), checkout: z.string(), repository: z.string(), gitDir: z.string(), branch: z.string(), subject: VerificationSubject }).strict()).min(1).max(64),
}).strict();
export type HostProvisioning = z.infer<typeof HostProvisioning>;

/** Require a canonical private directory owned by the current trusted control identity. */
export async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('Canonical absolute private directory required');
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    const trustedOwner = info.uid === 0 || info.uid === process.getuid?.();
    const trustedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || !trustedOwner || ((info.mode & 0o022) !== 0 && !trustedSticky)) throw new Error('Untrusted private directory ancestor');
    if (ancestor === dirname(ancestor)) break;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Private directory owner or mode differs');
  return path;
}

type ProtectedFileIdentity = Readonly<{ isFile(): boolean; nlink: number; uid: number; mode: number; size: number }>;

/** Check file ownership independently of the surrounding directory. */
export function isProtectedVerifierFile(info: ProtectedFileIdentity, controlUid: number | undefined): boolean {
  return info.isFile() && info.nlink === 1 && info.uid === controlUid
    && (info.mode & 0o777) === 0o600 && info.size <= 65536;
}

/** Bound protected regular-file reads reject symlinks and raced replacements. */
export async function readProtected(path: string): Promise<string> {
  await privateDirectory(dirname(path));
  const before = await lstat(path);
  if (!isProtectedVerifierFile(before, process.getuid?.())) throw new Error('Protected file owner, mode or size differs');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== before.uid || stat.mode !== before.mode || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw new Error('Protected file changed');
    const bytes = Buffer.alloc(65537);
    const read = await fd.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) throw new Error('Protected file changed size');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
  } finally { await fd.close(); }
}

/** Load the separately provisioned signer and policy without importing project code. */
export async function loadHostProvisioning(path: string) {
  if (process.platform !== 'linux') throw new Error('Hosted verifier requires supported Linux confinement');
  const policy = HostProvisioning.parse(JSON.parse(await readProtected(path)));
  await privateDirectory(policy.stateDir);
  await privateDirectory(dirname(policy.socketPath));
  if (!isAbsolute(policy.socketPath) || resolve(policy.socketPath) !== policy.socketPath) throw new Error('Canonical socket path required');
  const token = await readProtected(policy.tokenPath);
  if (token.length < 32 || token.length > 4096) throw new Error('Invalid operator credential');
  const privateKey = createPrivateKey(await readProtected(policy.privateKeyPath));
  const signerId = verifierSignerId(privateKey);
  if (signerId !== verifierSignerId(policy.publicKey)) throw new Error('Signer provisioning mismatch');
  return { policy, token, privateKey, signerId, provisioningPath: path };
}

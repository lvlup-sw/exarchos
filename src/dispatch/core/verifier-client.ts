// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — staged client for externally provisioned verifier authority.
/** The governor client reads private provisioning and never starts an execution host. */
import { connect } from 'node:net';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { VerificationRequest, type VerificationReply, authenticateVerificationReply, encodeVerificationFrame, verificationFrameReader, verificationDigest, verifierSignerId } from '../../contract/verification/harness-verification.js';

const provisioningSchema = z.object({ version: z.literal(1), socketPath: z.string(), tokenPath: z.string(), publicKey: z.string().max(4096) }).strict();

/** Independently validate the client's protected files without importing host execution code. */
async function protectedFile(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error('Noncanonical client provisioning');
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error('Unsafe client provisioning parent');
  for (let ancestor = dirname(dirname(path)); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.())
      || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new Error('Unsafe provisioning ancestor');
    if (ancestor === dirname(ancestor)) break;
  }
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size > 65536) throw new Error('Unsafe client provisioning file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode !== before.mode || info.uid !== before.uid || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw new Error('Client provisioning changed');
    const bytes = Buffer.alloc(65537);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size) throw new Error('Client provisioning changed size');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead));
  } finally { await file.close(); }
}

/** Exchange exactly one bounded frame and authenticate the full original response. */
export async function createVerifierClient(path: string) {
  if (process.platform !== 'linux') throw new Error('Verifier platform unsupported');
  const policy = provisioningSchema.parse(JSON.parse(await protectedFile(path)));
  const token = await protectedFile(policy.tokenPath);
  if (token.length < 32 || token.length > 4096) throw new Error('Invalid client credential');
  verifierSignerId(policy.publicKey);
  const exchange = async (command: unknown, key: string, digest: string): Promise<VerificationReply | { kind: 'unavailable'; reason: string }> => {
    try {
      if (!isAbsolute(policy.socketPath) || resolve(policy.socketPath) !== policy.socketPath || await realpath(dirname(policy.socketPath)) !== dirname(policy.socketPath)) throw new Error('Noncanonical socket');
      for (let ancestor = dirname(dirname(policy.socketPath)); ; ancestor = dirname(ancestor)) {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || (info.uid !== 0 && info.uid !== process.getuid?.()) || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new Error('Unsafe socket ancestor');
        if (ancestor === dirname(ancestor)) break;
      }
      const parent = await lstat(dirname(policy.socketPath));
      const socketInfo = await lstat(policy.socketPath);
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700
        || !socketInfo.isSocket() || socketInfo.uid !== process.getuid?.() || (socketInfo.mode & 0o777) !== 0o600) throw new Error('Socket authority differs');
      const frame = encodeVerificationFrame(command);
      return await new Promise((resolve, reject) => {
        const socket = connect({ path: policy.socketPath, allowHalfOpen: true });
        const reader = verificationFrameReader();
        const timer = setTimeout(() => { socket.destroy(); reject(new Error('Verifier transport deadline')); }, 40000);
        socket.once('connect', () => socket.write(frame));
        socket.on('data', bytes => { try { reader.push(bytes); } catch (error) { socket.destroy(); reject(error); } });
        socket.once('error', reject);
        socket.once('end', () => {
          try { resolve(authenticateVerificationReply(reader.finish(), policy.publicKey, key, digest)); }
          catch (error) { reject(error); }
          finally { clearTimeout(timer); socket.destroy(); }
        });
        socket.once('close', () => { clearTimeout(timer); reject(new Error('Verifier transport closed without authenticated evidence')); });
      });
    } catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'Verifier unavailable' }; }
  };
  return {
    submit(request: VerificationRequest) {
      const checked = VerificationRequest.parse(request);
      return exchange({ version: 1, action: 'submit', token, request: checked }, checked.key, verificationDigest(checked));
    },
    retrieve(key: string, digest: string) { return exchange({ version: 1, action: 'retrieve', token, key, digest }, key, digest); },
  };
}

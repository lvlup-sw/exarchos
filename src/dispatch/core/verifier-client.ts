// RESERVED(issue: #1928, owner: exarchos, expires: 2027-02-28) — staged client for externally provisioned verifier authority.
/** The governor client reads private provisioning and never starts an execution host. */
import { connect } from 'node:net';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { VerificationRequest, type VerificationReply, type VerificationRequestCarrier, authenticateVerificationReply, encodeVerificationFrame, verificationFrameReader, verificationDigest, verifierSignerId } from '../../contract/verification/harness-verification.js';

/** The longest total poll of one request. A longer run stays pending, and a later call retrieves its original result. */
const MAXIMUM_POLL_MS = 900_000;
const provisioningSchema = z.object({
  version: z.literal(1), socketPath: z.string(), tokenPath: z.string(), publicKey: z.string().max(4096),
  exchangeMs: z.number().int().min(1000).max(40000).optional(),
  pollMs: z.number().int().min(1000).max(MAXIMUM_POLL_MS).optional(),
}).strict();

/** The transport deadline of one exchange. It never proves that the verifier did not run the request. */
class TransportDeadline extends Error {}

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

/**
 * Exchange exactly one bounded frame and authenticate the full original response.
 * The poll operation submits once. Only an exchange deadline starts a retrieve, and each retrieve waits for the running original.
 * Any reply, a refused connection or another transport failure stops the poll. The poll bound returns the pending outcome.
 */
export async function createVerifierClient(path: string) {
  if (process.platform !== 'linux') throw new Error('Verifier platform unsupported');
  const policy = provisioningSchema.parse(JSON.parse(await protectedFile(path)));
  const token = await protectedFile(policy.tokenPath);
  if (token.length < 32 || token.length > 4096) throw new Error('Invalid client credential');
  verifierSignerId(policy.publicKey);
  const exchangeMs = policy.exchangeMs ?? 40000;
  const pollMs = policy.pollMs ?? 660000;
  const transport = async (command: unknown, key: string, digest: string): Promise<VerificationReply | { kind: 'unavailable'; reason: string; deadline: boolean }> => {
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
        const timer = setTimeout(() => { socket.destroy(); reject(new TransportDeadline('Verifier transport deadline')); }, exchangeMs);
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
    } catch (error) {
      return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'Verifier unavailable', deadline: error instanceof TransportDeadline };
    }
  };
  const exchange = async (command: unknown, key: string, digest: string): Promise<VerificationReply | { kind: 'unavailable'; reason: string }> => {
    const reply = await transport(command, key, digest);
    return 'kind' in reply ? { kind: 'unavailable', reason: reply.reason } : reply;
  };
  return {
    submit(request: VerificationRequestCarrier) {
      const checked = VerificationRequest.parse(request);
      return exchange({ version: 1, action: 'submit', token, request: checked }, checked.key, verificationDigest(checked));
    },
    retrieve(key: string, digest: string) { return exchange({ version: 1, action: 'retrieve', token, key, digest }, key, digest); },
    async poll(request: VerificationRequestCarrier): Promise<VerificationReply | { kind: 'unavailable'; reason: string }> {
      const checked = VerificationRequest.parse(request);
      const digest = verificationDigest(checked);
      const ends = Date.now() + pollMs;
      let reply = await transport({ version: 1, action: 'submit', token, request: checked }, checked.key, digest);
      while ('kind' in reply && reply.deadline && Date.now() < ends) {
        reply = await transport({ version: 1, action: 'retrieve', token, key: checked.key, digest }, checked.key, digest);
      }
      if (!('kind' in reply)) return reply;
      return { kind: 'unavailable', reason: reply.deadline ? 'Verifier result is still pending after the poll bound' : reply.reason };
    },
  };
}

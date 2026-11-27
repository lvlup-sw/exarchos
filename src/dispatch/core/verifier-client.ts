/** The governor client reads private provisioning and never starts an execution host. */
import { connect } from 'node:net';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  VerificationRequest, type HostedCheckIdentities, type VerificationHostConnector, type VerificationReply, type VerificationRequestCarrier,
  authenticateVerificationReply, encodeVerificationFrame, verificationFrameReader, verificationDigest, verifierSignerId,
} from '../../contract/verification/harness-verification.js';

/** The longest total poll of one request. A longer run stays pending, and a later call retrieves its original result. */
const MAXIMUM_POLL_MS = 900_000;
const provisioningSchema = z.object({
  version: z.literal(1), socketPath: z.string(), tokenPath: z.string(), publicKey: z.string().max(4096),
  exchangeMs: z.number().int().min(1000).max(40000).optional(),
  pollMs: z.number().int().min(1000).max(MAXIMUM_POLL_MS).optional(),
}).strict();
type ClientPolicy = z.infer<typeof provisioningSchema>;

/** An absolute path with no relative or repeated part. */
const canonicalPath = z.string().min(1).max(4096).refine(path => isAbsolute(path) && resolve(path) === path, 'Canonical absolute path required');
/** An operator identity in the name format of the request contract. */
const identityName = z.string().min(1).max(200);
const contractDigest = z.string().regex(/^[a-f0-9]{64}$/);
const checkIdentity = z.object({ resourceId: identityName, profileId: identityName }).strict();
const checkoutIdentity = checkIdentity.extend({
  checkout: canonicalPath, repository: canonicalPath, branch: z.string().min(1).max(200), commandDigest: contractDigest,
}).strict();
const checkIdentities = z.object({
  'static-analysis': checkIdentity.optional(),
  'contract-drift': checkIdentity.optional(),
  'integration-suite': checkIdentity.optional(),
  'spec-coverage': checkIdentity.optional(),
  lifecycle: z.array(checkoutIdentity).max(64).optional(),
  integration: checkoutIdentity.optional(),
}).strict();
/** The extended client provisioning. It holds the transport fields and the operator identities of the connector. */
const connectorSchema = provisioningSchema.extend({
  gitPath: canonicalPath, resourceId: identityName, profileId: identityName, checks: checkIdentities.optional(),
}).strict();

/** The transport deadline of one exchange. It never proves that the verifier did not run the request. */
class TransportDeadline extends Error {}

/** Independently validate the client's protected files without importing host execution code. Each refusal names the path that failed. */
async function protectedFile(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`The provisioning path ${path} is not canonical`);
  const parentPath = dirname(path);
  const uid = process.getuid?.();
  for (let ancestor = dirname(parentPath); ; ancestor = dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink()) throw new Error(`The provisioning ancestor directory ${ancestor} is a symbolic link`);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid)) throw new Error(`The provisioning ancestor ${ancestor} is not a directory of a trusted owner`);
    if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) throw new Error(`The provisioning ancestor directory ${ancestor} is group or world writable`);
    if (ancestor === dirname(ancestor)) break;
  }
  const parent = await lstat(parentPath);
  if (parent.isSymbolicLink()) throw new Error(`The provisioning directory ${parentPath} is a symbolic link`);
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) throw new Error(`The provisioning directory ${parentPath} is not a private directory of this user with mode 0700`);
  if (await realpath(parentPath) !== parentPath) throw new Error(`The provisioning directory ${parentPath} is not canonical`);
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o777) !== 0o600 || before.size > 65536) {
    throw new Error(`The provisioning file ${path} is not a private regular file of this user with mode 0600`);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.mode !== before.mode || info.uid !== before.uid || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw new Error(`The provisioning file ${path} changed`);
    const bytes = Buffer.alloc(65537);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size) throw new Error(`The provisioning file ${path} changed size`);
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
  return clientFromPolicy(provisioningSchema.parse(JSON.parse(await protectedFile(path))));
}

/** Build the transport of one parsed client policy. It reads the protected credential and checks the public key first. */
async function clientFromPolicy(policy: ClientPolicy) {
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

/**
 * The outcome of one read of the verifier client provisioning.
 * Only `absent` means that the machine has no verifier. An `unusable` result carries the reason and a connector that never runs a check.
 */
export type VerifierProvisioning =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unusable'; readonly reason: string; readonly connector: VerificationHostConnector }
  | { readonly kind: 'usable'; readonly connector: VerificationHostConnector };

/** The parsed per-check identities, with only the defined entries copied, as exact optional properties require. */
function definedChecks(parsed: z.infer<typeof checkIdentities>): HostedCheckIdentities {
  return {
    ...(parsed['static-analysis'] === undefined ? {} : { 'static-analysis': parsed['static-analysis'] }),
    ...(parsed['contract-drift'] === undefined ? {} : { 'contract-drift': parsed['contract-drift'] }),
    ...(parsed['integration-suite'] === undefined ? {} : { 'integration-suite': parsed['integration-suite'] }),
    ...(parsed['spec-coverage'] === undefined ? {} : { 'spec-coverage': parsed['spec-coverage'] }),
    ...(parsed.lifecycle === undefined ? {} : { lifecycle: parsed.lifecycle }),
    ...(parsed.integration === undefined ? {} : { integration: parsed.integration }),
  };
}

/**
 * The result of provisioning that exists and cannot be used. Its connector has no checks and empty identities.
 * Its client gives the unavailable outcome and never opens a socket.
 */
function unusableProvisioning(reason: string): VerifierProvisioning {
  const unavailable: { kind: 'unavailable'; reason: string } = { kind: 'unavailable', reason };
  return {
    kind: 'unusable', reason,
    connector: { publicKey: '', gitPath: '', resourceId: '', profileId: '', client: { submit: async () => unavailable, retrieve: async () => unavailable } },
  };
}

/** The reason of one refused provisioning read. A schema refusal names each refused field. */
function refusalReason(path: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    const fields = error.issues.map(issue => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`).join('; ');
    return `The verifier client provisioning ${path} does not match its strict schema: ${fields}`;
  }
  if (error instanceof SyntaxError) return `The verifier client provisioning ${path} is not valid JSON`;
  return error instanceof Error ? error.message : `The verifier client provisioning ${path} is not usable`;
}

/**
 * Read the verifier client provisioning at `path` once, and build the connector of this governor.
 * The reader calls `lstat` on the file first, on every platform. Only an ENOENT result means that the machine has no verifier.
 * Any other `lstat` error, an unsupported platform, an unsafe file or ancestor directory, or a failed strict parse gives an unusable connector.
 *
 * The reader parses the transport fields and the identities from the same bytes, and it passes each identity with no change.
 * The caller reads the provisioning once per process. A provisioning change needs a restart of a long-lived server.
 * Operators keep the top-level and per-check identities stable while a segment is open. The reader never throws.
 */
export async function loadVerifierProvisioning(path: string): Promise<VerifierProvisioning> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' };
  }
  try {
    if (process.platform !== 'linux') return unusableProvisioning(`The hosted verifier does not support the ${process.platform} platform`);
    const policy = connectorSchema.parse(JSON.parse(await protectedFile(path)));
    const client = await clientFromPolicy(policy);
    return {
      kind: 'usable',
      connector: {
        publicKey: policy.publicKey, gitPath: policy.gitPath, resourceId: policy.resourceId, profileId: policy.profileId,
        ...(policy.checks === undefined ? {} : { checks: definedChecks(policy.checks) }),
        client,
      },
    };
  } catch (error) {
    return unusableProvisioning(refusalReason(path, error));
  }
}

/** Closed portable verifier messages bind complete requests and bounded original signed evidence. */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export const VERIFIER_FRAME_LIMIT = 65536;
export const VERIFIER_VERSION = 'exarchos-verifier/1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(200);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const VerificationSubject = z.object({
  streamId: name, phaseAttemptId: name, taskId: name, leafId: name, operationId: name,
  preparedDigest: digest, callerDigest: digest, segmentDigest: digest,
  configDigest: digest, profileDigest: digest, testSelectionDigest: digest,
  baseCommit: oid, headCommit: oid, blockerHeads: z.array(oid).max(64),
}).strict();
export const VerificationRequest = z.object({
  version: z.literal(1), key: digest, operation: z.literal('probe'),
  resourceId: name, profileId: name, subject: VerificationSubject,
}).strict();
export type VerificationRequest = z.infer<typeof VerificationRequest>;
export const VerificationCommand = z.discriminatedUnion('action', [
  z.object({ version: z.literal(1), token: z.string().min(32).max(4096), action: z.literal('submit'), request: VerificationRequest }).strict(),
  z.object({ version: z.literal(1), token: z.string().min(32).max(4096), action: z.literal('retrieve'), key: digest, digest }).strict(),
]);
export const ResourceIdentity = z.object({ path: z.string().min(1).max(4096), device: z.string(), inode: z.string() }).strict();
export const VerificationEvidence = z.object({
  version: z.literal(1), hostVersion: z.literal(VERIFIER_VERSION), signerId: digest,
  request: VerificationRequest, requestDigest: digest, hostPolicyDigest: digest,
  resources: z.array(ResourceIdentity).min(1).max(3),
  completedAt: z.string().datetime(),
  outcome: z.object({ status: z.enum(['passed', 'failed', 'unsupported']), exitCode: z.number().int().nullable(),
    reason: z.string().max(200), stdoutBase64: z.string().max(5464), stderrBase64: z.string().max(5464) }).strict(),
}).strict();
export type VerificationEvidence = z.infer<typeof VerificationEvidence>;
export const SignedVerification = z.object({ evidence: VerificationEvidence, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type SignedVerification = z.infer<typeof SignedVerification>;
export const VerificationResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evidence'), signed: SignedVerification }).strict(),
  z.object({ kind: z.literal('incomplete'), key: digest, digest }).strict(),
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('conflict') }).strict(),
  z.object({ kind: z.literal('busy') }).strict(),
  z.object({ kind: z.literal('refused'), reason: name }).strict(),
]);
export type VerificationResponse = z.infer<typeof VerificationResponse>;

/** Canonical JSON sorts object keys recursively while preserving all array order. */
export function verificationJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** Request identity includes every immutable field and the original operation key. */
export function verificationDigest(request: VerificationRequest): string {
  return createHash('sha256').update(verificationJson(VerificationRequest.parse(request))).digest('hex');
}

/** A request key cannot be changed to re-execute the same authorized operation. */
export function verificationOperation(request: Omit<VerificationRequest, 'key'>): string {
  const { streamId, phaseAttemptId, taskId, leafId, operationId } = request.subject;
  return createHash('sha256').update(verificationJson({ streamId, phaseAttemptId, taskId, leafId, operationId })).digest('hex');
}

/** Claim keys bind the original operation and segment while durable operation uniqueness prevents alias replay. */
export function verificationKey(request: Omit<VerificationRequest, 'key'>): string {
  return createHash('sha256').update(verificationJson({ operation: verificationOperation(request), segment: request.subject.segmentDigest })).digest('hex');
}

/** Signer identity is the digest of the actual Ed25519 public key bytes. */
export function verifierSignerId(key: string | KeyObject): string {
  const publicKey = typeof key === 'string' || key.type !== 'public' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 verifier key required');
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Terminal evidence is signed once before its resource leases become available. */
export function signVerification(evidence: VerificationEvidence, key: KeyObject): SignedVerification {
  const checked = VerificationEvidence.parse(evidence);
  return SignedVerification.parse({ evidence: checked, signature: sign(null, Buffer.from(verificationJson(checked)), key).toString('base64') });
}

/** Authenticate the exact original subject independently of current filesystem or execution policy. */
export function authenticateVerification(signed: SignedVerification, publicKey: string, key: string, digest: string): boolean {
  try {
    const checked = SignedVerification.parse(signed);
    return checked.evidence.signerId === verifierSignerId(publicKey)
      && checked.evidence.request.key === key && checked.evidence.requestDigest === digest
      && verificationDigest(checked.evidence.request) === digest
      && verify(null, Buffer.from(verificationJson(checked.evidence)), publicKey, Buffer.from(checked.signature, 'base64'));
  } catch { return false; }
}

/** Frame the complete canonical carrier, including credentials or signature, under a fixed byte ceiling. */
export function encodeVerificationFrame(value: unknown): Buffer {
  const payload = Buffer.from(verificationJson(value), 'utf8');
  if (payload.length === 0 || payload.length > VERIFIER_FRAME_LIMIT) throw new Error('Verifier frame exceeds byte limit');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Collect exactly one bounded frame and refuse trailing or truncated transport bytes before decoding. */
export function verificationFrameReader() {
  const chunks: Buffer[] = [];
  let length = 0;
  let expected: number | undefined;
  return {
    push(chunk: Uint8Array) {
      if (length + chunk.byteLength > VERIFIER_FRAME_LIMIT + 4) throw new Error('Verifier frame exceeds byte limit');
      chunks.push(Buffer.from(chunk));
      length += chunk.byteLength;
      if (expected === undefined && length >= 4) {
        expected = Buffer.concat(chunks, length).readUInt32BE(0);
        if (expected === 0 || expected > VERIFIER_FRAME_LIMIT) throw new Error('Invalid verifier frame length');
      }
      if (expected !== undefined && length > expected + 4) throw new Error('Additional verifier frame bytes refused');
    },
    complete(): boolean { return expected !== undefined && length === expected + 4; },
    finish(): unknown {
      if (expected === undefined || length !== expected + 4) throw new Error('Truncated verifier frame');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length).subarray(4)));
    },
  };
}

/** Status receipts authenticate the requested lookup without implying safe re-execution. */
export const VerificationReply = z.object({
  version: z.literal(1), signerId: digest, key: digest, digest,
  response: VerificationResponse, signature: z.string(),
}).strict();
export type VerificationReply = z.infer<typeof VerificationReply>;

/** Sign the entire reply carrier before returning any authenticated disposition. */
export function signVerificationReply(key: string, digest: string, response: VerificationResponse, signer: KeyObject): VerificationReply {
  const body = { version: 1, signerId: verifierSignerId(signer), key, digest, response };
  return VerificationReply.parse({ ...body, signature: sign(null, Buffer.from(verificationJson(body)), signer).toString('base64') });
}

/** Verify both reply binding and original evidence with the provisioned public key. */
export function authenticateVerificationReply(value: unknown, publicKey: string, key: string, digest: string): VerificationReply {
  const reply = VerificationReply.parse(value);
  const { signature, ...body } = reply;
  if (reply.signerId !== verifierSignerId(publicKey) || reply.key !== key || reply.digest !== digest
    || !verify(null, Buffer.from(verificationJson(body)), publicKey, Buffer.from(signature, 'base64'))
    || (reply.response.kind === 'evidence' && !authenticateVerification(reply.response.signed, publicKey, key, digest))) throw new Error('Verifier signature or request binding differs');
  return reply;
}

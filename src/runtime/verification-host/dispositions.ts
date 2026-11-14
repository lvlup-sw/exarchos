/** Authorized requests resolve original durable evidence before consulting current execution policy. */
import { timingSafeEqual } from 'node:crypto';
import { VerificationCommand, type VerificationResponse, verificationDigest, signVerification, authenticateVerification, signVerificationReply, encodeVerificationFrame, VERIFIER_VERSION } from '../../contract/verification/harness-verification.js';
import { authorizeVerification } from './authorization.js';
import { VerificationClaims } from './claims.js';
import { runVerificationProbe } from './processes.js';
import type { loadHostProvisioning } from './provisioning.js';

/** Own one durable host session without making incomplete work reclaimable on restart. */
export function createVerificationDispositions(config: Awaited<ReturnType<typeof loadHostProvisioning>>) {
  const claims = new VerificationClaims(config.policy.stateDir);
  const abort = new AbortController();
  let closed = false;
  const pending = new Map<string, Promise<VerificationResponse>>();
  const original = (key: string, digest: string): VerificationResponse => {
    const response = claims.lookup(key, digest);
    if (response.kind === 'evidence' && !authenticateVerification(response.signed, config.policy.publicKey, key, digest)) throw new Error('Stored signature differs');
    return response;
  };
  return {
    async handle(value: unknown) {
      if (closed) throw new Error('Verifier closing');
      const command = VerificationCommand.parse(value);
      const supplied = Buffer.from(command.token);
      const expected = Buffer.from(config.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Unauthorized verifier client');
      const key = command.action === 'submit' ? command.request.key : command.key;
      const digest = command.action === 'submit' ? verificationDigest(command.request) : command.digest;
      let response = original(key, digest);
      try {
        if (command.action === 'submit' && response.kind === 'absent') {
          const request = command.request;
          const authorized = await authorizeVerification(config.policy, config.provisioningPath, request);
          if (closed) throw new Error('Verifier closing');
          const existing = claims.acquire(request, digest, authorized.identities.map(value => `${value.device}:${value.inode}`));
          if (existing) response = existing.kind === 'busy' || existing.kind === 'conflict' ? existing : original(key, digest);
          else {
            const execution = (async (): Promise<VerificationResponse> => {
              try {
                const outcome = await runVerificationProbe(authorized, abort.signal);
                const signed = signVerification({ version: 1, hostVersion: VERIFIER_VERSION, signerId: config.signerId,
                  request, requestDigest: digest, hostPolicyDigest: authorized.hostPolicyDigest, resources: authorized.identities, completedAt: new Date().toISOString(), outcome }, config.privateKey);
                const terminal: Extract<VerificationResponse, { kind: 'evidence' }> = { kind: 'evidence', signed };
                encodeVerificationFrame(signVerificationReply(key, digest, terminal, config.privateKey));
                claims.complete(key, digest, terminal);
                return terminal;
              } catch { return { kind: 'incomplete', key, digest }; }
            })();
            pending.set(key, execution);
            try { response = await execution; } finally { pending.delete(key); }
          }
        }
      } catch {
        if (closed) throw new Error('Verifier closing');
        response = original(key, digest);
        if (response.kind === 'absent') response = { kind: 'refused', reason: 'Request does not match protected execution authority' };
      }
      if (response.kind === 'incomplete' && pending.has(key)) response = await pending.get(key) ?? response;
      return signVerificationReply(key, digest, response, config.privateKey);
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled(pending.values());
      claims.close();
    },
  };
}

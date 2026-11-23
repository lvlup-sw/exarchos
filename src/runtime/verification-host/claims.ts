/** Host-private SQLite atomically holds immutable requests and exclusive resource identities. */
import { openVerifierClaimDb } from '../../storage/sqlite/verifier-claim-db.js';
import { z } from 'zod';
import { type VerificationResponse, SignedVerification, verificationJson, VerificationRequest, verificationDigest, verificationOperation } from '../../contract/verification/harness-verification.js';

const terminalSchema = z.object({ kind: z.literal('evidence'), signed: SignedVerification }).strict();
type TerminalEvidence = z.infer<typeof terminalSchema>;
const rowSchema = z.object({ digest: z.string(), request: z.string(), terminal: z.string().nullable() });

/** An incomplete claim keeps every resource lease until an original terminal response is committed. */
export class VerificationClaims {
  private readonly db: ReturnType<typeof openVerifierClaimDb>;
  constructor(stateDir: string) {
    this.db = openVerifierClaimDb(stateDir);
    try {
      this.db.initialize(
        'CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, operation TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, request TEXT NOT NULL, terminal TEXT); ' +
        'CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES claims(key));',
      );
    } catch (error) { this.db.close(); throw error; }
  }

  lookup(key: string, digest: string): VerificationResponse {
    const raw = this.db.claimRow(key);
    return raw === undefined ? { kind: 'absent' } : this.response(key, digest, raw);
  }

  /** The response of one stored claim row. A stored request that does not match its key or its digest throws. */
  private response(key: string, digest: string, raw: unknown): VerificationResponse {
    const row = rowSchema.parse(raw);
    const original = VerificationRequest.parse(JSON.parse(row.request));
    if (original.key !== key || verificationDigest(original) !== row.digest) throw new Error('Stored original request differs');
    if (row.digest !== digest) return { kind: 'conflict' };
    return row.terminal === null ? { kind: 'incomplete', key, digest } : terminalSchema.parse(JSON.parse(row.terminal));
  }

  acquire(request: VerificationRequest, digest: string, resources: readonly string[]): VerificationResponse | undefined {
    const claim = { key: request.key, operation: verificationOperation(request), digest, request: verificationJson(request) };
    const outcome = this.db.acquire(claim, resources);
    switch (outcome.kind) {
      case 'existing': return this.response(request.key, digest, outcome.row);
      case 'operation-taken': return { kind: 'conflict' };
      case 'busy': return { kind: 'busy' };
      case 'acquired': return undefined;
    }
  }

  complete(key: string, digest: string, response: TerminalEvidence): void {
    this.db.complete(key, digest, verificationJson(terminalSchema.parse(response)));
  }

  close(): void { this.db.close(); }
}

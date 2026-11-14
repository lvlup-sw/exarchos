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
    const raw = this.db.one('SELECT digest,request,terminal FROM claims WHERE key=?', key);
    if (!raw) return { kind: 'absent' };
    const row = rowSchema.parse(raw);
    const original = VerificationRequest.parse(JSON.parse(row.request));
    if (original.key !== key || verificationDigest(original) !== row.digest) throw new Error('Stored original request differs');
    if (row.digest !== digest) return { kind: 'conflict' };
    return row.terminal === null ? { kind: 'incomplete', key, digest } : terminalSchema.parse(JSON.parse(row.terminal));
  }

  acquire(request: VerificationRequest, digest: string, resources: readonly string[]): VerificationResponse | undefined {
    return this.db.immediate(() => {
      const existing = this.lookup(request.key, digest);
      if (existing.kind !== 'absent') return existing;
      const operation = verificationOperation(request);
      if (this.db.one('SELECT key FROM claims WHERE operation=?', operation)) return { kind: 'conflict' };
      for (const resource of resources) {
        if (this.db.one('SELECT owner FROM leases WHERE resource=?', resource)) return { kind: 'busy' };
      }
      this.db.change('INSERT INTO claims(key,operation,digest,request,terminal) VALUES(?,?,?,?,NULL)', request.key, operation, digest, verificationJson(request));
      for (const resource of resources) this.db.change('INSERT INTO leases(resource,owner) VALUES(?,?)', resource, request.key);
      return undefined;
    });
  }

  complete(key: string, digest: string, response: TerminalEvidence): void {
    this.db.immediate(() => {
      const changed = this.db.change('UPDATE claims SET terminal=? WHERE key=? AND digest=? AND terminal IS NULL', verificationJson(terminalSchema.parse(response)), key, digest);
      if (changed !== 1) throw new Error('Original claim changed before completion');
      this.db.change('DELETE FROM leases WHERE owner=?', key);
    });
  }

  close(): void { this.db.close(); }
}

/**
 * Holds the one `createHash` call behind every waiver-ledger key-set pin.
 * The call is in this file so that `waiver-ledger.ts` imports nothing. A guard that needs only
 * the day rule, such as the CLI-derivation ratchet guard, then takes no hash code.
 * The canonical form of a key set stays in `waiver-ledger.ts`, so all ledgers share one form.
 */
import { createHash } from 'node:crypto';
import { canonicalKeySet } from './waiver-ledger.js';

/**
 * Returns the hex `<algorithm>` digest of the sorted, deduplicated ids joined by newlines.
 * The algorithm is a parameter, so a change of hash is an explicit edit at the caller.
 */
export function keySetDigest(ids: readonly string[], algorithm: string): string {
  return createHash(algorithm).update(canonicalKeySet(ids), 'utf8').digest('hex');
}

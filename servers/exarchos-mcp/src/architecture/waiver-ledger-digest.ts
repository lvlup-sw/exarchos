/**
 * The one `createHash` call behind every waiver-ledger key-set pin (DR-6).
 *
 * Split from `waiver-ledger.ts` so that module can keep importing nothing: a
 * guard that only needs the day rule and the expiry verdict — the CLI-derivation
 * ratchet, which must never acquire a `bun:sqlite` edge — takes the ledger core
 * without taking a hash implementation with it. The canonical form the digest is
 * taken over lives in the core, because that is the half that could silently
 * diverge between mechanisms; this file is the primitive.
 */
import { createHash } from 'node:crypto';
import { canonicalKeySet } from './waiver-ledger.js';

/**
 * `<algorithm>` over the sorted, deduplicated ids joined by newlines, as hex.
 *
 * The algorithm is a parameter and every caller passes a named constant from its
 * own pin file, so a future change of hash is an explicit, readable act rather
 * than a silent reinterpretation of the same hex string.
 */
export function keySetDigest(ids: readonly string[], algorithm: string): string {
  return createHash(algorithm).update(canonicalKeySet(ids), 'utf8').digest('hex');
}

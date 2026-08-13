/**
 * Thin CLI entrypoint that prints the computed prefix fingerprint to stdout.
 *
 * Intended to be invoked under `tsx` by `scripts/check-prefix-fingerprint.mjs`
 * (T047, DR-12). Printing a single lowercase hex digest followed by `\n`
 * lets the `.mjs` wrapper compare against the committed `PREFIX_FINGERPRINT`
 * file without needing to share module graphs between ESM `.mjs` and this
 * TypeScript source tree.
 *
 * Rationale: the `.mjs` wrapper lives at the repo root and cannot directly
 * import TypeScript. Rather than duplicating the hashing logic in plain JS
 * (which would drift from `fingerprint.ts` the moment inputs change), this
 * stub reuses the canonical `computePrefixFingerprint()` via a `tsx` child
 * process. Single source of truth for the hash, at the cost of one spawn
 * per `npm run validate` invocation.
 */
import { computePrefixFingerprint } from './fingerprint.js';

process.stdout.write(`${computePrefixFingerprint()}\n`);

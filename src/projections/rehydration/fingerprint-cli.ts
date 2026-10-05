/**
 * CLI entry point that prints the prefix fingerprint to stdout as one lowercase hex digest and a newline.
 * `tools/audit/gates/check-prefix-fingerprint.mjs` runs it under `tsx` and compares the output with the committed `PREFIX_FINGERPRINT` file.
 * The `.mjs` gate cannot import TypeScript, so this entry point lets it reuse `computePrefixFingerprint()` instead of a copy of the hash logic.
 */
import { computePrefixFingerprint } from './fingerprint.js';

process.stdout.write(`${computePrefixFingerprint()}\n`);

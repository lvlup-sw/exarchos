// ─── P07-04 — cross-runtime corpus-digest CLI (bun/node runnable) ────────────
//
// Prints a single, content-addressed fingerprint of the whole admission
// scenario corpus's decisions. The admission decision path is pure and
// deterministic, so this digest MUST be byte-identical under every runtime
// (Node via vitest, and Bun via `bun run`). The cross-runtime suite runs this
// under Bun and compares the result to the Node in-process digest.
//
// It imports ONLY the pure decision path (no event store, no bun:sqlite), so it
// runs standalone under `bun run` without the vitest module aliases.

import { admissionScenarioCorpus } from './admission-scenario-corpus.js';
import { corpusDigest } from './admission-decision-path.js';

function main(): void {
  const digest = corpusDigest(admissionScenarioCorpus);
  // A single greppable line; the suite parses `DIGEST=<hex>`.
  process.stdout.write(`DIGEST=${digest}\n`);
}

main();

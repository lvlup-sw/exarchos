// Prints one fingerprint of the decisions of the whole admission scenario corpus.
// The admission decision path is pure, so the digest must be identical under Node and Bun.
// The cross-runtime suite runs this file under `bun run` and compares the result to the Node digest.
// The file imports only the pure decision path, so it runs without the vitest module aliases.

import { admissionScenarioCorpus } from './admission-scenario-corpus.js';
import { corpusDigest } from './admission-decision-path.js';

/** Writes one line, `DIGEST=<hex>`, that the cross-runtime suite parses. */
function main(): void {
  const digest = corpusDigest(admissionScenarioCorpus);
  process.stdout.write(`DIGEST=${digest}\n`);
}

main();

/**
 * Compiles the live meta-model and writes the checked-in proof-fixture baseline
 * (`generated/proof-fixtures.json`). Thus contract drift shows in a diff, and the oracle has a
 * stable artifact. A drift test fails when the baseline differs from a fresh compile.
 *
 * `compile()` runs `verifyContractAuthority()`, so a floating or unapproved authority throws and
 * writes nothing. Run it with `npx tsx src/contract/compiler/generate.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMetaModel } from './meta-model.js';
import { compile, type CompiledContract } from './compile.js';
import { serializeProofFixtures } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checked-in generated-artifact directory. */
export const GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in proof-fixture baseline (digests + authority snapshot). */
export const PROOF_FIXTURES_FILE = path.resolve(GENERATED_DIR, 'proof-fixtures.json');

/**
 * Compiles the live contract, or throws one error that lists every diagnostic. The generator must
 * fail and not write a partial or stale baseline.
 */
export function compileLiveContract(): CompiledContract {
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) {
    const summary = outcome.diagnostics
      .map((d) => `  [${d.code}] ${d.actionId} ${d.path}: ${d.message}`)
      .join('\n');
    throw new Error(`contract compilation BLOCKED — ${outcome.diagnostics.length} diagnostic(s):\n${summary}`);
  }
  return outcome.output;
}

/** The canonical, byte-stable serialization written to disk (trailing newline). */
export function serializedProofBaseline(): string {
  return serializeProofFixtures(compileLiveContract().proofFixtures) + '\n';
}

export interface GenerateResult {
  readonly fixturesFile: string;
  readonly contractDigest: string;
}

/** Regenerate + write the checked-in proof-fixture baseline. */
export function generateContractArtifacts(): GenerateResult {
  const contract = compileLiveContract();
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(PROOF_FIXTURES_FILE, serializeProofFixtures(contract.proofFixtures) + '\n', 'utf8');
  return { fixturesFile: PROOF_FIXTURES_FILE, contractDigest: contract.contractDigest };
}

/**
 * Returns true when this module is the process entry point. The write runs only then, so an import
 * in a test touches no file.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { fixturesFile, contractDigest } = generateContractArtifacts();
  process.stdout.write(`wrote proof-fixture baseline: ${fixturesFile}\n`);
  process.stdout.write(`contract digest: ${contractDigest}\n`);
}

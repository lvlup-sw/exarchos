// ─── Contract-artifact generator / drift baseline (P03-03) ───────────────────
//
// PROGRAM-03, API-003. Compiles the live meta-model and writes the checked-in
// PROOF-FIXTURE baseline (`generated/proof-fixtures.json`) so contract drift is
// reviewable in a diff and the downstream oracle (P03-09) has a stable artifact
// to verify against. This mirrors the P03-01 `authority-lock-cli.ts` pattern:
// running the generator is the regeneration gesture; the co-located
// `generated.test.ts` fails when the checked-in baseline drifts from a fresh
// compile.
//
// Generation is GATED: `compile()` runs the real `verifyContractAuthority()`, so
// a floating/unapproved authority throws here rather than writing a stale
// baseline (P03-01 exit proof — floating/unapproved digests block generation).
//
// Usage (from servers/exarchos-mcp):
//   npx tsx src/contract/compiler/generate.ts
// ────────────────────────────────────────────────────────────────────────────

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
 * Compile the live contract or throw a readable, aggregated diagnostic. The
 * throw is intentional: a generator must fail loudly (blocked authority, a
 * missing policy field, an incompatible schema) rather than emit a partial or
 * stale baseline.
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

// Executed only when run directly (never on import) so importing this module in
// a test has no filesystem side effect (mirrors `authority-lock-cli.ts`).
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

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { deriveMetaModel } from './meta-model.js';
import { compile } from './compile.js';
import { serializeProofFixtures } from './fixtures.js';
import {
  PROOF_FIXTURES_FILE,
  compileLiveContract,
  serializedProofBaseline,
} from './generate.js';

// The checked-in proof-fixture baseline is the reviewable drift artifact and the
// stable fixture the downstream oracle (P03-09) verifies against. If the live
// registry / policy / schema surface changes, this test goes red until the
// baseline is regenerated (`npx tsx src/contract/compiler/generate.ts`) — the
// same "regenerate + review" gesture as the P03-01 authority lock.
describe('generated proof-fixture baseline — drift guard', () => {
  it('CheckedInBaselineMatchesAFreshCompilation', () => {
    const outcome = compile(deriveMetaModel());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const onDisk = fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8');
      expect(serializeProofFixtures(outcome.output.proofFixtures) + '\n').toBe(onDisk);
    }
  });

  it('RegeneratingProducesTheByteIdenticalBaseline', () => {
    // The generator is idempotent against the current tree — proving the
    // "repeated generation is byte-stable" exit proof at the artifact boundary.
    expect(serializedProofBaseline()).toBe(serializedProofBaseline());
    expect(serializedProofBaseline()).toBe(fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8'));
  });

  it('CompilesLiveAgainstTheRealAuthorityFreeze', () => {
    // compileLiveContract() throws if the authority freeze blocks; reaching a
    // digest proves the real freeze is green in this tree.
    expect(compileLiveContract().contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

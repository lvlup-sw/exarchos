import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { deriveMetaModel } from '../../../../src/contract/compiler/meta-model.js';
import { compile } from '../../../../src/contract/compiler/compile.js';
import { serializeProofFixtures } from '../../../../src/contract/compiler/fixtures.js';
import {
  PROOF_FIXTURES_FILE,
  compileLiveContract,
  serializedProofBaseline,
} from '../../../../src/contract/compiler/generate.js';

/**
 * The checked-in proof-fixture baseline is the drift artifact that the downstream oracle verifies against.
 * If the live registry, policy or schema surface changes, these tests fail.
 * To regenerate the baseline, run `npx tsx src/contract/compiler/generate.ts`.
 */
describe('generated proof-fixture baseline — drift guard', () => {
  it('CheckedInBaselineMatchesAFreshCompilation', () => {
    const outcome = compile(deriveMetaModel());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const onDisk = fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8');
      expect(serializeProofFixtures(outcome.output.proofFixtures) + '\n').toBe(onDisk);
    }
  });

  /** Two generations from the current tree give the same bytes, and those bytes equal the checked-in file. */
  it('RegeneratingProducesTheByteIdenticalBaseline', () => {
    expect(serializedProofBaseline()).toBe(serializedProofBaseline());
    expect(serializedProofBaseline()).toBe(fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8'));
  });

  /**
   * `compileLiveContract()` throws when the authority freeze blocks.
   * A digest proves that the real freeze passes in this tree.
   */
  it('CompilesLiveAgainstTheRealAuthorityFreeze', () => {
    expect(compileLiveContract().contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

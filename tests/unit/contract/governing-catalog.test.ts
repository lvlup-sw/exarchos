// Pins the governing wording of the invariant catalog that the authority freeze locks.
//
// `.exarchos/invariants.md` is a frozen authority, and `contract-authority.lock.json` holds its
// digest. `authority-collector.test.ts` proves that the locked digest equals the live digest.
// That test cannot tell which wording the lock approved. This file asserts the governing wording
// of four catalog entries, and that shipped source does not cite the retired parity framing.
//
// Two independent sources judge the wording: the catalog file, and the deviation ledger
// `CLI_CONTRACT_DEVIATIONS` together with the expectations in this file.
//
// @oracle-sources: ../../../.exarchos/invariants.md, shipped-src-corpus

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInvariants, type InvariantEntry } from '../../../src/architecture/invariants-loader.js';
import {
  extractCommentProse,
  isQuotedMention,
  sentenceBefore,
} from '../../../tools/audit/lib/comment-prose.mjs';
import { defaultSourcePaths, loadAuthorityLock } from '../../../src/contract/authority-collector.js';
import { digestText } from '../../../src/contract/authority-digest.js';
import { CLI_CONTRACT_DEVIATIONS } from '../../../src/contract/cli/cli-contract-seam.js';
import { listTrackedFiles, trackedFilesMissedBy } from '../../../tools/test-helpers/tracked-population.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src` — the shipped production source root. */
const SHIPPED_SRC_ROOT = path.resolve(HERE, '../../../src');
const REPO_ROOT = path.resolve(HERE, '../../..');
const CATALOG_FILE = path.join(REPO_ROOT, '.exarchos/invariants.md');
const CATALOG_CONFIG = {
  invariants: { catalogs: [{ path: CATALOG_FILE, tier: 'dev' as const }] },
};

function catalogEntry(id: string): InvariantEntry {
  const entries = loadInvariants(CATALOG_FILE, { scope: 'all' }, CATALOG_CONFIG);
  const found = entries.find((e) => e.id === id);
  if (!found) throw new Error(`catalog entry ${id} not found`);
  return found;
}

function auditPromptOf(entry: InvariantEntry): string {
  const enforcement = entry.enforcement as
    | { mode: string; 'audit-prompt'?: string }
    | undefined;
  return enforcement?.['audit-prompt'] ?? '';
}

describe('DR-26 — the freeze pins the governing catalog', () => {
  /**
   * The test computes the catalog digest with `digestText` and compares it with the locked pin.
   * It does not use the comparison of the collector. The approval must also name its approver.
   */
  it('GoverningCatalog_ApprovedLockDigest_IsTheLiveGoverningCatalog', () => {
    const paths = defaultSourcePaths();
    const lock = loadAuthorityLock(paths.lockFile);
    const catalogText = fs.readFileSync(CATALOG_FILE, 'utf8');

    const pin = lock.authorities['invariant-catalog'];
    expect(pin, 'the catalog must be a pinned authority').toBeDefined();
    expect(pin!.digest).toBe(digestText(catalogText));
    expect(pin!.approved).toBe(true);
    expect(lock.approved).toBe(true);

    expect(lock.approvedBy.trim().length).toBeGreaterThan(0);
    expect(lock.note ?? '').toMatch(/DR-26/);
  });
});

describe('DR-26 — INV-2 is contract-client equivalence, not peer-facade parity', () => {
  /**
   * The governing summary calls the CLI a client of the same compiled contract, equal by
   * construction. It calls the parity harnesses a witness, not the proof.
   * The summary must not describe two peer facades whose equality is the invariant.
   */
  it('GoverningCatalog_Inv2_StatesEquivalenceByConstruction_NotByParityFixture', () => {
    const inv2 = catalogEntry('INV-2');
    const summary = inv2.summary;

    expect(summary).toMatch(/\bclient\b/i);
    expect(summary).toMatch(/by construction/i);
    expect(summary).toMatch(/compiled contract/i);

    expect(summary).toMatch(/witness/i);

    expect(summary).not.toMatch(/both facades over/i);
    expect(inv2.dimension).not.toBe('facade-equivalence');
  });

  /**
   * The second source is the deviation ledger `CLI_CONTRACT_DEVIATIONS`, which is empty.
   * The catalog must record the `cli-direct-dispatch` row as retired, without its expiry date.
   * A new ledger row fails this test. Then the catalog needs a new approval with that record.
   * The summary keeps the deviation and expiry rules for a future exception.
   */
  it('GoverningCatalog_Inv2_RecordsTheDr25Retirement_MatchingTheEmptyLedger', () => {
    expect(CLI_CONTRACT_DEVIATIONS).toEqual([]);

    const summary = catalogEntry('INV-2').summary;
    expect(summary).toMatch(/generated.client/i);
    expect(summary).toMatch(/retired/i);
    expect(summary).toContain('cli-direct-dispatch');
    expect(summary).not.toContain('2027-02-28');
    expect(summary).toMatch(/deviation/i);
    expect(summary).toMatch(/expir/i);
  });

  it('GoverningCatalog_Inv2_ReferencesTheDeviationLedgerAndGeneratedClient', () => {
    const references = catalogEntry('INV-2').references;
    expect(references).toContain(
      'src/contract/cli/cli-contract-seam.ts',
    );
    expect(references).toContain(
      'src/contract/cli/generated-client.ts',
    );
  });
});

describe('DR-26 — INV-4 is standards conformance, not six-runtime fan-out', () => {
  /**
   * The governing summary requires one standard-conformant artifact where a standard exists. It
   * allows a shim only where no standard exists, as technical debt with a retirement condition.
   * The summary must not call six runtimes first-class.
   *
   * The test pins the enforcement mode `audit` by name. An entry with no enforcement has the mode
   * `undefined`, and that entry must fail here.
   */
  it('GoverningCatalog_Inv4_EmitsOneStandardArtifact_WithShimsAsOwnedDebt', () => {
    const summary = catalogEntry('INV-4').summary;

    expect(summary).toMatch(/standard-conformant/i);
    expect(summary).toMatch(/AGENTS\.md/);
    expect(summary).toMatch(/shim/i);

    expect(summary).toMatch(/technical debt/i);
    expect(summary).toMatch(/retirement condition/i);

    expect(summary).not.toMatch(/six\s+runtimes\s+are\s+first-class/i);

    expect(catalogEntry('INV-4').enforcement?.mode).toBe('audit');
  });
});

describe('DR-26 — INV-7 is a closed claim (T-26 / EFF-001), not a target', () => {
  /**
   * The summary must name the evidence: real OS child processes that contend, with interleaving.
   * It must not hedge the claim as unverified.
   */
  it('GoverningCatalog_Inv7_AssertsCrossProcessSerializationAsClosed', () => {
    const inv7 = catalogEntry('INV-7');
    const summary = inv7.summary;

    expect(summary).toMatch(/closed claim/i);
    expect(summary).toMatch(/EFF-001/);
    expect(summary).toMatch(/child process/i);
    expect(summary).toMatch(/interleaving/i);

    expect(summary).not.toMatch(/remains? unverified|until EFF-001 passes/i);
  });

  /** The fixture that the catalog references must be on disk. A closed claim needs its witness. */
  it('GoverningCatalog_Inv7_ReferencesTheMultiProcessFixtureThatClosedIt', () => {
    const fixture = 'tests/core/process/multi-process-append.test.ts';
    expect(catalogEntry('INV-7').references).toContain(fixture);
    expect(fs.existsSync(path.join(REPO_ROOT, fixture))).toBe(true);
  });
});

describe('DR-26 — INV-11 keeps spatial write confinement EXCLUDED', () => {
  /**
   * The summary names what the launcher enforces: lifecycle and placement.
   * It must say explicitly that spatial write confinement is excluded. It must list the four
   * capability postures of a harness. It must not claim confinement by construction.
   */
  it('GoverningCatalog_Inv11_ClaimsLifecycleAndPlacement_NotFilesystemConfinement', () => {
    const inv11 = catalogEntry('INV-11');
    const summary = inv11.summary;

    expect(summary).toMatch(/launcher/i);
    expect(summary).toMatch(/lifecycle/i);
    expect(summary).toMatch(/placement/i);

    expect(summary).toMatch(/spatial/i);
    expect(summary).toMatch(/exclud/i);

    for (const posture of ['prevention', 'detection', 'advisory', 'unavailable']) {
      expect(summary.toLowerCase()).toContain(posture);
    }

    expect(summary).not.toMatch(/cannot write outside its assigned worktree/i);
  });

  it('GoverningCatalog_Inv11_AuditPromptForbidsInferringConfinementFromTheLauncher', () => {
    const inv11 = catalogEntry('INV-11');
    expect(inv11.enforcement?.mode).toBe('audit');
    const prompt = auditPromptOf(inv11);
    expect(prompt).toMatch(/spatial/i);
    expect(prompt).toMatch(/never be inferred/i);
  });
});

/**
 * Matches the retired framing, which cites the contract-client equivalence invariant as parity
 * between two peer facades.
 *
 * A match is a citation only when it is comment prose, is not quoted, and has no retirement
 * qualifier before it in its sentence. A title, a message, a regex source or an identifier is code.
 * {@link citesRetiredParityFramingIn} keeps the comment prose only.
 * {@link citesRetiredParityFraming} skips the quoted mentions and the qualified sentences.
 */
const RETIRED_PARITY_RE = /INV-2\s+(?:byte-)?parity/gi;

/**
 * Words that make the phrase a description of the retired framing, not a claim.
 * The detector reads them only from the part of the sentence that comes before the phrase.
 * A sentence can span the lines of one block comment, but it stops at the start of a `//` line.
 * Thus a qualifier after the phrase, on the previous `//` line, or in a different sentence does
 * not apply.
 */
const RETIREMENT_QUALIFIER_RE =
  /\b(?:retired|retiring|former|formerly|superseded|supersedes|deprecated|stale|obsolete|no longer|not|never|instead of|rather than|was|used to)\b/i;
function citesRetiredParityFraming(prose: string): boolean {
  for (const match of prose.matchAll(RETIRED_PARITY_RE)) {
    if (isQuotedMention(prose, match.index)) continue;
    if (!RETIREMENT_QUALIFIER_RE.test(sentenceBefore(prose, match.index))) return true;
  }
  return false;
}

/** {@link citesRetiredParityFraming} over the comment prose of a source file. */
function citesRetiredParityFramingIn(source: string): boolean {
  return citesRetiredParityFraming(extractCommentProse(source));
}
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name === 'node_modules') continue;
      walkTsFiles(full, out);
    } else if (
      dirent.name.endsWith('.ts') &&
      !dirent.name.endsWith('.test.ts') &&
      !dirent.name.endsWith('.type-test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('DR-26 — the retired INV-2 parity citations are re-pointed', () => {
  /** The positive control. Zero offenders prove nothing if the detector cannot fire. */
  it('RetiredParityDetector_FiresOnStaleCitation_AndNotOnGoverningOne', () => {
    const stale = '// shape the MCP arm receives (INV-2 parity; #1127).';
    const repointed = '// one registered schema (governing INV-2 — by construction).';
    expect(citesRetiredParityFramingIn(stale)).toBe(true);
    expect(citesRetiredParityFramingIn(repointed)).toBe(false);
  });

  /** A title, a message and a regex source hold the phrase as code. None of them is a citation. */
  it('RetiredParityDetector_PhraseInCode_IsNotAProseCitation', () => {
    const asTitle = `describe('the retired INV-2 parity citations are re-pointed', () => {});`;
    const asMessage = `const why = 'shipped source still cites the retired INV-2 parity framing';`;
    const asPattern = 'const RE = /INV-2 parity/i;';
    expect(citesRetiredParityFramingIn(asTitle)).toBe(false);
    expect(citesRetiredParityFramingIn(asMessage)).toBe(false);
    expect(citesRetiredParityFramingIn(asPattern)).toBe(false);
  });

  it('RetiredParityDetector_ProseNamingTheFramingAsRetired_IsNotACitation', () => {
    const naming = '// The retired INV-2 parity framing has no citation left here.';
    const wrapped =
      '/**\n * ...for the four invariants DR-26 names, and the retired\n' +
      ' * INV-2 parity framing must have no citation left in shipped source.\n */';
    const contrasted = '// One registered schema, not INV-2 parity between peers.';
    expect(citesRetiredParityFramingIn(naming)).toBe(false);
    expect(citesRetiredParityFramingIn(wrapped)).toBe(false);
    expect(citesRetiredParityFramingIn(contrasted)).toBe(false);
  });

  /** A quoted phrase is a mention. Only unquoted prose asserts the framing. */
  it('RetiredParityDetector_QuotedPhraseIsMentionedNotAsserted', () => {
    const mentioned = '// Words that turn "INV-2 parity" into a claim about one.';
    const asserted = '// Words that turn the MCP arm into INV-2 parity with the CLI.';
    expect(citesRetiredParityFramingIn(mentioned)).toBe(false);
    expect(citesRetiredParityFramingIn(asserted)).toBe(true);
  });

  /**
   * A qualifier in the previous sentence must not excuse a citation in the next sentence.
   * A fixed look-back window has that fault.
   */
  it('RetiredParityDetector_QualifierFromAnotherSentence_DoesNotExcuseACitation', () => {
    const source =
      '// The old wording is retired. The MCP arm receives INV-2 parity with the CLI.';
    expect(citesRetiredParityFramingIn(source)).toBe(true);
  });

  /**
   * This file holds the phrase in titles, messages and fixture strings, and cites it nowhere.
   * The same text with one appended citation must make the detector fire.
   */
  it('RetiredParityDetector_ReadsThisVeryFile_AsClean', () => {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(citesRetiredParityFramingIn(self)).toBe(false);
    expect(citesRetiredParityFramingIn(`${self}\n// per INV-2 parity, #1127.`)).toBe(true);
  });

  /**
   * The sweep must reach each tracked production module. The test compares the walked files with
   * `git ls-files`, filtered to non-test `.ts` files, and a shortfall names the missed files.
   * The tracked list does not depend on the recursion of the walker.
   */
  it('ShippedSource_CitesNoRetiredInv2ParityFraming', async () => {
    const files = walkTsFiles(SHIPPED_SRC_ROOT);
    expect(
      trackedFilesMissedBy(
        files.map((file) => path.relative(SHIPPED_SRC_ROOT, file).split(path.sep).join('/')),
        await listTrackedFiles(SHIPPED_SRC_ROOT, {
          exclude: (file) => file.endsWith('.test.ts') || file.endsWith('.type-test.ts'),
        }),
      ),
      'the citation sweep did not reach every tracked production module — a ' +
        'retired-framing citation could sit in the gap',
    ).toEqual([]);

    const offenders = files
      .filter((f) => citesRetiredParityFramingIn(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SHIPPED_SRC_ROOT, f).split(path.sep).join('/'));

    expect(
      offenders,
      'shipped production source still cites the retired INV-2 parity framing',
    ).toEqual([]);
  });
});

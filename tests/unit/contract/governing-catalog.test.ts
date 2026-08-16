// ─── DR-26 / T-35: the freeze pins the GOVERNING invariant contract ─────────
//
// `.exarchos/invariants.md` is one of the seven frozen authorities in
// `authority-pin.ts`, digested into `contract-authority.lock.json`. That makes
// its WORDING a load-bearing input to generation, not documentation: a stale
// framing there is pinned, approved, and propagated into every artifact built
// against the freeze.
//
// The existing `authority-collector.test.ts` proves the freeze is CONSISTENT —
// the locked digest equals the live digest. It cannot say WHICH catalog was
// approved, so a stale catalog re-approved through the same generator would
// pass it. This module supplies the missing half: the text that hashes to the
// pinned digest must read in the GOVERNING form for the four invariants DR-26
// names (INV-2, INV-4, INV-7, INV-11), and the retired INV-2 parity framing
// must have no citation left in shipped production source.
//
// Two independent authorities, per DR-30:
//   • the catalog artifact itself (what the repository declares), and
//   • the governing spec + the machine-readable DR-25 deviation ledger (what
//     the audit decided the governing form IS). Neither is computed from the
//     other, so they can disagree — which is the whole point.
//
// @oracle-sources: ../../../.exarchos/invariants.md, ../../../docs/specs/2026-08-04-wiring-closure-and-unified-integration-suite.md, shipped-src-corpus
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInvariants, type InvariantEntry } from '../../../src/architecture/invariants-loader.js';
import {
  extractCommentProse,
  isQuotedMention,
  sentenceBefore,
} from '../../../tools/test-helpers/comment-prose.js';
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

// ════════════════════════════════════════════════════════════════════════════
//  The freeze pins THIS catalog
// ════════════════════════════════════════════════════════════════════════════

describe('DR-26 — the freeze pins the governing catalog', () => {
  it('GoverningCatalog_ApprovedLockDigest_IsTheLiveGoverningCatalog', () => {
    // The lock is the approval record produced by `authority-lock-cli.ts`; the
    // catalog is the artifact. Re-deriving the digest here (rather than
    // trusting the collector) keeps this assertion independent of the
    // collector's own plumbing.
    const paths = defaultSourcePaths();
    const lock = loadAuthorityLock(paths.lockFile);
    const catalogText = fs.readFileSync(CATALOG_FILE, 'utf8');

    const pin = lock.authorities['invariant-catalog'];
    expect(pin, 'the catalog must be a pinned authority').toBeDefined();
    expect(pin!.digest).toBe(digestText(catalogText));
    expect(pin!.approved).toBe(true);
    expect(lock.approved).toBe(true);

    // The approval must be attributable. An unowned approval is a rubber stamp.
    expect(lock.approvedBy.trim().length).toBeGreaterThan(0);
    expect(lock.note ?? '').toMatch(/DR-26/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  The four invariants DR-26 names, in their governing form
// ════════════════════════════════════════════════════════════════════════════

describe('DR-26 — INV-2 is contract-client equivalence, not peer-facade parity', () => {
  it('GoverningCatalog_Inv2_StatesEquivalenceByConstruction_NotByParityFixture', () => {
    const inv2 = catalogEntry('INV-2');
    const summary = inv2.summary;

    // Governing framing: the MCP wire is the invocation surface and the CLI is
    // a CLIENT of the same compiled contract, equal BY CONSTRUCTION.
    expect(summary).toMatch(/\bclient\b/i);
    expect(summary).toMatch(/by construction/i);
    expect(summary).toMatch(/compiled contract/i);

    // The parity harnesses are demoted from proof to witness. This is the
    // sentence the retired framing did not contain.
    expect(summary).toMatch(/witness/i);

    // The retired framing — two peer facades whose equality IS the invariant.
    expect(summary).not.toMatch(/both facades over/i);
    expect(inv2.dimension).not.toBe('facade-equivalence');
  });

  it('GoverningCatalog_Inv2_RecordsTheDr25Retirement_MatchingTheEmptyLedger', () => {
    // Second authority: the machine-readable DR-25 ledger the census enforces.
    // The primary resolution retired the `cli-direct-dispatch` row (the CLI
    // now addresses actions through the generated client), so the ledger is
    // EMPTY — and the catalog must record the RETIREMENT rather than keep
    // advertising an open deviation. If a future row is recorded, this pin
    // goes red and the catalog must be re-approved with the new record, never
    // silently disagreeing with the code.
    expect(CLI_CONTRACT_DEVIATIONS).toEqual([]);

    const summary = catalogEntry('INV-2').summary;
    expect(summary).toMatch(/generated.client/i);
    expect(summary).toMatch(/retired/i);
    expect(summary).toContain('cli-direct-dispatch');
    // No open-deviation claim survives — the retired row's expiry is gone.
    expect(summary).not.toContain('2027-02-28');
    // The machinery framing stays: a future exception is debt AGAINST the
    // invariant, not a weakening OF it.
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
  it('GoverningCatalog_Inv4_EmitsOneStandardArtifact_WithShimsAsOwnedDebt', () => {
    const summary = catalogEntry('INV-4').summary;

    // Governing framing: emit the standard artifact ONCE where a standard
    // converged; a shim survives only where none did.
    expect(summary).toMatch(/standard-conformant/i);
    expect(summary).toMatch(/AGENTS\.md/);
    expect(summary).toMatch(/shim/i);

    // Per-runtime fan-out is debt, and a residual shim is owned + retirable —
    // conformance replaces render-parity as the metric.
    expect(summary).toMatch(/technical debt/i);
    expect(summary).toMatch(/retirement condition/i);

    // The retired framing: N first-class runtime renderings kept drift-guarded.
    expect(summary).not.toMatch(/six\s+runtimes\s+are\s+first-class/i);

    // The mechanical backstop still EXISTS — but it is `skills:guard`, not a
    // grep. #1764 task 086 re-pointed this to `audit`: the old `check` scoped to
    // `skills/**` and greped `@@`, so it fired on every conforming regeneration,
    // which CLAUDE.md mandates committing. Pinning `check` here pinned that bug.
    // What must not silently become true is `mode: undefined` — an entry with no
    // enforcement at all — so the assertion names the mode rather than dropping.
    expect(catalogEntry('INV-4').enforcement?.mode).toBe('audit');
  });
});

describe('DR-26 — INV-7 is a closed claim (T-26 / EFF-001), not a target', () => {
  it('GoverningCatalog_Inv7_AssertsCrossProcessSerializationAsClosed', () => {
    const inv7 = catalogEntry('INV-7');
    const summary = inv7.summary;

    expect(summary).toMatch(/closed claim/i);
    expect(summary).toMatch(/EFF-001/);
    // The evidence that closed it: N real OS child processes that genuinely
    // contend, not in-process workers.
    expect(summary).toMatch(/child process/i);
    expect(summary).toMatch(/interleaving/i);

    // The target-shaped hedge the audit found must be gone.
    expect(summary).not.toMatch(/remains? unverified|until EFF-001 passes/i);
  });

  it('GoverningCatalog_Inv7_ReferencesTheMultiProcessFixtureThatClosedIt', () => {
    const fixture = 'tests/core/process/multi-process-append.test.ts';
    expect(catalogEntry('INV-7').references).toContain(fixture);
    // A closed claim whose witness does not exist is not closed.
    expect(fs.existsSync(path.join(REPO_ROOT, fixture))).toBe(true);
  });
});

describe('DR-26 — INV-11 keeps spatial write confinement EXCLUDED', () => {
  it('GoverningCatalog_Inv11_ClaimsLifecycleAndPlacement_NotFilesystemConfinement', () => {
    const inv11 = catalogEntry('INV-11');
    const summary = inv11.summary;

    // What IS enforced by construction, and by which chokepoint.
    expect(summary).toMatch(/launcher/i);
    expect(summary).toMatch(/lifecycle/i);
    expect(summary).toMatch(/placement/i);

    // Spatial write confinement is excluded, and the exclusion is explicit
    // rather than an omission a reader could mistake for a guarantee.
    expect(summary).toMatch(/spatial/i);
    expect(summary).toMatch(/exclud/i);

    // It is reported as a per-harness capability posture, never inferred.
    for (const posture of ['prevention', 'detection', 'advisory', 'unavailable']) {
      expect(summary.toLowerCase()).toContain(posture);
    }

    // The overclaim the audit found: confinement asserted by construction.
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

// ════════════════════════════════════════════════════════════════════════════
//  The retired INV-2 parity framing has no citation left in shipped source
// ════════════════════════════════════════════════════════════════════════════

/**
 * The four shipped production modules the mechanical grep found citing the
 * retired framing (`src/**\/*.ts`, excluding tests). The
 * same grep found four MORE in test files, which were re-pointed too; only the
 * production set is pinned here because a comment in a test is not an input to
 * generation.
 */
const REPOINTED_CITATION_SITES: readonly string[] = Object.freeze([
  'adapters/cli/cli.ts',
  // The registry's citation sits on the `update` action, which moved with the
  // rest of the workflow action list when the declarations were split out of
  // one module. The path names the module that CARRIES the citation, not the
  // barrel consumers import: the barrel re-exports and holds no prose, so
  // naming it would assert against a file that can never satisfy the check.
  'registry/actions/workflow.ts',
  'workflow/composite.ts',
  'contract/cli/cli-contract-seam.ts',
]);

/**
 * The retired framing: INV-2 cited AS byte-parity between two peer facades.
 *
 * Two things separate a CITATION from the mere characters, and the earlier
 * `/INV-2\s+parity/i` over raw file text had neither:
 *
 *   1. **It must be prose.** A `describe(...)` title, a failure message, a regex
 *      source or an identifier that contains the phrase is code, not a claim the
 *      tree makes. This module's own sweep name and error string both contain
 *      it; so does the line that used to hold the pattern.
 *   2. **It must not be a mention.** Prose that names the framing in order to
 *      say it is gone, or that puts the words in quotes to talk ABOUT them, is
 *      not asserting them. The old detector could not tell either apart from a
 *      live citation, which is why this file's fixture had to be written as
 *      `'INV-2' + ' parity'` — a test evading its own detector is the detector
 *      admitting it matches spelling rather than meaning.
 *
 * So the phrase counts only when it appears in comment prose, unquoted, and its
 * own sentence does not qualify it as retired. {@link citesRetiredParityFramingIn}
 * applies (1); this function applies (2) to text already known to be prose.
 */
const RETIRED_PARITY_RE = /INV-2\s+(?:byte-)?parity/gi;

/**
 * Words that turn "INV-2 parity" from a claim into a description of one. Read
 * within the phrase's own sentence, so a qualifier wrapped onto the previous
 * comment line still governs it and one from an unrelated sentence does not.
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
/** The governing framing: INV-2 as the contract every client is derived from. */
function citesGoverningFraming(text: string): boolean {
  return /governing\s+INV-2/i.test(text);
}

/** {@link citesGoverningFraming} over the comment prose of a source file. */
function citesGoverningFramingIn(source: string): boolean {
  return citesGoverningFraming(extractCommentProse(source));
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
  it('RetiredParityDetector_FiresOnStaleCitation_AndNotOnGoverningOne', () => {
    // A sweep that reports zero offenders is only meaningful if the detector
    // that produced the zero can produce a one.
    //
    // The literal is written WHOLE here. Under the retired detector it had to be
    // split (`'INV-2' + ' parity'`) so this file would not match its own sweep —
    // a workaround that only exists when a detector reads characters instead of
    // claims, and its disappearance is part of what this repair buys.
    const stale = '// shape the MCP arm receives (INV-2 parity; #1127).';
    const repointed = '// one registered schema (governing INV-2 — by construction).';
    expect(citesRetiredParityFramingIn(stale)).toBe(true);
    expect(citesRetiredParityFramingIn(repointed)).toBe(false);
    expect(citesGoverningFramingIn(repointed)).toBe(true);
    expect(citesGoverningFramingIn(stale)).toBe(false);
  });

  // ─── Kill fixtures: the innocuous forms that used to red the build ────────

  it('RetiredParityDetector_PhraseInCode_IsNotAProseCitation', () => {
    // A title, a message and a regex source all contain the characters and none
    // of them is the tree claiming byte-parity. This module has all three, which
    // is why the sweep never dared read its own directory honestly.
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

  it('RetiredParityDetector_QuotedPhraseIsMentionedNotAsserted', () => {
    // The use–mention distinction. A document that defines, quotes or retires a
    // framing has to spell it; only bare prose asserts it. Without this the sole
    // way to write about the framing is to avoid writing it, which is the
    // workaround this repair deletes.
    const mentioned = '// Words that turn "INV-2 parity" into a claim about one.';
    const asserted = '// Words that turn the MCP arm into INV-2 parity with the CLI.';
    expect(citesRetiredParityFramingIn(mentioned)).toBe(false);
    expect(citesRetiredParityFramingIn(asserted)).toBe(true);
  });

  it('RetiredParityDetector_QualifierFromAnotherSentence_DoesNotExcuseACitation', () => {
    // The qualifier has to govern THIS phrase. A "retired" belonging to the
    // previous sentence must not launder a live citation in the next one — the
    // failure mode a fixed look-back window would have.
    const source =
      '// The old wording is retired. The MCP arm receives INV-2 parity with the CLI.';
    expect(citesRetiredParityFramingIn(source)).toBe(true);
  });

  it('RetiredParityDetector_ReadsThisVeryFile_AsClean', () => {
    // The sharpest available fixture: this module names the retired framing in
    // its header, its describe title, its failure message and every comment
    // above — and cites it nowhere. Under the retired detector it was an
    // offender by its own rule, which is exactly why it excluded itself.
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(citesRetiredParityFramingIn(self)).toBe(false);
    // ...and the sweep is still capable of firing on the same corpus.
    expect(citesRetiredParityFramingIn(`${self}\n// per INV-2 parity, #1127.`)).toBe(true);
  });

  it('ShippedSource_CitesNoRetiredInv2ParityFraming', () => {
    const files = walkTsFiles(SHIPPED_SRC_ROOT);
    // DERIVED denominator (task 079 / DR-8). This read `>= 300` over a corpus of
    // ~655 — less than half the real population, so a sweep that lost most of the
    // tree still cleared it and reported the remainder clean. The pin is now
    // containment against `git ls-files` narrowed to this walk's own filter
    // (non-test `.ts`), which knows nothing about the walker's recursion: every
    // tracked module in scope must have been visited, and a shortfall names the
    // files that were not.
    expect(
      trackedFilesMissedBy(
        files.map((file) => path.relative(SHIPPED_SRC_ROOT, file).split(path.sep).join('/')),
        listTrackedFiles(SHIPPED_SRC_ROOT, {
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

  it('RepointedSites_EachCiteTheGoverningInv2Framing', () => {
    for (const rel of REPOINTED_CITATION_SITES) {
      const abs = path.join(SHIPPED_SRC_ROOT, rel);
      expect(fs.existsSync(abs), `${rel} must exist`).toBe(true);
      const text = fs.readFileSync(abs, 'utf8');
      expect(citesGoverningFramingIn(text), `${rel} must cite the governing INV-2`).toBe(
        true,
      );
      expect(citesRetiredParityFramingIn(text), `${rel} must not cite the retired one`).toBe(
        false,
      );
    }
  });
});

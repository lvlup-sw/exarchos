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
// @oracle-sources: ../../../../.exarchos/invariants.md, ../../../../docs/specs/2026-08-04-wiring-closure-and-unified-integration-suite.md, shipped-src-corpus
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInvariants, type InvariantEntry } from '../architecture/invariants-loader.js';
import { defaultSourcePaths, loadAuthorityLock } from './authority-collector.js';
import { digestText } from './authority-digest.js';
import { CLI_CONTRACT_DEVIATIONS } from './cli/cli-contract-seam.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `src` — the shipped production source root. */
const SHIPPED_SRC_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(HERE, '../..');
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

    // The mechanical backstop is unchanged: `skills/**` is generated output.
    expect(catalogEntry('INV-4').enforcement?.mode).toBe('check');
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
    const fixture = 'test/core/process/multi-process-append.test.ts';
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
  'registry.ts',
  'workflow/composite.ts',
  'contract/cli/cli-contract-seam.ts',
]);

/** The retired framing: INV-2 cited AS byte-parity between two peer facades. */
function citesRetiredParityFraming(text: string): boolean {
  return /INV-2\s+parity/i.test(text);
}

/** The governing framing: INV-2 as the contract every client is derived from. */
function citesGoverningFraming(text: string): boolean {
  return /governing\s+INV-2/i.test(text);
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
    const stale = '// shape the MCP arm receives (INV-2' + ' parity; #1127).';
    const repointed = '// one registered schema (governing INV-2 — by construction).';
    expect(citesRetiredParityFraming(stale)).toBe(true);
    expect(citesRetiredParityFraming(repointed)).toBe(false);
    expect(citesGoverningFraming(repointed)).toBe(true);
    expect(citesGoverningFraming(stale)).toBe(false);
  });

  it('ShippedSource_CitesNoRetiredInv2ParityFraming', () => {
    const files = walkTsFiles(SHIPPED_SRC_ROOT);
    // Denominator floor: a sweep over an empty corpus is vacuously clean.
    expect(files.length).toBeGreaterThanOrEqual(300);

    const offenders = files
      .filter((f) => citesRetiredParityFraming(fs.readFileSync(f, 'utf8')))
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
      expect(citesGoverningFraming(text), `${rel} must cite the governing INV-2`).toBe(
        true,
      );
      expect(citesRetiredParityFraming(text), `${rel} must not cite the retired one`).toBe(
        false,
      );
    }
  });
});

// ─── P07-05 exit-proof tests — Retirement-safety scan (Transition task 037) ────
//
// Proves, mechanically, the P07-05 gating discipline:
//   (a) the scan reports ZERO production references for anything it calls
//       safe-to-delete (the safe path is exercised, not vacuous);
//   (b) a PLANTED production reference flips a safe disposition to
//       blocked-by-live-reference (the scan is not a rubber stamp);
//   (c) the cutover gate correctly reports its unmet conditions and REFUSES to
//       event-source enforcement enablement (the legacy guard stays authoritative);
//   (d) the REAL tree + REAL gate disposition: every legacy authority is blocked,
//       the legacy HSM guard by the cutover gate with its unmet conditions named,
//       the playbook registry by live references — nothing is safe to delete now.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CutoverGateNotSatisfiedError,
  evaluateCutoverGate,
  toEnforcementEnabledData,
  type CutoverGateEvidence,
  type CutoverPolicyRef,
} from '../admission/cutover-gate.js';
import type {
  ShadowDecisionRecord,
  ShadowProvenance,
} from '../admission/shadow-decision.js';
import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  ContentDigestV1,
} from '../admission/types.js';
import {
  LEGACY_AUTHORITIES,
  AUTHORITY_KINDS,
  disposeAuthority,
  extractRelativeImports,
  formatDispositionTable,
  productionReferencesForAuthority,
  resolveRelativeTarget,
  runRetirementScan,
  scanProductionReferences,
  stripModuleExtension,
  type CutoverGateStatus,
  type LegacyAuthority,
  type SourceModule,
} from './retirement-safety.js';

// ─── Shared source-tree fixtures ───────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '..', '..'); // …/servers/exarchos-mcp/src

const TEST_PATH_RE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|__fixtures__|test-fixtures|test-helpers|evals)(\/|$)/;

function isTestPath(rel: string): boolean {
  return TEST_PATH_RE.test(rel) || TEST_DIR_RE.test(rel);
}

function collectSourceModules(root: string): readonly SourceModule[] {
  const modules: SourceModule[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
          continue;
        }
        walk(full);
      } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        const rel = relative(root, full).split(sep).join('/');
        modules.push({ path: rel, content: readFileSync(full, 'utf8'), isTest: isTestPath(rel) });
      }
    }
  };
  walk(root);
  return modules;
}

// Cached once — the walk reads the whole tree.
const REAL_MODULES = collectSourceModules(SRC_ROOT);

// ─── Real cutover-gate evidence: 6 explained disagreements, 0 live attempts ────
//
// This mirrors the CURRENT production state the work package describes: the
// deterministic corpus is clean (all disagreements explained), but the live
// observer has accumulated NO attempts, so three conditions remain unmet.

function attempt(): ShadowDecisionRecord['attempt'] {
  return { workflowType: 'feature', fromPhase: 'a', toPhase: 'b', phaseKind: 'IMPLEMENT' };
}

function agreeRecord(): ShadowDecisionRecord {
  return {
    attempt: attempt(),
    legacyOutcome: 'allow',
    admission: { status: 'evaluated', verdict: 'allow' },
    disagreementClass: 'agree',
    disposition: 'agree',
    explained: true,
    reason: 'agree',
  };
}

function explainedDisagreement(): ShadowDecisionRecord {
  return {
    attempt: attempt(),
    legacyOutcome: 'allow',
    admission: { status: 'evaluated', verdict: 'deny' },
    disagreementClass: 'legacy-allow-admission-deny',
    disposition: 'explained-legacy',
    explained: true,
    reason: 'known legacy defect (P06-01 DR-1)',
  };
}

function currentProductionGateEvidence(): CutoverGateEvidence {
  return {
    corpusRecords: [
      agreeRecord(),
      ...Array.from({ length: 6 }, () => explainedDisagreement()),
    ],
    liveAttempts: [], // P07-02 wired the observer; no production evidence has accrued yet
  };
}

function currentProductionGateStatus(): CutoverGateStatus {
  const report = evaluateCutoverGate(currentProductionGateEvidence());
  return { satisfied: report.satisfied, unmetConditions: report.unmet };
}

const SATISFIED_GATE: CutoverGateStatus = { satisfied: true, unmetConditions: [] };

// ─── Dependency-scan primitives ────────────────────────────────────────────────

describe('RetirementSafety_DependencyScan (path + import resolution)', () => {
  it('strips module extensions so a .js specifier matches its .ts source', () => {
    expect(stripModuleExtension('workflow/guards.ts')).toBe('workflow/guards');
    expect(stripModuleExtension('workflow/guards.js')).toBe('workflow/guards');
    expect(stripModuleExtension('a/b/c.mts')).toBe('a/b/c');
  });

  it('extracts only RELATIVE imports (static + type-only + dynamic), dropping bare specifiers', () => {
    const src = [
      "import { a } from './guards.js';",
      "import type { B } from '../workflow/state-machine.js';",
      "export { x } from './x.js';",
      "import zod from 'zod';",
      "const m = await import('./late.js');",
      "const r = require('../legacy/thing.js');",
    ].join('\n');
    const specs = extractRelativeImports(src);
    expect(specs).toContain('./guards.js');
    expect(specs).toContain('../workflow/state-machine.js');
    expect(specs).toContain('./x.js');
    expect(specs).toContain('./late.js');
    expect(specs).toContain('../legacy/thing.js');
    expect(specs).not.toContain('zod');
  });

  it('resolves ../ and ./ specifiers against the importing module directory', () => {
    expect(resolveRelativeTarget('workflow/state-machine.ts', './guards.js')).toBe('workflow/guards');
    expect(resolveRelativeTarget('orchestrate/finalize-oneshot.ts', '../workflow/guards.js')).toBe(
      'workflow/guards',
    );
    expect(resolveRelativeTarget('a/b/c.ts', '../../top.js')).toBe('top');
  });

  it('counts a production importer but NOT a test importer', () => {
    const modules: readonly SourceModule[] = [
      { path: 'workflow/guards.ts', content: '// target', isTest: false },
      {
        path: 'workflow/state-machine.ts',
        content: "import { guards } from './guards.js';",
        isTest: false,
      },
      {
        path: 'workflow/guards.test.ts',
        content: "import { guards } from './guards.js';",
        isTest: true,
      },
    ];
    const refs = scanProductionReferences(modules, ['workflow/guards.ts']);
    expect(refs.get('workflow/guards.ts')).toEqual(['workflow/state-machine.ts']);
  });

  it('excludes INTERNAL edges from an authority\'s external references', () => {
    const authority: LegacyAuthority = {
      id: 'cluster',
      kind: 'legacy-guard',
      summary: 'self-contained cluster',
      modules: ['workflow/guards.ts', 'workflow/hsm-definitions.ts'],
      cutoverGated: false,
    };
    const modules: readonly SourceModule[] = [
      { path: 'workflow/guards.ts', content: '// leaf', isTest: false },
      {
        // internal edge — part of the same authority, must NOT block deletion
        path: 'workflow/hsm-definitions.ts',
        content: "import { guards } from './guards.js';",
        isTest: false,
      },
    ];
    expect(productionReferencesForAuthority(authority, modules)).toEqual([]);
  });
});

// ─── Disposition core ──────────────────────────────────────────────────────────

describe('RetirementSafety_Disposition (evidence → verdict)', () => {
  const ungated: LegacyAuthority = {
    id: 'manual-widget-inventory',
    kind: 'manual-inventory',
    summary: 'a hand-maintained inventory superseded by a governed registry',
    modules: ['legacy/widget-inventory.ts'],
    cutoverGated: false,
  };

  it('(a) reports safe-to-delete with ZERO production references', () => {
    const d = disposeAuthority(ungated, [], SATISFIED_GATE, []);
    expect(d.disposition).toBe('safe-to-delete');
    expect(d.productionReferences).toEqual([]);
    expect(d.rationale).toContain('0 production references');
  });

  it('(b) a PLANTED production reference flips safe-to-delete → blocked-by-live-reference', () => {
    const before = disposeAuthority(ungated, [], SATISFIED_GATE, []);
    expect(before.disposition).toBe('safe-to-delete');

    const after = disposeAuthority(ungated, ['orchestrate/live-consumer.ts'], SATISFIED_GATE, []);
    expect(after.disposition).toBe('blocked-by-live-reference');
    expect(after.productionReferences).toEqual(['orchestrate/live-consumer.ts']);
  });

  it('(b) a live-behaviour test alone also blocks (never delete a test that covers live behaviour)', () => {
    const d = disposeAuthority(ungated, [], SATISFIED_GATE, ['legacy/widget-inventory.test.ts']);
    expect(d.disposition).toBe('blocked-by-live-reference');
    expect(d.liveBehaviorTests).toEqual(['legacy/widget-inventory.test.ts']);
  });

  it('a cutover-gated authority is blocked-by-cutover-gate and names the unmet conditions', () => {
    const gated: LegacyAuthority = { ...ungated, id: 'legacy-guard', kind: 'legacy-guard', cutoverGated: true };
    const gate: CutoverGateStatus = {
      satisfied: false,
      unmetConditions: ['live-attempt-threshold', 'phase-kind-coverage', 'outcome-coverage'],
    };
    const d = disposeAuthority(gated, ['workflow/state-machine.ts'], gate, []);
    expect(d.disposition).toBe('blocked-by-cutover-gate');
    expect(d.unmetGateConditions).toEqual([
      'live-attempt-threshold',
      'phase-kind-coverage',
      'outcome-coverage',
    ]);
    // secondary evidence (live refs) is still surfaced
    expect(d.productionReferences).toEqual(['workflow/state-machine.ts']);
  });

  it('the cutover gate DOMINATES: a gated authority with zero refs is still blocked while unsatisfied', () => {
    const gated: LegacyAuthority = { ...ungated, kind: 'legacy-guard', cutoverGated: true };
    const gate: CutoverGateStatus = { satisfied: false, unmetConditions: ['live-attempt-threshold'] };
    expect(disposeAuthority(gated, [], gate, []).disposition).toBe('blocked-by-cutover-gate');
  });

  it('a satisfied gate releases a gated-but-unreferenced authority to safe-to-delete', () => {
    const gated: LegacyAuthority = { ...ungated, kind: 'legacy-guard', cutoverGated: true };
    expect(disposeAuthority(gated, [], SATISFIED_GATE, []).disposition).toBe('safe-to-delete');
  });
});

// ─── Exit-proof (c): the cutover gate refuses enforcement enablement ───────────

describe('RetirementSafety_CutoverGateRefusesEnablement (P07-05 exit-proof c)', () => {
  const digest: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };
  const caller: AttributedPrincipalV1 = {
    principalKind: 'operator',
    principalId: 'principal.cutover-operator',
    role: 'release-authority',
  };
  const authorization: AuthorizationSnapshotV1 = {
    authorizationId: 'authz-1',
    posture: 'shared-mutating',
    capabilityIds: ['capability.enable-enforcement'],
    resolverVersion: '1.0',
    resolvedAt: '2026-08-03T00:00:00.000Z',
  };
  const provenance: ShadowProvenance = { caller, authorization };
  const policy: CutoverPolicyRef = {
    policyId: 'policy-1',
    policyVersion: '1.0',
    policyDigest: digest,
    inputDigest: digest,
  };

  it('the current-production gate is NOT satisfied and names exactly the three unmet conditions', () => {
    const report = evaluateCutoverGate(currentProductionGateEvidence());
    expect(report.satisfied).toBe(false);
    expect(report.unexplainedDisagreements).toBe(0);
    expect(report.liveAttemptCount).toBe(0);
    // deterministic-corpus-clean is met (all disagreements explained); the other three are not.
    expect(new Set(report.unmet)).toEqual(
      new Set(['live-attempt-threshold', 'phase-kind-coverage', 'outcome-coverage']),
    );
  });

  it('enforcement enablement CANNOT be event-sourced past the unsatisfied gate', () => {
    const report = evaluateCutoverGate(currentProductionGateEvidence());
    expect(() =>
      toEnforcementEnabledData({
        report,
        enablementId: 'en-x',
        operationId: 'op-x',
        rolloutDecisionId: 'ro-x',
        policy,
        enabledAt: '2026-08-03T00:00:00.000Z',
        provenance,
      }),
    ).toThrow(CutoverGateNotSatisfiedError);
  });
});

// ─── Exit-proof (d): the REAL disposition over the live tree ───────────────────

describe('RetirementSafety_LiveDisposition (P07-05 exit-proof d)', () => {
  const gate = currentProductionGateStatus();
  const report = runRetirementScan(LEGACY_AUTHORITIES, REAL_MODULES, gate);
  const byId = new Map(report.dispositions.map((d) => [d.authorityId, d]));

  it('the source walk actually found the tree (sanity floor)', () => {
    expect(REAL_MODULES.length).toBeGreaterThan(100);
    // The legacy guard modules are present in the walked tree.
    const paths = new Set(REAL_MODULES.map((m) => m.path));
    expect(paths.has('workflow/guards.ts')).toBe(true);
    expect(paths.has('workflow/state-machine.ts')).toBe(true);
  });

  it('the legacy HSM guard is blocked-by-cutover-gate with the gate\'s unmet conditions', () => {
    const d = byId.get('legacy-hsm-guard');
    expect(d).toBeDefined();
    expect(d?.disposition).toBe('blocked-by-cutover-gate');
    expect(new Set(d?.unmetGateConditions ?? [])).toEqual(
      new Set(['live-attempt-threshold', 'phase-kind-coverage', 'outcome-coverage']),
    );
    // It is also demonstrably live: real production modules still import it.
    expect((d?.productionReferences.length ?? 0)).toBeGreaterThan(0);
    expect(d?.productionReferences).toContain('workflow/state-machine.ts');
    expect(d?.productionReferences).toContain('orchestrate/finalize-oneshot.ts');
  });

  it('the legacy HSM registry is blocked-by-cutover-gate and still has live importers', () => {
    const d = byId.get('legacy-hsm-registry');
    expect(d?.disposition).toBe('blocked-by-cutover-gate');
    expect((d?.productionReferences.length ?? 0)).toBeGreaterThan(0);
    expect(d?.productionReferences).toContain('workflow/tools.ts');
  });

  it('the obsolete predicates are blocked-by-cutover-gate (embedded in the live guards.ts)', () => {
    const d = byId.get('legacy-obsolete-predicates');
    expect(d?.disposition).toBe('blocked-by-cutover-gate');
    expect(d?.liveBehaviorTests).toContain('workflow/guard-classification.test.ts');
  });

  it('the playbook registry is NOT closed — blocked-by-live-reference by real importers', () => {
    const d = byId.get('legacy-playbook-registry');
    expect(d?.disposition).toBe('blocked-by-live-reference');
    expect((d?.productionReferences.length ?? 0)).toBeGreaterThan(0);
  });

  it('NOTHING is safe to delete in this pass — the honest, evidence-backed result', () => {
    expect(report.safeToDelete).toEqual([]);
    expect(new Set(report.blocked)).toEqual(new Set(LEGACY_AUTHORITIES.map((a) => a.id)));
    // The disposition table renders for the human-facing exit-proof report.
    const table = formatDispositionTable(report);
    expect(table).toContain('blocked-by-cutover-gate');
    expect(table).toContain('legacy-hsm-guard');
  });
});

// ─── The authority registry is well-formed ─────────────────────────────────────

describe('RetirementSafety_AuthorityRegistry', () => {
  it('every authority has a unique id and at least one module', () => {
    const ids = LEGACY_AUTHORITIES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of LEGACY_AUTHORITIES) {
      expect(a.modules.length).toBeGreaterThan(0);
      for (const m of a.modules) expect(m.endsWith('.ts')).toBe(true);
    }
  });

  it('every authority kind is a declared member of AUTHORITY_KINDS', () => {
    expect(AUTHORITY_KINDS).toContain('legacy-guard');
    expect(AUTHORITY_KINDS).toHaveLength(6);
    const kinds = new Set<string>(AUTHORITY_KINDS);
    for (const a of LEGACY_AUTHORITIES) {
      expect(kinds.has(a.kind), `${a.id} kind ${a.kind} must be declared`).toBe(true);
    }
  });

  it('every enforcement-path authority (guard/hsm-registry/obsolete-predicate) is cutover-gated', () => {
    for (const a of LEGACY_AUTHORITIES) {
      if (a.kind === 'legacy-guard' || a.kind === 'hsm-registry' || a.kind === 'obsolete-predicate') {
        expect(a.cutoverGated, `${a.id} must be cutover-gated`).toBe(true);
      }
    }
  });
});

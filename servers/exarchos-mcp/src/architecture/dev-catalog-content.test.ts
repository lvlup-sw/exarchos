// ─── Dev-catalog v3 content characterization (issue #1466) ──────────────────
//
// These tests assert the AUTHORED CONTENT of the live dev catalog at
// `.exarchos/invariants.md` — distinct from #1465's machinery tests
// (loader, evaluator, projection) which inject synthetic entries. Here we load
// the REAL catalog and assert the v3 fields authored onto real invariants:
//   CR-1  schema-version 3 + back-compat
//   CR-2  ≥1 mode:check + ≥1 mode:audit, each firing on a seeded diff and
//         CALIBRATED to zero findings on a clean diff (bootstrap-hazard guard)
//   CR-3  affinity + severity + integrity-class projection
//   CR-6  audit prompts rendered verbatim
//
// The "calibrate on clean" guard here uses an empty / benign diff; the full
// "zero findings on the actual HEAD diff" calibration is verified by the gate
// run during implementation and the e2e parity test.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadInvariants, type InvariantEntry } from './invariants-loader.js';
import { evaluateTree } from './check-evaluator.js';
import { projectCatalog } from './project-catalog.js';
import { renderAuditPrompt } from './audit-prompt.js';
import { EventStore } from '../event-store/store.js';
import { handleCheckInvariantConformance } from '../orchestrate/check-invariant-conformance.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

function loadCatalog(): InvariantEntry[] {
  return loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);
}

function entry(id: string): InvariantEntry {
  const e = loadCatalog().find((x) => x.id === id);
  if (!e) throw new Error(`catalog entry ${id} not found`);
  return e;
}

/** A unified diff hunk touching one file. */
function diffFor(filePath: string, addedLines: string[]): string {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1 +1,2 @@',
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

// ─── CR-1: schema bump + back-compat ─────────────────────────────────────────

describe('dev-catalog v3 content — CR-1 schema bump', () => {
  it('liveCatalog_declaresSchemaVersion3', () => {
    const fm = matter(fs.readFileSync(INVARIANTS_DOC, 'utf8')).data as {
      'schema-version'?: unknown;
    };
    expect(fm['schema-version']).toBe(3);
  });

  it('liveCatalog_loadsUnderV3LoaderWithNoError', () => {
    expect(() => loadCatalog()).not.toThrow();
    expect(loadCatalog().length).toBeGreaterThan(0);
  });

  it('liveCatalog_hasExactly21Entries_noDimEntries', () => {
    // Axiom excision (#1477) removed the 8 DIM-* axiom-dimension entries and
    // the coverage-closure machinery that depended on `axiom_overlap`. The
    // live catalog is now exactly 21 entries (20 INV-* — including INV-16
    // os-portability added in #1623 and INV-17 response-economy added by the
    // tool-token-economy-remediation feature — plus basileus-boundary), none DIM-*.
    const cat = loadCatalog();
    expect(cat.length).toBe(21);
    expect(cat.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  it('entryWithoutAffinities_resolvesAllPhasesAllTypes', () => {
    // An entry with no phase/workflow affinity must project for any context.
    const noAffinity = loadCatalog().find(
      (e) => e.phaseAffinity === undefined && e.workflowAffinity === undefined,
    );
    expect(noAffinity).toBeDefined();
    const projected = projectCatalog([noAffinity!], {
      phase: 'review',
      workflowType: 'feature',
    });
    expect(projected).toHaveLength(1);
  });
});

// ─── CR-2: mode:check enforcement, calibrated ────────────────────────────────

describe('dev-catalog v3 content — CR-2 mode:check enforcement', () => {
  it('atLeastOneCheckAndOneAudit_authored', () => {
    const cat = loadCatalog();
    const checks = cat.filter((e) => e.enforcement?.mode === 'check');
    const audits = cat.filter((e) => e.enforcement?.mode === 'audit');
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  // INV-4 is the original diff-precise mode:check; task 027 (DR-15) raised
  // INV-13/14/16 to mode:check too (each with a deterministic anti-pattern grep
  // + both-direction self-tests below). INV-6's operational projection
  // (scripts/lint-inv6.mjs) is a deliberately-advisory literal scan with a
  // frontmatter-declaration escape hatch a diff-grep cannot replicate, and
  // INV-5a/5d tool-COUNT facts require the whole file, not a diff — so those
  // three stay mode:audit (Approach-B "audit the rest"). See CR-6 below.

  // These two characterized the PRE-086 check node, which greped `@@` over any
  // `skills/**` diff. That fired on every regeneration — which CLAUDE.md
  // mandates committing — so the old `inv4_editingGeneratedSkillsRuntimeFile_fires`
  // asserted the defect as correct. Task 086 re-pointed INV-4 to `audit`
  // deferring to `skills:guard`, so what is worth pinning is that the deferral
  // went to a real mechanism rather than becoming an absence of enforcement.

  it('inv4_GeneratedSkillsDiff_NoLongerAutoBlocks', () => {
    const e = entry('INV-4');
    expect(e.enforcement?.mode).toBe('audit');
    // An audit entry carries no check tree, so no diff shape can auto-block —
    // asserted structurally rather than by evaluating a node that is now absent.
    expect(e.enforcement && 'check' in e.enforcement).toBe(false);
  });

  it('inv4_AuditPrompt_NamesTheRenderEquivalenceProbe', () => {
    const enforcement = entry('INV-4').enforcement;
    if (!enforcement || enforcement.mode !== 'audit') {
      throw new Error('INV-4 must be an audit entry for this claim to mean anything');
    }
    const prompt = enforcement['audit-prompt'];
    // The deferral must name the probe that answers the question the grep could
    // not — otherwise `audit` is just "a reviewer will think about it", and the
    // downgrade would have removed enforcement instead of relocating it.
    expect(prompt).toMatch(/skills:guard/);
    expect(prompt).toMatch(/skills-src/);
    // Non-empty denominator on the prompt itself: a one-word prompt would match
    // neither pattern by accident, but an empty one must not read as satisfied.
    expect(prompt.trim().length).toBeGreaterThan(80);
  });

  // ─── INV-13/14/16 raised audit→check (task 027 / DR-15): both-direction proofs ─
  //
  // Each raised invariant is CALIBRATED: a synthetic violation fires (>=1
  // finding) AND the conforming form produces zero findings — a check that
  // cannot fail is vacuous. The anti-pattern literals are ASSEMBLED from
  // fragments so this test's OWN source neither trips
  // scripts/check-windows-portability.mjs (the INV-16 module-path literal) nor
  // the invariant's own diff-grep when the review gate runs on this PR's diff.

  function checkTreeOf(id: string): never {
    const e = entry(id);
    expect(e.enforcement?.mode, `${id} must be mode:check (task 027)`).toBe('check');
    return (e.enforcement as { mode: 'check'; check: never }).check;
  }

  it('inv14_addsDestructiveResetHard_fires', () => {
    // The forbidden git-args invocation `['reset', '--hard', …]`.
    const resetHard = `['reset', ` + `'--hard', sha]`;
    const violating = diffFor(
      'servers/exarchos-mcp/src/orchestrate/pure/execute-merge.ts',
      [`    gitExec(repoRoot, ${resetHard});`],
    );
    expect(evaluateTree(checkTreeOf('INV-14'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv14_usesResetKeepRecoveryLadder_producesNoFinding', () => {
    // The conforming INV-14 ladder: merge --abort → reset --keep, never --hard.
    const conforming = diffFor(
      'servers/exarchos-mcp/src/orchestrate/pure/execute-merge.ts',
      [
        `    gitExec(repoRoot, ['merge', '--abort']);`,
        `    gitExec(repoRoot, ['reset', '--keep', sha]);`,
      ],
    );
    expect(evaluateTree(checkTreeOf('INV-14'), conforming)).toEqual([]);
  });

  it('inv16_addsUrlPathnameModulePath_fires', () => {
    const antipattern = `new URL(import.meta.url)` + `.pathname`;
    const violating = diffFor('servers/exarchos-mcp/src/utils/paths.ts', [
      `    const here = ${antipattern};`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-16'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv16_usesFileUrlToPath_producesNoFinding', () => {
    const conforming = diffFor('servers/exarchos-mcp/src/utils/paths.ts', [
      `    const here = fileURLToPath(import.meta.url);`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-16'), conforming)).toEqual([]);
  });

  it('inv13_addsExecutedWithoutRequested_fires', () => {
    const violating = diffFor(
      'servers/exarchos-mcp/src/orchestrate/execute-merge.ts',
      [`    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`],
    );
    expect(evaluateTree(checkTreeOf('INV-13'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv13_addsBothRequestedAndExecuted_producesNoFinding', () => {
    const conforming = diffFor(
      'servers/exarchos-mcp/src/orchestrate/execute-merge.ts',
      [
        `    await emit(eventStore, featureId, 'merge.requested', { payload });`,
        `    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`,
      ],
    );
    expect(evaluateTree(checkTreeOf('INV-13'), conforming)).toEqual([]);
  });

  it('inv13_executedOutsideOrchestrateScope_producesNoFinding', () => {
    // Scope guard: an executed emission outside the orchestrate handler tree is
    // out of range, so the two-event proxy does not fire on it.
    const outOfScope = diffFor('servers/exarchos-mcp/src/telemetry/foo.ts', [
      `    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-13'), outOfScope)).toEqual([]);
  });
});

// ─── CR-6: mode:audit prompts ────────────────────────────────────────────────

describe('dev-catalog v3 content — CR-6 mode:audit', () => {
  it('inv6_inv5a_inv5d_areAuditMode', () => {
    // Demoted from check (Approach-B): not diff-precise. They contribute
    // judgment prompts, never a programmatic check.
    for (const id of ['INV-6', 'INV-5a', 'INV-5d']) {
      expect(entry(id).enforcement?.mode).toBe('audit');
    }
  });

  it('inv11_isAuditModeWithPrompt', () => {
    const e = entry('INV-11');
    expect(e.enforcement?.mode).toBe('audit');
    const prompt = renderAuditPrompt([e]);
    expect(prompt).toContain('INV-11');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('inv3_auditPrompt_isTransportNeutral', () => {
    // INV-3 (basileus-forward) audit prompt must not presume MCP-local
    // execution — no "locally"/"on this machine"-style language.
    const e = entry('INV-3');
    expect(e.enforcement?.mode).toBe('audit');
    const promptText = (
      e.enforcement as { mode: 'audit'; 'audit-prompt': string }
    )['audit-prompt'].toLowerCase();
    expect(promptText).not.toMatch(/mcp[- ]local|local-only|on this machine/);
  });

  it('renderedAuditPrompt_carriesNoPerInvariantBranching', () => {
    // INV-6 guard: the renderer treats every audit invariant uniformly.
    const cat = loadCatalog();
    const audits = cat.filter((e) => e.enforcement?.mode === 'audit');
    const prompt = renderAuditPrompt(audits);
    for (const a of audits) expect(prompt).toContain(a.id);
  });
});

// ─── CR-3: projection metadata ───────────────────────────────────────────────

describe('dev-catalog v3 content — CR-3 projection', () => {
  it('workflowDiscoveryPhaseReview_excludesCodeAxisInvariants', () => {
    const projected = projectCatalog(loadCatalog(), {
      phase: 'review',
      // DR-4: canonical workflow-type token is `'discovery'`.
      workflowType: 'discovery',
    });
    // No substrate-axis (code) invariant survives a discovery-workflow review.
    expect(projected.every((e) => e.axis !== 'substrate')).toBe(true);
  });

  it('substrateInvariants_carryIntegrityClassSubstrate', () => {
    const inv1 = entry('INV-1');
    expect(inv1.integrityClass).toBe('substrate');
  });

  it('oneshotWorkflow_downgradesSeverityToAdvisory', () => {
    // At least one enforcement-bearing invariant downgrades to advisory under
    // the oneshot workflow (design DR-5 oneshot rule).
    const downgraded = loadCatalog().filter(
      (e) => e.severity?.['by-workflow']?.['oneshot'] === 'advisory',
    );
    expect(downgraded.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── CR-5: end-to-end gate bite through the REAL production path ─────────────
//
// Drives handleCheckInvariantConformance with repoRoot=REPO_ROOT + the enabled
// config and NO injected loader, so resolveEffectiveCatalog loads the AUTHORED
// .exarchos/invariants.md for real. Proves the authored content (not
// just the machinery) produces a real finding on a violating diff and stays
// APPROVED + emits gate.executed on a clean diff (calibrate-on-HEAD).

describe('dev-catalog v3 content — CR-5 end-to-end gate bite', () => {
  async function arm(): Promise<{ stateDir: string; eventStore: EventStore }> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'inv1466-e2e-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore };
  }

  it('seededGeneratedSkillsEdit_inv4Audits_RatherThanAutoBlocking', async () => {
    // This case previously asserted `NEEDS_FIXES` for ANY `skills/**` diff —
    // i.e. it characterized the #1764/086 defect as correct behaviour. A diff
    // touching generated skills is exactly what `npm run build:skills` produces
    // and CLAUDE.md requires committing, so auto-blocking it made the invariant
    // unsatisfiable by a conforming change. INV-4 now audits, and the mechanical
    // question ("is this tree a faithful render of skills-src/?") is answered by
    // `skills:guard`, which is a whole-tree probe this diff-scoped gate cannot be.
    const { stateDir, eventStore } = await arm();
    try {
      const regenerated = diffFor('skills/claude-code/ideate/SKILL.md', [
        'a direct edit to generated output',
      ]);
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-1466-regenerated',
          workflowType: 'feature',
          phase: 'review',
          diff: regenerated,
          repoRoot: REPO_ROOT,
          config: ENABLED_CONFIG,
        },
        stateDir,
        eventStore,
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        findings: Array<{ dimension?: string }>;
        auditInvariantIds?: readonly string[];
      };
      // No AUTOMATIC INV-4 block…
      expect(data.findings.some((f) => f.dimension === 'INV-4')).toBe(false);
      // …but INV-4 is still routed to the reviewer rather than dropped. That
      // distinction is the whole point: audit relocates the judgement, and an
      // INV-4 absent from BOTH lists would mean the downgrade deleted it.
      expect(data.auditInvariantIds ?? []).toContain('INV-4');

      // The gate still runs and still records itself — a silent gate would be
      // its own defect, so the event is asserted independently of the verdict.
      const gates = await eventStore.query('feat-1466-regenerated', {
        type: 'gate.executed',
      });
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  it('cleanDiff_approvedWithGateEvent', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      // A benign source edit (no skills/** path) trips no mode:check invariant.
      const clean = diffFor('servers/exarchos-mcp/src/example.ts', [
        'export const answer = 42;',
      ]);
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-1466-clean',
          workflowType: 'feature',
          phase: 'review',
          diff: clean,
          repoRoot: REPO_ROOT,
          config: ENABLED_CONFIG,
        },
        stateDir,
        eventStore,
      );
      expect(result.success).toBe(true);
      const data = result.data as { verdict: string; high: number };
      expect(data.verdict).toBe('APPROVED');
      expect(data.high).toBe(0);

      const gates = await eventStore.query('feat-1466-clean', {
        type: 'gate.executed',
      });
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});

// ─── Task 027 (DR-15): gate blocks on check-mode findings only ───────────────
//
// Drives handleCheckInvariantConformance against the REAL authored catalog
// (repoRoot=REPO_ROOT + enabled config, no injected loader) to prove:
//   1. a synthetic check-mode (blocking) violation fails the gate;
//   2. a conforming diff over the anti-pattern zones passes;
//   3. audit-mode entries never produce a gating finding here (they render into
//      the review-subagent PROMPT) — the blocking scope is check-mode only.

describe('dev-catalog v3 content — task 027 gate blocking (DR-15)', () => {
  async function arm(): Promise<{ stateDir: string; eventStore: EventStore }> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'task027-gate-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore };
  }

  it('InvariantGate_SyntheticViolation_FailsForCheckMode', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      // A blocking check-mode violation: INV-16's non-portable module path.
      const antipattern = `new URL(import.meta.url)` + `.pathname`;
      const violating = diffFor('servers/exarchos-mcp/src/utils/paths.ts', [
        `    const here = ${antipattern};`,
      ]);
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-027-violating',
          workflowType: 'feature',
          phase: 'review',
          diff: violating,
          repoRoot: REPO_ROOT,
          config: ENABLED_CONFIG,
        },
        stateDir,
        eventStore,
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        findings: Array<{ dimension?: string; severity: string }>;
      };
      expect(data.verdict).toBe('NEEDS_FIXES');
      expect(data.high).toBeGreaterThanOrEqual(1);
      expect(data.findings.some((f) => f.dimension === 'INV-16')).toBe(true);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  it('InvariantGate_ConformingTree_Passes', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      // A diff touching every anti-pattern zone in its CONFORMING form: the
      // INV-14 reset --keep ladder, both INV-13 two-event emissions, and the
      // INV-16 fileURLToPath module path. No check-mode invariant fires.
      const conforming = [
        diffFor('servers/exarchos-mcp/src/orchestrate/pure/execute-merge.ts', [
          `    gitExec(repoRoot, ['merge', '--abort']);`,
          `    gitExec(repoRoot, ['reset', '--keep', sha]);`,
        ]),
        diffFor('servers/exarchos-mcp/src/orchestrate/execute-merge.ts', [
          `    await emit(store, id, 'merge.requested', { payload });`,
          `    await emit(store, id, 'merge.executed', { mergeSha });`,
        ]),
        diffFor('servers/exarchos-mcp/src/utils/paths.ts', [
          `    const here = fileURLToPath(import.meta.url);`,
        ]),
      ].join('\n');
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-027-conforming',
          workflowType: 'feature',
          phase: 'review',
          diff: conforming,
          repoRoot: REPO_ROOT,
          config: ENABLED_CONFIG,
        },
        stateDir,
        eventStore,
      );
      expect(result.success).toBe(true);
      const data = result.data as { verdict: string; high: number };
      expect(data.verdict).toBe('APPROVED');
      expect(data.high).toBe(0);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  it('InvariantGate_AuditModeFinding_StaysAdvisory', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const auditIds = new Set(
        loadCatalog()
          .filter((e) => e.enforcement?.mode === 'audit')
          .map((e) => e.id),
      );
      expect(auditIds.size).toBeGreaterThanOrEqual(1);

      // A benign diff: no check-mode invariant fires.
      const benign = diffFor('servers/exarchos-mcp/src/example.ts', [
        'export const answer = 42;',
      ]);
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-027-audit-advisory',
          workflowType: 'feature',
          phase: 'review',
          diff: benign,
          repoRoot: REPO_ROOT,
          config: ENABLED_CONFIG,
        },
        stateDir,
        eventStore,
      );
      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        auditPrompt: string;
        findings: Array<{ dimension?: string }>;
      };
      // Audit-mode entries render into the review-subagent PROMPT ...
      const promptedAudit = [...auditIds].filter((id) => data.auditPrompt.includes(id));
      expect(promptedAudit.length).toBeGreaterThanOrEqual(1);
      // ... and NEVER as a programmatic (gating) finding in this handler.
      expect(
        data.findings.some((f) => f.dimension !== undefined && auditIds.has(f.dimension)),
      ).toBe(false);
      // The benign diff gates nothing.
      expect(data.verdict).toBe('APPROVED');
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});

/**
 * Characterizes the authored content of the live dev catalog at `.exarchos/invariants.md`.
 * The machinery tests inject synthetic entries. These tests load the real catalog and assert its
 * v3 fields. The fields are the schema version, the enforcement modes, the projection metadata
 * and the audit prompts.
 *
 * The conformance gate records evidence through the shared phase-gate runner. The runner needs an
 * active workflow phase attempt, which these fixtures do not create. The subject here is the
 * verdict of the authored catalog, so the `gate-runner` mock reduces the runner to its provider call.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadInvariants, type InvariantEntry } from '../../../src/architecture/invariants-loader.js';
import { evaluateTree } from '../../../src/architecture/check-evaluator.js';
import { projectCatalog } from '../../../src/architecture/project-catalog.js';
import { renderAuditPrompt } from '../../../src/architecture/audit-prompt.js';

vi.mock('../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));
import { EventStore } from '../../../src/events/store.js';
import { handleCheckInvariantConformance } from '../../../src/verbs/gates/check-invariant-conformance.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
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

  /** The 21 entries are 20 `INV-*` entries and `basileus-boundary`. The catalog holds no `DIM-*` entry. */
  it('liveCatalog_hasExactly21Entries_noDimEntries', () => {
    const cat = loadCatalog();
    expect(cat.length).toBe(21);
    expect(cat.filter((e) => e.id.startsWith('DIM-'))).toEqual([]);
  });

  /** An entry with no phase affinity and no workflow affinity must project in a `review` phase of a `feature` workflow. */
  it('entryWithoutAffinities_resolvesAllPhasesAllTypes', () => {
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

/**
 * The enforcement modes of the live catalog. For each check-mode entry, a synthetic violation
 * must give a finding and the conforming form must give none. A check that cannot fail is vacuous.
 *
 * The tests assemble the `reset --hard` literal and the module-path literal from fragments, so
 * the source of this file holds neither. `tools/audit/gates/check-windows-portability.mjs` scans
 * the whole repository and flags the module-path literal. The invariant greps read only `src/**`,
 * so they do not flag this file.
 * `checkTreeOf` asserts that an entry is check-mode and returns its check tree.
 */
describe('dev-catalog v3 content — CR-2 mode:check enforcement', () => {
  it('atLeastOneCheckAndOneAudit_authored', () => {
    const cat = loadCatalog();
    const checks = cat.filter((e) => e.enforcement?.mode === 'check');
    const audits = cat.filter((e) => e.enforcement?.mode === 'audit');
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The `platform-agnosticity` entry is audit-mode. A regeneration changes the generated skills,
   * and the repository commits them, so a diff grep blocks a conforming change.
   * An audit entry has no check tree, so no diff shape can block automatically.
   */
  it('inv4_GeneratedSkillsDiff_NoLongerAutoBlocks', () => {
    const e = entry('INV-4');
    expect(e.enforcement?.mode).toBe('audit');
    expect(e.enforcement && 'check' in e.enforcement).toBe(false);
  });

  /**
   * The audit prompt must name `render:guard`, the probe that answers what a diff grep cannot.
   * Without that name, the audit mode removes the enforcement and does not move it.
   */
  it('inv4_AuditPrompt_NamesTheRenderEquivalenceProbe', () => {
    const enforcement = entry('INV-4').enforcement;
    if (!enforcement || enforcement.mode !== 'audit') {
      throw new Error('INV-4 must be an audit entry for this claim to mean anything');
    }
    const prompt = enforcement['audit-prompt'];
    expect(prompt).toMatch(/render:guard/);
    expect(prompt).toMatch(/content\//);
    expect(prompt.trim().length).toBeGreaterThan(80);
  });

  function checkTreeOf(id: string): never {
    const e = entry(id);
    expect(e.enforcement?.mode, `${id} must be mode:check (task 027)`).toBe('check');
    return (e.enforcement as { mode: 'check'; check: never }).check;
  }

  it('inv14_addsDestructiveResetHard_fires', () => {
    const resetHard = `['reset', ` + `'--hard', sha]`;
    const violating = diffFor(
      'src/verbs/merge/execute-merge.ts',
      [`    gitExec(repoRoot, ${resetHard});`],
    );
    expect(evaluateTree(checkTreeOf('INV-14'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv14_usesResetKeepRecoveryLadder_producesNoFinding', () => {
    const conforming = diffFor(
      'src/verbs/merge/execute-merge.ts',
      [
        `    gitExec(repoRoot, ['merge', '--abort']);`,
        `    gitExec(repoRoot, ['reset', '--keep', sha]);`,
      ],
    );
    expect(evaluateTree(checkTreeOf('INV-14'), conforming)).toEqual([]);
  });

  it('inv16_addsUrlPathnameModulePath_fires', () => {
    const antipattern = `new URL(import.meta.url)` + `.pathname`;
    const violating = diffFor('src/utils/paths.ts', [
      `    const here = ${antipattern};`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-16'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv16_usesFileUrlToPath_producesNoFinding', () => {
    const conforming = diffFor('src/utils/paths.ts', [
      `    const here = fileURLToPath(import.meta.url);`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-16'), conforming)).toEqual([]);
  });

  it('inv13_addsExecutedWithoutRequested_fires', () => {
    const violating = diffFor(
      'src/verbs/merge/execute-merge.ts',
      [`    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`],
    );
    expect(evaluateTree(checkTreeOf('INV-13'), violating).length).toBeGreaterThanOrEqual(1);
  });

  it('inv13_addsBothRequestedAndExecuted_producesNoFinding', () => {
    const conforming = diffFor(
      'src/verbs/merge/execute-merge.ts',
      [
        `    await emit(eventStore, featureId, 'merge.requested', { payload });`,
        `    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`,
      ],
    );
    expect(evaluateTree(checkTreeOf('INV-13'), conforming)).toEqual([]);
  });

  /** The check covers only `src/verbs`, so a `merge.executed` emission in a different tree gives no finding. */
  it('inv13_executedOutsideVerbScope_producesNoFinding', () => {
    const outOfScope = diffFor('src/projections/telemetry/foo.ts', [
      `    await emit(eventStore, featureId, 'merge.executed', { mergeSha });`,
    ]);
    expect(evaluateTree(checkTreeOf('INV-13'), outOfScope)).toEqual([]);
  });
});

describe('dev-catalog v3 content — CR-6 mode:audit', () => {
  /**
   * A diff-scoped check cannot decide these three entries, so they are audit-mode.
   * Each one gives a prompt for a reviewer and no programmatic check.
   */
  it('inv6_inv5a_inv5d_areAuditMode', () => {
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

  /** The audit prompt must not presume local MCP execution, so it holds no "on this machine" wording. */
  it('inv3_auditPrompt_isTransportNeutral', () => {
    const e = entry('INV-3');
    expect(e.enforcement?.mode).toBe('audit');
    const promptText = (
      e.enforcement as { mode: 'audit'; 'audit-prompt': string }
    )['audit-prompt'].toLowerCase();
    expect(promptText).not.toMatch(/mcp[- ]local|local-only|on this machine/);
  });

  /** The rendered prompt holds the id of every audit-mode entry of the live catalog. */
  it('renderedAuditPrompt_carriesNoPerInvariantBranching', () => {
    const cat = loadCatalog();
    const audits = cat.filter((e) => e.enforcement?.mode === 'audit');
    const prompt = renderAuditPrompt(audits);
    for (const a of audits) expect(prompt).toContain(a.id);
  });
});

describe('dev-catalog v3 content — CR-3 projection', () => {
  /** `'discovery'` is the canonical workflow-type token. Its review projects no substrate-axis invariant. */
  it('workflowDiscoveryPhaseReview_excludesCodeAxisInvariants', () => {
    const projected = projectCatalog(loadCatalog(), {
      phase: 'review',
      workflowType: 'discovery',
    });
    expect(projected.every((e) => e.axis !== 'substrate')).toBe(true);
  });

  it('substrateInvariants_carryIntegrityClassSubstrate', () => {
    const inv1 = entry('INV-1');
    expect(inv1.integrityClass).toBe('substrate');
  });

  /** At least one entry declares the `advisory` severity for the `oneshot` workflow. */
  it('oneshotWorkflow_downgradesSeverityToAdvisory', () => {
    const downgraded = loadCatalog().filter(
      (e) => e.severity?.['by-workflow']?.['oneshot'] === 'advisory',
    );
    expect(downgraded.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Runs `handleCheckInvariantConformance` with the real repo root, the enabled config and no
 * injected loader, so the handler loads the authored `.exarchos/invariants.md`.
 * `arm` creates a temp state directory and an initialized event store.
 */
describe('dev-catalog v3 content — CR-5 end-to-end gate bite', () => {
  async function arm(): Promise<{ stateDir: string; eventStore: EventStore }> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'inv1466-e2e-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore };
  }

  /**
   * A regeneration produces a diff of generated skills, so the gate must not block that diff
   * automatically. The `platform-agnosticity` entry gives no finding, but its id stays in
   * `auditInvariantIds`, so the reviewer still judges it. An id in neither list is a lost entry.
   * The gate must also append `gate.executed`, whatever the verdict is.
   */
  it('seededGeneratedSkillsEdit_inv4Audits_RatherThanAutoBlocking', async () => {
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
      expect(data.findings.some((f) => f.dimension === 'INV-4')).toBe(false);
      expect(data.auditInvariantIds ?? []).toContain('INV-4');

      const gates = await eventStore.query('feat-1466-regenerated', {
        type: 'gate.executed',
      });
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  /** A benign source edit trips no check-mode invariant. */
  it('cleanDiff_approvedWithGateEvent', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const clean = diffFor('src/example.ts', [
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

/**
 * Runs the gate against the authored catalog to show its blocking scope. A check-mode violation
 * fails the gate, and a conforming diff over the same zones passes. An audit-mode entry gives no
 * gating finding. It renders into the prompt for the review subagent.
 * `arm` creates a temp state directory and an initialized event store.
 */
describe('dev-catalog v3 content — task 027 gate blocking (DR-15)', () => {
  async function arm(): Promise<{ stateDir: string; eventStore: EventStore }> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'task027-gate-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore };
  }

  /** The violation is a module path from `URL.pathname`, which the `os-portability` entry blocks. */
  it('InvariantGate_SyntheticViolation_FailsForCheckMode', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const antipattern = `new URL(import.meta.url)` + `.pathname`;
      const violating = diffFor('src/utils/paths.ts', [
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

  /**
   * The diff touches each anti-pattern zone in its conforming form: the `reset --keep` sequence,
   * both merge events, and the `fileURLToPath` module path.
   */
  it('InvariantGate_ConformingTree_Passes', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const conforming = [
        diffFor('src/verbs/pure/execute-merge.ts', [
          `    gitExec(repoRoot, ['merge', '--abort']);`,
          `    gitExec(repoRoot, ['reset', '--keep', sha]);`,
        ]),
        diffFor('src/verbs/pure/execute-merge.ts', [
          `    await emit(store, id, 'merge.requested', { payload });`,
          `    await emit(store, id, 'merge.executed', { mergeSha });`,
        ]),
        diffFor('src/utils/paths.ts', [
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

  /**
   * On a benign diff, at least one audit-mode id appears in `auditPrompt`.
   * No finding has an audit-mode id as its dimension, and the verdict is `APPROVED`.
   */
  it('InvariantGate_AuditModeFinding_StaysAdvisory', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const auditIds = new Set(
        loadCatalog()
          .filter((e) => e.enforcement?.mode === 'audit')
          .map((e) => e.id),
      );
      expect(auditIds.size).toBeGreaterThanOrEqual(1);

      const benign = diffFor('src/example.ts', [
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
      const promptedAudit = [...auditIds].filter((id) => data.auditPrompt.includes(id));
      expect(promptedAudit.length).toBeGreaterThanOrEqual(1);
      expect(
        data.findings.some((f) => f.dimension !== undefined && auditIds.has(f.dimension)),
      ).toBe(false);
      expect(data.verdict).toBe('APPROVED');
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});

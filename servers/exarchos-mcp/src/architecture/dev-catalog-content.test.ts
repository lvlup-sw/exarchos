// ─── Dev-catalog v3 content characterization (issue #1466) ──────────────────
//
// These tests assert the AUTHORED CONTENT of the live dev catalog at
// `docs/architecture/invariants.md` — distinct from #1465's machinery tests
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { loadInvariants, type InvariantEntry } from './invariants-loader.js';
import { evaluateTree } from './check-evaluator.js';
import { projectCatalog } from './project-catalog.js';
import { renderAuditPrompt } from './audit-prompt.js';
import { EventStore } from '../event-store/store.js';
import { handleCheckInvariantConformance } from '../orchestrate/check-invariant-conformance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs/architecture/invariants.md');
const ENABLED_CONFIG = { invariants: { devCatalog: 'enabled' as const } };

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

  it('liveCatalog_hasExactly19Entries_noDimEntries', () => {
    // Axiom excision (#1477) removed the 8 DIM-* axiom-dimension entries and
    // the coverage-closure machinery that depended on `axiom_overlap`. The
    // live catalog is now exactly 19 entries (18 INV-* + basileus-boundary),
    // none of them DIM-*.
    const cat = loadCatalog();
    expect(cat.length).toBe(19);
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

  // INV-4 is the lone precise mode:check. INV-6's operational projection
  // (scripts/lint-inv6.mjs) is a deliberately-advisory literal scan with a
  // frontmatter-declaration escape hatch a diff-grep cannot replicate, and
  // INV-5a/5d tool-COUNT facts require the whole file, not a diff — so all
  // three are mode:audit (Approach-B "audit the rest"). See CR-6 below.

  it('inv4_editingGeneratedSkillsRuntimeFile_fires', () => {
    const e = entry('INV-4');
    expect(e.enforcement?.mode).toBe('check');
    const violating = diffFor('skills/claude-code/brainstorming/SKILL.md', [
      'direct edit to generated output',
    ]);
    const findings = evaluateTree(
      (e.enforcement as { mode: 'check'; check: never }).check,
      violating,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it('inv4_editingSkillsSrcOnly_producesNoFinding', () => {
    const e = entry('INV-4');
    const clean = diffFor('skills-src/brainstorming/SKILL.md', [
      'edit to source-of-truth is fine',
    ]);
    const findings = evaluateTree(
      (e.enforcement as { mode: 'check'; check: never }).check,
      clean,
    );
    expect(findings).toEqual([]);
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
  it('workflowDiscoverPhaseReview_excludesCodeAxisInvariants', () => {
    const projected = projectCatalog(loadCatalog(), {
      phase: 'review',
      workflowType: 'discover',
    });
    // No substrate-axis (code) invariant survives a discover-workflow review.
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
// docs/architecture/invariants.md for real. Proves the authored content (not
// just the machinery) produces a real finding on a violating diff and stays
// APPROVED + emits gate.executed on a clean diff (calibrate-on-HEAD).

describe('dev-catalog v3 content — CR-5 end-to-end gate bite', () => {
  async function arm(): Promise<{ stateDir: string; eventStore: EventStore }> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'inv1466-e2e-'));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore };
  }

  it('seededGeneratedSkillsEdit_inv4Fires_NeedsFixesWithGateEvent', async () => {
    const { stateDir, eventStore } = await arm();
    try {
      const violating = diffFor('skills/claude-code/brainstorming/SKILL.md', [
        'a direct edit to generated output',
      ]);
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-1466-violating',
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
        findings: Array<{ dimension?: string }>;
      };
      expect(data.verdict).toBe('NEEDS_FIXES');
      expect(data.high).toBeGreaterThanOrEqual(1);
      expect(data.findings.some((f) => f.dimension === 'INV-4')).toBe(true);

      const gates = await eventStore.query('feat-1466-violating', {
        type: 'gate.executed',
      });
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
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
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

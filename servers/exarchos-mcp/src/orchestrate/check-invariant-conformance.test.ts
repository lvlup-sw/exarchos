// ─── check_invariant_conformance handler tests (DR-3, DR-4) ─────────────────
//
// The gate, at phase=review:
//   1. load → merge → project the effective invariant catalog for
//      (workflow-type, phase:'review', touched-files);
//   2. evaluate every enforcement.mode === 'check' invariant's combinator tree
//      against the diff → findings;
//   3. render every applicable mode:'audit' invariant into a prompt;
//   4. fold both into the check_review_verdict severity-merge path using each
//      invariant's context-resolved severity.
//
// Tests inject the catalog directly via `loadInvariantsFn` so they need no
// disk IO; the default loader reads `docs/architecture/invariants.md`.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { InvariantEntry } from '../architecture/invariants-loader.js';
import { handleCheckInvariantConformance } from './check-invariant-conformance.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Build a minimal v3 InvariantEntry; callers override the shape they need. */
function makeEntry(over: Partial<InvariantEntry> & { id: string }): InvariantEntry {
  return {
    dimension: 'Test',
    axis: 'substrate',
    costOfLoad: 'always-load',
    appliesTo: ['**'],
    summary: `${over.id} summary`,
    references: [],
    raw: {},
    ...over,
  };
}

interface Arm {
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

async function createArm(prefix: string): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, eventStore };
}

async function gateEvents(eventStore: EventStore, featureId: string) {
  return eventStore.query(featureId, { type: 'gate.executed' });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleCheckInvariantConformance (DR-3, DR-4)', () => {
  it('CheckInvariantConformance_EmptyCatalog_ApprovedZeroFindings', async () => {
    const arm = await createArm('inv-conformance-empty-');
    try {
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-empty',
          workflowType: 'feature',
          diffContent: 'anything',
          loadInvariantsFn: () => [],
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        findings: unknown[];
        high: number;
        medium: number;
        low: number;
      };
      expect(data.verdict).toBe('APPROVED');
      expect(data.findings).toEqual([]);
      expect(data.high).toBe(0);

      // STILL emits gate.executed even for an empty applicable catalog.
      const gates = await gateEvents(arm.eventStore, 'feat-empty');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
  });

  it('CheckInvariantConformance_BlockingViolation_FoldsToNeedsFixes', async () => {
    const arm = await createArm('inv-conformance-blocking-');
    try {
      // A check-mode invariant that fires (a `console.log` appears in the diff),
      // with context-resolved severity = blocking → HIGH → NEEDS_FIXES.
      const entry = makeEntry({
        id: 'USER-1',
        severity: { default: 'blocking' },
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'console\\.log', fileGlob: '*.ts' },
        },
      });

      const diff = [
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -1 +1,2 @@',
        '+console.log("debug");',
      ].join('\n');

      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-blocking',
          workflowType: 'feature',
          diffContent: diff,
          loadInvariantsFn: () => [entry],
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as { verdict: string; high: number; findings: unknown[] };
      expect(data.findings.length).toBeGreaterThanOrEqual(1);
      expect(data.high).toBeGreaterThanOrEqual(1);
      expect(data.verdict).toBe('NEEDS_FIXES');
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
  });

  it('CheckInvariantConformance_MalformedUserCatalog_DegradesToShippedLayersAdvisory', async () => {
    const arm = await createArm('inv-conformance-malformed-');
    try {
      // A valid SHIPPED-layer invariant that fires on the diff.
      const shipped = makeEntry({
        id: 'INV-9',
        severity: { default: 'blocking' },
        enforcement: {
          mode: 'check',
          check: { kind: 'grep', pattern: 'console\\.log', fileGlob: '*.ts' },
        },
      });

      const diff = [
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -1 +1,2 @@',
        '+console.log("debug");',
      ].join('\n');

      // The user-catalog loader throws (malformed YAML / unknown kind /
      // reserved-namespace id). The gate must DEGRADE to the shipped layers
      // and surface an advisory finding naming the failed catalog — never
      // abort, never silently swallow.
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-malformed',
          workflowType: 'feature',
          diffContent: diff,
          loadInvariantsFn: () => [shipped],
          loadUserInvariantsFn: () => {
            throw new Error('bad YAML in .exarchos/invariants.user.yml');
          },
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        high: number;
        findings: Array<{ severity: string; source: string; message: string }>;
      };

      // Shipped layer still evaluated → its blocking violation folds to HIGH.
      expect(data.high).toBeGreaterThanOrEqual(1);

      // The user-catalog load failure is surfaced as a non-fatal advisory
      // finding that names the failed catalog source.
      const advisory = data.findings.find((f) =>
        /user.?catalog|invariants\.user\.yml/i.test(`${f.source} ${f.message}`),
      );
      expect(advisory).toBeDefined();
      expect(advisory?.severity).toBe('LOW');
      expect(advisory?.message).toContain('invariants.user.yml');

      // Gate still executed (degraded, not aborted).
      const gates = await gateEvents(arm.eventStore, 'feat-malformed');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
  });

  it('CheckInvariantConformance_LeafThrows_CapturedAsLowFinding', async () => {
    const arm = await createArm('inv-conformance-leaf-throws-');
    try {
      // An invalid regex pattern makes the evaluator throw during evaluation.
      // The throw must be captured as a LOW finding naming the invariant id,
      // never propagated to abort the whole gate.
      const entry = makeEntry({
        id: 'USER-THROW',
        severity: { default: 'blocking' },
        enforcement: {
          mode: 'check',
          // Unbalanced group → `new RegExp` throws inside the evaluator.
          check: { kind: 'grep', pattern: '(', fileGlob: '*.ts' },
        },
      });

      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-leaf-throws',
          workflowType: 'feature',
          diffContent: '+something',
          loadInvariantsFn: () => [entry],
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        verdict: string;
        low: number;
        findings: Array<{ severity: string; message: string }>;
      };

      const lowFinding = data.findings.find((f) => f.severity === 'LOW');
      expect(lowFinding).toBeDefined();
      expect(lowFinding?.message).toContain('USER-THROW');
      expect(data.low).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
  });

  it('CheckInvariantConformance_AuditInvariant_RendersPromptInResult', async () => {
    const arm = await createArm('inv-conformance-audit-');
    try {
      const entry = makeEntry({
        id: 'USER-AUDIT',
        summary: 'Judgment call on API ergonomics',
        enforcement: {
          mode: 'audit',
          'audit-prompt': 'Assess whether the public API reads ergonomically.',
        },
      });

      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-audit',
          workflowType: 'feature',
          diffContent: '',
          loadInvariantsFn: () => [entry],
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as { auditPrompt: string };
      expect(data.auditPrompt).toContain('USER-AUDIT');
      expect(data.auditPrompt).toContain('Assess whether the public API reads ergonomically.');
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
    }
  });
});

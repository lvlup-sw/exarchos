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
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { InvariantEntry } from '../architecture/invariants-loader.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';
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

/**
 * Build an isolated repo fixture with a built-in dev catalog at
 * `docs/architecture/invariants.md` plus (optionally) a user-authored catalog
 * file. The gate is then driven through `config` + `repoRoot` with NO injected
 * loader, so it exercises the REAL `resolveEffectiveCatalog` production path
 * (user `catalogs`, `overrides`, DR-9 degradation).
 */
async function makeRepoFixture(opts: {
  /** Dev-catalog markdown body (frontmatter + body). */
  devCatalog: string;
  /** User-catalog file written to `<repoRoot>/<userCatalogName>`. */
  userCatalog?: string;
  userCatalogName?: string;
}): Promise<{ repoRoot: string; userCatalogPath?: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'inv-conf-repo-'));
  const archDir = path.join(repoRoot, 'docs', 'architecture');
  await mkdir(archDir, { recursive: true });
  await writeFile(path.join(archDir, 'invariants.md'), opts.devCatalog, 'utf8');

  let userCatalogPath: string | undefined;
  if (opts.userCatalog !== undefined) {
    const name = opts.userCatalogName ?? 'invariants.user.yml';
    userCatalogPath = path.join(repoRoot, name);
    await writeFile(userCatalogPath, opts.userCatalog, 'utf8');
  }
  return userCatalogPath !== undefined
    ? { repoRoot, userCatalogPath }
    : { repoRoot };
}

/**
 * A dev catalog whose single invariant SDLC-3 is a blocking check-mode rule
 * that fires when `console.log` appears in a `.ts` diff. Used to prove that a
 * consumer override can flip its `enabled`/`severity` via config alone.
 *
 * NOTE: SDLC-3 lives in a reserved namespace (`SDLC-*`), so it is only valid
 * as a built-in (dev) catalog entry — never as a user-layer id. That makes it
 * the right vehicle for the override-by-config test: the override targets a
 * built-in invariant, which is the production scenario the gate must honor.
 *
 * integrity-class `sdlc` ⇒ resolveFloor = 'advisory': an `enabled:false`
 * override is CLAMPED to advisory (severity → advisory) rather than dropped,
 * so the finding falls from HIGH to MEDIUM and the verdict flips
 * NEEDS_FIXES → APPROVED. That clamp is the production override effect the
 * gate must honor.
 */
const DEV_CATALOG_SDLC3_BLOCKING = [
  '---',
  'schema-version: 3',
  'invariants:',
  '  - id: SDLC-3',
  '    dimension: lint',
  '    axis: substrate',
  '    integrity-class: sdlc',
  '    cost-of-load: always-load',
  '    applies-to:',
  '      - "**"',
  '    summary: No stray console.log in committed source.',
  '    references: []',
  '    severity:',
  '      default: blocking',
  '    enforcement:',
  '      mode: check',
  '      check:',
  '        kind: grep',
  "        pattern: 'console\\.log'",
  '        fileGlob: "*.ts"',
  '---',
  '# Dev catalog body',
  '',
].join('\n');

const CONSOLE_LOG_DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1 +1,2 @@',
  '+console.log("debug");',
].join('\n');

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

  // Legacy DI-seam degradation (kept for coverage of the loadUserInvariantsFn
  // path). The CONFIG-DRIVEN equivalent
  // (CheckInvariantConformance_MalformedUserCatalog_DegradesToShippedLayersAdvisory)
  // below proves the REAL production path.
  it('CheckInvariantConformance_MalformedUserCatalog_DegradesViaLegacyDISeam', async () => {
    const arm = await createArm('inv-conformance-malformed-di-');
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

  // ─── FIX-1: config-driven override (no injected loader) ─────────────────────
  //
  // Proves the gate runs the REAL resolveEffectiveCatalog pipeline: a consumer
  // `overrides: { SDLC-3: { enabled:false } }` in config actually removes the
  // invariant from the gate, flipping NEEDS_FIXES → APPROVED. No loader is
  // injected, so this drives applyOverrides through production code.
  it('CheckInvariantConformance_UserOverrideDisable_RespectedViaConfig', async () => {
    const arm = await createArm('inv-conformance-override-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      // Baseline: devCatalog enabled, no override → SDLC-3 fires → NEEDS_FIXES.
      const baseConfig: ExarchosConfig = {
        invariants: { devCatalog: 'enabled' },
      };
      const baseline = await handleCheckInvariantConformance(
        {
          featureId: 'feat-override-base',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
          config: baseConfig,
        },
        arm.stateDir,
        arm.eventStore,
      );
      expect(baseline.success).toBe(true);
      const baseData = baseline.data as { verdict: string; high: number };
      expect(baseData.high).toBeGreaterThanOrEqual(1);
      expect(baseData.verdict).toBe('NEEDS_FIXES');

      // With the disable override the invariant is dropped → APPROVED, 0 HIGH.
      const overrideConfig: ExarchosConfig = {
        invariants: {
          devCatalog: 'enabled',
          overrides: { 'SDLC-3': { enabled: false } },
        },
      };
      const overridden = await handleCheckInvariantConformance(
        {
          featureId: 'feat-override-applied',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
          config: overrideConfig,
        },
        arm.stateDir,
        arm.eventStore,
      );
      expect(overridden.success).toBe(true);
      const overData = overridden.data as {
        verdict: string;
        high: number;
        medium: number;
      };
      // sdlc floor clamps the disable to advisory: the violation survives as
      // MEDIUM (not dropped), but no longer drives a HIGH → verdict APPROVED.
      expect(overData.high).toBe(0);
      expect(overData.medium).toBeGreaterThanOrEqual(1);
      expect(overData.verdict).toBe('APPROVED');
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
      await rm(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  // ─── FIX-1 / DR-9: malformed user catalog degrades via the REAL config path ─
  //
  // A malformed user catalog (referenced from config.invariants.catalogs) must
  // NOT abort the gate. The dev-layer blocking invariant still evaluates; the
  // user-catalog load failure surfaces as a LOW advisory finding naming the
  // failed file. No loader is injected — this exercises resolveEffectiveCatalog
  // → its warnings → the gate's advisory findings end to end.
  it('CheckInvariantConformance_MalformedUserCatalog_DegradesToShippedLayersAdvisory', async () => {
    const arm = await createArm('inv-conformance-malformed-cfg-');
    const fixture = await makeRepoFixture({
      devCatalog: DEV_CATALOG_SDLC3_BLOCKING,
      // Unknown check kind ⇒ loader throws UnknownCheckKindError at load.
      userCatalog: [
        '---',
        'schema-version: 3',
        'invariants:',
        '  - id: team-bad',
        '    dimension: lint',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    applies-to:',
        '      - "**"',
        '    summary: Malformed — unknown check kind.',
        '    references: []',
        '    enforcement:',
        '      mode: check',
        '      check:',
        '        kind: not-a-real-kind',
        "        pattern: 'x'",
        '---',
        '# bad user catalog',
        '',
      ].join('\n'),
      userCatalogName: 'invariants.user.yml',
    });
    try {
      const config: ExarchosConfig = {
        invariants: {
          devCatalog: 'enabled',
          catalogs: [fixture.userCatalogPath as string],
        },
      };
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-malformed-cfg',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
          config,
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

      // Dev layer still evaluated → its blocking violation folds to HIGH.
      expect(data.high).toBeGreaterThanOrEqual(1);

      // The user-catalog load failure surfaces as a non-fatal LOW advisory
      // naming the failed file.
      const advisory = data.findings.find((f) =>
        /invariants\.user\.yml/i.test(`${f.source} ${f.message}`),
      );
      expect(advisory).toBeDefined();
      expect(advisory?.severity).toBe('LOW');
      expect(advisory?.message).toContain('invariants.user.yml');

      // Gate still executed (degraded, not aborted).
      const gates = await gateEvents(arm.eventStore, 'feat-malformed-cfg');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
      await rm(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  // ─── FIX-1: config is loaded from .exarchos.yml on disk (no args.config) ────
  //
  // The registry action schema does NOT carry `config`, so in production the
  // gate must load `.exarchos.yml` itself from `repoRoot`. This test writes a
  // real `.exarchos.yml` with a disable override and passes ONLY `repoRoot`
  // (no `config`, no loader) — proving the consumer's config reaches
  // applyOverrides end to end.
  it('CheckInvariantConformance_DiskConfigOverride_RespectedWithoutArgsConfig', async () => {
    const arm = await createArm('inv-conformance-disk-cfg-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      // Baseline (.exarchos.yml: devCatalog enabled, no override) → NEEDS_FIXES.
      await writeFile(
        path.join(fixture.repoRoot, '.exarchos.yml'),
        ['invariants:', '  devCatalog: enabled', ''].join('\n'),
        'utf8',
      );
      const baseline = await handleCheckInvariantConformance(
        {
          featureId: 'feat-disk-base',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
        },
        arm.stateDir,
        arm.eventStore,
      );
      expect(baseline.success).toBe(true);
      expect((baseline.data as { verdict: string }).verdict).toBe('NEEDS_FIXES');

      // Rewrite .exarchos.yml with a disable override → clamps to advisory →
      // no HIGH → APPROVED. Still no args.config: the gate loads it from disk.
      await writeFile(
        path.join(fixture.repoRoot, '.exarchos.yml'),
        [
          'invariants:',
          '  devCatalog: enabled',
          '  overrides:',
          '    SDLC-3:',
          '      enabled: false',
          '',
        ].join('\n'),
        'utf8',
      );
      const overridden = await handleCheckInvariantConformance(
        {
          featureId: 'feat-disk-override',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
        },
        arm.stateDir,
        arm.eventStore,
      );
      expect(overridden.success).toBe(true);
      const overData = overridden.data as { verdict: string; high: number };
      expect(overData.high).toBe(0);
      expect(overData.verdict).toBe('APPROVED');
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
      await rm(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  // ─── FIX-2: enforcement.review === 'advisory' does not gate ─────────────────
  //
  // A blocking invariant still fires (HIGH count preserved in the result), but
  // with `enforcement.review: advisory` the verdict must NOT be driven to
  // NEEDS_FIXES — advisory enforcement surfaces findings without gating.
  it('CheckInvariantConformance_EnforcementAdvisory_DoesNotBlockVerdict', async () => {
    const arm = await createArm('inv-conformance-advisory-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      const config: ExarchosConfig = {
        invariants: {
          devCatalog: 'enabled',
          enforcement: { review: 'advisory' },
        },
      };
      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-advisory',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          repoRoot: fixture.repoRoot,
          config,
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const data = result.data as { verdict: string; high: number };
      // The finding is still surfaced (HIGH count preserved) …
      expect(data.high).toBeGreaterThanOrEqual(1);
      // … but advisory enforcement must NOT gate the verdict.
      expect(data.verdict).toBe('APPROVED');
    } finally {
      await rm(arm.stateDir, { recursive: true, force: true });
      await rm(fixture.repoRoot, { recursive: true, force: true });
    }
  });
});

/**
 * These tests cover `check_invariant_conformance`. The gate evaluates each
 * check-mode invariant against the diff and renders each audit-mode invariant
 * into a prompt. It folds both into the review verdict. A test that passes
 * `loadInvariantsFn` reads no catalog file.
 *
 * The tests stub the phase-gate runner down to its provider call, because they
 * test the provider verdict. `gate-runner.test.ts` and
 * `check-invariant-conformance.parity.test.ts` test the real runner.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { InvariantEntry } from '../../../../src/architecture/invariants-loader.js';
import type { ExarchosConfig } from '../../../../src/config/exarchos-config-schema.js';
import { handleCheckInvariantConformance } from '../../../../src/verbs/gates/check-invariant-conformance.js';
import { CheckInvariantConformanceData } from '../../../../src/verbs/gates/check-invariant-conformance-schema.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
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

/** Builds a minimal v3 `InvariantEntry`. A caller overrides the fields it needs. */
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
 * Writes a repo fixture with a dev catalog at `.exarchos/invariants.md` and an
 * optional user catalog. A test that passes `repoRoot` with no injected loader
 * runs the real `resolveEffectiveCatalog` path.
 */
async function makeRepoFixture(opts: {
  /** Dev-catalog markdown body (frontmatter + body). */
  devCatalog: string;
  /** User-catalog file written to `<repoRoot>/<userCatalogName>`. */
  userCatalog?: string;
  userCatalogName?: string;
}): Promise<{ repoRoot: string; userCatalogPath?: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'inv-conf-repo-'));
  const devCatalogDir = path.join(repoRoot, '.exarchos');
  await mkdir(devCatalogDir, { recursive: true });
  await writeFile(
    path.join(devCatalogDir, 'invariants.md'),
    opts.devCatalog,
    'utf8',
  );

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
 * A dev catalog with one blocking check-mode invariant, SDLC-3, that fires on
 * `console.log` in a `.ts` diff. An `SDLC-*` id is valid only in a built-in
 * catalog. The `sdlc` integrity class has an advisory floor, so an
 * `enabled: false` override clamps SDLC-3 to advisory and does not drop it.
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

describe('handleCheckInvariantConformance (DR-3, DR-4)', () => {
  /**
   * An empty projection audits nothing, so the result must not look like a
   * clean audit. The gate sets the projection to `no-subject` and adds one LOW
   * advisory. The verdict stays APPROVED, because an unregistered catalog is a
   * legal state. The gate still records `gate.executed`.
   */
  it('CheckInvariantConformance_EmptyCatalog_ReportsNoSubjectRatherThanCleanAudit', async () => {
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
        findings: ReadonlyArray<{ source: string; severity: string; message: string }>;
        high: number;
        medium: number;
        low: number;
        auditPrompt: string;
        auditInvariantIds: readonly string[];
        auditProjection: string;
        applicableCount: number;
      };

      expect(data.auditProjection).toBe('no-subject');
      expect(data.applicableCount).toBe(0);
      expect(data.auditPrompt).toBe('');
      expect(data.auditInvariantIds).toEqual([]);

      const advisory = data.findings.filter((f) => f.source === 'invariant-audit');
      expect(advisory).toHaveLength(1);
      expect(advisory[0]?.severity).toBe('LOW');
      expect(advisory[0]?.message).toMatch(/No invariant was audited/);

      expect(data.verdict).toBe('APPROVED');
      expect(data.high).toBe(0);
      expect(data.low).toBe(1);

      const gates = await gateEvents(arm.eventStore, 'feat-empty');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(arm.stateDir);
    }
  });

  it('CheckInvariantConformance_BlockingViolation_FoldsToNeedsFixes', async () => {
    const arm = await createArm('inv-conformance-blocking-');
    try {
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
      await rmrfAsync(arm.stateDir);
    }
  });

  /**
   * Covers the `loadUserInvariantsFn` seam. When the user-catalog loader
   * throws, the gate still evaluates the shipped layers and adds a LOW advisory
   * that names the failed catalog. A config-driven test below covers the
   * production path.
   */
  it('CheckInvariantConformance_MalformedUserCatalog_DegradesViaLegacyDISeam', async () => {
    const arm = await createArm('inv-conformance-malformed-di-');
    try {
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

      expect(data.high).toBeGreaterThanOrEqual(1);

      const advisory = data.findings.find((f) =>
        /user.?catalog|invariants\.user\.yml/i.test(`${f.source} ${f.message}`),
      );
      expect(advisory).toBeDefined();
      expect(advisory?.severity).toBe('LOW');
      expect(advisory?.message).toContain('invariants.user.yml');

      const gates = await gateEvents(arm.eventStore, 'feat-malformed');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(arm.stateDir);
    }
  });

  /**
   * The pattern `(` makes `new RegExp` throw in the evaluator. The gate records
   * the throw as a LOW finding that names the invariant and does not abort.
   */
  it('CheckInvariantConformance_LeafThrows_CapturedAsLowFinding', async () => {
    const arm = await createArm('inv-conformance-leaf-throws-');
    try {
      const entry = makeEntry({
        id: 'USER-THROW',
        severity: { default: 'blocking' },
        enforcement: {
          mode: 'check',
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
      await rmrfAsync(arm.stateDir);
    }
  });

  /**
   * The result carries the prompt, the audit invariant ids, and a projection
   * status. The report repeats the obligation text from
   * `AUDIT_DELIVERY_OBLIGATIONS` for a consumer that calls the action without
   * the review skill. The closure guard reads the same record.
   */
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
      const data = result.data as {
        auditPrompt: string;
        auditInvariantIds: readonly string[];
        auditProjection: string;
        report: string;
      };
      expect(data.auditPrompt).toContain('USER-AUDIT');
      expect(data.auditPrompt).toContain('Assess whether the public API reads ergonomically.');

      expect(data.auditProjection).toBe('rendered');
      expect([...data.auditInvariantIds]).toEqual(['USER-AUDIT']);

      expect(data.report).toContain('USER-AUDIT');
      expect(data.report).toContain('auditPrompt');
      expect(data.report).toContain('check_review_verdict');
      expect(data.report).toContain('An unanswered audit-mode invariant is not a pass.');
    } finally {
      await rmrfAsync(arm.stateDir);
    }
  });

  /**
   * The declared output schema must accept the real handler payload. If it
   * does not, the MCP adapter replaces a correct response with INTERNAL_ERROR.
   * The schema must also reject a payload without `auditPrompt` and
   * `auditInvariantIds`. This proves that the schema does not accept every
   * object.
   */
  it('CheckInvariantConformance_DeclaredOutputSchema_AcceptsTheRealPayload', async () => {
    const arm = await createArm('inv-conformance-schema-');
    try {
      const entries = [
        makeEntry({
          id: 'USER-AUDIT',
          enforcement: { mode: 'audit', 'audit-prompt': 'Judge it.' },
        }),
        makeEntry({
          id: 'USER-CHECK',
          severity: { default: 'blocking' },
          enforcement: {
            mode: 'check',
            check: { kind: 'grep', pattern: 'console\\.log', fileGlob: '*.ts' },
          },
        }),
      ];

      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-schema',
          workflowType: 'feature',
          diffContent: CONSOLE_LOG_DIFF,
          loadInvariantsFn: () => entries,
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(true);
      const parsed = CheckInvariantConformanceData.safeParse(result.data);
      expect(parsed.error?.message ?? 'ok').toBe('ok');
      expect(parsed.success).toBe(true);

      const { auditPrompt: _p, auditInvariantIds: _i, ...stripped } =
        result.data as Record<string, unknown> & {
          auditPrompt: unknown;
          auditInvariantIds: unknown;
        };
      expect(CheckInvariantConformanceData.safeParse(stripped).success).toBe(false);
      expect(CheckInvariantConformanceData.safeParse({}).success).toBe(false);
    } finally {
      await rmrfAsync(arm.stateDir);
    }
  });

  /**
   * Runs the real `resolveEffectiveCatalog` path with no injected loader. With
   * the dev catalog registered, SDLC-3 fires and the verdict is NEEDS_FIXES. An
   * `enabled: false` override clamps SDLC-3 to advisory, so the finding becomes
   * MEDIUM and the verdict becomes APPROVED.
   */
  it('CheckInvariantConformance_UserOverrideDisable_RespectedViaConfig', async () => {
    const arm = await createArm('inv-conformance-override-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      const baseConfig: ExarchosConfig = {
        invariants: {
          catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
        },
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

      const overrideConfig: ExarchosConfig = {
        invariants: {
          catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
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
      expect(overData.high).toBe(0);
      expect(overData.medium).toBeGreaterThanOrEqual(1);
      expect(overData.verdict).toBe('APPROVED');
    } finally {
      await rmrfAsync(arm.stateDir);
      await rmrfAsync(fixture.repoRoot);
    }
  });

  /**
   * A user catalog in `config.invariants.catalogs` with an unknown check kind
   * fails to load. The gate does not abort. The dev-layer invariant still
   * fires, and a LOW advisory names the failed file. No loader is injected.
   */
  it('CheckInvariantConformance_MalformedUserCatalog_DegradesToShippedLayersAdvisory', async () => {
    const arm = await createArm('inv-conformance-malformed-cfg-');
    const fixture = await makeRepoFixture({
      devCatalog: DEV_CATALOG_SDLC3_BLOCKING,
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
          catalogs: [
            fixture.userCatalogPath as string,
            { path: '.exarchos/invariants.md', tier: 'dev' },
          ],
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

      expect(data.high).toBeGreaterThanOrEqual(1);

      const advisory = data.findings.find((f) =>
        /invariants\.user\.yml/i.test(`${f.source} ${f.message}`),
      );
      expect(advisory).toBeDefined();
      expect(advisory?.severity).toBe('LOW');
      expect(advisory?.message).toContain('invariants.user.yml');

      const gates = await gateEvents(arm.eventStore, 'feat-malformed-cfg');
      expect(gates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(arm.stateDir);
      await rmrfAsync(fixture.repoRoot);
    }
  });

  /**
   * The action schema has no `config` field, so the gate loads `.exarchos.yml`
   * from `repoRoot`. The test passes `repoRoot` and no `config`. The first run
   * gives NEEDS_FIXES. After an `enabled: false` override in the file, the
   * verdict is APPROVED.
   */
  it('CheckInvariantConformance_DiskConfigOverride_RespectedWithoutArgsConfig', async () => {
    const arm = await createArm('inv-conformance-disk-cfg-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      await writeFile(
        path.join(fixture.repoRoot, '.exarchos.yml'),
        [
          'invariants:',
          '  catalogs:',
          '    - { path: .exarchos/invariants.md, tier: dev }',
          '',
        ].join('\n'),
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

      await writeFile(
        path.join(fixture.repoRoot, '.exarchos.yml'),
        [
          'invariants:',
          '  catalogs:',
          '    - { path: .exarchos/invariants.md, tier: dev }',
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
      await rmrfAsync(arm.stateDir);
      await rmrfAsync(fixture.repoRoot);
    }
  });

  /**
   * With `enforcement.review: advisory`, a blocking invariant still counts as
   * HIGH, but the verdict stays APPROVED.
   */
  it('CheckInvariantConformance_EnforcementAdvisory_DoesNotBlockVerdict', async () => {
    const arm = await createArm('inv-conformance-advisory-');
    const fixture = await makeRepoFixture({ devCatalog: DEV_CATALOG_SDLC3_BLOCKING });
    try {
      const config: ExarchosConfig = {
        invariants: {
          catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
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
      expect(data.high).toBeGreaterThanOrEqual(1);
      expect(data.verdict).toBe('APPROVED');
    } finally {
      await rmrfAsync(arm.stateDir);
      await rmrfAsync(fixture.repoRoot);
    }
  });

  /**
   * `invariant-conformance` declares `gate.executed` without a condition. When
   * the append fails, the gate withholds the success carrier and keeps its
   * verdict on `data`.
   */
  it('CheckInvariantConformance_GateEventAppendFails_WithholdsTheSuccessCarrier', async () => {
    const arm = await createArm('inv-conformance-append-fails-');
    try {
      vi.spyOn(arm.eventStore, 'append').mockRejectedValueOnce(new Error('store unavailable'));

      const result = await handleCheckInvariantConformance(
        {
          featureId: 'feat-append-fails',
          workflowType: 'feature',
          diffContent: 'anything',
          loadInvariantsFn: () => [],
        },
        arm.stateDir,
        arm.eventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_EVENT_UNRECORDED');
      const data = result.data as { verdict: string };
      expect(data.verdict).toBe('APPROVED');
    } finally {
      await rmrfAsync(arm.stateDir);
    }
  });
});

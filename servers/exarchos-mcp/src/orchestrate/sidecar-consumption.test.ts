// ─── Sidecar Consumption Tests (T15, #1298) ──────────────────────────────────
//
// Cross-gate behaviour: each of the four authoring gates must consume the
// machine-readable `<doc>.sidecar.yml` when present, and fall back to the
// existing regex-scrape path with a deprecation warning when absent.
//
// These tests anchor that contract end-to-end against real on-disk fixtures
// (no mocks) so the wiring between the handler, the sidecar-lookup helper,
// and the underlying pure functions is exercised once per gate.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { EventStore } from '../event-store/store.js';
import { sidecarPathFor } from './sidecar-lookup.js';

import { handleDesignCompleteness } from './design-completeness.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { handleProvenanceChain } from './provenance-chain.js';
import { handleTaskDecomposition } from './task-decomposition.js';
import { orchestrateLogger } from '../logger.js';

// ─── Test scaffolding ───────────────────────────────────────────────────────

const mockAppend = vi.fn();
const mockQuery = vi.fn();
const mockStore = {
  append: mockAppend,
  query: mockQuery,
} as unknown as EventStore;

let workDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sidecar-consumption-'));
  mockAppend.mockResolvedValue({
    streamId: 'feat',
    sequence: 1,
    type: 'gate.executed',
    timestamp: new Date().toISOString(),
  });
  mockQuery.mockResolvedValue([]);
  // The deprecation message is emitted via pino (`orchestrateLogger.warn`)
  // to stay inside the no-console-in-production policy (#1119).
  warnSpy = vi.spyOn(orchestrateLogger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** Concatenate all spied logger.warn invocations into one searchable string. */
function collectWarnMessages(): string {
  return warnSpy.mock.calls
    .flatMap((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))))
    .join('\n');
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

function writeConformantDesignMarkdown(designPath: string): void {
  // Conforms to existing regex-scrape expectations so the fallback path passes.
  const content = `# Sample Design

## Problem Statement
Stuff.

## Requirements
- DR-1: Foo

  - Given: X
  - When: Y
  - Then: Z

## Chosen Approach
Some prose.

### Option 1
A.

### Option 2
B.

## Technical Design
### Section A
Detail.

## Integration Points
Stuff.

## Testing Strategy
Stuff.

## Open Questions
None.
`;
  writeFileSync(designPath, content, 'utf-8');
}

function writeConformantPlanMarkdown(planPath: string): void {
  const content = `# Plan

## Tasks

### Task T-01: First task title with Section A and substantial description text

**Goal:** Implement DR-1 with a description that comfortably exceeds ten words for the structural check.

**Files:** \`src/a.ts\`, \`src/a.test.ts\`

**Tests:** [RED] First_Test_Name

**Dependencies:** none

**Parallelizable:** No

### Task T-02: Acceptance test task covering DR-1

**Goal:** Provide acceptance coverage with at least ten descriptive words to satisfy the structural validator.

**Test Layer:** acceptance

**Implements:** DR-1

**Files:** \`src/a.acceptance.test.ts\`

**Tests:** [RED] Second_Test_Name

**Dependencies:** T-01

**Parallelizable:** No
`;
  writeFileSync(planPath, content, 'utf-8');
}

function writeDesignSidecar(designPath: string): void {
  const yaml = `schema: design.v1
sections:
  problem: { present: true }
  approaches: { present: true }
drs:
  - { id: DR-1, title: Foo, section: Wave A }
acceptance:
  - { id: A-1, references: [DR-1] }
options:
  count: 2
`;
  writeFileSync(sidecarPathFor(designPath), yaml, 'utf-8');
}

function writePlanSidecar(planPath: string): void {
  // Descriptions include [RED]/Method_Scenario_Outcome markers to satisfy the
  // sidecar task-decomposition gate's test-marker requirement, mirroring the
  // markdown body convention (`**Tests:** [RED] First_Test_Name`) the legacy
  // regex path validates.
  const yaml = `schema: plan.v1
tasks:
  - id: T-01
    phase: RED
    description: "[RED] First_Test_Name — failing test that anchors the contract before any production code lands"
    files: [src/a.test.ts]
  - id: T-02
    phase: GREEN
    description: "Minimal implementation turning the [RED] Second_Test_Name green without overreach beyond the contract"
    files: [src/a.ts]
coverage:
  DR-1: [T-01, T-02]
provenance:
  - { taskId: T-01, dr: DR-1 }
  - { taskId: T-02, dr: DR-1 }
`;
  writeFileSync(sidecarPathFor(planPath), yaml, 'utf-8');
}

// ─── design-completeness ─────────────────────────────────────────────────────

describe('CheckDesignCompleteness', () => {
  it('SidecarPresent_UsesStructuredInput', async () => {
    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-fixture.md');
    writeConformantDesignMarkdown(designPath);
    writeDesignSidecar(designPath);

    const stateDir = join(workDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'feat.state.json');
    writeFileSync(stateFile, JSON.stringify({ artifacts: { design: designPath } }), 'utf-8');

    const result = await handleDesignCompleteness(
      { featureId: 'feat', stateFile, designPath },
      stateDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string; findings: readonly string[] };
      expect(data.passed).toBe(true);
      // Structured-input branch surfaces a `source: 'sidecar'` signal in the result.
      expect(data.source).toBe('sidecar');
    }
    // Deprecation warning must NOT fire when sidecar is present.
    expect(collectWarnMessages()).not.toContain('[DEPRECATION] sidecar missing');
  });

  it('NoSidecar_FallsBackToRegexWithDeprecationLog', async () => {
    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-fixture.md');
    writeConformantDesignMarkdown(designPath);
    // No sidecar written.

    const stateDir = join(workDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'feat.state.json');
    writeFileSync(stateFile, JSON.stringify({ artifacts: { design: designPath } }), 'utf-8');

    const result = await handleDesignCompleteness(
      { featureId: 'feat', stateFile, designPath },
      stateDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { source?: string };
      expect(data.source).toBe('regex');
    }
    const allWarns = collectWarnMessages();
    expect(allWarns).toContain('[DEPRECATION]');
    expect(allWarns).toContain(designPath);
  });
});

// ─── plan-coverage ──────────────────────────────────────────────────────────

describe('CheckPlanCoverage', () => {
  it('SidecarPresent_VerifiesDrCoverageStructurally', async () => {
    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-fixture.md');
    writeConformantDesignMarkdown(designPath);
    writeDesignSidecar(designPath);

    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    writePlanSidecar(planPath);

    const result = await handlePlanCoverage(
      { featureId: 'feat', designPath, planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string };
      expect(data.source).toBe('sidecar');
      expect(data.passed).toBe(true);
    }
    expect(collectWarnMessages()).not.toContain('[DEPRECATION] sidecar missing');
  });
});

// ─── provenance-chain ───────────────────────────────────────────────────────

describe('CheckProvenanceChain', () => {
  it('SidecarPresent_VerifiesDrsStructurally', async () => {
    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-fixture.md');
    writeConformantDesignMarkdown(designPath);
    writeDesignSidecar(designPath);

    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    writePlanSidecar(planPath);

    const result = await handleProvenanceChain(
      { featureId: 'feat', designPath, planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string };
      expect(data.source).toBe('sidecar');
      expect(data.passed).toBe(true);
    }
  });
});

// ─── task-decomposition ─────────────────────────────────────────────────────

describe('CheckTaskDecomposition', () => {
  it('SidecarPresent_VerifiesTasksStructurally', async () => {
    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    writePlanSidecar(planPath);

    const result = await handleTaskDecomposition(
      { featureId: 'feat', planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string; totalTasks: number };
      expect(data.source).toBe('sidecar');
      expect(data.passed).toBe(true);
      expect(data.totalTasks).toBe(2);
    }
  });

  it('SidecarTaskDecomposition_DescriptionUnderTenWords_FailsLikeLegacy', async () => {
    // Sentry #1425 HIGH: pre-fix the sidecar gate accepted any description
    // >= 5 words. Legacy `validateTaskStructure` requires > 10. Drift was a
    // silent regression in decomposition quality. Pin both branches to the
    // same threshold.
    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    const shortDescSidecar = `schema: plan.v1
tasks:
  - id: T-01
    phase: RED
    description: "[RED] Short_Test_Name only six words here"
    files: [src/a.test.ts]
coverage:
  DR-1: [T-01]
provenance:
  - { taskId: T-01, dr: DR-1 }
`;
    writeFileSync(sidecarPathFor(planPath), shortDescSidecar, 'utf-8');

    const result = await handleTaskDecomposition(
      { featureId: 'feat', planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string; needsRework: number };
      expect(data.source).toBe('sidecar');
      expect(data.passed).toBe(false);
      expect(data.needsRework).toBeGreaterThan(0);
    }
  });

  it('SidecarTaskDecomposition_DescriptionMissingTestMarker_FailsLikeLegacy', async () => {
    // Sentry #1425 HIGH: pre-fix the sidecar gate omitted the test-marker
    // check entirely. A task could claim `phase: RED` with a description
    // containing no test method name. Legacy `validateTaskStructure`
    // requires at least one `[RED]` token or `Method_Scenario_Outcome`
    // triple in the block body.
    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    const noMarkerSidecar = `schema: plan.v1
tasks:
  - id: T-01
    phase: RED
    description: "A perfectly long description that comfortably exceeds ten words but has no test markers anywhere"
    files: [src/a.test.ts]
coverage:
  DR-1: [T-01]
provenance:
  - { taskId: T-01, dr: DR-1 }
`;
    writeFileSync(sidecarPathFor(planPath), noMarkerSidecar, 'utf-8');

    const result = await handleTaskDecomposition(
      { featureId: 'feat', planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { passed: boolean; source?: string; needsRework: number };
      expect(data.source).toBe('sidecar');
      expect(data.passed).toBe(false);
      expect(data.needsRework).toBeGreaterThan(0);
    }
  });
});

// ─── #1425 follow-ups: empty-drs + log-once dedup ───────────────────────────

describe('CheckPlanCoverage — sidecar parity follow-ups', () => {
  it('SidecarPlanCoverage_EmptyDrsArray_FailsClosedWithNoDesignSections', async () => {
    // Sentry #1425 MEDIUM: pre-fix an empty `drs[]` from a malformed design
    // sidecar yielded `total=0, gaps=0, passed=true` — silently passing a
    // design with zero requirements. Legacy regex path returns
    // `NO_DESIGN_SECTIONS` for the equivalent input. Sidecar path must
    // match the same error code.
    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-fixture.md');
    writeConformantDesignMarkdown(designPath);
    const emptyDrsSidecar = `schema: design.v1
sections: {}
drs: []
acceptance: []
`;
    writeFileSync(sidecarPathFor(designPath), emptyDrsSidecar, 'utf-8');

    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-fixture.md');
    writeConformantPlanMarkdown(planPath);
    writePlanSidecar(planPath);

    const result = await handlePlanCoverage(
      { featureId: 'feat', designPath, planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NO_DESIGN_SECTIONS');
    }
  });
});

describe('SidecarLookup — log-once dedup', () => {
  it('SidecarMissing_AcrossMultipleGates_LogsDeprecationOncePerDocPath', async () => {
    // Sentry #1425 LOW: pre-fix the deprecation warning fired once per
    // (gate × missing-file) combination — 4+ duplicate lines per check for
    // a workflow without sidecars. Per-process dedup collapses repeats.
    const { __resetDeprecationLog } = await import('./sidecar-lookup.js');
    __resetDeprecationLog();

    const designDir = join(workDir, 'designs');
    mkdirSync(designDir, { recursive: true });
    const designPath = join(designDir, '2026-05-15-dedup.md');
    writeConformantDesignMarkdown(designPath);

    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-dedup.md');
    writeConformantPlanMarkdown(planPath);

    // Hit four gates back-to-back with NO sidecars on disk. The legacy regex
    // path runs each time and the missing-sidecar warning would fire on
    // every call without dedup. We assert the warn count for each unique
    // docPath stays at exactly 1.
    await handleDesignCompleteness({ featureId: 'feat', designPath }, workDir, mockStore);
    await handlePlanCoverage({ featureId: 'feat', designPath, planPath }, workDir, mockStore);
    await handleProvenanceChain({ featureId: 'feat', designPath, planPath }, workDir, mockStore);
    await handleTaskDecomposition({ featureId: 'feat', planPath }, workDir, mockStore);

    const designWarnHits = warnSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === 'object' && arg !== null && (arg as { docPath?: string }).docPath === designPath,
      ),
    ).length;
    const planWarnHits = warnSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === 'object' && arg !== null && (arg as { docPath?: string }).docPath === planPath,
      ),
    ).length;

    expect(designWarnHits).toBe(1);
    expect(planWarnHits).toBe(1);
  });
});

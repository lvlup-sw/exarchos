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

/**
 * Resolve the on-disk sidecar path for a `.md` doc using the canonical
 * `<base>.sidecar.yml` convention (B1 fix on PR #1406). Tests write
 * sidecars to this path so the lookup helper actually resolves them.
 */
function sidecarPathForTest(docPath: string): string {
  return docPath.endsWith('.md')
    ? `${docPath.slice(0, -3)}.sidecar.yml`
    : `${docPath}.sidecar.yml`;
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
  writeFileSync(sidecarPathForTest(designPath), yaml, 'utf-8');
}

function writePlanSidecar(planPath: string): void {
  const yaml = `schema: plan.v1
tasks:
  - id: T-01
    phase: RED
    description: First failing test that anchors the contract before any production code lands
    files: [src/a.test.ts]
  - id: T-02
    phase: GREEN
    description: Minimal implementation turning the RED test green without overreach
    files: [src/a.ts]
coverage:
  DR-1: [T-01, T-02]
provenance:
  - { taskId: T-01, dr: DR-1 }
  - { taskId: T-02, dr: DR-1 }
`;
  writeFileSync(sidecarPathForTest(planPath), yaml, 'utf-8');
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

  // B2 (#1406): sidecar fixture covers structural shape (count + per-task
  // description/files). DAG cycles and file conflicts are NOT encoded in
  // the plan.v1 schema today, so the sidecar branch MUST still run those
  // checks against the markdown task graph. Anchor that contract.
  it('SidecarPresentWithDagCycle_ReportsDagInvalid', async () => {
    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-cycle.md');

    // Sidecar shape is conformant (two well-described tasks with files),
    // but the markdown task graph has T-01 ↔ T-02 mutual dependency.
    const cyclicMarkdown = `# Plan

## Tasks

### Task T-01: First cyclic task with enough words for the description check

**Goal:** Describe task one with enough descriptive words for the structural validator.

**Files:** \`src/a.ts\`

**Tests:** [RED] First_Test

**Dependencies:** T-02

**Parallelizable:** No

### Task T-02: Second cyclic task with enough descriptive words for the structural check

**Goal:** Describe task two with enough descriptive words to clear the structural validator.

**Files:** \`src/b.ts\`

**Tests:** [RED] Second_Test

**Dependencies:** T-01

**Parallelizable:** No
`;
    writeFileSync(planPath, cyclicMarkdown, 'utf-8');
    writePlanSidecar(planPath);

    const result = await handleTaskDecomposition(
      { featureId: 'feat', planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        passed: boolean;
        dagValid: boolean;
        source?: string;
      };
      expect(data.source).toBe('sidecar');
      expect(data.dagValid).toBe(false);
      expect(data.passed).toBe(false);
    }
  });

  it('SidecarPresentWithFileConflict_ReportsParallelUnsafe', async () => {
    const planDir = join(workDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const planPath = join(planDir, '2026-05-15-conflict.md');

    // Two parallelizable tasks declaring the same file → conflict in the
    // parallel-safety check. Sidecar shape is otherwise conformant.
    const conflictMarkdown = `# Plan

## Tasks

### Task T-01: First parallel task with sufficient descriptive words for the validator

**Goal:** First task with enough descriptive words for the structural validator to pass.

**Files:** \`src/shared.ts\`

**Tests:** [RED] First_Test

**Dependencies:** none

**Parallelizable:** Yes

### Task T-02: Second parallel task touching the same shared source file as task one

**Goal:** Second task with enough descriptive words for the structural validator to pass.

**Files:** \`src/shared.ts\`

**Tests:** [RED] Second_Test

**Dependencies:** none

**Parallelizable:** Yes
`;
    writeFileSync(planPath, conflictMarkdown, 'utf-8');
    writePlanSidecar(planPath);

    const result = await handleTaskDecomposition(
      { featureId: 'feat', planPath },
      workDir,
      mockStore,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        passed: boolean;
        parallelSafe: boolean;
        source?: string;
      };
      expect(data.source).toBe('sidecar');
      expect(data.parallelSafe).toBe(false);
      expect(data.passed).toBe(false);
    }
  });
});

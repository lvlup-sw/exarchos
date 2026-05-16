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
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

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
  writeFileSync(`${designPath}.sidecar.yml`, yaml, 'utf-8');
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
  writeFileSync(`${planPath}.sidecar.yml`, yaml, 'utf-8');
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
    const allWarns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarns).not.toContain('[DEPRECATION] sidecar missing');
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
    const allWarns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
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
    const allWarns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allWarns).not.toContain('[DEPRECATION] sidecar missing');
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
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyProvenanceChain } from './provenance-chain.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Behavioral parity tests for provenance-chain.ts against the original
 * scripts/verify-provenance-chain.sh bash script.
 *
 * Bash script behavior:
 *   - exit 0 → all DR-N requirements traced → PASS (3/3 requirements traced)
 *   - exit 1 → gaps found → FAIL (1/3 requirements unmapped, 0 orphan references)
 */

const DESIGN_FIXTURE = `# Feature Design
## Technical Design
### Widget Component
DR-1: Renders the main UI widget.
### API Client
DR-2: Handles data fetching from the backend.
### State Manager
DR-3: Manages application state lifecycle.
`;

const PLAN_FULL_COVERAGE = `# Implementation Plan
## Tasks
### Task 1: Build Widget Component
**Implements:** DR-1
Build the core widget rendering component.
### Task 2: Create API Client
**Implements:** DR-2
Set up the API client with fetch wrappers.
### Task 3: Implement State Manager
**Implements:** DR-3
Create the state management layer.
`;

const PLAN_GAP_MISSING_DR3 = `# Implementation Plan
## Tasks
### Task 1: Build Auth Module
**Implements:** DR-1
Implement the auth flow.
### Task 2: Create Session Manager
**Implements:** DR-2
Build session handling.
`;

let tmpDir: string;
let designPath: string;
let planPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-parity-'));
  designPath = path.join(tmpDir, 'design.md');
  planPath = path.join(tmpDir, 'plan.md');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('behavioral parity with verify-provenance-chain.sh', () => {
  it('full coverage — 3/3 requirements traced yields PASS', () => {
    fs.writeFileSync(designPath, DESIGN_FIXTURE);
    fs.writeFileSync(planPath, PLAN_FULL_COVERAGE);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: planPath,
    });

    expect(result.status).toBe('pass');
    expect(result.requirements).toBe(3);
    expect(result.covered).toBe(3);
    expect(result.gaps).toBe(0);
    expect(result.orphanRefs).toBe(0);
    expect(result.gapDetails).toEqual([]);
    expect(result.orphanDetails).toEqual([]);
    expect(result.output).toContain('**Result: PASS** (3/3 requirements traced)');
  });

  it('gap — DR-3 not covered yields FAIL with 1 gap and 0 orphans', () => {
    fs.writeFileSync(designPath, DESIGN_FIXTURE);
    fs.writeFileSync(planPath, PLAN_GAP_MISSING_DR3);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: planPath,
    });

    expect(result.status).toBe('fail');
    expect(result.requirements).toBe(3);
    expect(result.covered).toBe(2);
    expect(result.gaps).toBe(1);
    expect(result.orphanRefs).toBe(0);
    expect(result.gapDetails).toEqual(['DR-3']);
    expect(result.orphanDetails).toEqual([]);
    expect(result.output).toContain(
      '**Result: FAIL** (1/3 requirements unmapped, 0 orphan references)'
    );
  });

  it('traceability matrix shows GAP marker for unmapped requirements', () => {
    fs.writeFileSync(designPath, DESIGN_FIXTURE);
    fs.writeFileSync(planPath, PLAN_GAP_MISSING_DR3);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: planPath,
    });

    expect(result.output).toContain('| DR-3 |');
    expect(result.output).toContain('**GAP**');
    expect(result.output).toContain('| DR-1 |');
    expect(result.output).toContain('| DR-2 |');
  });

  it('missing design file returns error status', () => {
    fs.writeFileSync(planPath, PLAN_FULL_COVERAGE);

    const result = verifyProvenanceChain({
      designFile: path.join(tmpDir, 'nonexistent.md'),
      planFile: planPath,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Design file not found');
  });

  it('missing plan file returns error status', () => {
    fs.writeFileSync(designPath, DESIGN_FIXTURE);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: path.join(tmpDir, 'nonexistent.md'),
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Plan file not found');
  });

  it('orphan — DR-99 referenced in plan but not in design yields FAIL with 1 orphan', () => {
    const planWithOrphan = `# Implementation Plan
## Tasks
### Task 1: Build Widget Component
**Implements:** DR-1, DR-99
Build the core widget rendering component.
### Task 2: Create API Client
**Implements:** DR-2
Set up the API client with fetch wrappers.
### Task 3: Implement State Manager
**Implements:** DR-3
Create the state management layer.
`;

    fs.writeFileSync(designPath, DESIGN_FIXTURE);
    fs.writeFileSync(planPath, planWithOrphan);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: planPath,
    });

    expect(result.status).toBe('fail');
    expect(result.requirements).toBe(3);
    expect(result.covered).toBe(3);
    expect(result.gaps).toBe(0);
    expect(result.orphanRefs).toBe(1);
    expect(result.orphanDetails).toEqual(
      expect.arrayContaining([expect.stringContaining('DR-99')])
    );
  });

  it('combined — gap (DR-3 missing) AND orphan (DR-99) yields FAIL with both findings', () => {
    const planWithGapAndOrphan = `# Implementation Plan
## Tasks
### Task 1: Build Widget Component
**Implements:** DR-1, DR-99
Build the core widget rendering component.
### Task 2: Create API Client
**Implements:** DR-2
Set up the API client with fetch wrappers.
`;

    fs.writeFileSync(designPath, DESIGN_FIXTURE);
    fs.writeFileSync(planPath, planWithGapAndOrphan);

    const result = verifyProvenanceChain({
      designFile: designPath,
      planFile: planPath,
    });

    expect(result.status).toBe('fail');
    expect(result.gaps).toBe(1);
    expect(result.gapDetails).toEqual(['DR-3']);
    expect(result.orphanRefs).toBe(1);
    expect(result.orphanDetails).toEqual(
      expect.arrayContaining([expect.stringContaining('DR-99')])
    );
  });
});

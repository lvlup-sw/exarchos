// ─── Design Completeness Pure TypeScript Tests ──────────────────────────────
//
// Tests for the ported design-completeness validation logic.
// Replaces bash script dependency (scripts/verify-ideate-artifacts.sh) with
// pure TypeScript functions: resolveDesignFile, checkRequiredSections,
// checkMultipleOptions, checkStateDesignPath, handleDesignCompleteness.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveDesignFile,
  checkRequiredSections,
  checkMultipleOptions,
  checkStateDesignPath,
  checkAcceptanceCriteria,
  handleDesignCompleteness,
} from './design-completeness.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'design-completeness-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Complete design document with all 7 required sections, 3 options, and acceptance criteria. */
function completeDesignContent(): string {
  return `# Design: Test Feature

## Problem Statement

We need to solve a problem that requires careful design.

## Requirements

- DR-1: The system must do X
  - Given: a valid input is provided
  - When: the system processes the input
  - Then: the expected output is produced

- DR-2: The system must do Y
  - Given: the system is in a ready state
  - When: an event is triggered
  - Then: the system transitions to the correct state

## Chosen Approach

We chose Option 2 because it balances flexibility and simplicity.

### Option 1: Simple Approach

Basic implementation with minimal complexity.

### Option 2: Balanced Approach

A balanced implementation with moderate complexity.

### Option 3: Complex Approach

A full-featured implementation.

## Technical Design

The implementation uses a strategy pattern with injectable handlers.

## Integration Points

Connects to the existing event store via the standard MCP protocol.

## Testing Strategy

Unit tests for each handler, integration tests for the full pipeline.

## Open Questions

- Should we support batch operations in v1?
`;
}

// ─── resolveDesignFile ──────────────────────────────────────────────────────

describe('resolveDesignFile', () => {
  it('ResolveDesignFile_ExplicitPath_ReturnsPath', () => {
    // Arrange — create a design file at an explicit path
    const designPath = join(tmpDir, 'my-design.md');
    writeFileSync(designPath, completeDesignContent());

    // Act
    const result = resolveDesignFile({ designFile: designPath });

    // Assert
    expect(result).toBe(designPath);
  });

  it('ResolveDesignFile_FromStateJson_ReadsArtifactsDesign', () => {
    // Arrange — create a design file and state file referencing it
    const designPath = join(tmpDir, 'design.md');
    writeFileSync(designPath, completeDesignContent());

    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: '1.1',
        featureId: 'test-feature',
        phase: 'plan',
        artifacts: { design: designPath },
      }),
    );

    // Act
    const result = resolveDesignFile({ stateFile });

    // Assert
    expect(result).toBe(designPath);
  });

  it('ResolveDesignFile_DocsDir_FindsLatestByDate', () => {
    // Arrange — create multiple dated design files in a docs directory
    const docsDir = join(tmpDir, 'docs', 'designs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, '2025-01-01-old-feature.md'), '# Old');
    writeFileSync(join(docsDir, '2026-03-09-new-feature.md'), '# New');
    writeFileSync(join(docsDir, '2025-06-15-mid-feature.md'), '# Mid');

    // Act
    const result = resolveDesignFile({ docsDir });

    // Assert — should return the most recent by date prefix
    expect(result).toBe(join(docsDir, '2026-03-09-new-feature.md'));
  });
});

// ─── checkRequiredSections ──────────────────────────────────────────────────

describe('checkRequiredSections', () => {
  it('CheckRequiredSections_AllPresent_Passes', () => {
    // Arrange — content with all 7 required sections
    const content = completeDesignContent();

    // Act
    const result = checkRequiredSections(content);

    // Assert
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('CheckRequiredSections_MissingRequirements_Fails', () => {
    // Arrange — content without ## Requirements
    const content = completeDesignContent().replace(/## Requirements[\s\S]*?(?=## Chosen Approach)/, '');

    // Act
    const result = checkRequiredSections(content);

    // Assert
    expect(result.passed).toBe(false);
    expect(result.missing).toContain('Requirements');
  });

  it('CheckRequiredSections_CaseInsensitive_AcceptsVariations', () => {
    // Arrange — content with lowercase "## problem statement"
    const content = completeDesignContent().replace(
      '## Problem Statement',
      '## problem statement',
    );

    // Act
    const result = checkRequiredSections(content);

    // Assert
    expect(result.passed).toBe(true);
  });
});

// ─── checkMultipleOptions ───────────────────────────────────────────────────

describe('checkMultipleOptions', () => {
  it('CheckMultipleOptions_ThreeOptions_Passes', () => {
    // Arrange — content with Option 1, Option 2, Option 3
    const content = completeDesignContent();

    // Act
    const result = checkMultipleOptions(content);

    // Assert
    expect(result.passed).toBe(true);
    expect(result.count).toBe(3);
  });

  it('CheckMultipleOptions_OneOption_Fails', () => {
    // Arrange — content with only one option
    const content = `# Design

## Problem Statement

Some problem.

### Option 1: The Only Way

This is the only option.

## Technical Design

Implementation details.
`;

    // Act
    const result = checkMultipleOptions(content);

    // Assert
    expect(result.passed).toBe(false);
    expect(result.count).toBe(1);
  });
});

// ─── checkStateDesignPath ───────────────────────────────────────────────────

describe('checkStateDesignPath', () => {
  it('CheckStateDesignPath_ValidJson_ReturnsPath', () => {
    // Arrange — valid state JSON with artifacts.design
    const designPath = join(tmpDir, 'design.md');
    writeFileSync(designPath, '# Design');

    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: '1.1',
        featureId: 'test-feature',
        phase: 'plan',
        artifacts: { design: designPath },
      }),
    );

    // Act
    const result = checkStateDesignPath(stateFile);

    // Assert
    expect(result.passed).toBe(true);
    expect(result.designPath).toBe(designPath);
  });

  it('CheckStateDesignPath_InvalidJson_ReturnsFail', () => {
    // Arrange — corrupted/invalid JSON state file
    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(stateFile, '{corrupted json!!!');

    // Act
    const result = checkStateDesignPath(stateFile);

    // Assert — should not crash, should return a failure result
    expect(result.passed).toBe(false);
  });
});

// ─── handleDesignCompleteness (integration) ─────────────────────────────────

describe('handleDesignCompleteness', () => {
  it('HandleDesignCompleteness_FullIntegration_PassesAllChecks', () => {
    // Arrange — set up a complete design file + state file
    const designPath = join(tmpDir, 'design.md');
    writeFileSync(designPath, completeDesignContent());

    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: '1.1',
        featureId: 'test-feature',
        phase: 'plan',
        artifacts: { design: designPath },
      }),
    );

    // Act
    const result = handleDesignCompleteness({
      stateFile,
      designFile: designPath,
    });

    // Assert — all checks pass
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checkCount).toBeGreaterThanOrEqual(3);
    expect(result.failCount).toBe(0);
    expect(result.passCount).toBe(result.checkCount);
  });
});

// ─── checkAcceptanceCriteria ─────────────────────────────────────────────────

describe('checkAcceptanceCriteria', () => {
  it('checkDesignCompleteness_GivenWhenThenPresent_PassesValidation', () => {
    // Arrange — design doc with DR-N entries that have Given/When/Then acceptance criteria
    const content = `## Requirements

- DR-1: The system must validate inputs
  - Given: a user submits a form with invalid data
  - When: the validation engine processes the submission
  - Then: the system returns a descriptive error message

- DR-2: The system must log all events
  - Given: any state-changing operation occurs
  - When: the event is processed
  - Then: an audit log entry is created with timestamp and actor
`;

    // Act
    const result = checkAcceptanceCriteria(content);

    // Assert — both DR-N entries have Given/When/Then criteria, so validation passes
    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('checkDesignCompleteness_BulletPointFallback_StillPasses', () => {
    // Arrange — design doc with DR-N entries that have bullet-point acceptance criteria
    const content = `## Requirements

- DR-1: The system must validate inputs
  - Acceptance Criteria:
    - Returns 400 for missing required fields
    - Returns descriptive error messages
    - Validates field types match schema

- DR-2: The system must log all events
  - Acceptance Criteria:
    - Every mutation produces an audit log entry
    - Log entries include timestamp, actor, and action
`;

    // Act
    const result = checkAcceptanceCriteria(content);

    // Assert — bullet-point format is accepted as valid acceptance criteria
    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('checkDesignCompleteness_NoAcceptanceCriteria_ReportsAdvisoryFinding', () => {
    // Arrange — design doc with DR-N entries but no acceptance criteria
    const content = `## Requirements

- DR-1: The system must validate inputs
- DR-2: The system must log all events
- DR-3: The system must handle errors gracefully
`;

    // Act
    const result = checkAcceptanceCriteria(content);

    // Assert — missing acceptance criteria on all DR-N entries produces advisory findings
    expect(result.passed).toBe(false);
    expect(result.missingCriteria).toContain('DR-1');
    expect(result.missingCriteria).toContain('DR-2');
    expect(result.missingCriteria).toContain('DR-3');
    expect(result.missingCriteria).toHaveLength(3);
  });
});

// ─── handleDesignCompleteness — advisory acceptance criteria ────────────────

describe('handleDesignCompleteness_AcceptanceCriteria', () => {
  it('handleDesignCompleteness_MissingAcceptanceCriteria_EmitsAdvisoryFinding', () => {
    // Arrange — complete design with all sections but DR entries lack acceptance criteria
    const content = `# Design: Test Feature

## Problem Statement

Testing advisory findings for missing acceptance criteria.

## Requirements

- DR-1: The system must validate inputs
- DR-2: The system must log all events

## Chosen Approach

We chose Option 1.

### Option 1: Simple Approach

Basic implementation.

### Option 2: Alternative Approach

Alternative implementation.

## Technical Design

Standard implementation.

## Integration Points

Standard integration.

## Testing Strategy

Unit tests.

## Open Questions

None.
`;
    const designPath = join(tmpDir, 'advisory-design.md');
    writeFileSync(designPath, content);

    // Act
    const result = handleDesignCompleteness({ designFile: designPath });

    // Assert — overall check passes (advisory only), but findings mention missing criteria
    expect(result.passed).toBe(true);
    expect(result.findings.some((f) => f.includes('DR-1'))).toBe(true);
    expect(result.findings.some((f) => f.includes('DR-2'))).toBe(true);
    expect(result.findings.some((f) => f.includes('Advisory'))).toBe(true);
  });
});

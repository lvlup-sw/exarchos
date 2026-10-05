// Tests for the pure design-completeness checks: design file resolution,
// required sections, multiple options, the state design path, acceptance
// criteria, and the composed handler.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveDesignFile,
  checkRequiredSections,
  checkMultipleOptions,
  checkStateDesignPath,
  checkAcceptanceCriteria,
  handleDesignCompleteness,
} from '../../../../src/verbs/pure/design-completeness.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'design-completeness-'));
});

afterEach(() => {
  rmrf(tmpDir);
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

describe('resolveDesignFile', () => {
  it('ResolveDesignFile_ExplicitPath_ReturnsPath', () => {
    const designPath = join(tmpDir, 'my-design.md');
    writeFileSync(designPath, completeDesignContent());

    const result = resolveDesignFile({ designFile: designPath });

    expect(result).toBe(designPath);
  });

  it('ResolveDesignFile_FromStateJson_ReadsArtifactsDesign', () => {
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

    const result = resolveDesignFile({ stateFile });

    expect(result).toBe(designPath);
  });

  it('ResolveDesignFile_DocsDir_FindsLatestByDate', () => {
    const docsDir = join(tmpDir, 'docs', 'designs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, '2025-01-01-old-feature.md'), '# Old');
    writeFileSync(join(docsDir, '2026-03-09-new-feature.md'), '# New');
    writeFileSync(join(docsDir, '2025-06-15-mid-feature.md'), '# Mid');

    const result = resolveDesignFile({ docsDir });

    expect(result).toBe(join(docsDir, '2026-03-09-new-feature.md'));
  });
});

describe('checkRequiredSections', () => {
  it('CheckRequiredSections_AllPresent_Passes', () => {
    const content = completeDesignContent();

    const result = checkRequiredSections(content);

    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('CheckRequiredSections_MissingRequirements_Fails', () => {
    const content = completeDesignContent().replace(/## Requirements[\s\S]*?(?=## Chosen Approach)/, '');

    const result = checkRequiredSections(content);

    expect(result.passed).toBe(false);
    expect(result.missing).toContain('Requirements');
  });

  it('CheckRequiredSections_CaseInsensitive_AcceptsVariations', () => {
    const content = completeDesignContent().replace(
      '## Problem Statement',
      '## problem statement',
    );

    const result = checkRequiredSections(content);

    expect(result.passed).toBe(true);
  });
});

describe('checkMultipleOptions', () => {
  it('CheckMultipleOptions_ThreeOptions_Passes', () => {
    const content = completeDesignContent();

    const result = checkMultipleOptions(content);

    expect(result.passed).toBe(true);
    expect(result.count).toBe(3);
  });

  it('CheckMultipleOptions_OneOption_Fails', () => {
    const content = `# Design

## Problem Statement

Some problem.

### Option 1: The Only Way

This is the only option.

## Technical Design

Implementation details.
`;

    const result = checkMultipleOptions(content);

    expect(result.passed).toBe(false);
    expect(result.count).toBe(1);
  });
});

describe('checkStateDesignPath', () => {
  it('CheckStateDesignPath_ValidJson_ReturnsPath', () => {
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

    const result = checkStateDesignPath(stateFile);

    expect(result.passed).toBe(true);
    expect(result.designPath).toBe(designPath);
  });

  it('CheckStateDesignPath_InvalidJson_ReturnsFail', () => {
    const stateFile = join(tmpDir, 'state.json');
    writeFileSync(stateFile, '{corrupted json!!!');

    const result = checkStateDesignPath(stateFile);

    expect(result.passed).toBe(false);
  });
});

describe('handleDesignCompleteness', () => {
  it('HandleDesignCompleteness_FullIntegration_PassesAllChecks', () => {
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

    const result = handleDesignCompleteness({
      stateFile,
      designFile: designPath,
    });

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checkCount).toBeGreaterThanOrEqual(3);
    expect(result.failCount).toBe(0);
    expect(result.passCount).toBe(result.checkCount);
  });
});

describe('checkAcceptanceCriteria', () => {
  it('checkDesignCompleteness_GivenWhenThenPresent_PassesValidation', () => {
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

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('checkDesignCompleteness_BulletPointFallback_StillPasses', () => {
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

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('checkDesignCompleteness_NoAcceptanceCriteria_ReportsAdvisoryFinding', () => {
    const content = `## Requirements

- DR-1: The system must validate inputs
- DR-2: The system must log all events
- DR-3: The system must handle errors gracefully
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(false);
    expect(result.missingCriteria).toContain('DR-1');
    expect(result.missingCriteria).toContain('DR-2');
    expect(result.missingCriteria).toContain('DR-3');
    expect(result.missingCriteria).toHaveLength(3);
  });

  /**
   * The design template mandates a standalone bold `**Acceptance criteria:**`
   * header, so the parser must accept it.
   */
  it('CheckAcceptanceCriteria_BoldHeader_Recognized', () => {
    const content = `## Requirements

### DR-1: The system must validate inputs

The system validates all user-submitted form data.

**Acceptance criteria:**
- Returns 400 for missing required fields
- Returns descriptive error messages
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('CheckAcceptanceCriteria_HeadingForm_Recognized', () => {
    const content = `## Requirements

### DR-1: The system must validate inputs

The system validates all user-submitted form data.

#### Acceptance criteria

- Returns 400 for missing required fields
- Returns descriptive error messages
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('CheckAcceptanceCriteria_SingleLineGWT_Recognized', () => {
    const content = `## Requirements

- DR-1: The system must validate inputs
  - Given a user submits a form with invalid data, when the validation engine processes it, then the system returns a descriptive error message
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  /**
   * The fixture omits the bold header, so only the continuation-line parser can
   * accept it. The header check runs first and can hide a broken continuation parser.
   */
  it('CheckAcceptanceCriteria_ContinuationGWT_Recognized', () => {
    const content = `## Requirements

### DR-1: The system must validate inputs

- Given a precondition holds
  When an action occurs
  Then an expected outcome is produced
  And an additional outcome is produced
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  it('CheckAcceptanceCriteria_BulletHeader_StillRecognized', () => {
    const content = `## Requirements

- DR-1: The system must validate inputs
  - Acceptance Criteria:
    - Returns 400 for missing required fields
    - Returns descriptive error messages
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(true);
    expect(result.missingCriteria).toEqual([]);
  });

  /**
   * A plain-text mention of acceptance does not satisfy the check. A requirement
   * with no criteria block stays flagged.
   */
  it('CheckAcceptanceCriteria_NoCriteria_StillFlagged', () => {
    const content = `## Requirements

### DR-1: The system must validate inputs

This requirement currently has no acceptance criteria defined yet.
We should add them before planning.
`;

    const result = checkAcceptanceCriteria(content);

    expect(result.passed).toBe(false);
    expect(result.missingCriteria).toEqual(['DR-1']);
  });
});

describe('handleDesignCompleteness_AcceptanceCriteria', () => {
  /** Missing acceptance criteria give advisory findings only, so the overall check passes. */
  it('handleDesignCompleteness_MissingAcceptanceCriteria_EmitsAdvisoryFinding', () => {
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

    const result = handleDesignCompleteness({ designFile: designPath });

    expect(result.passed).toBe(true);
    expect(result.findings.some((f) => f.includes('DR-1'))).toBe(true);
    expect(result.findings.some((f) => f.includes('DR-2'))).toBe(true);
    expect(result.findings.some((f) => f.includes('Advisory'))).toBe(true);
  });
});

/**
 * These tests compare `design-completeness.ts` with the bash script
 * `verify-ideate-artifacts.sh`. The bash script required six sections. The TS
 * port also requires "Requirements", and the tests record that difference.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { checkRequiredSections, checkMultipleOptions, handleDesignCompleteness } from '../../../../src/verbs/pure/design-completeness.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const COMPLETE_DESIGN = `# Design: Test Feature

## Problem Statement

We need to solve a complex problem that requires careful design.

## Chosen Approach

We chose Option 2 because it balances flexibility and simplicity.

### Option 1: Simple Approach

**Approach:** A basic implementation with minimal complexity.

**Pros:**
- Easy to implement
- Low risk

**Cons:**
- Limited extensibility

### Option 2: Balanced Approach

**Approach:** A balanced implementation with moderate complexity.

**Pros:**
- Good extensibility
- Moderate risk

**Cons:**
- More code to maintain

### Option 3: Complex Approach

**Approach:** A full-featured implementation.

**Pros:**
- Maximum flexibility

**Cons:**
- High risk
- Longer to implement

## Technical Design

The implementation uses a strategy pattern with injectable handlers.

## Integration Points

Connects to the existing event store via the standard MCP protocol.

## Testing Strategy

Unit tests for each handler, integration tests for the full pipeline.

## Open Questions

- Should we support batch operations in v1?`;

const MISSING_TECHNICAL_DESIGN = `# Design: Incomplete Feature

## Problem Statement

We need to solve a problem.

## Chosen Approach

We chose Option 1.

### Option 1: Simple Approach

Basic implementation.

### Option 2: Complex Approach

Full implementation.

## Integration Points

Connects to existing systems.

## Testing Strategy

Unit tests for everything.

## Open Questions

None yet.`;

describe('behavioral parity with verify-ideate-artifacts.sh', () => {
  describe('checkRequiredSections', () => {
    /** The fixture has no Requirements section, so the test adds one. */
    it('complete design with all 7 TS sections — passes with no missing sections', () => {
      const withRequirements = COMPLETE_DESIGN + '\n\n## Requirements\n\nMust handle 1000 requests/sec.\n';
      const result = checkRequiredSections(withRequirements);

      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    /**
     * The bash script passes this fixture. The TS port fails it, because the
     * fixture has no Requirements section.
     */
    it('complete design without ## Requirements — known divergence from bash', () => {
      const result = checkRequiredSections(COMPLETE_DESIGN);

      expect(result.passed).toBe(false);
      expect(result.missing).toEqual(['Requirements']);
    });

    /**
     * The bash script reported only Technical Design. The TS port also reports
     * Requirements, because the fixture has no Requirements section.
     */
    it('missing Technical Design section — reports it as missing (bash: exit 1)', () => {
      const result = checkRequiredSections(MISSING_TECHNICAL_DESIGN);

      expect(result.passed).toBe(false);
      expect(result.missing).toContain('Technical Design');
    });

    /** Of the six sections that the bash script checked, only Technical Design is missing. */
    it('missing Technical Design — the 6 bash-era sections report correctly', () => {
      const bashSections = [
        'Problem Statement',
        'Chosen Approach',
        'Technical Design',
        'Integration Points',
        'Testing Strategy',
        'Open Questions',
      ];

      const result = checkRequiredSections(MISSING_TECHNICAL_DESIGN);
      const missingBashSections = result.missing.filter((s) => bashSections.includes(s));

      expect(missingBashSections).toEqual(['Technical Design']);
    });

    it('section matching is case-insensitive', () => {
      const content = `## problem statement
Some text.
## requirements
Some requirements.
## chosen approach
Selected approach.
## technical design
Design details.
## integration points
Integration info.
## testing strategy
Test plan.
## open questions
Questions here.`;

      const result = checkRequiredSections(content);

      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
    });
  });

  describe('checkMultipleOptions', () => {
    it('complete design with 3 options — passes with count 3 (bash: 3 options found)', () => {
      const result = checkMultipleOptions(COMPLETE_DESIGN);

      expect(result.passed).toBe(true);
      expect(result.count).toBe(3);
    });

    it('incomplete design with 2 options — passes with count 2 (bash: 2 options found)', () => {
      const result = checkMultipleOptions(MISSING_TECHNICAL_DESIGN);

      expect(result.passed).toBe(true);
      expect(result.count).toBe(2);
    });

    it('single option — fails (below minimum of 2)', () => {
      const content = `## Chosen Approach

### Option 1: Only Approach

The single option.`;

      const result = checkMultipleOptions(content);

      expect(result.passed).toBe(false);
      expect(result.count).toBe(1);
    });

    it('no options — fails with count 0', () => {
      const content = `## Design

Some design without any options listed.`;

      const result = checkMultipleOptions(content);

      expect(result.passed).toBe(false);
      expect(result.count).toBe(0);
    });
  });
});

describe('full evaluation parity', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmrf(tmpDir);
    }
  });

  it('complete design with all sections — handleDesignCompleteness returns all-pass result', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-completeness-parity-'));
    const designPath = path.join(tmpDir, 'design.md');
    const completeWithRequirements = COMPLETE_DESIGN + '\n\n## Requirements\n\nMust handle 1000 requests/sec.\n';
    fs.writeFileSync(designPath, completeWithRequirements);

    const result = handleDesignCompleteness({ designFile: designPath });

    expect(result).toEqual({
      passed: true,
      advisory: true,
      findings: [],
      checkCount: 3,
      passCount: 3,
      failCount: 0,
    });
  });

  it('incomplete design (missing Technical Design) — handleDesignCompleteness returns failure', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-completeness-parity-'));
    const designPath = path.join(tmpDir, 'design.md');
    fs.writeFileSync(designPath, MISSING_TECHNICAL_DESIGN);

    const result = handleDesignCompleteness({ designFile: designPath });

    expect(result.passed).toBe(false);
    expect(result.failCount).toBeGreaterThanOrEqual(1);
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Technical Design/)])
    );
  });
});

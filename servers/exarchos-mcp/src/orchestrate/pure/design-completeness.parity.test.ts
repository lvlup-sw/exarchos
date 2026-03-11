import { describe, it, expect, afterEach } from 'vitest';
import { checkRequiredSections, checkMultipleOptions, handleDesignCompleteness } from './design-completeness.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Behavioral parity tests for design-completeness.ts against the original
 * scripts/verify-ideate-artifacts.sh bash script.
 *
 * Bash script behavior (verify-ideate-artifacts.sh):
 *   - exit 0 → all 4 checks pass: design exists, sections present, >=2 options, state has path
 *   - exit 1 → at least 1 check fails (e.g. missing section)
 *   - Complete design: "**Result: PASS** (4/4 checks passed)" — all sections, 3 options
 *   - Missing section: "**Result: FAIL** (1/4 checks failed)" — missing Technical Design, 2 options
 *
 * Known behavioral difference:
 *   The bash script required 6 sections:
 *     Problem Statement, Chosen Approach, Technical Design,
 *     Integration Points, Testing Strategy, Open Questions
 *   The TS implementation requires 7 sections (adds "Requirements").
 *   Tests below document this divergence explicitly.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('behavioral parity with verify-ideate-artifacts.sh', () => {
  describe('checkRequiredSections', () => {
    it('complete design with all 7 TS sections — passes with no missing sections', () => {
      // The complete design fixture includes a Requirements section
      // (via "## Chosen Approach" — no, it doesn't have ## Requirements).
      // The TS implementation adds "Requirements" as a 7th required section
      // that the bash script did not require. This fixture lacks ## Requirements,
      // so it will report Requirements as missing.
      const withRequirements = COMPLETE_DESIGN + '\n\n## Requirements\n\nMust handle 1000 requests/sec.\n';
      const result = checkRequiredSections(withRequirements);

      expect(result.passed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('complete design without ## Requirements — known divergence from bash', () => {
      // The bash script would PASS this fixture (it did not check for Requirements).
      // The TS implementation FAILS because it requires "Requirements" as a 7th section.
      // This documents the known behavioral difference.
      const result = checkRequiredSections(COMPLETE_DESIGN);

      expect(result.passed).toBe(false);
      expect(result.missing).toEqual(['Requirements']);
    });

    it('missing Technical Design section — reports it as missing (bash: exit 1)', () => {
      // Bash output: "Missing: Technical Design", 1/4 checks failed
      // The TS also requires Requirements which this fixture lacks,
      // so both Technical Design and Requirements appear as missing.
      const result = checkRequiredSections(MISSING_TECHNICAL_DESIGN);

      expect(result.passed).toBe(false);
      expect(result.missing).toContain('Technical Design');
    });

    it('missing Technical Design — the 6 bash-era sections report correctly', () => {
      // Verify that among the 6 sections the bash script checked,
      // only Technical Design is missing from the incomplete fixture.
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

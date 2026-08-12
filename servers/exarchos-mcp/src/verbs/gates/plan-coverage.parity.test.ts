import { describe, it, expect } from 'vitest';
import { parseDesignSections, parsePlanTasks, computeCoverage } from './plan-coverage.js';

/**
 * Behavioral parity tests for plan-coverage.ts against the original
 * scripts/verify-plan-coverage.sh bash script.
 *
 * Bash script behavior (verify-plan-coverage.sh):
 *   - Extracts sections under ## Technical Design
 *   - Extracts tasks from ### Task NNN: Title headers
 *   - Computes coverage matrix: section ↔ task title matching
 *   - exit 0 → all sections covered (PASS), exit 1 → gaps (FAIL)
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DESIGN_FULL_COVERAGE = `# Feature Design
## Problem Statement
We need to build a widget system.
## Chosen Approach
Use component-based architecture.
## Technical Design
### Widget Component
Renders the main UI.
### API Client
Handles data fetching.
### State Manager
Manages application state.
## Testing Strategy
Unit tests for all components.`;

const DESIGN_WITH_GAP = `# Feature Design
## Problem Statement
We need a full system.
## Technical Design
### Widget Component
Renders the main UI.
### API Client
Handles data fetching.
### Cache Layer
Caching for performance.
## Testing Strategy
Unit tests needed.`;

const PLAN_FULL = `# Implementation Plan
## Tasks
### Task 001: Create Widget Component
Build the widget rendering layer.
Design section: Widget Component
### Task 002: Create API Client
Build the API integration.
Design section: API Client
### Task 003: Create State Manager
Build the state management module.
Design section: State Manager`;

const PLAN_WITH_GAP = `# Implementation Plan
## Tasks
### Task 001: Create Widget Component
Design section: Widget Component
### Task 002: Create API Client
Design section: API Client`;

const DESIGN_MULTI_GAP = `# Feature Design
## Problem Statement
We need a full system.
## Technical Design
### Widget Component
Renders the main UI.
### Cache Layer
Caching for performance.
### Message Queue
Async message processing.
## Testing Strategy
Unit tests needed.`;

const PLAN_MINIMAL = `# Implementation Plan
## Tasks
### Task 001: Create Widget Component
Build the widget rendering layer.
Design section: Widget Component`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('behavioral parity with verify-plan-coverage.sh', () => {
  describe('parseDesignSections', () => {
    it('full coverage design — extracts 3 sections under Technical Design', () => {
      expect(parseDesignSections(DESIGN_FULL_COVERAGE)).toEqual(
        ['Widget Component', 'API Client', 'State Manager'],
      );
    });

    it('gap design — extracts 3 sections including Cache Layer', () => {
      expect(parseDesignSections(DESIGN_WITH_GAP)).toEqual(
        ['Widget Component', 'API Client', 'Cache Layer'],
      );
    });

    it('design without Technical Design section — returns empty array', () => {
      expect(parseDesignSections(`# Design
## Problem Statement
Some problem.
## Chosen Approach
Some approach.`)).toEqual([]);
    });
  });

  describe('parsePlanTasks', () => {
    it('full plan — extracts 3 tasks with correct ids and titles', () => {
      expect(parsePlanTasks(PLAN_FULL)).toEqual([
        { id: '001', title: 'Create Widget Component' },
        { id: '002', title: 'Create API Client' },
        { id: '003', title: 'Create State Manager' },
      ]);
    });

    it('gap plan — extracts 2 tasks', () => {
      expect(parsePlanTasks(PLAN_WITH_GAP)).toEqual([
        { id: '001', title: 'Create Widget Component' },
        { id: '002', title: 'Create API Client' },
      ]);
    });

    it('no tasks — returns empty array', () => {
      expect(parsePlanTasks(`# Plan
## Overview
Some overview without task headers.`)).toEqual([]);
    });
  });

  describe('computeCoverage', () => {
    it('full coverage — PASS (3/3 sections covered)', () => {
      const sections = parseDesignSections(DESIGN_FULL_COVERAGE);
      const tasks = parsePlanTasks(PLAN_FULL);

      expect(computeCoverage(sections, tasks, PLAN_FULL, [])).toEqual({
        passed: true,
        coverage: { covered: 3, gaps: 0, deferred: 0, total: 3 },
        report: [
          '## Plan Coverage Report',
          '',
          '### Coverage Matrix',
          '',
          '| Design Section | Task(s) | Status |',
          '|----------------|---------|--------|',
          '| Widget Component | Create Widget Component | Covered |',
          '| API Client | Create API Client | Covered |',
          '| State Manager | Create State Manager | Covered |',
          '',
          '### Summary',
          '',
          '- Design sections: 3',
          '- Covered: 3',
          '- Deferred: 0',
          '- Gaps: 0',
          '',
          '---',
          '',
          '**Result: PASS** (3/3 sections covered)',
        ].join('\n'),
        gapSections: [],
      });
    });

    it('coverage gap — FAIL (1/3 have gaps), Cache Layer uncovered', () => {
      const sections = parseDesignSections(DESIGN_WITH_GAP);
      const tasks = parsePlanTasks(PLAN_WITH_GAP);

      expect(computeCoverage(sections, tasks, PLAN_WITH_GAP, [])).toEqual({
        passed: false,
        coverage: { covered: 2, gaps: 1, deferred: 0, total: 3 },
        report: [
          '## Plan Coverage Report',
          '',
          '### Coverage Matrix',
          '',
          '| Design Section | Task(s) | Status |',
          '|----------------|---------|--------|',
          '| Widget Component | Create Widget Component | Covered |',
          '| API Client | Create API Client | Covered |',
          '| Cache Layer | \u2014 | **GAP** |',
          '',
          '### Summary',
          '',
          '- Design sections: 3',
          '- Covered: 2',
          '- Deferred: 0',
          '- Gaps: 1',
          '',
          '### Unmapped Sections',
          '',
          '- **Cache Layer** \u2014 No task maps to this design section',
          '',
          '---',
          '',
          '**Result: FAIL** (1/3 sections have gaps)',
        ].join('\n'),
        gapSections: ['Cache Layer'],
      });
    });

    it('deferred section — counts as deferred, not a gap, PASS', () => {
      const sections = parseDesignSections(DESIGN_WITH_GAP);
      const tasks = parsePlanTasks(PLAN_WITH_GAP);

      expect(computeCoverage(sections, tasks, PLAN_WITH_GAP, ['Cache Layer'])).toEqual({
        passed: true,
        coverage: { covered: 2, gaps: 0, deferred: 1, total: 3 },
        report: [
          '## Plan Coverage Report',
          '',
          '### Coverage Matrix',
          '',
          '| Design Section | Task(s) | Status |',
          '|----------------|---------|--------|',
          '| Widget Component | Create Widget Component | Covered |',
          '| API Client | Create API Client | Covered |',
          '| Cache Layer | (Deferred in traceability) | Deferred |',
          '',
          '### Summary',
          '',
          '- Design sections: 3',
          '- Covered: 2',
          '- Deferred: 1',
          '- Gaps: 0',
          '',
          '---',
          '',
          '**Result: PASS** (2/3 sections covered, 1 deferred)',
        ].join('\n'),
        gapSections: [],
      });
    });

    it('multiple gaps — FAIL (2/3 have gaps)', () => {
      const sections = parseDesignSections(DESIGN_MULTI_GAP);
      const tasks = parsePlanTasks(PLAN_MINIMAL);

      expect(computeCoverage(sections, tasks, PLAN_MINIMAL, [])).toEqual({
        passed: false,
        coverage: { covered: 1, gaps: 2, deferred: 0, total: 3 },
        report: [
          '## Plan Coverage Report',
          '',
          '### Coverage Matrix',
          '',
          '| Design Section | Task(s) | Status |',
          '|----------------|---------|--------|',
          '| Widget Component | Create Widget Component | Covered |',
          '| Cache Layer | \u2014 | **GAP** |',
          '| Message Queue | \u2014 | **GAP** |',
          '',
          '### Summary',
          '',
          '- Design sections: 3',
          '- Covered: 1',
          '- Deferred: 0',
          '- Gaps: 2',
          '',
          '### Unmapped Sections',
          '',
          '- **Cache Layer** \u2014 No task maps to this design section',
          '- **Message Queue** \u2014 No task maps to this design section',
          '',
          '---',
          '',
          '**Result: FAIL** (2/3 sections have gaps)',
        ].join('\n'),
        gapSections: ['Cache Layer', 'Message Queue'],
      });
    });
  });
});

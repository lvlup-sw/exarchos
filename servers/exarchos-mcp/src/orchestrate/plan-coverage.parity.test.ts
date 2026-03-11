import { describe, it, expect } from 'vitest';
import { parseDesignSections, parsePlanTasks, computeCoverage } from './plan-coverage.js';

/**
 * Behavioral parity tests for plan-coverage.ts against the original
 * scripts/verify-plan-coverage.sh bash script.
 *
 * Bash script behavior (verify-plan-coverage.sh):
 *   - Full coverage (exit 0): 3 sections all covered
 *       → "**Result: PASS** (3/3 sections covered)"
 *   - Coverage gap (exit 1): 3 sections, Cache Layer not covered
 *       → "**Result: FAIL** (1/3 sections have gaps)", 1 gap
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('behavioral parity with verify-plan-coverage.sh', () => {
  describe('parseDesignSections', () => {
    it('full coverage design — extracts 3 sections under Technical Design', () => {
      const sections = parseDesignSections(DESIGN_FULL_COVERAGE);

      expect(sections).toEqual(['Widget Component', 'API Client', 'State Manager']);
    });

    it('gap design — extracts 3 sections including Cache Layer', () => {
      const sections = parseDesignSections(DESIGN_WITH_GAP);

      expect(sections).toEqual(['Widget Component', 'API Client', 'Cache Layer']);
    });

    it('design without Technical Design section — returns empty array', () => {
      const content = `# Design
## Problem Statement
Some problem.
## Chosen Approach
Some approach.`;

      const sections = parseDesignSections(content);

      expect(sections).toEqual([]);
    });
  });

  describe('parsePlanTasks', () => {
    it('full plan — extracts 3 tasks with correct ids and titles', () => {
      const tasks = parsePlanTasks(PLAN_FULL);

      expect(tasks).toEqual([
        { id: '001', title: 'Create Widget Component' },
        { id: '002', title: 'Create API Client' },
        { id: '003', title: 'Create State Manager' },
      ]);
    });

    it('gap plan — extracts 2 tasks', () => {
      const tasks = parsePlanTasks(PLAN_WITH_GAP);

      expect(tasks).toEqual([
        { id: '001', title: 'Create Widget Component' },
        { id: '002', title: 'Create API Client' },
      ]);
    });

    it('no tasks — returns empty array', () => {
      const content = `# Plan
## Overview
Some overview without task headers.`;

      const tasks = parsePlanTasks(content);

      expect(tasks).toEqual([]);
    });
  });

  describe('computeCoverage', () => {
    it('full coverage — passes with 3/3 covered, 0 gaps (bash: exit 0)', () => {
      const designSections = parseDesignSections(DESIGN_FULL_COVERAGE);
      const tasks = parsePlanTasks(PLAN_FULL);
      const result = computeCoverage(designSections, tasks, PLAN_FULL, []);

      expect(result.passed).toBe(true);
      expect(result.coverage.covered).toBe(3);
      expect(result.coverage.gaps).toBe(0);
      expect(result.coverage.total).toBe(3);
      expect(result.gapSections).toEqual([]);
      expect(result.report).toContain('**Result: PASS**');
      expect(result.report).toContain('3/3 sections covered');
    });

    it('coverage gap — fails with Cache Layer uncovered (bash: exit 1)', () => {
      const designSections = parseDesignSections(DESIGN_WITH_GAP);
      const tasks = parsePlanTasks(PLAN_WITH_GAP);
      const result = computeCoverage(designSections, tasks, PLAN_WITH_GAP, []);

      expect(result.passed).toBe(false);
      expect(result.coverage.gaps).toBe(1);
      expect(result.coverage.covered).toBe(2);
      expect(result.coverage.total).toBe(3);
      expect(result.gapSections).toContain('Cache Layer');
      expect(result.report).toContain('**Result: FAIL**');
      expect(result.report).toContain('1/3 sections have gaps');
    });

    it('deferred section — counts as deferred, not a gap', () => {
      const designSections = parseDesignSections(DESIGN_WITH_GAP);
      const tasks = parsePlanTasks(PLAN_WITH_GAP);
      const result = computeCoverage(designSections, tasks, PLAN_WITH_GAP, ['Cache Layer']);

      expect(result.passed).toBe(true);
      expect(result.coverage.deferred).toBe(1);
      expect(result.coverage.gaps).toBe(0);
      expect(result.coverage.covered).toBe(2);
      expect(result.gapSections).toEqual([]);
    });
  });
});

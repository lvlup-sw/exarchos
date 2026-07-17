import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyProvenanceChain } from './provenance-chain.js';
import type { ProvenanceResult } from './provenance-chain.js';

// Repo root: this file lives at servers/exarchos-mcp/src/orchestrate/pure/.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const WLM_SPEC_PATH = path.resolve(REPO_ROOT, 'docs/specs/2026-07-03-wlm-6-surface-and-workflow-fixes.md');

describe('verifyProvenanceChain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================================================
  // FIXTURE HELPERS
  // ============================================================

  function writeDesign(content: string): string {
    const filePath = path.join(tmpDir, 'design.md');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function writePlan(content: string): string {
    const filePath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // ============================================================
  // USAGE ERRORS (exit code 2 equivalent)
  // ============================================================

  describe('usage errors', () => {
    it('missing design file returns error status', () => {
      const planFile = writePlan('# Plan\n### Task 1: Foo\n**Implements:** DR-1\n');

      const result = verifyProvenanceChain({
        designFile: path.join(tmpDir, 'nonexistent.md'),
        planFile,
      });

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/design file not found/i);
    });

    it('missing plan file returns error status', () => {
      const designFile = writeDesign('DR-1: something\n');

      const result = verifyProvenanceChain({
        designFile,
        planFile: path.join(tmpDir, 'nonexistent.md'),
      });

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/plan file not found/i);
    });

    it('design with no DR-N identifiers returns error status', () => {
      const designFile = writeDesign(
        '# Feature Design\n\n## Technical Design\n\nA component that renders widgets.\n'
      );
      const planFile = writePlan('# Plan\n### Task 1: Build Widget\nBuild it.\n');

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/no DR-N identifiers/i);
    });
  });

  // ============================================================
  // UNIFIED ARTIFACT — design+plan collapse (#1581 DR-6, task 012)
  // ============================================================
  //
  // In the collapsed world design and plan are ONE `docs/specs/` artifact, so
  // verifyProvenanceChain is called with the SAME path for designFile and
  // planFile. DR-N definitions live in `## Design & Rationale`; task→DR-N
  // references live in `## Decomposition`. DR-N extraction is scoped to the
  // design region so a reference can never masquerade as a definition.
  describe('unified single-artifact traceability (#1581 DR-6, task 012)', () => {
    function writeUnified(content: string): string {
      const filePath = path.join(tmpDir, 'spec.md');
      fs.writeFileSync(filePath, content, 'utf-8');
      return filePath;
    }

    it('ProvenanceChain_SingleArtifact_ResolvesTaskToDrN', () => {
      const spec = writeUnified(
        [
          '# Spec: Widget',
          '',
          '## Design & Rationale',
          '',
          '### DR-1: Render the widget',
          'The widget renders the main UI.',
          '',
          '### DR-2: Fetch data',
          'The client fetches from the backend.',
          '',
          '## Decomposition',
          '',
          '### Task 001: Build the widget',
          '**Implements:** DR-1',
          '',
          '### Task 002: Build the API client',
          '**Implements:** DR-2',
        ].join('\n')
      );

      // designFile === planFile — one unified artifact.
      const result = verifyProvenanceChain({ designFile: spec, planFile: spec });

      expect(result.status).toBe('pass');
      expect(result.requirements).toBe(2);
      expect(result.covered).toBe(2);
      expect(result.gaps).toBe(0);
      expect(result.orphanRefs).toBe(0);
    });

    it('Traceability_MissingDrN_StillFlagged', () => {
      // DR-1 and DR-2 are defined in the design section; DR-2 has no task (a
      // gap), and Task 002 implements DR-9 which is NOT defined anywhere in
      // the design region (a forward-dangling orphan). Without design-region
      // scoping the DR-9 reference would be miscounted as a definition and the
      // orphan would silently vanish in a single-document artifact.
      const spec = writeUnified(
        [
          '# Spec: Widget',
          '',
          '## Design & Rationale',
          '',
          '### DR-1: Render the widget',
          'The widget renders the main UI.',
          '',
          '### DR-2: Fetch data',
          'The client fetches from the backend.',
          '',
          '## Decomposition',
          '',
          '### Task 001: Build the widget',
          '**Implements:** DR-1',
          '',
          '### Task 002: Build something undefined',
          '**Implements:** DR-9',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile: spec, planFile: spec });

      expect(result.status).toBe('fail');
      // DR-2 is defined but unimplemented — a gap.
      expect(result.gapDetails).toContain('DR-2');
      // DR-9 is referenced by a task but undefined in the design region — a
      // forward-dangling orphan, still flagged within one document.
      expect(result.orphanRefs).toBe(1);
      expect(result.orphanDetails.some((o) => o.includes('DR-9'))).toBe(true);
      // The converse must also hold: the DR-9 reference is NOT counted as a
      // requirement (design-region scoping working).
      expect(result.requirements).toBe(2);
    });
  });

  // ============================================================
  // FULL COVERAGE (all DRs mapped)
  // ============================================================

  describe('full coverage', () => {
    it('complete chain returns pass', () => {
      const designFile = writeDesign(
        [
          '# Feature Design',
          '',
          '## Technical Design',
          '',
          '### Widget Component',
          '',
          'DR-1: Renders the main UI widget.',
          '',
          '### API Client',
          '',
          'DR-2: Handles data fetching from the backend.',
          '',
          '### State Manager',
          '',
          'DR-3: Manages application state lifecycle.',
        ].join('\n')
      );
      const planFile = writePlan(
        [
          '# Implementation Plan',
          '',
          '## Tasks',
          '',
          '### Task 1: Build Widget Component',
          '',
          '**Implements:** DR-1',
          '',
          'Build the core widget rendering component.',
          '',
          '### Task 2: Create API Client',
          '',
          '**Implements:** DR-2',
          '',
          'Set up the API client with fetch wrappers.',
          '',
          '### Task 3: Implement State Manager',
          '',
          '**Implements:** DR-3',
          '',
          'Create the state management layer.',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('pass');
      expect(result.requirements).toBe(3);
      expect(result.covered).toBe(3);
      expect(result.gaps).toBe(0);
      expect(result.orphanRefs).toBe(0);
    });

    it('output contains report header', () => {
      const designFile = writeDesign('DR-1: First\nDR-2: Second\nDR-3: Third\n');
      const planFile = writePlan(
        [
          '### Task 1: A',
          '**Implements:** DR-1',
          '### Task 2: B',
          '**Implements:** DR-2',
          '### Task 3: C',
          '**Implements:** DR-3',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.output).toContain('## Provenance Chain Report');
      expect(result.output).toContain('Requirements: 3');
      expect(result.output).toContain('Covered: 3');
      expect(result.output).toContain('Gaps: 0');
      expect(result.output).toContain('Result: PASS');
    });

    it('single task implementing multiple DRs returns pass', () => {
      const designFile = writeDesign(
        'DR-1: Engine core.\nDR-2: Engine extensions.\nDR-3: Engine configuration.\n'
      );
      const planFile = writePlan(
        [
          '### Task 1: Build Engine Core',
          '',
          '**Implements:** DR-1, DR-2, DR-3',
          '',
          'A single task that covers all three requirements.',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('pass');
      expect(result.requirements).toBe(3);
      expect(result.covered).toBe(3);
    });
  });

  // ============================================================
  // PARTIAL COVERAGE (some DRs missing)
  // ============================================================

  describe('partial coverage', () => {
    it('missing DR in plan returns fail with gap count', () => {
      const designFile = writeDesign(
        'DR-1: Authentication flow.\nDR-2: Session lifecycle management.\nDR-3: Audit log capture.\n'
      );
      const planFile = writePlan(
        [
          '### Task 1: Build Auth Module',
          '**Implements:** DR-1',
          '',
          '### Task 2: Create Session Manager',
          '**Implements:** DR-2',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('fail');
      expect(result.gaps).toBe(1);
      expect(result.gapDetails).toContain('DR-3');
    });

    it('output shows gap details', () => {
      const designFile = writeDesign('DR-1: First\nDR-2: Second\nDR-3: Third\n');
      const planFile = writePlan(
        '### Task 1: A\n**Implements:** DR-1\n### Task 2: B\n**Implements:** DR-2\n'
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.output).toContain('Gaps: 1');
      expect(result.output).toContain('DR-3');
      expect(result.output).toContain('Result: FAIL');
    });
  });

  // ============================================================
  // ORPHAN REFERENCES
  // ============================================================

  describe('orphan references', () => {
    it('DR in plan not in design returns fail', () => {
      const designFile = writeDesign('DR-1: First requirement.\nDR-2: Second requirement.\n');
      const planFile = writePlan(
        [
          '### Task 1: Build Component A',
          '**Implements:** DR-1',
          '',
          '### Task 2: Build Component B',
          '**Implements:** DR-2, DR-99',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('fail');
      expect(result.orphanRefs).toBe(1);
      expect(result.orphanDetails.some((d) => d.includes('DR-99'))).toBe(true);
    });

    it('output shows orphan details', () => {
      const designFile = writeDesign('DR-1: First\nDR-2: Second\n');
      const planFile = writePlan(
        '### Task 1: A\n**Implements:** DR-1\n### Task 2: B\n**Implements:** DR-2, DR-99\n'
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.output).toContain('Orphan refs: 1');
      expect(result.output).toContain('DR-99');
    });
  });

  // ============================================================
  // NO IMPLEMENTS FIELDS
  // ============================================================

  describe('no implements fields', () => {
    it('tasks without implements fields result in all gaps', () => {
      const designFile = writeDesign('DR-1: First thing.\nDR-2: Second thing.\n');
      const planFile = writePlan(
        [
          '### Task 1: Build Module A',
          '',
          'Build module A without an Implements field.',
          '',
          '### Task 2: Build Module B',
          '',
          'Build module B without an Implements field.',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('fail');
      expect(result.gaps).toBe(2);
    });
  });

  // ============================================================
  // CASE INSENSITIVE IMPLEMENTS
  // ============================================================

  describe('case insensitive implements', () => {
    it('lowercase implements: is accepted', () => {
      const designFile = writeDesign('DR-1: Parse input.\nDR-2: Format output.\n');
      const planFile = writePlan(
        [
          '### Task 1: Build Parser',
          '',
          'implements: DR-1',
          '',
          'Build the parser.',
          '',
          '### Task 2: Build Formatter',
          '',
          '**implements:** DR-2',
          '',
          'Build the formatter.',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('pass');
      expect(result.covered).toBe(2);
    });
  });

  // ============================================================
  // TRACEABILITY MATRIX
  // ============================================================

  describe('traceability matrix', () => {
    it('output contains a markdown traceability matrix table', () => {
      const designFile = writeDesign('DR-1: Renders UI.\nDR-2: Handles data.\n');
      const planFile = writePlan(
        [
          '### Task 1: Build Widget',
          '**Implements:** DR-1',
          '### Task 2: Create API Client',
          '**Implements:** DR-2',
        ].join('\n')
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.output).toContain('### Traceability Matrix');
      expect(result.output).toContain('| Requirement | Task(s) | Status |');
      expect(result.output).toContain('DR-1');
      expect(result.output).toContain('Covered');
    });

    it('gap rows show GAP marker', () => {
      const designFile = writeDesign('DR-1: First\nDR-2: Second\n');
      const planFile = writePlan(
        '### Task 1: A\n**Implements:** DR-1\n'
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.output).toMatch(/DR-2.*GAP/);
    });
  });

  // ============================================================
  // DEDUPLICATION
  // ============================================================

  describe('deduplication', () => {
    it('duplicate DR-N in design are counted once', () => {
      const designFile = writeDesign(
        'DR-1: first mention.\nSome text.\nDR-1: second mention.\nDR-2: other.\n'
      );
      const planFile = writePlan(
        '### Task 1: A\n**Implements:** DR-1\n### Task 2: B\n**Implements:** DR-2\n'
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.requirements).toBe(2);
      expect(result.status).toBe('pass');
    });
  });

  // ============================================================
  // ZERO PARSED TASKS (issue #1543)
  // ============================================================

  describe('zero parsed tasks (issue #1543)', () => {
    it('too-deep tasks yield a distinct zero-tasks error naming both accepted shapes', () => {
      const designFile = writeDesign(
        ['# Design', '', 'DR-1: First requirement.', 'DR-2: Second requirement.'].join('\n'),
      );
      // Tasks nested at h5 — deeper than BOTH accepted depths (h3 legacy,
      // h4 unified docs/specs/ shape, #1654 DR-1). extractPlanTasks finds
      // zero tasks, which previously rendered as a misleading "2/2 unmapped"
      // FAIL; it must surface as a parse error instead.
      const planFile = writePlan(
        [
          '# Plan',
          '',
          '### Cluster A',
          '',
          '#### Subcluster',
          '',
          '##### Task 1: Foo',
          '**Implements:** DR-1',
          '',
          '##### Task 2: Bar',
          '**Implements:** DR-2',
        ].join('\n'),
      );
      const result = verifyProvenanceChain({ designFile, planFile });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/0 tasks/i);
      // The error names both accepted shapes (#1654 DR-1 acceptance criterion).
      expect(result.error).toContain("'### Task'");
      expect(result.error).toContain("'#### Task'");
      expect(result.output).not.toContain('requirements unmapped');
    });
  });

  // ============================================================
  // UNIFIED docs/specs/ TEMPLATE SHAPE (#1654, DR-1)
  // ============================================================
  //
  // The unified spec template nests DR-N definitions as `#### DR-N:` under
  // `### Requirements (DR-N)` inside `## Design & Rationale`, and tasks as
  // `#### Task NNN:` under a `### Tasks` grouping inside `## Decomposition`.
  // Both the h3 (legacy) and h4 (unified) task depths must parse; the
  // decomposition boundary must trigger on either depth.
  describe('unified spec template shape (#1654, DR-1)', () => {
    it('UnifiedSpec_TemplateVerbatim_ParsesDrsAndTasks', () => {
      const spec = path.join(tmpDir, 'spec.md');
      fs.writeFileSync(
        spec,
        [
          '# Spec: Widget Pipeline',
          '',
          '## Design & Rationale',
          '',
          '### Problem Statement',
          '',
          'The widget pipeline drops records under load.',
          '',
          '### Requirements (DR-N)',
          '',
          '#### DR-1: Bounded queue backpressure',
          '',
          'Records queue with backpressure instead of dropping.',
          '',
          '#### DR-2: Structured drop metrics',
          '',
          'Rejected records emit a structured metric.',
          '',
          '## Decomposition',
          '',
          '### Tasks',
          '',
          '#### Task 001: Add the bounded queue',
          '',
          '**Implements:** DR-1',
          '',
          '#### Task 002: Emit rejection counters',
          '',
          '**Implements:** DR-2',
        ].join('\n'),
        'utf-8',
      );

      // One unified artifact: designFile === planFile.
      const result = verifyProvenanceChain({ designFile: spec, planFile: spec });

      expect(result.status).toBe('pass');
      expect(result.requirements).toBe(2);
      expect(result.covered).toBe(2);
      expect(result.gaps).toBe(0);
      expect(result.orphanRefs).toBe(0);
      // Real task names appear in the traceability matrix rows.
      expect(result.output).toContain('| DR-1 | Add the bounded queue | Covered |');
      expect(result.output).toContain('| DR-2 | Emit rejection counters | Covered |');
    });

    it('LegacyPair_TwoFileShape_Unchanged', () => {
      // Legacy two-file shape (separate design + plan, h3 tasks): behavior
      // must remain byte-identical to the pre-#1654 parser.
      const designFile = writeDesign(
        [
          '# Feature Design',
          '',
          '## Technical Design',
          '',
          '### Widget Component',
          'DR-1: Renders the main UI widget.',
          '',
          '### API Client',
          'DR-2: Handles data fetching.',
        ].join('\n'),
      );
      const planFile = writePlan(
        [
          '# Implementation Plan',
          '',
          '## Tasks',
          '',
          '### Task 1: Build Widget Component',
          '**Implements:** DR-1',
          '',
          '### Task 2: Create API Client',
          '**Implements:** DR-2',
        ].join('\n'),
      );

      const result = verifyProvenanceChain({ designFile, planFile });

      expect(result.status).toBe('pass');
      expect(result.requirements).toBe(2);
      expect(result.covered).toBe(2);
      expect(result.gaps).toBe(0);
      expect(result.orphanRefs).toBe(0);
      expect(result.gapDetails).toEqual([]);
      expect(result.orphanDetails).toEqual([]);
      expect(result.output).toContain('**Result: PASS** (2/2 requirements traced)');
    });

    it('WlmCorpusSpec_UnifiedShape_ParsesFourDrsSevenTasks', () => {
      // Regression pin against the real shipped corpus file (#1654 acceptance
      // criterion). Its 7 h4 tasks previously parsed as ZERO tasks (a #1543
      // error); they must now parse, with each of the 4 defined DRs covered.
      const result = verifyProvenanceChain({
        designFile: WLM_SPEC_PATH,
        planFile: WLM_SPEC_PATH,
      });

      expect(result.status).not.toBe('error');
      // The 4 h4-defined DRs are all covered by the 7 h4 tasks' Implements
      // lines. (The prose-token scan also picks up DR-10/DR-12 cross-document
      // references in the design region — pre-existing behavior out of #1654
      // scope — so `requirements` may exceed 4, but never at the cost of the
      // four real DRs.)
      expect(result.covered).toBe(4);
      expect(result.requirements).toBeGreaterThanOrEqual(4);
      for (const dr of ['DR-1', 'DR-2', 'DR-3', 'DR-4']) {
        expect(result.gapDetails).not.toContain(dr);
      }
      expect(result.orphanRefs).toBe(0);
      // A real task title from the corpus appears in the matrix.
      expect(result.output).toContain('Registry-driven conformance rewrite');
    });
  });
});

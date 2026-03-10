import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { verifyProvenanceChain } from './provenance-chain.js';
import type { ProvenanceResult } from './provenance-chain.js';

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
});

/**
 * Tests for the single-workflow-fold gate: exactly one module folds
 * `WorkflowEvent` into `WorkflowStateView`.
 *
 * A file is a workflow-state fold when it holds both a `case 'workflow.transition'`
 * arm and a `case 'merge.executed'` arm. Readiness and pipeline views hold only
 * the first arm, and the merge-orchestrator projection holds only the second.
 * The allowlist holds the canonical fold (`projections/views/workflow-state-projection.ts`)
 * and the distinct rehydration projection. Each other match fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runScriptCheck,
  makeFixtureSrc as makeFixtureSrcShared,
  validateManifestCommands,
} from '../../tools/audit/gates/test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'check-single-workflow-fold.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

function makeFixtureSrc(files: Record<string, string>) {
  return makeFixtureSrcShared('single-fold-', files);
}

/** A minimal duplicate of the workflow-state fold, with the transition arm and the merge arm. */
const DUPLICATE_FOLD =
  'export function apply(view: unknown, event: { type: string; data?: { to?: string } }) {\n' +
  '  switch (event.type) {\n' +
  "    case 'workflow.transition': { return { ...view, phase: event.data?.to }; }\n" +
  "    case 'merge.executed': { return { ...view, merged: true }; }\n" +
  '    default: return view;\n' +
  '  }\n' +
  '}\n';

describe('check-single-workflow-fold CLI (#1554)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Detects_DuplicateWorkflowStateFold_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workflow/shadow-fold.ts': DUPLICATE_FOLD,
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/workflow\/shadow-fold\.ts/);
    } finally {
      cleanup();
    }
  });

  /** The allowlist matches the canonical module by path. */
  it('Allows_CanonicalFoldPath_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'projections/views/workflow-state-projection.ts': DUPLICATE_FOLD,
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  /** The rehydration reducer folds a distinct `RehydrationDocument`, so the allowlist holds it. */
  it('Allows_RehydrationProjection_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'projections/rehydration/reducer.ts': DUPLICATE_FOLD,
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  /**
   * A view that derives `phase` from `workflow.transition` and does not fold
   * `merge.executed` is not a duplicate fold.
   */
  it('Allows_PhaseOnlyView_NoMergeTerminal_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'projections/views/pipeline-view.ts':
        'export function apply(view: unknown, event: { type: string; data?: { to?: string } }) {\n' +
        '  switch (event.type) {\n' +
        "    case 'workflow.started': return view;\n" +
        "    case 'workflow.transition': return { ...view, phase: event.data?.to };\n" +
        '    default: return view;\n' +
        '  }\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  /**
   * A fold of `merge.executed` without `workflow.transition` builds a different
   * state shape and is not a duplicate fold.
   */
  it('Allows_MergeOrchestratorFold_NoTransition_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'projections/merge-orchestrator/reducer.ts':
        'export function apply(s: unknown, event: { type: string }) {\n' +
        '  switch (event.type) {\n' +
        "    case 'merge.preflight': return s;\n" +
        "    case 'merge.executed': return { ...s, phase: 'completed' };\n" +
        '    default: return s;\n' +
        '  }\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('Excludes_TestAndBenchSurface_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workflow/dup.test.ts': DUPLICATE_FOLD,
      '__tests__/dup.ts': DUPLICATE_FOLD,
      'workflow/dup.bench.ts': DUPLICATE_FOLD,
      'benchmarks/event-factories.ts': DUPLICATE_FOLD,
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('SkipsCommentedFold_DocstringMentioningCases_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workflow/notes.ts':
        '/**\n' +
        " * Historical: applyEventToState had case 'workflow.transition' and\n" +
        " * case 'merge.executed' arms. Deleted in #1554.\n" +
        ' */\n' +
        'export const x = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('LiveCheck_RealRepo_ExitsZero', () => {
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  /**
   * The `validate` script runs `run-validate.mjs`, which reads its steps from
   * `tools/audit/gates/validate-manifest.json`. The test finds the gate in that manifest.
   */
  it('Validate_ChainedIntoNpmValidate', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.validate ?? '').toContain('run-validate.mjs');
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-single-workflow-fold.mjs');
  });
});

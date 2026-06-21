/**
 * Tests for the single-workflow-fold CI gate (#1554).
 *
 * The gate enforces INV-1 "one left-fold": exactly one module folds
 * `WorkflowEvent` → `WorkflowStateView`. The signature of that fold is a
 * `case 'workflow.transition'` arm co-occurring with a `case 'merge.executed'`
 * arm (the lifecycle + merge-terminal fold) — readiness/pipeline views derive a
 * `phase` from transitions but never fold `merge.executed`, and the
 * merge-orchestrator projection folds `merge.executed` but not
 * `workflow.transition`, so the conjunction isolates the workflow-state fold.
 * The canonical fold (`views/workflow-state-projection.ts`) and the deliberately
 * distinct rehydration projection are allowlisted; any other match fails.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-single-workflow-fold.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('node', [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function makeFixtureSrc(files: Record<string, string>): {
  srcRoot: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'single-fold-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }
  return { srcRoot: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A minimal duplicate workflow-state fold: both lifecycle + merge-terminal arms.
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

  it('Allows_CanonicalFoldPath_ExitsZero', () => {
    // The canonical module is allowlisted by path.
    const { srcRoot, cleanup } = makeFixtureSrc({
      'views/workflow-state-projection.ts': DUPLICATE_FOLD,
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('Allows_RehydrationProjection_ExitsZero', () => {
    // The rehydration reducer is a distinct projection (RehydrationDocument),
    // allowlisted per the design §3.3 addendum decision.
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

  it('Allows_PhaseOnlyView_NoMergeTerminal_ExitsZero', () => {
    // A pipeline/status/readiness view derives `phase` from workflow.transition
    // but never folds merge.executed — must NOT be flagged (no false positive).
    const { srcRoot, cleanup } = makeFixtureSrc({
      'views/pipeline-view.ts':
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

  it('Allows_MergeOrchestratorFold_NoTransition_ExitsZero', () => {
    // The merge-orchestrator projection folds merge.executed but not
    // workflow.transition — a different state shape, must NOT be flagged.
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

  it('Validate_ChainedIntoNpmValidate', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const validate = pkg.scripts?.validate ?? '';
    expect(validate).toContain('check-single-workflow-fold.mjs');
  });
});

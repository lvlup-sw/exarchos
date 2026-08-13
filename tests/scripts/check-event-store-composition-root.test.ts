/**
 * Tests for the EventStore composition-root CI gate (Fix 1, RCA cluster
 * #1182).
 *
 * Phase progression:
 *   - RED: `scripts/check-event-store-composition-root.mjs` does not yet
 *     exist; these tests fail because spawning the script yields ENOENT
 *     and because the root `package.json` `validate` chain has not been
 *     extended to invoke it.
 *   - GREEN: a Node script walks `src/**` looking
 *     for `new EventStore(...)` outside the documented composition root
 *     (4 entries: index.ts, core/context.ts, lifecycle/subagent-stop.ts,
 *     evals/run-evals-cli.ts) and outside
 *     test/bench files. Exit 0 = clean, 1 = violations, 2 = env errors.
 *
 * Rationale: see docs/rca/2026-04-26-v29-event-projection-cluster.md
 * (DIM-1 finding). Without a CI gate, a future caller could re-introduce
 * an in-process EventStore instance that bypasses the #971 PID lock and
 * silently corrupt event sequences.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runScriptCheck,
  makeFixtureSrc as makeFixtureSrcShared,
  validateManifestCommands,
} from '../../scripts/test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(
  REPO_ROOT,
  'scripts',
  'check-event-store-composition-root.mjs',
);
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

/**
 * Build a fixture src tree mirroring the real layout (so the script's
 * relative-path matching against the composition-root whitelist behaves
 * identically). Returns the temp dir; caller is responsible for cleanup.
 */
function makeFixtureSrc(files: Record<string, string>) {
  return makeFixtureSrcShared('es-composition-root-', files);
}

describe('check-event-store-composition-root CLI (Fix 1, #1182)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Detects_RogueInstantiation_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'verbs/some-handler.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export function getStore(dir: string) {\n' +
        '  return new EventStore(dir);\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/verbs\/some-handler\.ts/);
      expect(stderr).toMatch(/new EventStore/);
    } finally {
      cleanup();
    }
  });

  it('Allows_CompositionRootFiles_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'index.ts':
        "import { EventStore } from './event-store/store.js';\n" +
        'export const store = new EventStore("/tmp");\n',
      'dispatch/core/context.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const store = new EventStore("/tmp");\n',
      'lifecycle/subagent-stop.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const store = new EventStore("/tmp");\n',
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
      'event-store/store.test.ts':
        "import { EventStore } from './store.js';\n" +
        'const store = new EventStore("/tmp");\n',
      '__tests__/integration.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'const store = new EventStore("/tmp");\n',
      'event-store/store.bench.ts':
        "import { EventStore } from './store.js';\n" +
        'const store = new EventStore("/tmp");\n',
      'telemetry/benchmarks/helpers.ts':
        "import { EventStore } from '../../event-store/store.js';\n" +
        'export const store = new EventStore("/tmp");\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('SkipsCommentLines_DocstringMentioningPattern_ExitsZero', () => {
    // The script must distinguish actual `new EventStore(...)` calls from
    // prose mentions of the pattern (e.g. RCA references in docstrings).
    const { srcRoot, cleanup } = makeFixtureSrc({
      'verbs/some-handler.ts':
        '/**\n' +
        ' * Migrated away from `new EventStore(...)`. See RCA.\n' +
        ' */\n' +
        '// new EventStore(stateDir) — no longer used\n' +
        'export const x = 1;\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('Reports_AllViolations_NotJustFirst', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'verbs/some-handler.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const a = new EventStore("/tmp");\n',
      'review/tools.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const b = new EventStore("/tmp");\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/verbs\/some-handler\.ts/);
      expect(stderr).toMatch(/review\/tools\.ts/);
    } finally {
      cleanup();
    }
  });

  it('LiveCheck_AfterFix_ExitsZero', () => {
    // Runs against the actual repo. RED: fails because views/tools.ts
    // and review/tools.ts still hold rogue instantiations. GREEN: passes
    // after T1.3 removes them.
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  it('Validate_ChainedIntoNpmValidate', () => {
    // Task 064 (DR-24): `validate` is no longer an inline `&&` chain, so a
    // substring check on `pkg.scripts.validate` can no longer see whether this
    // gate is wired into it. The steps are DATA now — the old chain died at
    // step 1 and every later gate read as skipped-as-passed — so the same
    // question is put to scripts/validate-manifest.json instead.
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.validate ?? '').toContain('run-validate.mjs');
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-event-store-composition-root.mjs');
  });
});

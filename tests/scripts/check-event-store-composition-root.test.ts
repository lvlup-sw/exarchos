/**
 * Tests for the EventStore composition-root gate,
 * `tools/audit/gates/check-event-store-composition-root.mjs`.
 * The gate finds `new EventStore(...)` in `src` outside the composition root and outside test and bench files.
 * Such an instance bypasses the PID lock and can corrupt event sequences.
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
const SCRIPT = path.join(
  REPO_ROOT,
  'tools',
  'audit',
  'gates',
  'check-event-store-composition-root.mjs',
);
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

/**
 * Builds a fixture `src` tree with the real layout, so the gate matches the same relative paths.
 * The caller must call `cleanup`.
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

  /** A comment that mentions `new EventStore(...)` is not a violation. */
  it('SkipsCommentLines_DocstringMentioningPattern_ExitsZero', () => {
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

  /** Runs the gate against the live repository. */
  it('LiveCheck_AfterFix_ExitsZero', () => {
    const { status, stderr } = runCheck();
    expect(status, `stderr: ${stderr}`).toBe(0);
  });

  /**
   * The `validate` script only starts the runner.
   * The steps are data in `tools/audit/gates/validate-manifest.json`, so the test reads the manifest.
   */
  it('Validate_ChainedIntoNpmValidate', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.validate ?? '').toContain('run-validate.mjs');
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-event-store-composition-root.mjs');
  });
});

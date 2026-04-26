/**
 * Tests for the EventStore composition-root CI gate (Fix 1, RCA cluster
 * #1182).
 *
 * Phase progression:
 *   - RED: `scripts/check-event-store-composition-root.mjs` does not yet
 *     exist; these tests fail because spawning the script yields ENOENT
 *     and because the root `package.json` `validate` chain has not been
 *     extended to invoke it.
 *   - GREEN: a Node script walks `servers/exarchos-mcp/src/**` looking
 *     for `new EventStore(...)` outside the documented composition root
 *     (index.ts, core/context.ts, cli-commands/assemble-context.ts) and
 *     outside test/bench files. Exit 0 = clean, 1 = violations, 2 = env
 *     errors.
 *
 * Rationale: see docs/rca/2026-04-26-v29-event-projection-cluster.md
 * (DIM-1 finding). Without a CI gate, a future caller could re-introduce
 * an in-process EventStore instance that bypasses the #971 PID lock and
 * silently corrupt event sequences.
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
const SCRIPT = path.join(
  REPO_ROOT,
  'scripts',
  'check-event-store-composition-root.mjs',
);
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
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a fixture src tree mirroring the real layout (so the script's
 * relative-path matching against the composition-root whitelist behaves
 * identically). Returns the temp dir; caller is responsible for cleanup.
 */
function makeFixtureSrc(
  files: Record<string, string>,
): { srcRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'es-composition-root-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }
  return {
    srcRoot: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('check-event-store-composition-root CLI (Fix 1, #1182)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Detects_RogueInstantiation_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'views/tools.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export function getStore(dir: string) {\n' +
        '  return new EventStore(dir);\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/views\/tools\.ts/);
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
      'core/context.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const store = new EventStore("/tmp");\n',
      'cli-commands/assemble-context.ts':
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

  it('Reports_AllViolations_NotJustFirst', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'views/tools.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const a = new EventStore("/tmp");\n',
      'review/tools.ts':
        "import { EventStore } from '../event-store/store.js';\n" +
        'export const b = new EventStore("/tmp");\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/views\/tools\.ts/);
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
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const validate = pkg.scripts?.validate ?? '';
    expect(validate).toContain('check-event-store-composition-root.mjs');
  });
});

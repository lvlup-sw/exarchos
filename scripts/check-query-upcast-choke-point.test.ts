/**
 * Tests for the read-time upcasting choke-point CI gate (#1556).
 *
 * The gate forbids direct backend reads (`.queryEvents(` /
 * `.queryEventsByType(`) outside the events/storage substrate, so every
 * reader folds rows through `migrateEvents` (read-time schema evolution
 * cannot be silently skipped).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runScriptCheck,
  makeFixtureSrc as makeFixtureSrcShared,
  validateManifestCommands,
} from './test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-query-upcast-choke-point.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

function makeFixtureSrc(files: Record<string, string>) {
  return makeFixtureSrcShared('upcast-choke-', files);
}

describe('check-query-upcast-choke-point CLI (#1556)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Detects_RawBackendReadOutsideSubstrate_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'verbs/some-handler.ts':
        'export function load(backend: any, id: string) {\n' +
        '  return backend.queryEvents(id);\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/verbs\/some-handler\.ts/);
      expect(stderr).toMatch(/queryEvents/);
    } finally {
      cleanup();
    }
  });

  it('Detects_QueryEventsByType_OutsideSubstrate_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'projections/views/some-view.ts':
        'export function scan(backend: any) {\n' +
        "  return backend.queryEventsByType('task.assigned', 'feat');\n" +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/views\/some-view\.ts/);
    } finally {
      cleanup();
    }
  });

  it('Allows_EventStoreAndStorageSubstrate_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'events/store.ts':
        'export function q(backend: any, id: string) { return backend.queryEvents(id); }\n',
      'events/atomic-appender.ts':
        'export function seq(backend: any, id: string) { return backend.queryEvents(id); }\n',
      'storage/sqlite-backend.ts':
        'export class B { queryEvents(id: string) { return []; } }\n',
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
      'verbs/h.test.ts':
        'const x = (b: any) => b.queryEvents("s");\n',
      '__tests__/integration.ts':
        'const x = (b: any) => b.queryEvents("s");\n',
      'verbs/h.bench.ts':
        'const x = (b: any) => b.queryEvents("s");\n',
      'telemetry/benchmarks/helpers.ts':
        'export const x = (b: any) => b.queryEvents("s");\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('SkipsCommentLines_DocstringMentioningPattern_ExitsZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'verbs/some-handler.ts':
        '/**\n' +
        ' * Do not call `backend.queryEvents(...)` here — go through EventStore.\n' +
        ' */\n' +
        '// backend.queryEvents(id) — forbidden\n' +
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
    // Task 064 (DR-24): `validate` is no longer an inline `&&` chain, so a
    // substring check on `pkg.scripts.validate` can no longer see whether this
    // gate is wired into it. The steps are DATA now — the old chain died at
    // step 1 and every later gate read as skipped-as-passed — so the same
    // question is put to scripts/validate-manifest.json instead.
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.validate ?? '').toContain('run-validate.mjs');
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-query-upcast-choke-point.mjs');
  });
});

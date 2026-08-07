/**
 * Tests for the `.state.json` no-read/write CI gate (#1504).
 *
 * The gate forbids raw `node:fs` reads/writes of a `<featureId>.state.json` file
 * in production code: the SQLite event store is the authoritative state surface,
 * so readers must fold the event log (`resolveWorkflowState` / `EventStore.query`)
 * or go through the backend-aware `readStateFile` / `writeStateFile` wrappers.
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
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-no-state-json.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

function runCheck(extraArgs: string[] = []) {
  return runScriptCheck(SCRIPT, REPO_ROOT, extraArgs);
}

function makeFixtureSrc(files: Record<string, string>) {
  return makeFixtureSrcShared('no-state-json-', files);
}

describe('check-no-state-json CLI (#1504)', () => {
  it('Script_Exists', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Detects_WriteStateJson_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workflow/some-writer.ts':
        'import * as fs from "node:fs/promises";\n' +
        'export async function persist(dir: string, id: string, data: string) {\n' +
        '  await fs.writeFile(path.join(dir, `${id}.state.json`), data);\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/workflow\/some-writer\.ts/);
      expect(stderr).toMatch(/state\.json/);
    } finally {
      cleanup();
    }
  });

  it('Detects_ReadStateJson_ExitsNonZero', () => {
    const { srcRoot, cleanup } = makeFixtureSrc({
      'orchestrate/some-reader.ts':
        'import { readFileSync } from "node:fs";\n' +
        'export function load(dir: string, id: string) {\n' +
        '  return JSON.parse(readFileSync(path.join(dir, `${id}.state.json`), "utf8"));\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/orchestrate\/some-reader\.ts/);
    } finally {
      cleanup();
    }
  });

  it('Detects_ExistsSyncStateJson_ExitsNonZero', () => {
    // Presence-probing a `.state.json` is the existence anti-pattern #1504 bans.
    const { srcRoot, cleanup } = makeFixtureSrc({
      'orchestrate/probe.ts':
        'import { existsSync } from "node:fs";\n' +
        'export const tracked = (dir: string, id: string) =>\n' +
        '  existsSync(path.join(dir, `${id}.state.json`));\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/orchestrate\/probe\.ts/);
    } finally {
      cleanup();
    }
  });

  it('Allows_PathStringHandedToWrapper_ExitsZero', () => {
    // Computing a `.state.json` path STRING and passing it to a backend-aware
    // wrapper (not a raw fs primitive) is the legitimate, ubiquitous pattern.
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workflow/handler.ts':
        'export async function go(dir: string, id: string, state: unknown) {\n' +
        '  const stateFile = path.join(dir, `${id}.state.json`);\n' +
        '  await writeStateFile(stateFile, state);\n' +
        '  return readStateFile(stateFile);\n' +
        '}\n',
    });
    try {
      const { status, stderr } = runCheck(['--src-root', srcRoot]);
      expect(status, `stderr: ${stderr}`).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('Allows_DirScanThenNameFilter_ExitsZero', () => {
    // The discovery file-scan fallback: an existsSync(dir) probe and an
    // `.endsWith('.state.json')` name filter live in adjacent statements. The
    // `;` boundary must keep the probe from reaching the literal.
    const { srcRoot, cleanup } = makeFixtureSrc({
      'workspace/scan.ts':
        'import { existsSync, readdirSync } from "node:fs";\n' +
        'export function detect(wfDir: string): boolean {\n' +
        '  if (!existsSync(wfDir)) return false;\n' +
        '  const entries = readdirSync(wfDir);\n' +
        "  return entries.some((e) => e.endsWith('.state.json'));\n" +
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
      'workflow/h.test.ts':
        'import * as fs from "node:fs/promises";\n' +
        'await fs.writeFile(path.join(d, "feat.state.json"), "{}");\n',
      '__tests__/integration.ts':
        'import { readFileSync } from "node:fs";\n' +
        'readFileSync(path.join(d, "feat.state.json"));\n',
      'workflow/h.bench.ts':
        'import { readFileSync } from "node:fs";\n' +
        'readFileSync("x.state.json");\n',
      'telemetry/benchmarks/helpers.ts':
        'import { readFileSync } from "node:fs";\n' +
        'export const x = () => readFileSync("y.state.json");\n',
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
      'workflow/handler.ts':
        '/**\n' +
        ' * Do not `fs.readFile(`${id}.state.json`)` here — fold the event log.\n' +
        ' */\n' +
        '// fs.writeFile("x.state.json", data) — forbidden\n' +
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
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-no-state-json.mjs');
  });
});

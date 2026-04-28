// ─── Characterization Tests: detectProjectType ──────────────────────────────
//
// Per Michael Feathers' "Working Effectively with Legacy Code", these tests
// pin down the CURRENT behavior of `detectProjectType` so future refactors
// (refactor #1199, test-runtime-resolver consolidation) can proceed with
// safety nets.
//
// INTENTIONAL GAP DOCUMENTATION:
//   The Python case (`pyproject.toml` only) currently returns `undefined` —
//   `detectProjectType` does NOT detect Python projects. This is asymmetric
//   with the test-runtime resolver in the worktree-create flow, which DOES
//   detect Python (pytest).
//
//   This characterization test documents the gap as it exists at HEAD.
//   Task T08 of refactor #1199 will close the gap by adding Python detection
//   here, and will FLIP the `detectProjectType_Python_ReturnsUndefined`
//   assertion below to expect `pytest` instead. Until T08 lands, the
//   undefined assertion is intentional and must not be "fixed".
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectType } from './verify-worktree-baseline.js';

describe('detectProjectType (characterization)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'verify-baseline-char-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detectProjectType_Node_ReturnsNpmRunTestRun', () => {
    writeFileSync(join(tempDir, 'package.json'), '{"name":"x"}');

    const result = detectProjectType(tempDir);

    expect(result).toEqual({
      projectType: 'Node.js',
      testCommand: 'npm run test:run',
      cmd: 'npm',
      args: ['run', 'test:run'],
    });
  });

  it('detectProjectType_DotNet_ReturnsDotnetTest', () => {
    writeFileSync(join(tempDir, 'MyApp.csproj'), '<Project></Project>');

    const result = detectProjectType(tempDir);

    expect(result).toEqual({
      projectType: '.NET',
      testCommand: 'dotnet test',
      cmd: 'dotnet',
      args: ['test'],
    });
  });

  it('detectProjectType_Rust_ReturnsCargoTest', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "x"\n');

    const result = detectProjectType(tempDir);

    expect(result).toEqual({
      projectType: 'Rust',
      testCommand: 'cargo test',
      cmd: 'cargo',
      args: ['test'],
    });
  });

  it('detectProjectType_Python_ReturnsUndefined', () => {
    // INTENTIONAL: Python detection is currently absent from
    // verify-worktree-baseline.ts — this asymmetry with the worktree-create
    // resolver is documented in refactor #1199 plan and will be closed by
    // task T08, at which point this assertion flips to expect a pytest
    // ProjectDetection. Do NOT "fix" this in T02.
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "x"\n');

    const result = detectProjectType(tempDir);

    expect(result).toBeUndefined();
  });

  it('detectProjectType_NoMarkers_ReturnsUndefined', () => {
    // Empty directory — no recognized project markers.
    const result = detectProjectType(tempDir);

    expect(result).toBeUndefined();
  });
});

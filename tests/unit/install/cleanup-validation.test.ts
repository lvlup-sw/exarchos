/**
 * Guards that the repository holds no remnant of the deleted `create-exarchos` package
 * or of the companion directories.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('Cleanup Validation', () => {
  /**
   * A workspace glob that matches nothing makes tooling treat the repository as a monorepo root.
   * For each glob, the test checks only that the path before the trailing wildcard exists.
   * The test passes when `workspaces` is absent.
   */
  it('WorkspaceConfig_RootPackageJson_DeclaresNoDeadWorkspaceGlob', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const workspaces: string[] = pkg.workspaces ?? [];

    for (const glob of workspaces) {
      const root = glob.replace(/\/\*+$/, '');
      expect(existsSync(resolve(ROOT, root)), `workspace glob "${glob}" matches no directory`).toBe(
        true,
      );
    }
  });

  it('CompanionDir_DoesNotExist_RemovedFromRepo', () => {
    expect(existsSync(resolve(ROOT, 'companion'))).toBe(false);
  });

  it('CompanionSkillsDir_DoesNotExist_RemovedFromRepo', () => {
    expect(existsSync(resolve(ROOT, 'companion-skills'))).toBe(false);
  });

  it('CompanionScripts_Removed_NoValidateCompanion', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['validate:companion']).toBeUndefined();
  });

  it('NoLegacy_CreateExarchosPackageAbsent', () => {
    expect(existsSync(resolve(ROOT, 'packages/create-exarchos'))).toBe(false);
  });

  it('NoLegacy_PackageJsonHasNoCreateExarchosWorkspace', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const workspaces: string[] = pkg.workspaces ?? [];
    for (const w of workspaces) {
      expect(w).not.toContain('create-exarchos');
    }
    const scripts: Record<string, string> = pkg.scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      expect(key).not.toContain('create-exarchos');
      expect(value).not.toContain('create-exarchos');
    }
  });

  /** The test passes with no assertion when `tools/release/sync-versions.sh` does not exist. */
  it('NoLegacy_SyncVersionsHasNoCreateExarchos', () => {
    const scriptPath = resolve(ROOT, 'tools/release/sync-versions.sh');
    if (!existsSync(scriptPath)) {
      return;
    }
    const script = readFileSync(scriptPath, 'utf-8');
    expect(script).not.toMatch(/create-exarchos/);
  });

  /** The test passes with no assertion when `.github/workflows` does not exist. */
  it('NoLegacy_GithubWorkflowsHaveNoCreateExarchos', () => {
    const workflowsDir = resolve(ROOT, '.github/workflows');
    if (!existsSync(workflowsDir)) return;
    const { readdirSync } = require('node:fs');
    const files: string[] = readdirSync(workflowsDir).filter(
      (f: string) => f.endsWith('.yml') || f.endsWith('.yaml'),
    );
    for (const f of files) {
      const body = readFileSync(resolve(workflowsDir, f), 'utf-8');
      expect(body, `workflow ${f} references create-exarchos`).not.toMatch(/create-exarchos/);
    }
  });
});

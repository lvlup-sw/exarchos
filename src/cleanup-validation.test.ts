import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Cleanup Validation', () => {
  it('WorkspaceConfig_RootPackageJson_HasWorkspacesField', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.workspaces).toBeDefined();
    expect(pkg.workspaces).toContain('packages/*');
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
    // Task 3.2: packages/create-exarchos directory is fully deleted (subsumes #1043).
    expect(existsSync(resolve(ROOT, 'packages/create-exarchos'))).toBe(false);
  });

  it('NoLegacy_PackageJsonHasNoCreateExarchosWorkspace', () => {
    // Root package.json workspaces array must not reference create-exarchos.
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    const workspaces: string[] = pkg.workspaces ?? [];
    for (const w of workspaces) {
      expect(w).not.toContain('create-exarchos');
    }
    // And no root scripts should reference create-exarchos either.
    const scripts: Record<string, string> = pkg.scripts ?? {};
    for (const [key, value] of Object.entries(scripts)) {
      expect(key).not.toContain('create-exarchos');
      expect(value).not.toContain('create-exarchos');
    }
  });

  it('NoLegacy_SyncVersionsHasNoCreateExarchos', () => {
    // scripts/sync-versions.sh must have zero matches for `create-exarchos` after cleanup.
    const scriptPath = resolve(ROOT, 'scripts/sync-versions.sh');
    if (!existsSync(scriptPath)) {
      // If the script no longer exists, the invariant trivially holds.
      return;
    }
    const script = readFileSync(scriptPath, 'utf-8');
    expect(script).not.toMatch(/create-exarchos/);
  });

  it('NoLegacy_GithubWorkflowsHaveNoCreateExarchos', () => {
    // Any CI workflow step referencing `create-exarchos` must be gone.
    const workflowsDir = resolve(ROOT, '.github/workflows');
    if (!existsSync(workflowsDir)) return;
    // Lazy import to avoid top-level fs scans.
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

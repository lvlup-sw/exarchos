import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

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

  it('VersionSync_Script_IncludesCreateExarchos', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/sync-versions.sh'), 'utf-8');
    expect(script).toContain('create-exarchos');
  });
});
